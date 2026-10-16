// Live sweeps (docs/MONITORING.md), built on MugiWatch: each store's search
// for each keyword, every few seconds, with every store on its own loop.
//
// Each search result page is read whole (name, price, stock, link, picture of
// every product on it) and compared with what Mugibot saw before:
//
//   🆕 New drop   a product that wasn't there before
//   🟢 Restock    out of stock → in stock (once a day per product, like MugiWatch)
//   📉 Price drop the price fell by at least the set percentage
//
// The first sweep of a search only sets the scene (what's there was already
// there); so does the first sweep after it hasn't run for 6 hours, or after
// the keywords or filters change. Products count when their name has the
// keyword in it, they're trading-card products (the TCG words) and they're
// sold by the store itself, not a marketplace seller.
//
// Alerts go out the moment a sweep sees the change: the dashboard's live
// feed, the Discord channels whose rules match, and every member watching
// that SKU (their own DM and watchlist).
//
// Target leaves sold-out products out of its results, so there a product gone
// from every page of a search for 6 minutes (while each page was read fine)
// counts as sold out, and its return as a restock. Only when the pages Mugibot
// reads hold every result: with more results than that, nothing is marked.
//
// Stores that answer servers (Target, JB Hi-Fi) are swept from the server,
// honestly identified as Mugibot. Stores that refuse servers (Kmart, BIG W,
// EB Games) are swept from an admin's browser by the extension, at a gentler
// pace. A refused or failed search backs off (twice as long each time, up to
// 15 minutes) and never alerts.

import { categoryFor, toProduct } from '../catalog.js';
import { ENTITLED_SQL } from '../repo.js';
import { serialize } from '../retailers/index.js';
import { bad, bool, num, str } from '../schema.js';
import { storeFetch } from './http.js';
import { mentions, norm, parseListing, termsRegex } from './listing.js';
import { BlockedUrlError, safeFetch } from './safeurl.js';
import { STATUS, isOrderable } from './status.js';

export const TCG_TERMS = [
  'card', 'cards', 'tcg', 'booster', 'pack', 'packs', 'bundle', 'starter deck', 'deck', 'elite trainer', 'etb',
  'tin', 'collection box', 'special collection', 'display', 'trading card', 'booster box', 'binder', 'sleeve', 'sleeves',
];

export const SWEEP_DEFAULTS = Object.freeze({
  enabled: true,
  keywords: ['pokemon', 'one piece'],
  everySeconds: 5, // between two searches at one store, from the server
  browserEverySeconds: 15, // …from an admin's browser
  stores: {}, // store id → 'server' | 'browser' | 'off' (unset: the store's own default)
  skipMarketplace: true,
  tcgOnly: true,
  tcgTerms: TCG_TERMS,
  newAlerts: true,
  restockAlerts: true,
  restockOncePerDay: true,
  priceDropPercent: 10, // 0 = no price drop alerts
});

const MODES = ['server', 'browser', 'off'];
const REBASELINE_MS = 6 * 3600 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
// After a store refuses a search, it's searched at a third of the pace for a while, even once it answers again.
const SLOW_MS = 10 * 60 * 1000;
const SLOW_FACTOR = 3;
// A store that leaves sold-out products out of its results: gone from every page this long = sold out.
const GONE_MS = 6 * 60 * 1000;
const HOUR = 3600 * 1000;
const ORDERABLE_FROM = new Set([STATUS.OUT_OF_STOCK, STATUS.COMING_SOON]);
// Fields that change with every search; on their own they don't need writing each time.
const QUIET = new Set(['sweep_seen_at', 'checked_at', 'last_ok_at']);
const sydneyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' });

function list(v, { max, maxLen, minLen = 1, lower = false }) {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/);
  const out = [];
  for (const x of raw) {
    let s = str(x, maxLen + 1).replace(/\s+/g, ' ');
    if (lower) s = s.toLowerCase();
    if (!s) continue;
    if (s.length < minLen || s.length > maxLen) throw bad(`"${s.slice(0, 40)}" is too ${s.length < minLen ? 'short' : 'long'}`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > max) throw bad(`Up to ${max}, please`);
  return out;
}

