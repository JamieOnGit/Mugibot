// Drop watches (docs/MONITORING.md → Drop watches): anything outside the card keywords — a console,
// a collectible, a product at any shop — watched for the moment it drops or comes back in stock.
//
// A watch is either:
// - a product's link. At a store Mugibot knows (JB Hi-Fi, Kmart, …) its page is checked like any
//   monitored product, and ⚡ Buy and Auto-checkout work as they do for trading cards. At another
//   website its page is read for its stock: alerts only (Mugibot has no checkout there).
// - the words in its name, and where to look: a store Mugibot searches (its own search, in the live
//   sweeps' turn: one search in three at most, each watch's words about every half a minute), or
//   another website (its search, or a page of it, read every couple of minutes, gently and as
//   Mugibot). Anything whose name has every word counts, trading cards or not.
//
// An admin's watch can be for everyone: what it finds is a monitored product in everyone's Tracked
// products, posted in #non-tcg-alerts (category Non-TCG) — or in the Discord channel the admin chose
// for it, pinging the role they chose — and members ☆ Watch it for their own DM and to arm
// Auto-checkout. Anyone's own watch is theirs alone: what it finds goes on their watchlist,
// and only they are told (their DMs). Auto-checkout (stores Mugibot checks out at), up to a max
// price: a link is armed like a watchlist item; words (and a search page's key phrases) arm only what
// drops after the watch was added — a new listing, or something that wasn't on sale when the watch
// first read it — by what the watch itself saw (monitor/sightings.js), as VIP watches do: a broad
// watch would otherwise buy everything that matches.

import crypto from 'node:crypto';
import { CATEGORIES, linkName, productName } from '../catalog.js';
import { newId } from '../crypto.js';
import { ENTITLED_SQL } from '../repo.js';
import { bad, bool, httpUrl, item as checkItem, num, str } from '../schema.js';
import { norm, siteAnswer, siteUrl } from './listing.js';
import { MonitorAdmin } from './manage.js';
import { PAGE_DEFAULT_SECONDS, PAGE_MAX_SECONDS, floorFor, isProductPage, pageLink, pageProblem, phrasesOf, planFor } from './pages.js';
import { publicError } from './public.js';
import { BlockedUrlError, safeFetch } from './safeurl.js';
import { STATUS, isOrderable } from './status.js';
import { readingOf } from './sightings.js';

const KINDS = ['restock', 'listed', 'price_drop'];
export const DROP_NOTE = 'Drop watch';
// Words (a key phrase: "Heavy Hitters Premium") looked for at every store Mugibot searches at once: each store's own
// search, in its turn, and every product any of its searches reads — each store's first look its own "before".
export const ALL_STORES = 'all';
// What one watch keeps of what it found: an admin's (monitored products), anyone's own (watchlist items).
const MAX_FOUND_SHARED = 20;
const MAX_FOUND_OWN = 10;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
// Statuses that say whether something's on sale (not a failed or empty read): a find's stock as a search said it.
// (In the store's shops only — Kmart's "In store only" — is a reading too: not on sale online yet.)
const READ = new Set([STATUS.IN_STOCK, STATUS.PREORDER, STATUS.OUT_OF_STOCK, STATUS.COMING_SOON, STATUS.NOT_LISTED, STATUS.IN_STORE]);
// A read that failed (refused, or an error).
const FAILED = new Set([STATUS.BLOCKED, STATUS.ERROR]);
const NO_ACO = 'Auto-checkout works at stores Mugibot has a checkout for — at another website you get the alert, and buy it there yourself';
// What an admin's watch for everyone posts in the channel chosen for it: its drops, restocks (and
// pre-orders) and price drops.
export const DROP_ROUTE_KINDS = ['listed', 'restock', 'price_drop'];
// A drop watch's find going down in price, for its owner (their own watch: a DM): at least this much
// lower (and a dollar), and said again only when it goes lower still — or half a day later.
export const OWN_PRICE_DROP_PERCENT = 1;
export const OWN_PRICE_AGAIN_MS = 12 * 60 * 60 * 1000;
const SNOWFLAKE = /^\d{5,25}$/;
const DEST_MS = 60 * 1000;
const json = (s, fallback) => { try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; } };

/** Words to look for: lower case, no accents or punctuation ("Xbox Series X!" → "xbox series x"). */
export function wordsOf(v) {
  return norm(str(v, 60)).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A drop watch's words in a product's name: every one of them. A short word (three letters or fewer)
 * or a number is a whole word — "x" isn't "Xbox", "5" isn't "50", "pro" isn't "Promo" (a plural is
 * fine: "box" → "Boxes") — so "xbox series x" isn't the Series S, nor "playstation 5 pro" a "PlayStation
 * 5 … Promo Bundle". A longer word counts at the start of one: "skate" → "Skateboard", "pokemon" →
 * "Pokémon's".
 */
export function hasWords(title, words) {
  const t = ` ${norm(title).replace(/[^a-z0-9]+/g, ' ')} `;
  const list = norm(words).split(/[^a-z0-9]+/).filter(Boolean);
  return list.length > 0 && list.every((w) => (w.length <= 3 || /^\d+$/.test(w) ? new RegExp(` ${w}(e?s)? `).test(t) : t.includes(` ${w}`)));
}

/** Another website's product code: its address and the last part of its link (one per site). */
export function otherSku(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const host = u.host.replace(/^www\./, '').toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  let slug = segs.length ? segs[segs.length - 1] : '';
  try { slug = decodeURIComponent(slug); } catch { /* as it is */ }
  slug = slug.replace(/\.(html?|aspx|php)$/i, '').replace(/\s+/g, '-');
  const sku = slug ? `${host}/${slug}` : host;
  if (sku.length <= 60) return sku;
  return `${slug.slice(0, 51)}~${crypto.createHash('sha1').update(`${host}${u.pathname}`).digest('hex').slice(0, 8)}`;
}

/** A name from a product link ("…/products/xbox-series-x-console" → "Xbox Series X Console"). */
export const nameFromLink = linkName;

function toWatch(r) {
  return r && {
    id: r.id, userId: r.user_id, username: r.username || '', active: r.active !== 0, shared: !!r.shared,
    store: r.store, site: r.site, words: r.words, url: r.url, label: r.label, category: r.category,
    aco: !!r.aco, maxPrice: r.max_price ?? null, found: json(r.found, []), how: r.how, seen: r.seen ?? 0,
    baselineAt: r.baseline_at ?? null, bases: json(r.bases, {}), nextAt: r.next_at || 0, lastAt: r.last_at ?? null, lastOkAt: r.last_ok_at ?? null,
    fails: r.fails || 0, error: r.error || '', createdAt: r.created_at,
    channelId: r.channel_id || '', roleId: r.role_id || '',
    // A search page's (monitor/pages.js): its link, the key phrases looked for on it, and how often it's read.
    page: r.page || '', phrases: json(r.phrases, []), every: r.every_seconds || 0,
  };
}

/** What a watch is called in what it says: its name, its words, its key phrases, or its link. */
export function nameOf(w) {
  return w.label || w.words || (w.phrases && w.phrases.length ? w.phrases.join(', ') : '') || w.url || w.page;
}

export class Drops {
  constructor({ cfg, db, repo, catalog, retailers, hub, notifier, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { cfg, db, repo, catalog, retailers, hub, notifier, fetch: fetchImpl, now });
    this.cache = null;
    this.cacheAt = 0;
    // When each store's watch words were last searched there (the live sweeps), and words to search next.
    this.searchedAt = new Map();
    this.urgent = new Set();
    this.hostNext = new Map();
    this.timer = null;
    this.busy = false;
    this.dest = null; // the Discord server's channels and roles, for the admins' pickers (a minute)
    // Other websites that refuse the server, read from a browser: when each watch is next due there, and last read there.
    this.browserNext = new Map();
    this.browserOkAt = new Map();
    this.browserFails = new Map();
    // (Set by app.js: monitor, sweeper, ctx.)
  }

  get sweepMs() { return Math.max(5, this.cfg.monitor.dropSweepSeconds ?? 30) * 1000; }
  get siteMs() { return Math.max(30, this.cfg.monitor.dropSiteSeconds ?? 120) * 1000; }

  /** How many drop watches someone can have: admins three times as many. */
  limitFor(user) {
    return (this.cfg.limits.dropWatches || 10) * (user && user.role === 'admin' ? 3 : 1);
  }

  /** Every watch, with whether its owner's membership is active (cached: the sweeps ask on every search). */
  watches() {
    const now = this.now();
    if (!this.cache || now - this.cacheAt > 60 * 1000) {
      this.cache = this.db.all(`SELECT d.*, u.username AS username, CASE WHEN u.disabled = 0 AND ${ENTITLED_SQL} THEN 1 ELSE 0 END AS active
        FROM drop_watches d JOIN users u ON u.id = d.user_id ORDER BY d.created_at`, { now }).map(toWatch);
      this.cacheAt = now;
    }
    return this.cache;
  }

  /** The watches looked for now (their owners' memberships are active). */
  live() {
    return this.watches().filter((w) => w.active);
  }

  get(id) {
    return this.watches().find((w) => w.id === id) || null;
  }

  changed() {
    this.cache = null;
  }

