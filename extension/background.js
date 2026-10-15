// Mugibot — background worker.
//
// Talks to your Mugibot account (the server in config.js) with this
// browser's device token: your watchlist and every store's checkout flow,
// ⚡ Buy codes, your delivery details for checkout, and what happened on the
// store page. Your card comes from the vault in this browser (vault.js): saved
// once, ready for every checkout, and never sent to the server. Details are
// handed to a store page only while a checkout you started is running in that
// tab, on that store.
//
// In-browser checks: about once a minute, this browser re-checks a few of
// YOUR OWN SKUs at stores that refuse checks from Mugibot's server — the same
// as you refreshing the product page. If a store shows a bot check, it backs
// off; it never tries to get past one. Switch it off on the dashboard
// (Extension tab).

import './config.js';
import './vault.js';
import { extractProduct, extractProductLinks } from './lib/extract.js';

const CONFIG = globalThis.MGB_CONFIG;
const Vault = globalThis.MGBVault;
const SERVER = CONFIG.server.replace(/\/+$/, '');
const SERVER_ORIGIN = new URL(SERVER).origin;
// Every address of your Mugibot site (the dashboard can be opened on any of them).
const APP_ORIGINS = new Set([SERVER_ORIGIN, ...(CONFIG.appOrigins || [])]);
const VERSION = chrome.runtime.getManifest().version;
// Installed from the Chrome Web Store (Chrome adds update_url): that copy updates itself.
// A copy downloaded from the dashboard doesn't, and steps aside once the store copy is installed.
const FROM_STORE = !!chrome.runtime.getManifest().update_url;
const SOURCE = FROM_STORE ? 'store' : 'download';
const PASS_TTL = 15 * 60 * 1000;
const CHECK_ALARM = 'mgb-checks';

async function getAuth() {
  const { auth } = await chrome.storage.local.get('auth');
  return auth && auth.token && auth.server === SERVER ? auth : null;
}

async function api(method, path, body, { token } = {}) {
  const auth = token ? { token } : await getAuth();
  if (!auth) return { status: 401, body: { error: 'Not connected' } };
  let res;
  try {
    res = await fetch(SERVER + path, {
      method,
      headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return { status: 0, body: { error: `Can't reach ${CONFIG.appName}` } };
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !token) await forget(); // device was disconnected from the dashboard
  return { status: res.status, body: data };
}

async function forget() {
  // The card stays saved (encrypted, under its account) for when that account connects again.
  await chrome.storage.local.remove('auth');
  const all = await chrome.storage.session.get(null);
  await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith('fill:') || k.startsWith('cardframe:')));
}

function browserName() {
  const ua = navigator.userAgent;
  const name = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Brave/.test(ua) ? 'Brave' : 'Chrome';
  const os = /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${name}${os ? ` on ${os}` : ''}`;
}

async function pair(code) {
  let res;
  try {
    res = await fetch(`${SERVER}/api/ext/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: browserName(), version: VERSION, source: SOURCE }),
    });
  } catch {
    return { ok: false, error: `Can't reach ${CONFIG.appName} — check your internet connection` };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || `Couldn't connect (HTTP ${res.status})` };
  await chrome.storage.local.set({ auth: { token: data.token, user: data.user, device: data.device, server: SERVER, pairedAt: Date.now() } });
  ensureAlarm();
  return { ok: true, user: data.user };
}

/** Your watchlist and the stores' flows (cached for when the server can't be reached). */
async function getState() {
  const auth = await getAuth();
  if (!auth) return { items: [], flows: [], online: false, paired: false };
  const cacheKey = `state:${auth.user.id}`;
  const res = await api('GET', `/api/ext/items?src=${SOURCE}`);
  if (res.status === 200 && res.body) {
    const st = { items: res.body.items, flows: res.body.flows, active: res.body.active, browserChecks: res.body.browserChecks };
    await chrome.storage.local.set({ [cacheKey]: { ...st, at: Date.now() } });
    return { ...st, online: true, paired: true, user: auth.user };
  }
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  const still = await getAuth();
  return { items: (still && cached && cached.items) || [], flows: (cached && cached.flows) || [], online: false, paired: !!still, user: still ? still.user : null };
}

// --- checkout passes: which tab may receive your details, for how long -----
const passKey = (tabId) => `fill:${tabId}`;

async function savePass(tabId, host, userId, profileId = null) {
  if (tabId == null || !host) return;
  await clearCardFrames(tabId); // a new checkout
  await chrome.storage.session.set({ [passKey(tabId)]: { host, userId, profileId, expires: Date.now() + PASS_TTL } });
}

/** The host of the page in the tab (the top page, even for a message from a payment frame). */
function tabHost(sender) {
  try { return new URL(sender.tab.url || (sender.frameId === 0 ? sender.url : '')).host; } catch { return ''; }
}