/** Sweep settings from an admin's form, on top of the current ones. */
export function sweepSettings(input, current, retailers) {
  const src = { ...current, ...(input || {}) };
  const keywords = list(src.keywords, { max: 12, maxLen: 60, minLen: 2, lower: true });
  const enabled = bool(src.enabled, true);
  if (enabled && !keywords.length) throw bad('Add at least one keyword to search for, e.g. pokemon');
  const stores = {};
  for (const [id, mode] of Object.entries(src.stores && typeof src.stores === 'object' ? src.stores : {})) {
    const r = retailers.get(id);
    if (!r || !r.sweep) continue;
    if (!MODES.includes(mode)) throw bad(`${r.name}: choose server, browser or off`);
    stores[id] = mode;
  }
  const tcgTerms = list(src.tcgTerms, { max: 80, maxLen: 40, lower: true });
  const tcgOnly = bool(src.tcgOnly, true);
  if (tcgOnly && !tcgTerms.length) throw bad('Add the words that make a product a trading-card product, or switch "Trading cards only" off');
  return {
    enabled,
    keywords,
    everySeconds: num(src.everySeconds, { min: 3, max: 600, int: true, def: SWEEP_DEFAULTS.everySeconds }),
    browserEverySeconds: num(src.browserEverySeconds, { min: 5, max: 600, int: true, def: SWEEP_DEFAULTS.browserEverySeconds }),
    stores,
    skipMarketplace: bool(src.skipMarketplace, true),
    tcgOnly,
    tcgTerms,
    newAlerts: bool(src.newAlerts, true),
    restockAlerts: bool(src.restockAlerts, true),
    restockOncePerDay: bool(src.restockOncePerDay, true),
    priceDropPercent: num(src.priceDropPercent, { min: 0, max: 90, def: SWEEP_DEFAULTS.priceDropPercent }),
  };
}

const FILTER_KEYS = ['keywords', 'skipMarketplace', 'tcgOnly', 'tcgTerms'];

