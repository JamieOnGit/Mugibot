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
//
// A checkpoint from your phone (Discord's ⚡ Buy pressed away from the computer): the check is for the
// browser that checks out, so solving it on the phone wouldn't let the computer through — and Mugibot
// never moves a pass from one browser to another. Two ways instead, both offered under the ⚡ Buy reply
// and in the member's DM: solve it on the computer from the phone (Chrome Remote Desktop: the tab is in
// front, waiting), or "📱 Finish on this phone" — the computer's checkout stops, and the phone opens the
// store with the product (its cart link) for the member to pass the check and pay there: toPhone().

import { entitlement } from './entitlement.js';
import { newId, purposeKey, signParts, verifyParts } from './crypto.js';
import { PHONE_EXTENSION_VERSION } from './extension.js';
import { olderVersion } from './monitor/sweep.js';
import { buyAction } from './notifier.js';
import { DEFAULT_ACO } from './schema.js';
import { productLink, startBuy } from './routes/user.js';

// Still on its way: waiting for a browser, opening the store, at checkout, pressing the final button.
const ACTIVE = ['queued', 'sent', 'started', 'waiting', 'checkout', 'placing'];
// The oldest extension a checkout you start yourself places the order in (Aco.own: 1.27.0 presses the final
// button again only when the store says it's struggling, and asks your account first). Older: it stops there.
const OWN_EXTENSION_VERSION = '1.27.0';
const DONE = new Set(['placed', 'ready', 'needs_you', 'failed', 'skipped', 'expired']);
// A browser has this long to pick a run up, and a run this long to finish.
const PICKUP_MS = 2 * 60 * 1000;
// …and once its browser has opened the store (sent), this long for the store's page to come in and take
// it up: a hot drop can slow a big store's page to minutes. (As long as the run's code lasts: repo.js.)
const SENT_MS = 5 * 60 * 1000;
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
// Waiting on a checkout that says it isn't on sale yet (a Shop checkout link's "not available for
// purchase"): the browser presses "Pay now" again every couple of seconds, for up to 8 hours from when it
// was first told so (a run started the evening before a 3AM drop), and stops by itself; a run still
// waiting this long after it was made is ended here.
const NOT_LIVE_MS = 8.5 * 60 * 60 * 1000;
// Next in line at a store (another checkout of the member's there goes first): this long at most.
const TURN_MS = 20 * 60 * 1000;
// A queue's lobby (a browser told to get in line) lasts while the queue's up, or this long.
const LOBBY_MS = 3 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
// After this many failed runs in a day, an item stops trying until it's armed again.
const MAX_FAILS = 3;
// "📱 Finish on this phone": its link lasts as long as a run may wait at a checkpoint, and a bit more.
const PHONE_LINK_MS = 30 * 60 * 1000;
// Google's Chrome Remote Desktop, on the phone: the member's own computer, to solve the check there.
export const REMOTE_DESKTOP_URL = 'https://remotedesktop.google.com/access';

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
  not_placed: 'The final button was pressed again and again for 30 minutes, and the store never took the order',
  others: 'Other things were already in the bag: they were bought too',
  store_denied: 'The store\'s bot protection turned your browser away ("Access Denied")',
  wrong_item: "The checkout wasn't for this item alone",
  stopped: 'You stopped it',
  queue: "In the store's virtual queue",
  checkpoint: "The store's checkpoint wants a human to solve it",
  phone: 'You finished it on your phone instead',
  no_shop: "Shop's checkout didn't open — this browser isn't signed in to Shop",
  not_live: "The store's checkout says it isn't on sale yet",
  old_extension: 'The extension in your checkout browser is too old for this store',
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

/** How long a placed run took, drop to order (its first step to its "placed"), in ms — or null. */
export function tookMs(steps) {
  const placed = steps.find((x) => x.status === 'placed');
  return placed && steps.length && typeof steps[0].at === 'number' ? Math.max(0, placed.at - steps[0].at) : null;
}