  /**
   * Room for another find? What was listed already at the watch's first look, and what dropped after it,
   * each have their own room — so a broad watch whose first look found plenty still hears of what drops.
   * (Finds from before this was told apart: listed already if they were found by its first look.)
   */
  room(w, baseline) {
    // (Every store's: twice as much — the same phrase at several stores.)
    const max = (w.shared ? MAX_FOUND_SHARED : MAX_FOUND_OWN) * (w.store === ALL_STORES ? 2 : 1);
    const isBase = (f) => (typeof f.base === 'boolean' ? f.base : !!w.baselineAt && f.at <= w.baselineAt);
    // (Your own watch's finds you've taken off your watchlist make room: they're never put back.)
    const kept = (f) => !f.itemId || !!this.db.get('SELECT 1 AS y FROM items WHERE id = :id', { id: f.itemId });
    return w.found.filter((f) => isBase(f) === !!baseline && kept(f)).length < max;
  }

  /** What it found (kept on the watch object too, so a loop over finds sees each one). */
  saveFound(w, found) {
    // (Both kinds of find, each to its most: what's dropped since its first look is never dropped from it.)
    w.found = found.slice(-4 * Math.max(MAX_FOUND_SHARED, MAX_FOUND_OWN));
    this.db.run('UPDATE drop_watches SET found = :f WHERE id = :id', { id: w.id, f: JSON.stringify(w.found) });
    this.changed();
  }

  /** Where a watch looks: the store's name, or the website's address. */
  where(w) {
    if (w.store === 'other') return this.retailers.siteName('other', w.site || w.url);
    if (w.store === ALL_STORES) return 'every store';
    return this.retailers.name(w.store);
  }

  // ---------------------------------------------------------------------------
  // Words at a store Mugibot searches: in the live sweeps' turn (sweep.js)
  // ---------------------------------------------------------------------------
  /** The words watches at a store (its own, and every store's). */
  wordsAt(storeId) {
    return this.live().filter((w) => w.words && (w.store === storeId || (w.store === ALL_STORES && storeId !== 'other')));
  }

  /** When a watch first looked at this store (what was listed there then was there already) — or null. */
  baseAt(w, storeId) {
    return w.store === ALL_STORES ? (w.bases && w.bases[storeId]) || null : w.baselineAt;
  }

  /** A search for these words at a store: 'shared' when an admin's watch for everyone has them, else 'private'. */
  kindOf(storeId, words) {
    return this.wordsAt(storeId).some((w) => w.words === words && w.shared) ? 'shared' : 'private';
  }

  /**
   * The next search at a store for a drop watch's words, or null (sweep.js's nextTerm). One search in
   * three at most, so the card keywords keep most of the store's searches: the words searched longest
   * ago, once their turn has come (every half a minute or so). A watch just added, or asked to check
   * now, goes first.
   */
  nextTerm(r, st) {
    const list = this.wordsAt(r.id);
    if (!list.length) return null;
    const now = this.now();
    const key = (wd) => `${r.id}|${wd}`;
    const words = [...new Set(list.map((w) => w.words))];
    const lastAt = (wd) => this.searchedAt.get(key(wd)) ?? Math.max(0, ...list.filter((w) => w.words === wd).map((w) => w.lastAt || 0));
    // (A watch yet to look here — every store's too, at each store in turn — goes first.)
    let pick = words.find((wd) => this.urgent.has(key(wd))) || words.find((wd) => !this.searchedAt.has(key(wd)) && list.some((w) => w.words === wd && !this.baseAt(w, r.id)));
    st.dropTurn = ((st.dropTurn || 0) + 1) % 3;
    if (!pick && st.dropTurn === 0) pick = words.filter((wd) => now - lastAt(wd) >= this.sweepMs).sort((a, b) => lastAt(a) - lastAt(b))[0];
    if (!pick) return null;
    this.urgent.delete(key(pick));
    this.searchedAt.set(key(pick), now);
    return { keyword: pick, page: 1, drop: this.kindOf(r.id, pick) };
  }

  /** An admin's watch for everyone whose words are in this name (words: only one with these words). */
  sharedFor(storeId, title, words = null) {
    const name = norm(title);
    if (!name) return null;
    return this.wordsAt(storeId).find((w) => w.shared && (!words || w.words === words) && hasWords(name, w.words)) || null;
  }

  /** A search page's key phrase in this name (the first of them that is), or null. */
  phraseIn(w, title) {
    const name = norm(title);
    return (name && (w.phrases || []).find((ph) => hasWords(name, ph))) || null;
  }

  /** Someone's own watches whose words are in this name. */
  ownFor(storeId, title) {
    const name = norm(title);
    if (!name) return [];
    return this.wordsAt(storeId).filter((w) => !w.shared && hasWords(name, w.words));
  }

  /**
   * Every watch at a store whose words — or, a search page's there, one of its key phrases — are in this name (what
   * each sees: monitor/sightings.js).
   */
  watchesFor(storeId, title) {
    const name = norm(title);
    if (!name) return [];
    return this.live().filter((w) => (w.words ? (w.store === storeId || (w.store === ALL_STORES && storeId !== 'other')) && hasWords(name, w.words)
      : !!w.page && w.store === storeId && !!this.phraseIn(w, title)));
  }

  /** One search of these words at a store went (sweep.js): what each watch with them shows — and its first look is done. */
  searched(storeId, words, info) {
    const list = this.wordsAt(storeId).filter((w) => w.words === words);
    if (!list.length) return;
    const now = this.now();
    for (const w of list) {
      // (Every store's: its first look at this store is this store's own "before".)
      const bases = w.store === ALL_STORES && info.ok && !this.baseAt(w, storeId) ? JSON.stringify({ ...w.bases, [storeId]: now }) : null;
      this.db.run(`UPDATE drop_watches SET last_at = :now, last_ok_at = CASE WHEN :ok = 1 THEN :now ELSE last_ok_at END,
          fails = CASE WHEN :ok = 1 THEN 0 ELSE fails + 1 END, error = :err, seen = CASE WHEN :ok = 1 THEN :seen ELSE seen END,
          baseline_at = CASE WHEN :ok = 1 AND baseline_at IS NULL THEN :now ELSE baseline_at END, bases = COALESCE(:bases, bases) WHERE id = :id`,
      { id: w.id, now, ok: info.ok ? 1 : 0, seen: info.found || 0, err: info.ok ? '' : String(info.error || 'The search failed').slice(0, 200), bases });
    }
    this.changed();
    for (const w of list) {
      this.hub.publish(w.userId, 'drop', { id: w.id });
      if (info.ok && !w.baselineAt && w.store !== ALL_STORES) this.firstLook(this.get(w.id));
    }
  }

  /**
   * An admin's watch for everyone found a product in a search (it's in the catalogue now: sweep.js):
   * a monitor on it, so its page is read for its stock too — and, when the admin asked, armed for
   * their Auto-checkout by what the watch saw of it (monitor/sightings.js): verdict 'new' or 'armed' (not on sale
   * when it first read it), 'skipped' or 'pending' (its page decides: checked()). baseline: there already as far as
   * its alerts go (listed when the watch first looked: its own room of finds). status: its stock in the search (or
   * null). later: the search's list for the admin's alerts (sent once its channel posts are out), the Auto-checkout
   * run made now all the same.
   */
  async foundShared(w, product, { baseline = false, verdict = 'pending', status = null, later = null } = {}) {
    if (!w || !product) return;
    this.monitorFor(w, product);
    if (!w.found.some((f) => f.productId === product.id)) {
      // (New to the watch — what it saw says so — has the room of what's dropped since its first look.)
      const base = baseline && verdict !== 'new';
      if (!this.room(w, base)) return;
      const want = this.armFor(w, product.store, product.url, 'pending');
      this.saveFound(w, [...w.found, { productId: product.id, sku: product.sku, store: product.store, at: this.now(), base, ...(want ? { arm: want } : {}) }]);
      this.repo.ensurePageFor({ store: product.store, sku: product.sku, url: product.url });
      // (Its page read now — unless it's backing off, the store having refused it: at its turn then.)
      if (product.url) this.db.run('UPDATE page_checks SET next_check_at = 0 WHERE url = :url AND fail_count = 0', { url: product.url });
    }
    await this.settleShared(w, product, verdict, status, later);
    this.hub.publish(w.userId, 'drop', { id: w.id });
  }

  /**
   * An admin's watch's find, armed by what the watch saw of it — once (bought, it stays disarmed): 'new' (on sale now:
   * its Auto-checkout run now), 'armed' (status: not on sale yet, so going on sale is a drop for the item too), or
   * skipped (said in the admin's activity). 'pending' waits for its page.
   */
  async settleShared(w, product, verdict, status = null, later = null) {
    const f = w.found.find((x) => x.productId === product.id);
    if (!f || !f.arm || f.arm === 'armed') return;
    // (A find from before the watch kept what it saw: never new to it, and skipped stays skipped.)
    if (this.sightings) verdict = this.sightings.findVerdict(w, product.store, [product.sku], verdict, { foundAt: f.at, arm: f.arm });
    const arm = this.armFor(w, product.store, product.url, verdict);
    if (!arm || arm === f.arm || arm === 'pending') return;
    this.saveFound(w, w.found.map((x) => (x === f ? { ...x, arm } : x)));
    if (arm === 'skipped') { this.onSale(w, product); return; }
    const item = this.arm(w, product, verdict === 'armed' ? status : null);
    // On sale the moment it's found: Auto-checkout starts now (not at the next check).
    if (item && verdict === 'new') await this.buyIfOnSale(item.id, status, { title: product.name, price: product.price }, later);
  }

