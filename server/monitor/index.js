// Restock monitor for everyone's watchlists, by SKU.
//
// Server checks: each page is checked once per interval however many people
// watch it (a popular SKU doesn't mean more requests to the store), with a
// minimum gap between requests to the same store. Requests identify
// themselves honestly as Mugibot. A SKU without a product link yet is looked
// for on the store's search page ("Not listed yet" until it appears).
//
// In-browser checks: some stores refuse requests from servers (Kmart does).
// For those, a member's own browser — with the extension — re-checks that
// member's own SKUs about once a minute, the same as refreshing the page
// yourself. Those results only ever update that member's own watchlist.
// If a store shows a bot check, Mugibot backs off; it never tries to get
// past bot protection.
//
// Every item keeps its own status, so each member gets their own alert when
// their SKU goes from out of stock (or not listed) to in stock / pre-order.
//
// The live sweeps (sweep.js) search each store every few seconds and update
// members' SKUs they come across straight away; while a sweep has seen a SKU
// lately, these slower checks leave it alone.

import { PRODUCTS_FOR_PAGE } from '../catalog.js';
import { ENTITLED_SQL } from '../repo.js';
import { DEFAULT_ALERTS } from '../schema.js';
import { serialize } from '../retailers/index.js';
import { CART_LINK, cartLines } from '../retailers/shoplink.js';
import { extractProduct, extractProductLinks } from './extract.js';
import { parseListing } from './listing.js';
import { SWEEP_FRESH_MS } from './feed.js';
import { BlockedUrlError, safeFetch } from './safeurl.js';
import { STATUS, isOrderable } from './status.js';
import { gateOnPage } from './gate.js';
import { olderVersion } from './sweep.js';

const MAX_BACKOFF_MS = 30 * 60 * 1000;
// The oldest extension that reads a store's page by opening it in its window (monitor.render: BIG W's).
export const RENDER_EXTENSION_VERSION = '1.27.0';
const FAILED = new Set([STATUS.BLOCKED, STATUS.ERROR]);
const KNOWN = new Set(Object.values(STATUS));

// An armed item's page (Auto-checkout): checked this far ahead of its turn at its store.
const ARMED_AHEAD_MS = 15 * 1000;
const ITEMS_FOR_PAGE = `(c.kind = 'product' AND i.url = c.url) OR (c.kind = 'search' AND i.url = '' AND i.store = c.store AND i.sku = c.sku COLLATE NOCASE)`;

/**
 * Alerts waiting to go out (members' DMs, webhooks, emails): a few at a time — each member's own
 * arrives in a fraction of a second, not after everyone before them has had theirs. A failed one is
 * logged and the rest still go.
 */
export async function sendAll(list, onError, atOnce = 5) {
  let next = 0;
  const lane = async () => {
    while (next < list.length) {
      const send = list[next++];
      await Promise.resolve().then(send).catch(onError);
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, list.length) }, lane));
}

