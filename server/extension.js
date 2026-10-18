// Builds the Mugibot browser extension for this server: fills in the server
// address and the stores the extension may run on, and adds the page reader
// shared with the server's monitor (for in-browser checks). Used by the
// dashboard's "Download extension" button and by `npm run build:extension`
// (for the Chrome Web Store).

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from './config.js';
import { PAYMENT_HOSTS, RETAILER_DEFS } from './retailers/index.js';
import { makeZip } from './zip.js';

export const EXTENSION_SRC = path.join(ROOT, 'extension');
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(EXTENSION_SRC, 'manifest.json'), 'utf8'));
export const EXTENSION_VERSION = TEMPLATE.version;
// The oldest extension Auto-checkout is ready with at every store. Raise it with a release that changes
// how checkouts are filled in — not every release does (1.13.0 was card backup). 1.14.0: Shopify's,
// Target's (Paydock) and Global-e's checkouts, tile choices, address finders, Amazon's "Buy Now".
// 1.16.0: checkpoints and virtual queues (waits at JB Hi-Fi's checkpoint and in EB Games' and
// Pokémon Center's queues, never refreshing them, then carries on).
export const ACO_EXTENSION_VERSION = '1.16.0';
// The oldest that listens all the time as your checkout browser, so Discord's ⚡ Buy (pressed on
// your phone) starts at once. Older ones pick it up at their next check (within a minute or so).
export const REMOTE_EXTENSION_VERSION = '1.15.0';
// The oldest that knows checkpoints and virtual queues (monitor/gates.js): waits in line without
// refreshing, carries on once through, and says when it's through (older ones get no checks or
// searches at a store while its queue is up).
export const GATE_EXTENSION_VERSION = '1.16.0';
// The monitor's page reader, used by the extension's in-browser checks too.
const SHARED = ['html.js', 'extract.js', 'status.js', 'listing.js', 'gate.js'].map((f) => ({ name: `lib/${f}`, from: path.join(ROOT, 'server', 'monitor', f) }));

const isLocal = (u) => ['localhost', '127.0.0.1'].includes(new URL(u).hostname);

/** Every address the site answers on (BASE_URL first, then EXTRA_ORIGINS). */
export function appOrigins(cfg) {
  const out = [];
  for (const u of [cfg.baseUrl, ...(cfg.extraOrigins || [])]) {
    try { out.push(new URL(u).origin); } catch { /* not an address */ }
  }
  return [...new Set(out)];
}

export function extensionManifest(cfg, { version } = {}) {
  const app = new URL(cfg.baseUrl);
  // Match patterns can't include a port; without one they match every port.
  const appPatterns = [...new Set(appOrigins(cfg).map((o) => { const u = new URL(o); return `${u.protocol}//${u.hostname}/*`; }))];
  const stores = [...new Set(RETAILER_DEFS.flatMap((r) => r.hosts).map((h) => `https://${h}/*`))];
  // Stores' search providers (Kmart's Constructor.io), for admins' browsers that sweep them.
  const searchApis = [...new Set(RETAILER_DEFS.filter((r) => r.sweep && r.sweep.apiBase).map((r) => `${new URL(r.sweep.apiBase).origin}/*`))];
  const local = isLocal(cfg.baseUrl) || (cfg.demoStoreUrl && isLocal(cfg.demoStoreUrl));
  // A server on your own computer also lets the extension work on the dummy store there.
  const dev = local ? ['http://127.0.0.1/*', 'http://localhost/*'] : [];
  if (cfg.demoStoreUrl && !isLocal(cfg.demoStoreUrl)) {
    const d = new URL(cfg.demoStoreUrl);
    dev.push(`${d.protocol}//${d.hostname}/*`);
  }
  const m = structuredClone(TEMPLATE);
  if (version) m.version = version;
  m.name = cfg.appName === 'Mugibot' ? m.name : `${cfg.appName} Checkout`;
  // The app (your account, on any of the site's addresses) and the stores (in-browser restock checks of your own SKUs).
  m.host_permissions = [...new Set([...appPatterns, ...stores, ...searchApis, ...dev])];
  m.content_scripts = [
    { matches: appPatterns, js: ['bridge.js'], run_at: 'document_start' },
    { matches: [...stores, ...dev], js: ['capture.js'], run_at: 'document_start' },
    { matches: [...stores, ...dev], js: ['flows.js', 'core.js', 'fill.js', 'checks.js', 'logins.js', 'content.js'], run_at: 'document_idle' },
    { matches: [...PAYMENT_HOSTS, ...stores, ...dev], js: ['flows.js', 'fill.js', 'checks.js', 'frame.js'], run_at: 'document_idle', all_frames: true },
  ];
  // The app's own pages aren't stores: keep the store scripts off them.
  if (dev.length) for (const cs of m.content_scripts.slice(1)) cs.exclude_matches = [`${app.protocol}//${app.hostname}:${app.port || (app.protocol === 'https:' ? 443 : 80)}/*`];
  return m;
}

export function extensionConfigJs(cfg) {
  return `// Written by the ${cfg.appName} server — the account server this extension talks to.\nglobalThis.MGB_CONFIG = ${JSON.stringify({ server: cfg.baseUrl, appName: cfg.appName, appOrigins: appOrigins(cfg) })};\n`;
}

/** All files of the extension built for this server: [{name, data}]. opts.version: build as another version (tests). */
export function extensionFiles(cfg, opts = {}) {
  const files = [];
  for (const name of fs.readdirSync(EXTENSION_SRC).sort()) {
    const full = path.join(EXTENSION_SRC, name);
    if (!fs.statSync(full).isFile() || name === 'manifest.json' || name === 'config.js') continue;
    files.push({ name, data: fs.readFileSync(full) });
  }
  for (const f of SHARED) files.push({ name: f.name, data: fs.readFileSync(f.from) });
  files.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(extensionManifest(cfg, opts), null, 2)) });
  files.push({ name: 'config.js', data: Buffer.from(extensionConfigJs(cfg)) });
  return files;
}

export function writeExtension(cfg, outDir, opts = {}) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of extensionFiles(cfg, opts)) {
    fs.mkdirSync(path.dirname(path.join(outDir, f.name)), { recursive: true });
    fs.writeFileSync(path.join(outDir, f.name), f.data);
  }
  return outDir;
}

/**
 * The extension's Chrome Web Store listing: set by an admin (Admin → Setup check),
 * else CHROME_STORE_URL. Empty until the extension is published there.
 */
export function storeUrl(cfg, repo) {
  return (repo && repo.getSetting('chrome_store_url')) || cfg.chromeStoreUrl || '';
}

/** A Chrome Web Store listing link (chromewebstore.google.com/detail/…, or the older chrome.google.com/webstore/detail/…). */
export function isStoreUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ((url.hostname === 'chromewebstore.google.com' && url.pathname.startsWith('/detail/'))
      || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore/detail/')));
  } catch {
    return false;
  }
}

/** The package to upload to the Chrome Web Store: the same files, with manifest.json at the top of the zip. */
export function storeZip(cfg) {
  return makeZip(extensionFiles(cfg));
}

let cached = null;
export function extensionZip(cfg) {
  const key = `${cfg.baseUrl}|${(cfg.extraOrigins || []).join(',')}|${cfg.demoStoreUrl}`;
  if (!cached || cached.key !== key) {
    const folder = `${cfg.appName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-extension`;
    cached = { key, zip: makeZip(extensionFiles(cfg).map((f) => ({ name: `${folder}/${f.name}`, data: f.data }))) };
  }
  return cached.zip;
}

export { loadConfig };
