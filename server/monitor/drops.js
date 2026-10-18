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
// price: a link is armed like a watchlist item; words arm only what drops after the watch's first
// look — a new listing, or something listed but not on sale yet (as VIP watches do: a broad watch
// would otherwise buy everything that matches).

import crypto from 'node:crypto';
import { CATEGORIES } from '../catalog.js';
import { newId } from '../crypto.js';
import { ENTITLED_SQL } from '../repo.js';
import { bad, bool, httpUrl, item as checkItem, num, str } from '../schema.js';
import { slugWords } from './extract.js';
import { mentions, norm, parseGeneric, parseShopifyProducts, parseShopifySuggest } from './listing.js';
import { MonitorAdmin } from './manage.js';
import { publicError } from './public.js';
import { BlockedUrlError, safeFetch } from './safeurl.js';
import { STATUS, isOrderable } from './status.js';

const KINDS = ['restock', 'listed', 'price_drop'];
export const DROP_NOTE = 'Drop watch';
// What one watch keeps of what it found: an admin's (monitored products), anyone's own (watchlist items).
const MAX_FOUND_SHARED = 20;
const MAX_FOUND_OWN = 10;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
// Statuses that say whether something's on sale (not a failed or empty read).
const READ = new Set([STATUS.IN_STOCK, STATUS.PREORDER, STATUS.OUT_OF_STOCK, STATUS.COMING_SOON, STATUS.NOT_LISTED]);
const NO_ACO = 'Auto-checkout works at stores Mugibot has a checkout for — at another website you get the alert, and buy it there yourself';
// What an admin's watch for everyone posts in the channel chosen for it: its drops and restocks.
export const DROP_ROUTE_KINDS = ['listed', 'restock'];
const SNOWFLAKE = /^\d{5,25}$/;
const DEST_MS = 60 * 1000;
const json = (s, fallback) => { try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; } };

/** Words to look for: lower case, no accents or punctuation ("Xbox Series X!" → "xbox series x"). */
export function wordsOf(v) {
  return norm(str(v, 60)).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
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
export function nameFromLink(url) {
  let p = '';
  try { p = new URL(url).pathname; } catch { return ''; }
  return slugWords(p).replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 120);
}