async function fillData(sender, part, profileId) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return null;
  const auth = await getAuth();
  if (!auth) return null;
  const pass = (await chrome.storage.session.get(passKey(tabId)))[passKey(tabId)];
  if (!pass || Date.now() > pass.expires || pass.userId !== auth.user.id) return null;
  // Only for the store the checkout was started on.
  if (tabHost(sender) !== pass.host) return null;
  const vault = await Vault.status(auth.user.id);
  const card = vault.ready ? await Vault.card(auth.user.id) : null;
  // Why there's no card, for the panel: none saved, saved by an older version (passphrase), or unreadable.
  const cardIssue = card ? null : !vault.saved ? 'none' : vault.needsPassphrase ? 'passphrase' : 'unreadable';
  if (part === 'card') return { card, cardIssue };
  const chosen = profileId || pass.profileId || '';
  const res = await api('GET', `/api/ext/profile${chosen ? `?profile=${encodeURIComponent(chosen)}` : ''}`);
  if (res.status !== 200 || !res.body) return null;
  return { profile: res.body.profile, card, cardIssue };
}

// What each payment frame in a tab found and filled (so the page can say when the card didn't go in).
const frameKey = (tabId, frameId) => `cardframe:${tabId}:${frameId}`;

async function cardFrames(tabId) {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith(`cardframe:${tabId}:`)).map(([, v]) => v);
}

async function clearCardFrames(tabId) {
  const all = await chrome.storage.session.get(null);
  await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith(`cardframe:${tabId}:`)));
}

