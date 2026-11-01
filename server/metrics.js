// Delivery and detection metrics (Mugibot 2.0), in memory: how long things take — a store's page read, Discord's
// requests, a drop seen to its alert in Discord, a member's DM — as P50 / P95 / P99 over the last SAMPLES of each (and
// per store where it says), and counts of what failed and what was tried again. For the health panel and /readyz; reset
// by a restart (the check log and feed keep the history that matters).

const SAMPLES = 1000;

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export class Metrics {
  constructor({ now = () => Date.now(), samples = SAMPLES } = {}) {
    this.now = now;
    this.samples = samples;
    this.series = new Map(); // key → { values: number[], at: number[], next }
    this.counters = new Map();
    this.startedAt = now();
  }

  static key(name, labels) {
    const l = labels && Object.keys(labels).length ? Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',') : '';
    return l ? `${name}{${l}}` : name;
  }

  /** A duration (ms) or any value: kept with the last `samples` of its kind, and in its name's total too. */
  observe(name, value, labels = null) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    this.push(name, value);
    if (labels) {
      // (Per store only: an "ok" label goes into the name's total, not a series of its own.)
      const { ok, ...rest } = labels;
      if (Object.keys(rest).length) this.push(Metrics.key(name, rest), value);
      if (ok === false) this.count(`${name}_failed`, rest);
    }
  }

  push(key, value) {
    let s = this.series.get(key);
    if (!s) this.series.set(key, (s = { values: [], at: [], next: 0 }));
    if (s.values.length < this.samples) { s.values.push(value); s.at.push(this.now()); } else {
      s.values[s.next] = value;
      s.at[s.next] = this.now();
      s.next = (s.next + 1) % this.samples;
    }
  }

  count(name, labels = null, n = 1) {
    const key = Metrics.key(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + n);
  }

  /** { n, p50, p95, p99, max } of a series (only what's newer than sinceMs ago, if given), or null. */
  summary(key, sinceMs = null) {
    const s = this.series.get(key);
    if (!s || !s.values.length) return null;
    const from = sinceMs ? this.now() - sinceMs : -Infinity;
    const vals = s.values.filter((_, i) => s.at[i] >= from).sort((a, b) => a - b);
    if (!vals.length) return null;
    return { n: vals.length, p50: percentile(vals, 50), p95: percentile(vals, 95), p99: percentile(vals, 99), max: vals[vals.length - 1] };
  }

  snapshot() {
    const series = {};
    for (const key of this.series.keys()) series[key] = this.summary(key);
    return { since: this.startedAt, series, counters: Object.fromEntries(this.counters) };
  }
}