  /**
   * A find new to its watch, just armed: bought now if it's on sale — as this read says, or as its last read did. Its
   * stock not known yet: "not listed" a moment ago, so its first read that says on sale is the drop.
   */
  async buyIfOnSale(itemId, status, { title = null, price = null } = {}, later = null) {
    const row = this.db.get('SELECT status FROM items WHERE id = :id', { id: itemId });
    if (!row) return;
    const onSale = isOrderable(status) ? status : isOrderable(row.status) ? row.status : null;
    if (onSale) await this.applyNow(itemId, { status: onSale, title, price, fresh: true }, later);
    else if (row.status === STATUS.UNKNOWN) this.db.run('UPDATE items SET status = :st WHERE id = :id', { st: STATUS.NOT_LISTED, id: itemId });
  }

  /**
   * A find's monitor (its page read for stock, its alerts posted): one the watch makes, or one an admin
   * made before, which the watch takes on (its alerts go where the watch's do) — and leaves as it was
   * when the watch goes. One another watch has already is left with that watch.
   */
  monitorFor(w, product) {
    const m = this.catalog.monitorForProduct(product.id);
    if (!m) {
      const { monitor } = this.catalog.addMonitor(product.id, { kinds: KINDS, note: DROP_NOTE, createdBy: w.userId });
      this.db.run('UPDATE monitors SET drop_watch = :w WHERE id = :id', { w: w.id, id: monitor.id });
    } else if (!m.drop_watch) {
      this.db.run('UPDATE monitors SET drop_watch = :w WHERE id = :id', { w: w.id, id: m.id });
    }
  }

  /**
   * Auto-checkout for one find, from the watch's verdict on it (monitor/sightings.js): 'armed' (new, or not on sale
   * when the watch first read it), 'pending' (armed once its page says it isn't on sale yet), 'skipped' (on sale
   * when the watch first read it: there before it) or '' (not asked for, or no checkout there).
   */
  armFor(w, store, url, verdict) {
    if (!w.aco || w.maxPrice === null || !url || !this.retailers.canBuy(store)) return '';
    return verdict === 'new' || verdict === 'armed' ? 'armed' : verdict === 'skipped' ? 'skipped' : 'pending';
  }

  /** On the watch owner's watchlist, armed for Auto-checkout up to the watch's max price. status: its stock now. */
  arm(w, p, status = null) {
    const user = this.repo.userById(w.userId);
    if (!user || user.disabled || !p || !p.url || !this.retailers.canBuy(p.store)) return null;
    const existing = this.repo.itemBySku(user.id, p.store, p.sku);
    if (existing && existing.aco) return existing;
    try {
      let saved;
      const isAdmin = user.role === 'admin';
      if (existing) {
        saved = this.repo.updateItem(user.id, existing.id, checkItem({ aco: true, maxPrice: existing.maxPrice ?? w.maxPrice, monitor: true }, { retailers: this.retailers, existing, isAdmin }));
      } else {
        if (this.repo.countItems(user.id) >= this.cfg.limits.items) { this.full(w); return null; }
        saved = this.repo.addItem(user.id, checkItem({ url: p.url, sku: p.sku, name: p.name || w.label || p.sku, maxPrice: w.maxPrice, aco: true, monitor: true }, { retailers: this.retailers, isAdmin }));
        this.db.run('UPDATE items SET drop_watch = :w WHERE id = :id', { w: w.id, id: saved.id });
      }
      if (READ.has(status) && !isOrderable(status)) {
        this.db.run("UPDATE items SET status = :st, status_source = 'server', status_at = :t, checked_at = :t WHERE id = :id", { st: status, t: this.now(), id: saved.id });
      }
      this.repo.addEvent(user.id, { type: 'aco', level: 'warn', message: `Drop watch: ${saved.name} armed for Auto-checkout, up to $${Number(saved.maxPrice).toFixed(2)}`, name: saved.name, sku: saved.sku, url: saved.url || null });
      this.hub.publish(user.id, 'watch', { id: saved.id, added: true });
      return saved;
    } catch (e) {
      this.cfg.log('[drops]', e.message);
      return null;
    }
  }

  onSale(w, p) {
    this.repo.addEvent(w.userId, { type: 'aco', level: 'info', message: `Drop watch: ${productName(p)} was on sale already when the watch first looked, so it isn't armed — ⚡ Buy it yourself if you want it`, name: p.name || null, sku: p.sku, url: p.url || null });
  }

  /**
   * Watches (ids) that armed a find on a search's "not on sale" its own page contradicts a moment later
   * (Sightings.revise): on sale as far as they go — skipped, and the item they armed for it disarmed (never one armed
   * before the find: someone's own arming).
   */
  unarm(ids, store, sku) {
    const product = this.catalog.productFor(store, sku);
    for (const w of this.watches().filter((x) => ids.includes(x.id))) {
      // (Its find: the product, for an admin's watch for everyone; the item on your watchlist, for your own.)
      const item = this.repo.itemBySku(w.userId, store, sku);
      const f = w.found.find((x) => x.arm === 'armed' && ((product && x.productId === product.id) || (item && x.itemId === item.id)));
      if (!f) continue;
      this.saveFound(w, w.found.map((x) => (x === f ? { ...x, arm: 'skipped' } : x)));
      if (item && item.aco && (item.acoAt || 0) >= (f.at || 0)) {
        this.db.run('UPDATE items SET aco = 0, aco_at = NULL WHERE id = :id', { id: item.id });
        this.hub.publish(w.userId, 'watch', { id: item.id, aco: false });
      }
      this.repo.addEvent(w.userId, { type: 'aco', level: 'info', message: `Drop watch: ${productName(item || product || { sku })} — its page says it's on sale, its search said it wasn't a moment before: taken as on sale already, so it isn't armed — ⚡ Buy it yourself if you want it`, name: (item || product || {}).name || null, sku, url: (item || product || {}).url || null });
    }
  }

  /** Someone's own watch has found as much as it keeps of what's dropped: said once a day (it's time to make it narrower). */
  noRoom(w) {
    const day = Math.floor(this.now() / 86400000);
    if (this.roomDay && this.roomDay.get(w.id) === day) return;
    (this.roomDay ||= new Map()).set(w.id, day);
    this.repo.addEvent(w.userId, { type: 'restock', level: 'warn', message: `Drop watch "${nameOf(w)}" has found ${MAX_FOUND_OWN} new products already, the most one watch keeps — take the ones you don't want off your watchlist (that makes room), or make its words narrower` });
  }

  /** Someone's watchlist is full: said once a day. */
  full(w) {
    const day = Math.floor(this.now() / 86400000);
    if (this.fullDay && this.fullDay.get(w.id) === day) return;
    (this.fullDay ||= new Map()).set(w.id, day);
    this.repo.addEvent(w.userId, { type: 'restock', level: 'warn', message: `Drop watch "${nameOf(w)}": your watchlist is full (${this.cfg.limits.items}), so what it finds can't go on it — remove something from your watchlist` });
  }

  /**
   * A product's page was read (monitor/index.js; reading: what that read said — on sale or not yet): each admin's
   * watch that found it records it, and a find waiting on its page is settled — armed if it isn't on sale, left alone
   * if it is.
   */
  async checked(product, reading, later = null) {
    if (!product || !reading || !this.sightings || !this.watches().length) return;
    for (const w of this.watches()) {
      if (!w.found.some((x) => x.productId === product.id)) continue;
      const { verdict } = this.sightings.see(w, product.store, [product.sku], { reading, how: 'page' });
      await this.settleShared(w, product, verdict, product.status, later);
    }
  }

  /**
   * Someone's own watch found a product in a search at a store (sweep.js): on their watchlist, theirs
   * alone. A new listing is news straight away — their DM — and armed by what the watch saw of it
   * (verdict: monitor/sightings.js), bought now when it's new and on sale. Found before: its arming settled again.
   * p: the search's product; status: its stock there (or null). later: the search's list for their DMs — sent once the
   * product's channel posts are out (their Auto-checkout run is made now all the same), so one member's watch never
   * holds up everyone's ping.
   */
  async foundOwn(w, r, p, status, { baseline = false, verdict = 'pending', later = null } = {}) {
    if (!w || !p || !p.url) return null;
    // (The same code at two stores is two products: an every-store watch's finds go by store too.)
    const f = w.found.find((x) => String(x.sku).toLowerCase() === String(p.sku).toLowerCase() && (!x.store || x.store === r.id));
    if (f) { await this.settleOwn(w, f, verdict, status, later); return null; }
    // (New to the watch — what it saw says so — has the room of what's dropped since its first look.)
    const base = baseline && verdict !== 'new';
    if (!this.room(w, base)) { if (!base) this.noRoom(w); return null; }
    // (The listing's only option: a run for it opens the store's add-to-cart link, as for a member's own SKU — sweep.js members.)
    const variantId = p.oneVariant && p.variantId ? String(p.variantId) : null;
    return this.addOwn(w, { store: r.id, sku: p.sku, url: p.url, name: p.title || p.name, price: p.price ?? null, variantId }, status, { baseline, verdict, later });
  }

