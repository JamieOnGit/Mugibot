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
// Every search is also an event for the dashboards' live event log (with how
// long the store took to answer), and so are faults, recoveries, settings
// changes and products dropping out of the results. The last ones are kept in
// memory for dashboards that open later.
//
// Target leaves sold-out products out of its results, so there a product gone
// from every page of a search for 6 minutes (while each page was read fine)
// counts as sold out, and its return as a restock. Only when the pages Mugibot
// reads hold every result: with more results than that, nothing is marked.
//
// Trainer Town (Shopify) keeps each game in a collection of its own; there a
// keyword's whole collection is read in one go, sold-out products included. At
// JB Hi-Fi, Toys"R"Us, Pokébox and the other card shops on Shopify, every few
// searches is the store's newest products (sweep.newestPath), where a new drop
// shows up first — each product in it counted for its keyword.
//
// Drop mode: a store where a new card listing has just been alerted is searched
// for what's next there more often for a while (its newest products, or that
// keyword's first page) — at the same pace, never more requests.
//
// Stores that answer servers (Target, JB Hi-Fi, Trainer Town, Amazon) are swept
// from the server, honestly identified as Mugibot; so is Kmart, through its
// search provider (Constructor.io), which its own search page asks. Stores that
// refuse servers (BIG W, EB Games) are swept from an admin's browser by the
// extension, at a gentler pace; BIG W's page is opened and read once it has
// built its product list. A refused or failed search backs off (twice as long each time, up to
// 15 minutes) and never alerts. A store that needs a newer extension than an admin's browser has
// (sweep.extension) isn't given to that browser: the live monitor says to update it.

import { categoryFor, toProduct } from '../catalog.js';
import { ENTITLED_SQL } from '../repo.js';
import { serialize } from '../retailers/index.js';
import { bad, bool, num, str } from '../schema.js';
import { decodeEntities } from './html.js';
import { dropConnections, storeFetch } from './http.js';
import { AU_STATES, mentions, norm, parseListing, termsRegex } from './listing.js';
import { BlockedUrlError, safeFetch } from './safeurl.js';
import { readingOf } from './sightings.js';
import { STATUS, isOrderable } from './status.js';
import { VIP_AFTER_MS } from './vip.js';

/** A Retry-After header (seconds, or a date) as milliseconds from now, at most 15 minutes; 0 if none. */
export function retryAfterMs(value, now = Date.now()) {
  const v = String(value || '').trim();
  if (!v) return 0;
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 15 * 60 * 1000) : 0;
}

// The query parameters a page's size is asked for under, in the search addresses Mugibot makes (sweep.path, wordsPath).
const PAGE_SIZE_KEYS = ['sz', 'limit', 'per_page', 'num_results_per_page', 'resources[limit]'];

/** How many results a page holds, as its address asks for them (0: it doesn't say). */
export function pageSizeIn(url) {
  try {
    const q = new URL(url).searchParams;
    for (const k of PAGE_SIZE_KEYS) {
      const n = Number(q.get(k));
      if (Number.isInteger(n) && n > 0) return n;
    }
  } catch { /* not an address */ }
  return 0;
}

/**
 * Does a read hold every result the store has for it — so a product it doesn't have isn't listed there (at a store
 * that leaves sold-out products out of its results, isn't on sale)? Its first page holds them all: the store's own
 * count of results says so (total, with perPage: how many came), or fewer came than the page holds (count, against
 * size: the page size Mugibot asked for — 0 where the address isn't Mugibot's own). Not known: no.
 */
export function holdsAll(parsed, size = 0) {
  if (typeof parsed.total === 'number' && typeof parsed.perPage === 'number') return parsed.total <= parsed.perPage;
  return size > 0 && typeof parsed.count === 'number' && parsed.count < size;
}

/** Is extension version a older than b ("1.8.0" < "1.8.1")? Unknown counts as older. */
export function olderVersion(a, b) {
  if (!a) return true;
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}

/**
 * Kmart's states with stock, when it isn't all of them: "In stock in NSW, VIC only." — or, when most have
 * it, the ones that don't: "In stock everywhere except NT." ('' for every state, or when it isn't known.)
 */
export function statesNote(states) {
  if (!Array.isArray(states) || !states.length) return '';
  const missing = AU_STATES.filter((s) => !states.includes(s));
  if (!missing.length) return '';
  return states.length * 2 <= AU_STATES.length ? `In stock in ${states.join(', ')} only.` : `In stock everywhere except ${missing.join(', ')}.`;
}

// (Added Oct 2026, termsVersion 2: sealed products named without a card word — "Prismatic Evolutions Super-Premium
// Collection", "Destined Rivals Blister", "Build & Battle Box" — went untracked. Merged into a list saved before then.)
const ADDED_TCG_TERMS = ['premium collection', 'blister', 'build & battle', 'collector chest', 'portfolio', 'deck box', 'playmat'];
export const TCG_TERMS = [
  'card', 'cards', 'tcg', 'booster', 'pack', 'packs', 'bundle', 'starter deck', 'deck', 'elite trainer', 'etb',
  'tin', 'collection box', 'special collection', 'display', 'trading card', 'booster box', 'binder', 'sleeve', 'sleeves',
  ...ADDED_TCG_TERMS,
];
// A card set's code in the name counts as a card word: One Piece's OP-15, EB-02, ST-21, PRB-01; Gundam's GD01 ("ONE PIECE
// OP-15 BOX").
const CARD_CODE_RE = /\b(?:op|eb|st|prb|gd)-?\d{1,2}\b/i;
// After the card words widen (an update), what they let in that wasn't counted before is tracked quietly the first time
// it's seen — for this long — never a burst of "new drops" that were on sale all along.
const WIDENED_QUIET_MS = 6 * 3600 * 1000;

// Not trading cards, even with a card word in the name ("3 Pack Socks", "Short Sleeve T-Shirt"),
// unless the name says TCG, trading card or card game.
export const NOT_CARD_TERMS = [
  'shirt', 't-shirt', 'tee', 'hoodie', 'jumper', 'socks', 'trunks', 'briefs', 'underwear', 'pyjamas', 'pajamas', 'sleepwear', 'dress', 'shorts',
  'pants', 'leggings', 'jacket', 'beanie', 'hat', 'bucket hat', 'backpack', 'lunch box', 'bottle', 'drink bottle', 'mug', 'tumbler', 'towel', 'blanket',
  'pillow', 'cushion', 'quilt', 'plush', 'plushie', 'puzzle', 'lego', 'costume', 'slippers', 'shoes', 'clogs', 'sandals', 'lamp', 'night light', 'poster',
  'pencil case', 'keyring', 'keychain', 'phone case', 'nintendo switch', 'switch 2',
];
const CARD_SURE_RE = /\b(tcg|trading cards?|card game)\b/i;

// Searched for since Oct 2026 (a member's list: Pokémon, One Piece, Riftbound, Gundam): added to a list saved
// before then too (keywordsVersion 2) — and, dropped from it later, left out. ("gundam card game": its cards
// are named "Gundam Card Game …", and a keyword with "card" in it isn't given "tcg" on top.)
const ADDED_KEYWORDS = ['riftbound', 'gundam card game'];
export const SWEEP_DEFAULTS = Object.freeze({
  enabled: true,
  keywords: ['pokemon', 'one piece', ...ADDED_KEYWORDS],
  everySeconds: 5, // between two searches at one store, from the server
  browserEverySeconds: 15, // …from an admin's browser
  stores: {}, // store id → 'auto' (server first) | 'server' | 'browser' | 'off' (unset: the store's own default)
  skipMarketplace: true,
  tcgOnly: true,
  tcgTerms: TCG_TERMS,
  notCardTerms: NOT_CARD_TERMS,
  newAlerts: true,
  restockAlerts: true,
  restockOncePerDay: true,
  priceAlerts: true,
  priceDropPercent: 10,
  dropMode: true,
});

const MODES = ['auto', 'server', 'browser', 'off'];
// Server first ('auto', every store's default): Mugibot's server searches the store. An admin's
// browser stands in only while the server's refused (3 searches in a row), or can't read the
// store's products at all (a page that draws them once it's open: BIG W's). Meanwhile the server
// tries again after 5 minutes, twice as long each time it's still turned away (30 at most), and
// takes back over the moment the store answers it. (Until an admin's browser is actually
// searching it, the server keeps trying at its usual backoff: 15 minutes apart at most.)
const SERVER_TRIES = 3; // (1 at a store known to turn servers away: sweep.from 'browser')
const SERVER_RETRY_MS = 5 * 60 * 1000;
const SERVER_RETRY_MAX_MS = 30 * 60 * 1000;
// A store only struggling — too slow to answer, out of reach a moment, a 5xx that isn't 503, a page without its list (all
// likeliest at a drop, when it's busiest) — turns nobody away: it's searched again soon (at half its pace three times, then a
// minute apart at most), and an admin's browser stands in only once it's been like that this long with no answer (the server
// trying again a minute later, twice as long each time it's still struggling). A refusal (401/403/429/503, a bot check)
// backs off as ever. (Not at a store known to turn servers away: sweep.from 'browser' — there any miss is one.)
const TRANSIENT_HANDOVER_MS = 2 * 60 * 1000;
const TRANSIENT_RETRY_MS = 60 * 1000;
const TRANSIENT_MAX_MS = 60 * 1000;
const TRANSIENT_QUICK = 3;
const minutes = (ms) => `${Math.max(1, Math.round(ms / 60000))} min`;
/** "2 h 10 min", "45 min". */
const howLong = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`; };
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');

/** " (it was “Search results for: 'pokemon'”, 312 KB, 0 product links)" — what a page Mugibot couldn't read was. */
function seenText(seen) {
  if (!seen || typeof seen !== 'object') return '';
  const title = str(decodeEntities(String(seen.title || '')).replace(/\s+/g, ' ').trim(), 80);
  const bytes = num(seen.bytes, { min: 0, max: 1e9, int: true, def: null });
  const links = num(seen.links, { min: 0, max: 100000, int: true, def: null });
  const parts = [title ? `“${title}”` : 'a page with no title', bytes !== null ? `${Math.max(1, Math.round(bytes / 1024))} KB` : null, links !== null ? `${links} product link${links === 1 ? '' : 's'}` : null];
  return ` (it was ${parts.filter(Boolean).join(', ')})`;
}

/** A search, as a note says it: its words (not a member's own drop watch's: theirs alone), and its page after the first. */
function searchName(r, term) {
  const words = term.drop === 'private' ? "a drop watch's words" : `"${termLabel(term.keyword, r)}"`;
  return `${words}${term.page > 1 ? ` (page ${term.page})` : ''}`;
}

/**
 * A search that found nothing, said as it was: the store saying so ("BIG W has no results for …" — its page said
 * it, or its reader knows its empty page) — or, on a page Mugibot reads any way it can (sweep.parser 'generic'),
 * that nothing showed on it, the page saying neither way.
 */
function emptyText(r, term, parsed) {
  const said = parsed.none === true || (r.sweep.parser || 'generic') !== 'generic';
  return said ? `${r.name} has no results for ${searchName(r, term)}` : `No products showed on ${r.name}'s page for ${searchName(r, term)}`;
}

/** A page that said it had results ("57 results"), none of which Mugibot could see on it. */
function unreadText(r, term, stated, source) {
  const n = `${stated} result${stated === 1 ? '' : 's'}`;
  return source === 'browser' && r.sweep.render
    ? `${r.name}'s page said ${n} for ${searchName(r, term)}, but none were on it yet when Mugibot read it — it's read again next round`
    : `${r.name}'s page said ${n} for ${searchName(r, term)}, but not in the product list Mugibot reads — the store may have changed it`;
}

/**
 * Where a store is searched from unless an admin says otherwise: server first — or its own (sweep.mode: BIG W's
 * 'browser', an admin's browser in a private window of its own, as the server can never draw its products) —
 * and the dummy-store copies off.
 */
