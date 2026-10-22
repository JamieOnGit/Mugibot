// Release news (docs/NEWS.md): what's coming out, when, and which stores are dropping it — for
// everything worth being ready for because more people want it than there's stock of: trading cards,
// consoles, collectibles. Posted in the Discord server's #news, and on every member's dashboard
// (Drops → 📰 News).
//
// Two sources:
// - Admins' own (Admin → News): a title, a link, the stores, the date. "Post to #news" posts it.
// - News feeds (RSS 2.0 and Atom): the server reads each one every 15 minutes, honestly as itself, one
//   request at a time to a website (a conditional read: 304 is "nothing new"), backing off when it
//   goes wrong. An entry is news only when it names a hyped product (HYPE_WORDS, plus the feed's own
//   words) and reads like a release (pre-orders, a release date, launches, restocks…) — then its date
//   and the stores it names are read out of it where they can be, and it's posted. A feed's first read
//   only sets the scene, like the live sweeps' first search: what was in it then is kept, not posted.
//
// Each morning (Sydney) "📅 Coming up" goes to #news: what's released in the next 14 days, soonest
// first, with its stores — once a day, and only when there's something.

import { newId } from './crypto.js';
import { storeFetch } from './monitor/http.js';
import { parseFeed } from './monitor/rss.js';
import { BlockedUrlError, safeFetch } from './monitor/safeurl.js';
import { NewsData, toFeed } from './newsdata.js';
import { HttpError, bad, bool, httpUrl, num, str } from './schema.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Each feed read this often (give or take a minute, so they stay spread out), backing off to this at most.
const POLL_MS = 15 * MIN;
const JITTER_MS = MIN;
const MAX_BACKOFF_MS = 4 * HOUR;
const TICK_MS = 20 * 1000;
// Two websites read at once at most (one request at a time to each).
const AT_ONCE = 2;
// A feed can be big (Press Start's has every article in full: 2 MB): the start of it is plenty.
const MAX_FEED_BYTES = 4 * 1024 * 1024;
// An entry published longer ago than this isn't posted when it first turns up (a feed catching up).
const STALE_MS = 2 * DAY;
// A feed's read that finds a lot posts this many, the rest kept for the dashboard and the digest.
const MAX_POSTS_PER_READ = 5;
const MAX_FEEDS = 40;
const MAX_ITEMS = 5000;
// The morning digest: from 8:31 in Sydney (not on the hour, like the scheduled jobs), until noon.
const DIGEST_FROM = 8 * 60 + 31;
const DIGEST_UNTIL = 12 * 60;
const DIGEST_DAYS = 14;
const SNOWFLAKE = /^\d{5,25}$/;
const COLOR = 0x7c3aed;

export const NEWS_CHANNEL = 'news';
export const NEWS_TOPIC = "Release news: what's coming out, when, and which stores are dropping it — trading cards, consoles, collectibles. From Mugibot.";
const CHANNEL_SETTING = 'newsChannel';
const DIGEST_SETTING = 'newsDigest';
const SEEDED_SETTING = 'newsFeedsSeeded';

export const NEWS_CATEGORIES = { tcg: 'Trading cards', console: 'Consoles & games', collectible: 'Collectibles', other: 'Other' };

// The hyped products: what sells out because more people want it than there's stock of. A feed's
// entry is news only when it names one of these (or a word its admin added to the feed).
export const HYPE_WORDS = [
  // Trading cards
  'Pokémon', 'One Piece', 'Riftbound', 'Gundam', 'Lorcana', 'Dragon Ball', 'Magic: The Gathering', 'MTG', 'Yu-Gi-Oh', 'Yugioh', 'Digimon',
  'Union Arena', 'Star Wars Unlimited', 'Flesh and Blood', 'Weiss Schwarz',
  // Consoles
  'Switch 2', 'Nintendo', 'PlayStation', 'PS5', 'PS6', 'DualSense', 'Xbox', 'Steam Deck',
  // Collectibles
  'LEGO', 'amiibo', 'Labubu', 'Pop Mart', "Collector's Edition",
];
// …but not what can't be bought and sold on: digital games' and subscriptions' news (in the title).
export const NOT_WORDS = ['Pokémon GO', 'TCG Pocket', 'Pokémon Pocket', 'for Pocket', 'in Pocket', 'TCG Live', 'Pokémon Unite', 'Pokémon Sleep', 'Pokémon Masters', 'PS Plus', 'PlayStation Plus', 'Game Pass', 'Switch Online', 'eShop', 'DLC', 'demo'];

// Feeds read from the start — each one checked with a real read when this was written (October 2026):
// PokéBeach's front-page news (the Pokémon TCG's sets and dates); Nintendo Life, Push Square and Pure
// Xbox (Nintendo, PlayStation, Xbox); IGN; and two Australian sites that say when pre-orders open at
// which stores here, Press Start and Stevivor. Admins switch any off, or add more.
export const DEFAULT_FEEDS = [
  { name: 'PokéBeach', url: 'https://www.pokebeach.com/forums/forums/front-page-news.18/index.rss' },
  { name: 'Nintendo Life', url: 'https://www.nintendolife.com/feeds/latest' },
  { name: 'Push Square', url: 'https://www.pushsquare.com/feeds/latest' },
  { name: 'Pure Xbox', url: 'https://www.purexbox.com/feeds/latest' },
  { name: 'IGN', url: 'https://www.ign.com/rss/articles/feed' },
  { name: 'Press Start', url: 'https://press-start.com.au/feed/' },
  { name: 'Stevivor', url: 'https://stevivor.com/feed/' },
];

