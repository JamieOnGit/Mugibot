// A store's gate: the checkpoint (JB Hi-Fi's hCaptcha page at /checkpoint) or the virtual queue
// (EB Games', Pokémon Center's) it puts up before a big drop. What a page shows, read the same way
// by the server's checks (monitor/gates.js) and the extension (its copy of this file: lib/gate.js).
//
// A store's `gate` (server/retailers/*.js):
//   kind: 'checkpoint' | 'queue'
//   page: what one of its pages looks like —
//     path: the address's path (JB's /checkpoint), url: anything in the address (Pokémon Center's ?queue),
//     text: words on the page ("You're in the queue!"), markers: in its code (hCaptcha's),
//     wait: the estimated wait, in minutes ("Your estimated wait time is 23 minutes")
//   probe: { path, intervalSeconds } — checked by the server (a store that answers servers: JB Hi-Fi)
//   check: { path, everySeconds } — checked from an admin's browser, as a new visitor (no cookies):
//     a store that turns servers away (EB Games, Pokémon Center)

// A bot check's page instead of the store's: neither the gate nor the store — can't tell.
const CHALLENGE = /just a moment|attention required|access denied|verify you are human|pardon our interruption|_Incapsula_Resource|cf-chl-|captcha-delivery\.com/i;
const CDN_CHECK = /cf-chl-|just a moment\.\.\.|_Incapsula_Resource|captcha-delivery\.com/i;

/** A pattern from a store's definition (a RegExp on the server; { re, f } once it has travelled as JSON). */
export function rx(v) {
  if (v instanceof RegExp) return v;
  if (v && typeof v.re === 'string') { try { return new RegExp(v.re, v.f || ''); } catch { return null; } }
  return null;
}

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(rx).filter(Boolean);

/** The page's words, without its code (for a page's HTML). */
export function textOf(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#39;|&rsquo;|&#8217;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this page the store's gate? { url, text, html } (any of them) → { kind, wait } or null.
 * wait: the estimated wait in minutes, when the page says.
 */
export function gateOnPage(gate, page) {
  if (!gate || !gate.page) return null;
  const p = gate.page;
  const url = String(page.url || '');
  let path = '';
  try { path = new URL(url).pathname; } catch { path = url; }
  const text = page.text !== undefined ? String(page.text) : textOf(page.html);
  const html = String(page.html || '');
  const where = (rx(p.path) && rx(p.path).test(path)) || (rx(p.url) && rx(p.url).test(url));
  const hit = where || list(p.text).some((re) => re.test(text)) || list(p.markers).some((re) => re.test(html));
  if (!hit) return null;
  // A checkpoint is its own address with its check on it (not a 404 page there, nor a page elsewhere
  // that happens to load the same captcha).
  if (gate.kind === 'checkpoint' && (!where || (list(p.markers).length && html && !list(p.markers).some((re) => re.test(html))))) return null;
  const w = rx(p.wait) && text.match(rx(p.wait));
  const wait = w ? Math.min(24 * 60, Math.max(0, parseInt(w[1], 10))) : null;
  return { kind: gate.kind, wait: Number.isFinite(wait) ? wait : null };
}

/**
 * What a check of the store's gate address found: 'up' (the gate), 'down' (the store as usual, or
 * no checkpoint there), or null (a bot check, an error: can't tell). res: { status, url, html }.
 */
export function classify(gate, res) {
  if (!gate || !res) return null;
  const status = Number(res.status) || 0;
  const html = String(res.html || '');
  const on = gateOnPage(gate, { url: res.url, html });
  if (gate.kind === 'checkpoint') {
    // (Not a CDN's own bot check that happens to use a captcha too: that isn't the store's checkpoint.)
    if (on && status === 200) return CDN_CHECK.test(html) ? null : 'up';
    // No checkpoint: the address is gone (404), it sends you on to the store, or there's no check on it.
    if (status === 404 || status === 410) return 'down';
    if (status === 200 && !on && html.length > 200 && !CHALLENGE.test(html)) return 'down';
    return null;
  }
  if (on) return 'up';
  // The store's own page (not a bot check's, not an error): the queue isn't up.
  if (status === 200 && html.length > 1500 && !CHALLENGE.test(html)) return 'down';
  return null;
}
