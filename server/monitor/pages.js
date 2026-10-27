// Drop watches on a search page (docs/MONITORING.md → Search pages): a store's search, category or
// collection page — EB Games' "Trading cards, pre-order" search, a Shopify collection, another website's
// listing — read every few seconds (3 s at the fastest; at a store whose searches go slower, at its
// pace) for products whose names have one of the watch's key phrases ("magic the gathering"),
// whatever the card keywords are. What it finds goes the way a drop watch's finds do (monitor/drops.js):
// an admin's watch for everyone posts in the Discord channel chosen for it (or by the usual rules),
// pinging the role chosen, and arms the admin's Auto-checkout; anyone's own puts it on their watchlist
// and DMs them. Auto-checkout at stores Mugibot checks out at, up to the watch's max price — for what
// drops after its first look.
//
// How a page is read (planFor): from Mugibot's server where the store answers it — its own page
// (Target's, City Beach's, The Games Cube's, The Gamesmen's, WooCommerce's), or what the page is built
// from (a Shopify collection's products.json, a Shopify search's suggestions, Kmart's search provider) —
// else from an admin's browser (extension 1.34.0), in a tab of its own in the sweep window: the page
// opened and its products read once they're drawn — or, where the page fetches them as data (EB Games'
// /search/query, Premium Bandai's /api/search), that data, learned from the page itself (so its
// filters are the page's own) and asked for again from inside it each time. A store that refuses the
// server, or whose server answer has no products where a browser can read the page, is read from an
// admin's browser while it does. One read for every watch on the same page.
//
// What counts as a drop (alerted as new, and bought at once when armed): a product with a phrase that
// wasn't on the page when it was last read — one Mugibot didn't know at that store, or knew as not on
// sale and is now. What's on the page at a watch's first look is how things were, and so is the
// first read after the page is read another way (the server, then an admin's browser) or after a
// long gap: nothing in it is a drop.

import crypto from 'node:crypto';
import { serialize } from '../retailers/index.js';
import { num, str } from '../schema.js';
import { parseListing, siteAnswer } from './listing.js';
import { BlockedUrlError, safeFetch } from './safeurl.js';
import { holdsAll, olderVersion, pageSizeIn, retryAfterMs } from './sweep.js';

export const PAGE_MIN_SECONDS = 3;
export const PAGE_DEFAULT_SECONDS = 5;
export const PAGE_MAX_SECONDS = 3600;
// The extension that reads pages in a tab of their own (an older one is never handed one).
export const PAGE_EXTENSION = '1.34.0';
export const MAX_PHRASES = 20;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
// Read again after this long without an answer: its scene is set again (nothing in that read is a drop).
const SCENE_GAP_MS = 6 * 3600 * 1000;
// A page read from an admin's browser because the server can't: this long, then the server tries again.
const BROWSER_FOR_MS = 30 * 60 * 1000;
// An admin's browser that asked for pages this lately is there to read them.
const BROWSER_AROUND_MS = 2 * 60 * 1000;
// A read handed to a browser that never came back: given up after this long (the extension's own limit is 90 s).
const JOB_MS = 100 * 1000;
// The data a page fetches (learned from the page): learned again this often, so a page that changes how it asks still reads right.
const RELEARN_MS = 10 * 60 * 1000;
// Reads going at once from the server (each page waits its turn, never two at once).
const MAX_JOBS = 6;
const SHOPIFY_SKU = /\/products\/([^/?#.]+)\/?$/i;

/**
 * The fastest a store's page is read: every 3 s — or its searches' own pace, where it asks for slower (Pokémon Center's
 * 30 s). (BIG W's 20 s only while it's read in an ordinary window: PageWatches.floorNow.)
 */
export function floorFor(r) {
  return Math.max(PAGE_MIN_SECONDS, Number(r && r.sweep && r.sweep.minSeconds) || 0);
}

/** A page's link as it's kept: no #part. */
export function pageLink(url) {
  try {
    const u = new URL(String(url));
    u.hash = '';
    return u.href;
  } catch { return ''; }
}

/** The key phrases a page is read for: each the words of a drop watch (lower case, no punctuation), 3 letters or more. */
export function phrasesOf(input, wordsOf) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[\n;]+/);
  return [...new Set(list.map((x) => wordsOf(x)).filter((x) => x.length >= 3))].slice(0, MAX_PHRASES);
}

