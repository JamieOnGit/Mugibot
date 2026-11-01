// Health (Mugibot 2.0): /readyz — is this instance really working, not just answering — and each store's reliability
// score for the health panel.
//
// /readyz checks: the database answers (a read and a write in a transaction rolled back), the server monitor ticked in
// the last 30 s (when it's on), the live sweeps are running (when they're on), and the process isn't stalled (event-loop
// delay). 200 with each check when all pass, 503 with the failing ones otherwise — what a deploy waits for before it
// counts as done, and what an uptime check can watch. It never says anything about members, keys or tokens.

const TICK_STALE_MS = 30 * 1000;
const ROLLBACK = Symbol('rollback');

export function readiness(ctx, { lagMs = 0 } = {}) {
  const { cfg, db, monitor, sweeper } = ctx;
  const now = Date.now();
  const checks = {};
  try {
    db.get('SELECT 1 AS ok');
    // (Can it write? The write lock taken and a no-op write made — then rolled back.)
    try {
      db.tx(() => { db.run("UPDATE settings SET value = value WHERE key = '__readyz'"); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    checks.database = { ok: true };
  } catch (e) {
    checks.database = { ok: false, error: String(e.message).slice(0, 120) };
  }
  if (cfg.monitor.enabled && monitor.timer) {
    const age = monitor.lastTickAt ? now - monitor.lastTickAt : null;
    checks.monitor = { ok: age !== null && age < TICK_STALE_MS, lastTickMsAgo: age, inFlight: monitor.inFlight.size };
  } else checks.monitor = { ok: true, off: true };
  if (sweeper && sweeper.settings && sweeper.settings.enabled && cfg.monitor.enabled) {
    checks.sweeps = { ok: !!sweeper.running, running: !!sweeper.running };
  } else checks.sweeps = { ok: true, off: true };
  checks.eventLoop = { ok: lagMs < 2000, lagMs: Math.round(lagMs) };
  const ok = Object.values(checks).every((c) => c.ok);
  return { ok, checks, uptimeS: Math.round(process.uptime()) };
}

/** The event loop's delay, measured every second (a stalled process says so in /readyz). */
export function lagMeter() {
  let lag = 0;
  let last = Date.now();
  const t = setInterval(() => {
    const now = Date.now();
    lag = Math.max(0, now - last - 1000);
    last = now;
  }, 1000);
  t.unref?.();
  return { get lagMs() { return lag; }, stop: () => clearInterval(t) };
}

/**
 * Each store's reliability over the last hour, as one score from 0 to 100 with what it's made of: the share of server
 * reads and searches that worked (60%), how fast its pages answered (P95 under 2 s full marks, 10 s none: 20%), its
 * breaker (closed full marks, half-open half, open none: 10%), and its alerts reaching Discord (P95 under 5 s full marks,
 * 30 s none: 10%). A store with nothing read in the hour has no score (null) — not a bad one.
 */
export function reliability(ctx, { sinceMs = 60 * 60 * 1000 } = {}) {
  const { db, monitor, metrics, retailers } = ctx;
  const since = Date.now() - sinceMs;
  const rows = db.all(`SELECT store, COUNT(*) AS n, SUM(CASE WHEN status IN ('error', 'blocked') THEN 0 ELSE 1 END) AS ok, AVG(ms) AS avg_ms
    FROM check_log WHERE at >= :since GROUP BY store`, { since });
  const breakers = monitor && monitor.breakers ? monitor.breakers.snapshot() : {};
  const out = [];
  for (const r of rows) {
    const read = metrics ? metrics.summary(`page_read_ms{store=${r.store}}`, sinceMs) : null;
    const alert = metrics ? metrics.summary(`detect_to_discord_ms{store=${r.store}}`, sinceMs) : null;
    const success = r.n ? r.ok / r.n : null;
    const scale = (v, good, bad) => (v === null || v === undefined ? 1 : Math.max(0, Math.min(1, (bad - v) / (bad - good))));
    const b = breakers[r.store];
    const breakerScore = !b || b.state === 'closed' ? 1 : b.state === 'half-open' ? 0.5 : 0;
    const score = success === null ? null : Math.round(100 * (0.6 * success + 0.2 * scale(read && read.p95, 2000, 10000) + 0.1 * breakerScore + 0.1 * scale(alert && alert.p95, 5000, 30000)));
    out.push({
      store: r.store, name: retailers.name ? retailers.name(r.store) : r.store, score, reads: r.n, successRate: success === null ? null : Math.round(success * 1000) / 10,
      avgMs: r.avg_ms === null ? null : Math.round(r.avg_ms), readP95Ms: read ? read.p95 : null, breaker: b ? b.state : 'closed', alertP95Ms: alert ? alert.p95 : null,
    });
  }
  return out.sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
}

const sydneyParts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Historical drop intelligence (Mugibot 2.0): each store's drops and restocks over the last `days` (the feed's alerts),
 * when they come — by Sydney weekday and hour — and the windows they come in most. The "likely next" window is an
 * estimate from history (labelled so wherever it's shown), never a promise; none with fewer than MIN_DROPS to go on.
 */
export function dropWindows(ctx, { days = 90, now = Date.now() } = {}) {
  const MIN_DROPS = 5;
  const rows = ctx.db.all("SELECT store, at FROM feed_alerts WHERE at >= :since AND kind IN ('restock', 'listed') AND manual = 0", { since: now - days * 86400000 });
  const by = new Map();
  for (const r of rows) {
    let s = by.get(r.store);
    if (!s) by.set(r.store, (s = { store: r.store, drops: 0, last: 0, buckets: new Map() }));
    s.drops += 1;
    s.last = Math.max(s.last, r.at);
    const parts = Object.fromEntries(sydneyParts.formatToParts(new Date(r.at)).map((p) => [p.type, p.value]));
    const key = `${parts.weekday} ${Number(parts.hour)}`;
    s.buckets.set(key, (s.buckets.get(key) || 0) + 1);
  }
  const out = [];
  for (const s of by.values()) {
    const top = [...s.buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => {
      const [day, hour] = k.split(' ');
      return { day, hour: Number(hour), drops: n, share: Math.round((n / s.drops) * 100) };
    });
    out.push({
      store: s.store, name: ctx.retailers.name ? ctx.retailers.name(s.store) : s.store, drops: s.drops, perWeek: Math.round((s.drops / (days / 7)) * 10) / 10, lastAt: s.last || null,
      windows: top, estimate: s.drops >= MIN_DROPS && top[0] ? `${top[0].day} ${top[0].hour}:00–${(top[0].hour + 1) % 24}:00 (estimate: ${top[0].drops} of ${s.drops} drops in the last ${days} days)` : null,
    });
  }
  return out.sort((a, b) => b.drops - a.drops || DAYS.indexOf(a.name) - DAYS.indexOf(b.name));
}