  async addOwn(w, p, status, { baseline, verdict = 'pending', later = null }) {
    const user = this.repo.userById(w.userId);
    if (!user || user.disabled) return null;
    let item = this.repo.itemBySku(user.id, p.store, p.sku);
    let arm = '';
    const added = !item;
    // (New to the watch — what it saw says so — is news to its owner too, whichever search found it.)
    const fresh = !baseline || verdict === 'new';
    if (added) {
      if (this.repo.countItems(user.id) >= this.cfg.limits.items) { this.full(w); return null; }
      arm = this.armFor(w, p.store, p.url, verdict);
      try {
        item = this.repo.addItem(user.id, checkItem({ url: p.url, sku: p.sku, name: productName(p), maxPrice: arm ? w.maxPrice : null, aco: arm === 'armed', monitor: true }, { retailers: this.retailers }));
      } catch (e) {
        this.cfg.log('[drops]', e.message);
        return null;
      }
      // Its stock as it is now, so only a change after this is news — or, a new listing, "not listed"
      // a moment ago (so what it is now is the news). Another website's listing doesn't say reliably:
      // its page decides (quietly, the first time: monitor/index.js).
      const st = fresh ? STATUS.NOT_LISTED : p.store !== 'other' && READ.has(status) ? status : STATUS.UNKNOWN;
      const t = this.now();
      this.db.run(`UPDATE items SET drop_watch = :w, status = :st, status_source = 'server', status_at = :t, checked_at = :t,
        last_price = COALESCE(:price, last_price) WHERE id = :id`, { w: w.id, st, t, price: typeof p.price === 'number' ? p.price : null, id: item.id });
    }
    this.saveFound(w, [...w.found, { itemId: item.id, sku: p.sku, store: p.store, at: this.now(), base: !fresh, ...(arm ? { arm } : {}) }]);
    this.hub.publish(user.id, 'watch', { id: item.id, added: true });
    this.hub.publish(user.id, 'drop', { id: w.id });
    if (added && fresh) {
      // A new listing: their alert now (and Auto-checkout, when it's armed and on sale). The search's
      // stock where it says; else (and at another website) its page, read in the monitor's turn — never holding up a
      // search, never ahead of the store's gap between requests or its backing off.
      if (p.store !== 'other' && READ.has(status)) await this.applyNow(item.id, { status, title: p.name || null, price: p.price ?? null, variantId: p.variantId || null }, later);
      else if (this.monitor) this.monitor.checkNow(p.url);
    }
    return item;
  }

  /**
   * Someone's own watch's find seen again, or read (its page): armed by what the watch saw of it now, once — bought,
   * it stays disarmed. 'new': bought now if it's on sale (buy: false — the caller's read does that: its page's own read).
   * f: the find.
   */
  async settleOwn(w, f, verdict, status = null, later = null, { buy = true } = {}) {
    if (!f || !f.itemId || !f.arm || f.arm === 'armed') return;
    const item = this.db.get('SELECT * FROM items WHERE id = :id', { id: f.itemId });
    if (!item) return;
    if (this.sightings) verdict = this.sightings.findVerdict(w, item.store, [item.sku], verdict, { foundAt: f.at, arm: f.arm });
    const arm = this.armFor(w, item.store, item.url, verdict);
    if (!arm || arm === f.arm || arm === 'pending') return;
    this.saveFound(w, w.found.map((x) => (x === f ? { ...x, arm } : x)));
    if (arm === 'skipped') { this.onSale(w, { name: item.name, sku: item.sku, url: item.url }); return; }
    this.db.run('UPDATE items SET aco = 1, aco_at = :t, max_price = COALESCE(max_price, :max) WHERE id = :id AND aco = 0', { t: this.now(), max: w.maxPrice, id: item.id });
    this.armedNote(w, { ...item, maxPrice: item.max_price ?? w.maxPrice });
    if (verdict === 'new' && buy) await this.buyIfOnSale(item.id, status, { title: item.name, price: item.last_price }, later);
  }

  armedNote(w, item) {
    this.repo.addEvent(w.userId, { type: 'aco', level: 'warn', message: `Drop watch: ${item.name} armed for Auto-checkout, up to $${Number(item.maxPrice ?? item.max_price ?? w.maxPrice).toFixed(2)}`, name: item.name, sku: item.sku, url: item.url || null });
    this.hub.publish(w.userId, 'watch', { id: item.id, aco: true });
  }

  /**
   * What a search said about a watchlist item it just put there, applied now (its alerts, Auto-checkout). later: see
   * foundOwn. fresh: a drop for the watch — this read is its news even where the item says it's on sale already.
   */
  async applyNow(itemId, { status, title = null, price = null, variantId = null, fresh = false }, later = null) {
    if (fresh) this.db.run(`UPDATE items SET status = '${STATUS.NOT_LISTED}' WHERE id = :id AND status IN ('${STATUS.IN_STOCK}', '${STATUS.PREORDER}')`, { id: itemId });
    const row = this.db.get('SELECT * FROM items WHERE id = :id', { id: itemId });
    if (!row || !this.monitor) return;
    await this.monitor.applyResult(row, { status, title, price: typeof price === 'number' ? price : null, error: '', variantId }, 'sweep', { later });
  }

  /**
   * A drop watch's find on someone's own watchlist was read — its page, from the server or a browser (monitor/index.js):
   * what that read said goes in what the watch saw, and a find waiting to see whether it's on sale yet is armed if it
   * isn't, left alone if it is. (A search's reading is the search's: sweep.js.)
   */
  async itemRead(item, status) {
    const w = this.get(item.drop_watch);
    const reading = readingOf(status);
    if (!w || !reading || !this.sightings) return;
    const f = w.found.find((x) => x.itemId === item.id);
    if (!f) return;
    const { verdict } = this.sightings.see(w, item.store, [item.sku], { reading, how: 'page' });
    // (Armed here, its run goes with this read's own alerts: monitor/index.js applyResult.)
    await this.settleOwn(w, f, verdict, null, null, { buy: false });
  }

  /** A watch's first look is done: what it found is how things were. Your own: one line in your activity. */
  firstLook(w) {
    if (!w || w.shared || !w.found.length) return;
    const n = w.found.length;
    if (w.page) {
      this.repo.addEvent(w.userId, {
        type: 'restock', level: 'info',
        message: `🔎 Watching ${this.where(w)}'s page for ${w.phrases.map((x) => `"${x}"`).join(', ')}: ${n} product${n === 1 ? '' : 's'} with ${w.phrases.length === 1 ? 'it' : 'one of them'} ${n === 1 ? 'is' : 'are'} on it already — on your watchlist now, so you're told when ${n === 1 ? 'it comes' : 'any comes'} back in stock. Anything new on the page, you're told the moment it's there.`,
      });
      return;
    }
    this.repo.addEvent(w.userId, {
      type: 'restock', level: 'info',
      message: `🎯 Watching "${w.words}" at ${this.where(w)}: ${n} product${n === 1 ? '' : 's'} with those words ${n === 1 ? 'is' : 'are'} listed already — on your watchlist now, so you're told when ${n === 1 ? 'it comes' : 'any comes'} back in stock. Anything new, you're told the moment it drops.`,
    });
  }

