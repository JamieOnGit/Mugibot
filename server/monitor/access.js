// A store whose bot protection takes a browser that reads it too often for a bot (BIG W's Akamai: "Access Denied" —
// and then it turns that whole browser away for a while, the person's own visits and checkouts too). Each of Mugibot's
// ways of reading it from a browser kept its own pace — its searches, its search pages watched, its product pages —
// but nothing kept them in check together: in a browser that reads it in a private window of its own, a search every
// 15 s, every page watched as often as every 3 s (all of them about once a second), and five product pages a round,
// in three tabs at once. That's what got admins' browsers turned away (Oct 2026), and half an hour later the same again.
//
// So a store with retailer `access` has one budget per browser, all three kinds of read together:
// - one of its pages loading at a time in a browser, at least `gapSeconds` between two (`sharedGapSeconds` while it's
//   read in an ordinary window, sharing its cookies with the person's own visits), and at least half the gap after the
//   last one's in (a page doesn't always start the moment it's handed out);
// - shared out by weight (`shares`): a kind that's had less than its share goes first when both are waiting — product
//   pages, asked for a round every 30 s, book the next free slot (an extension that waits for it: 1.39.0) rather than
//   have it kept for them; searches and pages watched, asked for every few seconds, have a slot kept a moment for the
//   one behind. None of them starved, and the browser never left idle long while one waits;
// - that browser turned away all the same ("Access Denied"): nothing more asked of it from there for `pauseMinutes` (as
//   the extension does itself), and its gap doubled (up to `maxGapSeconds`); a bot check instead of the page doubles it
//   too. A step back each `easeMinutes` without one (counted from the end of the pause), down to `gapSeconds` — though
//   for a day, never back down to within half again of the gap it was turned away at: a pace it turned the browser
//   away for isn't tried again straight after. Each browser's own: the store's bot protection turns away a browser, not
//   every browser — and one browser's answers (a member's, say) never slow anyone else's. What each browser learned is
//   kept (setting 'access'), so a restart (a deploy) doesn't start where it was turned away.
// What it did and how often each keyword, page and product was read: view() (the Stores panel), and the live log.
// Nothing here gets round the store's bot protection: it only asks less, and waits when told no.

export const ACCESS_DEFAULTS = Object.freeze({
  gapSeconds: 8,
  sharedGapSeconds: 20,
  maxGapSeconds: 120,
  pauseMinutes: 30,
  easeMinutes: 10,
  // A read handed out and never heard of again (the browser closed): given up on after this long.
  inFlightSeconds: 120,
  // How often each keyword, page and product is asked for (the budget permitting: it decides).
  targetSeconds: 5,
  shares: Object.freeze({ search: 2, check: 2, page: 1 }),
  // Product pages a round (read one after another), from an extension that waits the gap between them (1.39.0).
  checksPerRound: 2,
});
export const KINDS = Object.freeze(['search', 'page', 'check']);
// A kind that asked this lately is waiting its turn.
const DEMAND_MS = 45 * 1000;
// A free slot kept for a kind behind on its share, at most this long (an older extension's product pages are asked for
// every 30 s — and can't book one).
const HOLD_MS = 35 * 1000;
// How far ahead a round of product pages may book the next free slot (it waits for it: extension 1.39.0).
export const BOOK_MS = 20 * 1000;
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
// Browsers whose learning is kept, a store: the most lately turned away.
const KEPT_BROWSERS = 100;

// What a setting may be (an override from the deployment's settings — MONITOR_ACCESS — is kept within these).
const BOUNDS = Object.freeze({
  gapSeconds: [3, 600], sharedGapSeconds: [3, 600], maxGapSeconds: [3, 3600], pauseMinutes: [5, 240], easeMinutes: [1, 1440],
  inFlightSeconds: [30, 600], targetSeconds: [1, 3600], checksPerRound: [1, 5],
});

export class AccessBudget {
  /** overrides: the deployment's changes to stores' budgets, by store (config monitor.access). */
  constructor({ now = () => Date.now(), repo = null, log = () => {}, sys = null, overrides = {} } = {}) {
    Object.assign(this, { now, repo, log, sys, overrides: overrides || {} });
    this.stores = new Map(); // store id → its state
    this.configs = new Map(); // store id → its settings
    this.saved = (repo && repo.getSetting('access')) || {};
  }