/** Does this link's path contain the SKU (as a whole code, not part of a longer number)? */
export function pathHasSku(url, sku) {
  let p;
  try { p = decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch { return false; }
  const s = String(sku || '').toLowerCase();
  if (!s) return false;
  // A number must not run into more digits; a code must not run into more letters or digits.
  const edge = /^\d+$/.test(s) ? /\d/ : /[a-z0-9]/;
  for (let i = p.indexOf(s); i >= 0; i = p.indexOf(s, i + 1)) {
    if (!edge.test(p[i - 1] || '') && !edge.test(p[i + s.length] || '')) return true;
  }
  return false;
}

export class Monitor {
  constructor({ cfg, repo, retailers, notifier, hub, catalog, feed, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { cfg, repo, retailers, notifier, hub, catalog, feed, fetch: fetchImpl, now });
    this.db = repo.db;
    this.hostNext = new Map();
    this.hostBusy = new Map(); // host → checks still going there
    this.hostGap = new Map(); // host → its gap between checks (seconds)
    this.inFlight = new Set();
    this.timer = null;
    this.ticks = 0;
    this.lastTickAt = null;
  }

  start() {
    this.forgetServerFailures();
    if (this.timer || !this.cfg.monitor.enabled) return;
    this.timer = setInterval(() => { this.tick().catch((e) => this.cfg.log('[monitor]', e.message)); }, this.cfg.monitor.tickMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A store the server never asks (monitor.server 'never': BIG W, which resets every server's connection; EB Games,
   * whose Cloudflare turns every server away):
   * what the server's own tries said there — "Error", on every BIG W watchlist item — is forgotten, for
   * members' browsers (and the live searches) to say instead. "Checking soon" meanwhile.
   */
  forgetServerFailures() {
    const stores = this.retailers.list.filter((r) => r.monitor && r.monitor.server === 'never').map((r) => r.id);
    if (!stores.length) return;
    const list = stores.map((_, i) => `:s${i}`).join(', ');
    const args = Object.fromEntries(stores.map((s, i) => [`s${i}`, s]));
    this.db.run(`UPDATE items SET status = 'pending', error = '', browser_next_at = 0 WHERE store IN (${list}) AND status IN ('error', 'blocked') AND (status_source IS NULL OR status_source = 'server')`, args);
    this.db.run(`UPDATE products SET status = 'pending', error = '', fail_count = 0 WHERE store IN (${list}) AND status IN ('error', 'blocked') AND (status_source IS NULL OR status_source = '' OR status_source = 'server')`, args);
  }

  get interval() {
    return this.cfg.monitor.urlIntervalSeconds * 1000;
  }

  /**
   * How often to check a page: the default for members' SKUs, or the shortest interval a
   * monitor on it asks for (never below MONITOR_MIN_INTERVAL).
   */
  pageInterval(url) {
    // A store whose items are checked more often (Shop checkout links: what they're for goes in moments).
    const r = this.retailers.forUrl(url);
    const own = r && r.monitor && r.monitor.intervalSeconds ? Math.max(r.monitor.floorSeconds ?? this.cfg.monitor.minIntervalSeconds, r.monitor.intervalSeconds) * 1000 : Infinity;
    const m = this.db.get(`SELECT MIN(COALESCE(m.interval_seconds, :def)) AS s, COUNT(*) AS n FROM products p JOIN monitors m ON m.product_id = p.id, page_checks c
      WHERE c.url = :url AND m.paused = 0 AND ${PRODUCTS_FOR_PAGE}`, { url, def: this.cfg.monitor.urlIntervalSeconds });
    if (!m || !m.n) return Math.min(own, this.interval);
    // Members watching the same page still get it checked at the default interval.
    const members = this.db.get(`SELECT 1 AS y FROM items i, page_checks c WHERE c.url = :url AND (${ITEMS_FOR_PAGE}) AND i.monitor = 1 LIMIT 1`, { url });
    const s = members ? Math.min(m.s, this.cfg.monitor.urlIntervalSeconds) : m.s;
    // A VIP drop's page (monitor/vip.js): every few seconds around its drop time.
    const vip = this.vip ? this.vip.pageSeconds(url) : null;
    return Math.min(own, vip ? vip * 1000 : Infinity, Math.max(this.cfg.monitor.minIntervalSeconds, s) * 1000);
  }

  get browserInterval() {
    return this.cfg.monitor.browserIntervalSeconds * 1000;
  }

  // -------------------------------------------------------------------------
  // Server checks
  // -------------------------------------------------------------------------
  async tick() {
    const now = this.now();
    this.lastTickAt = now;
    if (this.ticks++ % 300 === 0) {
      // Forget pages nobody watches any more (members' SKUs and monitors), and old log lines.
      const monitored = `EXISTS (SELECT 1 FROM products p JOIN monitors m ON m.product_id = p.id, page_checks c WHERE c.url = page_checks.url AND ${PRODUCTS_FOR_PAGE})`;
      this.db.run(`DELETE FROM page_checks WHERE kind = 'product' AND NOT EXISTS (SELECT 1 FROM items i WHERE i.url = page_checks.url) AND NOT ${monitored}`);
      this.db.run(`DELETE FROM page_checks WHERE kind = 'search' AND NOT EXISTS (SELECT 1 FROM items i WHERE i.url = '' AND i.store = page_checks.store AND i.sku = page_checks.sku COLLATE NOCASE) AND NOT ${monitored}`);
      this.catalog.prune(this.cfg.monitor.logDays);
    }
    // Stores that can't be asked this second (inside their gap between checks, or — with a gap — a check still going)
    // are left out of the list, so one store's long list never keeps another store's pages waiting. Oldest first
    // within a store, an armed item's page 15 seconds ahead of its place (its restock starts members' checkouts).
    const wait = [...this.hostNext].filter(([, t]) => t > now).map(([h]) => h);
    for (const [h, n] of this.hostBusy) if (n > 0 && (this.hostGap.get(h) || 0) > 0 && !wait.includes(h)) wait.push(h);
    const skip = wait.length ? `AND c.host NOT IN (${wait.map((_, i) => `:h${i}`).join(', ')})` : '';
    const due = this.db.all(`SELECT c.* FROM page_checks c
      WHERE c.next_check_at <= :now ${skip} AND (EXISTS (
        SELECT 1 FROM items i JOIN users u ON u.id = i.user_id
        WHERE (${ITEMS_FOR_PAGE}) AND i.monitor = 1 AND u.disabled = 0 AND ${ENTITLED_SQL})
        OR EXISTS (SELECT 1 FROM products p JOIN monitors m ON m.product_id = p.id WHERE m.paused = 0 AND ${PRODUCTS_FOR_PAGE}))
      ORDER BY c.next_check_at - CASE WHEN EXISTS (SELECT 1 FROM items i WHERE (${ITEMS_FOR_PAGE}) AND i.aco = 1 AND i.monitor = 1) THEN ${ARMED_AHEAD_MS} ELSE 0 END
      LIMIT 50`, { now, ...Object.fromEntries(wait.map((h, i) => [`h${i}`, h])) });
    const jobs = [];
    for (const page of due) {
      if (this.sweptLately(page.url, now)) {
        // A live sweep has just seen this product: no need to fetch its page as well.
        this.db.run('UPDATE page_checks SET next_check_at = :next WHERE url = :url', { url: page.url, next: now + this.pageInterval(page.url) });
        continue;
      }
      const retailer = this.retailers.get(page.store) || this.retailers.forUrl(page.url);
      if (retailer && !this.retailers.settings(retailer).serverChecks) {
        // Switched off by an admin: members' browsers check these instead.
        this.db.run("UPDATE page_checks SET next_check_at = :next, error = 'Server checks are off for this store' WHERE url = :url", { url: page.url, next: now + 10 * 60 * 1000 });
        continue;
      }
      if (this.inFlight.has(page.url) || this.inFlight.size >= 4) continue;
      if ((this.hostNext.get(page.host) || 0) > now) continue;
      const gap = (retailer && retailer.monitor && retailer.monitor.hostGapSeconds) || this.cfg.monitor.hostGapSeconds;
      // (One check at a time at a store with a gap: a store slow to answer holds one of the four, never all of them.)
      if (gap > 0 && (this.hostBusy.get(page.host) || 0) > 0) continue;
      this.hostNext.set(page.host, now + gap * 1000);
      this.hostGap.set(page.host, gap);
      this.hostBusy.set(page.host, (this.hostBusy.get(page.host) || 0) + 1);
      this.inFlight.add(page.url);
      jobs.push(this.checkPage(page.url).finally(() => {
        this.inFlight.delete(page.url);
        const n = (this.hostBusy.get(page.host) || 1) - 1;
        if (n > 0) this.hostBusy.set(page.host, n); else this.hostBusy.delete(page.host);
      }));
    }
    await Promise.all(jobs);
    return jobs.length;
  }

  /** Has a live sweep seen what's on this product page in the last few minutes (the shared product, or members' SKUs)? */
  sweptLately(url, now) {
    // (A VIP drop's page is always read: its stock is what decides, and every second counts.)
    if (this.vip && this.vip.pageSeconds(url, now)) return false;
    const since = now - SWEEP_FRESH_MS;
    const product = this.db.get("SELECT 1 AS y FROM products WHERE url = :url AND sweep_seen_at >= :since AND status_source = 'sweep' LIMIT 1", { url, since });
    if (product) return true;
    const items = this.db.get(`SELECT COUNT(*) AS n, SUM(CASE WHEN status_source = 'sweep' AND checked_at >= :since THEN 1 ELSE 0 END) AS swept
      FROM items WHERE url = :url AND monitor = 1`, { url, since });
    return !!items && items.n > 0 && items.swept === items.n;
  }

  headers() {
    return { 'user-agent': this.cfg.monitor.userAgent, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-AU,en;q=0.9' };
  }

  get(target) {
    return safeFetch(this.fetch, target, { headers: this.headers(), signal: AbortSignal.timeout(this.cfg.monitor.timeoutMs) }, { allowPrivate: this.cfg.monitor.allowPrivateHosts });
  }

  /** A product page's stock status (Shopify's product JSON first, for Shopify stores). */
  async read(url, retailer) {
    const u = new URL(url);
    const lines = retailer && retailer.cartLinks ? cartLines(u.pathname) : null;
    if (lines) return this.readCartLink(u, lines);
    // A store whose pages turn servers away, looked up at its search provider by the product's code (Kmart's).
    const code = retailer && retailer.monitor && retailer.monitor.lookup && retailer.skuFromPath ? (u.pathname.match(retailer.skuFromPath) || [])[1] : null;
    if (code) return this.lookup(retailer, code);
    if (/\/products\/[^/]+\/?$/.test(u.pathname) && (!retailer || retailer.platform === 'shopify' || retailer.id === 'other')) {
      try {
        const res = await this.get(`${u.origin}${u.pathname.replace(/\/$/, '')}.js`);
        if (res.ok && /json|javascript/.test(res.headers.get('content-type') || '')) {
          const p = await res.json();
          if (p && Array.isArray(p.variants)) {
            const avail = p.variants.some((v) => v.available);
            const v = p.variants.find((x) => x.available) || p.variants[0];
            let image = p.featured_image || (Array.isArray(p.images) && p.images[0]) || null;
            if (image && typeof image === 'object') image = image.src || null;
            if (typeof image === 'string' && image.startsWith('//')) image = `https:${image}`;
            return {
              status: avail ? STATUS.IN_STOCK : STATUS.OUT_OF_STOCK, title: p.title || null, price: v && typeof v.price === 'number' ? v.price / 100 : null,
              image: typeof image === 'string' ? image : null, variantId: v && v.id ? String(v.id) : null, decidedBy: 'shopify-json',
            };
          }
        }
        // (A Shopify store's product that's gone. At another website it may just not be Shopify: its page says.)
        if (res.status === 404 && retailer && retailer.id !== 'other') return { status: STATUS.NOT_FOUND };
      } catch (e) {
        if (e instanceof BlockedUrlError) throw e;
        /* fall back to the page */
      }
    }
    const res = await this.get(url);
    if (res.status === 404 || res.status === 410) return { status: STATUS.NOT_FOUND };
    if (res.status === 403 || res.status === 429 || res.status === 503) return { status: STATUS.BLOCKED, error: `The store refused the server check (HTTP ${res.status})` };
    if (!res.ok) return { status: STATUS.ERROR, error: `HTTP ${res.status}` };
    const html = (await res.text()).slice(0, 3_000_000);
    const queued = this.gateSeen(retailer, res.url || url, html);
    if (queued) return queued;
    const r = extractProduct(html, { url, hints: (retailer && retailer.hints) || {} });
    let image = r.image || null;
    try { if (image) image = new URL(image, url).href; } catch { image = null; }
    return { status: r.status, title: r.title, price: r.price, image, decidedBy: r.decidedBy, error: r.blocked ? 'The store showed a bot check instead of the page' : '' };
  }

  /**
   * A Shop checkout link (retailers/shoplink.js): each option in it, as the store's own pages ask about
   * it (/variants/<id>.js) — in stock when every one of them can be bought. Its price: the link's
   * (each option's price times its quantity); its name: the options'.
   */
  async readCartLink(u, lines) {
    const prefix = u.pathname.match(CART_LINK)[1];
    const names = [];
    let price = 0;
    let image = null;
    let gone = false;
    for (const line of lines) {
      const res = await this.get(`${u.origin}${prefix}/variants/${line.id}.js`);
      if (res.status === 404 || res.status === 410) return { status: STATUS.NOT_FOUND, error: `Option ${line.id} in the link isn't at the store any more` };
      if (res.status === 403 || res.status === 429 || res.status === 503) return { status: STATUS.BLOCKED, error: `The store refused the server check (HTTP ${res.status})` };
      if (!res.ok) return { status: STATUS.ERROR, error: `HTTP ${res.status}` };
      const v = await res.json().catch(() => null);
      if (!v || typeof v.available !== 'boolean') return { status: STATUS.ERROR, error: "The store's answer wasn't about an option it sells" };
      if (!v.available) gone = true;
      if (typeof v.price === 'number') price += (v.price / 100) * line.qty;
      names.push(`${String(v.name || v.title || line.id).slice(0, 80)}${line.qty > 1 ? ` ×${line.qty}` : ''}`);
      const img = v.featured_image && typeof v.featured_image === 'object' ? v.featured_image.src : v.featured_image;
      if (!image && typeof img === 'string') image = img.startsWith('//') ? `https:${img}` : img;
    }
    return { status: gone ? STATUS.OUT_OF_STOCK : STATUS.IN_STOCK, title: names.join(' + ').slice(0, 200), price: Math.round(price * 100) / 100, image, decidedBy: 'shopify-variant' };
  }

  /**
   * The store's virtual queue (or checkpoint) where its page should be (monitor/gates.js): the server
   * saw it — and the check tells nothing about the product (never read as its stock).
   */
  gateSeen(retailer, url, html) {
    if (!retailer || !retailer.gate || !gateOnPage(retailer.gate, { url, html })) return null;
    if (this.gates) this.gates.observe(retailer.id, 'up', { source: 'server' });
    return { status: STATUS.BLOCKED, error: `${retailer.name}'s ${retailer.gate.kind === 'queue' ? 'virtual queue' : 'checkpoint'} was there instead of the page` };
  }

  /**
   * One product at a store whose pages turn servers away, looked up by its code at the search provider its own pages
   * ask (retailer monitor.lookup: Kmart's Constructor.io) — its stock, price and picture as the store shows them, and
   * its link (for a SKU with none yet). Not there: not listed (yet).
   */
  async lookup(retailer, sku) {
    const how = retailer.monitor.lookup;
    const res = await this.get(`${(retailer.sweep && retailer.sweep.apiBase) || retailer.base}${how.path.replace('{sku}', encodeURIComponent(sku))}`);
    if (res.status === 403 || res.status === 429 || res.status === 503) return { status: STATUS.BLOCKED, error: `The store's search provider refused the server check (HTTP ${res.status})` };
    if (!res.ok) return { status: STATUS.ERROR, error: `HTTP ${res.status}` };
    const parsed = parseListing(how.parser, (await res.text()).slice(0, 3_000_000), { base: retailer.base, storeBase: retailer.base });
    if (parsed.problem) return { status: STATUS.ERROR, error: "The store's search provider didn't answer with its product list" };
    const p = parsed.products.find((x) => String(x.sku) === String(sku));
    if (!p) return { status: STATUS.NOT_LISTED };
    const status = p.inStock === true ? (p.inStoreOnly ? STATUS.IN_STORE : p.preorder ? STATUS.PREORDER : STATUS.IN_STOCK) : STATUS.OUT_OF_STOCK;
    return { status, title: p.title || null, price: p.price ?? null, image: p.image || null, foundUrl: p.url || null, decidedBy: 'lookup' };
  }

  /** Look for a SKU on the store's search page. */
  async readSearch(page, retailer) {
    // (A store whose products are looked up by code: the lookup says where its page is.)
    if (retailer && retailer.monitor && retailer.monitor.lookup) {
      const r = await this.lookup(retailer, page.sku);
      return r.foundUrl ? { status: STATUS.NOT_LISTED, foundUrl: r.foundUrl, title: r.title } : { status: r.status === STATUS.NOT_LISTED ? STATUS.NOT_LISTED : r.status, error: r.error || '' };
    }
    const res = await this.get(page.url);
    if (res.status === 404 || res.status === 410) return { status: STATUS.NOT_LISTED };
    if (res.status === 403 || res.status === 429 || res.status === 503) return { status: STATUS.BLOCKED, error: `The store refused the server check (HTTP ${res.status})` };
    if (!res.ok) return { status: STATUS.ERROR, error: `HTTP ${res.status}` };
    const html = (await res.text()).slice(0, 3_000_000);
    const finalUrl = res.url || page.url;
    const queued = this.gateSeen(retailer, finalUrl, html);
    if (queued) return queued;
    // Some stores send a search for an exact code straight to the product page.
    if (retailer && retailer.productPath && retailer.productPath.test(new URL(finalUrl).pathname) && pathHasSku(finalUrl, page.sku)) {
      return { status: STATUS.NOT_LISTED, foundUrl: finalUrl };
    }
    const links = extractProductLinks(html, finalUrl, (retailer && retailer.productPath) || /\/(product|products|p)\//i);
    const hit = links.find((l) => pathHasSku(l.url, page.sku));
    if (hit) return { status: STATUS.NOT_LISTED, foundUrl: hit.url, title: hit.name };
    const ex = extractProduct(html, { url: finalUrl });
    if (ex.blocked) return { status: STATUS.BLOCKED, error: 'The store showed a bot check instead of the page' };
    return { status: STATUS.NOT_LISTED };
  }

  async checkPage(url) {
    const prev = this.db.get('SELECT * FROM page_checks WHERE url = :url', { url });
    if (!prev) return null;
    const retailer = this.retailers.get(prev.store) || this.retailers.forUrl(url);
    let r;
    const started = Date.now();
    try {
      r = prev.kind === 'search' ? await this.readSearch(prev, retailer) : await this.read(url, retailer);
    } catch (e) {
      r = { status: STATUS.ERROR, error: e instanceof BlockedUrlError ? e.message : e.name === 'TimeoutError' ? 'The store took too long to answer' : "Couldn't reach the store" };
    }
    const ms = Date.now() - started;
    const now = this.now();
    const failed = FAILED.has(r.status);
    const failCount = failed ? prev.fail_count + 1 : 0;
    const interval = this.pageInterval(url);
    const next = now + (failed ? Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(failCount, 6)) : interval);
    if (failed) this.cfg.log(JSON.stringify({ evt: 'monitor.check_failed', store: prev.store, url, status: r.status, error: r.error || '', fails: failCount, ms }));
    // A failed check keeps the last known stock status (so a block doesn't look like a restock later).
    const status = failed && prev.status && !FAILED.has(prev.status) && failCount < 3 ? prev.status : r.status;
    this.db.run(`UPDATE page_checks SET status = :status, title = COALESCE(:title, title), price = COALESCE(:price, price), signals = :sig,
      checked_at = :now, next_check_at = :next, fail_count = :fails, error = :err, found_url = COALESCE(:found, found_url) WHERE url = :url`,
    { url, status, title: r.title || null, price: r.price ?? null, sig: r.decidedBy || null, now, next, fails: failCount, err: r.error || '', found: r.foundUrl || null });

    // Members watching this page: each armed one's Auto-checkout run first; their alerts once the feed's are out.
    const later = [];
    const items = prev.kind === 'search' && r.foundUrl ? [] : this.db.all(`SELECT i.* FROM items i JOIN users u ON u.id = i.user_id, page_checks c
      WHERE c.url = :url AND (${ITEMS_FOR_PAGE}) AND i.monitor = 1 AND u.disabled = 0 AND ${ENTITLED_SQL}`, { url, now });
    await this.applyAll(items, { status, title: r.title || null, price: r.price ?? null, error: r.error || '' }, 'server', { later });
    try {
      // The shared feed: every monitored product on this page.
      for (const product of this.catalog.productsForPage(url)) {
        if (prev.kind === 'search' && r.foundUrl) continue;
        // What this check really saw: the feed keeps the last confirmed status itself.
        await this.feed.applyCheck(product, { status: r.status, title: r.title || null, price: r.price ?? null, image: r.image || null, variantId: r.variantId || null, error: r.error || '' }, { source: 'server', url, ms });
        // A VIP or drop watch waiting to see whether this is on sale yet (monitor/vip.js, monitor/drops.js).
        if (this.vip) this.vip.checked(this.catalog.productById(product.id));
        if (this.drops) this.drops.checked(this.catalog.productById(product.id));
      }
    } finally {
      // (Even when the shared feed's failed.)
      await sendAll(later, (e) => this.cfg.log('[alerts]', e.message));
    }
    if (prev.kind === 'search' && r.foundUrl) {
      this.resolveSku(prev.store, prev.sku, r.foundUrl);
      return { status: 'found', url: r.foundUrl };
    }
    return { status, previous: prev.status };
  }

  /** The product page for a SKU has been found: every item waiting for it gets the link. */
  resolveSku(store, sku, foundUrl, userId = null) {
    const where = `url = '' AND store = :s AND sku = :k COLLATE NOCASE${userId ? ' AND user_id = :u' : ''}`;
    const waiting = this.db.all(`SELECT id, user_id FROM items WHERE ${where}`, { s: store, k: sku, u: userId });
    // Status stays "not listed" until the product page itself is read, so that read counts as "listed".
    this.db.run(`UPDATE items SET url = :url, status = 'not_listed', updated_at = :t, browser_next_at = 0 WHERE ${where}`, { url: foundUrl, s: store, k: sku, u: userId, t: this.now() });
    if (!userId) this.catalog.resolveProduct(store, sku, foundUrl);
    this.repo.ensurePage(foundUrl, 'product', store, sku);
    this.db.run('UPDATE page_checks SET next_check_at = 0 WHERE url = :url', { url: foundUrl });
    for (const w of waiting) this.hub.publish(w.user_id, 'watch', { id: w.id, url: foundUrl });
    return waiting.length;
  }

  // -------------------------------------------------------------------------
  // One item's new status → its owner's alerts
  // -------------------------------------------------------------------------
  /**
   * One store answer for everyone watching it: armed items first, and every member's Auto-checkout run
   * made before anyone's alerts go out (then a few at a time: sendAll) — in a drop, the tenth member's
   * run doesn't wait on nine members' DMs. later: the caller's list to put the alerts on instead (a
   * search's: sent once its channel alerts are out — sweep.js).
   */
  async applyAll(items, r, source, { later: theirs = null } = {}) {
    const later = theirs || [];
    const order = [...items].sort((a, b) => (b.aco ? 1 : 0) - (a.aco ? 1 : 0));
    for (const item of order) await this.applyResult(item, r, source, { later });
    if (!theirs) await sendAll(later, (e) => this.cfg.log('[alerts]', e.message));
  }

  /** later: a list to put this item's alerts on (sent by the caller), instead of sending them now. */
  async applyResult(item, r, source, { later = null } = {}) {
    const now = this.now();
    const prev = item.status;
    const failed = FAILED.has(r.status);
    if (source !== 'sweep' && item.status_source === 'sweep' && item.checked_at && now - item.checked_at < SWEEP_FRESH_MS) return prev;
    if (source === 'server' && failed && item.status_source === 'browser' && item.browser_checked_at && now - item.browser_checked_at < 3 * this.browserInterval) {
      // The member's browser is doing the checking for this store; keep what it saw.
      return prev;
    }
    let status = r.status;
    if (source === 'browser' && failed && prev && !FAILED.has(prev) && prev !== 'pending' && item.browser_fails < 2) status = prev;
    // A drop watch's find whose stock wasn't known (monitor/drops.js): its first read is how it is,
    // not a change — and a failed read leaves it not known.
    const firstRead = prev === STATUS.UNKNOWN && !!item.drop_watch;
    if (firstRead && failed) status = prev;
    const changed = status !== prev;
    const error = r.error || '';
    this.db.run(`UPDATE items SET status = :st, status_source = :src, status_at = CASE WHEN :changed = 1 THEN :now ELSE status_at END, checked_at = :now,
        title = COALESCE(:title, title), last_price = COALESCE(:price, last_price), error = :err WHERE id = :id`,
    { id: item.id, st: status, src: source, changed: changed ? 1 : 0, now, title: r.title || null, price: r.price ?? null, err: error });
    if (changed || error !== (item.error || '')) {
      this.hub.publish(item.user_id, 'watch', { id: item.id, status, source, checkedAt: now, price: r.price ?? item.last_price, error });
    }
    // Your own drop watch's find — at any store or website: its price going down is news too (monitor/drops.js).
    // (With the other alerts, after every member's Auto-checkout run is made: applyAll.)
    if (item.drop_watch && this.drops && !failed && typeof r.price === 'number') {
      const drop = () => this.drops.priceDropped(item, r.price, status).catch((e) => this.cfg.log('[drops]', e.message));
      if (later) later.push(drop);
      else await drop();
    }
    if (!changed) return status;
    const fresh = { ...item, status, last_price: r.price ?? item.last_price, title: r.title || item.title };
    if (firstRead) {
      if (this.drops) this.drops.firstRead(fresh, status);
      return status;
    }
    if (isOrderable(status) && !isOrderable(prev)) {
      await this.alertRestock(fresh, { status, price: r.price ?? item.last_price, source, wasListed: prev !== STATUS.NOT_LISTED, later, variantId: r.variantId || null });
    } else if (prev === STATUS.NOT_LISTED && ![STATUS.NOT_LISTED, STATUS.BLOCKED, STATUS.ERROR, STATUS.NOT_FOUND, 'pending'].includes(status)) {
      const dm = () => this.notifier.itemAlert(item.user_id, fresh, 'listed', { status, price: r.price ?? item.last_price });
      if (later) later.push(dm);
      else await dm();
    } else if (isOrderable(prev) && !failed) {
      this.repo.addEvent(item.user_id, { type: 'restock', level: 'info', message: `${item.name} is now ${status.replace(/_/g, ' ')}`, name: item.name, sku: item.sku, url: item.url || null });
    }
    return status;
  }

  /** later: a list to put the alerts on (applyAll sends them once every member's run is made), instead of sending them now. */
  async alertRestock(item, { status, price, source, manual = false, note = '', later = null, variantId = null }) {
    if (item.max_price !== null && item.max_price !== undefined && typeof price === 'number' && price > item.max_price) {
      this.repo.addEvent(item.user_id, { type: 'restock', level: 'info', message: `${item.name} is available but $${price.toFixed(2)} is over your limit of $${item.max_price.toFixed(2)}`, name: item.name, sku: item.sku, url: item.url || null });
      await this.autoCheckout(item, { status, price, source, manual, later }); // (armed: kept as "skipped, over your max")
      return false;
    }
    this.db.run('UPDATE items SET last_alert_at = :now WHERE id = :id', { now: this.now(), id: item.id });
    // Armed for Auto-checkout (server/aco.js): the member's browser starts checking out straight away.
    await this.autoCheckout(item, { status, price, source, manual, later, variantId });
    const tell = async () => {
      await this.notifier.itemAlert(item.user_id, item, 'restock', { status, price, source, manual, note });
      if (item.announce) {
        const owner = this.repo.userById(item.user_id);
        if (owner && owner.role === 'admin') await this.announce(item, { status, price, manual, note });
      }
    };
    if (later) later.push(tell);
    else await tell();
    return true;
  }

  async autoCheckout(item, info) {
    if (!this.aco || !item.aco) return null;
    try {
      return await this.aco.trigger(item, info);
    } catch (e) {
      this.cfg.log('[aco]', e.message);
      return null;
    }
  }

  /** An admin's 📣 SKU restocked: post it in the Discord channels (through the feed, with its cooldown). */
  async announce(item, info) {
    const product = this.catalog.upsertProduct({ store: item.store, sku: item.sku, url: item.url, name: item.name });
    const fresh = this.catalog.updateProduct(product.id, { status: info.status || STATUS.IN_STOCK, ...(typeof info.price === 'number' ? { price: info.price } : {}) });
    const alert = await this.feed.alert(fresh, 'restock', { announce: true, note: info.note || '' });
    return !!(alert && alert.posted.length);
  }

  /** An admin says a SKU is in stock: ping everyone watching it (and the server channels). */
  async broadcastRestock({ store, sku, note = '', url = '', name = '' }) {
    const now = this.now();
    const items = this.db.all(`SELECT i.* FROM items i JOIN users u ON u.id = i.user_id
      WHERE i.store = :s AND i.sku = :k COLLATE NOCASE AND i.monitor = 1 AND u.disabled = 0 AND ${ENTITLED_SQL}`, { s: store, k: sku, now });
    let pinged = 0;
    for (const item of items) {
      if (await this.alertRestock({ ...item, announce: 0 }, { status: STATUS.IN_STOCK, price: item.last_price, source: 'manual', manual: true, note })) pinged += 1;
    }
    const sample = items[0] || { store, sku, name: name || sku, url };
    const product = this.catalog.upsertProduct({ store, sku, url: sample.url || url, name: name || sample.name });
    const fresh = this.catalog.updateProduct(product.id, { status: STATUS.IN_STOCK, status_source: 'manual', status_at: now });
    const alert = await this.feed.alert(fresh, 'restock', { manual: true, note });
    return { pinged, watchers: items.length, posted: !!(alert && alert.posted.length) };
  }

  // -------------------------------------------------------------------------
  // In-browser checks (the extension)
  // -------------------------------------------------------------------------
  /**
   * Which of this member's SKUs their browser should check now (and lease them so two browsers don't both do it).
   * through: stores whose virtual queue this browser has got through. A store whose queue is up is left alone
   * otherwise: a request there could cost the member their place in line (monitor/gates.js).
   * version: the extension's (a store read by opening its page — BIG W's — only by one that does: 1.27.0).
   * priv: it opens such a store's pages in a private window of its own (extension 1.36.0, allowed in Incognito).
   */
  browserDue(user, { through = new Set(), sites = new Set(), want = new Set(), version = null, priv = false } = {}) {
    const held = (store) => !!this.gates && this.gates.queueUp(store) && !through.has(store);
    const settings = { ...DEFAULT_ALERTS, ...(this.repo.getData(user.id, 'alerts', {}) || {}) };
    if (!settings.browserChecks) return [];
    const now = this.now();
    // (A store whose pages are opened in the browser's window to be read — BIG W's: one at a time, at its pace —
    //  and only by an extension that does: 1.27.0; an older one would ask for the page in the background, what
    //  got browsers turned away there. A browser that hasn't said its version is taken for an older one, and
    //  that store's items left out of its list altogether, for a browser that can.)
    // (…at the usual pace, and as many a round as there's room for, in a browser that opens them in its private window:
    //  apart from your own visits there, its bot protection taking Mugibot's reading for a bot never turns you away.)
    const fast = (r) => !!(priv && r && r.monitor && r.monitor.privateWindow);
    const pace = (r) => (r && r.monitor && r.monitor.browserSeconds && !fast(r) ? r.monitor.browserSeconds * 1000 : this.browserInterval);
    const render = (r) => !!(r && r.monitor && r.monitor.render);
    // (…in a private window of its own, where the browser allows it: BIG W's — apart from your own visits there.)
    const privateOf = (r) => (r && r.monitor && r.monitor.privateWindow ? { privateWindow: true } : {});
    // (A store whose bot protection refuses the extension's background requests — EB Games' Cloudflare — while its own
    //  pages' requests go through: asked for from inside a tab of the store, by an extension that does: 1.35.0 — an older
    //  one asks in the background, as before. A SKU with no link yet: looked up in the store's own search data there.)
    const askedIn = (r, sku, url) => {
      if (!(r && r.monitor && r.monitor.inPage)) return {};
      const data = !url && r.sweep && r.sweep.inPage && r.sweep.path ? `${r.base}${r.sweep.path.replace('{q}', encodeURIComponent(sku))}` : null;
      return { inPage: true, storeBase: r.base, ...(data ? { data, parser: r.sweep.parser } : {}) };
    };
    const cantRender = !version || olderVersion(version, RENDER_EXTENSION_VERSION);
    const unopened = cantRender ? this.retailers.list.filter(render).map((r) => r.id) : [];
    const notThese = unopened.length ? `AND i.store NOT IN (${unopened.map((_, n) => `:r${n}`).join(', ')})` : '';
    const rows = this.db.all(`SELECT i.*, c.status AS page_status, c.fail_count AS page_fails, c.checked_at AS page_checked, c.error AS page_error
      FROM items i LEFT JOIN page_checks c ON c.url = i.url AND i.url != ''
      WHERE i.user_id = :u AND i.monitor = 1 AND i.browser_next_at <= :now ${notThese} ORDER BY i.browser_next_at, i.position LIMIT 40`,
    { u: user.id, now, ...Object.fromEntries(unopened.map((id, n) => [`r${n}`, id])) });
    const out = [];
    const rendering = new Set();
    // (Left for later this round — BIG W's one page a round: its turn pushed back a little, so a long BIG W
    //  list never keeps the other stores' checks out of the round.)
    const later = (table, id) => this.db.run(`UPDATE ${table} SET browser_next_at = :n WHERE id = :id`, { n: now + this.browserInterval, id });
    for (const it of rows) {
      const r = this.retailers.get(it.store);
      const other = it.store === 'other';
      // (Not a Shop checkout link: opening it starts a checkout — the server asks the store about its options instead.)
      if (!r || r.cartLinks || !this.retailers.enabled(r) || held(it.store)) continue;
      // (Another website's page: only once it refuses the server, and where you've let the extension read that website.)
      if (other ? !it.url : !this.retailers.settings(r).browserChecks) continue;
      const serverOff = !this.retailers.settings(r).serverChecks;
      const serverStruggling = FAILED.has(it.page_status) || it.page_fails > 0 || /Server checks are off/.test(it.page_error || '');
      const serverSilent = !it.page_checked && now - it.created_at > 90 * 1000;
      const searchBlocked = !it.url && this.searchStruggling(it);
      if (!(serverOff || serverStruggling || serverSilent || searchBlocked || it.status_source === 'browser')) continue;
      if (other && !this.siteAllowed(it.url, sites, want)) continue;
      if (render(r)) {
        if (cantRender) continue;
        if (rendering.has(r.id) && !fast(r)) { later('items', it.id); continue; }
        // (Seen by a live search just now: nothing more to open.)
        if (it.status_source === 'sweep' && it.checked_at && now - it.checked_at < SWEEP_FRESH_MS) {
          this.db.run('UPDATE items SET browser_next_at = :n WHERE id = :id', { n: now + pace(r), id: it.id });
          continue;
        }
        rendering.add(r.id);
      }
      const url = it.url || this.retailers.searchUrl(r, it.sku);
      if (!url) continue;
      out.push(serialize({ id: it.id, store: it.store, sku: it.sku, kind: it.url ? 'product' : 'search', url, productPath: r.productPath || null, ...(render(r) ? { render: true, ...privateOf(r) } : {}), ...askedIn(r, it.sku, it.url) }));
      this.db.run('UPDATE items SET browser_next_at = :n WHERE id = :id', { n: now + pace(r), id: it.id });
      if (out.length >= 5) break;
    }
    // Admins' browsers also check the shared monitors the server can't: every one at a store that
    // refuses the server (Kmart), and any one whose own page refuses it (a drop watch's find at BIG W,
    // or at another website the admin has let the extension read). Members' browsers never do: only
    // the server and admins can change what everyone sees.
    if (user.role === 'admin' && out.length < 5) {
      const stores = this.retailers.list.filter((r) => r.id !== 'other' && this.retailers.enabled(r) && this.retailers.settings(r).browserChecks
        && (!this.retailers.settings(r).serverChecks || this.serverStruggles(r.id)) && !held(r.id)).map((r) => r.id);
      const whole = this.catalog.browserTargets(stores, now, 5 - out.length);
      // (Picked in the database by where this browser may check — so ones it may not never crowd out the rest.)
      const checks = this.retailers.list.filter((r) => r.id !== 'other' && !r.cartLinks && this.retailers.enabled(r) && this.retailers.settings(r).browserChecks && !held(r.id)).map((r) => r.id);
      const failing = this.catalog.browserFailing({ stores: checks, sites: this.sitePatterns(sites) }, now, 5).filter((p) => !whole.some((x) => x.id === p.id));
      for (const url of this.catalog.failingSitePages()) this.siteAllowed(url, sites, want);
      // …and at a store read by opening its pages (BIG W's), what its live searches found that nobody monitors:
      // its search tiles don't say when one goes on sale (a drop listed ahead of time shows no buy button), its
      // own page does. (Its one page a round, if the round has room for it.)
      const opened = this.retailers.list.filter((r) => render(r) && this.retailers.enabled(r) && this.retailers.settings(r).browserChecks
        && !this.retailers.settings(r).serverChecks && !held(r.id)).map((r) => r.id);
      const swept = cantRender ? [] : this.catalog.sweptTargets(opened, now, 5).filter((p) => !whole.some((x) => x.id === p.id) && !failing.some((x) => x.id === p.id));
      for (const p of [...whole, ...failing, ...swept].slice(0, 15)) {
        if (out.length >= 5) break;
        const r = this.retailers.get(p.store);
        if (render(r) && cantRender) continue;
        if (render(r) && rendering.has(r.id) && !fast(r)) { later('products', p.id); continue; }
        if (render(r) && p.status_source === 'sweep' && p.sweep_seen_at && now - p.sweep_seen_at < SWEEP_FRESH_MS) {
          this.db.run('UPDATE products SET browser_next_at = :n WHERE id = :id', { n: now + pace(r), id: p.id });
          continue;
        }
        if (render(r)) rendering.add(r.id);
        const url = p.url || this.retailers.searchUrl(r, p.sku);
        this.db.run('UPDATE products SET browser_next_at = :n WHERE id = :id', { n: now + this.productPace(p, { priv }), id: p.id });
        if (url) out.push(serialize({ id: `p:${p.id}`, store: p.store, sku: p.sku, kind: p.url ? 'product' : 'search', url, productPath: r.productPath || null, ...(render(r) ? { render: true, ...privateOf(r) } : {}), ...askedIn(r, p.sku, p.url) }));
      }
    }
    return out;
  }

  /**
   * How soon a product's page is read again in an admin's browser: a store read by opening its pages (BIG W's) at
   * its pace (retailer monitor.browserSeconds) — one its searches found that nobody monitors at that pace while it
   * can't be bought (it's what drops), every half hour once it can (to see it sell out, so its next restock alerts).
   * priv: read in the browser's private window — at the usual pace then.
   */
  productPace(product, { priv = false } = {}) {
    const r = this.retailers.get(product.store);
    const pace = r && r.monitor && r.monitor.browserSeconds && !(priv && r.monitor.privateWindow) ? r.monitor.browserSeconds * 1000 : this.browserInterval;
    if (r && r.monitor && r.monitor.render && isOrderable(product.status) && !this.catalog.monitorForProduct(product.id)) return Math.max(pace, 30 * 60 * 1000);
    return pace;
  }

  /** The pages of the other websites a browser may read, as LIKE patterns ('*': any https page). */
  sitePatterns(sites) {
    if (sites.has('*')) return ['https://%'];
    // (http too where private addresses are allowed: the dummy store, on your own computer.)
    const dev = this.cfg.monitor.allowPrivateHosts;
    return [...sites].flatMap((s) => (/:\*$/.test(s) ? (dev ? [`http://${s.slice(0, -1)}%`] : []) : [`https://${s}/%`, ...(dev ? [`http://${s}/%`] : [])]));
  }

  /**
   * The other websites each of a member's browsers may read (each says at every check, extension 1.26.0
   * or later), for the dashboard to say whether to allow one. device: the browser's id.
   */
  noteSites(userId, device, sites) {
    this.siteGrants ||= new Map();
    const mine = this.siteGrants.get(userId) || new Map();
    mine.set(device, { sites, at: this.now() });
    for (const [d, g] of mine) if (this.now() - g.at > 10 * 60 * 1000) mine.delete(d);
    this.siteGrants.set(userId, mine);
  }

  /**
   * Has a browser of this member's said lately (10 minutes) whether it may read this page's website?
   * true: one may; false: a browser that could be allowed it hasn't been; null: none of theirs has said
   * (no extension open, or one too old to ask).
   */
  siteGranted(userId, url) {
    const mine = this.siteGrants && this.siteGrants.get(userId);
    const live = mine ? [...mine.values()].filter((g) => this.now() - g.at <= 10 * 60 * 1000) : [];
    if (!live.length) return null;
    return live.some((g) => this.siteAllowed(url, g.sites, null));
  }

  /** Are in-browser checks on for this member (their alerts settings)? */
  browserChecksOn(user) {
    return !!{ ...DEFAULT_ALERTS, ...(this.repo.getData(user.id, 'alerts', {}) || {}) }.browserChecks;
  }

  /**
   * May this browser read a page at another website? Only where its owner has let the extension read
   * that website (sites: its addresses, '*' for any) — else the address goes in want (the extension
   * offers to allow it). https only (bar the dummy store).
   */
  siteAllowed(url, sites, want) {
    let host;
    try {
      const u = new URL(url);
      // (http too where private addresses are allowed: the dummy store, on your own computer.)
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && this.cfg.monitor.allowPrivateHosts)) return false;
      host = u.host.toLowerCase();
    } catch { return false; }
    if (sites.has('*') || sites.has(host)) return true;
    // (Any port: the dummy store, on your own computer.)
    if (this.cfg.monitor.allowPrivateHosts && sites.has(`${host.replace(/:\d+$/, '')}:*`)) return true;
    if (want) want.add(host);
    return false;
  }

  /** Is the server being refused by this store lately? (Then admins' browsers check its monitors.) */
  serverStruggles(store) {
    const r = this.db.get(`SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('blocked', 'error') THEN 1 ELSE 0 END) AS bad FROM check_log
      WHERE store = :s AND source = 'server' AND at >= :since`, { s: store, since: this.now() - 30 * 60 * 1000 });
    return !!r && r.n > 0 && r.bad / r.n >= 0.5;
  }

  /** What an admin's browser saw on a monitored product. */
  async browserProductResult(user, res) {
    if (user.role !== 'admin') return false;
    const product = this.catalog.productById(String(res.id).slice(2));
    if (!product) return false;
    const now = this.now();
    const status = KNOWN.has(res.status) ? res.status : STATUS.ERROR;
    const failed = FAILED.has(status);
    // (Refused in the admin's browser too: asked again later each time, as members' own are.)
    this.browserFails ||= new Map();
    const fails = failed ? (this.browserFails.get(product.id) || 0) + 1 : 0;
    if (fails) this.browserFails.set(product.id, fails); else this.browserFails.delete(product.id);
    // (Read fine: again at its own pace — BIG W's pages every few minutes, not every round: what its bot
    //  protection turns a browser away for.)
    this.db.run('UPDATE products SET browser_next_at = :n WHERE id = :id',
      { n: now + (failed ? Math.min(MAX_BACKOFF_MS, this.browserInterval * 2 ** Math.min(fails + 1, 5)) : this.productPace({ ...product, status }, { priv: res.privateWindow === true })), id: product.id });
    const found = typeof res.foundUrl === 'string' ? res.foundUrl.slice(0, 2000) : '';
    if (!product.url && found) {
      let ok = false;
      try {
        const u = new URL(found);
        const r = this.retailers.forUrl(u);
        ok = /^https?:$/.test(u.protocol) && !!r && r.id === product.store && pathHasSku(found, product.sku);
      } catch { ok = false; }
      if (ok) {
        this.catalog.resolveProduct(product.store, product.sku, found);
        this.repo.ensurePage(found, 'product', product.store, product.sku);
      }
      return ok;
    }
    if (!product.url && status !== STATUS.NOT_LISTED && !failed) return false;
    const price = typeof res.price === 'number' && Number.isFinite(res.price) && res.price >= 0 && res.price < 100000 ? res.price : null;
    const image = typeof res.image === 'string' && /^https:\/\//.test(res.image) ? res.image.slice(0, 1000) : null;
    const fresh = await this.feed.applyCheck(product, {
      status, price, image, title: typeof res.title === 'string' ? res.title.slice(0, 200) : null,
      error: failed ? (typeof res.error === 'string' && res.error ? res.error.slice(0, 200) : "The admin's browser couldn't read the page") : '',
    }, { source: 'browser', url: product.url || '' });
    // A product the searches found that nobody monitors, on sale on its own page now: alerted by the searches' rules.
    if (this.sweeper && fresh && !failed) await this.sweeper.pageRead(product, fresh).catch((e) => this.cfg.log('[sweep]', e.message));
    return true;
  }

  searchStruggling(item) {
    const r = this.retailers.get(item.store);
    const url = r && this.retailers.searchUrl(r, item.sku);
    const page = url && this.db.get('SELECT status, fail_count, checked_at FROM page_checks WHERE url = :u', { u: url });
    return !page || FAILED.has(page.status) || page.fail_count > 0 || (!page.checked_at && this.now() - item.created_at > 90 * 1000);
  }

  /** What this member's browser saw. Only ever changes this member's own items. */
  async browserResults(user, results) {
    const now = this.now();
    let applied = 0;
    for (const res of results) {
      if (!res || typeof res !== 'object') continue;
      if (typeof res.id === 'string' && res.id.startsWith('p:')) {
        if (await this.browserProductResult(user, res)) applied += 1;
        continue;
      }
      const row = this.db.get('SELECT * FROM items WHERE id = :id AND user_id = :u', { id: String(res.id || ''), u: user.id });
      if (!row || !row.monitor) continue;
      const status = KNOWN.has(res.status) ? res.status : STATUS.ERROR;
      const failed = FAILED.has(status);
      const fails = failed ? row.browser_fails + 1 : 0;
      // (Read fine: again at its store's pace — BIG W's every few minutes, not every round; read in the browser's private
      //  window, the usual pace.)
      const storeOf = this.retailers.get(row.store);
      const priv = res.privateWindow === true && !!(storeOf && storeOf.monitor && storeOf.monitor.privateWindow);
      const pace = storeOf && storeOf.monitor && storeOf.monitor.browserSeconds && !priv ? storeOf.monitor.browserSeconds * 1000 : this.browserInterval;
      const next = now + (failed ? Math.min(MAX_BACKOFF_MS, this.browserInterval * 2 ** Math.min(fails, 5)) : pace);
      this.db.run('UPDATE items SET browser_checked_at = :now, browser_fails = :f, browser_next_at = :n WHERE id = :id', { now, f: fails, n: next, id: row.id });
      const found = typeof res.foundUrl === 'string' ? res.foundUrl.slice(0, 2000) : '';
      if (!row.url && found) {
        let ok = false;
        try {
          const u = new URL(found);
          const r = this.retailers.forUrl(u);
          ok = /^https?:$/.test(u.protocol) && !!r && r.id === row.store && pathHasSku(found, row.sku);
        } catch { ok = false; }
        if (ok) {
          this.resolveSku(row.store, row.sku, found, user.id);
          applied += 1;
        }
        continue;
      }
      if (!row.url && status !== STATUS.NOT_LISTED && !failed) continue; // a search result without a link tells us nothing more
      const title = typeof res.title === 'string' ? res.title.slice(0, 200) : null;
      const price = typeof res.price === 'number' && Number.isFinite(res.price) && res.price >= 0 && res.price < 100000 ? res.price : null;
      const error = failed ? (typeof res.error === 'string' && res.error ? res.error.slice(0, 200) : 'Your browser couldn\'t read the page') : '';
      await this.applyResult({ ...row, browser_fails: fails }, { status, title, price, error }, 'browser');
      applied += 1;
    }
    return applied;
  }
}