// The other big Australian stores a release can name (Mugibot's own come from retailers/index.js).
export const OTHER_STORES = [
  ['myer', 'Myer'], ['davidjones', 'David Jones'], ['harveynorman', 'Harvey Norman'], ['goodguys', 'The Good Guys'], ['officeworks', 'Officeworks'],
  ['mightyape', 'Mighty Ape'], ['costco', 'Costco'], ['woolworths', 'Woolworths'], ['coles', 'Coles'], ['gametraders', 'Game Traders'],
  ['toyworld', 'Toyworld'], ['kogan', 'Kogan'], ['catch', 'Catch'], ['auspost', 'Australia Post'], ['zavvi', 'Zavvi'],
];
// What else people call them (whatever the case and punctuation: "Toys"R"Us" is "Toys R Us").
const ALSO_CALLED = {
  amazon: ['Amazon'], bigw: ['BigW'], jbhifi: ['JB HiFi', 'JB Hi Fi'], kmart: ['K-Mart'], toysrus: ['Toys R Us', 'ToysRUs'],
  pokemoncenter: ['Pokémon Centre'], pbandai: ['P-Bandai', 'PBandai'], gametraders: ['Gametraders'], toyworld: ['Toy World'],
};
// Names that are ordinary words too: only as written — Target next to a store-ish word ("at Target",
// "Target's", "Target exclusive"), not "hits its target".
const AMBIGUOUS = {
  target: /\b(?:at|from|via|and|or|in|with)\s+Target\b|[,&]\s*Target\b|\bTarget(?:'s|’s)\s|\bTarget\s+(?:Australia|AU|exclusives?|stores?)\b/,
  zing: /\bZing\b/, goodgames: /\bGood Games\b/, gamesworld: /\bGames World\b/, davidjones: /\bDavid Jones\b/, goodguys: /\bThe Good Guys\b/,
  catch: /\bCatch\.com\.au\b/,
};

// ---------------------------------------------------------------------------
// Reading an entry: is it release news about something hyped? When, which stores, what kind?
// ---------------------------------------------------------------------------
/** Words to compare: lower case, no accents, punctuation as spaces ("Pokémon TCG: Pre-Orders" → "pokemon tcg pre orders"). */
export function words(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
const has = (w, phrase) => { const p = words(phrase); return !!p && ` ${w} `.includes(` ${p} `); };

// What a release reads like (on words()): pre-orders, a date, a launch, stock coming in.
const RELEASE = [
  /\bpre ?orders?\b/, /\bpre ?sales?\b/, /\brelease (date|dates|day|window)\b/, /\breleas(es|ing)\b/, /\b(to|will|now) release\b/,
  /\breleased? (on|in|this|next|today|tomorrow)\b/, /\blaunch(es|ing)\b/, /\blaunch (date|day)\b/, /\b(to|will) launch\b/,
  /\bcoming (to stores|to australia|soon|today|tomorrow|this|next|in|on)\b/, /\barriv(es|ing) (in|on|this|next)\b/, /\brestock(s|ed|ing)?\b/,
  /\breprints?\b/, /\bdrops?\b/, /\bdropping\b/, /\bavailable (on|from|now|to (pre ?order|order|buy))\b/, /\b(on|goes on) sale\b/,
  /\bout now\b/, /(?<!\b(?:check|checking|rolling|rolls|roll|sold|sells|selling|find|left|miss|phased|pulled) )\bout (today|on|in|this|next)\b/, /\bhits? (stores|shelves)\b/, /\bin stores\b/, /\bin stock\b/, /\b(go|goes|going) live\b/,
  /\b(physical|retail|boxed) release\b/,
];
// (Not a release: a trailer dropping, a price dropping.)
const NOT_RELEASE = /\b(price drops?|drops? to|drops? (a |the |its |new |first |another )*(trailer|teaser|gameplay|footage|video|demo|clip)s?)\b/g;

export const readsLikeRelease = (w) => { const t = String(w || '').replace(NOT_RELEASE, ' '); return RELEASE.some((re) => re.test(t)); };

/** A feed's words ("funko, -pocket"): added to the hyped products; a "-word" leaves entries with it out. */
export function hypeLists(keywords = '') {
  const want = [...HYPE_WORDS];
  const not = [...NOT_WORDS];
  for (const k of String(keywords || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (k.startsWith('-')) not.push(k.replace(/^-\s*/, ''));
    else want.push(k);
  }
  return { want, not: not.filter(Boolean) };
}

/**
 * Is this entry release news about something hyped? It names a hyped product (in its title or
 * summary) and its title reads like a release. (Only the title for that: a summary says "released",
 * "launch" or "drops" in passing — patch notes, reviews, podcasts.) Never with one of the left-out
 * words in its title.
 */
export function isReleaseNews({ title = '', summary = '' }, lists = hypeLists()) {
  const t = words(title);
  if (!t || lists.not.some((x) => has(t, x)) || !readsLikeRelease(t)) return false;
  const s = words(summary);
  const hits = lists.want.filter((x) => has(t, x) || has(s, x));
  if (!hits.length) return false;
  // A console's name alone — its games' news names it too ("Mario Kart World launches on Switch 2") — counts
  // only when the title is about the console itself or its stock: what sells out and flips, not a game.
  if (hits.every((x) => CONSOLE_ONLY.has(words(x)))) return CONSOLE_ITSELF.test(t) || CONSOLE_NEWS.test(t);
  return true;
}

// (On words(): console names, and the words that make a title about the console rather than one of its games.)
const CONSOLE_ONLY = new Set(['nintendo', 'playstation', 'xbox', 'switch 2', 'ps5', 'ps6']);
const CONSOLE_ITSELF = /\b(consoles?|controllers?|handhelds?|bundles?|editions?|amiibo|hardware|dualsense|joy cons?|oled|slim|series [xs]|restocks?|restocked|in stock|back in stock|sold out)\b/;
const CONSOLE_NEWS = /\b(switch 2|ps5( pro| slim)?|ps6|xbox series [xs])( console)? (pre ?orders?|is|are|will|launch(es)?|releases?|release dates?|stock|back)\b/;

const TCG_WORDS = /\b(tcg|ccg|card games?|trading cards?|booster|boosters|elite trainer|etb|op \d{2}|lorcana|riftbound|magic the gathering|mtg|yu gi oh|yugioh|union arena|star wars unlimited|flesh and blood|weiss schwarz)\b/;
const COLLECTIBLE_WORDS = /\b(lego|amiibo|labubu|pop mart|funko|figures?|figurines?|plush|plushies|statues?)\b/;
const CONSOLE_WORDS = /\b(switch 2|playstation|ps5|ps6|dualsense|xbox|steam deck|consoles?|controllers?|handhelds?|nintendo)\b/;
const EDITION_WORDS = /\b(collector s edition|collectors edition|limited edition)\b/;
const CARD_BRAND = /\b(pokemon|one piece|dragon ball|gundam|digimon)\b/;
const CARD_THINGS = /\b(sets?|packs?|decks?|tins?|box|boxes|collection|expansion)\b/;

/** 'tcg' | 'console' | 'collectible' | 'other', from what it says. */
export function categoryOf(text) {
  const w = words(text);
  if (TCG_WORDS.test(w)) return 'tcg';
  if (COLLECTIBLE_WORDS.test(w)) return 'collectible';
  if (CONSOLE_WORDS.test(w)) return 'console';
  if (EDITION_WORDS.test(w)) return 'collectible';
  if (CARD_BRAND.test(w) && CARD_THINGS.test(w)) return 'tcg';
  return 'other';
}

// --- Dates (the stores are Australian: a release day is a day in Sydney) ---------------------------
const SYDNEY = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const LONG = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const SHORT = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short' });
const WEEKDAY = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', day: 'numeric', month: 'short' });

/** The time in Sydney: { y, m, d, hour, minute, second, day: 'YYYY-MM-DD' }. */
export function sydneyParts(ms) {
  const p = Object.fromEntries(SYDNEY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second), day: `${p.year}-${p.month}-${p.day}` };
}

/** Midnight in Sydney on that day (a day past the month's end rolls over, as Date.UTC does). */
export function sydneyMidnight(y, m, d) {
  const want = Date.UTC(y, m - 1, d);
  let t = want - 10 * HOUR;
  // (Sydney is 10 or 11 hours ahead: guessed, then put right by what the clock there says.)
  for (let i = 0; i < 3; i++) {
    const p = sydneyParts(t);
    t += want - Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second);
  }
  return t;
}

export const longDay = (ms) => LONG.format(new Date(ms)).replace(/,/g, ''); // "Sat 14 Nov 2026"
export const shortDay = (ms) => SHORT.format(new Date(ms)).replace(/,/g, ''); // "14 Nov"
const weekday = (ms) => WEEKDAY.format(new Date(ms)).replace(/,/g, ''); // "Sat 14 Nov"

const MONTH = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "14 November", "14th Nov 2026"; "November 14", "Nov 14th, 2026" (not "November 2026", nor a time:
// "Nov 14 at 10:00" is the 14th); "14/11/2026" (Australian order); "2026-11-14".
// (A number that's part of a name isn't a day: "Switch 2 October update", "Top 10 May releases".)
const NOT_A_DAY = '(?<!\\b(?:Switch|PS|Gen|Vol|Part|Season|Series|Episode|Chapter|Wave|Phase|Top|No|Mk)\\.?\\s*)';
const DAY_MONTH = new RegExp(`\\b${NOT_A_DAY}(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH})\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'gi');
const MONTH_DAY = new RegExp(`\\b(${MONTH})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?::|%|am\\b|pm\\b|\\.\\d))(?:,?\\s+(\\d{4})\\b)?`, 'gi');
const SLASHED = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g;
const ISO = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;
const monthOf = (s) => MONTHS.indexOf(String(s).slice(0, 3).toLowerCase()) + 1;

/** The day (midnight in Sydney) — a date without a year is the next one (or one a few weeks back). */
function dayAt(day, month, year, base) {
  if (!(month >= 1 && month <= 12) || !(day >= 1)) return null;
  const fits = (y) => day <= new Date(Date.UTC(y, month, 0)).getUTCDate();
  let y = year ? (year < 100 ? 2000 + year : year) : sydneyParts(base).y;
  if (!fits(y)) return null;
  let at = sydneyMidnight(y, month, day);
  if (!year && at < base - 45 * DAY) {
    y += 1;
    if (!fits(y)) return null;
    at = sydneyMidnight(y, month, day);
  }
  return at >= base - 2 * 365 * DAY && at <= base + 3 * 365 * DAY ? at : null;
}

/**
 * The first date in the text that's sure to be one: { at (midnight in Sydney), text (as written) } or
 * null. base: when it was written (a date without a year is the next one after it).
 */
export function findDate(text, base = Date.now()) {
  const s = String(text || '');
  let best = null;
  const take = (m, at) => { if (at !== null && (!best || m.index < best.index)) best = { index: m.index, at, text: m[0].trim().replace(/[.,]$/, '') }; };
  // (A month's name only with a capital: "you may 2…" isn't May.)
  const each = (re, read) => {
    for (const m of s.matchAll(re)) {
      const at = read(m);
      if (at !== null) { take(m, at); return; }
    }
  };
  each(DAY_MONTH, (m) => (/^[A-Z]/.test(m[2]) ? dayAt(Number(m[1]), monthOf(m[2]), m[3] ? Number(m[3]) : null, base) : null));
  each(MONTH_DAY, (m) => (/^[A-Z]/.test(m[1]) ? dayAt(Number(m[2]), monthOf(m[1]), m[3] ? Number(m[3]) : null, base) : null));
  each(SLASHED, (m) => dayAt(Number(m[1]), Number(m[2]), Number(m[3]), base));
  each(ISO, (m) => dayAt(Number(m[3]), Number(m[2]), Number(m[1]), base));
  return best && { at: best.at, text: best.text };
}

// ---------------------------------------------------------------------------
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  return `${cut.replace(/\s+\S*$/, '') || cut}…`;
};
// (Never anyone pinged by what a feed wrote: Discord is told to ping no one anyway — this keeps it from showing.)
const quiet = (s) => String(s || '').replace(/@(everyone|here)/gi, '@\u200b$1'); // (a zero-width space after the @)
const hostOf = (url) => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNewsName = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '').replace(/^-+|-+$/g, '') === NEWS_CHANNEL;
/** The server's #news: a text (or announcement) channel called news — "📰┃news" too. */
export const isNewsChannel = (c) => !!c && (c.type === 0 || c.type === 5) && isNewsName(c.name);
const discordProblem = (r) => (r.status === 0 ? "Discord didn't answer" : `HTTP ${r.status}${r.body && r.body.message ? `: ${r.body.message}` : ''}`);

/** A feed's words, tidied: "Funko,  -pocket ,funko" → "Funko, -pocket". */
function keywordsFrom(v) {
  const seen = new Set();
  const out = [];
  for (const k of (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => str(x, 40).replace(/^-\s+/, '-')).filter((x) => x && x !== '-')) {
    if (seen.has(k.toLowerCase()) || out.length >= 30) continue;
    seen.add(k.toLowerCase());
    out.push(k);
  }
  return out.join(', ');
}

export class News {
  constructor({ cfg, db, repo, retailers, discord, notifier, fetchImpl = storeFetch, now = () => Date.now() }) {
    Object.assign(this, { cfg, db, repo, retailers, discord, notifier, fetch: fetchImpl, now });
    this.data = new NewsData({ db, now });
    this.posting = Promise.resolve();
    this.timer = null;
    this.running = false;
    this.ticking = false;
    this.digesting = false;
    this.hosts = new Map(); // website → the read going on there (and any waiting behind it)
    this.hostNext = new Map(); // website → when the next request there may go
    this.prunedAt = 0;
    this.seed();
  }

  get hostGapMs() { return Math.max(0, this.cfg.monitor.hostGapSeconds ?? 5) * 1000; }

  /** Everything said so far has been posted (tests). */
  settled() {
    return this.posting;
  }

  /** The default feeds, once (an admin who removes one doesn't get it back). */
  seed() {
    try {
      if (this.repo.getSetting(SEEDED_SETTING)) return;
      for (const f of DEFAULT_FEEDS) this.data.insertFeed({ id: newId('feed'), url: f.url, name: f.name });
      this.repo.setSetting(SEEDED_SETTING, true);
    } catch (e) {
      this.cfg.log('[news]', e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // The stores
  // ---------------------------------------------------------------------------
  /** The stores a release can name: Mugibot's own (not the dummy store's, nor Shop checkout links), then the other big Australian ones. */
  stores() {
    const own = this.retailers.list.filter((r) => !r.demo && !r.cartLinks && r.id !== 'other').map((r) => ({ id: r.id, name: r.name }));
    return [...own, ...OTHER_STORES.filter(([id]) => !own.some((o) => o.id === id)).map(([id, name]) => ({ id, name }))];
  }

  storeName(id) {
    const s = this.stores().find((x) => x.id === id);
    return s ? s.name : id;
  }

  /** The stores the text names, in the order it names them. */
  storesIn(text) {
    const raw = String(text || '');
    const w = ` ${words(raw)} `;
    const found = [];
    for (const s of this.stores()) {
      const re = AMBIGUOUS[s.id];
      let at = -1;
      if (re) {
        if (re.test(raw)) at = Math.max(0, w.indexOf(` ${words(s.name)} `));
      } else {
        for (const name of [s.name, ...(ALSO_CALLED[s.id] || [])]) {
          const i = w.indexOf(` ${words(name)} `);
          if (i >= 0 && (at < 0 || i < at)) at = i;
        }
      }
      if (at >= 0) found.push([at, s.id]);
    }
    return found.sort((a, b) => a[0] - b[0]).slice(0, 8).map(([, id]) => id);
  }

  // ---------------------------------------------------------------------------
  // What people see
  // ---------------------------------------------------------------------------
  /** Midnight in Sydney today: releases from then on are coming up. */
  today(at = this.now()) {
    const p = sydneyParts(at);
    return sydneyMidnight(p.y, p.m, p.d);
  }

  publicItem(x) {
    return {
      id: x.id, title: x.title, summary: x.summary, url: x.url, sourceName: x.sourceName, category: x.category,
      stores: x.stores.map((id) => ({ id, name: this.storeName(id) })), releaseAt: x.releaseAt, releaseText: x.releaseText, at: x.publishedAt || x.createdAt,
    };
  }

  /** Members (Drops → 📰 News): what's coming up, soonest first, and the latest news. */
  forMembers() {
    return {
      upcoming: this.data.releases(this.today(), null, 40).map((x) => this.publicItem(x)),
      recent: this.data.recent(30).map((x) => this.publicItem(x)),
      categories: NEWS_CATEGORIES,
    };
  }

  /** Admin → News: every item (with where it was posted), the feeds, the channel, the defaults. */
  forAdmins() {
    const counts = this.data.feedCounts();
    return {
      items: this.data.recent(200).map((x) => ({ ...this.publicItem(x), source: x.source, feedId: x.feedId, postedAt: x.postedAt, postedChannel: x.postedChannel, createdAt: x.createdAt, updatedAt: x.updatedAt })),
      feeds: this.data.feedRows().map((r) => ({ ...toFeed(r), found: counts[r.id] || 0 })),
      newsChannel: this.repo.getSetting(CHANNEL_SETTING) || null,
      digest: this.repo.getSetting(DIGEST_SETTING) || null,
      stores: this.stores(),
      categories: NEWS_CATEGORIES,
      defaults: { words: HYPE_WORDS, notWords: NOT_WORDS },
      everyMinutes: POLL_MS / MIN,
      running: this.running,
      bot: !!(this.discord && this.discord.botReady),
    };
  }

  // ---------------------------------------------------------------------------
  // Admins' own news
  // ---------------------------------------------------------------------------
  /** A release date: 'YYYY-MM-DD' (that day in Sydney) or ms; '' / null: none. undefined: unchanged. */
  dateFrom(v) {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const now = this.now();
    let at;
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) at = dayAt(Number(m[3]), Number(m[2]), Number(m[1]), now);
    else at = num(v, { def: null, int: true });
    if (at === null || at < now - 2 * 365 * DAY || at > now + 3 * 365 * DAY) throw bad('Release date: pick a day within the next three years (or leave it empty)');
    return at;
  }

  storesFrom(v) {
    if (v === undefined) return undefined;
    const known = new Set(this.stores().map((s) => s.id));
    const list = (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => str(s, 40)).filter((s) => known.has(s));
    return [...new Set(list)].slice(0, 12);
  }

  /** input: { title, url, summary, category, stores: [ids], releaseAt ('YYYY-MM-DD' or ms), releaseText }. */
  fields(input, existing = null) {
    const src = input || {};
    const title = src.title === undefined && existing ? existing.title : str(src.title, 200);
    if (title.length < 3) throw bad('Give it a title, e.g. "Pokémon TCG: Ascended Heroes — pre-orders"');
    const url = src.url === undefined && existing ? existing.url : httpUrl(src.url, 'Link', { required: false });
    const summary = src.summary === undefined && existing ? existing.summary : str(src.summary, 1000);
    let category = src.category === undefined && existing ? existing.category : String(src.category || '').toLowerCase();
    if (!NEWS_CATEGORIES[category]) {
      if (category) throw bad(`Category: one of ${Object.keys(NEWS_CATEGORIES).join(', ')}`);
      category = categoryOf(`${title} ${summary}`);
    }
    const stores = this.storesFrom(src.stores) ?? (existing ? existing.stores : this.storesIn(`${title} ${summary}`));
    const releaseAt = this.dateFrom(src.releaseAt !== undefined ? src.releaseAt : src.releaseDate);
    const releaseText = src.releaseText === undefined && existing ? existing.releaseText : str(src.releaseText, 60);
    return { title, url, summary, category, stores, releaseAt: releaseAt === undefined ? (existing ? existing.releaseAt : null) : releaseAt, releaseText };
  }

  /** An admin's news item; with post: true, posted in #news straight away. { item, posted, postError } */
  async add(input, user) {
    if (this.data.count() >= MAX_ITEMS) throw bad(`${MAX_ITEMS.toLocaleString('en-AU')} news items is the most — delete some old ones first`);
    const f = this.fields(input);
    const id = newId('news');
    this.data.insert({ id, ...f, source: 'admin', sourceName: this.cfg.appName, key: `admin:${id}`, createdBy: user ? user.id : null });
    if (user) this.repo.audit(user.id, null, 'news-add', f.title);
    let posted = false;
    let postError = '';
    if (bool(input && input.post, false)) {
      try { posted = await this.postNow(id, user); } catch (e) { postError = e.message; }
    }
    return { item: this.data.item(id), posted, postError };
  }

  update(id, input, user) {
    const existing = this.data.item(id);
    if (!existing) throw new HttpError(404, 'That news item no longer exists');
    const f = this.fields(input, existing);
    const item = this.data.update(id, { title: f.title, url: f.url, summary: f.summary, category: f.category, stores: f.stores, release_at: f.releaseAt, release_text: f.releaseText });
    if (user) this.repo.audit(user.id, null, 'news-edit', f.title);
    return item;
  }

  remove(id, user) {
    const existing = this.data.item(id);
    if (!existing || !this.data.remove(id)) throw new HttpError(404, 'That news item no longer exists');
    if (user) this.repo.audit(user.id, null, 'news-remove', existing.title);
    return true;
  }

  /** "Post to #news" (again, if it was already): true, or an HttpError saying what's wrong. */
  async postNow(id, user = null) {
    const item = this.data.item(id);
    if (!item) throw new HttpError(404, 'That news item no longer exists');
    if (!this.discord || !this.discord.botReady) throw new HttpError(503, "The Discord bot isn't set up yet (Admin → Setup check)");
    const ch = await this.channel();
    if (!ch) throw new HttpError(502, "Couldn't find or make #news — press \"Set up #news\" to see why");
    if (!(await this.discord.post(ch.channelId, this.message(item, { mention: ch.roleId ? `<@&${ch.roleId}>` : '' })))) {
      throw new HttpError(502, "Couldn't post in #news — check the bot can see and post in that channel");
    }
    this.data.markPosted(id, ch.channelId);
    if (user) this.repo.audit(user.id, null, 'news-post', item.title);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Discord: #news
  // ---------------------------------------------------------------------------
  /** #news: the one saved by "Set up #news" (or "Set up store channels"), else found by name (or made). */
  async channel() {
    const saved = this.repo.getSetting(CHANNEL_SETTING);
    if (saved && saved.channelId) return saved;
    if (!this.discord || !this.discord.botReady || !this.cfg.discord.guildId) return null;
    const list = await this.discord.guildChannels();
    if (list.status !== 200 || !Array.isArray(list.body)) return null;
    let ch = list.body.find(isNewsChannel);
    if (!ch) {
      const parent = list.body.find((c) => c && c.type === 4 && /^mugibot alerts$/i.test(c.name || ''));
      const made = await this.discord.createChannel({ name: NEWS_CHANNEL, type: 0, topic: NEWS_TOPIC, ...(parent ? { parent_id: parent.id } : {}) });
      if (made.status !== 200 && made.status !== 201) return null;
      ch = made.body;
    }
    return this.saveChannel(String(ch.id));
  }

  /** Remembered: the channel, and the role its posts ping (kept while it's the same channel; roleId: a new one). */
  saveChannel(channelId, roleId) {
    const before = this.repo.getSetting(CHANNEL_SETTING) || {};
    return this.repo.setSetting(CHANNEL_SETTING, { channelId, roleId: roleId !== undefined ? roleId : before.channelId === channelId ? before.roleId || '' : '' });
  }

  /**
   * "Set up #news": the server's #news found by name (or made by the bot under "Mugibot alerts") and
   * remembered. opts.roleId: a role each news post pings ('': none; missing: the one it had).
   */
  async setupChannel(opts = {}, user = null) {
    if (!this.discord || !this.discord.botReady || !this.cfg.discord.guildId) throw new HttpError(503, "The Discord bot isn't set up yet (Admin → Setup check)");
    const roleId = opts.roleId === undefined || opts.roleId === null ? undefined : str(opts.roleId, 30);
    if (roleId && !SNOWFLAKE.test(roleId)) throw bad('Role ID: Server Settings → Roles → right-click the role → Copy Role ID, or leave it empty');
    const list = await this.discord.guildChannels();
    if (list.status !== 200 || !Array.isArray(list.body)) throw new HttpError(502, `Couldn't read the server's channels (${discordProblem(list)})`);
    let ch = list.body.find(isNewsChannel);
    let made = false;
    if (!ch) {
      const make = async (body) => {
        const r = await this.discord.createChannel(body);
        if (r.status === 403) throw new HttpError(409, `The bot can't make channels: give its role the Manage Channels permission (Server Settings → Roles), or make #${NEWS_CHANNEL} yourself and press this again — it finds it by name`);
        if (r.status !== 200 && r.status !== 201) throw new HttpError(502, `Couldn't make #${body.name} (${discordProblem(r)})`);
        return r.body;
      };
      let parent = list.body.find((c) => c && c.type === 4 && /^mugibot alerts$/i.test(c.name || ''));
      if (!parent) parent = await make({ name: 'Mugibot alerts', type: 4 });
      ch = await make({ name: NEWS_CHANNEL, type: 0, parent_id: parent.id, topic: NEWS_TOPIC });
      made = true;
    }
    const saved = this.saveChannel(String(ch.id), roleId);
    if (user) this.repo.audit(user.id, null, 'news-channel-setup', `#${ch.name}${made ? ' (made)' : ''}`);
    return { channel: { name: ch.name, id: String(ch.id), made }, roleId: saved.roleId };
  }

  /** "📰 Pokémon TCG: Ascended Heroes — pre-orders 14 Nov at EB Games, BIG W": the link, the date, the stores, where it's from. */
  message(item, { mention = '' } = {}) {
    const title = quiet(item.title);
    const tw = words(title);
    const names = item.stores.map((id) => this.storeName(id));
    // (What the title says already isn't said twice.)
    const day = item.releaseAt && !(item.releaseText && title.includes(item.releaseText)) ? shortDay(item.releaseAt) : '';
    const unsaid = names.filter((n) => !has(tw, n));
    const tail = [day, unsaid.length ? `at ${unsaid.join(', ')}` : ''].filter(Boolean).join(' ');
    const fields = [];
    if (item.releaseAt || item.releaseText) fields.push({ name: '📅 Release', value: item.releaseAt ? longDay(item.releaseAt) : quiet(item.releaseText), inline: true });
    if (names.length) fields.push({ name: '🏬 Stores', value: names.join(', ').slice(0, 1000), inline: true });
    fields.push({ name: 'Category', value: NEWS_CATEGORIES[item.category] || 'Other', inline: true });
    if (item.sourceName) fields.push({ name: 'Source', value: quiet(item.sourceName).slice(0, 200), inline: true });
    return this.notifier.message({
      level: 'info', title: `📰 ${title}${tail ? `${title.includes(' — ') ? ' ' : ' — '}${tail}` : ''}`,
      message: quiet(clip(item.summary, 600)), url: item.url, fields, footer: `${this.cfg.appName} News`, embedColor: COLOR,
      buttons: item.url ? [{ label: 'Read more', url: item.url }] : [],
    }, { mention });
  }

  queuePost(id) {
    // (One after another: in the order they came, and the channel found or made once.)
    this.posting = this.posting.then(async () => {
      if (!this.discord || !this.discord.botReady) return;
      const item = this.data.item(id);
      const ch = item && await this.channel();
      if (!ch) return;
      if (await this.discord.post(ch.channelId, this.message(item, { mention: ch.roleId ? `<@&${ch.roleId}>` : '' }))) this.data.markPosted(id, ch.channelId);
    }).catch((e) => this.cfg.log('[news]', e.message));
  }

  // ---------------------------------------------------------------------------
  // The morning digest: "📅 Coming up"
  // ---------------------------------------------------------------------------
  /** What's released in the next 14 days (today included), soonest first. */
  comingUp(at = this.now()) {
    const p = sydneyParts(at);
    return this.data.releases(sydneyMidnight(p.y, p.m, p.d), sydneyMidnight(p.y, p.m, p.d + DIGEST_DAYS + 1), 25);
  }

  digestMessage(items) {
    let text = `Releases in the next ${DIGEST_DAYS} days, soonest first:\n`;
    for (const x of items) {
      const t = quiet(clip(x.title, 120)).replace(/[[\]]/g, '');
      const names = x.stores.map((id) => this.storeName(id));
      const line = `\n**${weekday(x.releaseAt)}** — ${x.url ? `[${t}](${x.url.replace(/\)/g, '%29')})` : t}${names.length ? ` · ${names.join(', ')}` : ''}`;
      // (Whole lines only: Discord takes 4,096 characters.)
      if (text.length + line.length > 3900) break;
      text += line;
    }
    return this.notifier.message({ level: 'info', title: '📅 Coming up', embedColor: COLOR, footer: `${this.cfg.appName} News`, message: text });
  }

  /** Each morning in Sydney (8:31 to noon), once a day — when there's something coming up. Returns whether it posted. */
  async digestTick({ at = this.now() } = {}) {
    if (this.digesting) return false;
    const p = sydneyParts(at);
    const mins = p.hour * 60 + p.minute;
    if (mins < DIGEST_FROM || mins >= DIGEST_UNTIL) return false;
    const last = this.repo.getSetting(DIGEST_SETTING);
    if (last && last.day === p.day) return false;
    if (!this.discord || !this.discord.botReady) return false;
    const items = this.comingUp(at);
    if (!items.length) return false;
    this.digesting = true;
    try {
      const ch = await this.channel();
      if (!ch) return false;
      const ok = await this.discord.post(ch.channelId, this.digestMessage(items));
      // (Not posted — Discord down: tried again next time, until noon.)
      if (ok) this.repo.setSetting(DIGEST_SETTING, { day: p.day, at, count: items.length });
      return ok;
    } finally {
      this.digesting = false;
    }
  }

  /** An admin's "Post the digest now": whatever the time, without counting as the day's. */
  async digestNow(user) {
    if (!this.discord || !this.discord.botReady) throw new HttpError(503, "The Discord bot isn't set up yet (Admin → Setup check)");
    const items = this.comingUp();
    if (!items.length) throw bad(`Nothing has a release date in the next ${DIGEST_DAYS} days`);
    const ch = await this.channel();
    if (!ch || !(await this.discord.post(ch.channelId, this.digestMessage(items)))) throw new HttpError(502, "Couldn't post in #news — check the bot can see and post in that channel");
    if (user) this.repo.audit(user.id, null, 'news-digest', `${items.length} releases`);
    return { count: items.length };
  }

  // ---------------------------------------------------------------------------
  // Feeds
  // ---------------------------------------------------------------------------
  addFeed(input, user) {
    const url = httpUrl(input && input.url, 'Feed link');
    if (this.data.feedRows().length >= MAX_FEEDS) throw bad(`${MAX_FEEDS} feeds is the most — remove one first`);
    if (this.data.feedByUrl(url)) throw bad('That feed is on the list already');
    const id = newId('feed');
    this.data.insertFeed({ id, url, name: str(input.name, 60) || hostOf(url).replace(/^www\./, ''), enabled: bool(input.enabled, true), keywords: keywordsFrom(input.keywords) });
    if (user) this.repo.audit(user.id, null, 'news-feed-add', url);
    return toFeed(this.data.feedRow(id));
  }

  /**
   * A feed changed. A new link or words — or switched back on — sets the scene again: its next read
   * is like its first (what's in it then isn't posted), and read in full (no conditional read).
   */
  updateFeed(id, input, user) {
    const row = this.data.feedRow(id);
    if (!row) throw new HttpError(404, 'That feed no longer exists');
    const set = {};
    if (input.url !== undefined) {
      const url = httpUrl(input.url, 'Feed link');
      const other = this.data.feedByUrl(url);
      if (other && other.id !== row.id) throw bad('That feed is on the list already');
      set.url = url;
    }
    if (input.name !== undefined) set.name = str(input.name, 60) || hostOf(set.url || row.url).replace(/^www\./, '');
    if (input.keywords !== undefined) set.keywords = keywordsFrom(input.keywords);
    if (input.enabled !== undefined) set.enabled = bool(input.enabled) ? 1 : 0;
    const anew = (set.url !== undefined && set.url !== row.url) || (set.keywords !== undefined && set.keywords !== row.keywords) || (set.enabled === 1 && !row.enabled);
    if (anew) Object.assign(set, { baseline_at: null, etag: '', last_modified: '', fails: 0, next_at: 0 });
    const fresh = this.data.updateFeed(row.id, set);
    if (user) this.repo.audit(user.id, null, 'news-feed-edit', `${fresh.url}: ${Object.keys(set).filter((k) => ['url', 'name', 'keywords', 'enabled'].includes(k)).map((k) => (k === 'enabled' ? (set.enabled ? 'on' : 'off') : k)).join(', ')}`);
    return toFeed(fresh);
  }

  removeFeed(id, user) {
    const row = this.data.feedRow(id);
    if (!row || !this.data.removeFeed(row.id)) throw new HttpError(404, 'That feed no longer exists');
    if (user) this.repo.audit(user.id, null, 'news-feed-remove', row.url);
    return true;
  }

  /** "Check feeds now": one feed (by id, even switched off), or every one that's on — one after another. */
  async checkNow(id = null) {
    const rows = id ? [this.data.feedRow(id)].filter(Boolean) : this.data.feedRows().filter((r) => r.enabled);
    if (id && !rows.length) throw new HttpError(404, 'That feed no longer exists');
    const out = [];
    for (const r of rows) out.push({ id: r.id, name: r.name, ...(await this.checkFeed(r.id)) });
    return out;
  }

  /** Read one feed now (in its website's line). */
  checkFeed(id) {
    const row = this.data.feedRow(id);
    if (!row) return Promise.resolve({ ok: false, error: 'That feed no longer exists' });
    return this.onHost(row.url, () => this.read(this.data.feedRow(id) || row));
  }

  /** One request at a time to a website, with the monitor's gap between two (on the real clock: it's real waiting). */
  onHost(url, fn) {
    const host = hostOf(url);
    const prev = this.hosts.get(host) || Promise.resolve();
    const run = prev.then(async () => {
      const wait = (this.hostNext.get(host) || 0) - Date.now();
      if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { this.hostNext.set(host, Date.now() + this.hostGapMs); }
    });
    const tail = run.catch(() => null);
    this.hosts.set(host, tail);
    tail.then(() => { if (this.hosts.get(host) === tail) this.hosts.delete(host); });
    return run;
  }

  headers(row) {
    const h = {
      'user-agent': this.cfg.monitor.userAgent,
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
      'accept-language': 'en-AU,en;q=0.9',
    };
    if (row.etag) h['if-none-match'] = row.etag;
    if (row.last_modified) h['if-modified-since'] = row.last_modified;
    return h;
  }

  nextRead(now) {
    return now + POLL_MS + Math.round((Math.random() * 2 - 1) * JITTER_MS);
  }

  failed(row, error) {
    const now = this.now();
    const fails = (row.fails || 0) + 1;
    const nextAt = now + Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(fails, 4));
    this.data.updateFeed(row.id, { last_fetch_at: now, fails, last_error: String(error).slice(0, 200), next_at: nextAt });
    return { ok: false, error, fails, nextAt };
  }

  /**
   * One read of a feed: what's new in it that's release news becomes news (posted in #news, unless
   * it's the feed's first read or old). { ok, notModified, entries, matched, added, posted, error }
   */
  async read(row) {
    let res;
    try {
      const timeoutMs = Math.min(this.cfg.monitor.timeoutMs, 20000);
      res = await safeFetch(this.fetch, row.url, { headers: this.headers(row), timeoutMs, signal: AbortSignal.timeout(timeoutMs), maxBytes: MAX_FEED_BYTES }, { allowPrivate: this.cfg.monitor.allowPrivateHosts });
    } catch (e) {
      return this.failed(row, e instanceof BlockedUrlError ? e.message : e.name === 'TimeoutError' ? 'The website took too long to answer' : "Couldn't reach the website");
    }
    const now = this.now();
    const done = (set) => this.data.updateFeed(row.id, {
      last_fetch_at: now, last_ok_at: now, fails: 0, last_error: '', next_at: this.nextRead(now), baseline_at: row.baseline_at || now,
      etag: res.headers.get('etag') || row.etag || '', last_modified: res.headers.get('last-modified') || row.last_modified || '', ...set,
    });
    if (res.status === 304) {
      done({ last_result: 'Nothing new since the last read (304)' });
      return { ok: true, notModified: true, entries: 0, matched: 0, added: 0, posted: 0 };
    }
    if (!res.ok) return this.failed(row, res.status === 403 || res.status === 429 ? `The website turned Mugibot away (HTTP ${res.status})` : `The website answered HTTP ${res.status}`);
    const feed = parseFeed(await res.text(), row.url);
    if (!feed) return this.failed(row, "That isn't an RSS or Atom feed (the website sent something else — a web page?)");
    const baseline = !row.baseline_at;
    const lists = hypeLists(row.keywords);
    const sourceName = row.name || feed.title || hostOf(row.url);
    let matched = 0;
    let added = 0;
    let posted = 0;
    for (const e of feed.entries) {
      if (!isReleaseNews(e, lists)) continue;
      matched += 1;
      // (Its guid — only this feed's own — else its link; a story another feed brought already isn't news again.)
      const key = e.id ? `${row.id}:${e.id.slice(0, 300)}` : e.link ? `link:${e.link}` : '';
      if (!key || this.data.known(key, e.link)) continue;
      const text = `${e.title} ${e.summary}`;
      const base = e.published || now;
      const date = findDate(e.title, base) || findDate(e.summary, base);
      const id = newId('news');
      if (!this.data.insert({
        id, title: clip(e.title, 200), summary: clip(e.summary, 400), url: e.link, source: 'feed', sourceName, feedId: row.id, category: categoryOf(text),
        stores: this.storesIn(text), releaseAt: date ? date.at : null, releaseText: date ? date.text.slice(0, 60) : '', key, publishedAt: e.published,
      })) continue;
      added += 1;
      // (The first read's backlog sets the scene; an entry published days ago is old news turning up late.)
      const stale = e.published && now - e.published > STALE_MS;
      if (!baseline && !stale && posted < MAX_POSTS_PER_READ) {
        posted += 1;
        this.queuePost(id);
      }
    }
    const result = `${feed.entries.length} entries, ${matched} about releases, ${added} new${baseline ? ' — first read: kept, not posted' : posted ? `, ${posted} posted` : ''}`;
    done({ last_result: result });
    return { ok: true, notModified: false, entries: feed.entries.length, matched, added, posted, baseline };
  }

  // ---------------------------------------------------------------------------
  // The loop
  // ---------------------------------------------------------------------------
  /** Feeds read every 15 minutes, the digest each morning. Off in tests (the monitor's switch) unless forced. */
  start({ force = false } = {}) {
    if (this.running || (!this.cfg.monitor.enabled && !force)) return;
    this.running = true;
    this.spread();
    this.timer = setInterval(() => { this.tick().catch((e) => this.cfg.log('[news]', e.message)); }, TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Feeds due now (just added, or the server was off) spread over the next few minutes, not all at once. */
  spread() {
    const now = this.now();
    const due = this.data.dueFeeds(now);
    const gap = Math.min(90 * 1000, Math.max(20 * 1000, Math.floor(POLL_MS / Math.max(1, due.length))));
    due.forEach((r, i) => this.data.updateFeed(r.id, { next_at: now + 15 * 1000 + i * gap }));
  }

  async tick() {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const now = this.now();
      const jobs = [];
      const hosts = new Set();
      for (const r of this.data.dueFeeds(now)) {
        if (jobs.length >= AT_ONCE) break;
        const host = hostOf(r.url);
        if (!host || hosts.has(host) || this.hosts.has(host)) continue;
        hosts.add(host);
        jobs.push(this.checkFeed(r.id).catch((e) => this.cfg.log('[news]', e.message)));
      }
      await Promise.all(jobs);
      await this.digestTick().catch((e) => this.cfg.log('[news]', e.message));
      if (now - this.prunedAt > DAY) {
        this.prunedAt = now;
        this.data.prune(now - 180 * DAY, now - 30 * DAY);
      }
      return jobs.length;
    } finally {
      this.ticking = false;
    }
  }
}
