// What each VIP and drop watch saw itself (docs/MONITORING.md → What an Auto-checkout watch buys): what decides what
// its Auto-checkout buys. A watch buys what drops after it was added — a new listing, or a restock of something that
// wasn't on sale when it was added — and never what was on sale when it was added. The catalogue's last status can't
// tell which: it's when the status last changed, not when it was last confirmed; some stores' searches don't say the
// stock (City Beach's); a page read and a search can disagree (EB Games' search, and "not available online" on its
// page). So each watch keeps, for each product it's seen at a store (by every code it's been seen under):
//
// - whether it was in the watch's first look there: its own search's (or its page's) first reads — every product in
//   them, whatever its name said then. Done once a read in it had products, or once there have been two reads a minute
//   apart (an empty answer may be the store's hiccup).
// - the first stock reading the watch got of it: a search that says the stock, or a page read that worked — on sale
//   ('on') or not on sale yet ('off': sold out, coming soon, in the store's shops only).
// - whether a read showed it's new since the watch was added (new_at) — never for a product the watch saw before that:
//   - the watch's own search shows it, and its first look — whose every read held all the results the store has for
//     those words, read the same way — didn't; and it's not something the store made before the watch was added, nor
//     (at a store whose results show sold-out products too) something Mugibot's catalogue knew before that look ended —
//     there before, only not under those words: a collection it's been put in, a name the store changed. (At a store
//     that leaves sold-out products out of its results, Target's, one missing from the look was sold out then: its
//     return is a restock.) A look long after the watch was added (a watch from before this release) says so only of
//     what the catalogue has never known (one that sold out since, and was left out of the results, could seem new).
//   - the store made it after the watch was added (its creation time, where its list says it);
//   - new_listings: it's known not to have been listed at a store at a time after the watch was added — a new card
//     listing (new to the catalogue in a card read that can't be an old product moving into view), or another watch's
//     first look, made soon after this one was added, said so.
//
// Its verdict: 'new' — armed, and bought at once when it's on sale; 'armed' — not on sale when the watch first read
// it: armed for its return; 'skipped' — on sale when the watch first read it (there before it, as far as it knows);
// 'pending' — no reading yet (its page is read, at the store's usual pace).

import { STATUS, isOrderable } from './status.js';

const OFF = new Set([STATUS.OUT_OF_STOCK, STATUS.COMING_SOON, STATUS.IN_STORE]);
// A first look of empty reads is done after this many, this far apart at least.
const LOOK_READS = 2;
const LOOK_EMPTY_MS = 60 * 1000;
// A first look this soon after the watch was added says what wasn't listed (or, at a store that leaves sold-out products
// out of its results, on sale) when it was added. Later, something missing may only have sold out or gone since.
const LOOK_NEAR_MS = 15 * 60 * 1000;
// Seen by the watch before its own search showed it: only if that was this lately (a search that left it out longer
// than that wasn't showing everything).
const SEEN_LATELY_MS = 10 * 60 * 1000;
// What one first look keeps of the products it saw.
const LOOK_CODES = 3000;

/** What a status says about being on sale: 'on', 'off' (not on sale yet) or '' (nothing either way). */
export function readingOf(status) {
  if (isOrderable(status)) return 'on';
  return OFF.has(status) ? 'off' : '';
}

/** A product's verdict for a watch, from what the watch saw (null: never seen). */
export function verdictOf(row) {
  if (!row) return 'pending';
  if (row.new_at) return 'new';
  if (row.first === 'off') return 'armed';
  if (row.first === 'on') return 'skipped';
  return 'pending';
}

const low = (c) => String(c).toLowerCase();
const keyOf = (store, sku) => `${store}|${low(sku)}`;
const codesOf = (row) => [row.sku, ...String(row.codes || '').split(' ').filter(Boolean)];

export class Sightings {
  constructor({ db, now = () => Date.now() }) {
    Object.assign(this, { db, now });
    this.rows = new Map(); // a watch → its sightings (store|code → row, each of its codes)
    this.looks = new Map(); // watch|store → its first look there (null: none yet)
  }

  rowsOf(watchId) {
    let m = this.rows.get(watchId);
    if (!m) {
      m = new Map();
      for (const r of this.db.all('SELECT * FROM watch_sightings WHERE watch = :w', { w: watchId })) for (const c of codesOf(r)) m.set(keyOf(r.store, c), r);
      this.rows.set(watchId, m);
    }
    return m;
  }

  /** The watch's sighting of a product at a store (codes: its SKU and aliases), or null. */
  row(watchId, store, codes) {
    const m = this.rowsOf(watchId);
    for (const c of codes) {
      const r = c ? m.get(keyOf(store, c)) : null;
      if (r) return r;
    }
    return null;
  }

  verdict(w, store, codes) {
    return verdictOf(this.row(w.id, store, codes.filter(Boolean)));
  }

