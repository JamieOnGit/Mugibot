// A circuit breaker per store (Mugibot 2.0): when a store keeps failing — down, timing out, refusing — the server stops
// asking it for a while instead of failing (and timing out) once on every one of its pages, and holding a check slot
// for up to 15 s each time. Closed (asking as usual) → after THRESHOLD failed reads in a row, open: nothing asked for
// a backoff (30 s, doubling each time it opens again, up to 10 minutes, ±20% jitter so stores don't come back in step;
// never sooner than a Retry-After the store gave) → half-open: one read lets it try; that read working closes it again,
// failing opens it for longer. A read the store answered (in stock, sold out, not found…) is a success: only failures
// to read count (monitor/index.js FAILED).

export const THRESHOLD = 5;
export const BASE_MS = 30 * 1000;
export const MAX_MS = 10 * 60 * 1000;
// A Retry-After honoured up to this long.
const RETRY_AFTER_MAX_MS = 30 * 60 * 1000;

export class Breakers {
  constructor({ now = () => Date.now(), random = Math.random, log = () => {}, threshold = THRESHOLD, baseMs = BASE_MS, maxMs = MAX_MS } = {}) {
    Object.assign(this, { now, random, log, threshold, baseMs, maxMs });
    this.map = new Map();
  }

  get(key) {
    let b = this.map.get(key);
    if (!b) {
      b = { fails: 0, level: -1, openUntil: 0, probing: false, opened: 0, lastError: '', lastOpenedAt: null };
      this.map.set(key, b);
    }
    return b;
  }

  /** 'closed' | 'open' | 'half-open' (open, its backoff over: one read may try). */
  state(key) {
    const b = this.map.get(key);
    if (!b || !b.openUntil) return 'closed';
    return this.now() < b.openUntil ? 'open' : 'half-open';
  }

  /** May a read of this store start now? Half-open: one at a time (the probe). */
  allow(key) {
    const s = this.state(key);
    if (s === 'closed') return true;
    if (s === 'open') return false;
    const b = this.get(key);
    if (b.probing) return false;
    b.probing = true;
    return true;
  }

  success(key) {
    const b = this.map.get(key);
    if (!b) return;
    const was = b.openUntil ? 'open' : null;
    Object.assign(b, { fails: 0, level: -1, openUntil: 0, probing: false });
    if (was) this.log(JSON.stringify({ evt: 'monitor.breaker', store: key, state: 'closed' }));
  }

  /** A failed read (retryAfterMs: the store's Retry-After, if it gave one). Returns the state after it. */
  failure(key, { retryAfterMs = 0, error = '' } = {}) {
    const b = this.get(key);
    const halfOpen = !!b.openUntil;
    b.fails += 1;
    b.lastError = String(error || '').slice(0, 200);
    b.probing = false;
    if (!halfOpen && b.fails < this.threshold && !(retryAfterMs > 0)) return 'closed';
    b.level = Math.min(b.level + 1, 12);
    const backoff = Math.min(this.maxMs, this.baseMs * 2 ** b.level);
    const jittered = Math.round(backoff * (0.8 + this.random() * 0.4));
    const wait = Math.max(jittered, Math.min(RETRY_AFTER_MAX_MS, retryAfterMs || 0));
    b.openUntil = this.now() + wait;
    b.opened += 1;
    b.lastOpenedAt = this.now();
    this.log(JSON.stringify({ evt: 'monitor.breaker', store: key, state: 'open', fails: b.fails, waitMs: wait, error: b.lastError }));
    return 'open';
  }

  /** For the health panel: each store's breaker. */
  snapshot() {
    const out = {};
    for (const [key, b] of this.map) {
      out[key] = { state: this.state(key), fails: b.fails, openUntil: b.openUntil || null, opened: b.opened, lastError: b.lastError, lastOpenedAt: b.lastOpenedAt };
    }
    return out;
  }
}

/** A Retry-After header's wait in ms (seconds or an HTTP date), or 0. */
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, Math.round(s * 1000));
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - now) : 0;
}