/** The page's path inside its store (its address less the store's own): '/search' at EB Games, and at its dummy copy. */
function relPath(r, u) {
  let basePath = '';
  try { basePath = new URL(r.base).pathname.replace(/\/+$/, ''); } catch { /* none */ }
  const p = u.pathname;
  return basePath && (p === basePath || p.startsWith(`${basePath}/`)) ? p.slice(basePath.length) || '/' : p;
}

// A page that does something rather than list products — a cart, a checkout, an account, signing in or out, adding
// to a bag: never a search page (an admin's browser opens a store's pages signed in as them).
const NOT_A_LIST = /(^|[/_.-])(cart|carts|basket|bag|checkout|checkouts|account|accounts|my-?account|customer|profile|login|log-?in|logout|log-?out|sign-?in|sign-?out|signin|signout|register|wishlist|wish-?list|orders?|payment|password|api|admin|graphql)([/_.?-]|$)/i;
const NOT_A_LIST_PARAM = /^(add|add-?to-?cart|addtocart|action|logout|quantity|qty|variant|id)$/i;

/** Why a link can't be a search page watch ('' when it can): a page that does something, not one that lists products. */
export function pageProblem(url) {
  let u;
  try { u = new URL(url); } catch { return "That isn't a valid web address"; }
  if (NOT_A_LIST.test(u.pathname) || [...u.searchParams.keys()].some((k) => NOT_A_LIST_PARAM.test(k))) {
    return "That link does something (a cart, a checkout, an account page) — paste a page of products instead: a search, a category or a collection";
  }
  return '';
}

/** A store's own product page (not a page of results): it's watched by its link, not its words. */
export function isProductPage(r, url) {
  try { return !!(r && r.productPath && r.productPath.test(new URL(url).pathname)); } catch { return false; }
}

/**
 * How a page is read: { server: { url, parser, json } | null, browser: { url, parser, render | inPage, … } | null }
 * — or null (a store whose pages Mugibot doesn't read). r: the page's store (null: another website).
 * urlFor(r, words): the store's own search for these words, as its drop watches search it.
 */