export function defaultModeOf(r) {
  return !r.sweep || r.demo || r.sweep.from === 'off' ? 'off' : MODES.includes(r.sweep.mode) ? r.sweep.mode : 'auto';
}
const REBASELINE_MS = 6 * 3600 * 1000;
// A search read again after a long gap (REBASELINE_MS) sets the scene anew — but the first few products in it
// nobody had seen still alert: what was listed while it was down (a store's drop overnight, its admins' browser
// turned away meanwhile). Never more than this many a read.
const GAP_NEW_ALERTS = 3;
// A product listed without a buy button in its search tile ("unknown": BIG W lists its drops ahead of time that
// way) and buyable there now is on sale now — once it's been listed without one this long (a tile whose button
// is drawn a moment late isn't a drop).
const UNKNOWN_SETTLE_MS = 10 * 60 * 1000;
// …or once it's been read without one this many times in a row, over at least this long: a drop listed a few minutes
// ahead of a 7 am sale (BIG W lists at 6:52, sells at 7:00) is on sale now too, not just one listed 10 minutes ahead.
const UNKNOWN_SETTLE_READS = 3;
const UNKNOWN_SETTLE_READS_MS = 2 * 60 * 1000;
// A store searched from admins' browsers none of whose searches has found any products this long (no browser
// searching it — Chrome closed, the computer asleep — or it turned them away: BIG W's "Access Denied"): its
// drops can't be seen, so its admins are told, once, and again when it's back.
const BLIND_MS = 20 * 60 * 1000;
// "Restock once a day": its first restock of the (Sydney) day — and another the same day only once it's been sold out this
// long first (a hot product's second wave: back at 13:30 after selling out at 9:04 — not a flicker), at most this many a day.
const RESTOCK_GAP_MS = 30 * 60 * 1000;
const RESTOCK_WAVES = 3;
const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th'];
const sydneyTime = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit', weekday: 'short' });
const MAX_BACKOFF_MS = 15 * 60 * 1000;
// After a store refuses a search, it's searched at a third of the pace for a while, even once it answers again.
const SLOW_MS = 10 * 60 * 1000;
const SLOW_FACTOR = 3;
// A store that leaves sold-out products out of its results: gone from every page this long = sold out.
const GONE_MS = 6 * 60 * 1000;
const HOUR = 3600 * 1000;
const ORDERABLE_FROM = new Set([STATUS.OUT_OF_STOCK, STATUS.COMING_SOON]);
// A store whose whole range comes back as one list (sweep.allPath: Kmart's trading cards, newest first):
// that list is the search — every keyword's products in it, so each is looked at every time — and this
// its keyword. It failing as a list (an answer that isn't one, not a refusal): each keyword's own search
// instead, for a while.
export const ALL = '*';
const ALL_LABEL = 'every trading card';
// A store that lists what it has just put on sale, newest first (sweep.newestPath: JB Hi-Fi's whole range by when each
// product was published): that list every few searches, between the keywords' searches — a drop is in it the moment
// the store publishes it, however far down any search it would sit (JB's search answers with its 10 most relevant: a new
// Pokémon product can miss them, Oct 2026). It holds every keyword's products, like the whole-range list, and this is its
// keyword. A product in it the store made long ago (republished, as JB does with older ones all day) and new to the
// catalogue is only noted, never alerted as a drop: it isn't one.
export const NEWEST = '+';
const NEWEST_LABEL = 'newest products';
const NEWEST_FRESH_MS = 14 * 24 * 3600 * 1000;
/** A search's keyword, as it's said: the whole-range and newest lists by name (a store's own name for its list: sweep.allLabel). */
const termLabel = (k, r = null) => (k === ALL ? (r && r.sweep && r.sweep.allLabel) || ALL_LABEL : k === NEWEST ? NEWEST_LABEL : k);
// Drop mode: a store where a new card listing has just been alerted (a read that wasn't setting its scene) is
// searched for what comes next there more often — drops come in waves (a set's booster box, then its ETB, its
// bundle…). Its newest products two searches in three (JB Hi-Fi, the card shops on Shopify), or, at a store whose
// search is newest first (sweep.hot: Target, EB Games), that keyword's first page every other search. Never faster:
// the same searches, in another order; never ahead of VIP drops or members' drop watches. For 15 minutes, each
// further new listing making it 15 from then — 30 at most, then not again for 15. (Admins can switch it off.)
const HOT_MS = 15 * 60 * 1000;
const HOT_MAX_MS = 30 * 60 * 1000;
const HOT_REST_MS = 15 * 60 * 1000;
const ALL_OFF_MS = 15 * 60 * 1000;
// Searches start on the set pace, however long the last one took to answer — at least this far apart.
const MIN_GAP_MS = 500;
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
    if (!MODES.includes(mode)) throw bad(`${r.name}: choose server first, server, browser or off`);
    // Only what differs from the store's default is kept, so a better default reaches everyone.
    if (mode !== defaultModeOf(r)) stores[id] = mode;
  }
  const tcgTerms = list(src.tcgTerms, { max: 80, maxLen: 40, lower: true });
  const notCardTerms = list(src.notCardTerms, { max: 120, maxLen: 40, lower: true });
  const tcgOnly = bool(src.tcgOnly, true);
  if (tcgOnly && !tcgTerms.length) throw bad('Add the words that make a product a trading-card product, or switch "Trading cards only" off');
  return {
    enabled,
    keywords,
    keywordsVersion: 2, // (ADDED_KEYWORDS offered: what's saved now is the admin's choice)
    termsVersion: 2, // (ADDED_TCG_TERMS offered too)
    modesVersion: 3, // stores: only the modes that differ from each store's default (server first, since 3)
    everySeconds: num(src.everySeconds, { min: 3, max: 600, int: true, def: SWEEP_DEFAULTS.everySeconds }),
    // (From 2 s: an admin's browser searches each store on its own — side by side — so its set pace is what each gets.)
    browserEverySeconds: num(src.browserEverySeconds, { min: 2, max: 600, int: true, def: SWEEP_DEFAULTS.browserEverySeconds }),
    stores,
    skipMarketplace: bool(src.skipMarketplace, true),
    tcgOnly,
    tcgTerms,
    notCardTerms,
    newAlerts: bool(src.newAlerts, true),
    restockAlerts: bool(src.restockAlerts, true),
    restockOncePerDay: bool(src.restockOncePerDay, true),
    priceAlerts: bool(src.priceAlerts, true),
    priceDropPercent: num(src.priceDropPercent, { min: 1, max: 90, def: SWEEP_DEFAULTS.priceDropPercent }),
    dropMode: bool(src.dropMode, true),
  };
}

const FILTER_KEYS = ['keywords', 'skipMarketplace', 'tcgOnly', 'tcgTerms', 'notCardTerms'];
const EVENTS_KEPT = 200;
const MODE_LABEL = { auto: "Mugibot's server first", server: "Mugibot's server", browser: "an admin's browser" };

export class Sweeper {
  constructor({ cfg, repo, catalog, feed, monitor, retailers, hub, fetchImpl = storeFetch, now = () => Date.now(), random = Math.random }) {
    Object.assign(this, { cfg, repo, catalog, feed, monitor, retailers, hub, fetch: fetchImpl, now, random });
    this.db = repo.db;
    this.running = false;
    this.loops = new Set();
    this.wakers = new Map();
    this.state = new Map(); // per store: rotation, recent requests, failures, browser lease
    this.collections = new Map(); // per Shopify store that's read by collection: its collections
    this.events = []; // the live event log's latest entries
    this.seq = 0;
    this.totals = { searches: 0, errors: 0, streak: 0 };
    this.ttns = []; // ms from a store's answer to the alert reaching dashboards, latest alerts
    this.unknownReads = new Map(); // product id → { n, since }: reads in a row without a buy button (UNKNOWN_SETTLE_READS)
    this.startedAt = null;
  }

  // ---------------------------------------------------------------------------
  // The live event log
  // ---------------------------------------------------------------------------
  /** One entry for the dashboards' event log, sent to every open dashboard of a member straight away. */
  emit(ev) {
    const e = { id: ++this.seq, at: this.now(), ...ev };
    this.events.push(e);
    if (this.events.length > EVENTS_KEPT) this.events.shift();
    this.feed.broadcast('sweep', e);
    return e;
  }

  sys(message, extra = {}) {
    return this.emit({ type: 'sys', message, ...extra });
  }

