// Auto-checkout (docs/AUTO-CHECKOUT.md): a member arms an item on their watchlist, and when it
// drops, their own browser (the extension) opens the store, adds it to the bag, fills checkout in
// with their details and card, and places the order — within the limits they set, and only after
// they've switched it on and agreed. Mugibot's server never sees the card and never buys anything
// itself: it decides when to start (here), and the member's browser does the checking out.
//
// One purchase per arming: once an order is placed (or the final button is pressed), the item
// waits to be armed again. Every run is kept, with each step and why it ended, for the member's
// Auto-checkout page.
//
// Runs go to one browser: the member's checkout browser (the one they picked, or the newest one
// connected), never to all of them. Discord's ⚡ Buy, pressed anywhere (on a phone, with no
// browser at all), starts a run there too: remote() below.
//
// Several at once: runs at different stores check out at the same time, each in a tab of its own.
// A store keeps one bag for a browser, so runs at the same store take turns there: the next one
// waits ('waiting', reason 'turn': next in line) and goes the moment the one before it is done.
//
// Checkpoints and virtual queues (monitor/gates.js): a run that meets one waits ('waiting') — in
// line, never refreshing the queue page, or at the checkpoint for the member to solve — and carries
// on from there. A queue going up puts the checkout browser of every member armed at that store in
// line straight away (a lobby: one tab at the store, waiting its turn), and Discord's "Join the
// queue on my computer" does the same for anyone.

import { entitlement } from './entitlement.js';
import { newId } from './crypto.js';
import { buyAction } from './notifier.js';
import { DEFAULT_ACO } from './schema.js';
import { startBuy } from './routes/user.js';

// Still on its way: waiting for a browser, opening the store, at checkout, pressing the final button.
const ACTIVE = ['queued', 'sent', 'started', 'waiting', 'checkout', 'placing'];
const DONE = new Set(['placed', 'ready', 'needs_you', 'failed', 'skipped', 'expired']);
// A browser has this long to pick a run up, and a run this long to finish.
const PICKUP_MS = 2 * 60 * 1000;
const RESEND_MS = 45 * 1000;
const RUN_MS = 10 * 60 * 1000;
const PLACING_MS = 5 * 60 * 1000;
// A browser that asked for runs this recently is listening (it asks again every 20 seconds or so).
const LISTEN_MS = 45 * 1000;
// Discord lets a button's reply be changed for 15 minutes.
const FOLLOW_MS = 14 * 60 * 1000;
// Waiting in a queue or at a checkpoint: the browser says it's still there every few minutes, and a
// run waits this long at most (a queue can take a while; a checkpoint needs the member now).
const WAIT_BEAT_MS = 10 * 60 * 1000;
const QUEUE_MS = 2 * 60 * 60 * 1000;
const CHECKPOINT_MS = 20 * 60 * 1000;
// Next in line at a store (another checkout of the member's there goes first): this long at most.
const TURN_MS = 20 * 60 * 1000;
// A queue's lobby (a browser told to get in line) lasts while the queue's up, or this long.
const LOBBY_MS = 3 * 60 * 60 * 1000;
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
  queue: "In the store's virtual queue",
  checkpoint: "The store's checkpoint wants a human to solve it",
  turn: 'Next in line: your other checkout at this store goes first (a store has one bag)',
  timeout: 'It took too long',
  error: 'Something went wrong',
};

const STATUS_WORD = {
  queued: 'Waiting for your browser', sent: 'Opening the store', started: 'Adding to bag', waiting: 'Waiting in line', checkout: 'At checkout', placing: 'Placing the order',
  placed: 'Order placed', ready: 'Filled in — waiting for you', needs_you: 'Needs you', failed: 'Failed', skipped: 'Skipped', expired: 'Not started',
};

const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '');
const parseSteps = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

