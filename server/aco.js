// Auto-checkout (docs/AUTO-CHECKOUT.md): a member arms an item on their watchlist, and when it
// drops, their own browser (the extension) opens the store, adds it to the bag, fills checkout in
// with their details and card, and places the order — within the limits they set, and only after
// they've switched it on and agreed. Mugibot's server never sees the card and never buys anything
// itself: it decides when to start (here), and the member's browser does the checking out.
//
// One purchase per arming: once an order is placed (or the final button is pressed), the item
// waits to be armed again. Every run is kept, with each step and why it ended, for the member's
// Auto-checkout page.

import { entitlement } from './entitlement.js';
import { newId } from './crypto.js';
import { DEFAULT_ACO } from './schema.js';
import { startBuy } from './routes/user.js';

// Still on its way: waiting for a browser, opening the store, at checkout, pressing the final button.
const ACTIVE = ['queued', 'sent', 'started', 'checkout', 'placing'];
const DONE = new Set(['placed', 'ready', 'needs_you', 'failed', 'skipped', 'expired']);
// A browser has this long to pick a run up, and a run this long to finish.
const PICKUP_MS = 2 * 60 * 1000;
const RESEND_MS = 45 * 1000;
const RUN_MS = 10 * 60 * 1000;
const PLACING_MS = 5 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
// After this many failed runs in a day, an item stops trying until it's armed again.
const MAX_FAILS = 3;

/** Why a run stopped, in words (the extension and this file give the code). */
export const REASONS = {
  membership: "Your membership isn't active",
  no_flow: "Mugibot doesn't have a checkout for this store yet",
  no_page: "The product page wasn't known yet",
  no_max: 'The item has no max price',
  over_max: 'The price was over your max',
  over_limit: 'The order total was over your limit',
  no_total: "Couldn't read the order total to check it",
  daily_orders: "You'd reached your orders for the day",
  daily_spend: "You'd reached your spending for the day",
  signed_out: "You weren't signed in at the store",
  no_browser: 'No browser with the extension was open to check out',
  too_many_failures: 'It failed 3 times today, so it stopped trying',
  disarmed: 'The item was switched off before the run started',
  sold_out: 'Sold out by the time your browser got there',
  not_added: "The store didn't add it to the bag",
  no_checkout: "Couldn't reach the store's checkout",
  card_missing: 'No card saved in the extension',
  card_not_filled: "The card didn't go into the store's card boxes",
  card_declined: 'The store declined the payment',
  bank_check: 'Your bank asked you to confirm the payment',
  human_check: 'The store asked to check you are human',
  needs_details: 'Checkout needed something Mugibot could not fill in',
  payment_frame: "This store's payment form can't be pressed by Mugibot",
  paypal_only: 'This store only takes PayPal: you pay there yourself',
  unconfirmed: "The final button was pressed, but no order confirmation showed",
  wrong_item: "The checkout wasn't for this item alone",
  stopped: 'You stopped it',
  timeout: 'It took too long',
  error: 'Something went wrong',
};

const STATUS_WORD = {
  queued: 'Waiting for your browser', sent: 'Opening the store', started: 'Adding to bag', checkout: 'At checkout', placing: 'Placing the order',
  placed: 'Order placed', ready: 'Filled in — waiting for you', needs_you: 'Needs you', failed: 'Failed', skipped: 'Skipped', expired: 'Not started',
};

const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '');
const parseSteps = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

