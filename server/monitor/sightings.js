// What each VIP and drop watch saw itself (docs/MONITORING.md → VIP drops, Drop watches): what decides what its
// Auto-checkout buys. A watch buys what drops after it was added — a new listing, or a restock of something that wasn't
// on sale when it was added — and never what was on sale when it was added. The catalogue's last status can't tell
// which: it's when the status last changed, not when it was last confirmed; some stores' searches don't say the stock
// (City Beach's); a page read and a search can disagree (EB Games' search, and "not available online" on its page).
// So each watch keeps, for each product it's seen at a store:
//
// - whether it was in the watch's first look there: its own search's (or its page's) first reads — done once one has
//   products in it, or after two (one empty read may be the store's hiccup);
// - the first stock reading the watch got of it: a search that says the stock, or a page read that worked — on sale
//   ('on') or not on sale yet ('off': sold out, coming soon, in the store's shops only);
// - whether a read showed it's new since the watch was added (new_at): the watch's own search shows it, and its first
//   look — whose every read held all the results the store has for those words, read the same way (the server's answer
//   and a page drawn in an admin's browser can differ) — didn't (at a store that leaves sold-out products out of its
//   results, Target's, only a look made soon after the watch was added says so); the store made it
//   after the watch was added; or it's known not to have been listed at a store at a time after the watch was added
//   (new_listings: a new card listing — new to the catalogue in a card search that isn't setting its scene — or another
//   watch's whole first look didn't have it). Never for a product the watch had seen before that time.
//
// Its verdict: 'new' — armed, and bought at once when it's on sale; 'armed' — not on sale when the watch first read
// it: armed for its return; 'skipped' — on sale when the watch first read it (there before it, as far as it knows);
// 'pending' — no reading yet (its page is read, at the store's usual pace).

import { STATUS, isOrderable } from './status.js';

const OFF = new Set([STATUS.OUT_OF_STOCK, STATUS.COMING_SOON, STATUS.IN_STORE]);
// A first look is done once a read in it had products in it, or after this many reads.
const LOOK_READS = 2;
// At a store that leaves sold-out products out of its results, a first look this soon after the watch was added says
// what wasn't on sale when it was (later, something missing may only have sold out since).
const LOOK_NEAR_MS = 15 * 60 * 1000;

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

const keyOf = (store, sku) => `${store}|${String(sku).toLowerCase()}`;

export class Sightings {
  constructor({ db, now = () => Date.now() }) {
    Object.assign(this, { db, now });
    this.rows = new Map(); // a watch → its sightings (store|sku → row)
    this.looks = new Map(); // watch|store → its first look there (null: none yet)
  }