export function toRun(r) {
  return r && {
    id: r.id, itemId: r.item_id, store: r.store, sku: r.sku, name: r.name, url: r.url, price: r.price, total: r.total, maxPrice: r.max_price,
    mode: r.mode, trigger: r.trigger, status: r.status, reason: r.reason || '',
    statusText: r.status === 'waiting' && r.reason === 'checkpoint' ? 'Waiting for you at the checkpoint' : r.status === 'waiting' && r.reason === 'turn' ? 'Next in line' : STATUS_WORD[r.status] || r.status,
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
    this.listening = new Map(); // deviceId → when it last asked for runs
    this.follows = new Map(); // runId → { token, until, last }: Discord's ⚡ Buy reply, kept up to date
    this.lobbies = new Map(); // userId → Map(store → { id, store, url, by, at, sent }): browsers told to get in line
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

  /**
   * The browser that checks out: Auto-checkout's runs and Discord's ⚡ Buy go there and nowhere else
   * (two browsers never race for the same order). The one the member picked, or the newest connected.
   */
  checkoutDevice(userId) {
    const devices = this.repo.listDevices(userId); // newest first
    const want = this.settings(userId).deviceId;
    return devices.find((d) => d.id === want) || devices[0] || null;
  }

  /** Should this browser keep asking for runs with nothing armed? The checkout browser, while Discord's ⚡ Buy is on. */
  listens(user, device) {
    const checkout = this.checkoutDevice(user.id);
    return !!checkout && checkout.id === device.id && this.settings(user.id).remoteBuy && entitlement(user, this.now()).active;
  }

  /** Is this browser open and asking for runs right now? */
  isListening(deviceId) {
    const at = this.listening.get(deviceId);
    return !!at && this.now() - at < LISTEN_MS;
  }

  /** The member's browsers for the Auto-checkout page: which one checks out, and which are listening. */
  browsers(userId) {
    const checkout = this.checkoutDevice(userId);
    return this.repo.listDevices(userId).map((d) => ({
      id: d.id, name: d.name, version: d.version, lastSeenAt: d.lastSeenAt,
      checkout: !!checkout && checkout.id === d.id, listening: this.isListening(d.id),
    }));
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

  /**
   * The day's orders and spending for a new run's limits: those, plus the runs still on their way that
   * may place one (several at once each count, so together they never go over the day's limits).
   */
  todayWithRunning(userId) {
    const day = this.today(userId);
    const going = this.db.all(`SELECT price, max_price FROM aco_runs WHERE user_id = :u AND mode = 'place'
      AND status IN ('queued', 'sent', 'started', 'waiting', 'checkout')`, { u: userId });
    return { orders: day.orders + going.length, spent: day.spent + going.reduce((s, r) => s + (r.price ?? r.max_price ?? 0), 0) };
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
    // (A drop's failures count — not Trigger ACO's, nor a ⚡ Buy pressed in Discord.)
    const fails = this.db.get("SELECT COUNT(*) AS n FROM aco_runs WHERE item_id = :i AND status = 'failed' AND trigger NOT IN ('test', 'remote') AND created_at > :since", { i: item.id, since: now - DAY }).n;
    if (fails >= MAX_FAILS && !info.test) {
      this.disarm(userId, item.id);
      return skip('too_many_failures', 'Arm it again to keep trying.');
    }
    // (Stopping at the final button for the member places nothing: the day's limits are for orders.
    // Runs still on their way count: several at once never go over them together.)
    const day = this.todayWithRunning(userId);
    const busy = day.orders - this.today(userId).orders;
    const going = busy ? ` (${busy} checking out now)` : '';
    if (s.mode === 'place' && day.orders >= s.perDay) return skip('daily_orders', `${day.orders} of ${s.perDay} today${going}.`);
    if (s.mode === 'place' && day.spent + (price ?? item.maxPrice) > s.spendPerDay) return skip('daily_spend', `${money(day.spent)} of ${money(s.spendPerDay)} spent today${going}.`);
    if (s.signedInOnly && this.loginStatus(userId, item.store) !== 'in') return skip('signed_out', `Sign in at ${r.name} in the browser with the extension.`);
    // Stores that only check out signed in (Amazon): not while you're seen signed out there.
    if (r.account && r.account.required && this.loginStatus(userId, item.store) === 'out') return skip('signed_out', `${r.name} only checks out signed in — sign in there in the browser with the extension.`);
    if (!this.repo.listDevices(userId).length) return skip('no_browser', 'Connect the extension in the browser you keep open.');

    const run = this.create(base, 'queued', '', `Dropped at ${r.name}${price !== null ? ` for ${money(price)}` : ''} — waiting for your browser to check out.`);
    this.wake(userId); // first: every second counts in a drop
    const queued = this.ctx.gates && this.ctx.gates.queueUp(item.store);
    await this.notifier.notify(userId, {
      type: 'aco', level: 'urgent', channel: 'aco',
      title: `🤖 Auto-checkout ${info.test ? 'test ' : ''}started: ${item.name}`,
      message: `${r.name}${price !== null ? ` · ${money(price)}` : ''}\n${s.mode === 'place' ? 'Your browser is checking out now, and will place the order.' : 'Your browser is filling in checkout now, and will stop at the final button for you.'}${queued ? `\n🚦 ${r.name}'s virtual queue is up: your browser waits its turn in line first (don't refresh the queue page).` : ''}`,
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

  /**
   * Discord's ⚡ Buy (routes/discord.js), or "Send to my computer" on the buy page: check this item
   * out now in the member's checkout browser, wherever they pressed it. With Auto-checkout on (and
   * set to place orders), it places the order within their limits — the most it may cost being the
   * item's max price, or else the price they were shown. Otherwise (Auto-checkout off, a limit
   * reached, no price to check against) it fills checkout in and stops at the final button.
   * price: what the alert said. Returns { run, mode, why, device, listening } — or { error }.
   */
  async remote(userId, itemId, { price = null } = {}) {
    const user = this.repo.userById(userId);
    if (!user || user.disabled) return { error: 'Your account is suspended — contact support.' };
    if (!entitlement(user, this.now()).active) return { error: `⚡ Buy needs an active membership: ${this.cfg.baseUrl}/app#membership` };
    const item = this.repo.getItem(userId, itemId);
    if (!item) return { error: 'That SKU isn\'t on your watchlist.' };
    const r = this.retailers.get(item.store);
    if (!r || !r.flow) return { error: `Mugibot doesn't have a checkout for ${r ? r.name : 'that store'} yet.` };
    if (!item.url) return { error: `The product page for SKU ${item.sku} hasn't been found yet.` };
    const s = this.settings(userId);
    if (!s.remoteBuy) return { error: `⚡ Buy from Discord on your computer is switched off — switch it on at ${this.cfg.baseUrl}/app#aco, or open the product in the browser with the extension.` };
    const device = this.checkoutDevice(userId);
    if (!device) return { error: `No browser with the ${this.cfg.appName} extension is connected yet — connect the one on your computer at ${this.cfg.baseUrl}/app#extension, and ⚡ Buy runs there from anywhere.` };
    if (this.db.get(`SELECT id FROM aco_runs WHERE item_id = :i AND status IN (${ACTIVE.map((x) => `'${x}'`).join(',')})`, { i: item.id })) return { error: `It's already checking out in ${device.name}.` };
    if (r.account && r.account.required && this.loginStatus(userId, item.store) === 'out') return { error: `${r.name} only sells to signed-in customers — sign in there in ${device.name} first.` };

    // Place the order, or fill checkout in and stop at the final button (and why).
    const known = [price, item.lastPrice, item.price].find((p) => typeof p === 'number' && p > 0);
    const shown = known === undefined ? null : known;
    const cap = item.maxPrice ?? shown;
    const day = this.todayWithRunning(userId);
    const why = !s.enabled ? 'Auto-checkout is off, so it stops at the final button for you'
      : s.mode !== 'place' ? 'Auto-checkout is set to stop at the final button'
        : cap === null ? 'there\'s no price to check the total against, so it stops at the final button'
          : shown !== null && item.maxPrice !== null && item.maxPrice !== undefined && shown > item.maxPrice ? `${money(shown)} is over your max of ${money(item.maxPrice)}, so it stops at the final button`
            : cap > s.maxOrder ? `${money(cap)} is over your limit of ${money(s.maxOrder)} an order, so it stops at the final button`
              : day.orders >= s.perDay ? `you've placed your ${s.perDay} orders for today, so it stops at the final button`
                : day.spent + cap > s.spendPerDay ? `that would go over your ${money(s.spendPerDay)} a day, so it stops at the final button`
                  : '';
    const mode = why ? 'fill' : 'place';
    const run = this.create({ userId, item, price: shown, maxPrice: mode === 'place' ? cap : (item.maxPrice ?? null), mode, trigger: 'remote' }, 'queued', '',
      `⚡ Buy pressed in Discord — waiting for ${device.name} to check out.`);
    this.wake(userId);
    await this.notifier.notify(userId, {
      type: 'aco', level: 'urgent',
      title: `⚡ Buy from Discord: ${item.name}`,
      message: `${r.name}${shown !== null ? ` · ${money(shown)}` : ''} — checking out in ${device.name}${mode === 'place' ? ', placing the order' : ', stopping at the final button'}.`,
    });
    return { run: toRun(run), mode, why, device: { id: device.id, name: device.name }, listening: this.isListening(device.id) };
  }

  /** What Discord's ⚡ Buy reply says: where the run is (kept up to date as it goes, for 15 minutes). */
  remoteText(run, deviceName = 'your checkout browser') {
    const where = this.retailers.name(run.store);
    const total = run.total ?? run.price;
    const lines = {
      queued: `⏳ Sent to **${deviceName}** — waiting for it to open ${where}.`,
      sent: `🛒 **${deviceName}** is opening ${where}…`,
      started: `🛒 Adding it to the bag at ${where} in **${deviceName}**…`,
      waiting: run.reason === 'turn'
        ? `⏳ Next in line at ${where} in **${deviceName}**: your other checkout there goes first (${where} keeps one bag), then this one goes straight away.`
        : run.reason === 'checkpoint'
        ? `🛡️ ${where}'s checkpoint wants a human: solve it in **${deviceName}**, and it carries on to checkout.`
        : `🚦 In ${where}'s virtual queue in **${deviceName}**${run.message && /about \d+ min/.test(run.message) ? ` — ${run.message.match(/about \d+ min\w*/)[0]}` : ''}. It waits its turn (never refreshing the page), then checks out.`,
      checkout: `🛒 At ${where}'s checkout in **${deviceName}** — filling it in…`,
      placing: `💳 Placing the order at ${where}…`,
      placed: `✅ **Order placed** at ${where}${total ? ` — ${money(total)}` : ''}. The store emails you the confirmation.`,
      ready: `🛒 **Checkout's ready** in ${deviceName} — press ${where}'s final button there to buy.`,
      needs_you: `⚠️ **It needs you** in ${deviceName}: ${run.message || run.reasonText}`,
      failed: `❌ **Didn't buy it**: ${run.message || run.reasonText}`,
      expired: `❌ **Didn't start**: ${run.reason === 'no_browser' ? `${deviceName} didn't pick it up within 2 minutes — is it open, with the extension connected?` : run.message || run.reasonText}`,
      skipped: `⏭️ **Didn't start**: ${run.message || run.reasonText}`,
    };
    return `**${run.name}**\n${lines[run.status] || run.statusText}`;
  }

  /** Keep a Discord ⚡ Buy reply up to date with its run (the interaction's token lasts 15 minutes). */
  follow(runId, token, deviceName, note = '') {
    if (!token) return;
    this.follows.set(runId, { token, deviceName, note, until: this.now() + FOLLOW_MS, last: '' });
    // (The oldest go once Discord's 15 minutes are up.)
    for (const [id, f] of this.follows) if (this.now() > f.until) this.follows.delete(id);
  }

  create(base, status, reason, message) {
    const now = this.now();
    const id = newId('acr');
    const { item } = base;
    this.db.run(`INSERT INTO aco_runs (id, user_id, item_id, store, sku, name, url, price, max_price, mode, trigger, status, reason, message, steps, created_at, updated_at)
      VALUES (:id, :u, :i, :store, :sku, :name, :url, :price, :max, :mode, :trig, :st, :reason, :msg, :steps, :t, :t)`, {
      id, u: base.userId, i: item.id, store: item.store, sku: item.sku, name: item.name, url: item.url || '', price: base.price, max: base.maxPrice !== undefined ? base.maxPrice : (item.maxPrice ?? null),
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
      buttons: [base.item.url ? { label: '⚡ Buy', url: this.notifier.buyLink(base.userId, base.item), action: buyAction('i', base.item.id) } : null, { label: 'Auto-checkout', url: `${this.cfg.baseUrl}/app#aco` }].filter(Boolean),
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
    this.listening.set(device.id, this.now());
    let runs = this.take(user, device, alive);
    if (runs.length || !waitMs) return runs;
    await new Promise((resolve) => {
      let set = this.waiters.get(user.id);
      if (!set) this.waiters.set(user.id, (set = new Set()));
      const done = () => { clearTimeout(timer); set.delete(done); if (!set.size) this.waiters.delete(user.id); resolve(); };
      const timer = setTimeout(done, waitMs);
      set.add(done);
    });
    this.listening.set(device.id, this.now());
    runs = this.take(user, device, alive);
    return runs;
  }

  take(user, device, alive) {
    // Only the checkout browser starts runs: the member's other browsers never race it.
    const checkout = this.checkoutDevice(user.id);
    if (checkout && checkout.id !== device.id) return [];
    const now = this.now();
    // Sent to a browser that never opened it (closed mid-way): it may take it again.
    this.db.run(`UPDATE aco_runs SET status = 'queued', device_id = NULL WHERE user_id = :u AND status = 'sent' AND updated_at < :t`, { u: user.id, t: now - RESEND_MS });
    const rows = this.db.all("SELECT * FROM aco_runs WHERE user_id = :u AND status = 'queued' ORDER BY created_at LIMIT 3", { u: user.id });
    const out = [];
    for (const row of rows) {
      if (!alive()) break;
      const item = row.item_id ? this.repo.getItem(user.id, row.item_id) : null;
      if (!item || (!item.aco && row.trigger !== 'test' && row.trigger !== 'remote') || !item.url) {
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
    // ('waiting': a run held while its browser waited in a queue, now opening the store with a fresh code.)
    if (!row || !['sent', 'queued', 'waiting'].includes(row.status)) return null;
    const s = this.settings(userId);
    // (Discord's ⚡ Buy that only fills checkout in doesn't need Auto-checkout on: the member presses the button.)
    if (!s.enabled && !(row.trigger === 'remote' && row.mode === 'fill')) {
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
      this.db.run("UPDATE aco_runs SET status = :st, reason = '', updated_at = :t WHERE id = :id", { st: status, t: this.now(), id: row.id });
      this.step(row.id, status, message);
      // The final button is pressed: this arming is used up, whatever happens next.
      if (status === 'placing') this.disarm(userId, row.item_id);
      return this.publish(userId, row.id);
    }
    if (status === 'waiting') return this.waiting(userId, row, reason === 'checkpoint' || reason === 'turn' ? reason : 'queue', message);
    if (status === 'started' && row.status === 'waiting') {
      // Through the queue (or past the checkpoint): carrying on.
      this.db.run("UPDATE aco_runs SET status = 'started', reason = '', updated_at = :t WHERE id = :id", { t: this.now(), id: row.id });
      this.step(row.id, 'started', message || (row.reason === 'turn' ? `Its turn — opening ${this.retailers.name(row.store)}` : `Through — carrying on at ${this.retailers.name(row.store)}`));
      return this.publish(userId, row.id);
    }
    if (!['ready', 'placed', 'needs_you', 'failed'].includes(status)) return toRun(row);
    return this.finish(userId, row, status, reason, message);
  }

  /**
   * The run's browser is waiting: in the store's virtual queue (reason 'queue'), at its checkpoint
   * for the member to solve (reason 'checkpoint'), or for its turn at the store (reason 'turn': another
   * checkout of theirs there goes first). Said again every few minutes while it waits (only a new
   * message is a new step); the member hears about a queue or a checkpoint once (a turn: it starts
   * in a moment, and its "started" message said what's happening).
   */
  async waiting(userId, row, reason, message) {
    if (!['queued', 'sent', 'started', 'checkout', 'waiting'].includes(row.status)) return toRun(row);
    const first = row.status !== 'waiting' || row.reason !== reason;
    const text = message || REASONS[reason];
    this.db.run("UPDATE aco_runs SET status = 'waiting', reason = :r, message = :m, updated_at = :t WHERE id = :id", { r: reason, m: text, t: this.now(), id: row.id });
    const last = parseSteps(row.steps).at(-1);
    if (first || !last || last.message !== text) this.step(row.id, 'waiting', text);
    const run = this.publish(userId, row.id);
    if (first && reason !== 'turn') {
      const where = this.retailers.name(row.store);
      await this.notifier.notify(userId, {
        type: 'aco', level: 'urgent', channel: 'aco',
        title: reason === 'checkpoint' ? `🛡️ ${where}'s checkpoint needs you: ${row.name}` : `🚦 In ${where}'s queue: ${row.name}`,
        message: reason === 'checkpoint'
          ? `${where} wants a human check (hCaptcha) before checkout. Solve it in the tab that opened, and Mugibot carries on to checkout — it never touches the check itself.`
          : `${text}\nYour browser is waiting its turn and carries on when it's through. Leave the queue page alone: it refreshes itself.`,
        name: row.name, sku: row.sku, url: row.url || null, buttons: [{ label: 'Auto-checkout', url: `${this.cfg.baseUrl}/app#aco` }],
      }).catch(() => null);
    }
    return run;
  }

  /** A fresh ⚡ Buy link for a run whose browser held it while it waited in a queue (its code may have run out). */
  freshLink(user, runId) {
    const row = this.get(user.id, runId);
    if (!row || !['waiting', 'sent'].includes(row.status)) return null;
    const item = row.item_id ? this.repo.getItem(user.id, row.item_id) : null;
    if (!item || !item.url) return null;
    return startBuy(this.ctx, user, { ...item, quantity: 1 }, { runId: row.id }).url;
  }

  // ---------------------------------------------------------------------------
  // Virtual queues: getting in line before the drop (monitor/gates.js)
  // ---------------------------------------------------------------------------
  /** Does this member's checkout browser get in line at this store when its queue goes up? Auto-checkout on, something armed there. */
  joinsQueue(userId, store) {
    if (!this.settings(userId).enabled) return false;
    return !!this.db.get('SELECT 1 FROM items WHERE user_id = :u AND store = :s AND aco = 1 LIMIT 1', { u: userId, s: store });
  }

  /** A store's queue went up: every member armed there (Auto-checkout on) gets their checkout browser in line. */
  queueUp(r) {
    const rows = this.db.all('SELECT DISTINCT user_id FROM items WHERE store = :s AND aco = 1', { s: r.id });
    for (const { user_id: userId } of rows) {
      const user = this.repo.userById(userId);
      if (!user || user.disabled || !entitlement(user, this.now()).active || !this.settings(userId).enabled) continue;
      if (!this.checkoutDevice(userId)) continue;
      this.lobby(userId, r, 'auto');
    }
  }

  /** The queue came down (or the checkpoint's off): nobody needs to get in line there any more. */
  gateDown(r) {
    for (const [userId, map] of this.lobbies) {
      map.delete(r.id);
      if (!map.size) this.lobbies.delete(userId);
    }
  }

  lobby(userId, r, by) {
    let map = this.lobbies.get(userId);
    if (!map) this.lobbies.set(userId, (map = new Map()));
    const had = map.get(r.id);
    if (had && this.now() - had.at < LOBBY_MS) return had;
    const gates = this.ctx.gates;
    // (Its front page: the store puts a new visitor in line there.)
    const lobby = { id: newId('lob'), store: r.id, storeName: r.name, url: gates ? gates.checkUrl(r, (r.gate.check && r.gate.check.path) || '/') : r.base, by, at: this.now(), sent: null };
    map.set(r.id, lobby);
    this.repo.addEvent(userId, { type: 'aco', level: 'info', message: `🚦 ${r.name}'s virtual queue is up — ${by === 'auto' ? 'your checkout browser is getting in line for your armed items' : 'your checkout browser is getting in line (Discord)'}` });
    this.wake(userId);
    return lobby;
  }

  /**
   * Discord's "📥 Join the queue on my computer" (routes/discord.js): the member's checkout browser
   * gets in line at that store. { lobby, device, listening } — or { error }.
   */
  joinQueue(userId, storeId) {
    const user = this.repo.userById(userId);
    if (!user || user.disabled) return { error: 'Your account is suspended — contact support.' };
    if (!entitlement(user, this.now()).active) return { error: `This needs an active membership: ${this.cfg.baseUrl}/app#membership` };
    const r = this.retailers.get(storeId);
    const gates = this.ctx.gates;
    if (!r || !r.gate || r.gate.kind !== 'queue') return { error: "That store doesn't have a virtual queue Mugibot knows." };
    if (!gates || !gates.queueUp(r.id)) return { error: `${r.name}'s virtual queue isn't up right now — nothing to join. Mugibot posts in #virtual-queue-detection when it is.` };
    const device = this.checkoutDevice(userId);
    if (!device) return { error: `No browser with the ${this.cfg.appName} extension is connected yet — connect the one on your computer at ${this.cfg.baseUrl}/app#extension.` };
    const lobby = this.lobby(userId, r, 'discord');
    return { lobby, device: { id: device.id, name: device.name }, listening: this.isListening(device.id) };
  }

  /** The queues this (checkout) browser should get in line for now — each handed over once. */
  lobbiesFor(user, device) {
    const map = this.lobbies.get(user.id);
    if (!map) return [];
    const checkout = this.checkoutDevice(user.id);
    if (!checkout || checkout.id !== device.id) return [];
    const out = [];
    for (const [store, l] of map) {
      if (this.now() - l.at > LOBBY_MS) { map.delete(store); continue; }
      if (l.sent === device.id) continue;
      l.sent = device.id;
      const g = this.ctx.gates ? this.ctx.gates.get(l.store) : null;
      out.push({ id: l.id, store: l.store, storeName: l.storeName, url: l.url, by: l.by, since: g ? g.since : null });
    }
    return out;
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
    // Discord's ⚡ Buy: the member pressed it, and its reply in Discord says how it went too.
    const remote = row.trigger === 'remote';
    const ev = {
      placed: { level: 'success', title: `✅ Auto-checkout placed your order: ${row.name}`, message: `${storeName}${total ? ` · ${money(total)}` : ''}\nThe store emails you the confirmation.${remote ? '' : ' To buy it again, arm it again in Mugibot.'}` },
      ready: { level: 'urgent', title: `🛒 Checkout ready: ${row.name}`, message: `${storeName}\nYour browser filled checkout in and stopped at the final button — press it to buy.` },
      needs_you: { level: 'urgent', title: `⚠️ Auto-checkout needs you: ${row.name}`, message: `${storeName}\n${text}${pressed ? '' : ' Finish it in the tab that opened.'}` },
      failed: { level: 'warn', title: `❌ Auto-checkout didn't buy ${row.name}`, message: `${storeName}\n${text}${pressed || remote ? '' : ' It stays armed for the next drop.'}` },
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
    if (run) this.followUp(run);
    return run;
  }

  /** The run moved on: its Discord ⚡ Buy reply says so (only that member sees it). */
  followUp(run) {
    const f = this.follows.get(run.id);
    if (!f) return;
    if (this.now() > f.until) { this.follows.delete(run.id); return; }
    const content = `${this.remoteText(run, f.deviceName)}${run.active && f.note ? `\n${f.note}` : ''}`;
    if (content === f.last) return;
    f.last = content;
    if (!run.active) this.follows.delete(run.id);
    if (this.ctx.discord) this.ctx.discord.editReply(f.token, { content, allowed_mentions: { parse: [] } }).catch(() => null);
  }

  /** Runs nobody picked up, or that never finished. */
  expire() {
    const now = this.now();
    const stale = this.db.all(`SELECT * FROM aco_runs WHERE (status IN ('queued', 'sent') AND created_at < :pick)
      OR (status IN ('started', 'checkout') AND updated_at < :run) OR (status = 'placing' AND updated_at < :placing)
      OR (status = 'waiting' AND (updated_at < :beat OR (reason = 'checkpoint' AND created_at < :cp) OR (reason = 'turn' AND created_at < :turn) OR created_at < :queue))`,
    { pick: now - PICKUP_MS, run: now - RUN_MS, placing: now - PLACING_MS, beat: now - WAIT_BEAT_MS, cp: now - CHECKPOINT_MS, turn: now - TURN_MS, queue: now - QUEUE_MS });
    for (const row of stale) {
      if (row.status === 'queued' || row.status === 'sent') this.finish(row.user_id, row, 'expired', 'no_browser', '').catch(() => null);
      else if (row.status === 'placing') this.finish(row.user_id, row, 'needs_you', 'unconfirmed', 'The final button was pressed, but no order confirmation showed. Check your email from the store before buying again.').catch(() => null);
      else if (row.status === 'waiting') {
        const where = this.retailers.name(row.store);
        const lost = row.updated_at < now - WAIT_BEAT_MS;
        this.finish(row.user_id, row, 'failed', 'timeout', lost ? `Lost touch with your browser while it waited at ${where} — is it still open?`
          : row.reason === 'checkpoint' ? `${where}'s checkpoint wasn't solved within 20 minutes`
            : row.reason === 'turn' ? `Your other checkout at ${where} was still going after 20 minutes — it stopped waiting for its turn`
              : `Still in ${where}'s queue after 2 hours — it stopped waiting`).catch(() => null);
      }
      else this.finish(row.user_id, row, 'failed', 'timeout', '').catch(() => null);
    }
  }
}