// --- updates -----------------------------------------------------------------
/** "1.0.10" > "1.0.9" */
function newer(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/**
 * Is there a newer extension? Asks your Mugibot site (at most every 10 minutes).
 * Also notices when the site has moved to a new address: this copy was built for
 * the old one, so it needs downloading again from the new one.
 */
async function updateInfo(force = false) {
  let { appInfo } = await chrome.storage.local.get('appInfo');
  if (force || !appInfo || appInfo.server !== SERVER || Date.now() - appInfo.at > 10 * 60 * 1000) {
    try {
      const res = await fetch(`${SERVER}/api/ext/app`, { cache: 'no-store' });
      if (res.ok) {
        const b = await res.json();
        appInfo = { server: SERVER, url: String(b.url || SERVER).replace(/\/+$/, ''), version: String(b.extensionVersion || ''), store: b.chromeStoreUrl || null, at: Date.now() };
        await chrome.storage.local.set({ appInfo });
      }
    } catch { /* offline: use what we knew */ }
  }
  const { retired } = await chrome.storage.local.get('retired');
  const info = { current: VERSION, latest: VERSION, url: SERVER, moved: false, available: false, store: null, fromStore: FROM_STORE, retired: !FROM_STORE && !!retired };
  if (appInfo && appInfo.server === SERVER) {
    let moved = false;
    try { moved = new URL(appInfo.url).origin !== SERVER_ORIGIN; } catch { /* keep false */ }
    Object.assign(info, { latest: appInfo.version || VERSION, url: appInfo.url, moved, store: appInfo.store });
    // The store copy updates itself; a downloaded copy is asked to move to the store copy once there is one.
    info.available = moved || (!FROM_STORE && (newer(info.latest, VERSION) || !!info.store));
  }
  const badge = info.retired ? 'OLD' : info.available ? 'NEW' : '';
  chrome.action.setBadgeText({ text: badge });
  if (badge) chrome.action.setBadgeBackgroundColor({ color: info.retired ? '#6b7280' : '#d97706' });
  chrome.action.setTitle({ title: info.retired ? `${CONFIG.appName} — old copy, remove it` : info.available ? `${CONFIG.appName} — update available` : CONFIG.appName });
  return info;
}

/**
 * A downloaded copy, when the Chrome Web Store copy is installed in this browser too
 * (its pages say so): stays out of the way — no checkout, no checks — until it's removed.
 */
async function setRetired(on) {
  if (FROM_STORE) return;
  const { retired } = await chrome.storage.local.get('retired');
  if (!!retired === on) return;
  await chrome.storage.local.set({ retired: on });
  if (on) await chrome.alarms.clear(CHECK_ALARM);
  else ensureAlarm();
  updateInfo().catch(() => null);
}

async function status() {
  const update = await updateInfo().catch(() => null);
  const auth = await getAuth();
  if (!auth) return { paired: false, server: SERVER, appName: CONFIG.appName, version: VERSION, update };
  const me = await api('GET', `/api/ext/me?v=${encodeURIComponent(VERSION)}&src=${SOURCE}`);
  const still = await getAuth();
  if (!still) return { paired: false, server: SERVER, appName: CONFIG.appName, version: VERSION, disconnected: true, update };
  const { lastChecks } = await chrome.storage.local.get('lastChecks');
  return {
    paired: true, server: SERVER, appName: CONFIG.appName, version: VERSION, user: still.user, update,
    online: me.status === 200, entitlement: me.body && me.body.entitlement, card: await Vault.status(still.user.id), lastChecks: lastChecks || null,
  };
}

// --- in-browser checks of your own SKUs --------------------------------------
const revive = (v) => (v && typeof v.re === 'string' ? new RegExp(v.re, v.f || '') : null);

function hasSku(url, sku) {
  let p;
  try { p = decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch { return false; }
  const s = String(sku || '').toLowerCase();
  if (!s) return false;
  const edge = /^\d+$/.test(s) ? /\d/ : /[a-z0-9]/;
  for (let i = p.indexOf(s); i >= 0; i = p.indexOf(s, i + 1)) {
    if (!edge.test(p[i - 1] || '') && !edge.test(p[i + s.length] || '')) return true;
  }
  return false;
}

async function checkOne(c) {
  let res;
  try {
    res = await fetch(c.url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
  } catch {
    return { id: c.id, status: 'error', error: "Your browser couldn't reach the store" };
  }
  if (res.status === 404 || res.status === 410) return { id: c.id, status: c.kind === 'search' ? 'not_listed' : 'not_found' };
  if (res.status === 403 || res.status === 429 || res.status === 503) return { id: c.id, status: 'blocked', error: `The store refused your browser's check (HTTP ${res.status}) — backing off` };
  if (!res.ok) return { id: c.id, status: 'error', error: `HTTP ${res.status}` };
  const html = (await res.text()).slice(0, 3_000_000);
  const finalUrl = res.url || c.url;
  if (c.kind === 'search') {
    const productPath = revive(c.productPath);
    if (productPath && productPath.test(new URL(finalUrl).pathname) && hasSku(finalUrl, c.sku)) return { id: c.id, status: 'not_listed', foundUrl: finalUrl };
    const hit = extractProductLinks(html, finalUrl, productPath || /\/(product|products|p)\//i).find((l) => hasSku(l.url, c.sku));
    if (hit) return { id: c.id, status: 'not_listed', foundUrl: hit.url };
    const ex = extractProduct(html, { url: finalUrl });
    return ex.blocked ? { id: c.id, status: 'blocked', error: 'The store showed a bot check — backing off' } : { id: c.id, status: 'not_listed' };
  }
  const ex = extractProduct(html, { url: finalUrl, sku: c.sku });
  if (ex.blocked) return { id: c.id, status: 'blocked', error: 'The store showed a bot check — backing off' };
  return { id: c.id, status: ex.status, price: ex.price, title: ex.title, image: ex.image && /^https:\/\//.test(ex.image) ? ex.image : null };
}

let checking = false;
async function runChecks() {
  if (checking) return { busy: true };
  if (!FROM_STORE && (await chrome.storage.local.get('retired')).retired) return { retired: true };
  const auth = await getAuth();
  if (!auth) return { paired: false };
  checking = true;
  try {
    const due = await api('GET', '/api/ext/checks');
    if (due.status !== 200 || !due.body) return { status: due.status };
    const results = [];
    const lastByHost = new Map();
    for (const c of due.body.checks || []) {
      const host = new URL(c.url).host;
      const gap = Date.now() - (lastByHost.get(host) || 0);
      if (gap < 4000) await new Promise((r) => setTimeout(r, 4000 - gap)); // gentle on each store
      lastByHost.set(host, Date.now());
      results.push(await checkOne(c));
    }
    if (results.length) await api('POST', '/api/ext/checks', { results });
    const summary = { at: Date.now(), checked: results.length, blocked: results.filter((r) => r.status === 'blocked').length };
    await chrome.storage.local.set({ lastChecks: summary });
    return summary;
  } finally {
    checking = false;
  }
}

function ensureAlarm() {
  chrome.storage.local.get('retired').then(({ retired }) => {
    if (retired && !FROM_STORE) return;
    chrome.alarms.get(CHECK_ALARM, (a) => { if (!a) chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.1 }); });
  });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== CHECK_ALARM) return;
  runChecks().catch(() => null);
  updateInfo().catch(() => null); // keeps the "NEW" badge on the toolbar icon up to date
});

// --- messages ---------------------------------------------------------------
const fromApp = (sender) => {
  try { return !!sender.tab && sender.frameId === 0 && APP_ORIGINS.has(new URL(sender.url).origin); } catch { return false; }
};
// The popup and Settings page (Settings opens in a tab, so check the page's address, not the tab).
const fromExtensionPage = (sender) => sender.id === chrome.runtime.id && String(sender.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== 'object' || sender.id !== chrome.runtime.id) return null;
    switch (msg.type) {
      // From store pages
      case 'state': return getState();
      case 'event': {
        await api('POST', '/api/ext/events', msg.event);
        return { ok: true };
      }
      case 'claim': {
        // A ⚡ Buy code: confirm it once, then allow checkout autofill in this tab.
        const auth = await getAuth();
        if (!auth || !sender.tab) return null;
        const res = await api('POST', '/api/ext/claim', { code: msg.code });
        if (res.status === 200 && res.body && res.body.ok) {
          await savePass(sender.tab.id, res.body.host === tabHost(sender) ? res.body.host : tabHost(sender), auth.user.id, res.body.profileId);
          return res.body;
        }
        return { ok: false, status: res.status, error: res.body && res.body.error };
      }
      case 'startFill': {
        // You pressed the panel's button (a real click): allow autofill for this tab's store.
        const auth = await getAuth();
        if (!auth || !sender.tab) return null;
        await savePass(sender.tab.id, tabHost(sender), auth.user.id);
        return { ok: true };
      }
      case 'fillData': return fillData(sender, msg.part, typeof msg.profileId === 'string' ? msg.profileId : null);
      case 'cardFrame': {
        // A payment frame: how many card boxes it found, and how many it filled.
        if (!sender.tab || !sender.frameId) return null;
        let host = '';
        try { host = new URL(sender.url).host; } catch { /* keep empty */ }
        await chrome.storage.session.set({ [frameKey(sender.tab.id, sender.frameId)]: { host, seen: Number(msg.seen) || 0, filled: Number(msg.filled) || 0, detail: String(msg.detail || '').slice(0, 300), at: Date.now() } });
        return { ok: true };
      }
      case 'cardFrames':
        return sender.tab && sender.frameId === 0 ? cardFrames(sender.tab.id) : null;
      case 'storeCopy':
        // From this copy's own scripts on a store page or the dashboard: is the Chrome Web Store copy there too?
        await setRetired(!!msg.present);
        return { ok: true };
      case 'endFill':
        if (sender.tab) {
          await chrome.storage.session.remove(passKey(sender.tab.id));
          await clearCardFrames(sender.tab.id);
        }
        return { ok: true };

      // From your Mugibot dashboard (bridge.js) or the extension's own pages
      case 'appHello': {
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        const auth = await getAuth();
        return { version: VERSION, server: SERVER, fromStore: FROM_STORE, paired: !!auth, userId: auth ? auth.user.id : null, username: auth ? auth.user.username : null };
      }
      case 'pair':
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        return pair(String(msg.code || ''));
      case 'cardStatus': {
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        const auth = await getAuth();
        return auth ? { userId: auth.user.id, card: await Vault.status(auth.user.id) } : null;
      }
      case 'openCardSettings':
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      case 'checkNow':
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        return runChecks();

      // From the popup / settings page only
      case 'status':
        return fromExtensionPage(sender) ? status() : null;
      case 'update':
        return fromExtensionPage(sender) ? updateInfo(true) : null;
      case 'removeSelf':
        // A downloaded copy, after moving to the Chrome Web Store copy (Chrome asks to confirm).
        if (!fromExtensionPage(sender) || FROM_STORE) return null;
        chrome.management.uninstallSelf({ showConfirmDialog: true }, () => void chrome.runtime.lastError);
        return { ok: true };
      case 'reload':
        // Loads the extension's files again — after you've copied a new version over them.
        if (!fromExtensionPage(sender)) return null;
        setTimeout(() => chrome.runtime.reload(), 100);
        return { ok: true };
      case 'unpair': {
        if (!fromExtensionPage(sender)) return null;
        await api('POST', '/api/ext/unpair', {});
        await forget();
        return { ok: true };
      }
      case 'vault': {
        if (!fromExtensionPage(sender)) return null;
        const auth = await getAuth();
        if (!auth) return { error: 'Connect the extension to your account first' };
        try {
          if (msg.action === 'save') return { status: await Vault.save(auth.user.id, msg.card) };
          if (msg.action === 'upgrade') return { status: await Vault.upgrade(auth.user.id, msg.passphrase) };
          if (msg.action === 'remove') { await Vault.remove(auth.user.id); return { status: await Vault.status(auth.user.id) }; }
          return { status: await Vault.status(auth.user.id) };
        } catch (e) {
          return { error: e.message };
        }
      }
      default:
        return null;
    }
  })().then(sendResponse, () => sendResponse(null));
  return true; // reply asynchronously
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(passKey(tabId));
  clearCardFrames(tabId).catch(() => null);
});

// For tests and the "Check now" button.
globalThis.mugibotRunChecks = runChecks;