  noteAlert(alert) {
    if (alert && typeof alert.ttnMs === 'number') {
      this.ttns.push(alert.ttnMs);
      if (this.ttns.length > 50) this.ttns.shift();
    }
    return alert;
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  get settings() {
    const saved = this.repo.getSetting('sweep') || {};
    // (Saved before server first became every store's default: see ownModes.)
    const out = { ...SWEEP_DEFAULTS, ...saved, stores: saved.modesVersion >= 3 ? { ...(saved.stores || {}) } : this.ownModes(saved.stores) };
    // (Before priceAlerts existed, a price drop % of 0 meant no price drop alerts.)
    if (saved.priceDropPercent === 0 && saved.priceAlerts === undefined) Object.assign(out, { priceAlerts: false, priceDropPercent: SWEEP_DEFAULTS.priceDropPercent });
    // (Saved before Riftbound and Gundam were searched for: they're on the list too.)
    if (!(saved.keywordsVersion >= 2) && Array.isArray(saved.keywords)) out.keywords = [...new Set([...saved.keywords, ...ADDED_KEYWORDS])].slice(0, 12);
    // (Saved before the sealed-product words: they're on the list too.)
    if (!(saved.termsVersion >= 2) && Array.isArray(saved.tcgTerms)) out.tcgTerms = [...new Set([...saved.tcgTerms, ...ADDED_TCG_TERMS])].slice(0, 80);
    return out;
  }

  /**
   * Settings saved before server first: a real store set to the server or an admin's browser (its
   * old default, or chosen) is searched server first now — the server first, the browser standing in
   * while it's refused. Only a store switched off stays off. (The dummy-store copies keep theirs:
   * they're off unless switched on.)
   */
  ownModes(stores) {
    const out = {};
    for (const [id, mode] of Object.entries(stores && typeof stores === 'object' ? stores : {})) {
      const r = this.retailers.get(id);
      if (r && r.sweep && !r.demo && mode !== 'off') continue;
      out[id] = mode;
    }
    return out;
  }

  save(input, user) {
    const before = this.settings;
    const next = sweepSettings(input, before, this.retailers);
    this.repo.setSetting('sweep', next);
    // New keywords or filters: products they let in were already there, so the next sweeps set the scene again.
    if (FILTER_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]))) {
      this.db.run('UPDATE sweep_terms SET baseline_at = NULL');
      this.prune();
    }
    // (A store's whole-range and newest lists are kept: they hold every keyword's products.)
    this.db.run(`DELETE FROM sweep_terms WHERE keyword NOT IN ('${ALL}', '${NEWEST}') AND keyword NOT IN (${next.keywords.map((_, i) => `:k${i}`).join(', ') || "''"})`, Object.fromEntries(next.keywords.map((k, i) => [`k${i}`, k])));
    this.repo.audit(user ? user.id : null, null, 'sweep-settings', `${next.enabled ? 'on' : 'off'}: ${next.keywords.join(', ')}`);
    // (A store no longer server first: nothing stands in for the server there.)
    for (const { retailer: r, mode } of this.stores()) {
      const st = this.state.get(r.id);
      if (st && mode !== 'auto' && st.backup) Object.assign(st, { backup: null, serverMisses: 0 });
    }
    const changed = Object.keys(next).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
    if (changed.length) {
      const what = changed.includes('keywords') ? `keywords: ${next.keywords.join(', ')}` : changed.includes('enabled') ? (next.enabled ? 'sweeps on' : 'sweeps off')
        : changed.includes('everySeconds') ? `a search every ${next.everySeconds} s at each store` : 'settings changed';
      this.sys(`${user ? user.username : 'An admin'} changed the sweeps — ${what}`);
    }
    this.restart();
    return next;
  }

  /**
   * Where a store is swept from: 'auto' (server first, an admin's browser standing in while the server's
   * refused), 'server', 'browser' or 'off'. The dummy-store copies are off unless switched on.
   */
  modeFor(r) {
    const s = this.settings;
    if (!s.enabled || !r || !r.sweep || !this.retailers.enabled(r)) return 'off';
    const m = s.stores[r.id];
    if (MODES.includes(m)) return m;
    return this.defaultMode(r);
  }

  /** Where a store is searched from unless an admin says otherwise: server first (dummy-store copies: off). */
  defaultMode(r) {
    return defaultModeOf(r);
  }

  /** Who's searching a store right now: 'server' or 'browser' (server first: the browser while it stands in). */
  sourceOf(r, mode = this.modeFor(r)) {
    if (mode === 'off') return null;
    return mode === 'browser' || (mode === 'auto' && this.stat(r.id).backup) ? 'browser' : 'server';
  }

  /** Every store with sweeps, and where it's swept from. */
  stores() {
    return this.retailers.list.filter((r) => r.sweep && r.id !== 'other').map((r) => ({ retailer: r, mode: this.modeFor(r) }));
  }

  stat(id) {
    let s = this.state.get(id);
    if (!s) {
      // backup: server first, an admin's browser standing in ({ since, retryAt, tries, why, waitUntil }).
      // nextPages: '<keyword>\n<page>' → the link on that page to the next one (sweep.followNext: BIG W's).
      s = { turn: 0, deep: 0, fails: 0, log: [], lastAt: null, lastOkAt: null, lastError: '', browserNext: 0, nextAt: null, slowUntil: 0, firstOkAt: null, backup: null, serverMisses: 0, browserAt: 0, askedAt: 0, nextPages: new Map() };
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

  /**
   * Shopify stores that list each game in a collection of its own (Trainer Town): a keyword's whole
   * range is that collection, read whole in one go (sold-out products too), instead of a search
   * that shows the first 10. The store's collections are looked up from its collection list
   * (every 6 hours); a keyword with no collection of its own is searched as usual.
   */
  async refreshCollections(r) {
    if (!r.sweep.collectionPath || !r.sweep.collectionsPath) return;
    const now = this.now();
    const c = this.collections.get(r.id);
    if (c && now < c.nextAt) return;
    this.collections.set(r.id, { list: c ? c.list : [], nextAt: now + 10 * 60 * 1000 });
    try {
      const url = `${r.base}${r.sweep.collectionsPath}`;
      const timeoutMs = Math.min(this.cfg.monitor.timeoutMs, 20000);
      const res = await safeFetch(this.fetch, url, { headers: this.headers(r), timeoutMs, signal: AbortSignal.timeout(timeoutMs) }, { allowPrivate: this.cfg.monitor.allowPrivateHosts });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = JSON.parse(await res.text());
      if (!j || !Array.isArray(j.collections)) throw new Error('no collection list');
      const list = j.collections.filter((x) => x && typeof x.handle === 'string' && /^[a-z0-9][a-z0-9-]{0,120}$/i.test(x.handle))
        .map((x) => ({ handle: x.handle, title: str(x.title, 120), count: Number(x.products_count) || 0 }));
      const before = c ? c.list.map((x) => x.handle).join() : '';
      this.collections.set(r.id, { list, nextAt: now + REBASELINE_MS });
      if (before !== list.map((x) => x.handle).join()) {
        const used = this.settings.keywords.map((k) => [k, this.collectionFor(r, k)]).filter(([, h]) => h);
        if (used.length) this.sys(`${r.name}: reading each game's whole collection — ${used.map(([k, h]) => `"${k}" → ${h}`).join(', ')}`, { store: r.id });
      }
    } catch (e) {
      this.cfg.log(JSON.stringify({ evt: 'sweep.collections', store: r.id, error: e.message }));
    }
  }

  /**
   * The store's own collection for a keyword: the biggest one named after it (that one read holds whole) — one
   * its sweep prefers first (collectionPrefer: From The Deep Games' "Sealed" ones), never one it skips
   * (collectionSkip: its 30,000 singles).
   */
  collectionFor(r, keyword) {
    const c = r.sweep.collectionPath && this.collections.get(r.id);
    if (!c) return null;
    const max = r.sweep.collectionMax || 250;
    const skip = (x) => !!r.sweep.collectionSkip && r.sweep.collectionSkip.test(`${x.title} ${x.handle}`);
    const prefer = (x) => (r.sweep.collectionPrefer && r.sweep.collectionPrefer.test(`${x.title} ${x.handle}`) ? 1 : 0);
    const named = c.list.filter((x) => x.count > 0 && !skip(x) && (mentions(x.title, keyword) || mentions(x.handle.replace(/-/g, ' '), keyword)))
      .sort((a, b) => prefer(b) - prefer(a) || b.count - a.count);
    return named.length && named[0].count <= max ? named[0].handle : null;
  }

  /** vip: a VIP or drop watch's words (monitor/vip.js, monitor/drops.js) — searched as they are, never "+ tcg". */
  urlFor(r, keyword, page = 1, { vip = false } = {}) {
    // The store's whole range in one list (Kmart's: from its search provider, like its own keyword searches).
    if (keyword === NEWEST && r.sweep.newestPath) return `${r.base}${r.sweep.newestPath}`;
    if (keyword === ALL && r.sweep.allPath) {
      const p = `${r.sweep.allPath}${page > 1 && r.sweep.pagePath ? r.sweep.pagePath.replace('{page}', String(page)) : ''}`;
      return `${r.sweep.apiBase || r.base}${p}`;
    }
    // A later page at a store whose page links to its next one (sweep.followNext: BIG W's): where that link goes.
    if (page > 1 && r.sweep.followNext && !vip) {
      const known = this.stat(r.id).nextPages.get(`${keyword}\n${page - 1}`);
      if (known) return known;
    }
    // A keyword's second page at a store that has one list of its newest products (sweep.feedPath:
    // Pokébox's): that list, whatever the keyword — it's read for the keyword's products in it. (Its first
    // page a whole collection or a search.)
    if (page > 1 && r.sweep.feedPath && !vip) return `${r.base}${r.sweep.feedPath}`;
    const collection = !vip && this.collectionFor(r, keyword);
    if (collection) return `${r.base}${r.sweep.collectionPath.replace('{collection}', encodeURIComponent(collection))}`;
    // (A VIP or drop watch's words are searched as they are — at a store whose search is kept to its
    // trading cards for the card keywords (Kmart's), across the whole store: sweep.wordsPath.)
    let p = (vip && r.sweep.wordsPath ? r.sweep.wordsPath : r.sweep.path).replace('{q}', encodeURIComponent(vip ? keyword : this.query(r, keyword)));
    if (page > 1 && r.sweep.pagePath) p += r.sweep.pagePath.replace('{page}', String(page));
    // (A store whose search is answered by its search provider: Kmart's, at Constructor.io. Or by
    // the site's own API, outside the region's pages: Premium Bandai's /api/search, not /au/….)
    return `${r.sweep.apiBase || (r.sweep.fromOrigin && !r.demo ? new URL(r.base).origin : r.base)}${p}`;
  }

  /**
   * The time between two searches at a store: the set pace, or the store's own slowest (Amazon: 20 s) — and from an
   * admin's browser, a store that asks for slower only while it's read in an ordinary window (BIG W's 20 s,
   * sharedWindowSeconds: there it shares its cookies with your own visits) at the set pace once it's read in its
   * private window.
   */
  paceFor(r, browser = false) {
    const s = this.settings;
    const shared = browser && r.sweep.sharedWindowSeconds && !this.inPrivate(r) ? r.sweep.sharedWindowSeconds : 0;
    const every = Math.max(browser ? s.browserEverySeconds : s.everySeconds, r.sweep.minSeconds || 0, shared) * 1000;
    // A VIP drop in its window (monitor/vip.js): its words, every few seconds — at a store whose search is one big
    // list whatever the words (Gamerholic's newest 100), no faster than its own VIP pace (sweep.vipMinSeconds).
    if (!browser && this.vip && this.vip.fast(r.id, this.now())) return Math.min(every, Math.max(this.vip.sweepSeconds, r.sweep.vipMinSeconds || 0) * 1000);
    return every;
  }

  /** Is the store read in a private window of its own (BIG W's), as an admin's browser last said? (Not known yet: no.) */
  inPrivate(r) {
    return !!r && !!r.sweep && !!r.sweep.privateWindow && this.stat(r.id).privateWindow === true;
  }

  /**
   * The next search at a store: the first page of each keyword in turn (where new drops show up),
   * and after each round one of the later pages (so everything listed is re-read every minute or so).
   */
  nextTerm(r, { all = true } = {}) {
    const st = this.stat(r.id);
    const now = this.now();
    // VIP watches at this store (monitor/vip.js): every other search — in a drop window, two searches in three, the
    // third the store's own as usual (its drop watches' words, newest products, keywords: a store with a VIP drop on
    // is still searched for everything else, and its newest products and whole list still count VIP finds); once
    // every watch's drop window there is over, one in three.
    const vip = this.vip ? this.vip.termsFor(r.id) : [];
    if (vip.length) {
      const fast = vip.filter((w) => this.vip.inWindow(w, now));
      const over = !fast.length && vip.every((w) => !!w.dropAt && now > w.dropAt + VIP_AFTER_MS);
      const turn = (st.vipTurn = (st.vipTurn || 0) + 1);
      if (fast.length ? turn % 3 !== 0 : over ? turn % 3 === 1 : turn % 2 === 1) {
        const list = fast.length ? fast : vip;
        const w = list[(st.vipNext = (st.vipNext || 0) + 1) % list.length];
        return { keyword: w.words, page: 1, vip: w.id };
      }
    }
    // Drop watches' words at this store (monitor/drops.js): one search in three at most.
    const drop = this.drops ? this.drops.nextTerm(r, st) : null;
    if (drop) return drop;
    const hot = this.hotAt(r, now);
    // The store's newest products (sweep.newestPath): every few searches (newestEvery), the keywords' in between — two
    // in three in drop mode. (The server's — and an admin's browser's at a store whose list it can read the same way:
    // sweep.newestBrowser, the card shops'. Elsewhere a browser searches each keyword, as it always has.)
    if (r.sweep.newestPath && (all || r.sweep.newestBrowser)) {
      if (hot) {
        st.hotTurn = ((st.hotTurn || 0) + 1) % 3;
        if (st.hotTurn !== 0) return { keyword: NEWEST, page: 1 };
      } else {
        st.newestTurn = ((st.newestTurn || 0) + 1) % Math.max(2, r.sweep.newestEvery || 2);
        if (st.newestTurn === 1) return { keyword: NEWEST, page: 1 };
      }
    }
    // A store whose whole range comes back as one list (sweep.allPath): that list, every search — each
    // product looked at every time, not one keyword in turn. Its later pages, when it has more than one,
    // one search in four. (Off for a while after it fails as a list — sweepTerm: each keyword instead.)
    if (all && r.sweep.allPath && !(st.allOffUntil > this.now())) {
      const first = this.db.get('SELECT total, found FROM sweep_terms WHERE store = :s AND keyword = :k AND page = 1', { s: r.id, k: ALL });
      const pages = first && first.found && first.total > first.found ? Math.min(10, Math.ceil(first.total / first.found)) : 1;
      st.allTurn = ((st.allTurn || 0) + 1) % 4;
      if (pages > 1 && st.allTurn === 0) return { keyword: ALL, page: 2 + ((st.allDeep = (st.allDeep || 0) + 1) % (pages - 1)), all: true };
      return { keyword: ALL, page: 1, all: true };
    }
    const kws = this.settings.keywords;
    // Drop mode at a store whose search is newest first (sweep.hot): the keyword a new listing just came up for, its
    // first page every other search (the other one goes round as usual, later pages too).
    if (hot && hot.keyword && kws.includes(hot.keyword)) {
      st.hotTurn = ((st.hotTurn || 0) + 1) % 2;
      if (st.hotTurn === 1) return { keyword: hot.keyword, page: 1 };
    }
    const pages = Math.max(1, Math.min(10, r.sweep.pages || 1));
    const deep = [];
    for (const keyword of kws) {
      // Only the pages that have results (the first page says how many there are).
      const first = pages > 1 ? this.db.get('SELECT total, found FROM sweep_terms WHERE store = :s AND keyword = :k AND page = 1', { s: r.id, k: keyword }) : null;
      // (A store whose second page is its newest-products list: that's always there.)
      const has = r.sweep.feedPath ? pages : first && first.total && first.found ? Math.ceil(first.total / first.found) : pages;
      for (let page = 2; page <= Math.min(pages, has); page++) {
        // (A store whose page links to its next one: only the pages it linked to.)
        if (r.sweep.followNext && !st.nextPages.has(`${keyword}\n${page - 1}`)) break;
        deep.push({ keyword, page });
      }
    }
    const round = kws.length + (deep.length ? 1 : 0);
    const slot = st.turn++ % round;
    if (slot < kws.length) return { keyword: kws[slot], page: 1 };
    return deep[st.deep++ % deep.length];
  }

  /**
   * A store in drop mode now: { newest } at a store with a newest-products list, { keyword } at one whose search is
   * newest first (sweep.hot) — or null. (Over: said once in the live log.)
   */
  hotAt(r, now = this.now()) {
    const st = this.stat(r.id);
    const h = st.hot;
    if (!h || !h.until) return null;
    if (now < h.until && this.settings.dropMode !== false) return h;
    if (h.until) {
      this.sys(`${r.name}: drop mode over — searched as usual again`, { store: r.id });
      st.hot = { restUntil: now + HOT_REST_MS };
    }
    return null;
  }

  /**
   * A new card listing just alerted at a store, in a read that wasn't setting its scene (keyword: the search's, null
   * for its newest products): drop mode there, or 15 more minutes of it — 30 at most, then a rest of 15.
   */
  heat(r, keyword, now = this.now()) {
    if (this.settings.dropMode === false) return;
    const newest = !!r.sweep.newestPath;
    if (!newest && !(r.sweep.hot && keyword)) return;
    const st = this.stat(r.id);
    // (One that's just over ends here: its rest starts.)
    const live = this.hotAt(r, now);
    if (live) {
      live.until = Math.min(live.since + HOT_MAX_MS, now + HOT_MS);
      if (!newest && keyword) live.keyword = keyword;
      return;
    }
    if (st.hot && st.hot.restUntil > now) return;
    st.hot = { since: now, until: now + HOT_MS, newest, keyword: newest ? null : keyword };
    st.hotTurn = 0;
    this.sys(`${r.name}: a new listing just came up — drop mode for 15 minutes: ${newest ? 'its newest products two searches in three' : `"${keyword}" every other search`} (same pace, no extra requests)`, { store: r.id });
  }

  headers(r) {
    // (A store whose own page asks for JSON — EB Games', Premium Bandai's — is asked for JSON, with the
    // headers its code sends: Premium Bandai's region. Never anything that hides who's asking.)
    const json = /^shopify/.test(r.sweep.parser) || (!!r.sweep.inPage && (r.sweep.expect || 'json') === 'json');
    return {
      ...(r.sweep.headers || {}),
      'user-agent': this.cfg.monitor.userAgent,
      accept: json ? 'application/json' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-AU,en;q=0.9',
    };
  }

  /** One search from the server: fetch, read, compare, alert. */
  async sweepTerm(r, term) {
    await this.refreshCollections(r);
    const url = this.urlFor(r, term.keyword, term.page, { vip: !!(term.vip || term.drop) });
    const started = Date.now();
    let res;
    let text = '';
    try {
      const timeoutMs = Math.min(this.cfg.monitor.timeoutMs, 20000);
      res = await safeFetch(this.fetch, url, { headers: this.headers(r), timeoutMs, signal: AbortSignal.timeout(timeoutMs) }, { allowPrivate: this.cfg.monitor.allowPrivateHosts });
      if (res.ok) text = await res.text();
    } catch (e) {
      const blocked = e instanceof BlockedUrlError;
      const error = blocked ? e.message : e.name === 'TimeoutError' ? 'The store took too long to answer' : "Couldn't reach the store";
      return this.record(r, term, { ok: false, transient: !blocked, url, source: 'server', ms: Date.now() - started, error });
    }
    const ms = Date.now() - started;
    // (The whole-range list answered, but not with a list: each keyword's own search instead, now — unless that's the
    //  same list, Gamerholic's, whose search is its newest products whatever the words: then it failed as any search does.)
    const fallback = term.keyword === ALL && this.urlFor(r, this.settings.keywords[0] || '', 1) !== url;
    if (fallback && !res.ok && ![401, 403, 429, 503].includes(res.status)) return this.allFailed(r, `HTTP ${res.status}`);
    if (!res.ok) {
      const refused = [401, 403, 429, 503].includes(res.status);
      // "Too many requests" / "unavailable" often come with how long to wait: no search before then.
      const wait = retryAfterMs(res.headers && res.headers.get('retry-after'), this.now());
      // (While an admin's browser stands in for the server, it's the server's next try that waits.)
      const st = this.stat(r.id);
      if (refused && wait) { if (this.standIn(r, st)) st.backup.waitUntil = this.now() + wait; else st.retryAt = this.now() + wait; }
      return this.record(r, term, {
        ok: false, blocked: refused, transient: !refused && res.status >= 500, url, source: 'server', ms,
        error: refused ? `The store refused the search (HTTP ${res.status})${wait ? ` — it asked to wait ${Math.ceil(wait / 1000)} s` : ''}` : `HTTP ${res.status}`,
      });
    }
    const parsed = parseListing(r.sweep.parser, text, { base: url, storeBase: r.base, productPath: r.productPath, skuFromPath: r.skuFromPath, storeName: r.name });
    if (fallback && parsed.problem !== 'blocked' && (parsed.problem === 'layout' || !parsed.products.length)) {
      return this.allFailed(r, parsed.problem === 'layout' ? "it wasn't the product list Mugibot reads" : 'no products in it');
    }
    const title = /<title[^>]*>([^<]{0,300})/i.exec(text);
    return this.ingest(r, term, parsed, { source: 'server', url, ms, seen: { title: title ? title[1] : '', bytes: text.length } });
  }

  /**
   * The store's whole-range list didn't come back as a list (not a refusal: that's the store's, like any
   * search's): each keyword's own search instead for 15 minutes — the next one straight away, so no
   * search is missed — then the list again. Said in the live log.
   */
  async allFailed(r, why) {
    const st = this.stat(r.id);
    st.allOffUntil = this.now() + ALL_OFF_MS;
    this.cfg.log(JSON.stringify({ evt: 'sweep.all_off', store: r.id, error: why }));
    this.sys(`${r.name}: its whole range didn't come back as one list (${why}) — searching each keyword instead for 15 minutes`, { store: r.id, level: 'warn' });
    return this.sweepTerm(r, this.nextTerm(r));
  }

  /**
   * Which products count (from MugiWatch): the keyword in the name, trading cards only, not a marketplace seller.
   * cardsOnly: a read that's already only trading cards (Kmart's Trading Cards list, a game's own collection): there a
   * card word isn't needed — only the keyword, and not one of the not-cards words. legacy: as before the card words
   * widened (no added words, no set codes, no card-only reads).
   */
  filters(s = this.settings, { cardsOnly = false, legacy = false } = {}) {
    const tcg = s.tcgOnly ? termsRegex(legacy ? (s.tcgTerms || []).filter((t) => !ADDED_TCG_TERMS.includes(t)) : s.tcgTerms) : null;
    const notCard = s.tcgOnly ? termsRegex(s.notCardTerms || []) : null;
    const scoped = cardsOnly && !legacy;
    return (p, keyword) => {
      const name = norm(p.title || p.name);
      if (!mentions(name, keyword)) return false;
      if (s.skipMarketplace && p.marketplace) return false;
      if (tcg && !scoped && !tcg.test(name) && (legacy || !CARD_CODE_RE.test(name))) return false;
      if (notCard && notCard.test(name) && !CARD_SURE_RE.test(name)) return false;
      return true;
    };
  }

  /** Is a read only trading cards already (cardsOnly: Kmart's Trading Cards list and search; a game's own collection)? */
  cardsOnlyRead(r, term) {
    if (term.vip || term.drop) return false;
    return !!r.sweep.cardsOnly || (term.keyword !== ALL && term.keyword !== NEWEST && !!this.collectionFor(r, term.keyword));
  }

  /** The card words widened lately (an update): what they let in that wasn't counted before is tracked quietly at first. */
  widenedLately(now = this.now()) {
    const at = Number(this.repo.getSetting('sweepWidenedAt')) || 0;
    return at > 0 && now - at < WIDENED_QUIET_MS;
  }

  /** Products the sweeps tracked that no longer count (the filters changed): out of the list, unless monitored. */
  prune() {
    const s = this.settings;
    const counts = this.filters(s);
    const scoped = this.filters(s, { cardsOnly: true });
    const rows = this.db.all(`SELECT p.id, p.name, p.store, p.sweep_keyword FROM products p LEFT JOIN monitors m ON m.product_id = p.id
      WHERE p.sweep_seen_at IS NOT NULL AND m.id IS NULL`);
    let n = 0;
    for (const p of rows) {
      const kws = s.keywords.includes(p.sweep_keyword) ? [p.sweep_keyword] : s.keywords;
      // (A store whose searches are only trading cards — Kmart's: a card word isn't needed there.)
      const r = this.retailers.get(p.store);
      const fits = r && r.sweep && r.sweep.cardsOnly ? scoped : counts;
      if (!kws.some((k) => fits({ title: p.name }, k))) {
        this.db.run('UPDATE products SET sweep_seen_at = NULL WHERE id = :id', { id: p.id });
        n += 1;
      }
    }
    return n;
  }

  /**
   * A whole-range or newest list (term) read for the first time under its own name, at the URL every keyword's own
   * search read lately (each keyword's products in it tracked on its turn): the scene is set already.
   */
  readByEveryKeyword(r, term, url, now) {
    if (term.keyword !== ALL && term.keyword !== NEWEST) return false;
    const rows = this.db.all(`SELECT keyword, baseline_at, last_ok_at FROM sweep_terms WHERE store = :s AND url = :u AND keyword NOT IN ('${ALL}', '${NEWEST}')`, { s: r.id, u: url });
    const kws = this.settings.keywords;
    return kws.length > 0 && kws.every((k) => rows.some((x) => x.keyword === k && x.baseline_at && x.last_ok_at && now - x.last_ok_at <= REBASELINE_MS));
  }

  /** What one search found. parsed: { products, total, problem } */
  async ingest(r, term, parsed, { source, url, ms = null, seen = null, way = source }) {
    // A person's check in an admin's browser: only that person passes it (Mugibot never answers one).
    if (parsed.problem === 'blocked') {
      return this.record(r, term, {
        ok: false, blocked: true, url, source, ms,
        error: source === 'browser' ? `The store showed its bot check in the admin's browser — open ${r.name} in that browser and pass the check yourself, once (searches back off meanwhile)` : 'The store showed a bot check instead of results',
      });
    }
    // (What the page was — its title and size — so whoever looks can tell what the store sent.)
    if (parsed.problem === 'layout') return this.record(r, term, { ok: false, transient: source === 'server', url, source, ms, error: `The page didn't have the product list Mugibot reads — the store may have changed it${seenText(seen)}` });
    const s = this.settings;
    const now = this.now();
    const row = this.db.get('SELECT * FROM sweep_terms WHERE store = :s AND keyword = :k AND page = :p', { s: r.id, k: term.keyword, p: term.page });
    // Server first: no products where there are some — a page that draws them once it's open (BIG W's),
    // or this search found some from an admin's browser in the last hour — isn't an answer. It's a
    // miss (serverFirst), and sets no scene: what the browser reads next isn't all "new".
    if (source === 'server' && !parsed.products.length && this.modeFor(r) === 'auto'
      && (r.sweep.render || (!!row && row.source === 'browser' && row.found > 0 && !!row.last_ok_at && now - row.last_ok_at < HOUR))) {
      return this.record(r, term, { ok: false, empty: true, url, source, ms, error: r.sweep.render ? "Mugibot's server can't read the products: they only show once the store's page has run" : "Mugibot's server got no products, where an admin's browser finds some" });
    }
    // A page that says it has results (BIG W's "57 results") none of which were on it when it was read — not drawn
    // yet: not an answer (no scene set, nothing marked gone, no "no products"), and said as it is. It's read again
    // next round at the usual pace: the store didn't turn anyone away.
    if (parsed.problem === 'unread') return this.record(r, term, { ok: false, unread: true, url, source, ms, error: unreadText(r, term, parsed.stated, source) });
    // (Read somewhere else than before, e.g. a collection instead of the search: what's there already was. A list read
    //  for the first time under its own name that every keyword read lately — the card shops' newest products, once each
    //  keyword's second page; Gamerholic's, once each keyword's search: what's new in it is new.)
    const baseline = !row ? !this.readByEveryKeyword(r, term, url, now)
      : !row.baseline_at || !row.last_ok_at || now - row.last_ok_at > REBASELINE_MS || (!!row.url && row.url !== url);
    // (Read again after a long gap, not for the first time: the first few new products in it still alert.)
    const gapNew = baseline && !!row && !!row.baseline_at && !!row.last_ok_at && now - row.last_ok_at > REBASELINE_MS && !(row.url && row.url !== url) ? { left: GAP_NEW_ALERTS } : null;
    // (The last later page read at a store whose results are by relevance — BIG W's page 3: a product new to it may
    //  only have moved up from the page after, so it's tracked, not alerted as a drop. One listed ahead of time
    //  still alerts the moment it's on sale.)
    const edge = !!r.sweep.followNext && term.page > 1 && term.page >= Math.min(10, r.sweep.pages || 1);
    const counts_ = this.filters(s, { cardsOnly: this.cardsOnlyRead(r, term) });
    // (The card words widened lately: what counts now that didn't before, and new to the catalogue, is tracked quietly.)
    const legacy = this.widenedLately(now) ? this.filters(s, { legacy: true }) : null;
    const counts = { found: parsed.products.length, kept: 0, new: 0, restock: 0, price: 0 };
    // The whole range (or its newest products) in one list: each product counts for the first keyword in its name.
    const all = term.keyword === ALL || term.keyword === NEWEST;
    const newest = term.keyword === NEWEST;
    const st = this.stat(r.id);
    if (all && st.allOffUntil) {
      st.allOffUntil = 0;
      this.sys(`${r.name}: its whole range comes back as one list again`, { store: r.id });
    }
    // Fastest first: as each product is read, its watchers' Auto-checkout runs (members); then its channel
    // alerts, sent without waiting on one another (posting); the members' own DMs once those are out (later).
    const later = [];
    const posting = [];
    let cardsNew = 0;
    // A VIP or drop watch's own words: this read is that watch's own (each with those words) — part of its first look
    // there while that's going (monitor/sightings.js). whole: it holds every result the store has for them. way: how it
    // was read (an admin's browser asking the same address as the server is the server's way).
    const mine = term.vip || term.drop ? this.watchesNamed(r.id, term.keyword) : [];
    const own = (w) => mine.some((x) => x.id === w.id);
    const whole = holdsAll(parsed, pageSizeIn(url));
    const codesIn = parsed.products.map((p) => [p.sku, ...(p.aliases || [])].filter(Boolean));
    // (A new card listing is one an old product moving up into view can't be: in a read that holds every result; in the
    //  newest products of a store that never republishes old ones; or, in a search the store sorts newest first, above a
    //  product the catalogue already had — what comes up from below lands under everything that was in view.)
    const knownBelow = [];
    if (r.sweep.newestFirst) {
      let any = false;
      for (let i = codesIn.length - 1; i >= 0; i--) {
        knownBelow[i] = any;
        any = any || codesIn[i].some((k) => !!this.catalog.productFor(r.id, k));
      }
    }
    try {
      for (const [i, p] of parsed.products.entries()) {
        // (In stock in the store's shops only — Kmart's "In store only": a status of its own, never ordered online.)
        const status = p.inStock === true ? (p.inStoreOnly ? STATUS.IN_STORE : p.preorder ? STATUS.PREORDER : STATUS.IN_STOCK) : p.inStock === false ? STATUS.OUT_OF_STOCK : null;
        // Members' own SKUs, whatever they are.
        await this.members(r, p, status, later);
        // A store whose list says who sells it (JB Hi-Fi's newest products: a "Seller" option naming its marketplace
        // seller(s), none on its own): that — no asking its product page before the alert, in a drop.
        if (r.sweep.sellers && Array.isArray(p.sellers)) {
          p.marketplace = p.sellers.length > 0 && !p.sellers.some((n) => r.sweep.sellers.own.test(n));
          p.seller = p.marketplace ? p.sellers.join(', ').slice(0, 200) : '';
        }
        // A store whose search doesn't say who sells what (JB Hi-Fi): what Mugibot found out before.
        if (r.sweep.sellers && !p.marketplace) {
          const known = this.catalog.productFor(r.id, p.sku);
          if (known && known.seller) p.marketplace = true;
        }
        const title = p.title || p.name;
        const mkt = s.skipMarketplace && p.marketplace;
        const keyword = all ? s.keywords.find((k) => counts_(p, k)) || null : term.keyword;
        const cards = !term.vip && !term.drop && (all ? !!keyword : counts_(p, term.keyword));
        // (A card search's new listing — new to the catalogue, in a read that isn't setting its scene: a drop for a
        //  drop watch whose words are in its name too, whichever search found it first.)
        const before = [p.sku, ...(p.aliases || [])].map((k) => this.catalog.productFor(r.id, k)).find(Boolean) || null;
        const known = !!before;
        // (In the newest products, one the store made long ago and new to the catalogue: at a store that republishes old
        //  products all day (JB Hi-Fi), noted, not a drop. At one whose list is only what it's just put up — sweep.newestFresh
        //  false, the card shops: a drop drafted weeks before still alerts — a card product in it is new whenever it was
        //  made, and anything else that old still isn't a drop for a drop watch.)
        const old = newest && !known && typeof p.createdAt === 'number' && now - p.createdAt > NEWEST_FRESH_MS;
        const republished = old && r.sweep.newestFresh !== false;
        // (…and one it's just published, cards or not: a drop for a drop watch whose words are in its name — the newest
        //  products may see it before the watch's own search does.)
        const quiet = !!legacy && cards && !known && !(all ? s.keywords.some((k) => legacy(p, k)) : legacy(p, term.keyword));
        const newListing = this.drops && (cards ? !republished : newest && !old) && !baseline && !edge && !mkt && !known && !quiet;
        // What each VIP and drop watch at this store saw of it (monitor/sightings.js): what its Auto-checkout buys. (A new
        // card listing — the card search's 🆕 — wasn't listed when this search last read: new to every watch added by then.)
        // (Not on the last page read of a search that has several — a product new there may only have come up from the page
        //  after it, at any store.)
        const lastPage = term.page > 1 && term.page >= Math.min(10, r.sweep.pages || 1);
        const intoView = !(whole || (newest && r.sweep.newestFresh === false) || !!knownBelow[i]);
        const newCard = cards && !known && !baseline && !edge && !lastPage && !intoView && !republished && !quiet && !mkt && !!row && !!row.last_ok_at;
        const seen = mkt ? new Map() : this.sight(r, p, { title, status, own, way, before, newSince: newCard ? row.last_ok_at : null, now });
        const verdict = (w) => (seen.get(w.id) || {}).verdict || 'pending';
        // (Alerts: listed already as far as a drop watch knows — found by another search than its own words', unless it's
        //  new; or seen by the watch before.)
        const dropDone = (w) => baseline || !this.drops.baseAt(w, r.id) || (term.keyword !== w.words && !newListing) || (!!seen.get(w.id) && seen.get(w.id).before !== null);
        // Someone's own drop watch's words in the name (monitor/drops.js): on their watchlist, theirs alone.
        if (this.drops && !mkt) {
          for (const w of this.drops.ownFor(r.id, title)) {
            await this.drops.foundOwn(w, r, p, status, { baseline: dropDone(w), verdict: verdict(w), later }).catch((e) => this.cfg.log('[drops]', e.message));
          }
        }
        // A VIP watch's words in the name (monitor/vip.js): it counts, trading cards or not.
        const watch = this.vip ? this.vip.matchFor(r.id, title, term.vip || null) : null;
        // An admin's drop watch for everyone (monitor/drops.js): it counts too, in #non-tcg-alerts.
        const drop = this.drops && !term.vip ? this.drops.sharedFor(r.id, title, term.drop ? term.keyword : null) : null;
        const counted = cards || ((!!watch || !!drop) && !mkt);
        if (!counted || this.catalog.isBlocked(r.id, p.sku, p.aliases)) continue;
        counts.kept += 1;
        // (Only a drop watch's: listed already, unless its own words' search found it after its first look — or it's new.)
        const dropBaseline = !!drop && dropDone(drop);
        const dropOnly = !!drop && !cards && !watch;
        // (Found by its words alone in the whole-range list: those words, as their own search would say.)
        const found = keyword || (watch && watch.words) || (drop && drop.words) || termLabel(term.keyword, r);
        const ev = await this.track(r, p, { status, keyword: found, baseline: dropOnly ? dropBaseline : baseline || edge || republished || quiet, gapNew: dropOnly || edge || republished || quiet ? null : gapNew, now, vip: !!watch, drop: dropOnly, category: drop && !cards ? drop.category : null, dropWatch: drop ? drop.id : null, posting });
        for (const k of ev) counts[k] += 1;
        if (cards && ev.includes('new')) cardsNew += 1;
        const product = () => [p.sku, ...(p.aliases || [])].map((k) => this.catalog.productFor(r.id, k)).find(Boolean);
        // (Armed by what the watch saw of it: something on sale before the watch is never bought, whichever search comes first.)
        if (watch) await this.vip.found(watch, product(), { verdict: verdict(watch), status, later }).catch((e) => this.cfg.log('[vip]', e.message));
        if (drop) await this.drops.foundShared(drop, product(), { baseline: dropBaseline, verdict: verdict(drop), status, later }).catch((e) => this.cfg.log('[drops]', e.message));
      }
      // (One more read of each own watch's first look, while that's going.)
      if (this.sightings) for (const w of mine) this.sightings.ownRead(w, r.id, { whole, codes: codesIn, how: way });
      // A new card listing in a read that isn't setting its scene (not a VIP or drop watch's own search): drop mode.
      if (cardsNew && !baseline && !term.vip && !term.drop) this.heat(r, all ? null : term.keyword, now);
      await Promise.allSettled(posting);
      const out = this.record(r, term, { ok: true, url, source, ms, baseline, total: parsed.total ?? null, ...counts, error: parsed.problem === 'empty' ? emptyText(r, term, parsed) : '' });
      // (Its newest products read under their own name for the first time, at a store with no later pages: the second
      //  pages they were read as before — the card shops' — are no longer searched, so they leave its list of searches.)
      if (!row && newest && (r.sweep.pages || 1) <= 1) this.db.run('DELETE FROM sweep_terms WHERE store = :s AND page > 1', { s: r.id });
      out.gone = all ? 0 : await this.markGone(r, term.keyword, now);
      return out;
    } finally {
      // (Members' own alerts once the channel's are out — even when reading the rest of the list failed — going out
      //  while the store's next search is on its way: monitor.deliver.)
      await Promise.allSettled(posting);
      await this.monitor.deliver(later, r.id);
    }
  }

  /**
   * What a drop watch's search page had on it (monitor/pages.js): each product whose name has one of a
   * watch's key phrases is that watch's find. Members' own SKUs on the page are read as a search's are.
   * An admin's watch for everyone: the product's in the catalogue (its alerts posted where the watch's go)
   * and monitored, armed for the admin's Auto-checkout; anyone's own: on their watchlist, DM'd. Its alerts:
   * a drop is a product that's new on the page (fresh: what wasn't on it before this read; null when this
   * read sets its scene) after the watch's first look — one this store's catalogue didn't have, or had as
   * not on sale and is on sale now. What's bought is what the watch saw (monitor/sightings.js): this read is
   * the page's watches' own — whole: it holds every result the store has for the page.
   */
  async ingestPage(r, watches, products, { fresh = null, whole = false, how = '', now = this.now() } = {}) {
    const s = this.settings;
    const counted = { found: products.length, kept: 0, new: 0, restock: 0, price: 0 };
    const counts = this.filters(s);
    const later = [];
    const posting = [];
    const log = (e) => this.cfg.log('[drops]', e.message);
    const own = (w) => watches.some((x) => x.id === w.id);
    // (Every product on the page goes in its watches' first look — whatever it's called, blocked or a marketplace's.)
    const codesIn = products.map((p) => [p.sku, ...(p.aliases || [])].filter(Boolean));
    try {
      for (const p of products) {
        const status = p.inStock === true ? (p.inStoreOnly ? STATUS.IN_STORE : p.preorder ? STATUS.PREORDER : STATUS.IN_STOCK) : p.inStock === false ? STATUS.OUT_OF_STOCK : null;
        // Members' own SKUs, whatever they are (a page read is as good as a search's).
        await this.members(r, p, status, later);
        if (r.sweep.sellers && !p.marketplace) {
          const known = this.catalog.productFor(r.id, p.sku);
          if (known && known.seller) p.marketplace = true;
        }
        if ((s.skipMarketplace && p.marketplace) || this.catalog.isBlocked(r.id, p.sku, p.aliases)) continue;
        const title = p.title || p.name;
        const codes = [p.sku, ...(p.aliases || [])];
        const before = codes.map((k) => this.catalog.productFor(r.id, k)).find(Boolean) || null;
        // What each VIP and drop watch at this store saw of it (monitor/sightings.js): this page's watches, their own read.
        const seen = this.sight(r, p, { title, status, own, way: how, before, now });
        const verdict = (w) => (seen.get(w.id) || {}).verdict || 'pending';
        const hits = watches.map((w) => ({ w, phrase: this.drops.phraseIn(w, title) })).filter((x) => x.phrase);
        if (!hits.length) continue;
        counted.kept += 1;
        const isFresh = !!fresh && fresh.has(String(p.sku || '').toLowerCase());
        const cameOnSale = !!before && !isOrderable(before.status) && isOrderable(status);
        // (Its alerts: new on the page — and not seen by the watch before.)
        const dropFor = (w) => !!w.baselineAt && isFresh && (!before || cameOnSale) && !(seen.get(w.id) && seen.get(w.id).before !== null);
        // Someone's own watch: on their watchlist, theirs alone.
        for (const { w } of hits.filter((x) => !x.w.shared)) {
          await this.drops.foundOwn(w, r, p, status, { baseline: !dropFor(w), verdict: verdict(w), later }).catch(log);
        }
        // An admin's watch for everyone: in the catalogue, its alerts where the watch's go (the first watch's channel).
        const shared = hits.filter((x) => x.w.shared);
        if (!shared.length) continue;
        const lead = shared.find((x) => dropFor(x.w)) || shared[0];
        // (A trading-card product the card keywords count too: its category from its name, as their searches give it.)
        const cards = s.keywords.some((k) => counts(p, k));
        const ev = await this.track(r, p, { status, keyword: lead.phrase, baseline: !shared.some((x) => dropFor(x.w)), now, drop: true, category: cards ? null : lead.w.category, dropWatch: lead.w.id, posting });
        for (const k of ev) counted[k] += 1;
        const product = codes.map((k) => this.catalog.productFor(r.id, k)).find(Boolean);
        for (const { w } of shared) {
          // (Armed by what the watch saw of it — never by the catalogue's old status: a month-old "sold out" may be stale.)
          await this.drops.foundShared(w, product, { baseline: !dropFor(w), verdict: verdict(w), status, later }).catch(log);
        }
      }
      // (One more read of each watch's first look, while that's going.)
      if (this.sightings) for (const w of watches) this.sightings.ownRead(w, r.id, { whole, codes: codesIn, how });
      await Promise.allSettled(posting);
      return counted;
    } finally {
      // (Members' own alerts once the channel's are out.)
      await Promise.allSettled(posting);
      await this.monitor.deliver(later, r.id);
    }
  }

  /** The VIP and drop watches at a store whose words are these (their own search: monitor/sightings.js). */
  watchesNamed(storeId, words) {
    return [...(this.vip ? this.vip.termsFor(storeId) : []), ...(this.drops ? this.drops.wordsAt(storeId) : [])].filter((w) => w.words === words);
  }

  /**
   * What each VIP and drop watch at this store saw of a product in this read (monitor/sightings.js) — what its
   * Auto-checkout buys: the stock this read says (status), whether it's in the first look of a watch whose own read
   * this is (own; way: how it was read), and whether the read shows it's new (newSince: a time it wasn't listed — a new
   * card listing's; the store's own creation time, p.createdAt). before: the catalogue's product before this read (or
   * null: it's new to the catalogue). Returns each watch's { verdict, before }.
   */
  sight(r, p, { title, status, own, way = '', before = null, newSince = null, now = this.now() }) {
    const out = new Map();
    if (!this.sightings) return out;
    const codes = [p.sku, ...(p.aliases || [])];
    if (newSince) this.sightings.listed(r.id, p.sku, newSince);
    const list = [...(this.vip ? this.vip.watchesFor(r.id, title) : []), ...(this.drops ? this.drops.watchesFor(r.id, title) : [])];
    if (!list.length) return out;
    // (A search saying it isn't on sale where its own page said it is a moment ago: they disagree — on sale, as far as a
    //  watch goes, so it's never armed on that.)
    let reading = readingOf(status);
    if (reading === 'off' && before && this.monitor.pageSaysOn(before.id, now)) reading = 'on';
    const opts = { reading, how: 'search', created: typeof p.createdAt === 'number' ? p.createdAt : null, knownAt: before ? before.created_at : null, hides: !!r.sweep.goneMeansSoldOut };
    // (Each watch's own read first: a product its whole first look didn't have is new to the others too.)
    const mine = list.filter(own);
    for (const w of mine) out.set(w.id, this.sightings.see(w, r.id, codes, { ...opts, own: true, way }));
    for (const w of list) if (!out.has(w.id)) out.set(w.id, this.sightings.see(w, r.id, codes, opts));
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
      this.emit({ type: 'out', store: r.id, storeName: r.name, product: { id: p.id, name: p.name, image: p.image, price: p.price, sku: p.sku, url: p.url } });
      const monitor = this.catalog.monitorForProduct(p.id);
      if (monitor && !monitor.paused) await this.feed.transitions(p, fresh);
      await this.members(r, { sku: p.sku, aliases: [] }, STATUS.OUT_OF_STOCK);
    }
    return gone.length;
  }

  /**
   * One product in the shared catalogue: update it, and alert what changed. Returns what it alerted.
   * drop: counted only for an admin's drop watch (monitor/drops.js), whose category it gets (Non-TCG).
   * dropWatch: the admin's drop watch that found it (its alerts go where the watch's do).
   */
  async track(r, p, { status, keyword, baseline, gapNew = null, now, vip = false, drop = false, category = null, dropWatch = null, posting = null }) {
    const s = this.settings;
    const found = [p.sku, ...(p.aliases || [])].map((k) => this.catalog.productFor(r.id, k)).find(Boolean);
    const before = found ? { ...found } : null;
    const product = found || this.catalog.upsertProduct({ store: r.id, sku: p.sku, url: p.url, name: p.title, image: p.image, category: category || '' });
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
    if (p.variantId && p.variantId !== product.variant_id) set.variant_id = String(p.variantId).slice(0, 40);
    // (Who sells it, where the list said: JB Hi-Fi's newest products.)
    if (typeof p.seller === 'string' && p.seller !== product.seller) set.seller = p.seller;
    if (product.category === 'other') {
      const c = category || categoryFor(p.title);
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
    // An alert: saved and on the dashboards at once; its Discord posts go on while the rest of the search
    // is read (posting: the search waits for them all at its end) — or waited for, without a list.
    const alert = async (one, kind, opts = {}) => {
      const a = this.noteAlert(await this.feed.alert(one, kind, { sweep: true, vip, dropWatch, detectedAt: now, ...opts, wait: !posting }));
      if (a && a.posting && posting) posting.push(a.posting);
      return a;
    };
    // (Kmart says which states it has stock in: when it isn't all of them, its alerts say so — and when
    // it's in its shops only, that it can't be ordered online.)
    const inStore = fresh.status === STATUS.IN_STORE;
    const where = [inStore ? `In ${r.name}'s stores only — it can't be ordered online.` : '', statesNote(p.states)].filter(Boolean).join(' ');
    // Back in stock: online (after selling out, coming soon, or being in stores only), or in stores only
    // (after selling out) — the online one is the one that counts, so a day's in-store alert never holds
    // it back (its day is marked apart).
    // Buyable for the first time after being listed a while without a buy button: on sale now. (BIG W lists a
    // drop ahead of time with none in its search tile — "unknown", not sold out — until the moment it's on sale:
    // a member's Pokémon TCG 30th Celebration UPC there, Oct 2026, went by without an alert that way.)
    const firstBuyable = isOrderable(fresh.status) && !!before && before.status === STATUS.UNKNOWN
      && ((now - (before.status_at || now) >= UNKNOWN_SETTLE_MS && now - (before.sweep_first_at || now) >= UNKNOWN_SETTLE_MS) || this.unknownSettled(product.id, now));
    this.noteUnknown(product.id, fresh.status, now);
    const restocked = (isOrderable(fresh.status) && (ORDERABLE_FROM.has(before && before.status) || (before && before.status === STATUS.IN_STORE)))
      || (inStore && ORDERABLE_FROM.has(before && before.status)) || firstBuyable;
    // New: never seen before, or a SKU confirmed as not listed yet (a monitor added before it's checked isn't new).
    const isNew = !before || (before.status === STATUS.NOT_LISTED && !!before.last_ok_at);
    // (A search back after a long gap: the first few new to it alert all the same — what was listed meanwhile.)
    const late = isNew && baseline && !!gapNew && gapNew.left > 0;
    // About to alert a product whose seller isn't known yet (JB Hi-Fi): ask first. A marketplace
    // seller's product leaves the list without an alert. (If the store doesn't answer, it alerts.)
    const mayAlert = isNew ? (!baseline || late) && s.newAlerts
      : (s.restockAlerts && restocked) || (s.priceAlerts && priceMoved && price < prevPrice);
    if (mayAlert && s.skipMarketplace && r.sweep.sellers && (fresh.seller === null || fresh.seller === undefined) && !monitor) {
      if (await this.sellerOf(r, fresh)) return sent;
    }
    if (isNew) {
      const note = [`New in "${keyword}" at ${r.name}.`, late ? `(Found as ${r.name}'s search came back after a while without one.)` : '', where].filter(Boolean).join(' ');
      if ((!baseline || late) && (s.newAlerts || vip || drop) && await alert(fresh, 'listed', { note })) {
        sent.push('new');
        if (late) gapNew.left -= 1;
      }
    } else {
      if (s.restockAlerts && restocked && before.confirmed) {
        const today = sydneyDay.format(now);
        const day = inStore ? `${today} in store` : today;
        const due = this.restockDue(fresh, before, day, now);
        if (due) {
          const onSale = firstBuyable ? `On sale now at ${r.name} — listed before without a buy button.` : '';
          const again = due.again ? `Back in stock again today (its ${ORDINAL[due.wave] || `${due.wave}th`} restock — sold out for ${howLong(due.outFor)}).` : '';
          if (await alert(fresh, 'restock', { note: [onSale, again, where].filter(Boolean).join(' ') })) {
            this.catalog.updateProduct(product.id, { restock_day: day });
            sent.push('restock');
          }
        }
      }
      if (s.priceAlerts && priceMoved && typeof prevPrice === 'number' && prevPrice > 0 && price < prevPrice) {
        const pct = ((price - prevPrice) / prevPrice) * 100;
        if (-pct >= s.priceDropPercent && await alert(fresh2(), 'price_drop', { pct })) sent.push('price');
      }
    }
    // A monitor on this product also gets the alerts it asks for (sold out, price up…).
    if (monitor && !monitor.paused && before) await this.feed.transitions(before, fresh2());
    return sent;
  }

  /** Read without a buy button UNKNOWN_SETTLE_READS times in a row, over UNKNOWN_SETTLE_READS_MS at least? */
  unknownSettled(productId, now) {
    const u = this.unknownReads.get(productId);
    return !!u && u.n >= UNKNOWN_SETTLE_READS && now - u.since >= UNKNOWN_SETTLE_READS_MS;
  }

  /** A read of a product: one more in a row without a buy button (unknown), or the count starts over. */
  noteUnknown(productId, status, now) {
    if (status !== STATUS.UNKNOWN) { this.unknownReads.delete(productId); return; }
    const u = this.unknownReads.get(productId);
    this.unknownReads.set(productId, { n: (u ? u.n : 0) + 1, since: u ? u.since : now });
    if (this.unknownReads.size > 5000) for (const [id, x] of this.unknownReads) if (now - x.since > 6 * HOUR) this.unknownReads.delete(id);
  }

  /**
   * Is a restock of this product alerted now ("restock once a day", the default)? Its first of the Sydney day (day: the
   * day's key, "<day> in store" for one in a store's shops only) — or another today once it's been sold out (or coming
   * soon) at least RESTOCK_GAP_MS before coming back, up to RESTOCK_WAVES today: a hot product's second wave reaches
   * the channels too, not only the members watching its SKU. Null: not now. { again, wave, outFor }.
   */
  restockDue(fresh, before, day, now) {
    const today = sydneyDay.format(now);
    if (!this.settings.restockOncePerDay || (fresh.restock_day !== today && fresh.restock_day !== day)) return { again: false };
    const outFor = before && ORDERABLE_FROM.has(before.status) && before.status_at ? now - before.status_at : 0;
    if (outFor < RESTOCK_GAP_MS) return null;
    const waves = this.db.all("SELECT at FROM feed_alerts WHERE product_id = :p AND kind = 'restock' AND at >= :since", { p: fresh.id, since: now - 26 * HOUR })
      .filter((x) => sydneyDay.format(x.at) === today).length;
    return waves < RESTOCK_WAVES ? { again: true, wave: waves + 1, outFor } : null;
  }

  /**
   * Who sells a product, from the product's own data, where the store's search doesn't say (JB Hi-Fi:
   * a "Seller" option naming its marketplace sellers; its own products have none). Remembered on the
   * product: '' = the store itself. A marketplace seller's product leaves the list (unless an admin
   * monitors it). Returns the seller, '' or null when the store didn't answer (asked again later).
   */
  async sellerOf(r, product) {
    const how = r.sweep.sellers;
    const url = `${r.base}${how.path.replace('{sku}', encodeURIComponent(product.sku))}`;
    try {
      const res = await safeFetch(this.fetch, url, { headers: { ...this.headers(r), accept: 'application/json' }, timeoutMs: 8000, signal: AbortSignal.timeout(8000) }, { allowPrivate: this.cfg.monitor.allowPrivateHosts });
      if (res.status === 404) { this.catalog.updateProduct(product.id, { seller: '' }); return ''; }
      if (!res.ok) return null;
      const j = JSON.parse(await res.text());
      const option = (Array.isArray(j.options) ? j.options : []).find((o) => o && typeof o === 'object' && /^sellers?$/i.test(String(o.name || '')));
      const names = option && Array.isArray(option.values) ? option.values.map((v) => String(v).trim()).filter(Boolean) : [];
      const seller = !names.length || names.some((n) => how.own.test(n)) ? '' : names.join(', ').slice(0, 200);
      this.catalog.updateProduct(product.id, seller && !this.catalog.monitorForProduct(product.id) ? { seller, sweep_seen_at: null } : { seller });
      return seller;
    } catch {
      return null;
    }
  }

  /** Products already on the list whose seller isn't known yet: one at a time, at most every 20 s, never during a search. */
  async checkSellers(r) {
    if (!r.sweep.sellers || !this.settings.skipMarketplace) return;
    const st = this.stat(r.id);
    if (st.sellerAt && this.now() - st.sellerAt < 20000) return;
    st.sellerAt = this.now();
    const p = this.db.get(`SELECT * FROM products WHERE store = :s AND seller IS NULL AND sweep_seen_at IS NOT NULL
      AND id NOT IN (SELECT product_id FROM monitors) ORDER BY sweep_seen_at DESC LIMIT 1`, { s: r.id });
    if (p && await this.sellerOf(r, p)) this.feed.broadcast('product', toProduct(this.catalog.productById(p.id)));
  }

  /**
   * A store searched from admins' browsers whose searches haven't found a single product for BLIND_MS: nothing
   * it drops can be seen meanwhile — so its admins are told, once (a DM, and an email where they have one), with
   * why and what to do, and told again when it's back. The stores that go (or come back) at once are in one
   * message: Chrome closed takes them all. (Never in the first BLIND_MS after a start.)
   */
  async watchBlind() {
    const s = this.settings;
    const now = this.now();
    if (!this.running || !s.enabled || now - (this.startedAt || now) < BLIND_MS) return [];
    const told = [];
    const went = [];
    const back = [];
    for (const { retailer: r, mode } of this.stores()) {
      if (mode === 'off' || !(mode === 'browser' || r.sweep.from === 'browser')) continue;
      const st = this.stat(r.id);
      if (!st.lastFoundAt) {
        const row = this.db.get('SELECT MAX(last_ok_at) AS at FROM sweep_terms WHERE store = :s AND found > 0', { s: r.id });
        st.lastFoundAt = (row && row.at) || this.startedAt;
      }
      const blind = now - st.lastFoundAt > BLIND_MS;
      if (blind === !!st.blindSince) continue;
      st.blindSince = blind ? now : 0;
      if (blind) {
        const why = this.statusOf(mode, st, now, r) === 'waiting'
          ? "no admin's browser is searching it (Chrome closed, the computer asleep, or the extension signed out)"
          : st.lastError || st.lastNote ? `its last search said "${str(st.lastError || st.lastNote, 160)}"` : 'its searches come back with no products';
        went.push({ r, line: `${r.name}: no search has found a product since ${sydneyTime.format(st.lastFoundAt)} (${minutes(now - st.lastFoundAt)}) — ${why}.` });
      } else back.push({ r });
      told.push({ store: r.id, blind });
    }
    const names = (list) => andList(list.map((x) => x.r.name));
    const evs = [];
    if (went.length) {
      evs.push({ level: 'urgent', stores: went, title: `${names(went)} ${went.length === 1 ? "isn't" : "aren't"} being watched`,
        message: `Nothing ${went.length === 1 ? 'it drops' : 'they drop'} can be seen until ${went.length === 1 ? "it's" : "they're"} searched again.\n${went.map((x) => x.line).join('\n')}\nKeep Chrome open with the Mugibot extension connected to an admin account (Setup → Extension), and the computer awake. If a store says "Access Denied" there, clear that store's cookies in that browser, or use another one.` });
    }
    if (back.length) evs.push({ level: 'success', stores: back, title: `${names(back)} ${back.length === 1 ? 'is' : 'are'} being watched again`, message: `${back.length === 1 ? 'Its search' : 'Their searches'} found products again at ${sydneyTime.format(now)}.` });
    if (!evs.length) return told;
    const admins = this.db.all("SELECT id FROM users WHERE role = 'admin' AND disabled = 0");
    for (const { stores, ...ev } of evs) {
      for (const x of stores) this.sys(`${ev.title} — ${x.line || ev.message}`, { store: x.r.id, level: ev.level === 'urgent' ? 'warn' : 'info' });
      for (const a of admins) await this.feed.notifier.notify(a.id, { type: 'monitor', channel: 'account', ...ev }).catch((e) => this.cfg.log('[sweep]', e.message));
    }
    return told;
  }

  /**
   * A product the searches found, read off its own page in an admin's browser (a store whose search doesn't say
   * its stock, or says it late — BIG W's): buyable there now after being sold out or coming soon is back in stock,
   * by the searches' own rules (restock alerts on, once a day) — and so is buyable after being listed a while
   * with no buy button (unknown: firstBuyable in track) — its channel alert, and everyone watching it (armed
   * ones' Auto-checkout runs first). A product with a monitor alerts by its monitor's (feed.transitions).
   * before / fresh: the product before and after the read.
   */
  async pageRead(before, fresh) {
    const s = this.settings;
    const r = fresh && this.retailers.get(fresh.store);
    if (!s.enabled || !r || !before || this.catalog.monitorForProduct(fresh.id)) return null;
    const now = this.now();
    const prev = [STATUS.BLOCKED, STATUS.ERROR].includes(before.status) ? this.catalog.lastReadStatus(before.id) : before.status;
    // (No buy button on its own page last time too, a while: not just its tile's — a product's first page read has
    //  nothing to compare with, so an update never turns every product in stock into an alert.)
    const settled = prev === STATUS.UNKNOWN && before.status_source === 'browser'
      && ((now - (before.status_at || now) >= UNKNOWN_SETTLE_MS && now - (before.sweep_first_at || now) >= UNKNOWN_SETTLE_MS) || this.unknownSettled(before.id, now));
    if (!isOrderable(fresh.status) || !(ORDERABLE_FROM.has(prev) || settled)) return null;
    const later = [];
    await this.members(r, { sku: fresh.sku, aliases: [], title: fresh.name, url: fresh.url, price: fresh.price }, fresh.status, later);
    let a = null;
    const today = sydneyDay.format(now);
    const due = s.restockAlerts ? this.restockDue(fresh, { status: prev, status_at: before.status_at }, today, now) : null;
    if (due) {
      const again = due.again ? ` Back in stock again today (its ${ORDINAL[due.wave] || `${due.wave}th`} restock — sold out for ${howLong(due.outFor)}).` : '';
      const note = `${settled ? `On sale now at ${r.name} — seen on its own page, listed before without a buy button.` : `Seen on its own page at ${r.name}.`}${again}`;
      a = this.noteAlert(await this.feed.alert(fresh, 'restock', { sweep: true, detectedAt: now, note }));
      if (a) this.catalog.updateProduct(fresh.id, { restock_day: today });
    }
    await this.monitor.deliver(later, r.id);
    return a;
  }

  /**
   * Members watching this SKU: their own watchlist, straight away — armed ones' Auto-checkout runs made
   * now, their alerts on later (the search's list: sent once its channel alerts are out), or now without one.
   */
  async members(r, p, status, later = null) {
    const codes = [...new Set([p.sku, ...(p.aliases || [])].filter(Boolean))].slice(0, 5);
    const params = { s: r.id, now: this.now(), ...Object.fromEntries(codes.map((c, i) => [`c${i}`, c])) };
    const items = this.db.all(`SELECT i.* FROM items i JOIN users u ON u.id = i.user_id
      WHERE i.store = :s AND i.sku COLLATE NOCASE IN (${codes.map((_, i) => `:c${i}`).join(', ')}) AND i.monitor = 1 AND u.disabled = 0 AND ${ENTITLED_SQL}`, params);
    if (!items.length) return;
    const waiting = [...new Set(items.filter((i) => !i.url).map((i) => i.sku))];
    if (waiting.length && p.url) for (const sku of waiting) this.monitor.resolveSku(r.id, sku, p.url);
    if (!status) return;
    const fresh = waiting.length ? this.db.all(`SELECT * FROM items WHERE id IN (${items.map((_, i) => `:i${i}`).join(', ')})`, Object.fromEntries(items.map((it, i) => [`i${i}`, it.id]))) : items;
    // (Every member's Auto-checkout run first, then everyone's alerts: monitor/index.js applyAll. variantId: the
    // listing's only option — a run for it opens the store's add-to-cart link, even for a listing that's brand new.)
    const variantId = p.oneVariant && p.variantId ? String(p.variantId) : null;
    await this.monitor.applyAll(fresh.filter((item) => item.url), { status, title: p.title || null, price: typeof p.price === 'number' ? p.price : null, error: '', variantId }, 'sweep', { later });
  }

  /** Remember how a search went (the sweep_terms row, the store's recent requests) and log failures. */
  record(r, term, info) {
    const now = this.now();
    const st = this.stat(r.id);
    // Server first, an admin's browser standing in: the server's try says whether it's back — the
    // store's own state (failures, pace, problem) is the browser's meanwhile.
    const trying = info.source === 'server' && this.standIn(r, st);
    const keep = trying ? { fails: st.fails, failKind: st.failKind, lastError: st.lastError, lastNote: st.lastNote, slowUntil: st.slowUntil, lastOkAt: st.lastOkAt } : null;
    const failedBefore = st.fails;
    const wasSlow = st.slowUntil > now;
    st.lastAt = now;
    st.searches = (st.searches || 0) + 1;
    st.log.push({ at: now, ok: info.ok, blocked: !!info.blocked, ms: info.ms ?? null, source: info.source });
    while (st.log.length && st.log[0].at < now - HOUR) st.log.shift();
    this.totals.searches += 1;
    if (info.ok) {
      st.fails = 0;
      st.failKind = '';
      st.lastOkAt = now;
      if (info.found > 0) st.lastFoundAt = now;
      if (!st.firstOkAt) st.firstOkAt = now;
      // (An answer is the store working: no problem to show. What this one search said — "BIG W has no results for
      //  …" — is its own, a note on it, never the store's state.)
      st.lastError = '';
      st.lastNote = info.error || '';
      this.totals.streak += 1;
    } else {
      st.fails += 1;
      // (unread: a page whose results hadn't been drawn when it was read — read again at the usual pace, no backing off.
      //  transient: the store struggling, not refusing — read again soon: waitFor.)
      st.failKind = info.unread ? 'unread' : info.transient && r.sweep.from !== 'browser' ? 'transient' : 'failed';
      st.lastError = info.error || 'Failed';
      st.lastNote = '';
      if (info.blocked) st.slowUntil = now + SLOW_MS;
      this.totals.errors += 1;
      this.totals.streak = 0;
      this.cfg.log(JSON.stringify({ evt: 'sweep.failed', store: r.id, keyword: term.keyword, page: term.page, source: info.source, error: info.error || '', fails: st.fails, ms: info.ms ?? null }));
    }
    this.db.run(`INSERT INTO sweep_terms (store, keyword, page, url, source, baseline_at, last_at, last_ok_at, found, kept, total, fails, error, ms)
      VALUES (:s, :k, :p, :url, :src, :base, :now, :ok, :found, :kept, :total, :fails, :err, :ms)
      ON CONFLICT (store, keyword, page) DO UPDATE SET url = excluded.url, source = excluded.source, last_at = excluded.last_at,
        baseline_at = CASE WHEN :isOk = 1 AND (sweep_terms.baseline_at IS NULL OR :wasBaseline = 1) THEN :now
          WHEN :isOk = 0 AND sweep_terms.url <> excluded.url THEN NULL ELSE sweep_terms.baseline_at END,
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
    if (keep) Object.assign(st, keep);
    if (info.source === 'browser') st.browserAt = now;
    if (info.source === 'server' && this.modeFor(r) === 'auto') this.serverFirst(r, st, info, now, trying);
    const out = { store: r.id, keyword: termLabel(term.keyword, r), page: term.page, ok: info.ok, blocked: !!info.blocked, ...(info.unread ? { unread: true } : {}), error: info.error || '', found: info.found || 0, kept: info.kept || 0, new: info.new || 0, restock: info.restock || 0, price: info.price || 0, baseline: !!info.baseline, ms: info.ms ?? null };
    // A drop watch's words (monitor/drops.js): how it went shows on the watch. ('private': someone's own
    // watch's words — members never see them in the live log: monitor/public.js.)
    if (term.drop && this.drops) this.drops.searched(r.id, term.keyword, info);
    // (trial: the server's try while an admin's browser stands in — the store's state is the browser's.)
    this.emit({ type: info.ok ? 'hb' : 'err', storeName: r.name, source: info.source || '', ...out, ...(term.drop ? { drop: term.drop } : {}), ...(trying ? { trial: true } : {}) });
    if (!trying && info.ok && failedBefore >= 2) this.sys(`${r.name} is answering again after ${failedBefore} failed searches`, { store: r.id });
    if (!trying && info.blocked && !wasSlow) this.sys(`${r.name} refused a search — searching it at a third of the pace for 10 minutes`, { store: r.id, level: 'warn' });
    return out;
  }

  /**
   * Server first ('auto'): what the server's search says about who searches the store. A miss: refused
   * or failed, or no products where there are some (ingest). Three misses in a row (one, at a store
   * known to turn servers away or whose products only a browser can draw), and an admin's browser
   * stands in; the server tries again
   * after 5 minutes, twice as long each time it's still turned away (30 at most), and takes back over
   * the moment its search works — gently at first, as after a reset.
   */
  serverFirst(r, st, info, now, trying) {
    if (info.ok) {
      st.serverMisses = 0;
      st.transientSince = 0;
      if (st.backup) {
        const { since, transient } = st.backup;
        // (Gently at first — not after a store that was only struggling: it never turned the server away.)
        Object.assign(st, { backup: null, fails: 0, lastError: '', lastOkAt: now, slowUntil: transient ? 0 : now + SLOW_MS });
        this.sys(`${r.name}: Mugibot's server is searching it again — the store answered (an admin's browser stood in for ${minutes(now - since)})`, { store: r.id });
      }
      return;
    }
    const why = info.empty ? (r.sweep.render ? 'its products only show once its page has run' : "no products, where an admin's browser finds some") : info.error || 'refused';
    const transient = !!info.transient && r.sweep.from !== 'browser';
    if (trying) {
      st.backup.tries += 1;
      st.backup.why = why;
      // (Turned away once while standing in: it's a refusal now — the server's tries wait as for one.)
      if (!transient) st.backup.transient = false;
      st.backup.retryAt = now + Math.min(SERVER_RETRY_MAX_MS, (st.backup.transient ? TRANSIENT_RETRY_MS : SERVER_RETRY_MS) * 2 ** (st.backup.tries - 1));
      st.backup.idleAt = now + this.idleWait(r, st.backup.tries, st.backup.transient);
      return;
    }
    if (transient) {
      // (Struggling, not refusing: its own misses don't count — only how long it's gone without an answer.)
      st.transientSince = st.transientSince || now;
      if (now - st.transientSince < TRANSIENT_HANDOVER_MS) return;
    } else {
      st.serverMisses = (st.serverMisses || 0) + 1;
      if (st.serverMisses < (r.sweep.from === 'browser' ? 1 : SERVER_TRIES) && !(info.empty && r.sweep.render)) return;
    }
    const first = transient ? TRANSIENT_RETRY_MS : SERVER_RETRY_MS;
    st.backup = { since: now, tries: 1, retryAt: now + first, idleAt: now + this.idleWait(r, 1, transient), why, waitUntil: st.retryAt || 0, transient };
    // (The browser starts afresh: the server's failures, slower pace and Retry-After were the server's.)
    Object.assign(st, { fails: 0, slowUntil: 0, retryAt: 0, browserNext: 0, serverMisses: 0, transientSince: 0 });
    const state = info.empty ? `can't read it (${why})` : transient ? `gets no answer from it (${why}, for ${minutes(TRANSIENT_HANDOVER_MS)})` : `is refused (${why})`;
    st.lastError = `Mugibot's server ${state} — an admin's browser searches it meanwhile, and the server tries again within ${transient ? 'a minute' : '5 min'}`;
    this.sys(`${r.name}: ${st.lastError}`, { store: r.id, level: 'warn' });
  }

  /**
   * The server's try while an admin's browser stands in: the first page of a keyword the browser
   * found products for (so an answer with none is told apart from one that works).
   */
  tryTerm(r) {
    const kws = this.settings.keywords;
    const row = this.db.get("SELECT keyword FROM sweep_terms WHERE store = :s AND page = 1 AND source = 'browser' AND found > 0 ORDER BY last_ok_at DESC LIMIT 1", { s: r.id });
    return { keyword: row && kws.includes(row.keyword) ? row.keyword : kws[0], page: 1 };
  }

  /** Searched from an admin's browser now: a store set to 'browser', or server first while the browser stands in. */
  fromBrowser(r, mode = this.modeFor(r)) {
    return mode === 'browser' || (mode === 'auto' && !!this.stat(r.id).backup);
  }

  /** Server first, and an admin's browser standing in for the server at this store. */
  standIn(r, st = this.stat(r.id)) {
    return !!st.backup && this.modeFor(r) === 'auto';
  }

  /** The server's usual backoff, for its tries while no admin's browser is searching the store yet (a struggling store's: waitFor's). */
  idleWait(r, tries, transient = false) {
    const every = this.paceFor(r);
    if (transient) return Math.max(every * 2, Math.min(TRANSIENT_MAX_MS, every * 2 ** Math.min(TRANSIENT_QUICK + tries, 10)));
    return Math.min(MAX_BACKOFF_MS, every * 2 ** Math.min(SERVER_TRIES + tries - 1, 10));
  }

  /**
   * When the server tries again, standing in: after 5, 10, 20, 30 minutes while an admin's browser is
   * searching the store — before that, at the server's usual backoff — never before Retry-After.
   */
  nextTry(r, st, now = this.now()) {
    const b = st.backup;
    const searching = !!st.browserAt && st.browserAt >= b.since && now - st.browserAt < Math.max(60 * 1000, 4 * this.paceFor(r, true));
    return Math.max(b.waitUntil || 0, searching ? b.retryAt || 0 : Math.min(b.retryAt || 0, b.idleAt ?? b.retryAt ?? 0));
  }

  // ---------------------------------------------------------------------------
  // The server's loops: one per store, each waiting its turn
  // ---------------------------------------------------------------------------
  start() {
    if (this.running || !this.cfg.monitor.enabled) return;
    this.running = true;
    this.startedAt = this.now();
    // (The card words widened in an update, at a Mugibot that had tracked products already: from now, what they let in
    //  is tracked quietly at first — widenedLately. A new Mugibot's first searches set the scene anyway.)
    if (!this.repo.getSetting('sweepWidenedAt')) {
      const tracked = this.db.get('SELECT 1 AS y FROM products WHERE sweep_seen_at IS NOT NULL LIMIT 1');
      this.repo.setSetting('sweepWidenedAt', tracked ? this.now() : 1);
    }
    this.prune();
    const live = this.stores().filter((x) => x.mode !== 'off');
    const from = (mode) => live.filter((x) => x.mode === mode).map((x) => x.retailer.name).join(', ');
    const s = this.settings;
    this.sys(s.enabled && live.length
      ? `Live sweeps started — ${[from('auto') && `${from('auto')} from Mugibot's server first`, from('server') && `${from('server')} from Mugibot's server only`, from('browser') && `${from('browser')} from admins' browsers`].filter(Boolean).join(' · ')} · keywords: ${s.keywords.join(', ')}`
      : 'Live sweeps are switched off');
    this.restart();
    this.blindTimer = setInterval(() => { this.watchBlind().catch((e) => this.cfg.log('[sweep]', e.message)); }, 60 * 1000);
    this.blindTimer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.blindTimer) clearInterval(this.blindTimer);
    this.blindTimer = null;
    for (const wake of this.wakers.values()) wake();
  }

  /** Start loops for stores newly swept from the server (server first too); wake the others so new settings apply now. */
  restart() {
    if (!this.running) return;
    for (const { retailer: r, mode } of this.stores()) {
      if ((mode === 'server' || mode === 'auto') && !this.loops.has(r.id)) this.loop(r.id).catch((e) => this.cfg.log('[sweep]', e.message));
    }
    for (const wake of this.wakers.values()) wake();
  }

  /**
   * Sweep everything now: server loops skip their wait (and any backoff), browsers get their next searches
   * straight away, and where an admin's browser stands in for the server, the server tries again now.
   */
  sweepNow() {
    for (const st of this.state.values()) {
      Object.assign(st, { fails: 0, browserNext: 0, slowUntil: 0 });
      if (st.backup) st.backup.retryAt = 0;
    }
    for (const wake of this.wakers.values()) wake();
  }

  async loop(id) {
    this.loops.add(id);
    try {
      while (this.running) {
        const r = this.retailers.get(id);
        const mode = this.modeFor(r);
        if (mode !== 'server' && mode !== 'auto') break;
        const st = this.stat(id);
        // Server first, an admin's browser standing in: the server only tries again when it's time
        // (and never before what the store asked of it: Retry-After).
        const backup = mode === 'auto' && st.backup;
        const until = backup ? this.nextTry(r, st) : st.retryAt || 0;
        // Woken early (Reset, Sweep now) while the store asked to wait (Retry-After): wait it out first.
        const asked = until > this.now() ? until - this.now() : 0;
        if (asked) {
          if (!backup) st.nextAt = this.now() + asked;
          // (Standing in: looked at again every minute — the browser may start, or stop, searching it.)
          await this.sleep(id, backup ? Math.min(asked, 60 * 1000) : asked);
          continue;
        }
        const term = backup ? this.tryTerm(r) : this.nextTerm(r);
        const began = Date.now();
        await this.sweepTerm(r, term).catch((e) => this.record(r, term, { ok: false, source: 'server', error: e.message }));
        const spent = Date.now() - began;
        // Handed over to an admin's browser (or still standing in): the next try waits at the top.
        if (st.backup && this.modeFor(r) === 'auto') continue;
        // (Between searches, not during one: who sells what, where the search doesn't say.)
        if (!st.fails) await this.checkSellers(r).catch(() => {});
        // (The next search on the pace from this one's start: a store slow to answer isn't searched less
        // often. Who-sells-what lookups come on top: they're requests to the store too.)
        const wait = this.waitFor(st, this.paceFor(r), { jitter: true, spent });
        st.nextAt = this.now() + wait;
        await this.sleep(id, wait);
      }
    } finally {
      this.loops.delete(id);
      this.wakers.delete(id);
    }
  }

  /**
   * How long a store waits before its next search: the set pace (±20%) from the last one's start (spent:
   * how long it took — at least MIN_GAP_MS between them), slower for a while after a refusal, doubling
   * after each failure (from its end) — and never before the time the store asked for (Retry-After).
   */
  waitFor(st, every, { jitter = false, spent = 0 } = {}) {
    const asked = st.retryAt && st.retryAt > this.now() ? st.retryAt - this.now() : 0;
    // (Not after a page that hadn't drawn its results yet: the store turned nobody away — its usual pace.)
    // A store only struggling (TRANSIENT_*): at half its pace three times, then twice as long each time, a minute apart at
    // most — never sooner than half its pace, and a search that took long to fail spaced itself already. (Not while it's
    // searched gently after turning one away: a refusal's backoff stands.)
    if (st.fails && st.failKind === 'transient' && !(st.slowUntil > this.now())) {
      const back = st.fails <= TRANSIENT_QUICK ? every * 2 : Math.max(every * 2, Math.min(TRANSIENT_MAX_MS, every * 2 ** Math.min(st.fails, 10)));
      return Math.max(asked, MIN_GAP_MS, back - Math.max(0, spent));
    }
    if (st.fails && st.failKind !== 'unread') return Math.max(asked, Math.min(MAX_BACKOFF_MS, every * 2 ** Math.min(st.fails, 10)));
    const slow = st.slowUntil > this.now() ? SLOW_FACTOR : 1;
    return Math.max(asked, MIN_GAP_MS, every * slow * (jitter ? 0.8 + 0.4 * this.random() : 1) - Math.max(0, spent));
  }

  /**
   * Reset: a store (or every store) that keeps failing starts over, the way a person would come
   * back to a site later. Its backoff and errors are cleared, its next search is now, and it's
   * searched gently (at a third of the pace) for 10 minutes so it isn't refused straight away
   * again. From the server: fresh connections to the store. From an admin's browser: the store's
   * cached files there are cleared (never its cookies or sign-in), and its tab in the sweep window is
   * closed and opened again at the store's front page. Server first:
   * the server searches it again (an admin's browser stands in again only if it's still refused).
   * What a store asked for (Retry-After) is still waited for. Nothing here hides who's asking.
   */
  reset(storeId = null, user = null) {
    const now = this.now();
    const done = [];
    let fromBrowser = false;
    for (const { retailer: r, mode } of this.stores()) {
      if (storeId ? r.id !== storeId : mode === 'off') continue;
      if (mode === 'browser') fromBrowser = true;
      const st = this.stat(r.id);
      Object.assign(st, { fails: 0, lastError: '', browserNext: 0, nextAt: now, slowUntil: now + SLOW_MS, resetAt: now, needsUpdateAt: 0 });
      if (mode === 'auto') {
        if (st.backup) st.retryAt = Math.max(st.retryAt || 0, st.backup.waitUntil || 0);
        Object.assign(st, { backup: null, serverMisses: 0 });
      }
      // (Server first: if the browser stands in again, its tab starts afresh too.)
      if (mode === 'browser' || mode === 'auto') st.freshTab = true;
      const server = mode === 'server' || mode === 'auto';
      if (server) {
        try { dropConnections(new URL(this.urlFor(r, this.settings.keywords[0] || '')).host); } catch { /* no address */ }
      }
      this.db.run("UPDATE sweep_terms SET fails = 0, error = '' WHERE store = :s", { s: r.id });
      done.push(r);
      // Only the stores reset: the others keep their own pace (and any backoff).
      if (server && this.running && !this.loops.has(r.id)) this.loop(r.id).catch((e) => this.cfg.log('[sweep]', e.message));
      const wake = this.wakers.get(r.id);
      if (wake) wake();
    }
    if (!done.length) return [];
    const who = user ? user.username : 'An admin';
    // (From an admin's browser: its tab there starts afresh, with the store's cached files cleared — cookies and sign-in kept.)
    const browser = storeId && fromBrowser ? ` (its tab in the admin's browser starts afresh, its cached files cleared)` : '';
    this.sys(storeId
      ? `${who} reset ${done[0].name}: searching it again now, gently for 10 minutes${browser}`
      : `${who} reset every store: searching them again now, gently for 10 minutes`, storeId ? { store: storeId } : {});
    if (user) this.repo.audit(user.id, null, 'sweep-reset', storeId || 'all stores');
    return done.map((r) => r.id);
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
  /**
   * The next search at each store swept from browsers, for an admin's browser. Two admins' browsers share them.
   * Server first: only while the browser stands in for the server (refused, or it can't read the store).
   * browser.version: its copy of the extension. A store that needs a newer one is left for another browser.
   * browser.busy: stores that browser is still searching (each store's search runs on its own, side by
   * side): none handed out again until it's done — never two at once at a store, no keyword's turn lost.
   */
  browserDue(user, browser = {}) {
    if (!user || user.role !== 'admin') return { terms: [], waitMs: null };
    const now = this.now();
    const terms = [];
    const held = [];
    let next = null;
    const through = browser.through || new Set();
    const busy = browser.busy || new Set();
    for (const { retailer: r, mode } of this.stores()) {
      if (!this.fromBrowser(r, mode)) continue;
      const st = this.stat(r.id);
      // Its virtual queue is up (monitor/gates.js): no searches from a browser that isn't through it —
      // a request there could cost the admin their place in line. Its tab is left exactly as it is.
      if (this.gates && this.gates.queueUp(r.id) && !through.has(r.id)) {
        if (!st.heldAt) this.sys(`${r.name}: its virtual queue is up — searches from ${browser.who ? `${browser.who}'s` : "admins'"} browser wait until it's through the queue or the queue's down (nothing refreshes the queue page)`, { store: r.id, level: 'warn' });
        st.heldAt = now;
        st.nextAt = null;
        held.push(r.id);
        continue;
      }
      if (st.heldAt) {
        st.heldAt = 0;
        this.sys(`${r.name}: searching it again (${this.gates && this.gates.queueUp(r.id) ? 'through its virtual queue' : 'its virtual queue is down'})`, { store: r.id });
      }
      // (Its search still going in that browser: nothing yet — the browser asks again the moment that's in.)
      if (busy.has(r.id)) continue;
      const needs = r.sweep.extension;
      if (needs && olderVersion(browser.version, needs)) {
        // (Unless another admin's browser, an up-to-date one, is searching it.)
        if (!st.browserAt || now - st.browserAt > Math.max(60 * 1000, 4 * this.paceFor(r, true))) this.needsUpdate(r, st, needs, browser);
        continue;
      }
      if (st.browserNext > now) { next = Math.min(next ?? Infinity, st.browserNext); continue; }
      this.refreshCollections(r).catch(() => {});
      const term = this.nextTerm(r, { all: false }); // (an admin's browser: each keyword, as it always has — the whole-range list is the server's; the card shops' newest products too)
      // (A VIP or drop watch's words: searched as they are.)
      const raw = !!(term.vip || term.drop);
      st.browserNext = now + this.waitFor(st, this.paceFor(r, true));
      st.nextAt = st.browserNext;
      st.askedAt = now;
      next = Math.min(next ?? Infinity, st.browserNext);
      terms.push(serialize({
        store: r.id, keyword: term.keyword, page: term.page, url: this.urlFor(r, term.keyword, term.page, { vip: raw }), parser: r.sweep.parser,
        productPath: r.productPath || null, skuFromPath: r.skuFromPath || null, storeName: r.name, storeBase: r.base,
        // Pages that build their product list once they're open (BIG W): the browser opens them and waits.
        render: !!r.sweep.render,
        // …in a private window of their own (BIG W's), where the browser allows it: apart from the admin's own visits.
        privateWindow: !!r.sweep.privateWindow,
        // A search the store's own page asks for (EB Games' JSON): asked from inside a page of the store.
        inPage: !!r.sweep.inPage,
        // What the store answers with: 'html' (Amazon's search page) — else JSON.
        expect: r.sweep.expect || 'json',
        // (Which page: openPath, '' for the store's front page. None: the site's address.)
        pageUrl: typeof r.sweep.openPath === 'string' ? `${r.base}${r.sweep.openPath.replace('{q}', encodeURIComponent(raw ? term.keyword : this.query(r, term.keyword)))}` : null,
        // The headers the store's own code sends with it (Premium Bandai's region: x-g1-area-code).
        headers: r.sweep.headers || null,
        // Reset by an admin: the store's tab is closed and opened again at its front page first.
        fresh: !!st.freshTab,
        frontUrl: r.base,
        // Its checkpoint or virtual queue (monitor/gate.js): a tab showing it is never navigated, and a
        // search that runs into it waits.
        gate: r.gate ? { kind: r.gate.kind, page: r.gate.page } : null,
      }));
      st.freshTab = false;
    }
    // Queues to look at as a new visitor (monitor/gates.js): is one up, or has it come down?
    const looks = this.gates ? this.gates.probesFor(user) : { probes: [], nextAt: null };
    if (looks.nextAt !== null) next = Math.min(next ?? Infinity, looks.nextAt);
    // (A held store: asked about again in a minute — sooner, if the browser gets through.)
    if (held.length) next = Math.min(next ?? Infinity, now + 60 * 1000);
    // (And what's up now: a browser that saw a queue lately knows when it's come down.)
    const gates = this.gates ? this.gates.upList().map((g) => ({ store: g.store, kind: g.kind, since: g.since, wait: g.wait })) : [];
    return { terms, probes: looks.probes, held, gates, waitMs: next === null ? null : Math.max(1000, next - now) };
  }

  /** An admin's browser whose extension is too old for a store (Chrome won't let it open that store's pages): say so, once. */
  needsUpdate(r, st, needs, browser) {
    const note = `Needs Mugibot's extension ${needs} or newer in an admin's browser${browser.version ? ` (${browser.who ? `${browser.who}'s has` : 'this one has'} ${browser.version})` : ''} — update it from the dashboard's Setup page`;
    const fresh = st.lastError !== note;
    st.needsUpdateAt = this.now();
    st.lastError = note;
    st.fails = 0;
    st.nextAt = null;
    if (fresh) this.sys(`${r.name}: ${note}`, { store: r.id, level: 'warn' });
  }

  /** What an admin's browser found. Only admins' browsers can change the shared feed. */
  async browserResults(user, results) {
    if (!user || user.role !== 'admin' || !Array.isArray(results)) return [];
    const out = [];
    for (const res of results.slice(0, 10)) {
      if (!res || typeof res !== 'object') continue;
      const r = this.retailers.get(str(res.store, 40));
      if (!r) continue;
      const st = this.stat(r.id);
      // (Server first: also a search asked for just before the server took back over.)
      if (!this.fromBrowser(r) && !(this.modeFor(r) === 'auto' && st.askedAt && this.now() - st.askedAt < 2 * 60 * 1000)) continue;
      const term = this.termOf(r, res);
      if (!term) continue;
      const url = this.urlFor(r, term.keyword, term.page, { vip: !!(term.vip || term.drop) });
      const ms = num(res.ms, { min: 0, max: 120000, int: true, def: null });
      // The search ran into the store's virtual queue (or checkpoint): it's up, and the search waits —
      // no failure, no backing off, and the tab's left alone.
      if (res.gate && this.gates) {
        this.gates.observe(r.id, 'up', { source: 'page', user, wait: res.gate.wait });
        if (!st.heldAt) this.sys(`${r.name}: the search ran into its ${r.gate && r.gate.kind === 'checkpoint' ? 'checkpoint' : 'virtual queue'} — waiting (nothing refreshes it)`, { store: r.id, level: 'warn' });
        st.heldAt = this.now();
        continue;
      }
      if (!st.browserAt || this.now() - st.browserAt > 2 * 60 * 1000) this.sys(`${r.name}: ${user.username}'s browser is searching it`, { store: r.id });
      // Read in an ordinary window where it should have its own private one (Mugibot not allowed in Incognito in that
      // browser): said once every few hours, with how to allow it.
      if (r.sweep.privateWindow && res.privateWindow === false && this.now() - (st.privateNoteAt || 0) > 6 * HOUR) {
        st.privateNoteAt = this.now();
        this.sys(`${r.name}: ${user.username}'s browser searches it in an ordinary window — allow Mugibot in Incognito there (chrome://extensions → Mugibot → Details → Allow in Incognito) and it's searched in a private window of its own, apart from your own ${r.name} visits and checkouts`, { store: r.id, level: 'warn' });
      }
      if (r.sweep.privateWindow && typeof res.privateWindow === 'boolean') st.privateWindow = res.privateWindow;
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
      const problem = ['blocked', 'layout', 'empty', 'unread'].includes(res.problem) ? res.problem : null;
      // (Extension 1.19.1: what the page it couldn't read was. 1.32.0: nothing read — what the page said it had.)
      const seen = res.seen && typeof res.seen === 'object' ? { title: res.seen.title, bytes: res.seen.bytes, links: res.seen.links } : null;
      const stated = num(res.stated, { min: 0, max: 1e7, int: true, def: null });
      if (r.sweep.followNext && !term.vip && !term.drop && !problem && products.length) this.noteNext(r, term, res.next);
      // (The store's own count of results and how many came, where the browser says: whether the read holds them all.)
      const total = num(res.total, { min: 0, max: 1e7, int: true, def: null });
      const perPage = total === null ? null : num(res.perPage, { min: 0, max: 1e5, int: true, def: null });
      const count = num(res.count, { min: 0, max: 1e5, int: true, def: null });
      // (Asked for at the same address as the server would — not a page drawn or asked from inside the store's own: its
      //  answer is the server's, as far as what a watch saw goes.)
      const way = r.sweep.render || r.sweep.inPage ? 'browser' : 'server';
      out.push(await this.ingest(r, term, { products, total, ...(perPage !== null ? { perPage } : {}), ...(count !== null ? { count } : {}), problem, stated, none: res.none === true }, { source: 'browser', url, ms, seen, way }));
    }
    return out;
  }

  /**
   * A search page's own link to its next page of results (sweep.followNext: BIG W's, whose search shows 48 by
   * relevance — a new listing can be further down): kept as where that keyword's next page is read, up to
   * sweep.pages. Only a link to the same search at the same store; none (the last page) forgets it.
   */
  noteNext(r, term, next) {
    const st = this.stat(r.id);
    const key = `${term.keyword}\n${term.page}`;
    let u = null;
    try {
      u = new URL(str(next, 2000));
      const first = new URL(this.urlFor(r, term.keyword, 1));
      const owner = this.retailers.forUrl(u);
      const same = owner && owner.id === r.id && u.origin === first.origin && u.pathname === first.pathname
        && [...first.searchParams].every(([k, v]) => u.searchParams.get(k) === v);
      if (!same || u.href === first.href || term.page >= Math.min(10, r.sweep.pages || 1)) u = null;
    } catch { u = null; }
    if (u) st.nextPages.set(key, u.href); else st.nextPages.delete(key);
  }

  /**
   * Which search an admin's browser says it did: a keyword's page, or a VIP or drop watch's words at
   * that store (monitor/vip.js, monitor/drops.js) — null for anything Mugibot didn't ask for.
   */
  termOf(r, res) {
    const words = str(res.keyword, 60);
    const keyword = this.settings.keywords.find((k) => k === words);
    if (keyword) return { keyword, page: num(res.page, { min: 1, max: 10, int: true, def: 1 }) };
    // (The store's newest products, at a store whose list an admin's browser reads too: the card shops'.)
    if (words === NEWEST && r.sweep.newestPath && r.sweep.newestBrowser) return { keyword: NEWEST, page: 1 };
    const vip = this.vip ? this.vip.termsFor(r.id).find((w) => w.words === words) : null;
    if (vip) return { keyword: vip.words, page: 1, vip: vip.id };
    const drop = this.drops ? this.drops.wordsAt(r.id).find((w) => w.words === words) : null;
    if (drop) return { keyword: drop.words, page: 1, drop: this.drops.kindOf(r.id, drop.words) };
    return null;
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
      price: price(p.price), wasPrice: price(p.wasPrice), inStock: typeof p.inStock === 'boolean' ? p.inStock : null, preorder: p.preorder === true, inStoreOnly: p.inStoreOnly === true,
      url: onStore(p.url), image: /^https:\/\//.test(image) ? image : '', marketplace: p.marketplace === true,
      variantId: /^\d{1,20}$/.test(String(p.variantId ?? '')) ? String(p.variantId) : null,
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

  /** A store's state in a word: ok, slowed, retrying, waiting (for an admin's browser) or starting. */
  statusOf(mode, st, now, r) {
    // From an admin's browser: set so, or server first while the browser stands in. (Its last search
    // is the browser's: the server's tries meanwhile don't count.)
    const browser = mode === 'browser' || (mode === 'auto' && !!st.backup);
    const seen = mode === 'browser' ? st.lastAt : st.browserAt;
    // Waiting while its virtual queue is up (from a browser that isn't through it).
    if (browser && st.heldAt && now - st.heldAt < 2 * 60 * 1000) return 'held';
    // Waiting for an admin's browser with a newer extension (none has searched it since one asked).
    if (browser && st.needsUpdateAt && st.needsUpdateAt > (seen || 0)) return 'waiting';
    // Server first, handed over: waiting until an admin's browser searches it.
    if (mode === 'auto' && st.backup && (st.browserAt || 0) < st.backup.since) return 'waiting';
    if (!st.lastAt) return browser ? 'waiting' : 'starting';
    if (st.fails) return 'retrying';
    if (browser && now - (seen || 0) > Math.max(60 * 1000, 4 * this.paceFor(r, true))) return 'waiting';
    if (st.slowUntil > now) return 'slowed';
    return 'ok';
  }

  /** Server first, an admin's browser standing in: since when, why, and when the server tries again. */
  backupOf(mode, st, r) {
    if (mode !== 'auto' || !st.backup) return null;
    const b = st.backup;
    return { since: b.since, why: b.why, tries: b.tries, retryAt: this.nextTry(r, st) || null };
  }

  /** What a store's searches read, for the live monitor ("/search?text=", "ac.cnstrc.com/search/"). */
  endpoint(r) {
    if (this.settings.keywords.some((k) => this.collectionFor(r, k))) return r.sweep.collectionPath.replace('{collection}', '…').split('?')[0];
    const p = r.sweep.path.split('{q}')[0];
    if (!r.sweep.apiBase) return p;
    try { return `${new URL(r.sweep.apiBase).host}${p}`; } catch { return p; }
  }

  /** Everything the live monitor shows when it opens: each store, the counters and the latest events. */
  /** The live monitor's view. offToo: stores switched off as well (admins switch them back on there). */
  live({ offToo = false } = {}) {
    const now = this.now();
    const stores = this.stores().filter((x) => offToo || x.mode !== 'off').map(({ retailer: r, mode }) => {
      const st = this.stat(r.id);
      const lastOk = [...st.log].reverse().find((x) => x.ok && typeof x.ms === 'number');
      return {
        id: r.id, name: r.name, realId: r.realId || r.id, mode, from: MODE_LABEL[mode], status: mode === 'off' ? 'off' : this.statusOf(mode, st, now, r),
        // Who's searching it now ('server' | 'browser'), and server first's stand-in, if the browser's standing in.
        source: this.sourceOf(r, mode), backup: this.backupOf(mode, st, r),
        defaultMode: this.defaultMode(r),
        searches: st.searches || 0, fails: st.fails, lastAt: st.lastAt, lastOkAt: st.lastOkAt, lastMs: lastOk ? lastOk.ms : null, lastError: st.lastError,
        // (What its last search said, when it found nothing: "BIG W has no results for …" — a note, not a problem.)
        lastNote: st.lastNote || '',
        nextAt: st.nextAt, slowedUntil: st.slowUntil > now ? st.slowUntil : null,
        // The store asked to wait (Retry-After); when it was last reset; its last answer was a refusal.
        retryAt: st.retryAt > now ? st.retryAt : null, resetAt: st.resetAt || null, refused: !!(st.fails && st.log.length && st.log.at(-1).blocked),
        endpoint: this.endpoint(r),
        latency: st.log.filter((x) => x.at >= now - 10 * 60 * 1000).slice(-150).map((x) => ({ at: x.at, ms: x.ms, ok: x.ok })),
      };
    });
    const t = this.ttns;
    // (And how long the latest took from the store's answer to being in Discord.)
    const discord = this.feed.discordTimes ? this.feed.discordTimes() : { meanMs: null, medianMs: null };
    return {
      now, startedAt: this.startedAt, running: this.running, totals: { ...this.totals },
      meanAlertMs: t.length ? Math.round(t.reduce((a, b) => a + b, 0) / t.length) : null, discordMs: discord.medianMs, stores, events: this.events.slice(-150),
    };
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
        store: r.id, name: r.name, mode, defaultMode: this.defaultMode(r), demo: !!r.demo, privateWindow: !!r.sweep.privateWindow,
        source: this.sourceOf(r, mode), backup: this.backupOf(mode, st, r),
        running: mode === 'server' || mode === 'auto' ? this.loops.has(r.id) : null,
        requests1h: recent.length, ok1h: ok.length, blocked1h: recent.filter((x) => x.blocked).length,
        avgMs: timed.length ? Math.round(timed.reduce((a, x) => a + x.ms, 0) / timed.length) : null,
        lastAt: st.lastAt, lastOkAt: st.lastOkAt, lastError: st.lastError, lastNote: st.lastNote || '', fails: st.fails, nextAt: mode === 'off' ? null : st.nextAt,
        slowedUntil: st.slowUntil > now ? st.slowUntil : null,
        // (Drop mode: until when, and what it's searched for meanwhile.)
        dropMode: st.hot && st.hot.until > now ? { until: st.hot.until, keyword: st.hot.keyword ? st.hot.keyword : null, newest: !!st.hot.newest } : null,
        products24h: products ? products.n : 0,
        terms: terms.map((t) => ({ keyword: termLabel(t.keyword, r), page: t.page, url: t.url, source: t.source, lastAt: t.last_at, lastOkAt: t.last_ok_at, found: t.found, kept: t.kept, total: t.total, fails: t.fails, error: t.error, ms: t.ms, baselineAt: t.baseline_at })),
      };
    });
  }
}