export function planFor(r, pageUrl, { urlFor = null } = {}) {
  let u;
  try { u = new URL(pageUrl); } catch { return null; }
  u.hash = '';
  if (!r || r.id === 'other') return { server: { url: u.href, parser: 'site' }, browser: null };
  if (!r.sweep || r.cartLinks) return null;
  const rel = relPath(r, u);
  const param = (...names) => names.map((n) => u.searchParams.get(n)).find((v) => v && v.trim()) || '';
  const page = (parser, extra = {}) => ({ url: u.href, parser, productPath: r.productPath || null, skuFromPath: r.skuFromPath || null, ...extra });
  const render = (parser, extra = {}) => page(parser, { render: true, privateWindow: !!r.sweep.privateWindow, ...extra });
  const search = (q) => (q && urlFor ? urlFor(r, q) : '');
  switch (r.sweep.parser) {
    // EB Games' (and Zing's) search page has no products in it: its own script asks /search/query for them, with the
    // page's own filters. Learned from the page as it asks (guess: the same filters asked of /search/query, if it doesn't).
    case 'ebgames':
      return { server: null, browser: render('ebgames', { learn: true, guess: /\/search\/?$/.test(rel) ? `${r.base}${rel.replace(/\/+$/, '')}/query${u.search}` : '' }) };
    // Premium Bandai's: its /api/search (with the region its code sends).
    case 'pbandai':
      return { server: null, browser: render('pbandai', { learn: true, headers: r.sweep.headers || null, guess: search(param('keyword', 'q')) }) };
    // Amazon's search and category pages are its own HTML, asked for from inside an Amazon page (servers get HTTP 503).
    case 'amazon':
      return { server: null, browser: page('amazon', { inPage: true, expect: 'html', pageUrl: r.base }) };
    // Kmart's search: its search provider (Constructor.io), the way its drop watches search it; its other pages, drawn in a browser.
    case 'constructor': {
      const q = search(param('searchTerm', 'q', 'text'));
      return { server: q ? { url: q, parser: 'constructor', json: true, size: pageSizeIn(q) } : null, browser: render('generic') };
    }
    // WooCommerce: its search through its product API; a category page, as it is.
    case 'woo': {
      const q = search(param('s'));
      return { server: q ? { url: q, parser: 'woo', json: true, size: pageSizeIn(q) } : page('generic'), browser: render('generic') };
    }
    // Shopify: a collection is its products.json (every product in it, with stock — its filters left to the key
    // phrases); a search, its suggestions; any other page as it is. A browser draws it where those come back empty.
    case 'shopify':
    case 'shopify-suggest': {
      const sku = r.skuFromPath || SHOPIFY_SKU;
      const col = rel.match(/^\/collections\/([^/?#]+)/);
      const q = /^\/search\/?$/.test(rel) ? param('q', 'query', 'keyword') : '';
      // (size: how many a read holds at most — Shopify's own limits — so one with fewer holds every product there is.)
      const server = col ? { url: `${r.base}/collections/${col[1]}/products.json?limit=250`, parser: 'shopify', json: true, size: 250 }
        : q ? { url: `${r.base}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=10&resources%5Boptions%5D%5Bunavailable_products%5D=last`, parser: 'shopify-suggest', json: true, size: 10 }
          : page('generic', { skuFromPath: sku });
      return { server, browser: render('generic', { skuFromPath: sku }) };
    }
    // The rest read their own pages — Target's, City Beach's, The Games Cube's, The Gamesmen's: from the server, or a
    // browser; BIG W's and Pokémon Center's are drawn in a browser only (no products in them until their code runs).
    default:
      return { server: r.sweep.render ? null : page(r.sweep.parser), browser: r.sweep.render ? render(r.sweep.parser) : page(r.sweep.parser) };
  }
}

const keyOf = (p) => String(p.sku || p.url || '').toLowerCase();

export class PageWatches {
  constructor({ cfg, db, retailers, drops, hub, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { cfg, db, retailers, drops, hub, fetch: fetchImpl, now });
    this.state = new Map(); // a page's key → how its reads are going
    this.ids = new Map(); // a browser read's id → its page's key
    this.hostNext = new Map();
    this.jobs = new Set();
    this.timer = null;
    this.browserAt = 0; // an admin's browser (one that reads pages) last asked
    this.storeNext = new Map(); // a store's next page read from a browser (all its pages together: about one a second at most)
    this.toldAt = new Map(); // a watch → when its owner's dashboard was last told how its reads are going
    this.oldBrowser = null; // { at, version }: an admin's browser too old to read pages
    // (Set by app.js: sweeper, monitor, gates.)
  }

  start() {
    if (this.timer || !this.cfg.monitor.enabled) return;
    this.timer = setInterval(() => { this.tick().catch((e) => this.cfg.log('[pages]', e.message)); }, 1000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** The page watches being read (their owners' memberships active), by page: { key, r, url, watches, every }. */
  groups() {
    const out = new Map();
    for (const w of this.drops.live()) {
      if (!w.page) continue;
      const key = `${w.store}|${w.page}`;
      let g = out.get(key);
      if (!g) {
        const r = w.store === 'other' ? null : this.retailers.get(w.store);
        if (w.store !== 'other' && !r) continue;
        g = { key, r, url: w.page, watches: [], every: Infinity };
        out.set(key, g);
      }
      g.watches.push(w);
      g.every = Math.min(g.every, this.everyFor(w, g.r));
    }
    return out;
  }

  /** How often a watch asks for its page to be read (never faster than its store allows). */
  everyFor(w, r = w.store === 'other' ? null : this.retailers.get(w.store)) {
    return Math.max(this.floorNow(r), w.every || PAGE_DEFAULT_SECONDS);
  }

  /**
   * The fastest a store's page is read just now: its floor — and a store that asks for slower while it's read in an
   * ordinary window (BIG W's 20 s, sharedWindowSeconds) at that, till an admin's browser reads it in its private window.
   */
  floorNow(r) {
    const shared = r && r.sweep && r.sweep.sharedWindowSeconds && !(this.sweeper && this.sweeper.inPrivate(r)) ? r.sweep.sharedWindowSeconds : 0;
    return Math.max(floorFor(r), shared);
  }

  st(key) {
    let s = this.state.get(key);
    if (!s) {
      s = { nextAt: 0, inFlight: 0, startedAt: 0, fails: 0, lastAt: null, lastOkAt: null, okTimes: [], via: '', browserUntil: 0, serverEmpty: 0, dataUrl: '', learnedAt: 0, base: null, seen: new Set(), error: '', refused: false, siteBrowserAt: 0 };
      this.state.set(key, s);
    }
    return s;
  }

  plan(g) {
    return planFor(g.r, g.url, { urlFor: this.sweeper ? (r, q) => this.sweeper.urlFor(r, q, 1, { vip: true }) : null });
  }

  modeOf(g) {
    if (!g.r) return 'server';
    return this.sweeper ? this.sweeper.modeFor(g.r) : 'auto';
  }

  /** An admin's browser that reads pages is there (it asked lately). */
  browserAround() {
    return this.now() - this.browserAt < BROWSER_AROUND_MS;
  }

  /** How a page is read now: 'server', 'browser' or null (it can't be: its store is off). */
  wayFor(g, plan = this.plan(g), mode = this.modeOf(g), st = this.st(g.key)) {
    if (!plan || mode === 'off') return null;
    const serverOk = !!plan.server && mode !== 'browser';
    const browserOk = !!plan.browser && (mode !== 'server' || !plan.server);
    if (serverOk && !(browserOk && st.browserUntil > this.now() && this.browserAround())) return 'server';
    return browserOk ? 'browser' : serverOk ? 'server' : null;
  }

  // ---------------------------------------------------------------------------
  // Reading from the server
  // ---------------------------------------------------------------------------
  /** The pages due a read from the server, each read on its own (no page waits on another's). Returns their reads. */
  tick() {
    const now = this.now();
    const groups = this.groups();
    for (const key of this.state.keys()) if (!groups.has(key)) this.state.delete(key);
    const started = [];
    const gap = Math.min(1000, Math.max(0, this.cfg.monitor.hostGapSeconds ?? 1) * 1000);
    for (const g of [...groups.values()].sort((a, b) => this.st(a.key).nextAt - this.st(b.key).nextAt)) {
      if (this.jobs.size >= MAX_JOBS) break;
      const st = this.st(g.key);
      // (A read handed to a browser that never came back — closed mid-read: given up after JOB_MS, as the browser's own are.)
      if ((st.inFlight && now - st.inFlight < JOB_MS) || st.nextAt > now) continue;
      const plan = this.plan(g);
      if (this.wayFor(g, plan) !== 'server') continue;
      let host = '';
      try { host = new URL(plan.server.url).host; } catch { continue; }
      if ((this.hostNext.get(host) || 0) > now) continue;
      this.hostNext.set(host, now + gap);
      st.inFlight = now;
      st.startedAt = now;
      const job = this.readServer(g, plan).catch((e) => this.cfg.log('[pages]', e.message)).finally(() => { st.inFlight = 0; this.jobs.delete(job); });
      this.jobs.add(job);
      started.push(job);
    }
    return Promise.all(started).then(() => started.length);
  }

  headers(r, json) {
    return {
      ...((r && r.sweep && r.sweep.headers) || {}),
      'user-agent': this.cfg.monitor.userAgent,
      accept: json ? 'application/json' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-AU,en;q=0.9',
    };
  }

  /** One read of a page from the server: its products, then what they mean (done). */
  async readServer(g, plan) {
    const want = plan.server;
    // Another website: read as its words watches' pages are (monitor/drops.js), as Mugibot.
    if (want.parser === 'site') {
      const got = await this.drops.read(want.url, '', 'page');
      if (!got.ok) return this.failed(g, { source: 'server', refused: !!got.refused, error: got.error });
      return this.done(g, { source: 'server', how: 'server', parsed: { products: got.products, problem: null } });
    }
    const r = g.r;
    let res;
    try {
      const timeoutMs = Math.min(this.cfg.monitor.timeoutMs, 20000);
      res = await safeFetch(this.fetch, want.url, { headers: this.headers(r, want.json), timeoutMs, signal: AbortSignal.timeout(timeoutMs) }, { allowPrivate: this.cfg.monitor.allowPrivateHosts });
    } catch (e) {
      return this.failed(g, { source: 'server', error: e instanceof BlockedUrlError ? e.message : e.name === 'TimeoutError' ? 'The store took too long to answer' : "Couldn't reach the store" });
    }
    if (!res.ok) {
      const refused = [401, 403, 429, 503].includes(res.status);
      const wait = refused ? retryAfterMs(res.headers && res.headers.get('retry-after'), this.now()) : 0;
      return this.failed(g, { source: 'server', refused, wait, error: refused ? `${r.name} refused Mugibot's server (HTTP ${res.status})` : `${r.name} answered HTTP ${res.status}` });
    }
    const text = (await res.text()).slice(0, 8_000_000);
    const parsed = parseListing(want.parser, text, { base: res.url || want.url, storeBase: r.base, productPath: want.productPath || null, skuFromPath: want.skuFromPath || null, storeName: r.name });
    // (whole: it holds every result there is — the store's own count says so, or fewer came than Mugibot's own address
    //  asks for. A page's own address is the person's: its size isn't trusted.)
    return this.done(g, { source: 'server', how: 'server', parsed, whole: holdsAll(parsed, want.size || 0) });
  }

  // ---------------------------------------------------------------------------
  // Reading from an admin's browser (the extension's sweep window, a tab of the page's own)
  // ---------------------------------------------------------------------------
  /**
   * The pages due a read from this admin's browser (GET /api/ext/sweeps): one at a time at each store (its tab),
   * none at a store whose queue is up (unless this browser's through it) or that's turning this browser away.
   * browser: { version, busy (tabs still reading), denied (stores turning it away), through (queues it's through) }.
   */
  browserDue(user, { version = '', busy = new Set(), denied = new Set(), through = new Set() } = {}) {
    if (!user || user.role !== 'admin') return { pages: [], waitMs: null };
    const now = this.now();
    const groups = [...this.groups().values()].filter((g) => g.r);
    if (!version || olderVersion(version, PAGE_EXTENSION)) {
      if (groups.some((g) => this.wayFor(g) === 'browser')) this.oldBrowser = { at: now, version, who: user.username };
      return { pages: [], waitMs: null };
    }
    this.browserAt = now;
    const pages = [];
    const tabs = new Set();
    let next = null;
    for (const g of groups.sort((a, b) => this.st(a.key).nextAt - this.st(b.key).nextAt)) {
      const st = this.st(g.key);
      const plan = this.plan(g);
      if (this.wayFor(g, plan) !== 'browser') continue;
      const r = g.r;
      const tab = `page:${r.id}`;
      if (tabs.has(tab) || busy.has(tab) || denied.has(r.id)) continue;
      if (this.gates && this.gates.queueUp(r.id) && !through.has(r.id)) continue;
      if (st.inFlight && now - st.inFlight < JOB_MS) continue;
      if (st.nextAt > now) { next = Math.min(next ?? Infinity, st.nextAt); continue; }
      // (All a store's pages together: a read about every second at most — a third of its fastest pace — so a store with
      //  many pages watched never sees a burst from the admin's browser it'd turn away, nor the admin's own checkouts.)
      const gate = this.storeNext.get(r.id) || 0;
      if (gate > now) { next = Math.min(next ?? Infinity, gate); continue; }
      this.storeNext.set(r.id, now + Math.round((this.floorNow(r) * 1000) / 3));
      tabs.add(tab);
      st.inFlight = now;
      st.startedAt = now;
      const id = `pg:${crypto.createHash('sha1').update(g.key).digest('hex').slice(0, 16)}`;
      this.ids.set(id, g.key);
      const b = plan.browser;
      const data = st.dataUrl && now - st.learnedAt < RELEARN_MS ? st.dataUrl : '';
      pages.push(serialize({
        id, tab, store: r.id, storeName: r.name, storeBase: r.base, frontUrl: r.base,
        url: b.url, parser: b.parser, render: !!b.render, inPage: !!b.inPage, expect: b.expect || 'json', pageUrl: b.pageUrl || null,
        headers: b.headers || null, privateWindow: !!b.privateWindow, productPath: b.productPath || null, skuFromPath: b.skuFromPath || null,
        // The data the page fetches (learned from it before): asked for from inside the page; else the page opened and read.
        dataUrl: data, learn: !!b.learn, guess: b.learn ? b.guess || '' : '',
        gate: r.gate ? { kind: r.gate.kind, page: r.gate.page } : null,
      }));
    }
    // (Nothing due yet: asked again when the next one is.)
    if (!pages.length && next === null && groups.some((g) => this.wayFor(g) === 'browser')) next = now + 5000;
    return { pages, waitMs: next === null ? null : Math.max(500, next - now) };
  }

  /** What an admin's browser read (POST /api/ext/sweeps, pages). */
  async browserResults(user, results) {
    if (!user || user.role !== 'admin' || !Array.isArray(results)) return [];
    const out = [];
    const groups = this.groups();
    for (const res of results.slice(0, 10)) {
      if (!res || typeof res !== 'object') continue;
      const key = this.ids.get(str(res.id, 40));
      const g = key && groups.get(key);
      if (!g || !g.r) continue;
      const r = g.r;
      const st = this.st(g.key);
      try {
        // Into the store's queue (or checkpoint): it's up — the read waits, no failure, the tab left as it is.
        if (res.gate && this.gates) {
          this.gates.observe(r.id, 'up', { source: 'page', user, wait: res.gate.wait });
          st.nextAt = this.now() + 30 * 1000;
          continue;
        }
        if (!res.ok) {
          const status = num(res.status, { min: 0, max: 999, int: true, def: 0 });
          const refused = !!res.blocked || [401, 403, 429, 503].includes(status);
          await this.failed(g, { source: 'browser', refused, error: refused ? `${r.name} refused the admin's browser${status ? ` (HTTP ${status})` : ''} — backing off` : str(res.error, 200) || (status ? `HTTP ${status}` : "The admin's browser couldn't read the page") });
          out.push({ id: res.id, ok: false });
          continue;
        }
        // (The data the page fetched, that had its products: asked for straight away next time. Only the store's own.)
        const learned = str(res.learned, 2000);
        if (learned) {
          const owner = (() => { try { return this.retailers.forUrl(new URL(learned)); } catch { return null; } })();
          if (owner && owner.id === r.id) { st.dataUrl = learned; st.learnedAt = this.now(); }
        } else if (res.how === 'page') st.dataUrl = '';
        const products = (Array.isArray(res.products) ? res.products : []).slice(0, 300).map((p) => this.sweeper.cleanProduct(r, p)).filter(Boolean);
        const problem = ['blocked', 'layout', 'empty', 'unread'].includes(res.problem) ? res.problem : null;
        const stated = num(res.stated, { min: 0, max: 1e7, int: true, def: null });
        // (The store's own count of results and how many came, where the browser says: whether the read holds them all.)
        const total = num(res.total, { min: 0, max: 1e7, int: true, def: null });
        const perPage = num(res.perPage, { min: 0, max: 1e5, int: true, def: null });
        const parsed = { products, problem, stated, total, perPage };
        await this.done(g, { source: 'browser', how: res.how === 'data' ? 'browser:data' : 'browser:page', parsed, whole: total !== null && perPage !== null && holdsAll(parsed) });
        out.push({ id: res.id, ok: true, products: products.length });
      } finally {
        // (Its next read is handed out only once this one's been taken in: never two at once for a page.)
        st.inFlight = 0;
      }
    }
    return out;
  }

  /** Another website's page refusing the server, read from a browser instead (monitor/drops.js's in-browser reads). */
  async siteResult(w, products) {
    const g = this.groups().get(`${w.store}|${w.page}`);
    if (!g) return false;
    this.st(g.key).siteBrowserAt = this.now();
    await this.done(g, { source: 'browser', how: 'browser:page', parsed: { products, problem: null } });
    return true;
  }

  /** Is another website's page refusing the server (so a browser should read it)? */
  siteRefused(w) {
    const st = this.state.get(`${w.store}|${w.page}`);
    return !!st && (st.refused || this.now() - st.siteBrowserAt < 3 * 60 * 1000);
  }

  // ---------------------------------------------------------------------------
  // What a read means
  // ---------------------------------------------------------------------------
  /** A read that answered: its products for each watch on the page (their finds), and when it's read next. whole: it held every result. */
  async done(g, { source, how, parsed, whole = false }) {
    const st = this.st(g.key);
    const now = this.now();
    st.lastAt = now;
    const plan = this.plan(g);
    if (parsed.problem === 'blocked') return this.failed(g, { source, refused: true, error: source === 'browser' ? `${this.name(g)} showed its bot check in the admin's browser — open it in that browser and pass the check yourself, once (reads back off meanwhile)` : `${this.name(g)} showed a bot check instead of the page` });
    if (parsed.problem === 'layout') return this.failed(g, { source, error: "The page didn't have a product list Mugibot can read — the store may have changed it" });
    if (parsed.problem === 'unread') return this.failed(g, { source, soft: true, error: `The page says it has ${parsed.stated} results, but none were drawn when it was read — read again shortly` });
    const products = parsed.products || [];
    // The server's answer has no products where an admin's browser can read the page (a page drawn by its own code, a
    // collection whose products.json is shut): a browser reads it instead, while one's there.
    const serverEmpty = source === 'server' && !!plan && !!plan.browser && this.modeOf(g) !== 'server';
    let toBrowser = false;
    if (serverEmpty) {
      st.serverEmpty = products.length ? 0 : st.serverEmpty + 1;
      if (st.serverEmpty >= 2 && this.browserAround()) {
        toBrowser = !(st.browserUntil > now);
        st.browserUntil = now + BROWSER_FOR_MS;
      }
    }
    // (Read another way than before, or after a long gap: how things are, nothing in it a drop. What's been on the page
    //  since only adds up — a read with nothing in it, or a page drawn before all its tiles were in, takes nothing away —
    //  so a product's coming back on the page is never a drop: only one that's never been on it.)
    const scene = !st.base || st.base.key !== how || now - (st.lastOkAt || 0) > SCENE_GAP_MS;
    if (scene) st.seen = new Set();
    const fresh = scene ? null : new Set(products.map(keyOf).filter((k) => k && !st.seen.has(k)));
    const peers = g.watches;
    try {
      if (g.r) await this.sweeper.ingestPage(g.r, peers, products, { fresh, now, whole, how });
      else await this.settleSite(peers, products, { fresh });
    } finally {
      for (const p of products) { const k = keyOf(p); if (k && st.seen.size < 5000) st.seen.add(k); }
      st.base = { key: how, at: now };
      st.via = source;
      st.lastOkAt = now;
      st.okTimes = [...st.okTimes.slice(-5), now];
      st.fails = 0;
      st.refused = false;
      st.error = '';
      // (A website read from a browser while it refuses the server: the server asks again, less often. Over to an
      //  admin's browser just now: its read straight away.)
      st.nextAt = toBrowser ? now : (st.startedAt || now) + g.every * 1000 * (!g.r && source === 'browser' ? 4 : 1);
    }
    const note = products.length ? ''
      : serverEmpty && st.serverEmpty >= 2 ? (this.browserAround() ? "Mugibot's server reads no products on this page — an admin's browser reads it instead" : "Mugibot's server reads no products on this page — an admin's browser can (Chrome with Mugibot's extension, signed in as an admin)")
        : 'No products on the page just now';
    for (const w of peers) {
      const first = !w.baselineAt;
      const was = `${w.fails}|${w.error}`;
      this.db.run(`UPDATE drop_watches SET how = :how, last_at = :now, last_ok_at = :now, fails = 0, error = :e, seen = :seen,
        baseline_at = COALESCE(baseline_at, :now) WHERE id = :id`, { how: source, now, e: note, seen: products.length, id: w.id });
      Object.assign(w, { how: source, lastAt: now, lastOkAt: now, fails: 0, error: note, seen: products.length, baselineAt: w.baselineAt || now });
      // (Its owner's dashboard: told when something's changed — or every half a minute, so "read 2 s ago" stays true.)
      if (first || was !== `0|${note}` || now - (this.toldAt.get(w.id) || 0) > 30 * 1000) {
        this.toldAt.set(w.id, now);
        this.hub.publish(w.userId, 'drop', { id: w.id });
      }
      if (first) this.drops.firstLook(this.drops.get(w.id) || w);
    }
    return { ok: true, products: products.length };
  }

  /** Another website's page: each product with a watch's phrase is that watch's find (alerts only: no checkout there). */
  async settleSite(peers, products, { fresh }) {
    for (const p of products) {
      const title = p.title || p.name;
      for (const w of peers) {
        if (!this.drops.phraseIn(w, title)) continue;
        const drop = !!w.baselineAt && !!fresh && fresh.has(keyOf(p));
        if (w.shared) await this.drops.foundSharedSite(w, p, { baseline: !drop }).catch((e) => this.cfg.log('[pages]', e.message));
        else await this.drops.foundOwnSite(w, p, { baseline: !drop }).catch((e) => this.cfg.log('[pages]', e.message));
      }
    }
  }

  /** A read that went wrong: said on each watch, and the page read again later — later each time (a refusal: the browser, where it can). */
  async failed(g, { source, refused = false, wait = 0, soft = false, error }) {
    const st = this.st(g.key);
    const now = this.now();
    st.lastAt = now;
    if (!soft) st.fails += 1;
    st.refused = refused && source === 'server';
    const every = g.every * 1000;
    // (Turned away: half a minute, then twice as long each time — a store saying "too many" is let be. Else its pace, doubling.)
    const backoff = refused ? Math.min(MAX_BACKOFF_MS, Math.max(30 * 1000, every) * 2 ** Math.min(Math.max(st.fails - 1, 0), 5))
      : Math.min(MAX_BACKOFF_MS, every * 2 ** Math.min(Math.max(st.fails - 1, 0), 8));
    const plan = this.plan(g);
    if (refused && source === 'server' && plan && plan.browser && this.modeOf(g) !== 'server') {
      // (Refused at the server: an admin's browser reads it meanwhile — straight away, where one's there.)
      st.browserUntil = now + BROWSER_FOR_MS;
      st.nextAt = this.browserAround() ? now : now + Math.max(wait, backoff);
    } else if (refused && source === 'browser' && plan && plan.server && this.modeOf(g) !== 'browser') {
      st.browserUntil = 0;
      st.nextAt = now + Math.max(wait, every);
    } else {
      st.nextAt = now + (soft ? every : Math.max(wait, backoff));
    }
    st.error = error;
    return this.note(g, error, { fails: !soft });
  }

  /** What each watch on the page says about its last read (its error, how many reads in a row went wrong). */
  note(g, error, { fails = true } = {}) {
    const now = this.now();
    const st = this.st(g.key);
    for (const w of g.watches) {
      const was = `${w.fails}|${w.error}`;
      const n = fails ? st.fails : w.fails;
      this.db.run('UPDATE drop_watches SET last_at = :now, fails = :f, error = :e WHERE id = :id', { now, f: n, e: String(error || '').slice(0, 200), id: w.id });
      Object.assign(w, { lastAt: now, fails: n, error: String(error || '').slice(0, 200) });
      if (was !== `${n}|${w.error}`) this.hub.publish(w.userId, 'drop', { id: w.id });
    }
    return { ok: false, error };
  }

  name(g) {
    return g.r ? g.r.name : this.retailers.siteName('other', g.url);
  }

  // ---------------------------------------------------------------------------
  // For drops.js and the dashboard
  // ---------------------------------------------------------------------------
  /** "Check now": its page read next (the browser's next ask, where a browser reads it). */
  checkNow(w) {
    const st = this.state.get(`${w.store}|${w.page}`);
    if (!st) return;
    st.nextAt = 0;
    if (st.inFlight && this.now() - st.inFlight > JOB_MS) st.inFlight = 0;
  }

  /** How a page watch is read, for its card: how often, from where, and what it's waiting on. */
  viewOf(w) {
    const r = w.store === 'other' ? null : this.retailers.get(w.store);
    const key = `${w.store}|${w.page}`;
    const st = this.state.get(key);
    const g = { key, r, url: w.page, watches: [w], every: this.everyFor(w, r) };
    const plan = this.plan(g);
    const way = plan ? this.wayFor(g, plan, this.modeOf(g), st || this.st(key)) : null;
    const times = st ? st.okTimes : [];
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    let waiting = '';
    if (!plan) waiting = 'unsupported';
    else if (!way) waiting = 'off';
    else if (way === 'browser' && !this.browserAround()) waiting = this.oldBrowser && this.now() - this.oldBrowser.at < BROWSER_AROUND_MS ? 'update' : 'browser';
    return {
      every: w.every || PAGE_DEFAULT_SECONDS, floor: floorFor(r), readEvery: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 100) / 10 : null,
      way: way || '', via: st ? st.via : '', nextAt: st ? st.nextAt || null : null, waiting,
      ...(waiting === 'update' ? { needs: PAGE_EXTENSION, has: this.oldBrowser.version } : {}),
    };
  }
}