function toWatch(r) {
  return r && {
    id: r.id, userId: r.user_id, username: r.username || '', active: r.active !== 0, shared: !!r.shared,
    store: r.store, site: r.site, words: r.words, url: r.url, label: r.label, category: r.category,
    aco: !!r.aco, maxPrice: r.max_price ?? null, found: json(r.found, []), how: r.how, seen: r.seen ?? 0,
    baselineAt: r.baseline_at ?? null, nextAt: r.next_at || 0, lastAt: r.last_at ?? null, lastOkAt: r.last_ok_at ?? null,
    fails: r.fails || 0, error: r.error || '', createdAt: r.created_at,
    channelId: r.channel_id || '', roleId: r.role_id || '',
  };
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

  /** What it found (kept on the watch object too, so a loop over finds sees each one). */
  saveFound(w, found) {
    w.found = found.slice(-Math.max(MAX_FOUND_SHARED, MAX_FOUND_OWN));
    this.db.run('UPDATE drop_watches SET found = :f WHERE id = :id', { id: w.id, f: JSON.stringify(w.found) });
    this.changed();
  }

  /** Where a watch looks: the store's name, or the website's address. */
  where(w) {
    if (w.store === 'other') return this.retailers.siteName('other', w.site || w.url);
    return this.retailers.name(w.store);
  }

  // ---------------------------------------------------------------------------
  // Words at a store Mugibot searches: in the live sweeps' turn (sweep.js)
  // ---------------------------------------------------------------------------
  /** The words watches at a store. */
  wordsAt(storeId) {
    return this.live().filter((w) => w.words && w.store === storeId);
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
    let pick = words.find((wd) => this.urgent.has(key(wd))) || words.find((wd) => !lastAt(wd) && list.some((w) => w.words === wd && !w.baselineAt));
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
    return this.wordsAt(storeId).find((w) => w.shared && (!words || w.words === words) && mentions(name, w.words)) || null;
  }

  /** Someone's own watches whose words are in this name. */
  ownFor(storeId, title) {
    const name = norm(title);
    if (!name) return [];
    return this.wordsAt(storeId).filter((w) => !w.shared && mentions(name, w.words));
  }

  /** One search of these words at a store went (sweep.js): what each watch with them shows — and its first look is done. */
  searched(storeId, words, info) {
    const list = this.wordsAt(storeId).filter((w) => w.words === words);
    if (!list.length) return;
    const now = this.now();
    for (const w of list) {
      this.db.run(`UPDATE drop_watches SET last_at = :now, last_ok_at = CASE WHEN :ok = 1 THEN :now ELSE last_ok_at END,
          fails = CASE WHEN :ok = 1 THEN 0 ELSE fails + 1 END, error = :err, seen = CASE WHEN :ok = 1 THEN :seen ELSE seen END,
          baseline_at = CASE WHEN :ok = 1 AND baseline_at IS NULL THEN :now ELSE baseline_at END WHERE id = :id`,
      { id: w.id, now, ok: info.ok ? 1 : 0, seen: info.found || 0, err: info.ok ? '' : String(info.error || 'The search failed').slice(0, 200) });
    }
    this.changed();
    for (const w of list) {
      this.hub.publish(w.userId, 'drop', { id: w.id });
      if (info.ok && !w.baselineAt) this.firstLook(this.get(w.id));
    }
  }

  /**
   * An admin's watch for everyone found a product in a search (it's in the catalogue now: sweep.js):
   * a monitor on it, so its page is read for its stock too — and, when the admin asked, armed for
   * their Auto-checkout (only what drops). baseline: listed already when the watch first looked.
   * status: its stock in the search (or null).
   */
  async foundShared(w, product, { baseline = false, status = null } = {}) {
    if (!w || !product) return;
    this.monitorFor(w, product);
    if (w.found.some((f) => f.productId === product.id) || w.found.length >= MAX_FOUND_SHARED) return;
    const arm = this.armOf(w, product.store, product.url, status, baseline);
    this.saveFound(w, [...w.found, { productId: product.id, sku: product.sku, at: this.now(), ...(arm ? { arm } : {}) }]);
    this.repo.ensurePageFor({ store: product.store, sku: product.sku, url: product.url });
    if (product.url) this.db.run('UPDATE page_checks SET next_check_at = 0 WHERE url = :url', { url: product.url });
    if (arm === 'armed') {
      const item = this.arm(w, product, status);
      // On sale the moment it's found: Auto-checkout starts now (not at the next check).
      if (item && !baseline && isOrderable(status)) await this.applyNow(item.id, { status, title: product.name, price: product.price });
    } else if (arm === 'skipped') this.onSale(w, product);
    this.hub.publish(w.userId, 'drop', { id: w.id });
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
   * Auto-checkout for one find: 'armed', 'pending' (armed once its page says it isn't on sale yet),
   * 'skipped' (on sale already at the watch's first look: not a drop) or '' (not asked for, or no checkout there).
   */
  armOf(w, store, url, status, baseline) {
    if (!w.aco || w.maxPrice === null || !url || !this.retailers.canBuy(store)) return '';
    if (!baseline) return 'armed';
    if (READ.has(status)) return isOrderable(status) ? 'skipped' : 'armed';
    return 'pending';
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
    this.repo.addEvent(w.userId, { type: 'aco', level: 'info', message: `Drop watch: ${p.name || p.sku} was on sale already when the watch first looked, so it isn't armed — ⚡ Buy it yourself if you want it`, name: p.name || null, sku: p.sku, url: p.url || null });
  }

  /** Someone's watchlist is full: said once a day. */
  full(w) {
    const day = Math.floor(this.now() / 86400000);
    if (this.fullDay && this.fullDay.get(w.id) === day) return;
    (this.fullDay ||= new Map()).set(w.id, day);
    this.repo.addEvent(w.userId, { type: 'restock', level: 'warn', message: `Drop watch "${w.label || w.words || w.url}": your watchlist is full (${this.cfg.limits.items}), so what it finds can't go on it — remove something from your watchlist` });
  }

  /** A product's page was read (monitor/index.js): a find waiting to see whether it's on sale yet is armed if it isn't. */
  checked(product) {
    if (!product || !READ.has(product.status) || !this.watches().length) return;
    for (const w of this.watches()) {
      const f = w.found.find((x) => x.productId === product.id && x.arm === 'pending');
      if (!f) continue;
      const onSale = isOrderable(product.status);
      this.saveFound(w, w.found.map((x) => (x === f ? { ...x, arm: onSale ? 'skipped' : 'armed' } : x)));
      if (onSale) this.onSale(w, product);
      else this.arm(w, product, product.status);
    }
  }

  /**
   * Someone's own watch found a product in a search at a store (sweep.js): on their watchlist, theirs
   * alone. A new listing is news straight away — their DM, and Auto-checkout if it's armed and on sale.
   * p: the search's product; status: its stock there (or null).
   */
  async foundOwn(w, r, p, status, { baseline = false } = {}) {
    if (!w || !p || !p.url || w.found.some((f) => String(f.sku).toLowerCase() === String(p.sku).toLowerCase()) || w.found.length >= MAX_FOUND_OWN) return null;
    return this.addOwn(w, { store: r.id, sku: p.sku, url: p.url, name: p.title || p.name, price: p.price ?? null }, status, { baseline });
  }

  async addOwn(w, p, status, { baseline }) {
    const user = this.repo.userById(w.userId);
    if (!user || user.disabled) return null;
    let item = this.repo.itemBySku(user.id, p.store, p.sku);
    let arm = '';
    const added = !item;
    if (added) {
      if (this.repo.countItems(user.id) >= this.cfg.limits.items) { this.full(w); return null; }
      arm = this.armOf(w, p.store, p.url, p.store === 'other' ? null : status, baseline);
      try {
        item = this.repo.addItem(user.id, checkItem({ url: p.url, sku: p.sku, name: p.name || p.sku, maxPrice: arm ? w.maxPrice : null, aco: arm === 'armed', monitor: true }, { retailers: this.retailers }));
      } catch (e) {
        this.cfg.log('[drops]', e.message);
        return null;
      }
      // Its stock as it is now, so only a change after this is news — or, a new listing, "not listed"
      // a moment ago (so what it is now is the news). Another website's listing doesn't say reliably:
      // its page decides (quietly, the first time: monitor/index.js).
      const st = !baseline ? STATUS.NOT_LISTED : p.store !== 'other' && READ.has(status) ? status : STATUS.UNKNOWN;
      const t = this.now();
      this.db.run(`UPDATE items SET drop_watch = :w, status = :st, status_source = 'server', status_at = :t, checked_at = :t,
        last_price = COALESCE(:price, last_price) WHERE id = :id`, { w: w.id, st, t, price: typeof p.price === 'number' ? p.price : null, id: item.id });
    }
    this.saveFound(w, [...w.found, { itemId: item.id, sku: p.sku, at: this.now(), ...(arm ? { arm } : {}) }]);
    this.hub.publish(user.id, 'watch', { id: item.id, added: true });
    this.hub.publish(user.id, 'drop', { id: w.id });
    if (added && !baseline) {
      // A new listing: their alert now (and Auto-checkout, when it's armed and on sale). The search's
      // stock where it says; else (and at another website) its page, read now.
      if (p.store !== 'other' && READ.has(status)) await this.applyNow(item.id, { status, title: p.name || null, price: p.price ?? null });
      else if (this.monitor) await this.monitor.checkPage(p.url);
    }
    return item;
  }

  /** What a search said about a watchlist item it just put there, applied now (its alerts, Auto-checkout). */
  async applyNow(itemId, { status, title = null, price = null }) {
    const row = this.db.get('SELECT * FROM items WHERE id = :id', { id: itemId });
    if (!row || !this.monitor) return;
    await this.monitor.applyResult(row, { status, title, price: typeof price === 'number' ? price : null, error: '' }, 'sweep');
  }

  /**
   * A drop watch's find whose stock wasn't known was read for the first time (monitor/index.js): how
   * it is, not a change. One waiting to see whether it's on sale yet is armed if it isn't.
   */
  firstRead(item, status) {
    const w = this.get(item.drop_watch);
    if (!w || !READ.has(status)) return;
    const f = w.found.find((x) => x.itemId === item.id && x.arm === 'pending');
    if (!f) return;
    const onSale = isOrderable(status);
    this.saveFound(w, w.found.map((x) => (x === f ? { ...x, arm: onSale ? 'skipped' : 'armed' } : x)));
    if (onSale) {
      this.onSale(w, { name: item.name, sku: item.sku, url: item.url });
      return;
    }
    this.db.run('UPDATE items SET aco = 1, aco_at = :t WHERE id = :id AND aco = 0', { t: this.now(), id: item.id });
    this.repo.addEvent(w.userId, { type: 'aco', level: 'warn', message: `Drop watch: ${item.name} armed for Auto-checkout, up to $${Number(item.max_price ?? w.maxPrice).toFixed(2)}`, name: item.name, sku: item.sku, url: item.url || null });
    this.hub.publish(w.userId, 'watch', { id: item.id, aco: true });
  }

  /** A watch's first look is done: what it found is how things were. Your own: one line in your activity. */
  firstLook(w) {
    if (!w || w.shared || !w.found.length) return;
    const n = w.found.length;
    this.repo.addEvent(w.userId, {
      type: 'restock', level: 'info',
      message: `🎯 Watching "${w.words}" at ${this.where(w)}: ${n} product${n === 1 ? '' : 's'} with those words ${n === 1 ? 'is' : 'are'} listed already — on your watchlist now, so you're told when ${n === 1 ? 'it comes' : 'any comes'} back in stock. Anything new, you're told the moment it drops.`,
    });
  }

  // ---------------------------------------------------------------------------
  // Words at another website: read from the server, every couple of minutes
  // ---------------------------------------------------------------------------
  start() {
    if (this.timer || !this.cfg.monitor.enabled) return;
    this.timer = setInterval(() => { this.tick().catch((e) => this.cfg.log('[drops]', e.message)); }, 5000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
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
    const base = site.replace(/[?#].*$/, '').replace(/\/+$/, '');
    const q = encodeURIComponent(words);
    const url = way === 'suggest' ? `${base}/search/suggest.json?q=${q}&resources%5Btype%5D=product&resources%5Blimit%5D=10&resources%5Boptions%5D%5Bunavailable_products%5D=last`
      : way === 'search' ? `${base}/search?q=${q}` : site;
    let res;
    try {
      const timeoutMs = Math.min(this.cfg.monitor.timeoutMs, 20000);
      res = await safeFetch(this.fetch, url, { headers: this.headers(way === 'suggest'), timeoutMs, signal: AbortSignal.timeout(timeoutMs) }, { allowPrivate: this.cfg.monitor.allowPrivateHosts });
    } catch (e) {
      return { ok: false, error: e instanceof BlockedUrlError ? e.message : e.name === 'TimeoutError' ? 'The website took too long to answer' : "Couldn't reach the website" };
    }
    if ([401, 403, 429, 503].includes(res.status)) return { ok: false, refused: true, error: `The website refused Mugibot (HTTP ${res.status}) — it's asked again later` };
    if (!res.ok) return { ok: false, error: `The website answered HTTP ${res.status}` };
    const text = (await res.text()).slice(0, 3_000_000);
    const type = (res.headers && res.headers.get('content-type')) || '';
    const final = res.url || url;
    if (way === 'suggest') {
      if (!/json/.test(type)) return { ok: false, error: 'Not a Shopify shop' };
      const parsed = parseShopifySuggest(text, { base: final });
      return parsed.problem ? { ok: false, error: 'Not a Shopify shop' } : { ok: true, products: parsed.products };
    }
    if (/json/.test(type)) {
      const parsed = parseShopifyProducts(text, { base: final });
      return parsed.problem ? { ok: false, error: "That page's data isn't a product list Mugibot can read" } : { ok: true, products: parsed.products };
    }
    let host = '';
    try { host = new URL(final).hostname; } catch { /* no address */ }
    const parsed = parseGeneric(text, { base: final, storeName: host });
    if (parsed.problem === 'blocked') return { ok: false, refused: true, error: 'The website showed a bot check instead of the page — it\'s asked again later' };
    // (A search page with nothing on it is fine: nothing with those words yet.)
    return { ok: true, products: parsed.products };
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
    const now = this.now();
    for (const x of peers) {
      if (!got) {
        const fails = x.fails + 1;
        this.db.run('UPDATE drop_watches SET last_at = :now, fails = :f, error = :e, next_at = :n WHERE id = :id',
          { now, f: fails, e: String(error).slice(0, 200), n: now + Math.min(MAX_BACKOFF_MS, this.siteMs * 2 ** Math.min(fails, 4)), id: x.id });
        continue;
      }
      const baseline = !x.baselineAt;
      for (const p of got.products.filter((q) => mentions(norm(q.title), x.words))) {
        if (x.shared) await this.foundSharedSite(x, p, { baseline });
        else await this.foundOwnSite(x, p, { baseline });
      }
      this.db.run(`UPDATE drop_watches SET how = :how, last_at = :now, last_ok_at = :now, fails = 0, error = '', seen = :seen, next_at = :n,
        baseline_at = COALESCE(baseline_at, :now) WHERE id = :id`, { how: got.how, now, seen: got.products.length, n: now + this.siteMs, id: x.id });
    }
    this.changed();
    for (const x of peers) {
      this.hub.publish(x.userId, 'drop', { id: x.id });
      if (got && !x.baselineAt) this.firstLook(this.get(x.id));
    }
    return got ? { ok: true, how: got.how, products: got.products.length } : { ok: false, error };
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
    if (!sku || w.found.some((f) => f.sku === sku) || w.found.length >= MAX_FOUND_SHARED || this.catalog.isBlocked('other', sku)) return;
    const known = this.catalog.productFor('other', sku);
    const product = this.catalog.upsertProduct({ store: 'other', sku, url, name: p.title, image: p.image || '', category: known ? '' : w.category });
    this.monitorFor(w, product);
    this.saveFound(w, [...w.found, { productId: product.id, sku, at: this.now() }]);
    this.repo.ensurePage(url, 'product', 'other', sku);
    if (!baseline && !known) {
      const t = this.now();
      this.catalog.updateProduct(product.id, { status: STATUS.NOT_LISTED, status_at: t, last_ok_at: t, confirmed: 1 });
      if (this.monitor) await this.monitor.checkPage(url);
    } else {
      this.db.run('UPDATE page_checks SET next_check_at = 0 WHERE url = :url', { url });
    }
  }

  /** Someone's own watch found a product at another website: on their watchlist (alerts only). */
  async foundOwnSite(w, p, { baseline }) {
    const url = this.siteLink(p);
    const sku = url && otherSku(url);
    if (!sku || w.found.some((f) => f.sku === sku) || w.found.length >= MAX_FOUND_OWN) return null;
    return this.addOwn(w, { store: 'other', sku, url, name: p.title, price: p.price ?? null }, null, { baseline });
  }

  // ---------------------------------------------------------------------------
  // Adding, checking and removing watches
  // ---------------------------------------------------------------------------
  /**
   * A new watch. input: { url } (a product link) or { words, store } — store: a store Mugibot
   * searches, or 'other' with site (the website, or a page of it) — plus label, aco + maxPrice,
   * and for admins shared (for everyone: default on) and category.
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
    const url = httpUrl(input.url, 'Product link', { required: false });
    let store = '';
    let site = '';
    let words = '';
    if (url) {
      const r = this.retailers.forUrl(url);
      store = r ? r.id : 'other';
      if (r && !this.retailers.enabled(r)) throw bad(`${r.name} is switched off at the moment`);
      if (aco && !this.retailers.canBuy(store)) throw bad(NO_ACO);
      if (mine.some((w) => w.url === url)) throw bad('You\'re watching that link already');
    } else {
      words = wordsOf(input.words);
      if (words.length < 3) throw bad('Paste the product\'s link, or type the words in its name (e.g. "xbox series x" — every word must be in the name)');
      store = str(input.store, 40);
      if (store === 'other') {
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
    this.db.run(`INSERT INTO drop_watches (id, user_id, shared, store, site, words, url, label, category, aco, max_price, channel_id, role_id, created_at)
      VALUES (:id, :u, :shared, :store, :site, :words, :url, :label, :category, :aco, :max, :ch, :role, :t)`, {
      id, u: user.id, shared: shared ? 1 : 0, store, site, words, url, label, category, aco: aco ? 1 : 0, max: maxPrice, ch: dest.channelId, role: dest.roleId, t: this.now(),
    });
    this.changed();
    try {
      if (url) await this.addLink(this.get(id), url, user);
    } catch (e) {
      this.db.run('DELETE FROM drop_watches WHERE id = :id', { id });
      this.changed();
      throw e;
    }
    this.repo.audit(user.id, null, 'drop-add', `${shared ? 'shared' : 'own'}: ${url || `${words} @ ${site || store}`}`);
    // Looked for at the store's next search (its first look is what it compares drops with) — at the
    // store's own pace, never sooner. Another website: within a few seconds.
    if (words && store !== 'other') this.urgent.add(`${store}|${words}`);
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
    if (w.url) {
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
    this.db.run('DELETE FROM monitors WHERE drop_watch = :id AND note = :note', { id: w.id, note: DROP_NOTE });
    this.db.run('UPDATE monitors SET drop_watch = NULL WHERE drop_watch = :id', { id: w.id });
    const items = this.db.all('SELECT id FROM items WHERE drop_watch = :id', { id: w.id });
    this.db.run('DELETE FROM items WHERE drop_watch = :id', { id: w.id });
    this.db.run('DELETE FROM drop_watches WHERE id = :id', { id: w.id });
    this.changed();
    for (const it of items) this.hub.publish(w.userId, 'watch', { id: it.id, removed: true });
    this.repo.audit(user.id, null, 'drop-remove', w.url || `${w.words} @ ${w.site || w.store}`);
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
    if (input.channelId !== undefined || input.roleId !== undefined) {
      if (!w.shared || user.role !== 'admin') throw bad('Only an admin\'s drop watch for everyone posts in a channel — your own tell you by DM');
      const dest = await this.destination({ channelId: input.channelId ?? w.channelId, roleId: input.roleId ?? w.roleId });
      Object.assign(set, { channel_id: dest.channelId, role_id: dest.roleId });
    }
    const keys = Object.keys(set);
    if (keys.length) {
      this.db.run(`UPDATE drop_watches SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`, { ...set, id: w.id });
      this.changed();
      this.repo.audit(user.id, null, 'drop-change', `${w.url || `${w.words} @ ${w.site || w.store}`}: ${keys.map((k) => `${k}=${set[k] || '(usual)'}`).join(' ')}`);
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
    return { id: `drop:${w.id}`, name: w.label || w.words || 'Drop watch', channelId: w.channelId, roleId: w.roleId, categories: [], stores: [], kinds: [...DROP_ROUTE_KINDS], keywords: '', drop: w.id };
  }

  // ---------------------------------------------------------------------------
  // For the dashboard
  // ---------------------------------------------------------------------------
  /** The stores to pick from (and to tell a pasted link's store by): which search, which check out. */
  stores() {
    return this.retailers.list.filter((r) => r.id !== 'other' && this.retailers.enabled(r)).map((r) => ({
      id: r.id, name: r.name, hosts: r.hosts, pathPrefix: r.pathPrefix || null, aco: !!r.flow,
      words: !!r.sweep && (!this.sweeper || this.sweeper.modeFor(r) !== 'off'), demo: !!r.demo,
    }));
  }

  /** What someone sees: their own watches, and the admins' for everyone. */
  viewFor(user) {
    const list = this.watches().filter((w) => w.userId === user.id || w.shared);
    const route = user.role === 'admin' ? this.catalog.listRoutes().find((r) => r.categories.includes('nontcg')) || null : null;
    return {
      watches: list.map((w) => this.view(w, user)),
      stores: this.stores(),
      limit: this.limitFor(user),
      used: list.filter((w) => w.userId === user.id).length,
      sweepSeconds: Math.round(this.sweepMs / 1000),
      siteSeconds: Math.round(this.siteMs / 1000),
      route: route && { id: route.id, name: route.name, enabled: route.enabled },
      // (Admins: whether there's a Discord server to pick a watch's channel and role from.)
      ...(user.role === 'admin' ? { discord: { ready: !!(this.ctx && this.ctx.discord && this.ctx.discord.botReady) } } : {}),
    };
  }

  view(w, viewer) {
    const mine = w.userId === viewer.id;
    const admin = viewer.role === 'admin';
    return {
      id: w.id, kind: w.url ? 'link' : 'words', shared: w.shared, mine, by: w.shared || admin ? w.username : '',
      store: w.store, storeName: this.where(w), site: w.site, words: w.words, url: w.url, label: w.label,
      category: w.category, aco: mine && w.aco, maxPrice: mine ? w.maxPrice : null, canBuy: this.retailers.canBuy(w.store),
      lastAt: w.lastAt, lastOkAt: w.lastOkAt, fails: w.fails, error: admin ? w.error : publicError(w.error), seen: w.seen,
      looked: !!w.baselineAt, nextAt: w.store === 'other' ? w.nextAt : null, createdAt: w.createdAt,
      canChange: this.canChange(w, viewer),
      // (Where it posts, for an admin's watch for everyone: admins only.)
      ...(admin && w.shared ? { channelId: w.channelId, roleId: w.roleId } : {}),
      found: w.found.map((f) => this.foundView(w, f, mine)).filter(Boolean),
    };
  }

  foundView(w, f, mine) {
    if (f.productId) {
      const p = this.catalog.productById(f.productId);
      if (!p) return null;
      return {
        id: p.id, productId: p.id, name: p.name || p.sku, url: p.url, image: p.image, status: p.status, price: p.price,
        store: p.store, sku: p.sku, storeName: this.retailers.siteName(p.store, p.url), canBuy: this.retailers.canBuy(p.store), arm: mine ? f.arm || '' : '',
      };
    }
    if (!mine || !f.itemId) return null;
    const it = this.repo.getItem(w.userId, f.itemId);
    if (!it) return null;
    return {
      id: it.id, itemId: it.id, name: it.name, url: it.url, image: '', status: it.monitor ? it.status : 'paused', price: it.lastPrice ?? it.price,
      store: it.store, sku: it.sku, storeName: this.retailers.siteName(it.store, it.url), canBuy: this.retailers.canBuy(it.store), aco: it.aco, arm: f.arm || '',
    };
  }
}