/** Link buttons as Discord's message components (an empty list clears them). */
export function linkRows(buttons) {
  const b = (buttons || []).filter((x) => x && /^https?:\/\//.test(x.url)).slice(0, 5);
  return b.length ? [{ type: 1, components: b.map((x) => ({ type: 2, style: 5, label: String(x.label).slice(0, 80), url: x.url })) }] : [];
}

export function toRun(r) {
  return r && {
    id: r.id, itemId: r.item_id, store: r.store, sku: r.sku, name: r.name, url: r.url, price: r.price, total: r.total, maxPrice: r.max_price,
    // (Drop to order, for a placed run: how fast it was.)
    tookMs: r.status === 'placed' ? tookMs(parseSteps(r.steps)) : null,
    mode: r.mode, trigger: r.trigger, status: r.status, reason: r.reason || '',
    statusText: r.status === 'waiting' && r.reason === 'checkpoint' ? 'Waiting for you at the checkpoint' : r.status === 'waiting' && r.reason === 'turn' ? 'Next in line' : r.status === 'waiting' && r.reason === 'not_live' ? 'Not on sale yet — pressing "Pay now"' : STATUS_WORD[r.status] || r.status,
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
    this.cards = new Map(); // deviceId → { state, at }: what each browser says of its card (from 1.20) — never the card
    this.variants = new Map(); // runId → the listing's only option (a drop's run opens the store's add-to-cart link)
    this.phoneKey = purposeKey(cfg.dataKey, 'phone-handover');
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
    const rows = this.db.all('SELECT status, price, total, steps FROM aco_runs WHERE user_id = :u AND created_at > :since', { u: userId, since: this.now() - days * DAY });
    const by = (st) => rows.filter((r) => st.includes(r.status)).length;
    // Drop to order, for the orders placed: the typical one (the median) and the fastest.
    const took = rows.filter((r) => r.status === 'placed').map((r) => tookMs(parseSteps(r.steps))).filter((x) => typeof x === 'number').sort((a, b) => a - b);
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
      medianMs: took.length ? took[Math.floor((took.length - 1) / 2)] : null,
      fastestMs: took.length ? took[0] : null,
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

  /** What a browser says of its card as it asks for runs: 'ready', 'saved' (there, but not ready) or 'none'. */
  noteCard(deviceId, state) {
    if (['ready', 'saved', 'none'].includes(state)) this.cards.set(deviceId, { state, at: this.now() });
  }

  /** A browser's card, as it last said (in the last half an hour): { state, ready, saved, at } — or null. */
  cardOf(deviceId) {
    const c = this.cards.get(deviceId);
    if (!c || this.now() - c.at > 30 * 60 * 1000) return null;
    return { state: c.state, ready: c.state === 'ready', saved: c.state !== 'none', at: c.at };
  }

  /** The member's browsers for the Auto-checkout page: which one checks out, which are listening, and their cards. */
  browsers(userId) {
    const checkout = this.checkoutDevice(userId);
    return this.repo.listDevices(userId).map((d) => ({
      id: d.id, name: d.name, version: d.version, lastSeenAt: d.lastSeenAt,
      checkout: !!checkout && checkout.id === d.id, listening: this.isListening(d.id), card: this.cardOf(d.id),
    }));
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
    // (info.later: the monitor's list of alerts to send once every member's run is made — monitor/index.js applyAll.)
    const later = Array.isArray(info.later) ? info.later : null;
    const skip = (reason, message) => this.skip(base, reason, message, later);

    const user = this.repo.userById(userId);
    if (!user || user.disabled) return null;
    if (!entitlement(user, now).active) return skip('membership');
    const r = this.retailers.get(item.store);
    if (!r || !r.flow) return skip('no_flow');
    if (!item.url) return skip('no_page');
    if (item.maxPrice === null || item.maxPrice === undefined) return skip('no_max');
    if (price !== null && price > item.maxPrice) return skip('over_max', `${money(price)} is over your max of ${money(item.maxPrice)}.`);
    if (price !== null && price > s.maxOrder) return skip('over_limit', `${money(price)} is over your limit of ${money(s.maxOrder)} an order.`);
    // (A drop's failures count — not Trigger ACO's, nor a ⚡ Buy pressed in Discord or by you.)
    const fails = this.db.get("SELECT COUNT(*) AS n FROM aco_runs WHERE item_id = :i AND status = 'failed' AND trigger NOT IN ('test', 'remote', 'buy') AND created_at > :since", { i: item.id, since: now - DAY }).n;
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
    // (Whether you're signed in at the store never holds a run back: each store's checkout goes either way —
    //  as a guest, or with your saved details — and a reading of it can be old or wrong (a member signed in at
    //  BIG W was taken for signed out). A store that only sells signed in says so on its own page, and the
    //  run stops there, buying nothing.)
    if (!this.repo.listDevices(userId).length) return skip('no_browser', 'Connect the extension in the browser you keep open.');
    // A store the extension only checks out at from a version on (Shop checkout links: 1.22.0, on Shop's checkout).
    const device = this.checkoutDevice(userId);
    if (r.acoVersion && device && olderVersion(device.version, r.acoVersion)) return skip('old_extension', `${device.name} has ${device.version || 'an older version'} — update it to ${r.acoVersion} (Setup → Extension).`);

    const run = this.create(base, 'queued', '', `Dropped at ${r.name}${price !== null ? ` for ${money(price)}` : ''} — waiting for your browser to check out.`);
    // (The search's listing says its only option: the run goes straight to the store's add-to-cart link
    // with it, even before the catalogue knows the product — a brand-new listing's, say.)
    if (/^\d{1,20}$/.test(String(info.variantId || ''))) {
      this.variants.set(run.id, String(info.variantId));
      if (this.variants.size > 500) this.variants.delete(this.variants.keys().next().value);
    }
    this.wake(userId); // first: every second counts in a drop
    const queued = this.ctx.gates && this.ctx.gates.queueUp(item.store);
    const tell = () => this.notifier.notify(userId, {
      type: 'aco', level: 'urgent', channel: 'aco',
      title: `🤖 Auto-checkout ${info.test ? 'test ' : ''}started: ${item.name}`,
      message: `${r.name}${price !== null ? ` · ${money(price)}` : ''}\n${s.mode === 'place' ? 'Your browser is checking out now, and will place the order.' : 'Your browser is filling in checkout now, and will stop at the final button for you.'}${queued ? `\n🚦 ${r.name}'s virtual queue is up: your browser waits its turn in line first (don't refresh the queue page).` : ''}`,
      name: item.name, sku: item.sku, url: item.url, buttons: [{ label: 'Auto-checkout', url: `${this.cfg.baseUrl}/app#aco` }],
    });
    if (later) later.push(tell);
    else await tell();
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
    if (r.acoVersion && olderVersion(device.version, r.acoVersion)) return { error: `${device.name} has an older copy of the ${this.cfg.appName} extension (${device.version || 'version unknown'}) — update it to ${r.acoVersion} to buy from ${r.name} (${this.cfg.baseUrl}/app#update).` };

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

  /**
   * ⚡ Buy pressed by the member themselves — on the dashboard, a channel's link, or the store panel's "Add to
   * bag → Checkout" — with Auto-checkout on and set to "Place the order for me": the order's placed, within
   * their limits, like an armed drop's. The most it may cost: the item's max price, or else their limit an
   * order (a product that isn't on their watchlist). A run for it, taken up straight away by this browser:
   * what its checkout may do (passFor), or null — it fills checkout in and stops at the final button, as
   * ever: Auto-checkout off or set to stop there, a limit reached, no checkout at this store, or another run
   * of this item already going. product: a watchlist item's id ({ id }), or the page's own product ({ store,
   * sku, name, url }). price: what the page or alert said, if anything.
   */
  own(user, device, product, { price = null, qty = 1 } = {}) {
    if (!user || user.disabled || !device || !entitlement(user, this.now()).active) return null;
    const s = this.settings(user.id);
    if (!s.enabled || s.mode !== 'place') return null;
    const item = product && product.id ? this.repo.getItem(user.id, String(product.id)) : null;
    const store = item ? item.store : product && String(product.store || '');
    const r = store ? this.retailers.get(store) : null;
    if (!r || !r.flow || !this.retailers.enabled(r)) return null;
    if (olderVersion(device.version, OWN_EXTENSION_VERSION) || (r.acoVersion && olderVersion(device.version, r.acoVersion))) return null;
    if (item && this.db.get(`SELECT id FROM aco_runs WHERE item_id = :i AND status IN (${ACTIVE.map((x) => `'${x}'`).join(',')})`, { i: item.id })) return null;
    const known = [price, item && item.lastPrice, item && item.price].find((p) => typeof p === 'number' && Number.isFinite(p) && p > 0) ?? null;
    // (Its max is for one: two of it, twice that — never over the limit an order.)
    const n = Math.max(1, Math.min(10, Number(qty) || 1));
    const cap = item && item.maxPrice !== null && item.maxPrice !== undefined ? Math.min(item.maxPrice * n, s.maxOrder) : s.maxOrder;
    if (known !== null && known * n > cap) return null;
    const day = this.todayWithRunning(user.id);
    if (day.orders >= s.perDay || day.spent + (known !== null ? known * n : cap) > s.spendPerDay) return null;
    const sku = item ? item.sku : String(product.sku || '').slice(0, 80);
    if (!sku) return null;
    const what = item || { id: null, store, sku, name: String(product.name || sku).slice(0, 200), url: String(product.url || '').slice(0, 2000) };
    const row = this.create({ userId: user.id, item: what, price: known, maxPrice: cap, mode: 'place', trigger: 'buy' }, 'started', '',
      `⚡ Buy pressed in ${device.name} — Auto-checkout places the order within your limits`);
    this.db.run('UPDATE aco_runs SET device_id = :d WHERE id = :id', { d: device.id, id: row.id });
    return this.passFor(user.id, row);
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
        ? `🛡️ ${where}'s checkpoint wants a human, in **${deviceName}** (its tab is in front, waiting). The check is for that browser, so solving it on your phone wouldn't let it through. From here: **🖥️ Solve it on my computer** (Chrome Remote Desktop) and it carries on to checkout — or **📱 Finish on this phone**: your computer stops, and the store opens here for you to pass the check and pay.`
        : `🚦 In ${where}'s virtual queue in **${deviceName}**${run.message && /about \d+ min/.test(run.message) ? ` — ${run.message.match(/about \d+ min\w*/)[0]}` : ''}. It waits its turn (never refreshing the page), then checks out.`,
      checkout: `🛒 At ${where}'s checkout in **${deviceName}** — filling it in…`,
      placing: `💳 Placing the order at ${where}…`,
      placed: `✅ **Order placed** at ${where}${total ? ` — ${money(total)}` : ''}. The store emails you the confirmation.`,
      ready: `🛒 **Checkout's ready** in ${deviceName} — press ${where}'s final button there to buy.`,
      needs_you: `⚠️ **It needs you** in ${deviceName}: ${run.message || run.reasonText}`,
      failed: `❌ **Didn't buy it**: ${run.message || run.reasonText}`,
      expired: `❌ **Didn't start**: ${run.reason === 'no_browser' ? `${deviceName} didn't pick it up within 2 minutes — is it open, with the extension connected?` : run.message || run.reasonText}`,
      skipped: run.reason === 'phone' ? `📱 **Finishing it on your phone** — **${deviceName}** stopped. Pass ${where}'s check and pay there.` : `⏭️ **Didn't start**: ${run.message || run.reasonText}`,
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

  /** It dropped, but Auto-checkout didn't start (a limit, signed out…): kept, and the member hears why (later: with the other alerts). */
  async skip(base, reason, extra = '', later = null) {
    const r = this.retailers.get(base.item.store);
    const message = `${REASONS[reason] || reason}${extra ? ` — ${extra}` : ''}`;
    const run = this.create(base, 'skipped', reason, message);
    const tell = () => this.notifier.notify(base.userId, {
      type: 'aco', level: 'warn', channel: 'aco',
      title: `🤖 Auto-checkout didn't start: ${base.item.name}`,
      message: `${r ? r.name : base.item.store}${base.price !== null ? ` · ${money(base.price)}` : ''}\n${message}`,
      name: base.item.name, sku: base.item.sku, url: base.item.url || null,
      buttons: [base.item.url ? { label: '⚡ Buy', url: this.notifier.buyLink(base.userId, base.item), action: buyAction('i', base.item.id) } : null, { label: 'Auto-checkout', url: `${this.cfg.baseUrl}/app#aco` }].filter(Boolean),
    });
    if (later) later.push(tell);
    else await tell();
    return toRun(run);
  }

  /** One purchase per drop watch (monitor/drops.js): its other armed finds disarmed, and the watch's own Auto-checkout off. */
  oncePerWatch(userId, itemId) {
    const it = this.db.get('SELECT drop_watch FROM items WHERE id = :i AND user_id = :u', { i: itemId, u: userId });
    if (!it || !it.drop_watch) return 0;
    const others = this.db.all('SELECT id, name FROM items WHERE user_id = :u AND drop_watch = :w AND aco = 1 AND id != :i', { u: userId, w: it.drop_watch, i: itemId });
    for (const o of others) this.disarm(userId, o.id);
    const off = this.db.run('UPDATE drop_watches SET aco = 0 WHERE id = :w AND user_id = :u AND aco = 1', { w: it.drop_watch, u: userId }).changes;
    if (off && this.ctx.drops) this.ctx.drops.changed();
    if (others.length || off) {
      this.repo.addEvent(userId, { type: 'aco', level: 'info', message: `🤖 One purchase per drop watch: it bought one${others.length ? `, so its other find${others.length === 1 ? '' : 's'} (${others.map((o) => o.name).slice(0, 3).join(', ')}${others.length > 3 ? '…' : ''}) ${others.length === 1 ? 'is' : 'are'} disarmed` : ''} and what it finds next isn't armed — arm it again for another` });
      this.hub.publish(userId, 'drop', {});
    }
    return others.length;
  }

  /**
   * A Shop checkout link's checkout as it last opened: 'in' (Shop's checkout opened and its ⚡ Buy or
   * Auto-checkout code was taken up there — only signed in does it get that far) or 'out' (it went on to
   * the store's guest checkout instead), and how it was seen.
   */
  noteShopSeen(userId, item, status, how) {
    const r = item && this.retailers.get(item.store);
    if (!r || !r.cartLinks) return;
    const all = this.repo.getData(userId, 'shopSeen', null) || {};
    all[item.id] = { status, at: this.now(), how };
    // (Only links still on the watchlist.)
    const ids = new Set(this.repo.listItems(userId).filter((x) => x.store === item.store).map((x) => x.id));
    this.repo.setData(userId, 'shopSeen', Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))));
    this.hub.publish(userId, 'watch', { id: item.id });
  }

  rearm(userId, itemId) {
    const n = this.db.run('UPDATE items SET aco = 1, aco_at = :t WHERE id = :i AND user_id = :u AND aco = 0', { t: this.now(), i: itemId, u: userId }).changes;
    if (n) this.hub.publish(userId, 'watch', { id: itemId, aco: true });
    return n > 0;
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
      const go = startBuy(this.ctx, user, { ...item, quantity: 1 }, { runId: row.id, variantId: this.variants.get(row.id) || null });
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
    return this.passFor(userId, row);
  }

  /**
   * What a checkout of this run may do (the tab's pass in the extension): place the order or stop at the
   * final button, and the most the order may cost — the item's max price plus delivery, never over the
   * member's limit. orderLimit: the most with other things already in the bag (they're bought too): the
   * member's limit an order, and what's left of their day's spending.
   */
  passFor(userId, row) {
    const s = this.settings(userId);
    // (Never more than what's left of the day's spending, either.)
    const left = Math.max(0, Math.round((s.spendPerDay - this.today(userId).spent) * 100) / 100);
    const maxTotal = Math.min(s.maxOrder, (row.max_price ?? s.maxOrder) + 40, left);
    const orderLimit = Math.min(s.maxOrder, left);
    return { runId: row.id, mode: row.mode, maxPrice: row.max_price, maxTotal, orderLimit, name: row.name, sku: row.sku };
  }

  /**
   * What happened, from the browser: status 'checkout' | 'ready' | 'placing' | 'placed' | 'needs_you' | 'failed',
   * reason (REASONS), message, total.
   */
  async report(userId, runId, { status, reason = '', message = '', total = null, pressed = false, again = false, live = false }) {
    const row = this.get(userId, runId);
    if (!row) return null;
    // Done is done — except a payment the member finished themselves (the bank's check) turning out placed;
    // and a run closed here for want of news (timed out) whose final button the browser did press after all:
    // that's an order, counted towards the day's limits and the arming used up. (Pressing it *again*, the
    // browser asks first — again — and a closed run says no.)
    const late = (row.status === 'failed' && row.reason === 'timeout') && !again && (status === 'placing' || status === 'placed');
    if (DONE.has(row.status) && !(row.status === 'needs_you' && status === 'placed') && !late) return toRun(row);
    if (typeof total === 'number' && Number.isFinite(total) && total > 0) this.db.run('UPDATE aco_runs SET total = :t WHERE id = :id', { t: Math.round(total * 100) / 100, id: row.id });
    if (late && status === 'placing') {
      // (Pressed after the run had been closed here: counted as an order — for the member to check — and never
      //  pressed again: a run that's needs-you refuses the browser's "again".)
      this.step(row.id, 'placing', message || 'Final button pressed');
      return this.finish(userId, this.get(userId, row.id), 'needs_you', 'unconfirmed', `The final button was pressed after this run had timed out here — check your email from ${this.retailers.name(row.store)} before buying it again.`);
    }
    if (status === 'note') {
      // Something the member should know, said on the run (other things in the bag, being bought too) — and in their activity.
      if (!ACTIVE.includes(row.status)) return toRun(row);
      this.step(row.id, row.status, message);
      this.repo.addEvent(userId, { type: 'aco', level: 'warn', message: `🤖 ${row.name}: ${message}`, name: row.name, sku: row.sku, url: row.url || null });
      return this.publish(userId, row.id);
    }
    if (status === 'placing' && live && row.status === 'waiting' && row.reason === 'not_live') {
      // Pressed again on a checkout that says it isn't on sale yet (every couple of seconds, until it is): the
      // run stays waiting for the sale. The press is on it — one step, its count kept up to date — and the
      // arming's used up (armed again if the wait ends with nothing bought).
      const last = parseSteps(row.steps).at(-1);
      if (last && last.status === 'placing' && String(last.message || '').replace(/\d+/g, '#') === String(message || '').replace(/\d+/g, '#')) this.restep(row.id, message);
      else this.step(row.id, 'placing', message || 'Final button pressed');
      this.disarm(userId, row.item_id);
      return this.publish(userId, row.id);
    }
    if (status === 'checkout' || status === 'placing') {
      // (The browser sends these without waiting for an answer: "at checkout" arriving after the final
      // button's "placing" is old news.)
      if (status === 'checkout' && row.status === 'placing') return toRun(row);
      this.db.run("UPDATE aco_runs SET status = :st, reason = '', updated_at = :t WHERE id = :id", { st: status, t: this.now(), id: row.id });
      // (Said again while a slow checkout's at it — a hot drop: the final button turning on, pressed again —
      //  each keeps the run going; only news, not its counting, is a new step.)
      const last = parseSteps(row.steps).at(-1);
      const same = last && last.status === status && String(last.message || '').replace(/\d+/g, '#') === String(message || '').replace(/\d+/g, '#');
      if (!same) this.step(row.id, status, message);
      // The final button is pressed: this arming is used up, whatever happens next.
      if (status === 'placing') this.disarm(userId, row.item_id);
      return this.publish(userId, row.id);
    }
    if (status === 'waiting') return this.waiting(userId, row, ['checkpoint', 'turn', 'not_live'].includes(reason) ? reason : 'queue', message);
    if (status === 'started' && row.status === 'waiting') {
      // Through the queue (or past the checkpoint): carrying on.
      this.db.run("UPDATE aco_runs SET status = 'started', reason = '', updated_at = :t WHERE id = :id", { t: this.now(), id: row.id });
      this.step(row.id, 'started', message || (row.reason === 'turn' ? `Its turn — opening ${this.retailers.name(row.store)}` : `Through — carrying on at ${this.retailers.name(row.store)}`));
      return this.publish(userId, row.id);
    }
    if (!['ready', 'placed', 'needs_you', 'failed'].includes(status)) return toRun(row);
    // (A Shop link's tab that never reached Shop's checkout, as the browser saw it: only while the run's
    // still not picked up there — a checkout that got going is reporting for itself.)
    if (reason === 'no_shop' && !['sent', 'queued'].includes(row.status)) return toRun(row);
    if (reason === 'no_shop' && row.item_id) this.noteShopSeen(userId, this.repo.getItem(userId, row.item_id), 'out', 'run');
    // (pressed: the browser pressed the final button — its "placing", sent without waiting, may not be here yet.)
    if (pressed && row.status !== 'placing' && !parseSteps(row.steps).some((x) => x.status === 'placing')) {
      this.step(row.id, 'placing', 'Final button pressed');
      return this.finish(userId, this.get(userId, row.id), status, reason, message);
    }
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
    // (Not on sale yet: also after "Pay now" was pressed — the store said no, so nothing was bought.)
    const from = reason === 'not_live' ? ['started', 'checkout', 'waiting', 'placing'] : ['queued', 'sent', 'started', 'checkout', 'waiting'];
    if (!from.includes(row.status)) return toRun(row);
    // (Not on sale yet: said once a run, however many times its button's pressed and refused — a wait in a
    //  queue before it doesn't count.)
    const first = reason === 'not_live'
      ? row.reason !== 'not_live' && !parseSteps(row.steps).some((x) => x.status === 'waiting' && /not on sale yet|isn't on sale/i.test(x.message || ''))
      : row.status !== 'waiting' || row.reason !== reason;
    const text = message || REASONS[reason];
    this.db.run("UPDATE aco_runs SET status = 'waiting', reason = :r, message = :m, updated_at = :t WHERE id = :id", { r: reason, m: text, t: this.now(), id: row.id });
    const last = parseSteps(row.steps).at(-1);
    if (first || !last || last.message !== text) this.step(row.id, 'waiting', text);
    const run = this.publish(userId, row.id);
    if (first && reason !== 'turn') {
      const where = this.retailers.name(row.store);
      await this.notifier.notify(userId, {
        type: 'aco', level: 'urgent', channel: 'aco',
        title: reason === 'checkpoint' ? `🛡️ ${where}'s checkpoint needs you: ${row.name}` : reason === 'not_live' ? `⏳ Not on sale yet at checkout: ${row.name}` : `🚦 In ${where}'s queue: ${row.name}`,
        message: reason === 'not_live'
          ? `${text}\nYour browser is on the checkout, everything filled in, pressing "Pay now" again every couple of seconds until the store takes the order (for up to 8 hours). Nothing has been bought yet. Keep that computer on and its tab open.`
          : reason === 'checkpoint'
          ? `${where} wants a human check (hCaptcha) before checkout, in the browser that's checking out — Mugibot never touches the check itself. At the computer: solve it in the tab that opened, and it carries on to checkout. On your phone: solve it on the computer with Chrome Remote Desktop (the tab's in front), or finish it on the phone instead — the computer stops, and the store opens on the phone for you to pass the check and pay.`
          : `${text}\nYour browser is waiting its turn and carries on when it's through. Leave the queue page alone: it refreshes itself.`,
        name: row.name, sku: row.sku, url: row.url || null,
        buttons: [...(reason === 'checkpoint' ? this.phoneButtons(this.get(userId, row.id)) : []), { label: 'Auto-checkout', url: `${this.cfg.baseUrl}/app#aco` }],
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
    return startBuy(this.ctx, user, { ...item, quantity: 1 }, { runId: row.id, variantId: this.variants.get(row.id) || null }).url;
  }

  // ---------------------------------------------------------------------------
  // A checkpoint from the phone: finish it there instead (see the top of this file)
  // ---------------------------------------------------------------------------
  /** "📱 Finish on this phone": a link only this run's member is given (Discord's ⚡ Buy reply, their DM). */
  phoneLink(userId, runId) {
    const t = signParts(this.phoneKey, [userId, runId], this.now() + PHONE_LINK_MS);
    return `${this.cfg.baseUrl}/phone/${encodeURIComponent(runId)}?t=${t}`;
  }

  /** The run a phone link is for (null: not one Mugibot made, or it's run out). */
  phoneRow(runId, t) {
    const row = this.db.get('SELECT * FROM aco_runs WHERE id = :id', { id: String(runId || '').slice(0, 40) });
    return row && verifyParts(this.phoneKey, [row.user_id, row.id], t, this.now()) ? row : null;
  }

  /**
   * Can the phone take this checkout over now? { can, stop (the computer's checkout is stopped first),
   * note (why not) }. Only before the computer has started it, or while it waits at the checkpoint (an
   * extension that stops there when told: PHONE_EXTENSION_VERSION) — never once it may be paying.
   * Over already (filled in for you, stopped, didn't start): nothing to stop, the store's link is all.
   */
  phoneState(row) {
    const where = this.retailers.name(row.store);
    if (row.status === 'queued' || row.status === 'sent') return { can: true, stop: true };
    if (row.status === 'waiting' && row.reason === 'checkpoint') {
      const device = row.device_id ? this.repo.listDevices(row.user_id).find((d) => d.id === row.device_id) : null;
      if (device && olderVersion(device.version, PHONE_EXTENSION_VERSION)) {
        return { can: false, note: `${device.name} has an older copy of ${this.cfg.appName}'s extension (${device.version || 'version unknown'}), which can't be stopped at the checkpoint from here. Solve the check on your computer (from your phone: Chrome Remote Desktop), and update the extension to ${PHONE_EXTENSION_VERSION} for next time.` };
      }
      return { can: true, stop: true };
    }
    const pressed = row.status === 'placing' || parseSteps(row.steps).some((x) => x.status === 'placing');
    if (row.status === 'placed') return { can: false, note: `Your computer already placed the order at ${where} — the store emails you the confirmation. Don't buy it again.` };
    if (pressed) return { can: false, note: `Your computer pressed ${where}'s final button — check your email from the store before you buy it again.` };
    if (ACTIVE.includes(row.status)) return { can: false, note: `Your computer is checking it out at ${where} right now — let it finish. (If it stops at the checkpoint, this link works then.)` };
    return { can: true, stop: false };
  }

  /** What the phone's page shows before it's pressed (routes/user.js). Null: an expired or unknown link. */
  phoneInfo(runId, t) {
    const row = this.phoneRow(runId, t);
    if (!row) return null;
    const st = this.phoneState(row);
    return { name: row.name, store: row.store, storeName: this.retailers.name(row.store), status: row.status, statusText: toRun(row).statusText, checkpoint: row.status === 'waiting' && row.reason === 'checkpoint', can: st.can, stop: !!st.stop, note: st.note || '' };
  }

  /**
   * "📱 Finish on this phone" pressed: the computer's checkout stops — in one step, and only if it's
   * still where it was (one that got through the checkpoint a moment ago carries on) — and the phone
   * gets the store's link with the product: { url, stopped } or { error }.
   */
  async toPhone(runId, t) {
    let row = this.phoneRow(runId, t);
    if (!row) return { error: 'This link has run out — press ⚡ Buy in Discord again.' };
    let st = this.phoneState(row);
    if (!st.can) return { error: st.note };
    const url = this.storeLink(row);
    if (!st.stop) return { url, stopped: false };
    const where = this.retailers.name(row.store);
    const text = row.status === 'waiting' ? `You finished it on your phone instead — your computer stopped at ${where}'s checkpoint` : 'You finished it on your phone instead — your computer didn\'t start it';
    const n = this.db.run("UPDATE aco_runs SET status = 'skipped', reason = 'phone', message = :m, updated_at = :t WHERE id = :id AND status = :st AND reason = :r",
      { m: text, t: this.now(), id: row.id, st: row.status, r: row.reason || '' }).changes;
    if (!n) {
      // (It moved on meanwhile: whatever it is now decides.)
      row = this.get(row.user_id, row.id);
      st = this.phoneState(row);
      return st.can && !st.stop ? { url, stopped: false } : { error: st.note || `Your computer just moved on at ${where} — press the link again in a moment.` };
    }
    this.step(row.id, 'skipped', text);
    // One purchase per arming: it's being bought on the phone, so it isn't armed any more (arm it again for the next drop).
    const disarmed = this.disarm(row.user_id, row.item_id);
    this.publish(row.user_id, row.id);
    this.repo.addEvent(row.user_id, { type: 'aco', level: 'info', message: `📱 ${row.name}: finishing it on your phone — your computer's checkout at ${where} stopped${disarmed ? ', and it\'s disarmed (arm it again for the next drop)' : ''}`, name: row.name, sku: row.sku, url: row.url || null });
    return { url, stopped: true };
  }

  /** Was this run handed to the phone? (Its ⚡ Buy code then opens nothing on the computer: routes/ext.js /claim.) */
  handedOff(userId, runId) {
    const row = this.get(userId, runId);
    return !!row && row.status === 'skipped' && row.reason === 'phone';
  }

  /** The store's page for the phone: its cart link with the product where it has one (Shopify's), else the product. */
  storeLink(row) {
    const item = row.item_id ? this.repo.getItem(row.user_id, row.item_id) : null;
    return productLink(this.ctx, { store: row.store, sku: row.sku, url: (item && item.url) || row.url }, this.variants.get(row.id) || null);
  }

  /** Under a checkpoint's message (the ⚡ Buy reply, the DM): finish on the phone, or solve it on the computer from there. */
  phoneButtons(row) {
    const out = [];
    if (this.phoneState(row).can) out.push({ label: '📱 Finish on this phone', url: this.phoneLink(row.user_id, row.id) });
    out.push({ label: '🖥️ Solve it on my computer', url: REMOTE_DESKTOP_URL });
    return out;
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
    // Waiting on a checkout that said it isn't on sale to its final button, every time it was pressed (a
    // Shop checkout link's "not available for purchase"): nothing was bought, so it's armed again for when
    // it is. (Only from that wait: a run ended as anything else after a press has its arming used up.)
    if (reason === 'not_live' && row.status === 'waiting' && row.reason === 'not_live' && row.item_id) this.rearm(userId, row.item_id);
    // A drop watch's find bought (or it may have been): one purchase per watch — its other finds are
    // disarmed, and what it finds from now on isn't armed (a broad watch would buy every listing that matches).
    if (status === 'placed' || (pressed && status === 'needs_you')) this.oncePerWatch(userId, row.item_id);
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

  /** The run's last step said again, as it is now (a count gone up): its words and time. */
  restep(id, message) {
    const row = this.db.get('SELECT steps FROM aco_runs WHERE id = :id', { id });
    if (!row) return;
    const steps = parseSteps(row.steps);
    if (!steps.length) return;
    steps[steps.length - 1] = { ...steps[steps.length - 1], at: this.now(), message: String(message || '').slice(0, 300) };
    this.db.run('UPDATE aco_runs SET steps = :s, updated_at = :t WHERE id = :id', { s: JSON.stringify(steps), t: this.now(), id });
  }

  step(id, status, message) {
    const row = this.db.get('SELECT steps FROM aco_runs WHERE id = :id', { id });
    if (!row) return;
    const steps = parseSteps(row.steps);
    steps.push({ at: this.now(), status, message: String(message || '').slice(0, 300) });
    this.db.run('UPDATE aco_runs SET steps = :s, updated_at = :t WHERE id = :id', { s: JSON.stringify(steps.slice(-40)), t: this.now(), id });
  }

  publish(userId, id) {
    const row = this.db.get('SELECT * FROM aco_runs WHERE id = :id', { id });
    const run = toRun(row);
    if (run) this.hub.publish(userId, 'aco', run);
    if (run) this.followUp(run, row);
    return run;
  }

  /** The run moved on: its Discord ⚡ Buy reply says so (only that member sees it). */
  followUp(run, row = null) {
    const f = this.follows.get(run.id);
    if (!f) return;
    if (this.now() > f.until) { this.follows.delete(run.id); return; }
    const content = `${this.remoteText(run, f.deviceName)}${run.active && f.note ? `\n${f.note}` : ''}`;
    // (At the checkpoint: its two ways through from the phone, as buttons. Otherwise none.)
    const buttons = row && run.status === 'waiting' && run.reason === 'checkpoint' ? this.phoneButtons(row) : [];
    const key = `${content}|${buttons.map((b) => b.label).join(',')}`;
    if (key === f.last) return;
    f.last = key;
    if (!run.active) this.follows.delete(run.id);
    if (this.ctx.discord) this.ctx.discord.editReply(f.token, { content, components: linkRows(buttons), allowed_mentions: { parse: [] } }).catch(() => null);
  }

  /** Runs nobody picked up, or that never finished. */
  expire() {
    const now = this.now();
    const stale = this.db.all(`SELECT * FROM aco_runs WHERE (status = 'queued' AND created_at < :pick) OR (status = 'sent' AND created_at < :sent)
      OR (status IN ('started', 'checkout') AND updated_at < :run) OR (status = 'placing' AND updated_at < :placing)
      OR (status = 'waiting' AND (updated_at < :beat OR (reason = 'checkpoint' AND created_at < :cp) OR (reason = 'turn' AND created_at < :turn) OR (reason = 'not_live' AND created_at < :live) OR (reason <> 'not_live' AND created_at < :queue)))`,
    { pick: now - PICKUP_MS, sent: now - SENT_MS, run: now - RUN_MS, placing: now - PLACING_MS, beat: now - WAIT_BEAT_MS, cp: now - CHECKPOINT_MS, turn: now - TURN_MS, live: now - NOT_LIVE_MS, queue: now - QUEUE_MS });
    for (const row of stale) {
      if (row.status === 'queued' || row.status === 'sent') this.finish(row.user_id, row, 'expired', 'no_browser', '').catch(() => null);
      else if (row.status === 'placing') this.finish(row.user_id, row, 'needs_you', 'unconfirmed', 'The final button was pressed, but no order confirmation showed. Check your email from the store before buying again.').catch(() => null);
      else if (row.status === 'waiting') {
        const where = this.retailers.name(row.store);
        const lost = row.updated_at < now - WAIT_BEAT_MS;
        if (row.reason === 'not_live' && !lost) {
          this.finish(row.user_id, row, 'failed', 'not_live', `${where}'s checkout still said it isn't on sale — nothing was bought, and it's armed again for when it is.`).catch(() => null);
          continue;
        }
        // (Lost touch while it pressed "Pay now" on a checkout that wasn't on sale: the last press may have gone through.)
        if (row.reason === 'not_live' && parseSteps(row.steps).some((x) => x.status === 'placing')) {
          this.finish(row.user_id, row, 'needs_you', 'unconfirmed', `Lost touch with your browser while it was pressing "Pay now" at ${where} — check your email from the store before buying it again.`).catch(() => null);
          continue;
        }
        this.finish(row.user_id, row, 'failed', 'timeout', lost ? `Lost touch with your browser while it waited at ${where} — is it still open?`
          : row.reason === 'checkpoint' ? `${where}'s checkpoint wasn't solved within 20 minutes`
            : row.reason === 'turn' ? `Your other checkout at ${where} was still going after 20 minutes — it stopped waiting for its turn`
              : `Still in ${where}'s queue after 2 hours — it stopped waiting`).catch(() => null);
      }
      else this.finish(row.user_id, row, 'failed', 'timeout', '').catch(() => null);
    }
  }
}