  rowsOf(watchId) {
    let m = this.rows.get(watchId);
    if (!m) {
      m = new Map();
      for (const r of this.db.all('SELECT * FROM watch_sightings WHERE watch = :w', { w: watchId })) m.set(keyOf(r.store, r.sku), r);
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

  look(watchId, store) {
    const k = `${watchId}|${store}`;
    if (!this.looks.has(k)) this.looks.set(k, this.db.get('SELECT * FROM watch_looks WHERE watch = :w AND store = :s', { w: watchId, s: store }));
    return this.looks.get(k);
  }

  /** Is the watch's first look at this store still going (what its own reads see is how things were)? */
  lookOpen(w, store) {
    const l = this.look(w.id, store);
    return !l || !l.done_at;
  }

  /**
   * One of the watch's own reads at a store went: whole — it held every result there is; found — how many products it
   * had; how — how it was read (the server; an admin's browser, and how there).
   */
  ownRead(w, store, { whole, found, how = '' }) {
    const now = this.now();
    let l = this.look(w.id, store);
    if (l && l.done_at) return;
    if (!l) {
      l = { watch: w.id, store, at: now, reads: 0, found: 0, whole: 1, how, done_at: null };
      this.db.run('INSERT OR IGNORE INTO watch_looks (watch, store, at, how) VALUES (:w, :s, :t, :h)', { w: w.id, s: store, t: now, h: how });
      this.looks.set(`${w.id}|${store}`, l);
    }
    l.reads += 1;
    l.found += found;
    // (Read another way partway: it's not one picture.)
    l.whole = l.whole && whole && l.how === how ? 1 : 0;
    if (l.found > 0 || l.reads >= LOOK_READS) l.done_at = now;
    this.db.run('UPDATE watch_looks SET reads = :r, found = :f, whole = :wh, done_at = :d WHERE watch = :w AND store = :s',
      { r: l.reads, f: l.found, wh: l.whole, d: l.done_at, w: w.id, s: store });
  }

  /**
   * The watch saw a product at a store. codes: its SKU (kept) and aliases. reading: what this read says of its stock
   * ('on', 'off' or ''); how: what read it. own: the watch's own read (its words' search, its page) — way: how it was
   * read (as ownRead's how). created: when the store made it (null: not said). hides: the store leaves sold-out products
   * out of its results.
   * Returns { verdict, before } — before: its verdict until now (null: never seen by the watch).
   */
  see(w, store, codes, { reading = '', how = '', own = false, way = '', created = null, hides = false } = {}) {
    codes = codes.filter(Boolean);
    if (!codes.length) return { verdict: 'pending', before: null };
    const now = this.now();
    let row = this.row(w.id, store, codes);
    const before = row ? verdictOf(row) : null;
    const look = this.look(w.id, store);
    const inLook = own && (!look || !look.done_at);
    const set = {};
    if (!row) {
      row = { watch: w.id, store, sku: String(codes[0]).slice(0, 120), at: now, look: inLook ? 1 : 0, first: '', first_at: null, first_how: '', new_at: null };
      this.db.run(`INSERT OR IGNORE INTO watch_sightings (watch, store, sku, at, look) VALUES (:w, :s, :k, :t, :l)`, { w: w.id, s: store, k: row.sku, t: now, l: row.look });
      this.rowsOf(w.id).set(keyOf(store, row.sku), row);
    } else if (inLook && !row.look) set.look = 1;
    if (!row.new_at) {
      // Not listed at `since` — at or after the watch was added, and before the watch first saw it.
      const fresh = (since) => typeof since === 'number' && since >= w.createdAt && row.at > since;
      // (Its own search shows it, and its whole first look — read the same way — didn't: not there then.)
      const missed = own && !!look && !!look.done_at && !!look.whole && look.how === way && !row.look && fresh(look.done_at);
      const near = !!look && look.at - w.createdAt <= LOOK_NEAR_MS;
      // (Made by the store after the watch was added: nothing the watch saw can be from before that.)
      const made = typeof created === 'number' && created >= w.createdAt;
      if ((missed && (!hides || near)) || made || fresh(this.since(store, codes))) set.new_at = now;
      // (…and not listed then for any watch added by then — at a store whose results show sold-out products too.)
      if (missed && !hides) this.listed(store, row.sku, look.done_at);
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
      for (const r of this.db.all("SELECT watch, sku FROM watch_sightings WHERE store = :s AND sku = :k AND first = ''", { s: store, k: code })) {
        this.db.run("UPDATE watch_sightings SET first = :f, first_at = :t, first_how = :h WHERE watch = :w AND store = :s AND sku = :k AND first = ''", { f: reading, t: now, h: how, w: r.watch, s: store, k: r.sku });
        const cached = this.rows.get(r.watch);
        const row = cached && cached.get(keyOf(store, r.sku));
        if (row) Object.assign(row, { first: reading, first_at: now, first_how: how });
        if (!ids.includes(r.watch)) ids.push(r.watch);
      }
    }
    return ids;
  }

  /** What's known not to have been listed, and since when (store|sku → since): kept in memory too (every search asks). */
  newListings() {
    if (!this.fresh) {
      this.fresh = new Map();
      for (const r of this.db.all('SELECT store, sku, since FROM new_listings')) this.fresh.set(keyOf(r.store, r.sku), r.since);
    }
    return this.fresh;
  }

  /** A product known not to have been listed at a store at `since`: new to each watch added by then that hadn't seen it. */
  listed(store, sku, since) {
    if (!sku || typeof since !== 'number') return;
    const k = keyOf(store, sku);
    const was = this.newListings().get(k);
    if (was !== undefined && was >= since) return;
    this.db.run(`INSERT INTO new_listings (store, sku, since, at) VALUES (:s, :k, :since, :t)
      ON CONFLICT (store, sku) DO UPDATE SET since = MAX(new_listings.since, excluded.since), at = excluded.at`,
    { s: store, k: String(sku).slice(0, 120), since, t: this.now() });
    this.fresh.set(k, since);
  }

  /** The latest time a product is known not to have been listed at a store (null: none). */
  since(store, codes) {
    let best = null;
    for (const c of codes) {
      const s = c ? this.newListings().get(keyOf(store, c)) : undefined;
      if (s !== undefined && (best === null || s > best)) best = s;
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