export class Sweeper {
  constructor({ cfg, repo, catalog, feed, monitor, retailers, hub, fetchImpl = storeFetch, now = () => Date.now(), random = Math.random }) {
    Object.assign(this, { cfg, repo, catalog, feed, monitor, retailers, hub, fetch: fetchImpl, now, random });
    this.db = repo.db;
    this.running = false;
    this.loops = new Set();
    this.wakers = new Map();
    this.state = new Map(); // per store: rotation, recent requests, failures, browser lease
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  get settings() {
    return { ...SWEEP_DEFAULTS, ...(this.repo.getSetting('sweep') || {}) };
  }

  save(input, user) {
    const before = this.settings;
    const next = sweepSettings(input, before, this.retailers);
    this.repo.setSetting('sweep', next);
    // New keywords or filters: products they let in were already there, so the next sweeps set the scene again.
    if (FILTER_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]))) this.db.run('UPDATE sweep_terms SET baseline_at = NULL');
    this.db.run(`DELETE FROM sweep_terms WHERE keyword NOT IN (${next.keywords.map((_, i) => `:k${i}`).join(', ') || "''"})`, Object.fromEntries(next.keywords.map((k, i) => [`k${i}`, k])));
    this.repo.audit(user ? user.id : null, null, 'sweep-settings', `${next.enabled ? 'on' : 'off'}: ${next.keywords.join(', ')}`);
    this.restart();
    return next;
  }

  /** Where a store is swept from: 'server', 'browser' or 'off'. The dummy-store copies are off unless switched on. */
  modeFor(r) {
    const s = this.settings;
    if (!s.enabled || !r || !r.sweep || !this.retailers.enabled(r)) return 'off';
    const m = s.stores[r.id];
    if (MODES.includes(m)) return m;
    return r.demo ? 'off' : r.sweep.from || 'server';
  }

  /** Every store with sweeps, and where it's swept from. */
  stores() {
    return this.retailers.list.filter((r) => r.sweep && r.id !== 'other').map((r) => ({ retailer: r, mode: this.modeFor(r) }));
  }

  stat(id) {
    let s = this.state.get(id);
    if (!s) {
      s = { turn: 0, deep: 0, fails: 0, log: [], lastAt: null, lastOkAt: null, lastError: '', browserNext: 0, nextAt: null, slowUntil: 0, firstOkAt: null };
      this.state.set(id, s);
    }
    return s;
  }

  // ---------------------------------------------------------------------------
  // The searches
  // ---------------------------------------------------------------------------
  query(r, keyword) {
    const w = r.sweep.addWord;
    return w && !/\b(tcg|cards?|booster|trading)\b/i.test(keyword) ? `${keyword} ${w}` : keyword;
  }

  urlFor(r, keyword, page = 1) {
    let p = r.sweep.path.replace('{q}', encodeURIComponent(this.query(r, keyword)));
    if (page > 1 && r.sweep.pagePath) p += r.sweep.pagePath.replace('{page}', String(page));
    return `${r.base}${p}`;
  }

  /**
   * The next search at a store: the first page of each keyword in turn (where new drops show up),
   * and after each round one of the later pages (so everything listed is re-read every minute or so).
   */
  nextTerm(r) {
    const st = this.stat(r.id);
    const kws = this.settings.keywords;
    const pages = Math.max(1, Math.min(10, r.sweep.pages || 1));
    const deep = [];
    for (const keyword of kws) {
      // Only the pages that have results (the first page says how many there are).
      const first = pages > 1 ? this.db.get('SELECT total, found FROM sweep_terms WHERE store = :s AND keyword = :k AND page = 1', { s: r.id, k: keyword }) : null;
      const has = first && first.total && first.found ? Math.ceil(first.total / first.found) : pages;
      for (let page = 2; page <= Math.min(pages, has); page++) deep.push({ keyword, page });
    }
    const round = kws.length + (deep.length ? 1 : 0);
    const slot = st.turn++ % round;
    if (slot < kws.length) return { keyword: kws[slot], page: 1 };
    return deep[st.deep++ % deep.length];
  }

  headers(r) {
    const json = r.sweep.parser === 'shopify-suggest';
    return {
      'user-agent': this.cfg.monitor.userAgent,
      accept: json ? 'application/json' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-AU,en;q=0.9',
    };
  }

  /** One search from the server: fetch, read, compare, alert. */
  async sweepTerm(r, term) {
    const url = this.urlFor(r, term.keyword, term.page);
    const started = Date.now();
    let res;
    let text = '';
    try {
      const timeoutMs = Math.min(this.cfg.monitor.timeoutMs, 20000);
      res = await safeFetch(this.fetch, url, { headers: this.headers(r), timeoutMs, signal: AbortSignal.timeout(timeoutMs) }, { allowPrivate: this.cfg.monitor.allowPrivateHosts });
      if (res.ok) text = await res.text();
    } catch (e) {
      const error = e instanceof BlockedUrlError ? e.message : e.name === 'TimeoutError' ? 'The store took too long to answer' : "Couldn't reach the store";
      return this.record(r, term, { ok: false, url, source: 'server', ms: Date.now() - started, error });
    }
    const ms = Date.now() - started;
    if (!res.ok) {
      const refused = [401, 403, 429, 503].includes(res.status);
      return this.record(r, term, { ok: false, blocked: refused, url, source: 'server', ms, error: refused ? `The store refused the search (HTTP ${res.status})` : `HTTP ${res.status}` });
    }
    const parsed = parseListing(r.sweep.parser, text, { base: url, productPath: r.productPath, skuFromPath: r.skuFromPath, storeName: r.name });
    return this.ingest(r, term, parsed, { source: 'server', url, ms });
  }

  /** What one search found. parsed: { products, total, problem } */
  async ingest(r, term, parsed, { source, url, ms = null }) {
    if (parsed.problem === 'blocked') return this.record(r, term, { ok: false, blocked: true, url, source, ms, error: 'The store showed a bot check instead of results' });
    if (parsed.problem === 'layout') return this.record(r, term, { ok: false, url, source, ms, error: "The page didn't have the product list Mugibot reads — the store may have changed it" });
    const s = this.settings;
    const now = this.now();
    const row = this.db.get('SELECT * FROM sweep_terms WHERE store = :s AND keyword = :k AND page = :p', { s: r.id, k: term.keyword, p: term.page });
    const baseline = !row || !row.baseline_at || !row.last_ok_at || now - row.last_ok_at > REBASELINE_MS;
    const tcg = s.tcgOnly ? termsRegex(s.tcgTerms) : null;
    const counts = { found: parsed.products.length, kept: 0, new: 0, restock: 0, price: 0 };
    for (const p of parsed.products) {
      const status = p.inStock === true ? (p.preorder ? STATUS.PREORDER : STATUS.IN_STOCK) : p.inStock === false ? STATUS.OUT_OF_STOCK : null;
      // Members' own SKUs, whatever they are.
      await this.members(r, p, status);
      if (!mentions(p.title, term.keyword)) continue;
      if (s.skipMarketplace && p.marketplace) continue;
      if (tcg && !tcg.test(norm(p.title))) continue;
      counts.kept += 1;
      const ev = await this.track(r, p, { status, keyword: term.keyword, baseline, now });
      for (const k of ev) counts[k] += 1;
    }
    const out = this.record(r, term, { ok: true, url, source, ms, baseline, total: parsed.total ?? null, ...counts, error: parsed.problem === 'empty' ? 'No products on the page' : '' });
    out.gone = await this.markGone(r, term.keyword, now);
    return out;
  }

  /**
   * Stores that leave sold-out products out of their results (Target): a product that's been gone
   * from every page of its search for GONE_MS, while each page was read fine, is sold out.
   * Only when the pages read hold every result the store has; never in the first minutes after a start.
   */
  async markGone(r, keyword, now) {
    if (!r.sweep.goneMeansSoldOut) return 0;
    const st = this.stat(r.id);
    if (!st.firstOkAt || now - st.firstOkAt < GONE_MS) return 0;
    const rows = this.db.all('SELECT * FROM sweep_terms WHERE store = :s AND keyword = :k', { s: r.id, k: keyword });
    const first = rows.find((x) => x.page === 1);
    if (!first || !first.total || !first.found) return 0;
    const need = Math.ceil(first.total / first.found);
    if (need > (r.sweep.pages || 1)) return 0; // more results than Mugibot reads: a product may just be further down
    for (let page = 1; page <= need; page++) {
      const row = rows.find((x) => x.page === page);
      if (!row || row.fails || !row.last_ok_at || now - row.last_ok_at > 3 * 60 * 1000) return 0;
    }
    const gone = this.db.all(`SELECT * FROM products WHERE store = :s AND sweep_keyword = :k AND status IN ('in_stock', 'preorder')
      AND status_source = 'sweep' AND sweep_seen_at < :cut AND sweep_seen_at >= :recent`, { s: r.id, k: keyword, cut: now - GONE_MS, recent: now - 7 * 86400000 });
    for (const p of gone) {
      const fresh = this.catalog.updateProduct(p.id, { status: STATUS.OUT_OF_STOCK, status_at: now });
      this.feed.broadcast('product', toProduct(fresh));
      const monitor = this.catalog.monitorForProduct(p.id);
      if (monitor && !monitor.paused) await this.feed.transitions(p, fresh);
      await this.members(r, { sku: p.sku, aliases: [] }, STATUS.OUT_OF_STOCK);
    }
    return gone.length;
  }

  /** One product in the shared catalogue: update it, and alert what changed. Returns what it alerted. */
  async track(r, p, { status, keyword, baseline, now }) {
    const s = this.settings;
    const found = [p.sku, ...(p.aliases || [])].map((k) => this.catalog.productFor(r.id, k)).find(Boolean);
    const before = found ? { ...found } : null;
    const product = found || this.catalog.upsertProduct({ store: r.id, sku: p.sku, url: p.url, name: p.title, image: p.image });
    const monitor = this.catalog.monitorForProduct(product.id);
    const set = { sweep_seen_at: now, checked_at: now, last_ok_at: now, confirmed: 1, fail_count: 0, error: '' };
    if (!product.sweep_first_at) Object.assign(set, { sweep_first_at: now, sweep_keyword: keyword });
    if (status) {
      set.status = status;
      set.status_source = 'sweep';
      if (status !== product.status) set.status_at = now;
    } else if (['pending', STATUS.NOT_LISTED, STATUS.BLOCKED, STATUS.ERROR].includes(product.status)) {
      set.status = STATUS.UNKNOWN;
      set.status_at = now;
    }
    if (p.title && p.title !== product.name && (!monitor || !product.name)) set.name = p.title.slice(0, 200);
    if (p.url && !product.url) {
      set.url = p.url;
      if (monitor) this.repo.ensurePage(p.url, 'product', r.id, product.sku);
    }
    if (p.image && p.image !== product.image) set.image = p.image.slice(0, 1000);
    if (product.category === 'other') {
      const c = categoryFor(p.title);
      if (c !== 'other') set.category = c;
    }
    const price = typeof p.price === 'number' && p.price > 0 ? Math.round(p.price * 100) / 100 : null;
    const prevPrice = product.price;
    const priceMoved = price !== null && (typeof prevPrice !== 'number' || Math.abs(price - prevPrice) >= 0.005);
    if (priceMoved) {
      Object.assign(set, { price, previous_price: prevPrice ?? null, price_at: now });
      this.catalog.addPrice(product.id, price);
    }
    // Nothing new about it: the row is only touched about once a minute (searches come every few seconds).
    for (const k of Object.keys(set)) if (set[k] === product[k]) delete set[k];
    const quiet = Object.keys(set).every((k) => QUIET.has(k)) && product.sweep_seen_at && now - product.sweep_seen_at < 60 * 1000;
    const fresh = quiet ? product : this.catalog.updateProduct(product.id, set);
    if (!before || before.status !== fresh.status || priceMoved || before.name !== fresh.name || before.image !== fresh.image) this.feed.broadcast('product', toProduct(fresh));

    const sent = [];
    const fresh2 = () => this.catalog.productById(product.id);
    // New: never seen before, or a SKU confirmed as not listed yet (a monitor added before it's checked isn't new).
    const isNew = !before || (before.status === STATUS.NOT_LISTED && !!before.last_ok_at);
    if (isNew) {
      if (!baseline && s.newAlerts && await this.feed.alert(fresh, 'listed', { sweep: true, note: `New in "${keyword}" at ${r.name}.` })) sent.push('new');
    } else {
      if (s.restockAlerts && isOrderable(fresh.status) && ORDERABLE_FROM.has(before.status) && before.confirmed) {
        const today = sydneyDay.format(now);
        if (!s.restockOncePerDay || fresh.restock_day !== today) {
          if (await this.feed.alert(fresh, 'restock', { sweep: true })) {
            this.catalog.updateProduct(product.id, { restock_day: today });
            sent.push('restock');
          }
        }
      }
      if (s.priceDropPercent > 0 && priceMoved && typeof prevPrice === 'number' && prevPrice > 0 && price < prevPrice) {
        const pct = ((price - prevPrice) / prevPrice) * 100;
        if (-pct >= s.priceDropPercent && await this.feed.alert(fresh2(), 'price_drop', { sweep: true, pct })) sent.push('price');
      }
    }
    // A monitor on this product also gets the alerts it asks for (sold out, price up…).
    if (monitor && !monitor.paused && before) await this.feed.transitions(before, fresh2());
    return sent;
  }

  /** Members watching this SKU: their own watchlist and alerts, straight away. */
  async members(r, p, status) {
    const codes = [...new Set([p.sku, ...(p.aliases || [])].filter(Boolean))].slice(0, 5);
    const params = { s: r.id, now: this.now(), ...Object.fromEntries(codes.map((c, i) => [`c${i}`, c])) };
    const items = this.db.all(`SELECT i.* FROM items i JOIN users u ON u.id = i.user_id
      WHERE i.store = :s AND i.sku COLLATE NOCASE IN (${codes.map((_, i) => `:c${i}`).join(', ')}) AND i.monitor = 1 AND u.disabled = 0 AND ${ENTITLED_SQL}`, params);
    if (!items.length) return;
    const waiting = [...new Set(items.filter((i) => !i.url).map((i) => i.sku))];
    if (waiting.length && p.url) for (const sku of waiting) this.monitor.resolveSku(r.id, sku, p.url);
    if (!status) return;
    const fresh = waiting.length ? this.db.all(`SELECT * FROM items WHERE id IN (${items.map((_, i) => `:i${i}`).join(', ')})`, Object.fromEntries(items.map((it, i) => [`i${i}`, it.id]))) : items;
    for (const item of fresh) {
      if (!item.url) continue;
      await this.monitor.applyResult(item, { status, title: p.title || null, price: typeof p.price === 'number' ? p.price : null, error: '' }, 'sweep');
    }
  }

  /** Remember how a search went (the sweep_terms row, the store's recent requests) and log failures. */
  record(r, term, info) {
    const now = this.now();
    const st = this.stat(r.id);
    st.lastAt = now;
    st.log.push({ at: now, ok: info.ok, blocked: !!info.blocked, ms: info.ms ?? null, source: info.source });
    while (st.log.length && st.log[0].at < now - HOUR) st.log.shift();
    if (info.ok) {
      st.fails = 0;
      st.lastOkAt = now;
      if (!st.firstOkAt) st.firstOkAt = now;
      st.lastError = info.error || '';
    } else {
      st.fails += 1;
      st.lastError = info.error || 'Failed';
      if (info.blocked) st.slowUntil = now + SLOW_MS;
      this.cfg.log(JSON.stringify({ evt: 'sweep.failed', store: r.id, keyword: term.keyword, page: term.page, source: info.source, error: info.error || '', fails: st.fails, ms: info.ms ?? null }));
    }
    this.db.run(`INSERT INTO sweep_terms (store, keyword, page, url, source, baseline_at, last_at, last_ok_at, found, kept, total, fails, error, ms)
      VALUES (:s, :k, :p, :url, :src, :base, :now, :ok, :found, :kept, :total, :fails, :err, :ms)
      ON CONFLICT (store, keyword, page) DO UPDATE SET url = excluded.url, source = excluded.source, last_at = excluded.last_at,
        baseline_at = CASE WHEN :isOk = 1 AND (sweep_terms.baseline_at IS NULL OR :wasBaseline = 1) THEN :now ELSE sweep_terms.baseline_at END,
        last_ok_at = COALESCE(excluded.last_ok_at, sweep_terms.last_ok_at),
        found = CASE WHEN :isOk = 1 THEN excluded.found ELSE sweep_terms.found END,
        kept = CASE WHEN :isOk = 1 THEN excluded.kept ELSE sweep_terms.kept END,
        total = CASE WHEN :isOk = 1 THEN excluded.total ELSE sweep_terms.total END,
        fails = CASE WHEN :isOk = 1 THEN 0 ELSE sweep_terms.fails + 1 END, error = excluded.error, ms = excluded.ms`,
    {
      s: r.id, k: term.keyword, p: term.page, url: info.url || '', src: info.source || '', base: info.ok ? now : null, now, ok: info.ok ? now : null,
      found: info.found || 0, kept: info.kept || 0, total: info.total ?? null, fails: info.ok ? 0 : 1, err: String(info.error || '').slice(0, 300), ms: info.ms ?? null,
      isOk: info.ok ? 1 : 0, wasBaseline: info.baseline ? 1 : 0,
    });
    const out = { store: r.id, keyword: term.keyword, page: term.page, ok: info.ok, blocked: !!info.blocked, error: info.error || '', found: info.found || 0, kept: info.kept || 0, new: info.new || 0, restock: info.restock || 0, price: info.price || 0, baseline: !!info.baseline, ms: info.ms ?? null };
    this.feed.broadcastAdmins('sweep', out);
    return out;
  }

  // ---------------------------------------------------------------------------
  // The server's loops: one per store, each waiting its turn
  // ---------------------------------------------------------------------------
  start() {
    if (this.running || !this.cfg.monitor.enabled) return;
    this.running = true;
    this.restart();
  }

  stop() {
    this.running = false;
    for (const wake of this.wakers.values()) wake();
  }

  /** Start loops for stores newly swept from the server; wake the others so new settings apply now. */
  restart() {
    if (!this.running) return;
    for (const { retailer: r, mode } of this.stores()) {
      if (mode === 'server' && !this.loops.has(r.id)) this.loop(r.id).catch((e) => this.cfg.log('[sweep]', e.message));
    }
    for (const wake of this.wakers.values()) wake();
  }

  /** Sweep everything now: server loops skip their wait (and any backoff), browsers get their next searches straight away. */
  sweepNow() {
    for (const st of this.state.values()) { st.fails = 0; st.browserNext = 0; st.slowUntil = 0; }
    for (const wake of this.wakers.values()) wake();
  }

  async loop(id) {
    this.loops.add(id);
    try {
      while (this.running) {
        const r = this.retailers.get(id);
        if (this.modeFor(r) !== 'server') break;
        const st = this.stat(id);
        const term = this.nextTerm(r);
        await this.sweepTerm(r, term).catch((e) => this.record(r, term, { ok: false, source: 'server', error: e.message }));
        const wait = this.waitFor(st, this.settings.everySeconds * 1000, { jitter: true });
        st.nextAt = this.now() + wait;
        await this.sleep(id, wait);
      }
    } finally {
      this.loops.delete(id);
      this.wakers.delete(id);
    }
  }

  /** How long a store waits before its next search: the set pace (±20%), slower for a while after a refusal, doubling after each failure. */
  waitFor(st, every, { jitter = false } = {}) {
    if (st.fails) return Math.min(MAX_BACKOFF_MS, every * 2 ** Math.min(st.fails, 10));
    const slow = st.slowUntil > this.now() ? SLOW_FACTOR : 1;
    return every * slow * (jitter ? 0.8 + 0.4 * this.random() : 1);
  }

  sleep(id, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      t.unref?.();
      function done() { clearTimeout(t); resolve(); }
      this.wakers.set(id, done);
    });
  }

  // ---------------------------------------------------------------------------
  // Admins' browsers (the extension), for stores that refuse servers
  // ---------------------------------------------------------------------------
  /** The next search at each store swept from browsers, for an admin's browser. Two admins' browsers share them. */
  browserDue(user) {
    if (!user || user.role !== 'admin') return { terms: [], waitMs: null };
    const now = this.now();
    const every = this.settings.browserEverySeconds * 1000;
    const terms = [];
    let next = null;
    for (const { retailer: r, mode } of this.stores()) {
      if (mode !== 'browser') continue;
      const st = this.stat(r.id);
      if (st.browserNext > now) { next = Math.min(next ?? Infinity, st.browserNext); continue; }
      const term = this.nextTerm(r);
      st.browserNext = now + this.waitFor(st, every);
      st.nextAt = st.browserNext;
      next = Math.min(next ?? Infinity, st.browserNext);
      terms.push(serialize({
        store: r.id, keyword: term.keyword, page: term.page, url: this.urlFor(r, term.keyword, term.page), parser: r.sweep.parser,
        productPath: r.productPath || null, skuFromPath: r.skuFromPath || null, storeName: r.name,
      }));
    }
    return { terms, waitMs: next === null ? null : Math.max(1000, next - now) };
  }

  /** What an admin's browser found. Only admins' browsers can change the shared feed. */
  async browserResults(user, results) {
    if (!user || user.role !== 'admin' || !Array.isArray(results)) return [];
    const out = [];
    for (const res of results.slice(0, 10)) {
      if (!res || typeof res !== 'object') continue;
      const r = this.retailers.get(str(res.store, 40));
      if (!r || this.modeFor(r) !== 'browser') continue;
      const keyword = this.settings.keywords.find((k) => k === res.keyword);
      if (!keyword) continue;
      const term = { keyword, page: num(res.page, { min: 1, max: 10, int: true, def: 1 }) };
      const url = this.urlFor(r, term.keyword, term.page);
      const ms = num(res.ms, { min: 0, max: 120000, int: true, def: null });
      if (!res.ok) {
        const status = num(res.status, { min: 0, max: 999, int: true, def: 0 });
        const refused = !!res.blocked || [401, 403, 429, 503].includes(status);
        out.push(this.record(r, term, {
          ok: false, blocked: refused, url, source: 'browser', ms,
          error: refused ? `The store refused the admin's browser${status ? ` (HTTP ${status})` : ''} — backing off` : str(res.error, 200) || (status ? `HTTP ${status}` : "The admin's browser couldn't read the page"),
        }));
        continue;
      }
      const products = (Array.isArray(res.products) ? res.products : []).slice(0, 300).map((p) => this.cleanProduct(r, p)).filter(Boolean);
      const problem = ['blocked', 'layout', 'empty'].includes(res.problem) ? res.problem : null;
      out.push(await this.ingest(r, term, { products, total: null, problem }, { source: 'browser', url, ms }));
    }
    return out;
  }

  cleanProduct(r, p) {
    if (!p || typeof p !== 'object') return null;
    const sku = str(p.sku, 80);
    const title = str(p.title, 200);
    if (!sku || title.length < 4) return null;
    const onStore = (v) => {
      const s = str(v, 2000);
      if (!s) return '';
      try {
        const u = new URL(s);
        const owner = this.retailers.forUrl(u);
        return /^https?:$/.test(u.protocol) && owner && owner.id === r.id ? u.href : '';
      } catch { return ''; }
    };
    const price = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100000 ? v : null);
    const image = str(p.image, 1000);
    return {
      sku, title, aliases: (Array.isArray(p.aliases) ? p.aliases : []).slice(0, 3).map((a) => str(a, 80)).filter(Boolean),
      price: price(p.price), wasPrice: price(p.wasPrice), inStock: typeof p.inStock === 'boolean' ? p.inStock : null, preorder: p.preorder === true,
      url: onStore(p.url), image: /^https:\/\//.test(image) ? image : '', marketplace: p.marketplace === true,
    };
  }

  // ---------------------------------------------------------------------------
  // For the dashboard
  // ---------------------------------------------------------------------------
  /** Searches in the last hour, all stores together. */
  summary() {
    const since = this.now() - HOUR;
    let requests = 0;
    let ok = 0;
    for (const st of this.state.values()) {
      for (const x of st.log) if (x.at >= since) { requests += 1; if (x.ok) ok += 1; }
    }
    return { sweeps1h: requests, sweepsOk1h: ok };
  }

  health() {
    const now = this.now();
    return this.stores().map(({ retailer: r, mode }) => {
      const st = this.stat(r.id);
      const recent = st.log.filter((x) => x.at >= now - HOUR);
      const ok = recent.filter((x) => x.ok);
      const timed = ok.filter((x) => typeof x.ms === 'number');
      const terms = this.db.all('SELECT * FROM sweep_terms WHERE store = :s ORDER BY keyword, page', { s: r.id });
      const products = this.db.get('SELECT COUNT(*) AS n FROM products WHERE store = :s AND sweep_seen_at >= :since', { s: r.id, since: now - 24 * HOUR });
      return {
        store: r.id, name: r.name, mode, defaultMode: r.demo ? 'off' : r.sweep.from || 'server', demo: !!r.demo,
        running: mode === 'server' ? this.loops.has(r.id) : null,
        requests1h: recent.length, ok1h: ok.length, blocked1h: recent.filter((x) => x.blocked).length,
        avgMs: timed.length ? Math.round(timed.reduce((a, x) => a + x.ms, 0) / timed.length) : null,
        lastAt: st.lastAt, lastOkAt: st.lastOkAt, lastError: st.lastError, fails: st.fails, nextAt: mode === 'off' ? null : st.nextAt,
        slowedUntil: st.slowUntil > now ? st.slowUntil : null,
        products24h: products ? products.n : 0,
        terms: terms.map((t) => ({ keyword: t.keyword, page: t.page, url: t.url, source: t.source, lastAt: t.last_at, lastOkAt: t.last_ok_at, found: t.found, kept: t.kept, total: t.total, fails: t.fails, error: t.error, ms: t.ms, baselineAt: t.baseline_at })),
      };
    });
  }
}
