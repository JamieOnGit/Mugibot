// What members see of the live sweeps (docs/MONITORING.md): each store's state and its searches —
// never where they come from. Mugibot's server or an admin's browser, the address read, who is
// searching: admins only. A message that would say it is put in plain words, or left out.

// Words that give away where a search came from.
const SOURCE_RE = /\b(admin'?s?|browser|extension|server)\b/i;

/** A store's problem, for members: as it is, unless it says where the searches come from. */
export function publicError(message) {
  const m = String(message || '');
  if (!m) return '';
  return SOURCE_RE.test(m) ? 'Not searched at the moment — Mugibot tries again shortly' : m;
}

/** A store in the live monitor, for members. */
export function publicStore(s) {
  // ("Waiting for an admin's browser" is just "starting" to a member.)
  const waiting = s.status === 'waiting';
  return {
    id: s.id, name: s.name, status: waiting ? 'starting' : s.status,
    searches: s.searches, fails: s.fails, lastAt: s.lastAt, lastOkAt: s.lastOkAt, lastMs: s.lastMs,
    lastError: waiting ? '' : publicError(s.lastError), nextAt: waiting ? null : s.nextAt, slowedUntil: s.slowedUntil,
    retryAt: s.retryAt, resetAt: s.resetAt, latency: s.latency,
  };
}

/** A tracked product, for members: not where its stock was last read from (a search, the server, an admin's browser). */
export function publicProduct(p) {
  if (!p) return p;
  const { statusSource, ...rest } = p;
  return { ...rest, error: publicError(rest.error), ...(p.monitor ? { monitor: { id: p.monitor.id, paused: p.monitor.paused } } : {}) };
}

/** A live event (a search, a problem, a note), for members — or null when it's only for admins. */
export function publicEvent(ev) {
  if (!ev) return null;
  if (ev.type === 'sys') return SOURCE_RE.test(ev.message || '') ? null : ev;
  // (The server's try while an admin's browser searches a store for it: says where searches come from.)
  if (ev.trial) return null;
  const { source, ...rest } = ev;
  // (Someone's own drop watch's words are theirs: monitor/drops.js.)
  if (rest.drop === 'private') rest.keyword = 'a drop watch';
  return rest.error ? { ...rest, error: publicError(rest.error) } : rest;
}