  /** The store's budget (null: none — its reads are paced as they always were). */
  configFor(r) {
    if (!r || !r.access) return null;
    let c = this.configs.get(r.id);
    if (!c) {
      const over = this.overrides[r.id] && typeof this.overrides[r.id] === 'object' ? this.overrides[r.id] : {};
      const a = { ...r.access, ...over, shares: { ...(r.access.shares || {}), ...(over.shares || {}) } };
      c = { ...ACCESS_DEFAULTS, shares: { ...ACCESS_DEFAULTS.shares } };
      for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
        const v = Number(a[k]);
        if (a[k] !== undefined && Number.isFinite(v)) c[k] = Math.min(hi, Math.max(lo, k === 'checksPerRound' ? Math.round(v) : v));
      }
      for (const k of KINDS) {
        const v = Number(a.shares[k]);
        if (a.shares[k] !== undefined && Number.isFinite(v)) c.shares[k] = Math.min(10, Math.max(0.1, v));
      }
      // (An ordinary window never closer than a private one; the widest gap never under the narrowest.)
      c.sharedGapSeconds = Math.max(c.sharedGapSeconds, c.gapSeconds);
      c.maxGapSeconds = Math.max(c.maxGapSeconds, c.sharedGapSeconds);
      this.configs.set(r.id, c);
      if (Object.keys(over).length) this.log('[access]', `store=${r.id} event=settings ${Object.entries(c).filter(([k]) => k !== 'shares').map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }
    return c;
  }

  limited(r) {
    return !!(r && r.access);
  }

  /** How often each keyword, page and product is asked for (ms) — the budget deciding how often it really is. */
  targetMs(r) {
    const c = this.configFor(r);
    return c ? c.targetSeconds * 1000 : null;
  }

  state(r) {
    let s = this.stores.get(r.id);
    if (!s) {
      const kept = this.saved[r.id] || {};
      s = {
        browsers: new Map(),
        kept: kept.browsers && typeof kept.browsers === 'object' ? kept.browsers : {}, // browser → what it learned
        loads: Object.fromEntries(KINDS.map((k) => [k, []])), // each kind's pages started, the last hour (every browser)
        reads: new Map(), // kind|key → { at, gaps }
      };
      this.stores.set(r.id, s);
    }
    return s;
  }

  browser(r, s, who) {
    const k = String(who || '');
    let b = s.browsers.get(k);
    if (!b) {
      const c = this.configFor(r);
      const kept = s.kept[k] || {};
      const min = c.gapSeconds * 1000;
      b = {
        who: k, inFlight: null, lastStartAt: 0, freeAt: 0, priv: null,
        // (kinds: each kind's share of this browser used — vt — when it last asked, and whether it books its slot.)
        kinds: Object.fromEntries(KINDS.map((x) => [x, { vt: 0, wantAt: 0, books: false }])),
        // What it learned: its gap, when it was last turned away, eased, its floor for a day, its pause, its blocks.
        gapMs: Math.min(c.maxGapSeconds * 1000, Math.max(min, Number(kept.gapMs) || 0)),
        lastBlockAt: Number(kept.lastBlockAt) || 0,
        easedAt: Number(kept.easedAt) || Number(kept.lastBlockAt) || 0,
        floorMs: Number(kept.floorMs) || 0,
        floorUntil: Number(kept.floorUntil) || 0,
        pausedUntil: Number(kept.pausedUntil) || 0,
        blocks: (Array.isArray(kept.blocks) ? kept.blocks : []).filter((t) => typeof t === 'number'),
      };
      s.browsers.set(k, b);
    }
    return b;
  }

  /** The gap between two of the store's pages from this browser (eased back a step after a while without a block). */
  gapFor(r, b, now = this.now()) {
    const c = this.configFor(r);
    const min = Math.max(c.gapSeconds * 1000, b.floorUntil > now ? b.floorMs : 0);
    if (b.gapMs > min && now - Math.max(b.lastBlockAt, b.easedAt) >= c.easeMinutes * 60 * 1000) {
      const was = b.gapMs;
      b.gapMs = Math.max(min, Math.round(b.gapMs * 0.75));
      b.easedAt = now;
      this.save(r, b);
      this.note(r, 'eased', `${r.name}: not turned away for ${c.easeMinutes} min — its pages from that browser at most every ${secs(b.gapMs)} again (was ${secs(was)})`, { who: b.who, gapMs: b.gapMs, was });
    }
    return b.priv === false ? Math.max(b.gapMs, c.sharedGapSeconds * 1000) : b.gapMs;
  }

  /** The gap between two of the store's pages from this browser now (ms): what a round of its product pages waits between them. */
  gapMs(r, who) {
    if (!this.configFor(r)) return 0;
    return this.gapFor(r, this.browser(r, this.state(r), who));
  }

  /** The least share of this browser used by the kinds waiting (but `but`'s; holders: only those a slot is kept for), or null. */
  minVt(b, now, but = null, { holders = false } = {}) {
    let min = null;
    for (const k of KINDS) {
      if (k === but) continue;
      const x = b.kinds[k];
      if (now - x.wantAt > DEMAND_MS || (holders && x.books)) continue;
      if (min === null || x.vt < min) min = x.vt;
    }
    return min;
  }

  /**
   * May this browser start one of the store's pages now, for this kind of read? { ok: true } — or { ok: false, at, why }:
   * when to ask again, and why not now ('paused': it was turned away; 'busy': one of its pages still loading; 'gap'; 'share':
   * another kind's turn). priv: it reads the store in its private window (null: not said). bookMs: it may book the next free
   * slot up to this far ahead — { ok: true, startAt }: it starts its first page then, and not before the store's other tabs
   * in that browser are done (a round of product pages from extension 1.39.0).
   */
  ask(r, who, kind, { priv = null, bookMs = 0 } = {}) {
    const c = this.configFor(r);
    if (!c) return { ok: true };
    const now = this.now();
    const b = this.browser(r, this.state(r), who);
    if (typeof priv === 'boolean') b.priv = priv;
    const k = b.kinds[kind];
    // (Back after a while: no credit for the time it didn't ask — its share starts level with the others'.)
    if (now - k.wantAt > DEMAND_MS) {
      const level = this.minVt(b, now, kind);
      if (level !== null) k.vt = Math.max(k.vt, level);
    }
    k.wantAt = now;
    k.books = bookMs > 0;
    if (b.pausedUntil > now) return { ok: false, at: b.pausedUntil, why: 'paused' };
    if (b.inFlight && now - b.inFlight.at >= c.inFlightSeconds * 1000) {
      // (Handed out and never heard of again — the browser closed, say: given up on.)
      this.note(r, 'lost', `${r.name}: a ${b.inFlight.kind} read handed to a browser ${Math.round((now - b.inFlight.at) / 1000)} s ago never came back — given up on`, { who: b.who, kind: b.inFlight.kind }, 'debug');
      b.inFlight = null;
      b.freeAt = now;
    }
    const gap = this.gapFor(r, b, now);
    const free = Math.max(b.lastStartAt + gap, b.freeAt ? b.freeAt + Math.round(gap / 2) : 0);
    const ahead = (min) => min !== null && k.vt > min + 1 / c.shares[kind] + 1e-9;
    if (bookMs > 0) {
      // (Its round books the next free slot — after what's loading now: the browser waits for its own tabs — unless it's
      //  had more than its share, or the slot's too far off: the next round, then.)
      if (b.inFlight && b.inFlight.kind === kind) return { ok: false, at: now + 1000, why: 'busy' };
      if (ahead(this.minVt(b, now, kind))) return { ok: false, at: now + bookMs, why: 'share' };
      if (free - now > bookMs) return { ok: false, at: free, why: 'gap' };
      return { ok: true, startAt: Math.max(now, free) };
    }
    if (b.inFlight) return { ok: false, at: now + 1000, why: 'busy' };
    if (free > now) return { ok: false, at: free, why: 'gap' };
    // (A slot kept a moment for a kind behind on its share that can't book one.)
    if (ahead(this.minVt(b, now, kind, { holders: true })) && now - free < HOLD_MS) {
      return { ok: false, at: Math.min(free + HOLD_MS, now + 5000), why: 'share' };
    }
    return { ok: true };
  }

  /**
   * One or more of the store's pages handed to this browser now (n: a round of product pages, read one after another,
   * the gap between them; startAt: when the first starts, if it booked a slot ahead). keys: which keyword, page or product
   * each is (how often each is read: view()).
   */
  take(r, who, kind, { n = 1, keys = [], startAt = null } = {}) {
    const c = this.configFor(r);
    if (!c || n < 1) return;
    const now = this.now();
    const start = Math.max(now, startAt || 0);
    const s = this.state(r);
    const b = this.browser(r, s, who);
    const gap = this.gapFor(r, b, now);
    b.inFlight = { kind, n, left: n, at: now };
    b.lastStartAt = start + (n - 1) * gap;
    const k = b.kinds[kind];
    k.vt += n / c.shares[kind];
    k.wantAt = now;
    for (let i = 0; i < n; i++) s.loads[kind].push(start + i * gap);
    s.loads[kind] = s.loads[kind].filter((t) => now - t < HOUR);
    for (const key of keys.slice(0, n)) {
      const id = `${kind}|${key}`;
      const rec = s.reads.get(id) || { at: 0, gaps: [] };
      if (rec.at) rec.gaps = [...rec.gaps.slice(-19), start - rec.at];
      rec.at = start;
      s.reads.set(id, rec);
    }
    if (s.reads.size > 2000) for (const [id, rec] of s.reads) if (now - rec.at > HOUR) s.reads.delete(id);
  }

  /**
   * What came of this browser's read there: 'ok', 'denied' (its bot protection turned the browser away), 'challenge' (a
   * bot check instead of its page) or 'failed' (anything else: a timeout, a page that didn't load).
   */
  done(r, who, kind, outcome = 'ok') {
    if (!this.configFor(r)) return;
    const now = this.now();
    const b = this.browser(r, this.state(r), who);
    // (A round of product pages: done once each is.)
    if (b.inFlight && b.inFlight.kind === kind && (b.inFlight.left -= 1) <= 0) {
      b.inFlight = null;
      b.freeAt = now;
    }
    if (outcome === 'denied' || outcome === 'challenge') this.blocked(r, b, kind, outcome, now);
  }

  /**
   * This browser's round of that kind is over, whatever it said (it asks for the next one only once it is): nothing in
   * flight. (When it ended isn't known — some time before now: the gap from its last start still holds.)
   */
  settled(r, who, kind) {
    if (!this.configFor(r)) return;
    const b = this.browser(r, this.state(r), who);
    if (b.inFlight && b.inFlight.kind === kind) b.inFlight = null;
  }

  /** The browser's tabs still reading (it says when it asks for searches): a search or a page of it no longer among them is done. */
  idle(r, who, busy) {
    if (!this.configFor(r)) return;
    const b = this.browser(r, this.state(r), who);
    const f = b.inFlight;
    if (!f || f.kind === 'check') return;
    const tab = f.kind === 'page' ? `page:${r.id}` : r.id;
    if (!busy.has(tab) && this.now() - f.at > 2000) {
      b.inFlight = null;
      b.freeAt = this.now();
    }
  }

  blocked(r, b, kind, outcome, now) {
    const c = this.configFor(r);
    // (The rest of a round turned away with it — the same block.)
    if (outcome === 'denied') {
      if (b.pausedUntil > now) return;
      b.pausedUntil = now + c.pauseMinutes * 60 * 1000;
    } else if (now - b.lastBlockAt < 60 * 1000) return;
    b.blocks = [...b.blocks.filter((t) => now - t < DAY), now].slice(-50);
    const was = b.gapMs;
    const max = c.maxGapSeconds * 1000;
    b.gapMs = Math.min(max, b.gapMs * 2);
    // (Not eased back down to within half again of the gap it was turned away at, for a day.)
    b.floorMs = Math.min(max, Math.max(b.floorUntil > now ? b.floorMs : 0, Math.round(was * 1.5)));
    b.floorUntil = now + DAY;
    b.lastBlockAt = now;
    // (Eased back only once it's been asked again a while: the pause first.)
    b.easedAt = outcome === 'denied' ? b.pausedUntil : now;
    this.save(r, b);
    const what = outcome === 'denied'
      ? `"Access Denied" (its bot protection) to a browser on a ${kind} read — nothing more asked of it from that browser for ${c.pauseMinutes} min`
      : `a bot check instead of its page to a browser on a ${kind} read`;
    this.note(r, outcome, `${r.name} showed ${what}; its pages from that browser at most every ${secs(b.gapMs)} from now (was ${secs(was)})`, { who: b.who, kind, gapMs: b.gapMs, was, blocks24h: b.blocks.length }, 'warn');
  }

  /** What this browser learned there, kept over a restart (the browsers most lately turned away). */
  save(r, b) {
    const s = this.state(r);
    s.kept[b.who] = { gapMs: b.gapMs, lastBlockAt: b.lastBlockAt, easedAt: b.easedAt, floorMs: b.floorMs, floorUntil: b.floorUntil, pausedUntil: b.pausedUntil, blocks: b.blocks };
    const now = this.now();
    s.kept = Object.fromEntries(Object.entries(s.kept)
      .filter(([, x]) => now - (x.lastBlockAt || 0) < 7 * DAY)
      .sort((x, y) => (y[1].lastBlockAt || 0) - (x[1].lastBlockAt || 0)).slice(0, KEPT_BROWSERS));
    this.saved = { ...this.saved, [r.id]: { browsers: s.kept } };
    if (this.repo) this.repo.setSetting('access', this.saved);
  }

  /** The live log and the server's log: what happened (event), plain, and as key=value pairs to search by. */
  note(r, event, message, fields = {}, level = 'info') {
    const pairs = Object.entries({ store: r.id, event, ...fields }).map(([k, v]) => `${k}=${v}`).join(' ');
    this.log('[access]', pairs);
    if (this.sys && level !== 'debug') this.sys(message, { store: r.id, level: level === 'warn' ? 'warn' : 'info' });
  }

  /**
   * What the budget is doing at a store (the Stores panel): the gap between two of its pages from the browsers reading it
   * lately (the widest), its pauses and blocks, and how often each kind's read.
   */
  view(r) {
    const c = this.configFor(r);
    if (!c) return null;
    const now = this.now();
    const s = this.state(r);
    const all = [...s.browsers.values()];
    const live = all.filter((x) => x.lastStartAt && now - x.lastStartAt < HOUR);
    const avg = (list) => (list.length ? Math.round(list.reduce((a, x) => a + x, 0) / list.length / 100) / 10 : null);
    const cadence = {};
    for (const kind of KINDS) {
      const gaps = [];
      let items = 0;
      for (const [id, rec] of s.reads) {
        if (!id.startsWith(`${kind}|`) || now - rec.at > HOUR) continue;
        items += 1;
        gaps.push(...rec.gaps);
      }
      cadence[kind] = { items, everySeconds: avg(gaps), loads1h: s.loads[kind].filter((t) => now - t < HOUR && t <= now).length };
    }
    const gap = Math.max(c.gapSeconds * 1000, ...live.map((x) => this.gapFor(r, x, now)));
    const floors = all.filter((x) => x.floorUntil > now).map((x) => x.floorMs);
    const blocks = all.flatMap((x) => x.blocks.filter((t) => now - t < DAY));
    return {
      gapSeconds: Math.round(gap / 100) / 10,
      minGapSeconds: c.gapSeconds, maxGapSeconds: c.maxGapSeconds, sharedGapSeconds: c.sharedGapSeconds, targetSeconds: c.targetSeconds,
      floorSeconds: floors.length ? Math.round(Math.max(...floors) / 100) / 10 : null,
      pausedBrowsers: all.filter((x) => x.pausedUntil > now).length,
      pausedUntil: all.reduce((m, x) => (x.pausedUntil > now ? Math.max(m, x.pausedUntil) : m), 0) || null,
      browsers: live.length,
      blocks24h: blocks.length,
      lastBlockAt: all.reduce((m, x) => Math.max(m, x.lastBlockAt), 0) || null,
      cadence,
    };
  }
}

/**
 * What came of a browser's read, from what it said: 'denied' (the store's bot protection turned the browser away —
 * "Access Denied", an HTTP 403 page), 'challenge' (a bot check where the page should be), 'failed' (anything else that
 * didn't read), or 'ok'. ok / blocked / status / error / problem: a search's or page's result; a product read's status.
 */
export function outcomeOf({ ok = true, blocked = false, status = null, error = '', problem = null } = {}) {
  const said = String(error || '');
  if (/access denied/i.test(said) || (blocked && Number(status) === 403)) return 'denied';
  if (problem === 'blocked' || /bot check/i.test(said) || status === 'blocked') return 'challenge';
  if (!ok || status === 'error') return 'failed';
  return 'ok';
}

function secs(ms) {
  return `${Math.round(ms / 100) / 10} s`;
}
