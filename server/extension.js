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
// Pokémon Center's queues, never refreshing them, then carries on). (1.16.1 types the card into
// payment frames sooner — a frame asking for the focus before the page is listening asks again —
// and works the same either way.) 1.17.0: several runs at once — side by side at different stores, in
// turn at the same one (its one bag), at full speed in a tab behind — and never stuck between the bag
// and checkout. 1.19.0: six more stores (Pokébox, Good Games, Collectible Madness, Cherry
// Collectables, The Gamesmen, Games World), every store's buy button by the same words (words.js:
// "Buy now" too), boxes ticked or unticked by the flow, WooCommerce's drop-downs and add-to-cart
// link, and a card Stripe's Link has for you.
// 1.21.0: a checkout your account ended while it waited at a checkpoint (finished on your phone
// instead) stops once through the check, never carrying on to the final button.
// 1.22.0: Shop checkout links (retailers/shoplink.js) — runs on Shop's checkout (shop.app): the store's
// required boxes ticked, "Pay now", the order seen placed as Shop goes on to the store's order page; and
// a link that never reaches Shop (signed out of it) said in seconds. The store's acoVersion says so.
// 1.23.0: the panel's "Add to bag → Checkout" checks out a product that isn't on your watchlist (read off
// its page); an admin's browser searches each store on its own, side by side (busy=…), not one after another.
// 1.24.0: Shop checkout links — your Shop sign-in read off the checkout's screen (never shop.app's own pages
// or any page's source), and a checkout that says it isn't on sale yet waited on, "Pay now" the moment it is.
// 1.25.0: hot drops — a store's slow page waited for while it's plainly still coming in (its Add button, the
// add, checkout), its error page looked at again after a wait (never a queue's), a slow add never pressed
// twice nor left for the bag early, and no second tab for a run; a cart in a pop-up (EB Games') read as the bag.
// 1.26.0: drop watches at websites refusing the server — read from your browser (an admin's for one for
// everyone) once you've allowed the extension on that website (its menu: Allow); it says which (sites=…).
// 1.27.0: "Place the order for me" for checkouts you start (⚡ Buy, the panel's) as for armed drops; the final
// button pressed the moment it's filled in, and again while a struggling store doesn't answer (up to 30 minutes,
// never past a decline or a check); agreement boxes ticked (Shop's Membership Agreement); other things in the
// bag flagged, not stopped for; EB Games' empty-cart pop-up; BIG W read by opening its page, left alone for
// 30 minutes when it says "Access Denied" (monitor RENDER_EXTENSION_VERSION).
// 1.27.1: Shop checkout links on Mattel Creations' real checkout — "Pay now $47.99" (the total in the button)
// is the final button, the membership box ticked by the words beside its label, and "This Product is not
// available for purchase" answered by pressing "Pay now" again every 2 s until the store takes the order (up
// to 8 hours; the checkout reloaded every 10 minutes). The store's checkout queue waited in, never refreshed — on
// the way in or sent back at the drop — then carried on at Shop's checkout (background.js heldUp); 🚦 Wait for
// queue, then ACO (the link opened again every 15 s until the queue's up); a link's discount code typed in and
// applied first (cleared if not taken); a box that signs you up to anything never ticked. Waits timed by the
// extension (a hidden tab's timers are held back), the tab's checkout flag kept good. Shop links need it.
// 1.27.2: a run stopped on your dashboard (its ■ Stop) is stopped in its tab here too — before its first press
// as well (later presses ask your account first, so 1.27.1 stops at its next one). Shopify's "Too many checkout
// attempts": nothing pressed, waited out (3 minutes), the link opened again; "Pay now" every 6 s, the link opened
// again every 90 s. Listens while a ⏰ 🚦 Wait for queue, then ACO is set for later.
// 1.28.0: Gameology (www.gameology.com.au) — its pages are new to the extension (retailers/gameology.js: an older
// copy can't open them, so its acoVersion asks for this one). Nothing else changed in how checkouts go.
// BIG W: a search page's own "Next" link is sent back with what it found (its later pages are read where it goes),
// and the browser checks say this copy's version (an updated copy gets BIG W's pages at once).
// 1.30.0: BIG W read in a private (Incognito) window of its own, where Mugibot's allowed in Incognito — its searches
// and page reads apart from your own BIG W visits and checkouts; an ordinary window otherwise, as before. And your
// bank's check after the final button seen as real checkouts show it, at every store, whatever the bank — a frame
// with no address to go by (named for it, or a pop-up in front of the checkout), one inside the payment provider's
// frame (every frame looked at), a page of the store's own, a window of its own, the tab sent to the bank's site,
// words about approving the payment: you're told at once (a DM: approve it in your bank's app), and the order's
// marked placed once the store confirms it. Before, such a run waited out the half hour as "no answer" (Oct 2026:
// two runs, EB Games' and Good Games').
// 1.31.0: Click & Collect when a store doesn't offer home delivery for an order (a pick-up-only pre-order), at every
// store — its home delivery switched off, not there, or the checkout saying so (fill.js: collectStep) — at the store
// nearest you (your postcode, or where your delivery details say): its store finder searched and its first store
// chosen, or its drop-down's, or its list's; said on the run and in the order's DM. Your delivery details can say
// home delivery only (stopped for you instead). A product page whose only buy button adds it for Click & Collect has
// it pressed. Your delivery details read afresh as each checkout starts.
// 1.32.0: a search page Mugibot couldn't see any products on (BIG W's) says what the page itself said — "No results
// for …" (and it stops waiting there at once, not 15 s later) or "57 results" that hadn't been drawn yet when it was
// read — so a search with none and a page not drawn yet are told apart. Nothing else changed in how checkouts go.
// 1.32.1: a product page whose store streams it in hidden and draws its buy button with its own code (the Riot Games
// Store's) is read from the store's own page data when a browser checks it: coming soon, then in stock or a pre-order.
// 1.33.0: several cards (up to 6), one of them your default — the one every checkout uses — chosen in Card settings or
// on the dashboard; a watchlist item can pay with another of them (Pay with). Backups and the copy kept for updates
// hold them all (an older extension restores the default). ↻ Reset of a store searched from an admin's browser clears
// that store's cached files there too (never its cookies or sign-in): the browsingData permission, which Chrome adds
// without asking. And with the checkout browser's backup on, every browser of yours listens, so an open one checks
// out while the checkout browser isn't (only one ever does).
// 1.34.0: drop watches on a search page (monitor/pages.js) — an admin's browser reads a store's search, category or
// collection page every few seconds in a tab of its own in the sweep window (one for each store, beside its
// searches): the data the page fetches (EB Games' /search/query, with the page's own filters), learned from the
// page and asked for from inside it — never the browser's cached copy — or the page itself once it's drawn.
// Nothing else changed in how searches or checkouts go.
// 1.35.0: EB Games' watchlist items checked from inside a tab of EB Games' in the extension's window (its Cloudflare
// refused the background checks: "Blocked by site", HTTP 403, on every item — while your own visits, ⚡ Buy and
// Auto-checkout went through): each item's page asked for there the way EB's own pages ask it for things, or opened
// there as you'd open it when that's refused too; a product code with no link yet looked up in EB's own search data.
// Nothing else changed in how searches or checkouts go.
// 1.29.0: quantities — ⚡ Buy and Auto-checkout put as many in the bag as the item says (its product page's
// drop-down, box or − / + set before Add; none on the page, the bag's), cart links with that many. From The
// Deep Games (fromthedeepgames.com.au) is new to it too. And searching all day from an admin's browser (BIG W):
// its sweep tabs never discarded by Chrome, a search that never ends given up (its tab opened afresh), a sweep
// loop gone quiet started again by the alarm.
export const ACO_EXTENSION_VERSION = '1.19.0';
// The oldest that puts more than one in the bag (an older copy adds one, whatever the item says).
export const QTY_EXTENSION_VERSION = '1.29.0';
// The oldest that keeps a copy of your card for updates (locked with a key your dashboard keeps in this
// browser): a new copy of the extension, connected from the dashboard, has your card back — no passphrase.
export const RESTORE_EXTENSION_VERSION = '1.20.0';
// The oldest that listens all the time as your checkout browser, so Discord's ⚡ Buy (pressed on
// your phone) starts at once. Older ones pick it up at their next check (within a minute or so).
export const REMOTE_EXTENSION_VERSION = '1.15.0';
// The oldest that knows checkpoints and virtual queues (monitor/gates.js): waits in line without
// refreshing, carries on once through, and says when it's through (older ones get no checks or
// searches at a store while its queue is up).
export const GATE_EXTENSION_VERSION = '1.16.0';
// The oldest that stops a checkout your account has ended (finished on your phone instead) when it
// gets through a checkpoint, rather than carrying on: before it, "📱 Finish on this phone" isn't
// offered once the checkout browser waits at the checkpoint.
export const PHONE_EXTENSION_VERSION = '1.21.0';
// The monitor's page reader, used by the extension's in-browser checks too.
const SHARED = ['html.js', 'extract.js', 'status.js', 'listing.js', 'gate.js', 'words.js'].map((f) => ({ name: `lib/${f}`, from: path.join(ROOT, 'server', 'monitor', f) }));

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
    { matches: [...stores, ...dev], js: ['flows.js', 'core.js', 'fill.js', 'checks.js', 'logins.js', 'bag.js', 'content.js'], run_at: 'document_idle' },
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