  /**
   * A find's verdict, for a find the watch made at `foundAt`: one it made before it kept what it saw (before this
   * release) was seen by it before anything since can say it's new — so it's never new to it, and one it skipped
   * (on sale then) stays skipped.
   */
  findVerdict(w, store, codes, verdict, { foundAt = null, arm = '' } = {}) {
    const row = this.row(w.id, store, codes.filter(Boolean));
    if (!row || !foundAt || foundAt >= row.at) return verdict;
    if (arm === 'skipped') return 'skipped';
    return verdict === 'new' ? verdictOf({ ...row, new_at: null }) : verdict;
  }

  look(watchId, store) {
    const k = `${watchId}|${store}`;
    if (!this.looks.has(k)) {
      const l = this.db.get('SELECT * FROM watch_looks WHERE watch = :w AND store = :s', { w: watchId, s: store });
      if (l) l.seen = new Set(String(l.codes || '').split('\n').filter(Boolean));
      this.looks.set(k, l);
    }
    return this.looks.get(k);
  }

  /** Is the watch's first look at this store still going (what its own reads see is how things were)? */
  lookOpen(w, store) {
    const l = this.look(w.id, store);
    return !l || !l.done_at;
  }

  /**
   * One of the watch's own reads at a store went: whole — it held every result there is; codes — every product in it
   * (each one's codes); how — how it was read (the server's way; an admin's browser drawing or asking from a page).
   */
  ownRead(w, store, { whole, codes = [], how = '' }) {
    const now = this.now();
    let l = this.look(w.id, store);
    if (l && l.done_at) return;
    if (!l) {
      l = { watch: w.id, store, at: now, reads: 0, found: 0, whole: 1, how, codes: '', done_at: null, seen: new Set() };
      this.db.run('INSERT OR IGNORE INTO watch_looks (watch, store, at, how) VALUES (:w, :s, :t, :h)', { w: w.id, s: store, t: now, h: how });
      this.looks.set(`${w.id}|${store}`, l);
    }
    const products = codes.filter((c) => c.length).length;
    l.reads += 1;
    l.found += products;
    for (const list of codes) for (const c of list) if (c && l.seen.size < LOOK_CODES) l.seen.add(low(c));
    // (Read another way partway: it's not one picture.)
    l.whole = l.whole && whole && l.how === how ? 1 : 0;
    if (l.found > 0 || (l.reads >= LOOK_READS && now - l.at >= LOOK_EMPTY_MS)) l.done_at = now;
    this.db.run('UPDATE watch_looks SET reads = :r, found = :f, whole = :wh, codes = :c, done_at = :d WHERE watch = :w AND store = :s',
      { r: l.reads, f: l.found, wh: l.whole, c: [...l.seen].join('\n'), d: l.done_at, w: w.id, s: store });
  }

  /**
   * The watch saw a product at a store. codes: its SKU (kept) and aliases. reading: what this read says of its stock
   * ('on', 'off' or ''); how: what read it. own: the watch's own read (its words' search, its page) — way: how it was
   * read (as ownRead's how). created: when the store made it (null: not said). knownAt: when Mugibot's catalogue first
   * had it at this store, before this read (null: it didn't). hides: the store leaves sold-out products out of its
   * results.
   * Returns { verdict, before } — before: its verdict until now (null: never seen by the watch).
   */
  see(w, store, codes, { reading = '', how = '', own = false, way = '', created = null, knownAt = null, hides = false } = {}) {
    codes = codes.filter(Boolean).map(String);
    if (!codes.length) return { verdict: 'pending', before: null };
    const now = this.now();
    let row = this.row(w.id, store, codes);
    const before = row ? verdictOf(row) : null;
    const look = this.look(w.id, store);
    const inLook = own && (!look || !look.done_at);
    const set = {};
    if (!row) {
      row = { watch: w.id, store, sku: codes[0].slice(0, 120), codes: '', at: now, look: inLook ? 1 : 0, first: '', first_at: null, first_how: '', new_at: null };
      this.db.run('INSERT OR IGNORE INTO watch_sightings (watch, store, sku, at, look) VALUES (:w, :s, :k, :t, :l)', { w: w.id, s: store, k: row.sku, t: now, l: row.look });
      this.rowsOf(w.id).set(keyOf(store, row.sku), row);
    } else if (inLook && !row.look) set.look = 1;
    // (Every code it's been seen under: a page read of it by another finds it.)
    const known = new Set(codesOf(row).map(low));
    const more = codes.map(low).filter((c) => !known.has(c));
    if (more.length) {
      set.codes = [...String(row.codes || '').split(' ').filter(Boolean), ...more].slice(0, 10).join(' ');
      for (const c of more) this.rowsOf(w.id).set(keyOf(store, c), row);
    }
    if (!row.new_at) {
      // Not listed at `since` — at or after the watch was added, and before the watch first saw it.
      const fresh = (since) => typeof since === 'number' && since >= w.createdAt && row.at > since;
      // (Its own search shows it, and its whole first look — read the same way — didn't: not there then.)
      const missed = own && !!look && !!look.done_at && !!look.whole && look.how === way && !codes.some((c) => look.seen.has(low(c)))
        && fresh(look.done_at)
        // …not seen by the watch long before its own search showed it (that search wasn't showing everything)…
        && (before === null || row.at >= now - SEEN_LATELY_MS)
        // …not made by the store before the watch was added, nor in the catalogue before that look ended (there before,
        //  only not under these words: a collection it's been put in, a name the store changed — where sold-out products
        //  show, so missing from the look wasn't selling out)…
        && !(typeof created === 'number' && created < w.createdAt) && !(!hides && typeof knownAt === 'number' && knownAt <= look.done_at)
        // …and a look soon after the watch was added — or else something the catalogue never had at all.
        && (look.at - w.createdAt <= LOOK_NEAR_MS || typeof knownAt !== 'number');
      // (Made by the store after the watch was added: nothing the watch saw can be from before that.)
      const made = typeof created === 'number' && created >= w.createdAt;
      const listed = this.newListing(store, codes);
      const told = !!listed && fresh(listed.since) && (!listed.look || listed.since - w.createdAt <= LOOK_NEAR_MS);
      if (missed || made || told) set.new_at = now;
      // (…and not listed then for any watch added soon before.)
      if (missed && look.at - w.createdAt <= LOOK_NEAR_MS) this.listed(store, row.sku, look.done_at, { look: true });
    }
    if (!row.first && reading) Object.assign(set, { first: reading, first_at: now, first_how: how });
    const keys = Object.keys(set);
    if (keys.length) {
      this.db.run(`UPDATE watch_sightings SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE watch = :w AND store = :s AND sku = :sku`, { ...set, w: w.id, s: store, sku: row.sku });
      Object.assign(row, set);
    }
    return { verdict: verdictOf(row), before };
  }