  // ---------------------------------------------------------------------------
  // Words at another website: read from the server, every couple of minutes
  // ---------------------------------------------------------------------------
  start() {
    this.priceDropsInNonTcg();
    if (this.timer || !this.cfg.monitor.enabled) return;
    this.timer = setInterval(() => { this.tick().catch((e) => this.cfg.log('[drops]', e.message)); }, 5000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * #non-tcg-alerts (the drop watches' channel) posts price drops too, from this release: its rule gets
   * 📉 Price drops once — an admin who takes them off again later is left alone.
   */
  priceDropsInNonTcg() {
    try {
      if (this.repo.getSetting('nontcgPriceDrops')) return;
      for (const r of this.catalog.listRoutes()) {
        if (r.vip || r.categories.length !== 1 || r.categories[0] !== 'nontcg' || r.kinds.includes('price_drop')) continue;
        this.catalog.saveRoute(r.id, { ...r, kinds: [...r.kinds, 'price_drop'] });
      }
      this.repo.setSetting('nontcgPriceDrops', true);
    } catch (e) {
      this.cfg.log('[drops]', e.message);
    }
  }

  /**
   * Someone's own drop watch's find was read (monitor/index.js): its price went down — a DM to its owner
   * (📉, with ⚡ Buy where Mugibot checks out, else Open product). At least OWN_PRICE_DROP_PERCENT lower than
   * the read before, and a dollar; said again only when it's lower than last time, or half a day later.
   * The first read after it was found (or after this release) only notes the price: what a listing said
   * and what its page says can differ, and that's not a drop.
   * item: the items row as it was; price: the price just read; status: its stock just read. Returns whether they were told.
   */
  async priceDropped(item, price, status = item.status) {
    if (!item.drop_watch || typeof price !== 'number' || !(price > 0)) return false;
    const now = this.now();
    if (typeof item.price_alert_price !== 'number') {
      this.db.run('UPDATE items SET price_alert_at = 0, price_alert_price = :p WHERE id = :id', { p: price, id: item.id });
      return false;
    }
    const was = item.last_price;
    if (typeof was !== 'number' || was <= 0 || price >= was) return false;
    const pct = ((was - price) / was) * 100;
    if (pct < OWN_PRICE_DROP_PERCENT || was - price < 1) return false;
    const told = item.price_alert_at && now - item.price_alert_at < OWN_PRICE_AGAIN_MS;
    if (told && price >= item.price_alert_price - 0.005) return false;
    const w = this.get(item.drop_watch);
    if (!w || !w.active || w.shared) return false;
    this.db.run('UPDATE items SET price_alert_at = :t, price_alert_price = :p WHERE id = :id', { t: now, p: price, id: item.id });
    await this.notifier.itemAlert(item.user_id, { ...item, last_price: price }, 'price_drop', { price, previous: was, pct, status });
    return true;
  }

  /** The other-website watches due a look: a few at a time, one website at a time (a gap between requests to it). */
  async tick() {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const now = this.now();
      const due = this.live().filter((w) => w.store === 'other' && w.words && w.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt);
      const jobs = [];
      const seen = new Set();
      for (const w of due) {
        if (jobs.length >= 3) break;
        const same = `${w.site}|${w.words}`;
        if (seen.has(same)) continue; // (one read for every watch with the same site and words)
        let host;
        try { host = new URL(w.site).host; } catch { continue; }
        if ((this.hostNext.get(host) || 0) > now) continue;
        this.hostNext.set(host, now + Math.max(2, this.cfg.monitor.hostGapSeconds) * 1000);
        seen.add(same);
        jobs.push(this.look(w).catch((e) => this.cfg.log('[drops]', e.message)));
      }
      await Promise.all(jobs);
      return jobs.length;
    } finally {
      this.busy = false;
    }
  }

  /**
   * How to look for words at another website: its search (Shopify's search suggestions, then its
   * search page), then the page itself — or only the page given, when that's a listing (a collection,
   * a search, a category).
   */
  ways(site) {
    const u = new URL(site);
    return u.search || u.pathname.split('/').filter(Boolean).length >= 2 ? ['page'] : ['suggest', 'search', 'page'];
  }

  headers(json = false) {
    return { 'user-agent': this.cfg.monitor.userAgent, accept: json ? 'application/json' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-AU,en;q=0.9' };
  }

  /** One read of another website for words: { ok, products, refused, error }. */
  async read(site, words, way) {
    const url = siteUrl(site, words, way);
    let res;
    try {
      const timeoutMs = Math.min(this.cfg.monitor.timeoutMs, 20000);
      res = await safeFetch(this.fetch, url, { headers: this.headers(way === 'suggest'), timeoutMs, signal: AbortSignal.timeout(timeoutMs) }, { allowPrivate: this.cfg.monitor.allowPrivateHosts });
    } catch (e) {
      return { ok: false, error: e instanceof BlockedUrlError ? e.message : e.name === 'TimeoutError' ? 'The website took too long to answer' : "Couldn't reach the website" };
    }
    const type = (res.headers && res.headers.get('content-type')) || '';
    const text = res.ok ? (await res.text()).slice(0, 3_000_000) : '';
    return siteAnswer({ way, status: res.status, type, text, url: res.url || url });
  }

  /** Read another website for a words watch — and for every other watch with the same site and words. */
  async look(w) {
    const peers = this.live().filter((x) => x.store === 'other' && x.words === w.words && x.site === w.site);
    if (!peers.length) return { ok: false, error: 'Not looked for' };
    let got = null;
    let error = '';
    for (const way of w.how ? [w.how] : this.ways(w.site)) {
      const r = await this.read(w.site, w.words, way);
      if (r.ok) { got = { ...r, how: way }; break; }
      error = r.error;
      if (r.refused) break;
    }
    if (got) {
      // (The website answers the server again: it's the server's to read, not a browser's.)
      for (const x of peers) { this.browserOkAt.delete(x.id); this.browserNext.delete(x.id); this.browserFails.delete(x.id); }
      await this.settle(peers, got);
      return { ok: true, how: got.how, products: got.products.length };
    }
    const now = this.now();
    for (const x of peers) {
      // (An admin's browser reads it while the website refuses the server: the server asks again, less often, and says nothing.)
      if (this.viaBrowser(x)) {
        this.db.run('UPDATE drop_watches SET last_at = :now, next_at = :n WHERE id = :id', { now, n: now + Math.min(MAX_BACKOFF_MS, this.siteMs * 4), id: x.id });
        continue;
      }
      const fails = x.fails + 1;
      this.db.run('UPDATE drop_watches SET last_at = :now, fails = :f, error = :e, next_at = :n WHERE id = :id',
        { now, f: fails, e: String(error).slice(0, 200), n: now + Math.min(MAX_BACKOFF_MS, this.siteMs * 2 ** Math.min(fails, 4)), id: x.id });
    }
    this.changed();
    for (const x of peers) this.hub.publish(x.userId, 'drop', { id: x.id });
    return { ok: false, error };
  }

  /**
   * What a read of another website found, for each watch with its site and words: their finds, and their
   * first look done. browser: read from a browser — the server's own next ask (backing off) is kept.
   */
  async settle(peers, got, { browser = false } = {}) {
    const now = this.now();
    for (const x of peers) {
      const baseline = !x.baselineAt;
      for (const p of got.products.filter((q) => hasWords(q.title, x.words))) {
        if (x.shared) await this.foundSharedSite(x, p, { baseline });
        else await this.foundOwnSite(x, p, { baseline });
      }
      this.db.run(`UPDATE drop_watches SET how = :how, last_at = :now, last_ok_at = :now, fails = 0, error = '', seen = :seen,
        next_at = CASE WHEN :browser = 1 THEN MAX(next_at, :later) ELSE :n END, baseline_at = COALESCE(baseline_at, :now) WHERE id = :id`,
      { how: got.how, now, seen: got.products.length, n: now + this.siteMs, browser: browser ? 1 : 0, later: now + Math.min(MAX_BACKOFF_MS, this.siteMs * 4), id: x.id });
    }
    this.changed();
    for (const x of peers) {
      this.hub.publish(x.userId, 'drop', { id: x.id });
      if (!x.baselineAt) this.firstLook(this.get(x.id));
    }
  }

  // ---------------------------------------------------------------------------
  // Another website that refuses the server: read from an admin's browser instead (your own watch: yours)
  // ---------------------------------------------------------------------------
  /** Has a browser read this watch's website lately (while it refuses the server)? */
  viaBrowser(w) {
    return (this.browserOkAt.get(w.id) || 0) > this.now() - 3 * this.siteMs;
  }

  /** The watches with this one's site and words that this browser reads for (an admin's never reads for a member's own). */
  peersFor(w, user) {
    return this.live().filter((x) => (w.page ? x.page === w.page : x.site === w.site && x.words === w.words) && this.readsFor(x, user));
  }

  /** Whose browser may read for this watch: an admin's for one for everyone, its owner's for their own. */
  readsFor(w, user) {
    return !!user && w.store === 'other' && (!!w.words || !!w.page) && (w.shared ? user.role === 'admin' : w.userId === user.id);
  }

  /**
   * The other-website searches this browser should read now (the extension's in-browser checks): each
   * watch whose website refuses the server (or that a browser reads already), at most every couple of
   * minutes, where its owner has let the extension read that website (sites: its addresses, '*' for
   * any) — else the address goes in want, for the extension to offer allowing it.
   */
  browserDue(user, { sites = new Set(), want = new Set() } = {}) {
    if (!this.monitor) return [];
    const now = this.now();
    const out = [];
    for (const w of this.live()) {
      if (out.length >= 2) break;
      // (A search page at another website (monitor/pages.js): while it refuses the server, as often as it's asked for — every 20 s at the most.)
      const refused = w.page ? !!this.pages && this.pages.siteRefused(w) : w.fails > 0 || this.viaBrowser(w);
      if (!this.readsFor(w, user) || !refused || (this.browserNext.get(w.id) || 0) > now) continue;
      if (!this.monitor.siteAllowed(w.site || w.page, sites, want)) continue;
      // (One read for every watch with its site and words — or its page — that this browser reads for.)
      for (const x of this.peersFor(w, user)) this.browserNext.set(x.id, now + (w.page ? Math.max(20, w.every || 0) * 1000 : this.siteMs));
      out.push(w.page ? { id: `d:${w.id}`, store: 'other', kind: 'site', url: w.page, reads: [{ way: 'page', url: w.page }] }
        : { id: `d:${w.id}`, store: 'other', kind: 'site', url: w.site, reads: (w.how ? [w.how] : this.ways(w.site)).map((way) => ({ way, url: siteUrl(w.site, w.words, way) })) });
    }
    return out;
  }

  /** What a browser read at another website for a watch: its finds, as the server's read would have. */
  async browserResult(user, res) {
    const w = this.get(String(res.id || '').slice(2));
    if (!w || !w.active || !this.readsFor(w, user)) return false;
    const peers = this.peersFor(w, user);
    if (!res.ok || !Array.isArray(res.products)) {
      // (Refused there too: the server's own error stays, and the browser asks again later each time.)
      const fails = (this.browserFails.get(w.id) || 0) + 1;
      for (const x of peers) {
        this.browserFails.set(x.id, fails);
        this.browserNext.set(x.id, this.now() + Math.min(MAX_BACKOFF_MS, this.siteMs * 2 ** Math.min(fails, 4)));
      }
      return false;
    }
    const how = ['suggest', 'search', 'page'].includes(res.how) ? res.how : '';
    const link = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v.slice(0, 2000) : '');
    const products = res.products.slice(0, 150).filter((p) => p && typeof p.title === 'string' && link(p.url)).map((p) => ({
      title: p.title.slice(0, 200), url: link(p.url), image: typeof p.image === 'string' && /^https:\/\//.test(p.image) ? p.image.slice(0, 1000) : '',
      price: typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0 && p.price < 100000 ? p.price : null,
    }));
    for (const x of peers) { this.browserOkAt.set(x.id, this.now()); this.browserFails.delete(x.id); }
    if (w.page) return !!this.pages && this.pages.siteResult(w, products);
    await this.settle(peers, { products, how: how || w.how || 'page' }, { browser: true });
    return true;
  }

  /** A product's link from another website's listing: on that website, never a store Mugibot knows. */
  siteLink(p) {
    try {
      const u = new URL(p.url);
      if (!/^https?:$/.test(u.protocol) || this.retailers.forUrl(u)) return '';
      u.hash = '';
      return u.href;
    } catch { return ''; }
  }

  /**
   * An admin's watch for everyone found a product at another website: a monitored product (its page
   * read for stock). A new listing is read now, so what its page says is the drop (🆕 or 🟢 in #non-tcg-alerts).
   */
  async foundSharedSite(w, p, { baseline }) {
    const url = this.siteLink(p);
    const sku = url && otherSku(url);
    if (!sku || w.found.some((f) => f.sku === sku) || !this.room(w, baseline) || this.catalog.isBlocked('other', sku)) return;
    const known = this.catalog.productFor('other', sku);
    const product = this.catalog.upsertProduct({ store: 'other', sku, url, name: p.title, image: p.image || '', category: known ? '' : w.category });
    this.monitorFor(w, product);
    this.saveFound(w, [...w.found, { productId: product.id, sku, at: this.now(), base: !!baseline }]);
    this.repo.ensurePage(url, 'product', 'other', sku);
    if (!baseline && !known) {
      const t = this.now();
      this.catalog.updateProduct(product.id, { status: STATUS.NOT_LISTED, status_at: t, last_ok_at: t, confirmed: 1 });
      // (Read in the monitor's turn: never ahead of the website's gap between requests, nor while it's backing off.)
      if (this.monitor) this.monitor.checkNow(url);
    } else {
      this.db.run('UPDATE page_checks SET next_check_at = 0 WHERE url = :url AND fail_count = 0', { url });
    }
  }

  /** Someone's own watch found a product at another website: on their watchlist (alerts only). */
  async foundOwnSite(w, p, { baseline }) {
    const url = this.siteLink(p);
    const sku = url && otherSku(url);
    if (!sku || w.found.some((f) => f.sku === sku)) return null;
    if (!this.room(w, baseline)) { if (!baseline) this.noRoom(w); return null; }
    return this.addOwn(w, { store: 'other', sku, url, name: p.title, price: p.price ?? null }, null, { baseline });
  }

  // ---------------------------------------------------------------------------
  // Adding, checking and removing watches
  // ---------------------------------------------------------------------------
  /**
   * A new watch. input: { url } (a product link), { words, store } — store: a store Mugibot
   * searches, or 'other' with site (the website, or a page of it) — or { page, phrases, every } (a
   * search page, read every few seconds for any of its key phrases: monitor/pages.js) — plus label,
   * aco + maxPrice, and for admins shared (for everyone: default on), category, channelId and roleId.
   */
  async add(input, user) {
    const isAdmin = user.role === 'admin';
    const mine = this.watches().filter((w) => w.userId === user.id);
    const limit = this.limitFor(user);
    if (mine.length >= limit) throw bad(`${limit} drop watches is the most — remove one first`);
    const shared = isAdmin && bool(input.shared, true);
    const label = str(input.label, 80);
    let category = 'nontcg';
    if (shared && input.category) {
      const c = String(input.category).toLowerCase().replace(/[^a-z]/g, '');
      if (!CATEGORIES[c]) throw bad(`Category must be one of: ${Object.values(CATEGORIES).join(', ')}`);
      category = c;
    }
    const aco = bool(input.aco, false);
    const maxPrice = aco ? num(input.maxPrice, { min: 1, max: 100000, def: null }) : null;
    if (aco && maxPrice === null) throw bad('Set a max price to auto-checkout it: Mugibot never pays more than that');
    // (Where it posts: for everyone only — someone's own watch tells them alone.)
    const dest = shared ? await this.destination(input) : { channelId: '', roleId: '' };
    const url = input.page ? '' : httpUrl(input.url, 'Product link', { required: false });
    let store = '';
    let site = '';
    let words = '';
    let page = '';
    let phrases = [];
    let every = 0;
    if (input.page) {
      // A search page (any store's search, category or collection — or another website's): its key phrases looked for on it.
      page = pageLink(httpUrl(input.page, "The search page's link"));
      const problem = pageProblem(page);
      if (problem) throw bad(problem);
      const r = this.retailers.forUrl(page);
      store = r ? r.id : 'other';
      if (r) {
        if (!this.retailers.enabled(r)) throw bad(`${r.name} is switched off at the moment`);
        if (isProductPage(r, page)) throw bad(`That's a product's own page at ${r.name} — paste it on its own to watch that product (a search page lists products)`);
        if (!planFor(r, page)) throw bad(`Mugibot doesn't read ${r.name}'s pages for key phrases — paste a product's link instead`);
        if (this.sweeper && this.sweeper.modeFor(r) === 'off') throw bad(`${r.name} isn't monitored at the moment (switched off in the Drops page's stores)`);
      }
      if (aco && !this.retailers.canBuy(store)) throw bad(NO_ACO);
      phrases = phrasesOf(input.phrases ?? input.words, wordsOf);
      if (!phrases.length) throw bad('Type a key phrase or two to look for on that page, one a line (e.g. "magic the gathering") — a product counts when its name has every word of one of them');
      const floor = floorFor(r);
      every = num(input.every, { min: 1, max: PAGE_MAX_SECONDS, int: true, def: Math.max(floor, PAGE_DEFAULT_SECONDS) });
      if (every < floor) throw bad(floor > 3 && r ? `${r.name}'s pages can be read every ${floor} seconds at the fastest (it turns away anything quicker)` : `Every ${floor} seconds is the fastest a page is read`);
      if (mine.some((w) => w.page === page)) throw bad("You're watching that page already — change its key phrases there");
    } else if (url) {
      const r = this.retailers.forUrl(url);
      store = r ? r.id : 'other';
      if (r && !this.retailers.enabled(r)) throw bad(`${r.name} is switched off at the moment`);
      if (aco && !this.retailers.canBuy(store)) throw bad(NO_ACO);
      if (mine.some((w) => w.url === url)) throw bad('You\'re watching that link already');
    } else {
      words = wordsOf(input.words);
      if (words.length < 3) throw bad('Paste the product\'s link, or type the words in its name (e.g. "xbox series x" — every word must be in the name)');
      store = str(input.store, 40);
      if (store === ALL_STORES) {
        // (A key phrase at every store Mugibot searches: Auto-checkout at whichever of them checks out.)
        if (!this.stores().some((x) => x.words)) throw bad("No store is searched at the moment — paste the product's link instead");
      } else if (store === 'other') {
        site = httpUrl(input.site, 'The website\'s address');
        const r = this.retailers.forUrl(site);
        if (r) throw bad(`That's ${r.name} — choose it from the stores instead (Mugibot searches it, and checks out there)`);
        if (aco) throw bad(NO_ACO);
      } else {
        const r = this.retailers.get(store);
        if (!r || !r.sweep) throw bad('Choose where to look: a store, or "Another website" and its address');
        if (!this.retailers.enabled(r)) throw bad(`${r.name} is switched off at the moment`);
        if (this.sweeper && this.sweeper.modeFor(r) === 'off') throw bad(`${r.name} isn't searched at the moment — paste the product's link instead`);
        if (aco && !this.retailers.canBuy(store)) throw bad(NO_ACO);
      }
      if (mine.some((w) => w.words === words && w.store === store && w.site === site)) throw bad('You have that drop watch already');
    }
    const id = newId('drp');
    this.db.run(`INSERT INTO drop_watches (id, user_id, shared, store, site, words, url, label, category, aco, max_price, channel_id, role_id, page, phrases, every_seconds, created_at)
      VALUES (:id, :u, :shared, :store, :site, :words, :url, :label, :category, :aco, :max, :ch, :role, :page, :phrases, :every, :t)`, {
      id, u: user.id, shared: shared ? 1 : 0, store, site, words, url, label, category, aco: aco ? 1 : 0, max: maxPrice, ch: dest.channelId, role: dest.roleId,
      page, phrases: JSON.stringify(phrases), every, t: this.now(),
    });
    this.changed();
    try {
      if (url) await this.addLink(this.get(id), url, user);
    } catch (e) {
      this.db.run('DELETE FROM drop_watches WHERE id = :id', { id });
      this.changed();
      throw e;
    }
    this.repo.audit(user.id, null, 'drop-add', `${shared ? 'shared' : 'own'}: ${url || (page ? `${phrases.join(' | ')} @ ${page}` : `${words} @ ${site || store}`)}`);
    // Looked for at the store's next search (its first look is what it compares drops with) — at the
    // store's own pace, never sooner (every store: each at its own). Another website: within a few seconds.
    if (words && store === ALL_STORES) for (const x of this.stores()) { if (x.words) this.urgent.add(`${x.id}|${words}`); }
    else if (words && store !== 'other') this.urgent.add(`${store}|${words}`);
    // (Their dashboards — and their pool's members', who see an admin's own watches: server/pools.js — look again.)
    this.hub.publish(user.id, 'drop', { id });
    return this.view(this.get(id), user);
  }

  /** A link watch: a monitored product (for everyone), or an item on the owner's watchlist. */
  async addLink(w, url, user) {
    const r = this.retailers.forUrl(url);
    const sku = r ? undefined : otherSku(url);
    if (w.shared) {
      // (The product's name is the store's, from its page: the label names the watch.)
      const { product } = new MonitorAdmin(this.ctx).add({ url, sku, category: w.category, kinds: KINDS, note: DROP_NOTE, dropWatch: w.id }, user);
      this.saveFound(w, [{ productId: product.id, sku: product.sku, at: this.now() }]);
      // (Auto-checkout for the admin: armed like a watchlist item — bought when it's on sale.)
      if (w.aco) this.arm(w, this.catalog.productById(product.id));
      return;
    }
    const parsed = checkItem({ url, sku, name: w.label || nameFromLink(url) || sku, maxPrice: w.maxPrice, aco: w.aco, monitor: true }, { retailers: this.retailers, isAdmin: user.role === 'admin' });
    let item = this.repo.itemBySku(user.id, parsed.store, parsed.sku);
    if (item) {
      if (w.aco && !item.aco) {
        item = this.repo.updateItem(user.id, item.id, checkItem({ aco: true, maxPrice: item.maxPrice ?? w.maxPrice, monitor: true }, { retailers: this.retailers, existing: item, isAdmin: user.role === 'admin' }));
      }
    } else {
      if (this.repo.countItems(user.id) >= this.cfg.limits.items) throw bad(`Your watchlist is full (${this.cfg.limits.items}) — remove something from it first`);
      item = this.repo.addItem(user.id, parsed);
      this.db.run('UPDATE items SET drop_watch = :w WHERE id = :id', { w: w.id, id: item.id });
    }
    this.saveFound(w, [{ itemId: item.id, sku: item.sku, at: this.now() }]);
    this.hub.publish(user.id, 'watch', { id: item.id, added: true });
  }

  /** May this person change this watch? Their own; admins also the ones for everyone. */
  canChange(w, user) {
    return !!w && !!user && (w.userId === user.id || (w.shared && user.role === 'admin'));
  }

  /** "Check now": a link's page read next; words searched (or the website read) next. */
  checkNow(id, user) {
    const w = this.get(String(id || ''));
    if (!this.canChange(w, user)) return false;
    if (w.page) {
      if (this.pages) this.pages.checkNow(w);
    } else if (w.url) {
      for (const f of w.found) {
        const p = f.productId ? this.catalog.productById(f.productId) : this.db.get('SELECT * FROM items WHERE id = :id', { id: f.itemId || '' });
        if (!p) continue;
        if (p.url) this.db.run('UPDATE page_checks SET next_check_at = 0 WHERE url = :url', { url: p.url });
        if (f.itemId) this.db.run('UPDATE items SET browser_next_at = 0 WHERE id = :id', { id: f.itemId });
        else this.db.run('UPDATE products SET browser_next_at = 0 WHERE id = :id', { id: f.productId });
      }
    } else if (w.store === 'other') {
      this.db.run('UPDATE drop_watches SET next_at = 0 WHERE id = :id', { id: w.id });
      this.changed();
    } else {
      this.urgent.add(`${w.store}|${w.words}`);
    }
    return true;
  }

  /** Removed: the monitors it made go (one that was there before stays, as it was), and what it put on the watchlist. */
  remove(id, user) {
    const w = this.get(String(id || ''));
    if (!this.canChange(w, user)) return false;
    for (const m of [this.browserNext, this.browserOkAt, this.browserFails]) m.delete(w.id);
    this.db.run('DELETE FROM monitors WHERE drop_watch = :id AND note = :note', { id: w.id, note: DROP_NOTE });
    this.db.run('UPDATE monitors SET drop_watch = NULL WHERE drop_watch = :id', { id: w.id });
    const items = this.db.all('SELECT id FROM items WHERE drop_watch = :id', { id: w.id });
    this.db.run('DELETE FROM items WHERE drop_watch = :id', { id: w.id });
    this.db.run('DELETE FROM drop_watches WHERE id = :id', { id: w.id });
    if (this.sightings) this.sightings.forget(w.id);
    this.changed();
    for (const it of items) this.hub.publish(w.userId, 'watch', { id: it.id, removed: true });
    this.hub.publish(w.userId, 'drop', { id: w.id, removed: true });
    this.repo.audit(user.id, null, 'drop-remove', w.url || (w.page ? `${w.phrases.join(' | ')} @ ${w.page}` : `${w.words} @ ${w.site || w.store}`));
    return true;
  }

  /**
   * An admin's change to their watch for everyone (or another admin's): its name, and where it posts —
   * channelId ('' = the usual rules: #non-tcg-alerts) and roleId (a role it pings, or '').
   */
  async update(id, input, user) {
    const w = this.get(String(id || ''));
    if (!w || !this.canChange(w, user)) return null;
    const set = {};
    if (input.label !== undefined) set.label = str(input.label, 80);
    // (A search page's key phrases, and how often it's read.)
    if (input.phrases !== undefined || input.every !== undefined) {
      if (!w.page) throw bad('Only a search page watch has key phrases to change — make a new watch for other words');
      if (input.phrases !== undefined) {
        const list = phrasesOf(input.phrases, wordsOf);
        if (!list.length) throw bad('Keep at least one key phrase (3 letters or more) — or remove the watch');
        set.phrases = JSON.stringify(list);
      }
      if (input.every !== undefined) {
        const r = w.store === 'other' ? null : this.retailers.get(w.store);
        const floor = floorFor(r);
        const every = num(input.every, { min: 1, max: PAGE_MAX_SECONDS, int: true, def: w.every || PAGE_DEFAULT_SECONDS });
        if (every < floor) throw bad(floor > 3 && r ? `${r.name}'s pages can be read every ${floor} seconds at the fastest (it turns away anything quicker)` : `Every ${floor} seconds is the fastest a page is read`);
        set.every_seconds = every;
      }
    }
    // (Its Auto-checkout, by its owner: armed again after the one purchase it makes — or its max price changed — or off.)
    if (input.aco !== undefined) {
      if (w.userId !== user.id) throw bad('Only its owner arms a drop watch\'s Auto-checkout');
      const aco = bool(input.aco, false);
      const max = aco ? num(input.maxPrice ?? w.maxPrice, { min: 1, max: 100000, def: null }) : w.maxPrice;
      if (aco && w.store !== ALL_STORES && !this.retailers.canBuy(w.store)) throw bad(NO_ACO);
      if (aco && max === null) throw bad('Set a max price to auto-checkout it: Mugibot never pays more than that');
      Object.assign(set, { aco: aco ? 1 : 0, max_price: max });
    }
    if (input.channelId !== undefined || input.roleId !== undefined) {
      if (!w.shared || user.role !== 'admin') throw bad('Only an admin\'s drop watch for everyone posts in a channel — your own tell you by DM');
      const dest = await this.destination({ channelId: input.channelId ?? w.channelId, roleId: input.roleId ?? w.roleId });
      Object.assign(set, { channel_id: dest.channelId, role_id: dest.roleId });
    }
    const keys = Object.keys(set);
    if (keys.length) {
      this.db.run(`UPDATE drop_watches SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`, { ...set, id: w.id });
      this.changed();
      this.hub.publish(w.userId, 'drop', { id: w.id });
      this.repo.audit(user.id, null, 'drop-change', `${w.url || w.page || `${w.words} @ ${w.site || w.store}`}: ${keys.map((k) => `${k}=${set[k] || '(usual)'}`).join(' ')}`);
    }
    return this.view(this.get(w.id), user);
  }

  /**
   * Where an admin's watch for everyone posts, from their form: a text channel of the Discord server
   * and a role of it (each '' for none) — checked against the server's own, when the bot's set up.
   */
  async destination(input) {
    const channelId = str(input.channelId, 30);
    const roleId = str(input.roleId, 30);
    if (channelId && !SNOWFLAKE.test(channelId)) throw bad('Choose the channel from the list (or "the usual channel")');
    if (roleId && !SNOWFLAKE.test(roleId)) throw bad('Choose the role to ping from the list (or no one)');
    if (!channelId && !roleId) return { channelId, roleId };
    if (!channelId) throw bad('Choose a channel for it to ping that role in');
    const d = await this.destinations();
    if (!d.ready) throw bad(d.error || "The Discord bot isn't set up yet (Admin → Setup check)");
    if (!d.channels.some((c) => c.id === channelId)) throw bad("That channel isn't a text channel of the Discord server (any more) — choose another");
    if (roleId && !d.roles.some((r) => r.id === roleId)) throw bad("That role isn't in the Discord server (any more) — choose another");
    return { channelId, roleId };
  }

  /** The Discord server's text channels (with their category) and the roles a post can ping, for the admins' pickers. */
  async destinations({ fresh = false } = {}) {
    const discord = this.ctx && this.ctx.discord;
    if (!discord || !discord.botReady) return { ready: false, channels: [], roles: [], error: "The Discord bot isn't set up yet (Admin → Setup check)" };
    const now = this.now();
    if (!fresh && this.dest && now - this.dest.at < DEST_MS) return this.dest.data;
    const [ch, ro] = await Promise.all([discord.guildChannels(), discord.guildRoles()]);
    if (ch.status !== 200 || !Array.isArray(ch.body)) return { ready: false, channels: [], roles: [], error: "Couldn't read the Discord server's channels — try again in a minute" };
    const all = ch.body.filter((c) => c && c.id);
    const parent = (c) => { const p = all.find((x) => x.type === 4 && x.id === c.parent_id); return p ? String(p.name || '') : ''; };
    const channels = all.filter((c) => c.type === 0 || c.type === 5)
      .map((c) => ({ id: String(c.id), name: String(c.name || ''), parent: parent(c), position: c.position ?? 0 }))
      .sort((a, b) => a.parent.localeCompare(b.parent) || a.position - b.position || a.name.localeCompare(b.name))
      .map(({ position, ...c }) => c);
    // (Not @everyone — its id is the server's — nor a bot's own role.)
    const guildId = this.cfg.discord.guildId;
    const roles = (ro.status === 200 && Array.isArray(ro.body) ? ro.body : [])
      .filter((r) => r && r.id && String(r.id) !== String(guildId) && !r.managed)
      .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
      .map((r) => ({ id: String(r.id), name: String(r.name || '') }));
    const data = { ready: true, channels, roles, error: '' };
    this.dest = { at: now, data };
    return data;
  }

  /**
   * Where an alert about a product a watch found goes (monitor/feed.js): the channel chosen for an
   * admin's watch for everyone, pinging its role — or null (the usual rules).
   */
  routeFor(id) {
    const w = id ? this.get(String(id)) : null;
    if (!w || !w.shared || !w.channelId) return null;
    return { id: `drop:${w.id}`, name: nameOf(w) || 'Drop watch', channelId: w.channelId, roleId: w.roleId, categories: [], stores: [], kinds: [...DROP_ROUTE_KINDS], keywords: '', drop: w.id };
  }

  // ---------------------------------------------------------------------------
  // For the dashboard
  // ---------------------------------------------------------------------------
  /** The stores to pick from (and to tell a pasted link's store by): which search, which check out. */
  stores() {
    return this.retailers.list.filter((r) => r.id !== 'other' && this.retailers.enabled(r)).map((r) => ({
      id: r.id, name: r.name, hosts: r.hosts, pathPrefix: r.pathPrefix || null, aco: !!r.flow,
      words: !!r.sweep && (!this.sweeper || this.sweeper.modeFor(r) !== 'off'), demo: !!r.demo,
      // (Its search pages read for key phrases (monitor/pages.js), every `floor` seconds at the fastest; its product pages' paths.)
      pages: !!r.sweep && !!planFor(r, r.base) && (!this.sweeper || this.sweeper.modeFor(r) !== 'off'), floor: floorFor(r),
      productPath: r.productPath ? [r.productPath.source, r.productPath.flags] : null,
    }));
  }

  /** What someone sees: their own watches, the admins' for everyone, and their pool's leader's (server/pools.js). */
  viewFor(user) {
    const leader = this.pools ? this.pools.leaderOf(user.id) : null;
    const list = this.watches().filter((w) => w.userId === user.id || w.shared || (leader && w.userId === leader));
    const route = user.role === 'admin' ? this.catalog.listRoutes().find((r) => r.categories.includes('nontcg')) || null : null;
    return {
      watches: list.map((w) => this.view(w, user, { pooled: !!leader && w.userId === leader && !w.shared })),
      stores: this.stores(),
      limit: this.limitFor(user),
      used: list.filter((w) => w.userId === user.id).length,
      sweepSeconds: Math.round(this.sweepMs / 1000),
      siteSeconds: Math.round(this.siteMs / 1000),
      // (A search page: read this often unless you choose, and never faster than every pageMin seconds.)
      pageSeconds: PAGE_DEFAULT_SECONDS, pageMin: floorFor(null),
      route: route && { id: route.id, name: route.name, enabled: route.enabled },
      // (Admins: whether there's a Discord server to pick a watch's channel and role from.)
      ...(user.role === 'admin' ? { discord: { ready: !!(this.ctx && this.ctx.discord && this.ctx.discord.botReady) } } : {}),
    };
  }

  /** pooled: the viewer's pool's leader's own watch — shown to them as it is, what it found as their copies of it. */
  view(w, viewer, { pooled = false } = {}) {
    const mine = w.userId === viewer.id;
    const admin = viewer.role === 'admin';
    // (A search page's: how often it's read, and from where — Mugibot's server or an admin's browser, said to admins only.)
    const pg = w.page && this.pages ? this.pages.viewOf(w) : null;
    return {
      id: w.id, kind: w.url ? 'link' : w.page ? 'page' : 'words', shared: w.shared, mine, by: w.shared || admin || pooled ? w.username : '',
      ...(pooled ? { pool: w.username } : {}),
      store: w.store, storeName: this.where(w), site: w.site, words: w.words, url: w.url, label: w.label,
      category: w.category, aco: mine && w.aco, maxPrice: mine ? w.maxPrice : null, canBuy: w.store === ALL_STORES || this.retailers.canBuy(w.store),
      // (A search page's note on a read that went fine, saying where it's read from: admins only.)
      lastAt: w.lastAt, lastOkAt: w.lastOkAt, fails: w.fails, error: admin ? w.error : pg && !w.fails && publicError(w.error) !== w.error ? '' : publicError(w.error), seen: w.seen,
      looked: !!w.baselineAt, nextAt: pg ? pg.nextAt : w.store === 'other' ? w.nextAt : null, createdAt: w.createdAt,
      // (Read from a browser while the website refuses the server: an admin's, or your own for your own watch.)
      via: pg ? ((admin || (mine && w.store === 'other')) && pg.via === 'browser' ? 'browser' : '')
        : (admin || mine) && w.store === 'other' && w.words && this.viaBrowser(w) ? 'browser' : '',
      allow: w.fails > 0 && /refused|bot check/i.test(w.error) && !this.viaBrowser(w) && this.readsFor(w, viewer) ? this.allowFor(viewer, w.site || w.page) : '',
      ...(pg ? {
        page: w.page, phrases: w.phrases, every: pg.every, floor: pg.floor, readEvery: pg.readEvery,
        // (What it's waiting on: 'browser' — an admin's browser to read it, 'update' — that browser's extension to update, 'off' — its store switched off.)
        waiting: pg.waiting === 'browser' || pg.waiting === 'update' ? (admin ? pg.waiting : 'browser') : pg.waiting,
        ...(admin && pg.needs ? { needs: pg.needs, has: pg.has } : {}),
      } : {}),
      canChange: this.canChange(w, viewer),
      // (Where it posts, for an admin's watch for everyone: admins only.)
      ...(admin && w.shared ? { channelId: w.channelId, roleId: w.roleId } : {}),
      found: w.found.map((f) => this.foundView(w, f, mine, viewer, pooled)).filter(Boolean),
    };
  }

  /**
   * Another website refusing the server, that this person's browser could read instead: its address
   * when their extension (one that can be allowed it: 1.26.0 or later) hasn't said it may read it — they
   * allow it from the extension's menu — else ''.
   */
  allowFor(viewer, url) {
    let host = '';
    try { const u = new URL(url); host = u.protocol === 'https:' || this.cfg.monitor.allowPrivateHosts ? u.host.toLowerCase() : ''; } catch { return ''; }
    return host && viewer && this.monitor && this.monitor.siteGranted(viewer.id, url) === false ? host : '';
  }

  foundView(w, f, mine, viewer = null, pooled = false) {
    const admin = !!viewer && viewer.role === 'admin';
    if (f.productId) {
      const p = this.catalog.productById(f.productId);
      if (!p) return null;
      return {
        id: p.id, productId: p.id, name: productName(p), url: p.url, image: p.image, status: p.status, price: p.price,
        // (Admins: its stock read by an admin's browser, the store refusing the server.)
        ...(admin && p.status_source === 'browser' ? { via: 'browser' } : {}),
        ...(admin && p.store === 'other' && FAILED.has(p.status) && this.allowFor(viewer, p.url) ? { allow: this.allowFor(viewer, p.url) } : {}),
        store: p.store, sku: p.sku, storeName: this.retailers.siteName(p.store, p.url), canBuy: this.retailers.canBuy(p.store), arm: mine ? f.arm || '' : '',
        // (When it was found, and when its stock last changed: the dashboard's "Latest finds first".)
        at: f.at || null, statusAt: p.status_at ?? null,
      };
    }
    if (!f.itemId || (!mine && !(pooled && viewer))) return null;
    // (The pool's leader's watch: what it found is on the viewer's watchlist as their own copy of the leader's.)
    const copy = mine ? null : this.db.get('SELECT id FROM items WHERE user_id = :v AND pool_src = :s', { v: viewer.id, s: f.itemId });
    if (!mine && !copy) return null;
    const it = mine ? this.repo.getItem(w.userId, f.itemId) : this.repo.getItem(viewer.id, copy.id);
    if (!it) return null;
    return {
      id: it.id, itemId: it.id, name: it.name, url: it.url, image: '', status: it.monitor ? it.status : 'paused', price: it.lastPrice ?? it.price,
      store: it.store, sku: it.sku, storeName: this.retailers.siteName(it.store, it.url), canBuy: this.retailers.canBuy(it.store), aco: it.aco, arm: mine ? f.arm || '' : '',
      at: f.at || null, statusAt: it.statusAt ?? null,
      ...(it.statusSource === 'browser' ? { via: 'browser' } : {}),
      ...(it.store === 'other' && it.monitor && FAILED.has(it.status) && this.allowFor(viewer, it.url) ? { allow: this.allowFor(viewer, it.url) } : {}),
    };
  }
}