export function toRun(r) {
  return r && {
    id: r.id, itemId: r.item_id, store: r.store, sku: r.sku, name: r.name, url: r.url, price: r.price, total: r.total, maxPrice: r.max_price,
    mode: r.mode, trigger: r.trigger, status: r.status, statusText: STATUS_WORD[r.status] || r.status, reason: r.reason || '',
    reasonText: r.reason ? (REASONS[r.reason] || r.reason) : '', message: r.message || '', steps: parseSteps(r.steps),
    active: ACTIVE.includes(r.status), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class Aco {
  constructor(ctx) {
    this.ctx = ctx;
    const { db, repo, hub, notifier, retailers, cfg } = ctx;
    Object.assign(this, { db, repo, hub, notifier, retailers, cfg });
    this.now = ctx.now || (() => Date.now());
    this.waiters = new Map(); // userId → Set<wake()>
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.expire(), 30 * 1000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const set of this.waiters.values()) for (const wake of set) wake();
    this.waiters.clear();
  }

  settings(userId) {
    return { ...DEFAULT_ACO, ...(this.repo.getData(userId, 'aco', {}) || {}) };
  }

  get(userId, id) {
    return this.db.get('SELECT * FROM aco_runs WHERE id = :id AND user_id = :u', { id: String(id || ''), u: userId });
  }

  list(userId, limit = 50) {
    this.expire();
    return this.db.all('SELECT * FROM aco_runs WHERE user_id = :u ORDER BY created_at DESC LIMIT :n', { u: userId, n: limit }).map(toRun);
  }

  /** The last `days` days at a glance: attempts, orders placed, spent, and how the rest ended. */
  stats(userId, days = 30) {
    const rows = this.db.all('SELECT status, price, total FROM aco_runs WHERE user_id = :u AND created_at > :since', { u: userId, since: this.now() - days * DAY });
    const by = (st) => rows.filter((r) => st.includes(r.status)).length;
    return {
      days,
      drops: rows.length,
      attempts: rows.filter((r) => r.status !== 'skipped').length,
      placed: by(['placed']),
      needsYou: by(['needs_you', 'ready']),
      failed: by(['failed', 'expired']),
      skipped: by(['skipped']),
      active: by(ACTIVE),
      spent: Math.round(rows.filter((r) => r.status === 'placed').reduce((s, r) => s + (r.total ?? r.price ?? 0), 0) * 100) / 100,
    };
  }

  armedCount(userId) {
    return this.db.get('SELECT COUNT(*) AS n FROM items WHERE user_id = :u AND aco = 1', { u: userId }).n;
  }

  /** Runs waiting for a browser to start them (a test run, for one: the item needn't be armed). */
  pendingCount(userId) {
    return this.db.get("SELECT COUNT(*) AS n FROM aco_runs WHERE user_id = :u AND status = 'queued'", { u: userId }).n;
  }

  /** The latest any of this member's browsers saw: 'in' | 'out' | null, for a store. */
  loginStatus(userId, store) {
    let best = null;
    for (const d of this.repo.listDevices(userId)) {
      const l = d.logins && d.logins[store];
      if (l && (!best || l.at > best.at)) best = l;
    }
    return best ? best.status : null;
  }

  /** Orders and spending in the last 24 hours (a pressed final button counts, confirmed or not). */
  today(userId) {
    const rows = this.db.all(`SELECT price, total FROM aco_runs WHERE user_id = :u AND created_at > :since
      AND (status IN ('placing', 'placed') OR (status = 'needs_you' AND steps LIKE '%"placing"%'))`, { u: userId, since: this.now() - DAY });
    return { orders: rows.length, spent: rows.reduce((s, r) => s + (r.total ?? r.price ?? 0), 0) };
  }

  // ---------------------------------------------------------------------------
  // A drop: an armed item came in stock (monitor/index.js → alertRestock)
  // ---------------------------------------------------------------------------
  /**
   * row: the item's database row. info: { price, status, source, manual, test }. Returns the run, or null.
   * test: Trigger ACO on the Auto-checkout page — a run now, as if it had dropped, armed or not (the
   * same limits and checks; its failures don't count towards the 3 a day).
   */
  async trigger(row, info = {}) {
    if (!row || (!row.aco && !info.test)) return null;
    const userId = row.user_id;
    const s = this.settings(userId);
    if (!s.enabled) return null;
    const item = this.repo.getItem(userId, row.id);
    if (!item || (!item.aco && !info.test)) return null;
    const now = this.now();
    // One run at a time for an item.
    const running = this.db.get(`SELECT id FROM aco_runs WHERE item_id = :i AND status IN (${ACTIVE.map((x) => `'${x}'`).join(',')})`, { i: item.id });
    if (running) return null;
    const price = typeof info.price === 'number' ? info.price : null;
    const base = { userId, item, price, mode: s.mode, trigger: info.test ? 'test' : info.manual ? 'manual' : info.source || '' };
    const skip = (reason, message) => this.skip(base, reason, message);

    const user = this.repo.userById(userId);
    if (!user || user.disabled) return null;
    if (!entitlement(user, now).active) return skip('membership');
    const r = this.retailers.get(item.store);
    if (!r || !r.flow) return skip('no_flow');
    if (!item.url) return skip('no_page');
    if (item.maxPrice === null || item.maxPrice === undefined) return skip('no_max');
    if (price !== null && price > item.maxPrice) return skip('over_max', `${money(price)} is over your max of ${money(item.maxPrice)}.`);
    if (price !== null && price > s.maxOrder) return skip('over_limit', `${money(price)} is over your limit of ${money(s.maxOrder)} an order.`);
    const fails = this.db.get("SELECT COUNT(*) AS n FROM aco_runs WHERE item_id = :i AND status = 'failed' AND trigger != 'test' AND created_at > :since", { i: item.id, since: now - DAY }).n;
    if (fails >= MAX_FAILS && !info.test) {
      this.disarm(userId, item.id);
      return skip('too_many_failures', 'Arm it again to keep trying.');
    }
    // (Stopping at the final button for the member places nothing: the day's limits are for orders.)
    const day = this.today(userId);
    if (s.mode === 'place' && day.orders >= s.perDay) return skip('daily_orders', `${day.orders} of ${s.perDay} today.`);
    if (s.mode === 'place' && day.spent + (price ?? item.maxPrice) > s.spendPerDay) return skip('daily_spend', `${money(day.spent)} of ${money(s.spendPerDay)} spent today.`);
    if (s.signedInOnly && this.loginStatus(userId, item.store) !== 'in') return skip('signed_out', `Sign in at ${r.name} in the browser with the extension.`);
    // Stores that only check out signed in (Amazon): not while you're seen signed out there.
    if (r.account && r.account.required && this.loginStatus(userId, item.store) === 'out') return skip('signed_out', `${r.name} only checks out signed in — sign in there in the browser with the extension.`);
    if (!this.repo.listDevices(userId).length) return skip('no_browser', 'Connect the extension in the browser you keep open.');

    const run = this.create(base, 'queued', '', `Dropped at ${r.name}${price !== null ? ` for ${money(price)}` : ''} — waiting for your browser to check out.`);
    this.wake(userId); // first: every second counts in a drop
    await this.notifier.notify(userId, {
      type: 'aco', level: 'urgent', channel: 'aco',
      title: `🤖 Auto-checkout ${info.test ? 'test ' : ''}started: ${item.name}`,
      message: `${r.name}${price !== null ? ` · ${money(price)}` : ''}\n${s.mode === 'place' ? 'Your browser is checking out now, and will place the order.' : 'Your browser is filling in checkout now, and will stop at the final button for you.'}`,
      name: item.name, sku: item.sku, url: item.url, buttons: [{ label: 'Auto-checkout', url: `${this.cfg.baseUrl}/app#aco` }],
    });
    return toRun(run);
  }

  /** Trigger ACO: a test run for one of the member's items, now. { run } — or { error } saying why not. */
  async test(userId, itemId) {
    const row = this.db.get('SELECT * FROM items WHERE id = :id AND user_id = :u', { id: String(itemId || ''), u: userId });
    if (!row) return { error: 'not_found' };
    const item = this.repo.getItem(userId, row.id);
    const r = this.retailers.get(item.store);
    if (!r || !r.flow) return { error: `Auto-checkout works at stores Mugibot has a checkout for — not ${r ? r.name : 'this one'} yet` };
    if (!this.settings(userId).enabled) return { error: 'Switch Auto-checkout on first (above)' };
    if (item.maxPrice === null || item.maxPrice === undefined) return { error: 'Set a max price for it first: Mugibot never pays more than that' };
    if (!item.url) return { error: "Its product page isn't known yet — paste its link into the item" };
    if (this.db.get(`SELECT id FROM aco_runs WHERE item_id = :i AND status IN (${ACTIVE.map((x) => `'${x}'`).join(',')})`, { i: item.id })) return { error: 'It\'s already checking out — wait for that run to finish' };
    const price = typeof item.lastPrice === 'number' ? item.lastPrice : typeof item.price === 'number' ? item.price : null;
    const run = await this.trigger(row, { price, test: true });
    return run ? { run } : { error: "Auto-checkout didn't start" };
  }

  create(base, status, reason, message) {
    const now = this.now();
    const id = newId('acr');
    const { item } = base;
    this.db.run(`INSERT INTO aco_runs (id, user_id, item_id, store, sku, name, url, price, max_price, mode, trigger, status, reason, message, steps, created_at, updated_at)
      VALUES (:id, :u, :i, :store, :sku, :name, :url, :price, :max, :mode, :trig, :st, :reason, :msg, :steps, :t, :t)`, {
      id, u: base.userId, i: item.id, store: item.store, sku: item.sku, name: item.name, url: item.url || '', price: base.price, max: item.maxPrice ?? null,
      mode: base.mode, trig: base.trigger, st: status, reason: reason || '', msg: message || '', steps: JSON.stringify([{ at: now, status, message: message || REASONS[reason] || '' }]), t: now,
    });
    const run = this.db.get('SELECT * FROM aco_runs WHERE id = :id', { id });
    this.hub.publish(base.userId, 'aco', toRun(run));
    return run;
  }

  /** It dropped, but Auto-checkout didn't start (a limit, signed out…): kept, and the member hears why. */
  async skip(base, reason, extra = '') {
    const r = this.retailers.get(base.item.store);
    const message = `${REASONS[reason] || reason}${extra ? ` — ${extra}` : ''}`;
    const run = this.create(base, 'skipped', reason, message);
    await this.notifier.notify(base.userId, {
      type: 'aco', level: 'warn', channel: 'aco',
      title: `🤖 Auto-checkout didn't start: ${base.item.name}`,
      message: `${r ? r.name : base.item.store}${base.price !== null ? ` · ${money(base.price)}` : ''}\n${message}`,
      name: base.item.name, sku: base.item.sku, url: base.item.url || null,
      buttons: [base.item.url ? { label: '⚡ Buy', url: this.notifier.buyLink(base.userId, base.item) } : null, { label: 'Auto-checkout', url: `${this.cfg.baseUrl}/app#aco` }].filter(Boolean),
    });
    return toRun(run);
  }

  disarm(userId, itemId) {
    const n = this.db.run('UPDATE items SET aco = 0, aco_at = NULL WHERE id = :i AND user_id = :u AND aco = 1', { i: itemId, u: userId }).changes;
    if (n) this.hub.publish(userId, 'watch', { id: itemId, aco: false });
    return n > 0;
  }

  // ---------------------------------------------------------------------------
  // The member's browser: picks runs up, says how each step went
  // ---------------------------------------------------------------------------
  wake(userId) {
    const set = this.waiters.get(userId);
    if (!set) return;
    for (const wake of [...set]) wake();
  }

  /**
   * Runs for this browser to start: each with the link that opens the store (a one-time ⚡ Buy
   * code tied to the run). Waits up to waitMs for one when there's none. alive(): is the browser
   * still waiting (it may have gone, mid-wait)?
   */
  async next(user, device, { waitMs = 0, alive = () => true } = {}) {
    this.expire();
    let runs = this.take(user, device, alive);
    if (runs.length || !waitMs) return runs;
    await new Promise((resolve) => {
      let set = this.waiters.get(user.id);
      if (!set) this.waiters.set(user.id, (set = new Set()));
      const done = () => { clearTimeout(timer); set.delete(done); if (!set.size) this.waiters.delete(user.id); resolve(); };
      const timer = setTimeout(done, waitMs);
      set.add(done);
    });
    runs = this.take(user, device, alive);
    return runs;
  }

  take(user, device, alive) {
    const now = this.now();
    // Sent to a browser that never opened it (closed mid-way): another of their browsers may take it.
    this.db.run(`UPDATE aco_runs SET status = 'queued', device_id = NULL WHERE user_id = :u AND status = 'sent' AND updated_at < :t`, { u: user.id, t: now - RESEND_MS });
    const rows = this.db.all("SELECT * FROM aco_runs WHERE user_id = :u AND status = 'queued' ORDER BY created_at LIMIT 3", { u: user.id });
    const out = [];
    for (const row of rows) {
      if (!alive()) break;
      const item = row.item_id ? this.repo.getItem(user.id, row.item_id) : null;
      if (!item || (!item.aco && row.trigger !== 'test') || !item.url) {
        // Switched off (or removed) before a browser picked it up: it didn't start, and isn't a failure.
        this.finish(user.id, row, 'expired', 'disarmed', '').catch(() => null);
        continue;
      }
      const claimed = this.db.run("UPDATE aco_runs SET status = 'sent', device_id = :d, updated_at = :t WHERE id = :id AND status = 'queued'", { d: device.id, t: now, id: row.id }).changes;
      if (!claimed) continue;
      this.step(row.id, 'sent', `Opening ${this.retailers.name(row.store)} in ${device.name}`);
      const go = startBuy(this.ctx, user, { ...item, quantity: 1 }, { runId: row.id });
      out.push({ id: row.id, url: go.url, store: row.store, storeName: this.retailers.name(row.store), name: row.name, sku: row.sku, mode: row.mode });
    }
    return out;
  }

  /** The store opened with the run's ⚡ Buy code (routes/ext.js /claim): what this checkout may do. */
  claimed(userId, runId, device) {
    const row = this.get(userId, runId);
    if (!row || !['sent', 'queued'].includes(row.status)) return null;
    const s = this.settings(userId);
    if (!s.enabled) {
      this.finish(userId, row, 'expired', 'stopped', 'Auto-checkout was switched off before the store opened').catch(() => null);
      return null;
    }
    this.db.run("UPDATE aco_runs SET status = 'started', device_id = :d, updated_at = :t WHERE id = :id", { d: device.id, t: this.now(), id: row.id });
    this.step(row.id, 'started', `Opened ${this.retailers.name(row.store)} in ${device.name}`);
    this.publish(userId, row.id);
    // The most the order may cost: the item's max price plus delivery, and never over the member's limit.
    const maxTotal = Math.min(s.maxOrder, (row.max_price ?? s.maxOrder) + 40);
    return { runId: row.id, mode: row.mode, maxPrice: row.max_price, maxTotal, name: row.name, sku: row.sku };
  }

  /**
   * What happened, from the browser: status 'checkout' | 'ready' | 'placing' | 'placed' | 'needs_you' | 'failed',
   * reason (REASONS), message, total.
   */
  async report(userId, runId, { status, reason = '', message = '', total = null }) {
    const row = this.get(userId, runId);
    if (!row) return null;
    // Done is done — except a payment the member finished themselves (the bank's check) turning out placed.
    if (DONE.has(row.status) && !(row.status === 'needs_you' && status === 'placed')) return toRun(row);
    if (typeof total === 'number' && Number.isFinite(total) && total > 0) this.db.run('UPDATE aco_runs SET total = :t WHERE id = :id', { t: Math.round(total * 100) / 100, id: row.id });
    if (status === 'checkout' || status === 'placing') {
      this.db.run('UPDATE aco_runs SET status = :st, updated_at = :t WHERE id = :id', { st: status, t: this.now(), id: row.id });
      this.step(row.id, status, message);
      // The final button is pressed: this arming is used up, whatever happens next.
      if (status === 'placing') this.disarm(userId, row.item_id);
      return this.publish(userId, row.id);
    }
    if (!['ready', 'placed', 'needs_you', 'failed'].includes(status)) return toRun(row);
    return this.finish(userId, row, status, reason, message);
  }

  async finish(userId, row, status, reason, message) {
    const now = this.now();
    const pressed = row.status === 'placing' || parseSteps(row.steps).some((x) => x.status === 'placing');
    const text = message || REASONS[reason] || '';
    this.db.run('UPDATE aco_runs SET status = :st, reason = :reason, message = :msg, updated_at = :t WHERE id = :id', { st: status, reason: reason || '', msg: text, t: now, id: row.id });
    this.step(row.id, status, text);
    // Bought (or it may have been), or filled in for them: armed again only by the member.
    if (status === 'placed' || status === 'ready' || pressed) this.disarm(userId, row.item_id);
    const run = this.publish(userId, row.id);
    const storeName = this.retailers.name(row.store);
    const total = run.total ?? run.price;
    const ev = {
      placed: { level: 'success', title: `✅ Auto-checkout placed your order: ${row.name}`, message: `${storeName}${total ? ` · ${money(total)}` : ''}\nThe store emails you the confirmation. To buy it again, arm it again in Mugibot.` },
      ready: { level: 'urgent', title: `🛒 Checkout ready: ${row.name}`, message: `${storeName}\nYour browser filled checkout in and stopped at the final button — press it to buy.` },
      needs_you: { level: 'urgent', title: `⚠️ Auto-checkout needs you: ${row.name}`, message: `${storeName}\n${text}${pressed ? '' : ' Finish it in the tab that opened.'}` },
      failed: { level: 'warn', title: `❌ Auto-checkout didn't buy ${row.name}`, message: `${storeName}\n${text}${pressed ? '' : ' It stays armed for the next drop.'}` },
      expired: { level: 'warn', title: `❌ Auto-checkout didn't start: ${row.name}`, message: `${storeName}\n${text}` },
    }[status];
    if (ev && reason !== 'disarmed') {
      await this.notifier.notify(userId, {
        type: 'aco', channel: 'aco', ...ev, name: row.name, sku: row.sku, url: row.url || null,
        buttons: [{ label: 'Auto-checkout', url: `${this.cfg.baseUrl}/app#aco` }],
      });
    }
    return run;
  }

  step(id, status, message) {
    const row = this.db.get('SELECT steps FROM aco_runs WHERE id = :id', { id });
    if (!row) return;
    const steps = parseSteps(row.steps);
    steps.push({ at: this.now(), status, message: String(message || '').slice(0, 300) });
    this.db.run('UPDATE aco_runs SET steps = :s, updated_at = :t WHERE id = :id', { s: JSON.stringify(steps.slice(-40)), t: this.now(), id });
  }

  publish(userId, id) {
    const run = toRun(this.db.get('SELECT * FROM aco_runs WHERE id = :id', { id }));
    if (run) this.hub.publish(userId, 'aco', run);
    return run;
  }

  /** Runs nobody picked up, or that never finished. */
  expire() {
    const now = this.now();
    const stale = this.db.all(`SELECT * FROM aco_runs WHERE (status IN ('queued', 'sent') AND created_at < :pick)
      OR (status IN ('started', 'checkout') AND updated_at < :run) OR (status = 'placing' AND updated_at < :placing)`,
    { pick: now - PICKUP_MS, run: now - RUN_MS, placing: now - PLACING_MS });
    for (const row of stale) {
      if (row.status === 'queued' || row.status === 'sent') this.finish(row.user_id, row, 'expired', 'no_browser', '').catch(() => null);
      else if (row.status === 'placing') this.finish(row.user_id, row, 'needs_you', 'unconfirmed', 'The final button was pressed, but no order confirmation showed. Check your email from the store before buying again.').catch(() => null);
      else this.finish(row.user_id, row, 'failed', 'timeout', '').catch(() => null);
    }
  }
}