  /**
   * A read of a product's page that worked: the first stock reading of every watch that's seen it without one yet.
   * Returns the ids of those watches.
   */
  read(store, codes, reading, how) {
    if (!reading) return [];
    const now = this.now();
    const ids = [];
    for (const code of codes.filter(Boolean)) {
      const rows = this.db.all(`SELECT watch, sku FROM watch_sightings WHERE store = :s AND first = ''
        AND (sku = :k OR (' ' || codes || ' ') LIKE :like)`, { s: store, k: code, like: `% ${low(code).replace(/[%_]/g, '')} %` });
      for (const r of rows) {
        this.db.run("UPDATE watch_sightings SET first = :f, first_at = :t, first_how = :h WHERE watch = :w AND store = :s AND sku = :k AND first = ''", { f: reading, t: now, h: how, w: r.watch, s: store, k: r.sku });
        const cached = this.rows.get(r.watch);
        const row = cached && cached.get(keyOf(store, r.sku));
        if (row) Object.assign(row, { first: reading, first_at: now, first_how: how });
        if (!ids.includes(r.watch)) ids.push(r.watch);
      }
    }
    return ids;
  }

  /** What's known not to have been listed, and since when (store|sku → { since, look }): kept in memory too (every search asks). */
  newListings() {
    if (!this.fresh) {
      this.fresh = new Map();
      for (const r of this.db.all('SELECT store, sku, since, look FROM new_listings')) this.fresh.set(keyOf(r.store, r.sku), { since: r.since, look: !!r.look });
    }
    return this.fresh;
  }

  /**
   * A product known not to have been listed at a store at `since`: new to each watch added by then that hadn't seen it.
   * look: what a watch's first look said — only for watches added soon before that look.
   */
  listed(store, sku, since, { look = false } = {}) {
    if (!sku || typeof since !== 'number') return;
    const k = keyOf(store, sku);
    const was = this.newListings().get(k);
    if (was && was.since >= since) return;
    this.db.run(`INSERT INTO new_listings (store, sku, since, at, look) VALUES (:s, :k, :since, :t, :l)
      ON CONFLICT (store, sku) DO UPDATE SET since = excluded.since, at = excluded.at, look = excluded.look`,
    { s: store, k: String(sku).slice(0, 120), since, t: this.now(), l: look ? 1 : 0 });
    this.fresh.set(k, { since, look });
  }

  /** The latest a product is known not to have been listed at a store ({ since, look } or null). */
  newListing(store, codes) {
    let best = null;
    for (const c of codes) {
      const s = c ? this.newListings().get(keyOf(store, c)) : undefined;
      if (s && (!best || s.since > best.since)) best = s;
    }
    return best;
  }

  /** A watch removed: what it saw goes with it. */
  forget(watchId) {
    this.db.run('DELETE FROM watch_sightings WHERE watch = :w', { w: watchId });
    this.db.run('DELETE FROM watch_looks WHERE watch = :w', { w: watchId });
    this.rows.delete(watchId);
    for (const k of [...this.looks.keys()]) if (k.startsWith(`${watchId}|`)) this.looks.delete(k);
  }
}
