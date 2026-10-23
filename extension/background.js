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
//
// Live sweeps (admins only): for stores that refuse servers, an admin's
// browser reads their search results at the pace the server sets, and sends
// back what it found (docs/MONITORING.md). Members' browsers never do this.
//
// Auto-checkout (only once you've switched it on and armed an item, docs/AUTO-CHECKOUT.md): this
// browser listens for your armed items dropping, and checks out by itself in a tab of its own —
// within your limits, with your details and the card saved here. It never gets past a bot check
// or your bank's check: it stops and tells you. Several runs go at once: at different stores side
// by side, each in a tab of its own; at the same store one after another (it keeps one bag for this
// browser), each the moment the one before it is done.
//
// Checkpoints and virtual queues (JB Hi-Fi's hCaptcha checkpoint, EB Games' and Pokémon Center's
// queues): a tab in a store's queue is never refreshed or sent anywhere by Mugibot, and while this
// browser is in line there (or hasn't got through), nothing else of Mugibot's asks that store for
// anything — no checks, no searches, no sign-in checks — so nobody's place is put at risk. A run
// for that store waits for the tab in line to get through, then opens the store from there.
// Whether a queue is up at all is looked at as a new visitor (no cookies: nobody's place touched).

import './config.js';
import './vault.js';
import './logins.js';
import { extractProduct, extractProductLinks } from './lib/extract.js';
import { classify, gateOnPage } from './lib/gate.js';
import { parseListing, siteAnswer } from './lib/listing.js';

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
// The longest an Auto-checkout run presses its final button again while the store's struggling (checks.js RETRY_MS).
const RETRY_MS = 30 * 60 * 1000;
const CHECK_ALARM = 'mgb-checks';

async function getAuth() {
  const { auth } = await chrome.storage.local.get('auth');
  return auth && auth.token && auth.server === SERVER ? auth : null;
}

// How long a call to Mugibot's server may take before it's given up on (an answer that waits for a run
// to drop asks for its own, longer): a checkout never waits on a server that's stopped answering.
const API_TIMEOUT_MS = 15000;

async function api(method, path, body, { token, timeoutMs = API_TIMEOUT_MS } = {}) {
  const auth = token ? { token } : await getAuth();
  if (!auth) return { status: 401, body: { error: 'Not connected' } };
  let res;
  try {
    res = await fetch(SERVER + path, {
      method,
      headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 0, body: { error: `Can't reach ${CONFIG.appName}` } };
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !token) await forget(); // device was disconnected from the dashboard
  return { status: res.status, body: data };
}

// --- the card's locked backup in your account (vault.js) ------------------------
async function backupCard(auth, passphrase) {
  const locked = await Vault.lock(auth.user.id, passphrase);
  const r = await api('PUT', '/api/ext/card-backup', locked);
  if (r.status !== 200) throw new Error((r.body && r.body.error) || `Can't reach ${CONFIG.appName} to back up your card`);
  return r.body.backup;
}

/** What's backed up in your account (brand, last 4, expiry), null for nothing, or undefined when the server can't be reached. */
async function cardBackupInfo() {
  const r = await api('GET', '/api/ext/card-backup');
  if (r.status !== 200) return undefined;
  const b = r.body && r.body.backup;
  return b ? { brand: b.brand, last4: b.last4, expMonth: b.expMonth, expYear: b.expYear, hasCvc: !!b.hasCvc, savedAt: b.savedAt } : null;
}

// --- the card's copy for reinstalls (vault.js, from 1.20) ------------------------------
// Locked here with a key your Mugibot dashboard keeps in this browser: Mugibot's server keeps the locked
// copy and never has the key. A new install of the extension (even from another folder) gets the key from
// the dashboard as it's connected, and has your card back — no passphrase. Keys are kept per account:
// a few, as each address of the site keeps its own.
const restoreKeysKey = (userId) => `restoreKeys:${userId}`;
const restoreMadeKey = (userId) => `restoreMade:${userId}`; // key id → the card (its savedAt) its copy is of

async function restoreKeys(userId) {
  return (await chrome.storage.local.get(restoreKeysKey(userId)))[restoreKeysKey(userId)] || [];
}

async function markRestoreMade(userId, keyId, savedAt) {
  const made = (await chrome.storage.local.get(restoreMadeKey(userId)))[restoreMadeKey(userId)] || {};
  if (savedAt) made[keyId] = savedAt;
  else delete made[keyId];
  await chrome.storage.local.set({ [restoreMadeKey(userId)]: made });
}

/** This card's copy under one of the dashboard's keys, sent to your account. false: no card ready here, or turned off. */
async function putRestoreCopy(auth, key, host = '') {
  const userId = auth.user.id;
  const st = await Vault.status(userId);
  if (!st.ready) return false;
  const copy = await Vault.lockForRestore(userId, key);
  if (!copy) return false;
  const r = await api('PUT', `/api/ext/card-restore/${encodeURIComponent(key.id)}`, { ...copy, host: String(host || '').slice(0, 100) });
  if (r.status !== 200) return false; // (409: the member turned it off — nothing kept)
  await markRestoreMade(userId, key.id, st.savedAt);
  return true;
}

/**
 * The dashboard's restore key for this browser (bridge.js): kept, and used. A card here: its copy under
 * the key is made (again, when the card's newer, or the account hasn't got it: has === false). No card
 * here — a new install, or it was never saved in this browser — and a copy under the key: your card back.
 * { ok, restored, card } — or { ok: false, error }.
 */
async function useCardKey(auth, key, { has, host } = {}) {
  const userId = auth.user.id;
  if (!key || !/^[A-Za-z0-9_-]{16,40}$/.test(String(key.id || '')) || typeof key.k !== 'string') return { ok: false, error: 'That isn\'t a restore key' };
  const keys = (await restoreKeys(userId)).filter((k) => k.id !== key.id);
  await chrome.storage.local.set({ [restoreKeysKey(userId)]: [{ id: key.id, k: key.k, host: String(host || '').slice(0, 100) }, ...keys].slice(0, 4) });
  const st = await Vault.status(userId);
  if (st.ready) {
    const made = (await chrome.storage.local.get(restoreMadeKey(userId)))[restoreMadeKey(userId)] || {};
    if (has === false || made[key.id] !== st.savedAt) await putRestoreCopy(auth, key, host).catch(() => false);
    return { ok: true, restored: false, card: st };
  }
  // (Asked for only when the account has one for this key: the dashboard says.)
  if (has === false) return { ok: true, restored: false, card: st };
  const r = await api('GET', `/api/ext/card-restore/${encodeURIComponent(key.id)}`);
  if (r.status === 404 || r.status === 429) return { ok: true, restored: false, card: st };
  if (r.status !== 200 || !r.body || !r.body.copy) return { ok: false, error: (r.body && r.body.error) || `Can't reach ${CONFIG.appName}`, card: st };
  try {
    const card = await Vault.unlockRestore(userId, r.body.copy, key);
    // (The copy is of the card now here: it needn't be made again.)
    await markRestoreMade(userId, key.id, card.savedAt);
    cardState = null;
    return { ok: true, restored: true, card };
  } catch (e) {
    return { ok: false, error: e.message, card: st };
  }
}

/** A card saved (or replaced) here: its copy under each of the dashboard's keys this browser has. */
async function refreshRestoreCopies(auth) {
  for (const key of await restoreKeys(auth.user.id)) await putRestoreCopy(auth, key, key.host).catch(() => false);
}

// What this browser's card is, for the dashboard's Armed checks (its checkout browser's card, seen from
// anywhere): 'ready', 'saved' (there, but not ready) or 'none' — never the card. Kept a minute.
let cardState = null;
async function cardStateNow() {
  const auth = await getAuth();
  if (!auth) return '';
  if (cardState && cardState.userId === auth.user.id && Date.now() - cardState.at < 60 * 1000) return cardState.v;
  const st = await Vault.status(auth.user.id).catch(() => null);
  const v = !st ? '' : st.ready ? 'ready' : st.saved ? 'saved' : 'none';
  cardState = { userId: auth.user.id, v, at: Date.now() };
  return v;
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
  sweepLoop().catch(() => null);
  return { ok: true, user: data.user };
}

// A copy of your watchlist from the last couple of minutes is used straight away (and
// refreshed behind it), so store pages — ⚡ Buy above all — never wait on the server for it.
const STATE_FRESH_MS = 2 * 60 * 1000;
let refreshing = null;

/** Your watchlist and the stores' flows, from the server (saved for when it can't be reached). */
function refreshState(auth) {
  if (!refreshing) {
    refreshing = (async () => {
      const res = await api('GET', `/api/ext/items?src=${SOURCE}&card=${await cardStateNow()}`);
      if (res.status !== 200 || !res.body) return null;
      const st = { items: res.body.items, flows: res.body.flows, active: res.body.active, browserChecks: res.body.browserChecks, aco: res.body.aco || null };
      await chrome.storage.local.set({ [`state:${auth.user.id}`]: { ...st, at: Date.now() } });
      if (Array.isArray(res.body.gates)) await noteGatesUp(res.body.gates);
      return st;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function getState() {
  const auth = await getAuth();
  if (!auth) return { items: [], flows: [], online: false, paired: false };
  const cacheKey = `state:${auth.user.id}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  const pick = (st) => ({ items: st.items, flows: st.flows, active: st.active, browserChecks: st.browserChecks, aco: st.aco || null });
  if (cached && Date.now() - cached.at < STATE_FRESH_MS) {
    refreshState(auth).catch(() => null);
    return { ...pick(cached), online: true, paired: true, user: auth.user };
  }
  const st = await refreshState(auth);
  if (st) return { ...st, online: true, paired: true, user: auth.user };
  const still = await getAuth();
  return { items: (still && cached && cached.items) || [], flows: (cached && cached.flows) || [], online: false, paired: !!still, user: still ? still.user : null };
}

// Delivery details asked for as a ⚡ Buy starts, ready for checkout a few seconds later.
const PROFILE_FRESH_MS = 2 * 60 * 1000;
const profiles = new Map();

async function profileFor(chosen) {
  const hit = profiles.get(chosen);
  if (hit && Date.now() - hit.at < PROFILE_FRESH_MS) return hit.profile;
  const res = await api('GET', `/api/ext/profile${chosen ? `?profile=${encodeURIComponent(chosen)}` : ''}`);
  if (res.status !== 200 || !res.body) return null;
  profiles.set(chosen, { profile: res.body.profile, at: Date.now() });
  return res.body.profile;
}

// --- checkout passes: which tab may receive your details, for how long -----
const passKey = (tabId) => `fill:${tabId}`;

/** aco: an Auto-checkout run this checkout is for (what it may do by itself), from the server. */
async function savePass(tabId, host, userId, profileId = null, aco = null) {
  if (tabId == null || !host) return;
  await clearCardFrames(tabId); // a new checkout
  await chrome.storage.session.set({ [passKey(tabId)]: { host, userId, profileId, aco, expires: Date.now() + PASS_TTL } });
}

async function passFor(sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return null;
  const auth = await getAuth();
  const pass = (await chrome.storage.session.get(passKey(tabId)))[passKey(tabId)];
  if (!auth || !pass || Date.now() > pass.expires || pass.userId !== auth.user.id || tabHost(sender) !== pass.host) return null;
  return pass;
}

/** The host of the page in the tab (the top page, even for a message from a payment frame). */
function tabHost(sender) {
  try { return new URL(sender.tab.url || (sender.frameId === 0 ? sender.url : '')).host; } catch { return ''; }
}

/** A pattern from a flow (it travels as { re, f }). */
function rx(v) {
  if (v instanceof RegExp) return v;
  if (v && typeof v.re === 'string') { try { return new RegExp(v.re, v.f || ''); } catch { return null; } }
  return null;
}

/** The store whose flow applies to the page in this tab (by address, and path for the dummy store). */
async function storeForTab(sender) {
  return storeOfUrl((await getState()).flows, sender.tab && sender.tab.url);
}

/** The store whose flow applies to a page's address, from these flows (or null). */
function storeOfUrl(flows, url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  let p = u.pathname;
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  const host = u.host.toLowerCase();
  return (flows || []).find((r) => (r.hosts || []).some((h) => host === h || host.endsWith(`.${h.replace(/^www\./, '')}`))
    && (!r.pathPrefix || p === r.pathPrefix || p.startsWith(`${r.pathPrefix}/`))) || null;
}

/**
 * A frame running the store's whole checkout (its flow's checkout.frames: Global-e's for Premium
 * Bandai, Amazon's quick checkout), in a tab with a checkout you started on that store: its store
 * and pass — or null. Only such a frame may be handed your details and report an Auto-checkout run.
 */
async function checkoutFrame(sender) {
  if (!sender.tab || !sender.frameId) return null;
  const pass = await passFor(sender);
  if (!pass) return null;
  const r = await storeForTab(sender);
  const frames = (r && r.flow && r.flow.checkout && r.flow.checkout.frames || []).map(rx).filter(Boolean);
  return frames.some((re) => re.test(String(sender.url || ''))) ? { store: r, pass } : null;
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
  // (A payment frame showing a card the provider has for you — Stripe's Link: the store's words for its Confirm, no card.)
  if (part === 'confirm') {
    const r = await storeForTab(sender);
    return { confirm: (r && r.flow && r.flow.checkout && r.flow.checkout.frameConfirm) || [] };
  }
  const vault = await Vault.status(auth.user.id);
  const card = vault.ready ? await Vault.card(auth.user.id) : null;
  // Why there's no card, for the panel: none saved, saved by an older version (passphrase), or unreadable.
  const cardIssue = card ? null : !vault.saved ? 'none' : vault.needsPassphrase ? 'passphrase' : 'unreadable';
  if (part === 'card') return { card, cardIssue };
  const profile = await profileFor(profileId || pass.profileId || '');
  if (!profile) return null;
  return { profile, card, cardIssue, aco: pass.aco && !pass.aco.done ? pass.aco : null };
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

// --- checkpoints and virtual queues (server/monitor/gates.js) -------------------
// Per store, this browser's own: the tabs in its queue now (their content script says, each time
// the queue page refreshes itself), when one last was, when one got through, and runs held until it
// does. Kept for the browser session.
const GATES = 'gates';
const GATES_UP = 'gatesUp';
// Through a queue: good for this long (or until the store shows its queue again).
const THROUGH_MS = 30 * 60 * 1000;
// A queue seen in this browser lately counts as up, whatever the server knows yet.
const SEEN_UP_MS = 10 * 60 * 1000;
let gateLock = Promise.resolve();
const lastGateReport = new Map();

/** One change at a time (messages from several tabs at once). */
function withGates(fn) {
  const run = gateLock.then(async () => {
    const g = (await chrome.storage.session.get(GATES))[GATES] || {};
    const out = await fn(g);
    await chrome.storage.session.set({ [GATES]: g });
    return out;
  });
  gateLock = run.catch(() => null);
  return run;
}

async function gatesNow() {
  return (await chrome.storage.session.get(GATES))[GATES] || {};
}

/** What the server says is up now: [{ store, kind, since, wait }]. */
async function noteGatesUp(list) {
  await chrome.storage.session.set({ [GATES_UP]: { at: Date.now(), list: list.filter((x) => x && typeof x.store === 'string').slice(0, 30) } });
}

const inLine = (s) => !!s && Object.keys(s.line || {}).length > 0;
// Through: since it was last seen in line here — and since the queue went up this time (since: when, from your account).
const isThrough = (s, since = 0) => !!s && !!s.throughAt && Date.now() - s.throughAt < THROUGH_MS && !inLine(s) && s.throughAt >= (s.upAt || 0) && s.throughAt >= (since || 0);

async function serverGates() {
  return (await chrome.storage.session.get(GATES_UP))[GATES_UP] || { at: 0, list: [] };
}
const sinceOf = (server, id) => ((server.list.find((x) => x.store === id) || {}).since || 0);

/** Stores whose queue this browser has got through (it may ask them for things again). */
async function throughStores() {
  const g = await gatesNow();
  const server = await serverGates();
  return Object.keys(g).filter((id) => g[id].kind === 'queue' && isThrough(g[id], sinceOf(server, id)));
}

/** Stores whose queue is up and this browser isn't through: it asks them for nothing. */
async function heldStores() {
  const g = await gatesNow();
  const server = await serverGates();
  const up = new Set(server.list.filter((x) => x.kind === 'queue').map((x) => x.store));
  const out = new Set();
  for (const id of up) if (!isThrough(g[id], sinceOf(server, id))) out.add(id);
  for (const [id, s] of Object.entries(g)) {
    // Seen here lately — unless your account has said since that it's down (a tab in line still counts).
    const seen = s.upAt && Date.now() - s.upAt < SEEN_UP_MS && !(server.at > s.upAt && !up.has(id));
    if (s.kind === 'queue' && (inLine(s) || seen) && !isThrough(s, sinceOf(server, id))) out.add(id);
  }
  return out;
}

/** Tell your account what this browser saw (a queue's or a checkpoint's page): at most once a minute a store, unless the wait changed. */
async function reportGate(store, seen) {
  const last = lastGateReport.get(store);
  if (last && Date.now() - last.at < 60 * 1000 && last.wait === seen.wait && last.status === seen.status) return;
  lastGateReport.set(store, { at: Date.now(), wait: seen.wait, status: seen.status });
  await api('POST', '/api/ext/gates', { seen: [{ store, ...seen }] }).catch(() => null);
}

/**
 * A store page in a tab: is it the store's queue (or checkpoint)? A tab that was in line and isn't
 * any more got through: runs held for it go now.
 */
function noteGate(tabId, store, on, info) {
  return withGates(async (g) => {
    const s = g[store] || (g[store] = { line: {}, runs: [] });
    s.line = s.line || {};
    s.runs = s.runs || [];
    if (info.kind) s.kind = info.kind;
    const was = !!s.line[tabId];
    let release = false;
    if (on) {
      s.line[tabId] = Date.now();
      s.upAt = Date.now();
      if (info.wait !== null && info.wait !== undefined) s.wait = info.wait;
    } else if (was) {
      delete s.line[tabId];
      if (!inLine(s)) { s.throughAt = Date.now(); release = s.runs.length > 0; }
    }
    if (on) {
      reportGate(store, { status: 'up', how: 'page', wait: info.wait ?? null }).catch(() => null);
      // Runs waiting for this tab to get through: still waiting (said every few minutes).
      if (s.runs.length && (!s.runsBeat || Date.now() - s.runsBeat > 150 * 1000)) {
        s.runsBeat = Date.now();
        for (const run of s.runs) {
          api('POST', `/api/ext/aco/${encodeURIComponent(run.id)}`, { status: 'waiting', reason: 'queue', message: `In ${run.storeName}'s virtual queue in this browser${s.wait != null ? ` — about ${s.wait} min` : ''}` }).catch(() => null);
        }
      }
    }
    if (release) setTimeout(() => releaseRuns(store).catch(() => null), 0);
    return { ok: true, through: was && !on };
  });
}

/** Through the queue: the runs that waited for it open the store now, each with a fresh link. */
async function releaseRuns(store) {
  const runs = await withGates((g) => { const s = g[store]; const out = (s && s.runs) || []; if (s) s.runs = []; return out; });
  for (const run of runs) {
    const r = await api('POST', `/api/ext/aco/${encodeURIComponent(run.id)}/link`, {});
    if (r.status === 200 && r.body && r.body.url) await startRun({ ...run, url: r.body.url }).catch(() => null);
  }
}

/**
 * A queue to get in line at (your armed items' store, or Discord's "Join the queue on my computer"):
 * one tab of its own at the store, in the background, waiting its turn — unless this browser is in
 * line there already, or through.
 */
async function joinLobby(l) {
  if (!l || typeof l.store !== 'string' || typeof l.url !== 'string') return null;
  const g = await gatesNow();
  const s = g[l.store];
  // (Through it already — since this queue went up: nothing to join.)
  if (inLine(s) || isThrough(s, l.since || 0)) return null;
  if (s && s.lobbyTab !== undefined) {
    try { await chrome.tabs.get(s.lobbyTab); return null; } catch { /* closed: open another */ }
  }
  const tab = await openStoreTab(l.url, { active: false });
  if (tab) await withGates((all) => { const x = all[l.store] || (all[l.store] = { line: {}, runs: [], kind: 'queue' }); x.lobbyTab = tab.id; x.lobbyAt = Date.now(); });
  return tab;
}

/** Runs in a page: what it shows (for reading whether it's a store's queue — nothing on it is touched). */
function readGatePage() {
  return { url: location.href, text: String((document.body && document.body.innerText) || '').slice(0, 20000), html: document.documentElement.outerHTML.slice(0, 600000) };
}

/**
 * The admins' looks at a store's queue, as a new visitor (server/monitor/gates.js): its front page
 * asked for with no cookies at all — this browser's place in any line is never touched — and what
 * it was: the queue, or the store.
 */
async function probeGate(p) {
  let res;
  let html = '';
  try {
    res = await fetch(p.url, { credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(20000) });
    html = (await res.text()).slice(0, 3000000);
  } catch {
    return { store: p.store, status: 'unknown', how: 'probe' };
  }
  const gate = { kind: p.kind, page: p.page };
  const reading = classify(gate, { status: res.status, url: res.url || p.url, html });
  const seen = reading === 'up' ? gateOnPage(gate, { url: res.url || p.url, html }) : null;
  return { store: p.store, status: reading || 'unknown', how: 'probe', wait: seen ? seen.wait : null };
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
  const { lastChecks, lastSweeps, needSites } = await chrome.storage.local.get(['lastChecks', 'lastSweeps', 'needSites']);
  return {
    paired: true, server: SERVER, appName: CONFIG.appName, version: VERSION, user: still.user, update,
    online: me.status === 200, entitlement: me.body && me.body.entitlement, card: await Vault.status(still.user.id), cardBackup: me.status === 200 ? await cardBackupInfo() : undefined, lastChecks: lastChecks || null, needSites: needSites || [],
    lastSweeps: lastSweeps || null, sweeping,
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

/**
 * A store whose bot protection takes background requests for a bot (BIG W's Akamai: it then turns the whole
 * browser away — "Access Denied" on your own visits too): its product page opened in the extension's window
 * instead, the way you'd open it, and read once it's drawn. One at a time, gently (the server paces them).
 */
async function renderCheck(c, gate) {
  let tab;
  try {
    tab = await sweepTab(`check:${c.store}`, { privateWindow: !!c.privateWindow });
    await openIn(tab.id, c.url, gate || null);
  } catch (e) {
    if (e instanceof GateHeld) return { id: c.id, gate: e.gate };
    return { id: c.id, status: 'error', error: "Your browser couldn't open the store's page" };
  }
  let page = null;
  // (The buy box is drawn by the page's own code: a few seconds for it.)
  for (const until = Date.now() + 10000; Date.now() < until;) {
    page = (await inPage(tab.id, readSweepPage, [c.productPath ? [c.productPath.re, c.productPath.f || ''] : null]).catch(() => null)) || page;
    if (page && (page.denied || page.challenge)) break;
    if (page && /add to (cart|bag|basket|trolley)|pre-?order|sold out|out of stock|unavailable|notify me/i.test(page.html.slice(0, 2000000))) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  // (Done with it: the tab's left on a blank page, so the store's page isn't kept running.)
  chrome.tabs.update(tab.id, { url: 'about:blank' }).catch(() => null);
  if (!page) return { id: c.id, status: 'error', error: "Your browser couldn't read the store's page" };
  if (page.denied) {
    await markDenied(c.store);
    return { id: c.id, status: 'blocked', error: 'The store said "Access Denied" to your browser (its bot protection) — Mugibot asks it for nothing more from here for 30 minutes' };
  }
  if (page.challenge) return { id: c.id, status: 'blocked', error: 'The store showed a bot check — backing off' };
  const html = page.html.slice(0, 3_000_000);
  const finalUrl = page.url || c.url;
  if (c.kind === 'search') {
    // (A SKU whose page isn't known yet: its link, in the search page the store drew.)
    const productPath = revive(c.productPath);
    if (productPath && productPath.test(new URL(finalUrl).pathname) && hasSku(finalUrl, c.sku)) return { id: c.id, status: 'not_listed', foundUrl: finalUrl };
    const hit = extractProductLinks(html, finalUrl, productPath || /\/(product|products|p)\//i).find((l) => hasSku(l.url, c.sku));
    return hit ? { id: c.id, status: 'not_listed', foundUrl: hit.url } : { id: c.id, status: 'not_listed' };
  }
  const ex = extractProduct(html, { url: finalUrl, sku: c.sku });
  if (ex.blocked) return { id: c.id, status: 'blocked', error: 'The store showed a bot check — backing off' };
  return { id: c.id, status: ex.status, price: ex.price, title: ex.title, image: ex.image && /^https:\/\//.test(ex.image) ? ex.image : null };
}

async function checkOne(c, gate) {
  if (c.render) return renderCheck(c, gate);
  let res;
  try {
    res = await fetch(c.url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
  } catch {
    return { id: c.id, status: 'error', error: "Your browser couldn't reach the store" };
  }
  if (gate && res.status === 200) {
    // The store's queue where its page should be (your time through it ran out): nothing more asked
    // there until you're through again — and nothing read as the product's stock.
    const html = await res.clone().text().catch(() => '');
    const seen = gateOnPage(gate, { url: res.url || c.url, html });
    if (seen && seen.kind === 'queue') return { id: c.id, gate: seen };
  }
  if (res.status === 404 || res.status === 410) return { id: c.id, status: c.kind === 'search' ? 'not_listed' : 'not_found' };
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    // (Its bot protection's "Access Denied": nothing more asked of that store from here for half an hour.)
    const page = await res.clone().text().catch(() => '');
    if (/errors\.edgesuite\.net|you don.?t have permission to access|sorry, you have been blocked/i.test(page.slice(0, 5000))) await markDenied(c.store);
    return { id: c.id, status: 'blocked', error: `The store refused your browser's check (HTTP ${res.status}) — backing off` };
  }
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

// --- other websites (drop watches) -------------------------------------------------
// A website that refuses Mugibot's server is read from here instead — only once you've allowed the
// extension to read it (its menu: Allow), never otherwise. The server says which it would.
/** The other websites this browser may read: those allowed beyond the stores ('*': any). */
async function otherSites() {
  try {
    const { origins = [] } = await chrome.permissions.getAll();
    const fixed = new Set(chrome.runtime.getManifest().host_permissions || []);
    if (origins.some((o) => o === '<all_urls>' || o === 'https://*/*')) return ['*'];
    // (A server on your own computer: the extension reads it, and the dummy store there, on any port.)
    const dev = ['127.0.0.1', 'localhost'].filter((h) => fixed.has(`http://${h}/*`)).map((h) => `${h}:*`);
    return [...new Set([...dev, ...origins.filter((o) => !fixed.has(o)).map((o) => (o.match(/^https:\/\/([^/*]+)\/\*$/) || [])[1]).filter(Boolean)])];
  } catch {
    return [];
  }
}

/** A drop watch's search at another website: its ways in turn, as the server reads them, till one answers. */
async function readSite(c) {
  let last = { ok: false, error: "Your browser couldn't read the website" };
  for (const r of (c.reads || []).slice(0, 3)) {
    let res;
    try {
      res = await fetch(r.url, { credentials: 'include', cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(20000) });
    } catch {
      last = { ok: false, error: "Your browser couldn't reach the website" };
      continue;
    }
    const type = res.headers.get('content-type') || '';
    const text = res.ok ? (await res.text()).slice(0, 3_000_000) : '';
    const got = siteAnswer({ way: r.way, status: res.status, type, text, url: res.url || r.url, by: 'your browser' });
    if (got.ok) {
      const products = got.products.slice(0, 150).map((p) => ({ title: p.title, url: p.url, image: p.image || '', price: typeof p.price === 'number' ? p.price : null }));
      return { id: c.id, ok: true, how: r.way, products };
    }
    last = got;
    if (got.refused) break;
  }
  return { id: c.id, ok: false, refused: !!last.refused, error: last.error };
}

let checking = false;
async function runChecks() {
  if (checking) return { busy: true };
  if (!FROM_STORE && (await chrome.storage.local.get('retired')).retired) return { retired: true };
  const auth = await getAuth();
  if (!auth) return { paired: false };
  checking = true;
  try {
    // (Stores whose queue this browser got through: it may check them; the others' queues are left alone.)
    const sites = await otherSites();
    // (v: this copy's version — BIG W's pages go only to one that opens them, 1.27.0 and later.)
    const due = await api('GET', `/api/ext/checks?through=${encodeURIComponent((await throughStores()).join(','))}&sites=${encodeURIComponent(sites.join(','))}&v=${encodeURIComponent(VERSION)}`);
    if (due.status !== 200 || !due.body) return { status: due.status };
    // (Websites refusing the server that this browser could read, once allowed: offered in the menu.)
    await chrome.storage.local.set({ needSites: Array.isArray(due.body.sites) ? due.body.sites.slice(0, 20) : [] });
    const results = [];
    const lastByHost = new Map();
    const flows = (await getState()).flows || [];
    const held = await heldStores();
    const denied = await deniedStores();
    for (const c of due.body.checks || []) {
      if (held.has(c.store)) continue; // its queue is up here (the server may not know yet)
      if (denied.has(c.store)) continue; // it's turning this browser away just now: left alone
      const host = new URL(c.url).host;
      const gap = Date.now() - (lastByHost.get(host) || 0);
      if (gap < 4000) await new Promise((r) => setTimeout(r, 4000 - gap)); // gentle on each store
      lastByHost.set(host, Date.now());
      if (c.kind === 'site') {
        results.push(await readSite(c));
        continue;
      }
      const r = flows.find((x) => x.id === c.store);
      const out = await checkOne(c, r && r.gate);
      if (out.gate) {
        held.add(c.store);
        await withGates((g) => { const s = g[c.store] || (g[c.store] = { line: {}, runs: [] }); s.kind = 'queue'; s.upAt = Date.now(); });
        reportGate(c.store, { status: 'up', how: 'page', wait: out.gate.wait }).catch(() => null);
        continue;
      }
      results.push(out);
    }
    if (results.length) await api('POST', '/api/ext/checks', { results });
    const summary = { at: Date.now(), checked: results.length, blocked: results.filter((r) => r.status === 'blocked').length };
    await chrome.storage.local.set({ lastChecks: summary });
    return summary;
  } finally {
    checking = false;
  }
}

// --- live sweeps (admins' browsers) --------------------------------------------
// --- Store pages kept open for live sweeps (BIG W, EB Games, Zing) ----------------------
// A minimised window of the extension's own, with one tab per store, reused for every search.
// Closing it is fine: the next search opens it again. Mugibot's store panel stays out of it.
//   render (BIG W): the search page is opened and read once it has built its product list, with
//     the product data the page itself downloaded (asked again from inside the page), so products
//     the page hasn't drawn yet still count.
//   inPage (EB Games, Zing): the store's own search JSON is asked for from inside a page of the
//     store, the way that page does, so it passes the store's bot check like any visitor.
const SWEEP_WINDOW = 'sweepWindow';

// --- a store turning this browser away (Akamai's "Access Denied" at BIG W) ------------------------------
// Its bot protection has taken this browser for a bot. Asking it for more only makes that last: so this
// browser asks that store for nothing more — no searches, no checks — for half an hour. (Your own visits,
// and a checkout you start, still go: only Mugibot's own asking stops.)
const DENIED = 'deniedStores';
const DENIED_MS = 30 * 60 * 1000;
async function deniedStores() {
  const all = (await chrome.storage.session.get(DENIED))[DENIED] || {};
  return new Set(Object.keys(all).filter((k) => all[k] > Date.now()));
}
async function markDenied(store) {
  if (!store) return;
  const all = (await chrome.storage.session.get(DENIED))[DENIED] || {};
  all[store] = Date.now() + DENIED_MS;
  await chrome.storage.session.set({ [DENIED]: all });
}

async function sweepWindow() {
  const { [SWEEP_WINDOW]: saved } = await chrome.storage.session.get(SWEEP_WINDOW);
  return saved && saved.tabs ? { privateWindowId: null, ...saved } : { windowId: null, privateWindowId: null, tabs: {} };
}

async function isSweepTab(tabId) {
  return Object.values((await sweepWindow()).tabs).includes(tabId);
}

let sweepTabLock = Promise.resolve();
/**
 * The store's tab in the sweep window (opened if needed) — one at a time: searches at several stores start side by side.
 * privateWindow (BIG W's): in a minimised private (Incognito) window of its own instead — see privateAllowed().
 */
function sweepTab(store, { privateWindow = false } = {}) {
  const next = sweepTabLock.then(() => openSweepTab(store, privateWindow));
  sweepTabLock = next.catch(() => null);
  return next;
}

// A store read from a private (Incognito) window of its own (BIG W's: sweep.privateWindow): its searches and page
// reads keep their own cookies, apart from your own visits to it — so its bot protection taking Mugibot's reading for
// a bot never turns you away there, nor your checkouts. Only where you've allowed Mugibot in Incognito
// (chrome://extensions → Mugibot → Details → Allow in Incognito); otherwise the ordinary sweep window, as before.
// (Its "Access Denied" is waited out the same either way — half an hour, the private window kept as it is: never
// a fresh private window to get round it.)
let privateOff = 0; // (Chrome wouldn't open one — Incognito switched off on this computer: tried again in an hour)
async function privateAllowed() {
  if (Date.now() < privateOff) return false;
  return !!(await chrome.extension.isAllowedIncognitoAccess().catch(() => false));
}

async function openSweepTab(store, privateWindow = false) {
  const saved = await sweepWindow();
  const priv = privateWindow && (await privateAllowed());
  if (saved.tabs[store] !== undefined) {
    try {
      const tab = await chrome.tabs.get(saved.tabs[store]);
      // (In the window it should be in: a store moved to its private window gets a new tab there.)
      if (!!tab.incognito === priv) {
        if (tab.autoDiscardable !== false) await keepTab(tab.id);
        return tab;
      }
      await chrome.tabs.remove(tab.id).catch(() => null);
    } catch { /* closed */ }
  }
  let tab = null;
  if (priv) tab = await privateTab(saved);
  if (!tab && saved.windowId !== null) {
    try { tab = await chrome.tabs.create({ windowId: saved.windowId, url: 'about:blank', active: false }); } catch { /* the window was closed */ }
  }
  if (!tab) {
    const win = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' });
    saved.windowId = win.id;
    for (const [k, id] of Object.entries(saved.tabs)) if (!(await chrome.tabs.get(id).then((t) => t.incognito, () => false))) delete saved.tabs[k];
    tab = win.tabs[0];
  }
  saved.tabs[store] = tab.id;
  await chrome.storage.session.set({ [SWEEP_WINDOW]: saved });
  await keepTab(tab.id);
  return tab;
}

/**
 * A tab in the private sweep window (opened, minimised, if needed: its first tab left blank, so closing a store's tab
 * never closes the window — and its cookies stay as they are). null if Chrome won't open one.
 */
async function privateTab(saved) {
  if (saved.privateWindowId !== null) {
    try { return await chrome.tabs.create({ windowId: saved.privateWindowId, url: 'about:blank', active: false }); } catch { /* the window was closed */ }
  }
  try {
    const win = await chrome.windows.create({ incognito: true, url: 'about:blank', focused: false, state: 'minimized' });
    saved.privateWindowId = win.id;
    for (const [k, id] of Object.entries(saved.tabs)) if (await chrome.tabs.get(id).then((t) => t.incognito, () => true)) delete saved.tabs[k];
    return await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: false });
  } catch {
    privateOff = Date.now() + 60 * 60 * 1000;
    return null;
  }
}

/** A sweep tab Chrome never throws out to save memory (its Memory Saver): a store searched from here all day long. */
async function keepTab(tabId) {
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => null);
}

/** The store's sweep tab, closed — opened afresh for its next search — unless it's in the store's queue (never touched then). */
async function dropSweepTab(store) {
  const g = await gatesNow().catch(() => ({}));
  const forget = sweepTabLock.then(async () => {
    const saved = await sweepWindow();
    const old = saved.tabs[store];
    if (old === undefined || ((g[store] || {}).line || {})[old]) return;
    delete saved.tabs[store];
    await chrome.storage.session.set({ [SWEEP_WINDOW]: saved });
    await chrome.tabs.remove(old).catch(() => null);
  });
  sweepTabLock = forget.catch(() => null);
  await forget;
}

/**
 * The page the tab is about to open, loaded: its own "complete", after it started loading — never the
 * one the tab is leaving (a new tab's blank page can say "complete" just after it's been sent on).
 * Read too early, a store's queue page would look like nothing at all, and the page be asked for
 * again: in a virtual queue, that loses the place in line.
 */
function tabLoaded(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let started = false;
    const timer = setTimeout(done, timeoutMs);
    function done() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }
    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      else if (info.status === 'complete' && started) done();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/** A tab showing the store's queue (or its checkpoint): never navigated, never reloaded. */
class GateHeld extends Error {
  constructor(seen) { super("It's in the store's queue"); this.gate = seen; }
}

async function openIn(tabId, url, gate = null) {
  const queued = async () => {
    const now = gate ? await inPage(tabId, readGatePage, []).catch(() => null) : null;
    return now && gateOnPage(gate, now);
  };
  let seen = await queued();
  if (seen) throw new GateHeld(seen);
  const loaded = tabLoaded(tabId, 25000);
  await chrome.tabs.update(tabId, { url });
  await loaded;
  // The store's queue came up instead (it went up just now): this tab's in line — nothing more asked from it.
  seen = await queued();
  if (seen) throw new GateHeld(seen);
}

/** Runs in the store's page: how many product links it has so far, the page, and the data it downloaded. */
function readSweepPage(path) {
  const rx = path ? new RegExp(path[0], path[1]) : /\/(p|product|products)\//i;
  let products = 0;
  for (const a of document.querySelectorAll('a[href]')) {
    // (Not the site's menus: at a store whose products are /<name> — The Gamesmen's — its menu's links
    // look like product links, and the page was read before its results were drawn.)
    if (a.closest('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')) continue;
    try { if (rx.test(new URL(a.href, location.href).pathname)) products += 1; } catch { /* not a link */ }
  }
  const data = performance.getEntriesByType('resource')
    .filter((e) => (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') && /search|product|listing|catalog|browse/i.test(e.name))
    .map((e) => e.name).filter((u, i, all) => all.indexOf(u) === i).slice(-4);
  // A bot check's page instead of the store's (Cloudflare's, or Imperva's at Pokémon Center: a frame and no title).
  const challenge = /just a moment|attention required|access denied|verify you are human|pardon our interruption/i.test(document.title)
    || !!document.querySelector('iframe[src*="_Incapsula_Resource"]');
  // (Its "Access Denied": the store's bot protection turning this browser away — not a page to wait on.)
  const text = String((document.body && document.body.innerText) || '').slice(0, 4000);
  const denied = (/^\s*access denied\s*$/i.test(document.title) || /you don.?t have permission to access|errors\.edgesuite\.net|sorry, you have been blocked/i.test(text)) && text.length < 3000;
  // (Its own link to its next page of results — rel="next", or a link saying "Next": where its later pages are.)
  const nextLink = document.querySelector('link[rel~="next"][href], a[rel~="next"][href]')
    || [...document.querySelectorAll('a[href]')].find((a) => /^\s*next(\s+page)?\s*[›»>→]?\s*$/i.test(a.textContent || '') || /^\s*next(\s+page)?\s*$/i.test(a.getAttribute('aria-label') || ''));
  const next = nextLink ? String(nextLink.href || '') : '';
  return { products, data, challenge, denied, next, url: location.href, title: document.title, html: document.documentElement.outerHTML };
}

/** Runs in the store's page: asks the store for something, the way the page itself does (with the headers its own code adds). */
async function askInPage(urls, headers) {
  const out = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*', ...(headers || {}) } });
      out.push({ url: r.url, status: r.status, type: r.headers.get('content-type') || '', text: (await r.text()).slice(0, 6000000) });
    } catch (e) {
      out.push({ url, status: 0, error: String(e && e.message || e) });
    }
  }
  return out;
}

const inPage = (tabId, func, args) => chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args })
  .then(([res]) => res && res.result);

async function renderedPage(t) {
  const { id: tabId, incognito } = await sweepTab(t.store, { privateWindow: !!t.privateWindow });
  await openIn(tabId, t.url, t.gate);
  const path = t.productPath ? [t.productPath.re, t.productPath.f || ''] : null;
  // (Longer than the page needs: a store's bot check may hold it up for a few seconds first.)
  const until = Date.now() + 15000;
  let page = null;
  let failed = null;
  let dataAt = 0;
  for (let seen = 0; ;) {
    // The page can be changing under us: a store's bot check (Imperva's, F5's) reloads it once it's
    // satisfied. Reading it at that moment fails: look again a moment later.
    const now = await inPage(tabId, readSweepPage, [path]).then((x) => { failed = null; return x; }, (e) => { failed = e; return null; });
    if (now) page = now;
    if (now && now.denied) break;
    // Products on the page: one more look a moment later, so their prices have filled in too.
    // A bot check's page: wait (it may let the page through), and say so if it never does.
    if (now && now.products) { if (seen++) break; } else if (Date.now() > until) break;
    // The page downloaded its product data but hasn't drawn it (a page in a hidden window
    // may never draw it): a moment longer for the drawing, then read the data instead.
    if (page && !page.products && page.data.length) {
      if (!dataAt) dataAt = Date.now();
      else if (Date.now() - dataAt > 2000) break;
    }
    await new Promise((r) => setTimeout(r, seen ? 600 : 800));
  }
  if (!page) { if (failed) throw failed; return null; }
  // The store's queue instead of its search: this tab's in line now — left exactly as it is.
  const queued = t.gate && gateOnPage(t.gate, { url: page.url, html: page.html });
  if (queued) throw new GateHeld(queued);
  // The product data the page downloaded, asked for again from inside it: JSON only.
  if (page.data.length) {
    const got = (await inPage(tabId, askInPage, [page.data]).catch(() => null)) || [];
    const json = got.filter((g) => g.status === 200 && /^\s*[[{]/.test(g.text || ''));
    page.html += json.map((g) => `<script type="application/json" data-mugibot-sweep>${g.text.replace(/<\//g, '<\\/')}</script>`).join('');
  }
  page.incognito = !!incognito;
  return page;
}

/** The store's own search JSON, asked for from inside a page of the store (opened first when needed). */
async function askFromStorePage(t) {
  const tab = await sweepTab(t.store, { privateWindow: !!t.privateWindow });
  const origin = new URL(t.url).origin;
  const onStore = () => chrome.tabs.get(tab.id).then((x) => String(x.url || '').startsWith(origin)).catch(() => false);
  if (!(await onStore())) await openIn(tab.id, t.pageUrl || origin, t.gate);
  const ask = () => inPage(tab.id, askInPage, [[t.url], t.headers || null]).catch(() => null);
  let [res] = (await ask()) || [];
  // The store's queue where the JSON should be: it's up — the search waits, and the tab isn't touched.
  const queued = (x) => !!(t.gate && x && x.status === 200 && gateOnPage(t.gate, { url: x.url, html: x.text || '' }));
  if (queued(res)) throw new GateHeld(gateOnPage(t.gate, { url: res.url, html: res.text || '' }));
  // The store's bot check (a refusal, or its page where the JSON should be): a real visit to the
  // store's page passes it, then ask again. (A store that answers with a page — Amazon's search — is
  // judged by its reader instead.)
  const wrongKind = t.expect !== 'html' && res && res.status === 200 && !/^\s*[[{]/.test(res.text || '');
  if (!res || res.status === 403 || res.status === 503 || wrongKind) {
    await openIn(tab.id, t.pageUrl || origin, t.gate);
    [res] = (await ask()) || [];
    if (queued(res)) throw new GateHeld(gateOnPage(t.gate, { url: res.url, html: res.text || '' }));
  }
  return res || null;
}

/**
 * Reset by an admin (the live monitor's Reset): the store's tab in the sweep window is closed and
 * opened again at the store's front page, like coming back to the site later. Its sign-in and
 * cookies stay as they are.
 */
async function freshStart(t) {
  // (In turn with the other stores' tabs being opened: the list of them is changed one at a time.)
  const forget = sweepTabLock.then(async () => {
    const saved = await sweepWindow();
    const old = saved.tabs[t.store];
    if (old === undefined) return;
    delete saved.tabs[t.store];
    await chrome.storage.session.set({ [SWEEP_WINDOW]: saved });
    await chrome.tabs.remove(old).catch(() => null);
  });
  sweepTabLock = forget.catch(() => null);
  await forget;
  if (!t.frontUrl) return;
  if (t.render || t.inPage) {
    const tab = await sweepTab(t.store, { privateWindow: !!t.privateWindow });
    await openIn(tab.id, t.frontUrl);
  } else {
    await fetch(t.frontUrl, { credentials: 'include', cache: 'no-store' }).catch(() => null);
  }
}

// Why something failed, briefly ("Cannot access contents of the page…"), for the live monitor.
const why = (e) => {
  const m = String((e && e.message) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return m ? ` (${m})` : '';
};

async function sweepOne(t) {
  const started = Date.now();
  const base = { store: t.store, keyword: t.keyword, page: t.page };
  const opts = (url) => ({ base: url || t.url, storeBase: t.storeBase, productPath: revive(t.productPath), skuFromPath: revive(t.skuFromPath), storeName: t.storeName });
  // A store added after this copy of the extension was made: Chrome doesn't let it open that store's pages.
  if (t.render || t.inPage) {
    const u = new URL(t.url);
    const allowed = await chrome.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] }).catch(() => true);
    if (!allowed) return { ...base, ok: false, error: `This copy of Mugibot's extension (v${VERSION}) can't open ${u.hostname} — update the extension`, ms: 0 };
  }
  if (t.fresh) await freshStart(t).catch(() => null);
  // (The store's queue: the search waits — no failure, and the tab's left as it is.)
  const held = (e) => ({ ...base, ok: false, gate: { kind: e.gate.kind, wait: e.gate.wait }, ms: Date.now() - started });
  if (t.render) {
    let page;
    try {
      page = await renderedPage(t);
    } catch (e) {
      if (e instanceof GateHeld) return held(e);
      return { ...base, ok: false, error: `This browser couldn't open the store's page${why(e)}`, ms: Date.now() - started };
    }
    if (!page) return { ...base, ok: false, error: "This browser couldn't read the store's page", ms: Date.now() - started };
    if (page.denied) {
      await markDenied(t.store);
      return { ...base, ok: false, blocked: true, status: 403, error: `${t.storeName || 'The store'} said "Access Denied" to this browser (its bot protection) — Mugibot asks it for nothing from here for 30 minutes, so it can lift`, ms: Date.now() - started };
    }
    const parsed = parseListing(t.parser, page.html.slice(0, 8_000_000), opts(page.url));
    const problem = page.challenge ? 'blocked' : parsed.problem;
    // (A page it couldn't read: what it was, for the live monitor — its title, size and product links.)
    const seen = problem === 'layout' ? { title: String(page.title || '').slice(0, 200), bytes: page.html.length, links: page.products } : undefined;
    // (next: the page's own link to its next page of results — BIG W's later pages are read where it goes.)
    // (privateWindow: whether it was read in its private window — Mugibot allowed in Incognito here — or the ordinary one.)
    return { ...base, ok: true, status: 200, ms: Date.now() - started, problem, seen, next: String(page.next || '').slice(0, 2000), products: parsed.products.slice(0, 300), ...(t.privateWindow ? { privateWindow: page.incognito } : {}) };
  }
  if (t.inPage) {
    let res;
    try {
      res = await askFromStorePage(t);
    } catch (e) {
      if (e instanceof GateHeld) return held(e);
      return { ...base, ok: false, error: `This browser couldn't open the store's page${why(e)}`, ms: Date.now() - started };
    }
    if (!res || !res.status) return { ...base, ok: false, error: "This browser couldn't reach the store", ms: Date.now() - started };
    if (res.status !== 200) return { ...base, ok: false, status: res.status, blocked: [401, 403, 429, 503].includes(res.status), ms: Date.now() - started };
    const parsed = parseListing(t.parser, res.text, opts(res.url));
    const title = parsed.problem === 'layout' ? /<title[^>]*>([^<]{0,200})/i.exec(res.text || '') : null;
    const seen = parsed.problem === 'layout' ? { title: title ? title[1] : String(res.type || ''), bytes: String(res.text || '').length } : undefined;
    return { ...base, ok: true, status: 200, ms: Date.now() - started, problem: parsed.problem, seen, products: parsed.products.slice(0, 300) };
  }
  let res;
  try {
    res = await fetch(t.url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
  } catch {
    return { ...base, ok: false, error: "This browser couldn't reach the store", ms: Date.now() - started };
  }
  if (!res.ok) return { ...base, ok: false, status: res.status, blocked: [401, 403, 429, 503].includes(res.status), ms: Date.now() - started };
  const text = (await res.text()).slice(0, 6_000_000);
  const parsed = parseListing(t.parser, text, opts(res.url));
  return { ...base, ok: true, status: res.status, ms: Date.now() - started, problem: parsed.problem, products: parsed.products.slice(0, 300) };
}

/** A search ran into the store's queue: if its tab in the sweep window shows the queue, that tab's in line now. */
async function sweepTabInLine(t) {
  const tabId = (await sweepWindow()).tabs[t.store];
  const now = tabId !== undefined ? await inPage(tabId, readGatePage, []).catch(() => null) : null;
  const seen = now && t.gate && gateOnPage(t.gate, now);
  await withGates((g) => {
    const s = g[t.store] || (g[t.store] = { line: {}, runs: [] });
    s.line = s.line || {};
    s.kind = (t.gate && t.gate.kind) || 'queue';
    s.upAt = Date.now();
    if (seen) s.line[tabId] = Date.now();
  });
}

/** Sweep tabs waiting in a store's queue: looked at (never touched) — once one's through, the store's searched again. */
async function watchSweepTabsInLine() {
  const g = await gatesNow();
  const saved = await sweepWindow();
  const flows = (await getState()).flows || [];
  for (const [store, s] of Object.entries(g)) {
    const tabId = saved.tabs[store];
    if (tabId === undefined || !(s.line || {})[tabId]) continue;
    const r = flows.find((x) => x.id === store);
    const now = await inPage(tabId, readGatePage, []).catch(() => null);
    if (!now || !r || !r.gate) continue; // (between pages: next time)
    const seen = gateOnPage(r.gate, now);
    await noteGate(tabId, store, !!seen, { kind: r.gate.kind, wait: seen ? seen.wait : null });
  }
}

let sweeping = false;
// Asked to start while running (the alarm, a new admin, new settings): ask the server again now,
// rather than after the wait — or, if the loop was just stopping, keep going.
let sweepAgain = false;
let wakeSweeps = null;
// Searches going now in this browser: store → its search (each store's runs on its own).
const sweepsGoing = new Map();
// Watched all day from here (BIG W's searches come only from admins' browsers), whatever happens in a page: one
// store's search is given up after jobMs — said as a failed one, its tab opened afresh for the next (a page that
// never answered) — and a loop that's gone stuckMs without a beat is started again by the alarm, the old one
// stopping at its next step (sweepWatch). (Tests shorten them: globalThis.mugibotSweepLimits.)
const SWEEP_LIMITS = { jobMs: 90000, stuckMs: 3 * 60 * 1000 };
globalThis.mugibotSweepLimits = SWEEP_LIMITS;
let sweepBeatAt = 0;
let sweepGen = 0;
class SweepTooLong extends Error {}
/** p, or SweepTooLong after ms. */
function withinLimit(p, ms) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new SweepTooLong()), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
let lastSweepLock = Promise.resolve();
/** The popup's "last search" at each store (one change at a time: searches finish side by side). */
function noteLastSweep(t, result) {
  lastSweepLock = lastSweepLock.then(async () => {
    const { lastSweeps } = await chrome.storage.local.get('lastSweeps');
    await chrome.storage.local.set({ lastSweeps: { ...(lastSweeps || {}), [t.store]: { at: Date.now(), name: t.storeName, ok: result.ok, found: (result.products || []).length, status: result.status || 0, privateWanted: !!t.privateWindow, private: result.privateWindow === true } } });
  }).catch(() => null);
  return lastSweepLock;
}

/** Runs while the server has searches for this browser (only admins get any); the alarm restarts it. */
async function sweepLoop() {
  if (sweeping) {
    sweepAgain = true;
    if (wakeSweeps) wakeSweeps();
    return;
  }
  if (!FROM_STORE && (await chrome.storage.local.get('retired')).retired) return;
  if (!(await getAuth())) return;
  sweeping = true;
  const gen = ++sweepGen;
  try {
    for (;;) {
      sweepAgain = false;
      sweepBeatAt = Date.now();
      // (With this copy's version: stores added since an older one are kept for browsers that can open them.
      //  And the stores whose queue it's through: the others' are left alone while they're up.)
      // (And the stores it's still searching: none of theirs handed out again until that search is in.)
      // (And the stores turning this browser away just now — "Access Denied": left alone for half an hour.)
      const denied = await deniedStores();
      const due = await api('GET', `/api/ext/sweeps?v=${encodeURIComponent(VERSION)}&through=${encodeURIComponent((await throughStores()).join(','))}&busy=${encodeURIComponent([...sweepsGoing.keys(), ...denied].join(','))}`);
      if (gen !== sweepGen) return; // (started again by the alarm: that one goes on)
      if (due.status !== 200 || !due.body || due.body.waitMs === null || due.body.waitMs === undefined) {
        if (sweepAgain) continue;
        // (Searches still going: asked again once they're in — they may be the last of a store swept from here.)
        if (sweepsGoing.size) { await Promise.race([...sweepsGoing.values()]); continue; }
        break;
      }
      if (Array.isArray(due.body.gates)) await noteGatesUp(due.body.gates);
      // Is a store's queue up (or down again)? Looked at as a new visitor, with no cookies.
      const looks = [];
      for (const p of due.body.probes || []) { looks.push(await probeGate(p)); sweepBeatAt = Date.now(); }
      if (looks.length) await api('POST', '/api/ext/gates', { seen: looks });
      await withinLimit(watchSweepTabsInLine(), 20000).catch(() => null);
      const held = await heldStores();
      for (const t of due.body.terms || []) {
        if (held.has(t.store) || sweepsGoing.has(t.store) || denied.has(t.store)) continue; // its queue is up in this browser (nothing asked there), it's still searching, or it's turning this browser away
        // Each store's search on its own, side by side: what it found goes in the moment it's read — never
        // after the slowest store's (BIG W's page, drawn once it's open). One at a time at each store.
        const job = (async () => {
          // (A search that went wrong in here is said as a failed one: the store's backed off as for any.)
          // (One that never ends — a page that never answered: given up, its tab opened afresh for the next.)
          const began = Date.now();
          const result = await withinLimit(sweepOne(t), SWEEP_LIMITS.jobMs).catch(async (e) => {
            if (e instanceof SweepTooLong) {
              await dropSweepTab(t.store).catch(() => null);
              return { store: t.store, keyword: t.keyword, page: t.page, ok: false, error: `This browser's search took over ${Math.round(SWEEP_LIMITS.jobMs / 1000)} s — given up, and the store's tab opened afresh for the next one`, ms: Date.now() - began };
            }
            return { store: t.store, keyword: t.keyword, page: t.page, ok: false, error: `This browser's search went wrong: ${String((e && e.message) || e).slice(0, 120)}`, ms: 0 };
          });
          if (result.gate) await sweepTabInLine(t).catch(() => null);
          await api('POST', '/api/ext/sweeps', { results: [result] });
          await noteLastSweep(t, result);
        })().catch(() => null).finally(() => {
          // (Started again meanwhile, this store searched anew: that search's, not this one's, to clear.)
          if (sweepsGoing.get(t.store) === job) sweepsGoing.delete(t.store);
          sweepAgain = true; // (its next search, at its pace: asked for now)
          if (wakeSweeps) wakeSweeps();
        });
        sweepsGoing.set(t.store, job);
      }
      // Waiting for the next search. Touching storage keeps this worker running meanwhile.
      await chrome.storage.session.set({ sweepBeat: Date.now() });
      if (!sweepAgain) {
        await new Promise((r) => {
          wakeSweeps = r;
          setTimeout(r, Math.min(20000, Math.max(1000, due.body.waitMs)));
        });
        if (gen !== sweepGen) return;
        wakeSweeps = null;
      }
      if (!(await getAuth())) break;
    }
  } finally {
    if (gen === sweepGen) sweeping = false;
  }
}

/**
 * The alarm's look at the sweep loop (every 30 s): not running — started; running but gone quiet past stuckMs
 * (something in it never answered) — started again, the old one stopping at its next step, the stores it was
 * searching handed out afresh.
 */
async function sweepWatch() {
  if (sweeping && sweepBeatAt && Date.now() - sweepBeatAt > SWEEP_LIMITS.stuckMs) {
    sweepGen += 1;
    sweeping = false;
    sweepsGoing.clear();
    if (wakeSweeps) { const w = wakeSweeps; wakeSweeps = null; w(); }
  }
  return sweepLoop();
}
globalThis.mugibotSweepWatch = sweepWatch;
// (What the loop's doing, for the popup and tests: running, its last beat, its turn, the stores searching now.)
globalThis.mugibotSweepState = () => ({ sweeping, beatAt: sweepBeatAt, gen: sweepGen, going: [...sweepsGoing.keys()] });

// --- Auto-checkout ---------------------------------------------------------------
// While you have it switched on with items armed (or a Trigger ACO test waiting), this browser asks your account for runs to start
// (each answer waits up to 20 seconds for an armed item to drop, so a drop starts within a moment).
// Your checkout browser (the one runs go to) asks all the time, armed or not: Discord's ⚡ Buy,
// pressed on your phone, starts a run here (aco.listen).
// A run opens the store in a tab of its own, in front of you (payment forms need a page you can
// see, and you can watch it go): the store page's script does the rest, with the run's limits.
let acoLooping = false;

// (clears / clearing: bags to empty — Clear cart — asked for while there are.)
// (going: a run of yours still under way — listened for meanwhile, so one you stop on your dashboard is told here.)
// (scheduled: a ⏰ 🚦 Wait for queue, then ACO set for later — listened for, so it starts here the moment it's due.)
const acoWanted = (a) => !!a && (a.listen || a.clearing > 0 || (typeof a.clears === 'number' && a.clears > 0) || (a.enabled && (a.armed || a.pending)) || a.going > 0 || a.scheduled > 0);

async function acoLoop() {
  if (acoLooping) return;
  if (!FROM_STORE && (await chrome.storage.local.get('retired')).retired) return;
  let st = await getState();
  if (!st.paired) return;
  // Not wanted, by the copy from the last couple of minutes: asked again first — something may have been
  // armed since (by a drop watch, or from your phone), and its drop shouldn't wait for the next copy.
  if (!acoWanted(st.aco)) {
    const auth = await getAuth();
    const fresh = auth ? await refreshState(auth).catch(() => null) : null;
    if (!fresh || !acoWanted(fresh.aco)) return;
    st = { ...st, aco: fresh.aco };
  }
  acoLooping = true;
  try {
    for (let quiet = 0; quiet < 3;) {
      // (An extension call between asks keeps this worker running while it waits.)
      await chrome.storage.session.set({ acoBeat: Date.now() });
      const started = Date.now();
      const res = await api('GET', `/api/ext/aco/next?wait=20&card=${await cardStateNow()}`, undefined, { timeoutMs: 40000 });
      if (res.status !== 200 || !res.body) {
        quiet += 1; // offline, or the account's membership ended: try again in a moment, then leave it to the alarm
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      quiet = 0;
      // Runs first: every moment counts in a drop.
      for (const run of res.body.runs || []) await startRun(run).catch(() => null);
      // Runs you stopped on your dashboard: their tabs here press nothing more.
      if ((res.body.stops || []).length) await stopRuns(res.body.stops).catch(() => null);
      await releaseTurns().catch(() => null);
      if (Array.isArray(res.body.gates)) await noteGatesUp(res.body.gates);
      // A store's queue went up where you have something armed (or you pressed "Join the queue"): get in line —
      // unless a run just opened that store (its tab gets in line itself: never two tabs into one queue).
      const opened = new Set((res.body.runs || []).map((r) => r.store));
      for (const l of res.body.lobbies || []) if (!opened.has(l.store)) await joinLobby(l).catch(() => null);
      // Bags to empty (Clear cart): one store at a time, in a tab of their own.
      if ((res.body.clears || []).length) startClears(res.body.clears);
      if (!acoWanted(res.body)) break;
      // (A quick answer with nothing in it: a moment before asking again. With runs: straight away — more may be waiting.)
      if (!(res.body.runs || []).length && Date.now() - started < 1000) await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    acoLooping = false;
  }
}

/** A tab at a store in your window (not the sweep window): in front of you, or (a queue's lobby) behind. */
async function openStoreTab(url, { active = true } = {}) {
  let tab = null;
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  // (Never into a private window — yours or the sweep's: a checkout needs your own sign-ins and cookies.)
  if (win && win.id !== undefined && !win.incognito && !(await isSweepWindow(win.id))) {
    tab = await chrome.tabs.create({ windowId: win.id, url, active }).catch(() => null);
    if (tab && active) await chrome.windows.update(win.id, { focused: true, state: win.state === 'minimized' ? 'normal' : undefined }).catch(() => null);
  }
  if (!tab) tab = ((await chrome.windows.create({ url, focused: active, type: 'normal' })).tabs || [])[0] || null;
  return tab;
}

/**
 * A run opens the store in a tab of its own — unless another checkout of yours at that store goes
 * first (turns, below): then it's next in line, and opens the store the moment that one is done.
 * (turn: false — its turn has come.)
 */
async function startRun(run, { turn = true } = {}) {
  // Sent again while its tab is still coming in (a store slowed right down by a busy drop takes longer
  // than the server waits to hear back): that tab carries on — never a second one, which could add it
  // twice. (A tab that has come in and still not taken the run up couldn't — its claim failed: a new
  // tab, as ever. So does one that's been loading longer than the run's code lasts.)
  const going = Object.entries((await chrome.storage.session.get(TURNS))[TURNS] || {}).find(([k, e]) => k.startsWith('t:') && e.runId === run.id);
  const goingTab = going && (await chrome.tabs.get(Number(going[0].slice(2))).catch(() => null));
  if (goingTab && goingTab.status === 'loading' && Date.now() - (going[1].since || 0) < 5 * 60 * 1000) return null;
  // This browser is in that store's queue (a tab of yours waiting its turn): the run waits for it to
  // get through, rather than ask the store again (which could cost the place in line).
  const g = await gatesNow();
  if (g[run.store] && g[run.store].kind === 'queue' && inLine(g[run.store])) {
    const wait = g[run.store].wait;
    await withTurns((t) => { delete t[`r:${run.id}`]; }); // (in the queue's line instead: it comes back here once through)
    await withGates((all) => { const s = all[run.store]; s.runs = [...(s.runs || []).filter((x) => x.id !== run.id), { id: run.id, store: run.store, storeName: run.storeName, name: run.name, sku: run.sku }]; });
    await api('POST', `/api/ext/aco/${encodeURIComponent(run.id)}`, { status: 'waiting', reason: 'queue', message: `In ${run.storeName}'s virtual queue in this browser${wait != null ? ` — about ${wait} min` : ''} — it checks out once it's through` });
    return null;
  }
  const key = `r:${run.id}`;
  const shopLink = await isShopLink(run.store);
  const before = await withTurns((t) => {
    if (!t[key]) t[key] = { store: run.store, since: Date.now(), runId: run.id, name: run.name || '', own: shopLink, run: { id: run.id, store: run.store, storeName: run.storeName, name: run.name, sku: run.sku, mode: run.mode } };
    const a = turn ? ahead(t, key) : null;
    if (a) t[key].beatAt = Date.now();
    else t[key].opening = true;
    return a;
  });
  if (before) {
    await api('POST', `/api/ext/aco/${encodeURIComponent(run.id)}`, { status: 'waiting', reason: 'turn', message: nextInLine(run.storeName, before) });
    return null;
  }
  // (Not in front of a card being typed in another tab: that tab keeps the front for it.)
  const tab = await openStoreTab(run.url, { active: !typingElsewhere(null) });
  await withTurns((t) => {
    const e = t[key] || { store: run.store, since: Date.now(), runId: run.id, name: run.name || '', own: shopLink };
    delete t[key];
    if (tab) t[`t:${tab.id}`] = { store: e.store, since: e.since, runId: e.runId, name: e.name, tabId: tab.id, own: !!e.own };
  });
  if (tab && shopLink) setTimeout(() => { notReachedShop(run, tab.id).catch(() => null); }, SHOP_REACH_MS);
  const { acoRecent = [] } = await chrome.storage.local.get('acoRecent');
  await chrome.storage.local.set({ acoRecent: [{ id: run.id, name: run.name, store: run.storeName, at: Date.now() }, ...acoRecent].slice(0, 10) });
  return tab;
}

/** Is this store's flow a Shop checkout link's (each link its own order, opened by the link itself)? */
async function isShopLink(storeId) {
  const r = ((await getState()).flows || []).find((x) => x.id === storeId);
  return !!(r && r.cartLinks);
}

// A Shop checkout link opens Shop's checkout only in a browser signed in to Shop: otherwise Shop sends it
// on to the store's own checkout as a guest, where Mugibot doesn't run — and the run would wait for
// nothing. Not on Shop's checkout this long after its tab opened: your account hears so (the tab is left
// as it is, for you), and this browser counts as signed out of Shop until it's seen signed in again.
const SHOP_REACH_MS = 25 * 1000;
// (A busy drop: Shop's checkout can take a while to come in — looked at again every 10 s while its tab is
//  still loading, this long at most.)
const SHOP_SLOW_MS = 3 * 60 * 1000;
async function notReachedShop(run, tabId, since = Date.now() - SHOP_REACH_MS) {
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (tab && tab.status === 'loading' && Date.now() - since < SHOP_SLOW_MS) {
    setTimeout(() => { notReachedShop(run, tabId, since).catch(() => null); }, 10 * 1000);
    return;
  }
  // (Got there meanwhile: its checkout's under way.)
  const pass = tabId != null ? (await chrome.storage.session.get(passKey(tabId)))[passKey(tabId)] : null;
  if (pass && pass.aco && pass.aco.runId === run.id) return;
  // Seen signed in to Shop in this browser lately: not on Shop's checkout yet is the store's queue, most
  // likely (Mattel Creations' checkout queue at a drop, on the store's own site, where Mugibot doesn't run) —
  // waited for, never refreshed; it carries on at Shop's checkout once it's through (heldUp, below).
  if (tab && (await shopSignedInLately(run.store))) {
    await holdUp(tabId, run.id, 'entry');
    return;
  }
  const res = await api('POST', `/api/ext/aco/${encodeURIComponent(run.id)}`, {
    status: 'needs_you', reason: 'no_shop',
    message: "Shop's checkout didn't open in this browser: the link went on to the store's own checkout, as a guest — sign in to Shop (shop.app) here, and finish this one in its tab yourself.",
  });
  // (Your account only takes it while the run hadn't got going: then it's said, and this browser's signed out of Shop.)
  if (res.status === 200 && res.body && res.body.run && res.body.run.reason === 'no_shop') await noteLogin(run.store, 'out', 'run');
}

/** Seen signed in to Shop in this browser in the last 12 hours (on its checkout, or a run that got there). */
async function shopSignedInLately(store) {
  const { [LOGINS]: all = {} } = await chrome.storage.local.get(LOGINS);
  const l = all[store];
  return !!(l && l.status === 'in' && Date.now() - l.at < 12 * 60 * 60 * 1000);
}

// A Shop checkout link's tab held up on the store's own site, where Mugibot doesn't run — the store's
// checkout queue at a drop (Mattel Creations'): on its way to Shop's checkout ('entry'), or sent back there
// from Shop's checkout while it said "not available for purchase" ('away': the queue reset at the drop).
// It's waited for, never refreshed: your account hears so every few minutes (the run kept going), the tab's
// pass is kept good, and once the tab's back on Shop's checkout the run carries on there (queueReturn,
// acoInfo). tabId → { runId, kind, since, beatAt }.
const HELD_UP = 'shopHeldUp';
const HELD_BEAT_MS = 3 * 60 * 1000;
const HELD_MAX_MS = 3 * 60 * 60 * 1000;
// (A run pressing "Pay now" while it isn't on sale: its tab heard from all the time — nap, acoRetry. Quiet this
//  long, and not at a press, it's left Shop's checkout without a word: reloaded into the store's queue.)
const LIVE_QUIET_MS = 45 * 1000;
const tabSeen = new Map();
let heldTimer = null;
const heldText = (kind) => (kind === 'entry'
  ? "Not on Shop's checkout yet: the store's queue, most likely (Mattel's at a drop) — your browser waits in it (leave that tab alone: Mugibot never refreshes a queue) and carries on at Shop's checkout once it's through. (If that tab shows the store's own checkout asking for your email instead, you're signed out of Shop: sign in at shop.app and press ⚡ Buy again.)"
  : "In the store's queue, most likely — the tab went on to the store's own site from Shop's checkout (Mattel's queue at a drop), where Mugibot doesn't run. Your browser waits in line (leave that tab alone: Mugibot never refreshes a queue), then presses \"Pay now\" on Shop's checkout until the store takes the order. Nothing has been bought yet.");

async function holdUp(tabId, runId, kind) {
  const { [HELD_UP]: held = {} } = await chrome.storage.session.get(HELD_UP);
  if (!held[tabId] || held[tabId].runId !== runId || held[tabId].kind !== kind) held[tabId] = { runId, kind, since: Date.now(), beatAt: 0 };
  await chrome.storage.session.set({ [HELD_UP]: held });
  await heldUpTick();
}

/** Every 15 s while a tab's held up (or a run's pressing "Pay now" while it isn't on sale): see above. */
async function heldUpTick() {
  clearTimeout(heldTimer);
  heldTimer = null;
  const now = Date.now();
  const { [HELD_UP]: held = {}, [LIVE_TABS]: live = {} } = await chrome.storage.session.get([HELD_UP, LIVE_TABS]);
  // A run pressing "Pay now" whose tab's gone quiet, not at a press: reloaded into the store's queue.
  for (const [tabId, runId] of Object.entries(live)) {
    const key = passKey(Number(tabId));
    const pass = (await chrome.storage.session.get(key))[key];
    const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (!tab || !pass || !pass.aco || pass.aco.runId !== runId || pass.aco.done || pass.aco.stopped) { delete live[tabId]; continue; }
    if (!tabSeen.has(Number(tabId))) tabSeen.set(Number(tabId), now);
    if (pass.aco.away || pass.aco.placing || now - tabSeen.get(Number(tabId)) < LIVE_QUIET_MS || held[tabId]) continue;
    await chrome.storage.session.set({ [key]: { ...pass, aco: awayAco(pass.aco), expires: now + PASS_TTL } });
    held[tabId] = { runId, kind: 'away', since: now, beatAt: 0 };
  }
  for (const [tabId, h] of Object.entries(held)) {
    const key = passKey(Number(tabId));
    const pass = (await chrome.storage.session.get(key))[key];
    const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
    const mine = pass && pass.aco && pass.aco.runId === h.runId;
    // (Closed; over; through to Shop's checkout — the run carrying on there; or too long.)
    if (!tab || now - h.since > HELD_MAX_MS || (h.kind === 'entry' ? mine : !mine || pass.aco.done || pass.aco.stopped || !pass.aco.away)) { delete held[tabId]; continue; }
    if (h.kind === 'away') await chrome.storage.session.set({ [key]: { ...pass, expires: now + PASS_TTL } });
    if (now - h.beatAt < HELD_BEAT_MS) continue;
    h.beatAt = now;
    const res = await api('POST', `/api/ext/aco/${encodeURIComponent(h.runId)}`, { status: 'waiting', reason: h.kind === 'entry' ? 'queue' : 'not_live', message: heldText(h.kind) }).catch(() => null);
    // (Stopped meanwhile — from the dashboard — or over on your account's side: this tab waits no more.)
    if (res && res.status === 200 && res.body && res.body.run && res.body.run.active === false) {
      delete held[tabId];
      if (mine) await chrome.storage.session.set({ [key]: { ...pass, aco: { ...pass.aco, done: true } } });
    }
  }
  await chrome.storage.session.set({ [HELD_UP]: held, [LIVE_TABS]: live });
  if (Object.keys(held).length || Object.keys(live).length) heldTimer = setTimeout(() => { heldUpTick().catch(() => null); }, 15 * 1000);
}

/** The run, sent back to the store's queue while it said "not available for purchase": nothing in flight, said again once back. */
const awayAco = (aco) => ({ ...aco, away: Date.now(), placing: false, placingAt: null, notLive: { since: (aco.notLive && aco.notLive.since) || Date.now(), saidAt: 0 } });
// (The tabs of runs pressing "Pay now" while it isn't on sale: tabId → runId, watched for going quiet.)
const LIVE_TABS = 'liveTabs';

/**
 * Runs you stopped on your dashboard (your account says which, for 10 minutes): each one's tab here is told — it
 * presses nothing more (its pass says stopped: a press it was about to make is refused here too) — and it's out of
 * the line at its store, held-up queue waits included.
 */
const stoppedHere = new Set();
async function stopRuns(ids) {
  const want = new Set(ids.filter((id) => typeof id === 'string' && !stoppedHere.has(id)));
  if (!want.size) return;
  for (const [key, pass] of Object.entries(await chrome.storage.session.get(null))) {
    if (!key.startsWith('fill:') || !pass || !pass.aco || !want.has(pass.aco.runId)) continue;
    const tabId = Number(key.slice('fill:'.length));
    await chrome.storage.session.set({ [key]: { ...pass, aco: { ...pass.aco, done: true, stopped: true } } });
    chrome.tabs.sendMessage(tabId, { type: 'acoStopped' }).catch(() => null);
    turnEnded(tabId).catch(() => null);
  }
  const { [HELD_UP]: held = {}, [LIVE_TABS]: live = {} } = await chrome.storage.session.get([HELD_UP, LIVE_TABS]);
  for (const [t, h] of Object.entries(held)) if (want.has(h.runId)) delete held[t];
  for (const [t, r] of Object.entries(live)) if (want.has(r)) delete live[t];
  await chrome.storage.session.set({ [HELD_UP]: held, [LIVE_TABS]: live });
  // (One still next in line at its store, no tab yet: out of the line.)
  await withTurns((t) => { for (const id of want) delete t[`r:${id}`]; });
  for (const id of want) stoppedHere.add(id);
}

async function isSweepWindow(windowId) {
  const saved = await sweepWindow();
  return saved.windowId === windowId || saved.privateWindowId === windowId;
}

// --- several checkouts at once: one at a time at each store -----------------------------------
// Checkouts at different stores go at the same time, each in a tab of its own. A store keeps one bag
// for this browser, whichever tab adds to it — two checkouts there at once would put both items in
// one order (or stop for each other's). So at each store the checkouts in this browser take turns,
// first come first served: an Auto-checkout run whose store is busy waits here (no tab yet — your
// account shows it as next in line) and opens the store the moment the one before it is done; a
// ⚡ Buy you press meanwhile waits on its page (it says so), then reloads and goes.
// A checkout holds its store until it's over (its order placed, it stopped, its tab closed or went to
// another store), or — once it's waiting for you (at the final button, or stopped for you) — for 3
// minutes more at most; and never more than 15 minutes in all.
// Entries: 't:<tab>' (a checkout in a tab), 'r:<run>' (a run next in line, no tab yet).
const TURNS = 'turns';
const TURN_MAX_MS = 15 * 60 * 1000;
const PARKED_MS = 3 * 60 * 1000;
// Still next in line: your account hears so every couple of minutes (it gives up on a run it hasn't heard from in 10).
const TURN_BEAT_MS = 2 * 60 * 1000;
// Why a checkout stopped before anything of its went into the bag: the next one at the store goes now.
const NOTHING_ADDED = new Set(['signed_out', 'wrong_item', 'sold_out', 'not_added', 'no_checkout', 'stopped', 'disarmed']);
let turnLock = Promise.resolve();

/** One change at a time (several tabs, and runs, at once). */
function withTurns(fn) {
  const run = turnLock.then(async () => {
    const t = (await chrome.storage.session.get(TURNS))[TURNS] || {};
    const out = await fn(t);
    await chrome.storage.session.set({ [TURNS]: t });
    return out;
  });
  turnLock = run.catch(() => null);
  return run;
}

/** Is this checkout still holding its store? */
const holds = (e, now = Date.now()) => !!e && !e.over && now - e.since < (e.clear ? CLEAR_TURN_MS : TURN_MAX_MS) && !(e.parkedAt && now - e.parkedAt > PARKED_MS);
// (Emptying a bag — Clear cart, below — holds its store for this long at most.)
const CLEAR_TURN_MS = 2 * 60 * 1000;

/**
 * The checkout before this one at its store that's still going, or null: it's this one's turn. (A Shop
 * checkout link's — own: each link its own order, with no bag shared — never waits, nor holds anyone up.)
 */
function ahead(t, key, now = Date.now()) {
  const me = t[key];
  if (!me || me.own) return null;
  let first = null;
  for (const [k, e] of Object.entries(t)) {
    if (k === key || e.store !== me.store || e.own || !holds(e, now)) continue;
    if ((e.since < me.since || (e.since === me.since && k < key)) && (!first || e.since < first.since)) first = e;
  }
  return first;
}

const nextInLine = (storeName, a) => (a && a.clear
  ? `Next in line at ${storeName || 'the store'}: your bag there is being emptied (Clear cart) — this one goes the moment that's done`
  : `Next in line at ${storeName || 'the store'}: your checkout of ${(a && a.name) || 'another item'} there goes first (it keeps one bag for this browser) — this one goes the moment that's done`);

/** This tab's checkout, in the line for its store (from its ⚡ Buy code: an Auto-checkout run's tab already is). own: a Shop checkout link's. */
async function joinTurn(tabId, store, { runId = null, name = '', own = false } = {}) {
  if (tabId == null || !store) return;
  await withTurns((t) => {
    const key = `t:${tabId}`;
    const run = runId ? t[`r:${runId}`] : null;
    if (run) { delete t[`r:${runId}`]; t[key] = { store, since: run.since, runId, name: run.name || name, tabId, own }; return; }
    // (The same checkout carrying on — or a new one in this tab: it starts again, at the back.)
    if (t[key] && t[key].store === store && holds(t[key]) && (!runId || t[key].runId === runId)) return;
    t[key] = { store, since: Date.now(), runId, name, tabId, own };
  });
}

/** This tab's checkout is over (gone: true — out of the line altogether), or waiting for you (parked). */
async function turnEnded(tabId, { parked = false, gone = false } = {}) {
  if (tabId == null) return;
  await withTurns((t) => {
    const e = t[`t:${tabId}`];
    if (!e) return;
    if (gone) delete t[`t:${tabId}`];
    else if (parked) { if (!e.parkedAt) e.parkedAt = Date.now(); }
    else e.over = true;
  });
  releaseTurns().catch(() => null);
}

let releasing = null;
/**
 * The next checkout at each store whose turn has come: a run next in line opens the store now (with
 * a fresh link: its first may have run out). Tabs waiting their turn see it themselves (they ask).
 * Also: forgets closed tabs and finished checkouts, and tells your account a run is still in line.
 */
function releaseTurns() {
  if (!releasing) releasing = doReleaseTurns().finally(() => { releasing = null; });
  return releasing;
}

async function doReleaseTurns() {
  const now = Date.now();
  const open = new Set((await chrome.tabs.query({})).map((x) => x.id));
  const { go, beat, late } = await withTurns((t) => {
    const out = { go: [], beat: [], late: [] };
    for (const [k, e] of Object.entries(t)) {
      // (A tab that's closed, a checkout that's over or out of time: out of the line.)
      if ((k.startsWith('t:') && !open.has(e.tabId)) || !holds(e, now)) {
        if (k.startsWith('r:') && now - e.since >= TURN_MAX_MS) out.late.push(e);
        delete t[k];
        continue;
      }
      if (!k.startsWith('r:') || e.opening) continue;
      if (!ahead(t, k, now)) { e.opening = true; out.go.push(e); } else if (now - (e.beatAt || 0) > TURN_BEAT_MS) { e.beatAt = now; out.beat.push({ e, a: ahead(t, k, now) }); }
    }
    return out;
  });
  for (const e of late) {
    api('POST', `/api/ext/aco/${encodeURIComponent(e.runId)}`, { status: 'failed', reason: 'timeout', message: `Your other checkout at ${(e.run && e.run.storeName) || 'the store'} was still going after 15 minutes — it stopped waiting for its turn` }).catch(() => null);
  }
  for (const { e, a } of beat) api('POST', `/api/ext/aco/${encodeURIComponent(e.runId)}`, { status: 'waiting', reason: 'turn', message: nextInLine(e.run && e.run.storeName, a) }).catch(() => null);
  for (const e of go) {
    const r = await api('POST', `/api/ext/aco/${encodeURIComponent(e.runId)}/link`, {});
    if (r.status === 200 && r.body && r.body.url) await startRun({ ...e.run, url: r.body.url }, { turn: false }).catch(() => null);
    else if (r.status !== 0) await withTurns((t) => { delete t[`r:${e.runId}`]; }); // (your account says it's not waiting any more: stopped, or over)
    else await withTurns((t) => { if (t[`r:${e.runId}`]) t[`r:${e.runId}`].opening = false; }); // offline: try again in a moment
  }
}

/** A tab went somewhere: to another store, its checkout here is over (a bank's or payment page on the way isn't a store). */
async function turnMoved(tabId, url) {
  const t = (await chrome.storage.session.get(TURNS))[TURNS] || {};
  const e = t[`t:${tabId}`];
  if (!e) return;
  const r = storeOfUrl((await getState()).flows, url);
  if (r && r.id !== e.store) await turnEnded(tabId, { gone: true });
}

// --- Clear cart: emptying your bag at a store (server/bags.js) ---------------------------------------
// Pressed on your dashboard (anywhere, your phone too): this browser — your checkout browser, where your
// bags are — opens the store's bag in a tab, and the store-page script (bag.js) empties it, checks it's
// empty and says how it went; the tab closes. One store at a time (Clear all: each in turn, in the same
// tab). It takes its turn at the store like a checkout does, so a drop meanwhile waits a moment for it —
// and a store where a checkout of yours is going is left alone (its bag is that checkout's), as is one
// whose virtual queue you're in here (asking it for a page could lose your place).
// A bag it couldn't empty stays open in its tab, for you to see what's left.
const CLEARS = 'clears'; // session: { [tabId]: job } — what the page in each tab is there to empty
const CLEAR_STORE_MS = 90 * 1000;
const clearQueue = [];
let clearing = null; // the job in hand
const clearWaits = new Map(); // job id → resolve(result)
const clearAsked = new Set(); // job ids whose page has asked what it's for (its store-page script is running)
// The bag's page loaded but its store-page script hasn't asked what it's for: this long, then it's said.
const CLEAR_ASK_MS = 10 * 1000;

/** Bags your account asks this browser to empty (each once: one already here isn't added again). */
function startClears(jobs) {
  for (const j of jobs || []) {
    if (!j || !j.id || !j.url || (clearing && clearing.id === j.id) || clearQueue.some((x) => x.id === j.id)) continue;
    clearQueue.push({ id: String(j.id), store: String(j.store || ''), storeName: String(j.storeName || j.store || 'the store'), url: String(j.url) });
  }
  runClears().catch(() => null);
}

const tellClear = (job, status, removed = 0, message = '') => api('POST', `/api/ext/bags/${encodeURIComponent(job.id)}`, { status, removed, message: String(message || '').slice(0, 300) });

async function setClearTab(tabId, job) {
  const all = (await chrome.storage.session.get(CLEARS))[CLEARS] || {};
  if (job) all[tabId] = job;
  else delete all[tabId];
  await chrome.storage.session.set({ [CLEARS]: all });
}
const clearJobOf = async (tabId) => (((await chrome.storage.session.get(CLEARS))[CLEARS] || {})[tabId]) || null;

let clearRunning = false;
async function runClears() {
  if (clearRunning) return;
  clearRunning = true;
  let tab = null; // the tab the bags are emptied in, one store after another
  let back = null; // the tab you were on, in front again once it's done
  try {
    while (clearQueue.length) {
      const job = clearQueue.shift();
      clearing = job;
      const res = await clearOne(job, tab, (t, was) => { tab = t; if (was && !back) back = was; }).catch((e) => ({ status: 'failed', message: `Something went wrong (${String((e && e.message) || e).slice(0, 80)})` }));
      if (!res.keepTab && tab && !(await chrome.tabs.get(tab.id).catch(() => null))) tab = null; // (closed meanwhile)
      clearing = null;
      // (A bag it couldn't empty is left open in its tab, for you: the next store gets a tab of its own.)
      if (res.status === 'failed' && res.keepTab) tab = null;
    }
  } finally {
    clearing = null;
    clearRunning = false;
    if (tab) {
      await setClearTab(tab.id, null).catch(() => null);
      await chrome.tabs.remove(tab.id).catch(() => null);
    }
    if (back) await chrome.tabs.update(back, { active: true }).catch(() => null);
  }
}

/** One store's bag: its turn there, the tab, then what the page says (or that it took too long). */
async function clearOne(job, tab, useTab) {
  const flows = (await getState()).flows || [];
  const r = flows.find((x) => x.id === job.store);
  const done = async (status, removed, message, extra = {}) => {
    await tellClear(job, status, removed, message).catch(() => null);
    return { status, removed, message, ...extra };
  };
  if (!r) return done('failed', 0, `This copy of the extension (v${VERSION}) doesn't know ${job.storeName} — update it`);
  // Your place in its virtual queue: nothing asked of that store meanwhile.
  if ((await heldStores()).has(job.store)) return done('busy', 0, `${job.storeName}'s virtual queue is up — its bag was left alone (asking it for a page could cost your place in line). Try again once it's down, or you're through.`);
  // Its turn at the store — unless a checkout of yours is going there (its bag is that checkout's).
  const key = `c:${job.id}`;
  const other = await withTurns((t) => {
    const now = Date.now();
    const going = Object.entries(t).find(([k, e]) => k !== key && e.store === job.store && holds(e, now));
    if (going) return going[1];
    t[key] = { store: job.store, since: now, clear: true, name: 'Clear cart' };
    return null;
  });
  if (other) return done('busy', 0, `Your checkout of ${other.name || 'an item'} at ${job.storeName} is going in this browser — its bag was left alone. Empty it once that's done.`);
  try {
    tellClear(job, 'clearing', 0, `Opening your ${job.storeName} bag`).catch(() => null);
    // In front, like a checkout (a page you can see draws itself) — not over a checkout of yours going in
    // another tab, nor while one types its card.
    const checkingOut = Object.entries((await chrome.storage.session.get(TURNS))[TURNS] || {}).some(([k, e]) => k.startsWith('t:') && holds(e));
    const front = !checkingOut && !typingElsewhere(null);
    if (tab) {
      await setClearTab(tab.id, job);
      // (Closed meanwhile: a tab of its own, below.)
      if (!(await chrome.tabs.update(tab.id, { url: job.url, ...(front ? { active: true } : {}) }).catch(() => null))) {
        await setClearTab(tab.id, null);
        tab = null;
      }
    }
    if (!tab) {
      const [was] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      tab = await openStoreTab('about:blank', { active: front });
      if (!tab) return done('failed', 0, "This browser couldn't open a tab");
      useTab(tab, front && was ? was.id : null);
      await setClearTab(tab.id, job);
      await chrome.tabs.update(tab.id, { url: job.url });
    }
    const tabId = tab.id;
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'failed', removed: 0, message: `It took too long at ${job.storeName} — have a look in the tab`, keepTab: true }), CLEAR_STORE_MS);
      // (Touching storage now and then keeps this worker running while the page empties the bag.)
      const beat = setInterval(() => chrome.storage.session.set({ clearBeat: Date.now() }).catch(() => null), 10000);
      clearWaits.set(job.id, (res) => { clearTimeout(timer); clearInterval(beat); clearWaits.delete(job.id); resolve(res); });
      // The page didn't load (the store's down, or this browser's offline), or its store-page script never
      // started (it went somewhere Mugibot doesn't know): said in seconds, not a minute and a half on.
      (async () => {
        const fail = (message, keepTab) => { const w = clearWaits.get(job.id); if (w) w({ status: 'failed', removed: 0, message, keepTab }); };
        for (const until = Date.now() + 30000; ;) {
          await new Promise((r) => setTimeout(r, 500));
          if (clearAsked.has(job.id) || !clearWaits.has(job.id)) return;
          const t = await chrome.tabs.get(tabId).catch(() => null);
          if (!t) return; // (closed: said when it was)
          // (Still loading — or still the blank page it started on.)
          if (t.status !== 'complete' || !t.url || /^about:/.test(t.url)) {
            if (Date.now() > until) return fail(`Your ${job.storeName} bag took too long to open in this browser — is the store up?`, true);
            continue;
          }
          const page = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.href }).then(([r]) => (r && r.result) || null, () => null);
          if (!page) return fail(`Couldn't open your ${job.storeName} bag in this browser — the page didn't load (is the store up?)`, false);
          await new Promise((r) => setTimeout(r, CLEAR_ASK_MS));
          if (!clearAsked.has(job.id)) fail(`${job.storeName}'s bag didn't open as Mugibot expected (the tab went to ${String(page).slice(0, 80)})`, true);
          return;
        }
      })().catch(() => null);
    });
    clearAsked.delete(job.id);
    if (clearWaits.has(job.id)) clearWaits.get(job.id)(result);
    await setClearTab(tab.id, null).catch(() => null);
    await tellClear(job, result.status, result.removed || 0, result.message || '').catch(() => null);
    return result;
  } finally {
    await withTurns((t) => { delete t[key]; });
    releaseTurns().catch(() => null); // (a drop that came in meanwhile goes now)
  }
}

/**
 * The page's own "Are you sure?" boxes (the browser's confirm()) answer yes in a tab emptying a bag, and
 * its "Item removed" alert() boxes are closed (one left open would hold the page up until someone did).
 */
function sayYes() {
  window.confirm = function () { return true; };
  window.alert = function () {};
}

// --- card boxes: one tab at a time -------------------------------------------------------------
// The card boxes in payment frames keep only typing into a box on a page in front of you. With
// several checkouts going, the tabs take turns to type their cards: each is brought forward for its
// boxes (a tab's own frames take their turns within it, through its page), and keeps the turn until
// every frame of it that asked is done — and a moment after (for its next box), so tabs don't swap
// back and forth.
const TYPE_HOLD_MS = 6000; // one box takes a second or two (a frame that never says it's done)
const TYPE_KEEP_MS = 700;
const typing = { tab: null, holds: 0, until: 0, log: [] };

const typingElsewhere = (tabId) => typing.tab !== null && typing.tab !== tabId && Date.now() < typing.until;

async function takeTyping(tabId) {
  const end = Date.now() + 20000;
  while (typingElsewhere(tabId) && Date.now() < end) await new Promise((r) => setTimeout(r, 40));
  if (typing.tab !== tabId) typing.holds = 0; // (the turn comes to this tab)
  Object.assign(typing, { tab: tabId, holds: typing.holds + 1, until: Date.now() + TYPE_HOLD_MS });
  typing.log = [...typing.log.slice(-49), { tab: tabId, from: Date.now(), to: null }]; // (for tests: who typed when)
}

function doneTyping(tabId, { all = false } = {}) {
  if (typing.tab !== tabId) return;
  typing.holds = all ? 0 : Math.max(0, typing.holds - 1);
  const open = typing.log.find((x) => x.tab === tabId && x.to === null);
  if (open) open.to = Date.now();
  if (all) for (const x of typing.log) if (x.tab === tabId && x.to === null) x.to = Date.now();
  // (Still typing in another of its frames: the turn stays, as long as they keep going.)
  typing.until = all ? 0 : Date.now() + (typing.holds ? TYPE_HOLD_MS : TYPE_KEEP_MS);
}

// --- the store login monitor -----------------------------------------------------
// Whether you're signed in at each store (logins.js): seen on the store's pages as you open them,
// and checked every 10 minutes for the stores whose pages say so. Your account shows it on the
// dashboard (Extension tab) so you can sign in before a drop: signed in, ⚡ Buy's checkout is faster.
const LOGINS = 'logins';
const LOGIN_CHECK_MS = 10 * 60 * 1000;
let loginReport = null;

async function noteLogin(store, status, how) {
  const { [LOGINS]: all = {} } = await chrome.storage.local.get(LOGINS);
  const before = all[store];
  all[store] = { status, at: Date.now(), how };
  await chrome.storage.local.set({ [LOGINS]: all });
  // Your account hears about it in a moment (a change: straight away), all stores at once.
  clearTimeout(loginReport);
  loginReport = setTimeout(() => reportLogins().catch(() => null), before && before.status === status ? 4000 : 200);
}

async function reportLogins() {
  const { [LOGINS]: all = {} } = await chrome.storage.local.get(LOGINS);
  if (Object.keys(all).length) await api('POST', '/api/ext/logins', { logins: all });
}

/** Every 10 minutes (force: now): the stores whose pages say whether you're signed in, read with your cookies. */
async function checkLogins({ force = false } = {}) {
  if (!(await getAuth())) return 0;
  const { loginsCheckedAt = 0 } = await chrome.storage.local.get('loginsCheckedAt');
  if (!force && Date.now() - loginsCheckedAt < LOGIN_CHECK_MS) return 0;
  await chrome.storage.local.set({ loginsCheckedAt: Date.now() });
  const st = await getState();
  // (Not at a store whose queue is up here: a request there could cost your place in line.)
  const held = await heldStores();
  let n = 0;
  for (const r of st.flows || []) {
    const check = r.account && r.account.check;
    // (Not a store whose pages can only be read on the screen: Shop's.)
    if (!check || check.fetch === false || check.onScreen || !r.base || held.has(r.id)) continue;
    try {
      const res = await fetch(`${r.base}${check.path || ''}`, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
      const status = globalThis.MGBLogins.fromHtml((await res.text()).slice(0, 3000000), res.url, check);
      if (status) { await noteLogin(r.id, status, 'check'); n += 1; }
    } catch { /* the store didn't answer: try again next time */ }
  }
  return n;
}
globalThis.mugibotCheckLogins = (opts) => checkLogins(opts);

function ensureAlarm() {
  chrome.storage.local.get('retired').then(({ retired }) => {
    if (retired && !FROM_STORE) return;
    chrome.alarms.get(CHECK_ALARM, (a) => { if (!a) chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.1 }); });
  });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();
sweepLoop().catch(() => null);
acoLoop().catch(() => null);
heldUpTick().catch(() => null);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== CHECK_ALARM) return;
  runChecks().catch(() => null);
  sweepWatch().catch(() => null);
  acoLoop().catch(() => null);
  releaseTurns().catch(() => null); // (a checkout waiting for you that's had its few minutes)
  if (!heldTimer) heldUpTick().catch(() => null); // (a Shop checkout link's tab held up in the store's queue)
  checkLogins().catch(() => null);
  updateInfo().catch(() => null); // keeps the "NEW" badge on the toolbar icon up to date
});

// --- ⚡ Buy: is the store's Add button ready? ------------------------------------
/**
 * Runs in the store's page: has the page's own code wired up the Add button (marked
 * data-mgb-add by the store-page script)? Pages built with React (Kmart's) or Vue show the
 * button before their code has started, and a press then does nothing. Read only: it
 * looks at the button and the page, and changes nothing. framework: null = can't tell.
 */
function addButtonReady() {
  const el = document.querySelector('[data-mgb-add]');
  if (!el) return null;
  const HANDLERS = ['onClick', 'onClickCapture', 'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp', 'onTouchEnd', 'onSubmit'];
  let react = false;
  for (let n = el, i = 0; n && n !== document.documentElement && i < 12; n = n.parentElement, i += 1) {
    for (const k of Object.keys(n)) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
        if (n === el) return { ready: true, framework: 'react' }; // React has taken the button over
        react = true;
      } else if (k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$')) {
        const props = n[k] || {};
        if (HANDLERS.some((h) => typeof props[h] === 'function')) return { ready: true, framework: 'react' };
      } else if (k === '_vei' || k === '__vue__' || k === '__vueParentComponent') {
        return { ready: true, framework: 'vue' };
      }
    }
    if (typeof n.onclick === 'function') return { ready: true, framework: 'plain' };
  }
  const $ = window.jQuery;
  if ($ && typeof $._data === 'function') {
    for (let n = el, i = 0; n && i < 12; n = n.parentElement, i += 1) {
      const ev = $._data(n, 'events');
      if (ev && (ev.click || ev.submit)) return { ready: true, framework: 'jquery' };
    }
  }
  // A React or Vue page whose code hasn't taken the button over yet.
  if (react || window.__NEXT_DATA__ || window.__next_f || document.querySelector('[data-reactroot], script[src*="/_next/"]')) return { ready: false, framework: 'react' };
  if (window.__NUXT__ || document.querySelector('[data-server-rendered], [data-v-app]')) return { ready: false, framework: 'vue' };
  return { ready: false, framework: null };
}

// --- messages ---------------------------------------------------------------
const fromApp = (sender) => {
  try { return !!sender.tab && sender.frameId === 0 && APP_ORIGINS.has(new URL(sender.url).origin); } catch { return false; }
};
// The popup and Settings page (Settings opens in a tab, so check the page's address, not the tab).
const fromExtensionPage = (sender) => sender.id === chrome.runtime.id && String(sender.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== 'object' || sender.id !== chrome.runtime.id) return null;
    if (sender.tab && sender.frameId === 0) tabSeen.set(sender.tab.id, Date.now());
    switch (msg.type) {
      // From store pages
      case 'state': {
        // The extension's own window for live sweeps: no panel, no checkout there.
        if (sender.tab && (await isSweepTab(sender.tab.id))) return { items: [], flows: [], sweepTab: true };
        // A tab emptying your bag there (Clear cart): what it's for.
        const clear = sender.tab && sender.frameId === 0 ? await clearJobOf(sender.tab.id) : null;
        if (clear) { clearAsked.add(clear.id); return { ...(await getState()), clear }; }
        return getState();
      }
      case 'event': {
        await api('POST', '/api/ext/events', msg.event);
        return { ok: true };
      }
      case 'login': {
        // The store page you have open: signed in there or not (logins.js).
        if (!sender.tab || sender.frameId !== 0 || !['in', 'out'].includes(msg.status) || typeof msg.store !== 'string') return null;
        if (await isSweepTab(sender.tab.id)) return null;
        await noteLogin(msg.store.slice(0, 40), msg.status, msg.how === 'screen' ? 'screen' : 'page');
        return { ok: true };
      }
      case 'checkLogins': {
        // The dashboard's "Check now" (Extension tab): look again now (at most once a minute) and tell the account.
        if (!fromApp(sender)) return null;
        const { loginsCheckedAt = 0 } = await chrome.storage.local.get('loginsCheckedAt');
        const checked = Date.now() - loginsCheckedAt < 60 * 1000 ? 0 : await checkLogins({ force: true });
        clearTimeout(loginReport);
        await reportLogins().catch(() => null);
        return { ok: true, checked };
      }
      case 'logins': {
        // The popup: what this browser knows.
        if (!fromExtensionPage(sender)) return null;
        const { [LOGINS]: all = {} } = await chrome.storage.local.get(LOGINS);
        const st = await getState();
        return { logins: all, stores: (st.flows || []).filter((r) => r.account).map((r) => ({ id: r.id, name: r.name, signIn: `${r.base}${r.account.signIn || ''}` })) };
      }
      case 'claim': {
        // A ⚡ Buy code: confirm it once, then allow checkout autofill in this tab.
        const auth = await getAuth();
        if (!auth || !sender.tab) return null;
        // Only on a store's page (one with a flow): a link that went somewhere else — a Shop checkout link
        // sent on to the store's own guest checkout — leaves its code unused. (The flows this browser has,
        // read here, never fetched: nothing waits on them.)
        const { [`state:${auth.user.id}`]: known } = await chrome.storage.local.get(`state:${auth.user.id}`);
        if (known && Array.isArray(known.flows) && known.flows.length && !storeOfUrl(known.flows, sender.url || sender.tab.url)) return { ok: false, status: 0, elsewhere: true };
        const res = await api('POST', '/api/ext/claim', { code: msg.code });
        if (res.status === 200 && res.body && res.body.ok) {
          // (An Auto-checkout run's code: the run's limits ride on this tab's pass, never on the page.)
          await savePass(sender.tab.id, res.body.host === tabHost(sender) ? res.body.host : tabHost(sender), auth.user.id, res.body.profileId, res.body.aco || null);
          profileFor(res.body.profileId || '').catch(() => null); // for checkout, in a moment
          // In the line for this store (one checkout at a time there: turns, above).
          const r = await storeForTab(sender);
          if (r) await joinTurn(sender.tab.id, r.id, { runId: res.body.aco ? res.body.aco.runId : null, name: res.body.name || '', own: !!r.cartLinks });
          return res.body;
        }
        return { ok: false, status: res.status, error: res.body && res.body.error };
      }
      case 'probe': {
        // Has the store page's own code wired up the Add button yet? (Looked at inside the page.)
        if (!sender.tab) return null;
        try {
          const [r] = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] }, world: 'MAIN', func: addButtonReady });
          return (r && r.result) || null;
        } catch {
          return null;
        }
      }
      case 'startFill': {
        // You pressed the panel's button (a real click): allow autofill for this tab's store — and, with
        // Auto-checkout set to "Place the order for me", a run for the product, placing the order within
        // your limits (your account says; otherwise it stops at the final button for you).
        const auth = await getAuth();
        if (!auth || !sender.tab) return null;
        let aco = null;
        // (Pressed again in the same tab: the run it started before, never pressed, is over — not left going.)
        const before = await passFor(sender);
        if (before && before.aco && before.aco.runId && !before.aco.done && !before.aco.placing) {
          // (Ended first, so a checkout of the same item can start a run of its own.)
          await api('POST', `/api/ext/aco/${encodeURIComponent(before.aco.runId)}`, { status: 'failed', reason: 'stopped', message: 'Started again from the store panel' }).catch(() => null);
        }
        if (msg.product && typeof msg.product === 'object') {
          const res = await api('POST', '/api/ext/aco/own', { product: msg.product }).catch(() => null);
          if (res && res.status === 200 && res.body && res.body.aco) aco = res.body.aco;
        }
        await savePass(sender.tab.id, tabHost(sender), auth.user.id, null, aco);
        return { ok: true, aco };
      }
      case 'fillData': return fillData(sender, msg.part, typeof msg.profileId === 'string' ? msg.profileId : null);
      case 'nap': {
        // A store page's wait, timed here (content.js nap): Chrome holds a hidden page's own timers back — to once
        // a minute after 5 minutes — and a checkout pressing "Pay now" for hours mustn't slow to that.
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(5000, Number(msg.ms) || 0))));
        return { ok: true };
      }
      case 'gate': {
        // A store page: is it the store's queue (or checkpoint)? Tracked per tab — see noteGate.
        if (!sender.tab || sender.frameId !== 0 || typeof msg.store !== 'string') return null;
        if (await isSweepTab(sender.tab.id)) return null;
        const r = await storeForTab(sender);
        if (!r || r.id !== msg.store || !r.gate) return null;
        const wait = Number.isFinite(msg.wait) ? Math.max(0, Math.min(1440, Math.round(msg.wait))) : null;
        return noteGate(sender.tab.id, r.id, !!msg.on, { kind: r.gate.kind, wait });
      }
      case 'gateWait': {
        // Waiting in the store's queue (or at its checkpoint) with a checkout going: its pass stays good meanwhile.
        if (!sender.tab) return null;
        const pass = await passFor(sender);
        if (!pass) return { ok: false };
        await chrome.storage.session.set({ [passKey(sender.tab.id)]: { ...pass, expires: Date.now() + PASS_TTL } });
        return { ok: true };
      }
      case 'acoReport': {
        // How the Auto-checkout run in this tab is going (only the tab the run's code opened: its page,
        // or the store's checkout running in a frame on it).
        if (!sender.tab) return null;
        const pass = sender.frameId === 0 ? await passFor(sender) : ((await checkoutFrame(sender)) || {}).pass;
        if (!pass || !pass.aco || !pass.aco.runId) return null;
        let status = String(msg.status || '');
        const run = { ...pass.aco };
        // Stopped after the final button was pressed (in this page or its checkout frame): the order may have gone
        // through — for you to check, and counted in the day's limits; never "nothing was bought".
        if (status === 'failed' && msg.reason === 'stopped' && run.placing) {
          status = 'needs_you';
          msg = { ...msg, status, message: 'You stopped it after the final button was pressed — check your email for an order confirmation before buying it again.' };
        }
        if (status === 'not_live') {
          // The store said it isn't on sale to the final button: nothing was bought, so the run presses it
          // again in a moment (content.js pressLoop), every couple of seconds until it takes the order — the
          // half hour for a store that's struggling counted afresh from the next press (placingAt). Your
          // account hears so the first time (it tells you), then from each press (acoRetry, live).
          const live = run.notLive || { since: Date.now(), saidAt: 0 };
          const say = !live.saidAt;
          const next = { ...run, placing: false, placingAt: null, away: null, notLive: { since: live.since, saidAt: say ? Date.now() : live.saidAt } };
          await chrome.storage.session.set({ [passKey(sender.tab.id)]: { ...pass, aco: next, expires: Date.now() + PASS_TTL } });
          const { [LIVE_TABS]: liveTabs = {} } = await chrome.storage.session.get(LIVE_TABS);
          if (liveTabs[sender.tab.id] !== run.runId) {
            await chrome.storage.session.set({ [LIVE_TABS]: { ...liveTabs, [sender.tab.id]: run.runId } });
            if (!heldTimer) heldTimer = setTimeout(() => { heldUpTick().catch(() => null); }, 15 * 1000);
          }
          if (!say) return { ok: true, since: live.since, presses: run.presses || 0 };
          const res = await api('POST', `/api/ext/aco/${encodeURIComponent(run.runId)}`, { status: 'waiting', reason: 'not_live', message: String(msg.message || '').slice(0, 300), total: typeof msg.total === 'number' ? msg.total : null });
          // (Stopped meanwhile — from the dashboard, or over on your account's side: this tab's run ends here.)
          const over = res.status === 200 && !!(res.body && res.body.run && res.body.run.active === false);
          if (over) await chrome.storage.session.set({ [passKey(sender.tab.id)]: { ...pass, aco: { ...next, done: true } } });
          return { ok: res.status === 200, since: live.since, presses: run.presses || 0, over, text: over ? String(res.body.run.message || '') : '' };
        }
        if (status === 'beat') {
          // A slow checkout (a hot drop) saying how it's going: your account hears it — that keeps the run going
          // there — and this tab's pass is kept good while it's at it. (Read afresh: only its time is changed.)
          const key = passKey(sender.tab.id);
          const cur = (await chrome.storage.session.get(key))[key];
          if (cur && cur.aco && cur.aco.runId === run.runId) await chrome.storage.session.set({ [key]: { ...cur, expires: Date.now() + PASS_TTL } });
          // (Not on sale yet, between presses: still waiting for the sale, as far as your account's concerned.)
          const body = run.notLive && !run.placing ? { status: 'waiting', reason: 'not_live' } : { status: run.placing ? 'placing' : 'checkout' };
          // (quiet: a page only watching on for the order after the press — its pass kept good, nothing said.)
          if (!run.done && !run.stopped && !msg.quiet) api('POST', `/api/ext/aco/${encodeURIComponent(run.runId)}`, { ...body, message: String(msg.message || '').slice(0, 300) }).catch(() => null);
          return { ok: true };
        }
        if (status === 'checkout') {
          if (run.atCheckout) return { ok: true }; // (said once, however many pages the checkout has)
          run.atCheckout = true;
        }
        // Kept on the tab's pass: when the final button was first pressed (it's pressed again only while the
        // store's struggling, for 30 minutes: acoRetry), and a run that's over (stopped short, for you to
        // finish) never presses anything again.
        if (status === 'placing') { run.placing = true; run.placingAt = run.placingAt || Date.now(); }
        if (['ready', 'needs_you', 'failed'].includes(status) && !run.placing) run.done = true;
        if (status === 'placed') run.done = true; // (never pressed again)
        if (['needs_you', 'failed'].includes(status) && run.placing) run.stopped = true;
        await chrome.storage.session.set({ [passKey(sender.tab.id)]: { ...pass, aco: run } });
        // The store's next checkout: on its way once this one's order is placed or it's stopped, or (waiting
        // for you) in a few minutes. (Stopped before anything went into the bag: straight away.)
        if (status === 'placed' || status === 'failed' || (status === 'needs_you' && NOTHING_ADDED.has(String(msg.reason || '')))) turnEnded(sender.tab.id).catch(() => null);
        else if (status === 'ready' || status === 'needs_you') turnEnded(sender.tab.id, { parked: true }).catch(() => null);
        // (pressed: the final button was pressed in this run — said with how it ended, in case its "placing" is still on its way.)
        const post = () => api('POST', `/api/ext/aco/${encodeURIComponent(run.runId)}`, {
          status, reason: String(msg.reason || ''), message: String(msg.message || '').slice(0, 300),
          total: typeof msg.total === 'number' ? msg.total : null, pressed: !!run.placing,
        });
        // At checkout, and pressing the final button: the page carries on at once — what matters (the final
        // button pressed at most once) is on the tab's pass already — and your account hears a moment later.
        // (A checkout never waits on Mugibot's server.)
        if (status === 'checkout' || status === 'placing') {
          post().catch(() => null);
          return { ok: true };
        }
        const res = await post();
        // Over on your account's side (finished on your phone instead, while this tab waited at the
        // checkpoint): this tab's run stops here — it never carries on to the final button.
        const over = res.status === 200 && !!(res.body && res.body.run && res.body.run.active === false) && (status === 'waiting' || status === 'started');
        if (over) await chrome.storage.session.set({ [passKey(sender.tab.id)]: { ...pass, aco: { ...run, done: true } } });
        return res.status === 200 ? { ok: true, over, text: over ? String(res.body.run.message || '') : '' } : { ok: false, status: res.status };
      }
      case 'bankMark': {
        // The final button's being pressed in this tab: every frame on the checkout notes what's in it now (its
        // frames, what it says), so that what the press brings up in any of them — a payment provider's — is seen
        // as new (bankFrames). Frames the extension may not open (the bank's own) are seen from the one they're in.
        if (!sender.tab) return null;
        await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, allFrames: true }, func: () => { if (window.top !== window && typeof MGBChecks !== 'undefined') MGBChecks.markPressed(document); } }).catch(() => null);
        return { ok: true };
      }
      case 'bankFrames': {
        // After the final button: the bank's check in any frame on the checkout — inside a payment provider's
        // frame, or one in that — as each frame sees it (MGBChecks.bankShown). The first found, or null. Only for
        // a tab whose run has pressed it.
        if (!sender.tab) return null;
        const pass = sender.frameId === 0 ? await passFor(sender) : ((await checkoutFrame(sender)) || {}).pass;
        if (!pass || !pass.aco || !pass.aco.placing) return null;
        const res = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, allFrames: true }, func: () => (window.top === window || typeof MGBChecks === 'undefined' ? null : MGBChecks.bankShown(document)) }).catch(() => []);
        return (res || []).map((r) => r && r.result).find(Boolean) || null;
      }
      case 'acoGoing': {
        // After the final button, the store's sending the checkout on to another site (content.js watchAway): where,
        // for what your account's told if it's still there in a few seconds (bankAway).
        if (!sender.tab || sender.frameId !== 0) return null;
        const pass = await passFor(sender);
        if (!pass || !pass.aco || !pass.aco.placing) return null;
        await chrome.storage.session.set({ [passKey(sender.tab.id)]: { ...pass, aco: { ...pass.aco, awayHost: String(msg.host || '').slice(0, 120) }, expires: awayExpiry(pass.aco) } });
        bankAwaySoon(sender.tab.id);
        return { ok: true };
      }
      case 'acoRetry': {
        // The final button, about to be pressed (again): may it be? Only in a run that's placing the order,
        // hasn't been stopped or ended, and is within the 30 minutes since it was first pressed. Counted, and
        // said to your account ("placing": the arming's used up). The first press goes at once (your account
        // hears as it's pressed); pressing again waits for your account to say the run's still going — a
        // run it has closed meanwhile (stopped, timed out) is never pressed again.
        if (!sender.tab) return null;
        const pass = sender.frameId === 0 ? await passFor(sender) : ((await checkoutFrame(sender)) || {}).pass;
        if (!pass || !pass.aco || !pass.aco.runId || pass.aco.done || pass.aco.stopped || pass.aco.mode !== 'place') return { ok: false };
        const run = { ...pass.aco };
        const now = Date.now();
        if (run.placingAt && now - run.placingAt > RETRY_MS) return { ok: false, over: true, since: run.placingAt };
        const body = { status: 'placing', message: String(msg.message || '').slice(0, 300), total: typeof msg.total === 'number' ? msg.total : null };
        const key = passKey(sender.tab.id);
        if (run.presses) {
          // (msg.live: pressed again on a checkout that says it isn't on sale yet — your account keeps the run
          //  waiting for the sale, the press counted on it.)
          const res = await api('POST', `/api/ext/aco/${encodeURIComponent(run.runId)}`, { ...body, again: true, live: !!msg.live }).catch(() => null);
          const live = res && res.status === 200 && res.body && res.body.run;
          const going = live && live.active !== false && (live.status === 'placing' || (!!msg.live && live.status === 'waiting' && live.reason === 'not_live'));
          // (Read afresh after the wait: stopped meanwhile — the panel's Stop — or another run in the tab, it isn't pressed.)
          const cur = (await chrome.storage.session.get(key))[key];
          if (!going || !cur || !cur.aco || cur.aco.runId !== run.runId || cur.aco.stopped || cur.aco.done) {
            if (cur && cur.aco && cur.aco.runId === run.runId) await chrome.storage.session.set({ [key]: { ...cur, aco: { ...cur.aco, done: true } } });
            return { ok: false, ended: true };
          }
        } else {
          api('POST', `/api/ext/aco/${encodeURIComponent(run.runId)}`, body).catch(() => null);
        }
        // (Only its press count and times changed — on the pass as it is now.)
        const cur = (await chrome.storage.session.get(key))[key] || pass;
        // (Pressing on Shop's checkout: not held up in the store's queue — heldUp — whatever it last looked like.)
        // (page: the checkout it was pressed on — whose store's it is, should the tab go somewhere Mugibot can't see: bankAway.)
        // (pressAt: this press — a pop-up window the checkout opens is its: bankWindow.)
        const next = { ...(cur.aco || run), presses: (run.presses || 0) + 1, placing: true, placingAt: run.placingAt || now, pressAt: now, away: null, page: run.page || sender.tab.url || '' };
        await chrome.storage.session.set({ [key]: { ...cur, aco: next, expires: now + PASS_TTL } });
        return { ok: true, n: next.presses, since: next.placingAt };
      }
      case 'acoOthers': {
        // Other things in the store's bag already: the run goes on (they're bought too), and says so.
        if (!sender.tab) return null;
        const pass = await passFor(sender);
        if (!pass || !pass.aco || !pass.aco.runId) return null;
        const n = Math.max(1, Math.min(99, Number(msg.n) || 1));
        await chrome.storage.session.set({ [passKey(sender.tab.id)]: { ...pass, aco: { ...pass.aco, others: n } } });
        api('POST', `/api/ext/aco/${encodeURIComponent(pass.aco.runId)}`, { status: 'note', reason: 'others', message: String(msg.message || '').slice(0, 300) }).catch(() => null);
        return { ok: true };
      }
      case 'denied': {
        // A store page in this browser was its bot protection's "Access Denied": nothing more asked of that store from here for a while.
        if (!sender.tab || typeof msg.store !== 'string') return null;
        const r = await storeForTab(sender);
        if (!r || r.id !== msg.store) return null;
        await markDenied(r.id);
        return { ok: true };
      }
      case 'acoInfo': {
        // The store page: is this tab running an Auto-checkout run (and how far has it got)?
        if (!sender.tab) return null;
        const pass = sender.frameId === 0 ? await passFor(sender) : ((await checkoutFrame(sender)) || {}).pass;
        // (Back on Shop's checkout from the store's queue: no longer held up — it carries on here.)
        if (pass && pass.aco && pass.aco.away && sender.frameId === 0) await chrome.storage.session.set({ [passKey(sender.tab.id)]: { ...pass, aco: { ...pass.aco, away: null } } });
        return pass && pass.aco && !pass.aco.done ? pass.aco : null;
      }
      case 'queueReturn': {
        // A page with no ⚡ Buy code: a Shop checkout link's tab through the store's queue at last (the code it
        // opened with left behind there)? A fresh code for its run, to carry on with here.
        if (!sender.tab || sender.frameId !== 0) return null;
        const { [HELD_UP]: held = {} } = await chrome.storage.session.get(HELD_UP);
        const h = held[sender.tab.id];
        if (!h || h.kind !== 'entry') return null;
        const res = await api('POST', `/api/ext/aco/${encodeURIComponent(h.runId)}/link`, {}).catch(() => null);
        const m = res && res.status === 200 && res.body && String(res.body.url || '').match(/mgb-go=([A-Za-z0-9_-]{8,64})/);
        return m ? { code: m[1], runId: h.runId } : null;
      }
      case 'acoAway': {
        // Shop's checkout went on to the store's own site while it said "not available for purchase" (its queue,
        // reset at the drop): nothing was bought — held up there (above), and carried on once it's back.
        if (!sender.tab || sender.frameId !== 0) return null;
        const pass = await passFor(sender);
        if (!pass || !pass.aco || !pass.aco.runId || pass.aco.done || pass.aco.stopped || pass.aco.mode !== 'place') return { ok: false };
        await chrome.storage.session.set({ [passKey(sender.tab.id)]: { ...pass, aco: awayAco(pass.aco), expires: Date.now() + PASS_TTL } });
        await holdUp(sender.tab.id, pass.aco.runId, 'away');
        return { ok: true };
      }
      case 'cardFrame': {
        // A payment frame: how many card boxes it found, and how many it filled.
        if (!sender.tab || !sender.frameId) return null;
        let host = '';
        try { host = new URL(sender.url).host; } catch { /* keep empty */ }
        // (done: every box there's something saved for has kept it — or been given up on.)
        // (saved: no boxes, a card the provider already has for you — Stripe's Link.)
        await chrome.storage.session.set({ [frameKey(sender.tab.id, sender.frameId)]: { host, seen: Number(msg.seen) || 0, filled: Number(msg.filled) || 0, done: !!msg.done, saved: !!msg.saved, detail: String(msg.detail || '').slice(0, 300), at: Date.now() } });
        return { ok: true };
      }
      case 'cardFrames':
        if (!sender.tab) return null;
        return sender.frameId === 0 || (await checkoutFrame(sender)) ? cardFrames(sender.tab.id) : null;
      case 'frameRole': {
        // A frame on a store page: is it the store's whole checkout (checkout.frames)? Then it gets
        // that store's checkout flow, and runs it there (frame.js). false: no, and no need to ask again.
        if (!sender.tab || !sender.frameId) return null;
        const r = await storeForTab(sender);
        if (!r || !(r.flow && r.flow.checkout && (r.flow.checkout.frames || []).length)) return false;
        const hit = await checkoutFrame(sender);
        if (!hit) return (r.flow.checkout.frames || []).map(rx).some((re) => re && re.test(String(sender.url || ''))) ? null : false;
        return { checkout: true, store: r.name, flow: r.flow.checkout };
      }
      case 'frameStatus': {
        // How a checkout running in a frame is going, for the panel on the page above it.
        if (!sender.tab || !(await checkoutFrame(sender))) return null;
        chrome.tabs.sendMessage(sender.tab.id, { type: 'frameStatus', text: String(msg.text || '').slice(0, 300) }, { frameId: 0 }, () => void chrome.runtime.lastError);
        return { ok: true };
      }
      case 'focusTab': {
        // A card box needs real typing, and the browser window isn't in front: bring this checkout's
        // tab forward (once — only for a tab with a checkout you started).
        if (!sender.tab) return null;
        const pass = (await chrome.storage.session.get(passKey(sender.tab.id)))[passKey(sender.tab.id)];
        if (!pass || Date.now() > pass.expires || tabHost(sender) !== pass.host) return null;
        await chrome.tabs.update(sender.tab.id, { active: true }).catch(() => null);
        await chrome.windows.update(sender.tab.windowId, { focused: true }).catch(() => null);
        return { ok: true };
      }
      case 'storeCopy':
        // From this copy's own scripts on a store page or the dashboard: is the Chrome Web Store copy there too?
        await setRetired(!!msg.present);
        return { ok: true };
      case 'endFill':
        if (sender.tab) {
          await chrome.storage.session.remove(passKey(sender.tab.id));
          await clearCardFrames(sender.tab.id);
          await turnEnded(sender.tab.id, { gone: true });
        }
        return { ok: true };
      case 'clearSayYes': {
        // A tab emptying your bag (Clear cart): the page's own "Are you sure?" boxes answer yes there.
        if (!sender.tab || sender.frameId !== 0 || !(await clearJobOf(sender.tab.id))) return null;
        await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, frameIds: [0] }, world: 'MAIN', func: sayYes }).catch(() => null);
        return { ok: true };
      }
      case 'clearReport': {
        // How emptying the bag in this tab is going (bag.js): on the way (to your account), or done.
        if (!sender.tab || sender.frameId !== 0) return null;
        const job = await clearJobOf(sender.tab.id);
        if (!job || job.id !== msg.id) return null;
        const status = ['clearing', 'cleared', 'empty', 'failed'].includes(msg.status) ? msg.status : 'failed';
        const removed = Math.max(0, Math.min(500, Math.round(Number(msg.removed) || 0)));
        const message = String(msg.message || '').slice(0, 300);
        if (status === 'clearing') { tellClear(job, status, removed, message).catch(() => null); return { ok: true }; }
        // (A bag it couldn't empty stays open in its tab, for you to see what's left.)
        const res = { status, removed, message, keepTab: status === 'failed' && msg.keep !== false };
        const waiting = clearWaits.get(job.id);
        if (waiting) waiting(res);
        else {
          // (This worker started again since it opened the tab: said here, and the tab done with.)
          await setClearTab(sender.tab.id, null);
          await tellClear(job, status, removed, message).catch(() => null);
          await withTurns((t) => { delete t[`c:${job.id}`]; });
          if (!res.keepTab) chrome.tabs.remove(sender.tab.id).catch(() => null);
        }
        return { ok: true };
      }
      case 'turn': {
        // A store page with a checkout to start: is it its turn at this store? (Another of yours there first: no.)
        if (!sender.tab || sender.frameId !== 0) return null;
        const r = await storeForTab(sender);
        if (!r) return { go: true };
        const key = `t:${sender.tab.id}`;
        const mine = ((await chrome.storage.session.get(TURNS))[TURNS] || {})[key];
        if (!mine || mine.store !== r.id || !holds(mine)) await joinTurn(sender.tab.id, r.id, { name: typeof msg.name === 'string' ? msg.name.slice(0, 120) : '', own: !!r.cartLinks });
        await releaseTurns(); // (closed tabs and finished checkouts forgotten first)
        const a = ahead((await chrome.storage.session.get(TURNS))[TURNS] || {}, key);
        return a ? { go: false, name: a.name || '', store: r.name, clearing: !!a.clear } : { go: true };
      }
      case 'turnEnd':
        // This tab's checkout stopped (you pressed Stop, or it couldn't go on), or it's at the final button for you (parked).
        if (sender.tab) await turnEnded(sender.tab.id, { parked: !!msg.parked });
        return { ok: true };
      case 'sleep': {
        // A store page or frame in a tab in the background: its own timers run at most about once a second
        // there, so its checkout's short waits are timed here instead (this worker's run at full speed).
        const ms = Math.max(0, Math.min(1000, Number(msg.ms) || 0));
        await new Promise((r) => setTimeout(r, ms));
        return { ok: true };
      }
      case 'typeTurn': {
        // A payment frame about to type a card box: its tab's turn (one tab at a time), in front.
        if (!sender.tab) return null;
        const pass = (await chrome.storage.session.get(passKey(sender.tab.id)))[passKey(sender.tab.id)];
        if (!pass || Date.now() > pass.expires || tabHost(sender) !== pass.host) return { ok: false };
        await takeTyping(sender.tab.id);
        const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
        if (tab && !tab.active) {
          await chrome.tabs.update(tab.id, { active: true }).catch(() => null);
          await new Promise((r) => setTimeout(r, 150)); // (the page comes forward)
        }
        return { ok: true };
      }
      case 'typeDone':
        if (sender.tab) doneTyping(sender.tab.id);
        return { ok: true };

      // From your Mugibot dashboard (bridge.js) or the extension's own pages
      case 'appHello': {
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        const auth = await getAuth();
        // deviceId: which of your connected browsers this is (the dashboard's checkout browser picker).
        return { version: VERSION, server: SERVER, fromStore: FROM_STORE, paired: !!auth, userId: auth ? auth.user.id : null, username: auth ? auth.user.username : null, deviceId: auth && auth.device ? auth.device.id : null };
      }
      case 'pair':
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        return pair(String(msg.code || ''));
      case 'cardStatus': {
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        const auth = await getAuth();
        return auth ? { userId: auth.user.id, card: await Vault.status(auth.user.id) } : null;
      }
      case 'cardKey': {
        // The dashboard's restore key for this browser (bridge.js): your card's copy for updates made under it —
        // or, with no card here (a new install), your card back from it. off: switched off — the keys forgotten.
        if (!fromApp(sender)) return null;
        const auth = await getAuth();
        if (!auth) return { ok: false, paired: false };
        if (msg.off) {
          await chrome.storage.local.remove([restoreKeysKey(auth.user.id), restoreMadeKey(auth.user.id)]);
          return { ok: true, off: true };
        }
        return useCardKey(auth, msg.key, { has: msg.has, host: msg.host });
      }
      case 'openCardSettings':
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      case 'checkNow':
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        sweepLoop().catch(() => null);
        acoLoop().catch(() => null);
        return runChecks();
      case 'acoListen': {
        // The dashboard: Auto-checkout was switched on, an item armed or a test run started — listen now (not at the next alarm).
        if (!fromApp(sender) && !fromExtensionPage(sender)) return null;
        const auth = await getAuth();
        if (auth) await refreshState(auth);
        acoLoop().catch(() => null);
        const st = await getState();
        return { ok: true, listening: acoLooping, aco: st.aco || null, version: VERSION };
      }

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
          if (msg.action === 'save') {
            const saved = await Vault.save(auth.user.id, msg.card);
            cardState = null;
            // Backed up too (locked with the card passphrase): the backup in your account is the new card.
            let backupError = null;
            if (msg.passphrase) await backupCard(auth, msg.passphrase).catch((e) => { backupError = e.message; });
            // …and its copies for updates (under the dashboard's keys this browser has) are of the new card.
            await refreshRestoreCopies(auth).catch(() => null);
            return { status: saved, backup: await cardBackupInfo(), backupError };
          }
          if (msg.action === 'upgrade') { cardState = null; const up = await Vault.upgrade(auth.user.id, msg.passphrase); await refreshRestoreCopies(auth).catch(() => null); return { status: up }; }
          if (msg.action === 'remove') {
            await Vault.remove(auth.user.id);
            cardState = null;
            // Removed on purpose: no copy is kept for updates either (or it would come back by itself).
            const gone = await api('DELETE', '/api/ext/card-restore');
            await chrome.storage.local.remove(restoreMadeKey(auth.user.id));
            return { status: await Vault.status(auth.user.id), backup: await cardBackupInfo(), restoreError: gone.status === 200 ? null : `Couldn't reach ${CONFIG.appName} to delete the copy kept for updates — delete it on the dashboard (Setup → Delivery & card)` };
          }
          if (msg.action === 'backup') { await backupCard(auth, msg.passphrase); return { status: await Vault.status(auth.user.id), backup: await cardBackupInfo() }; }
          if (msg.action === 'restore') {
            const r = await api('GET', '/api/ext/card-backup');
            if (r.status !== 200) throw new Error((r.body && r.body.error) || `Can't reach ${CONFIG.appName}`);
            const restored = await Vault.unlock(auth.user.id, r.body.backup, msg.passphrase);
            cardState = null;
            await refreshRestoreCopies(auth).catch(() => null);
            return { status: restored, backup: await cardBackupInfo() };
          }
          if (msg.action === 'unbackup') {
            const r = await api('DELETE', '/api/ext/card-backup');
            if (r.status !== 200) throw new Error((r.body && r.body.error) || `Can't reach ${CONFIG.appName}`);
            return { status: await Vault.status(auth.user.id), backup: null };
          }
          return { status: await Vault.status(auth.user.id), backup: await cardBackupInfo() };
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
  // (A tab emptying a bag, closed before it was done.)
  clearJobOf(tabId).then((job) => {
    const waiting = job && clearWaits.get(job.id);
    if (waiting) waiting({ status: 'failed', removed: 0, message: 'Its tab was closed before the bag was empty' });
  }).catch(() => null);
  chrome.storage.session.remove(passKey(tabId));
  clearCardFrames(tabId).catch(() => null);
  doneTyping(tabId, { all: true });
  turnEnded(tabId, { gone: true }).catch(() => null); // (the store's next checkout goes)
  // (A tab closed while in a queue: out of line — not through. Runs that were waiting for it go their own way:
  // each opens the store, and waits in line itself.)
  withGates((g) => {
    const orphaned = [];
    for (const [store, s] of Object.entries(g)) {
      if (!s.line || !s.line[tabId]) continue;
      delete s.line[tabId];
      if (!inLine(s) && (s.runs || []).length) orphaned.push(store);
    }
    return orphaned;
  }).then((stores) => { for (const store of stores || []) releaseRuns(store).catch(() => null); }).catch(() => null);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) turnMoved(tabId, info.url).catch(() => null);
  if (info.status === 'complete') bankAwaySoon(tabId);
});

// A window the checkout opened itself after the final button (its own window.open, not Mugibot's): the bank's
// check in a window of its own, most likely — still open a few seconds on (one that closes by itself passed by
// itself), and your account's told at once, as for a page. Its checkout: the tab Chrome names as its opener (a tab)
// — or, a pop-up window (Chrome names no opener for those), the checkout whose final button was pressed last, in
// the 2 minutes before it opened (never a tab or window you open yourself: those aren't pop-ups). (Chrome blocks a
// pop-up a checkout opens without a person's click unless pop-ups are allowed for that store: docs/AUTO-CHECKOUT.md.)
chrome.tabs.onCreated.addListener((tab) => {
  const at = Date.now();
  setTimeout(() => { bankWindow(tab, at).catch(() => null); }, BANK_AWAY_MS);
});

async function bankWindow(tab, at) {
  let openerId = tab.openerTabId;
  if (openerId == null) {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (!win || win.type !== 'popup') return;
    const all = await chrome.storage.session.get(null);
    const last = Object.entries(all)
      .filter(([k, v]) => k.startsWith('fill:') && v && v.aco && v.aco.placing && v.aco.pressAt && v.aco.pressAt <= at && at - v.aco.pressAt < 2 * 60 * 1000)
      .sort((a, b) => b[1].aco.pressAt - a[1].aco.pressAt)[0];
    if (!last) return;
    openerId = Number(last[0].slice('fill:'.length));
  }
  const key = passKey(openerId);
  const pass = (await chrome.storage.session.get(key))[key];
  const run = pass && pass.aco;
  if (!run || !run.runId || !run.placing || run.done || run.stopped || !run.placingAt || Date.now() - run.placingAt > RETRY_MS) return;
  if (!(await chrome.tabs.get(tab.id).catch(() => null))) return;
  const r = storeOfUrl((await getState()).flows, run.page || `https://${pass.host}/`);
  const name = (r && r.name) || 'The store';
  await chrome.storage.session.set({ [key]: { ...pass, aco: { ...run, stopped: true }, expires: awayExpiry(run) } });
  turnEnded(openerId, { parked: true }).catch(() => null);
  await api('POST', `/api/ext/aco/${encodeURIComponent(run.runId)}`, {
    status: 'needs_you', reason: 'bank_check', pressed: true, total: null,
    message: `After paying, ${name}'s checkout opened a window of its own — most likely your bank wanting you to approve it: approve it in your bank's app (or with the code it sent you), or in that window. It's marked placed once ${name} confirms the order.`.slice(0, 300),
  }).catch(() => null);
}

// --- after the final button: the checkout gone on to a site Mugibot can't see ----------------------
// A store that sends the checkout to its bank's check — the whole tab, not a frame on its page (straight from
// "Pay", or by way of its own server) — goes somewhere Mugibot doesn't run, so nothing on the page can say so.
// Looked at a few seconds after each page in a tab that's placing an order finishes loading: on a site this
// extension can't open (not a store, nor a payment provider's), still within the half hour of the press, and
// your account's told at once — most likely it's your bank wanting you to approve the payment (a check that
// passed by itself has come back to the store by then). Once: the run's for you then, and the store's
// confirmation page — when the tab gets there — says "placed" as ever. (Shop checkout links go on to the
// store's own order page by design: theirs say how it went before they leave — content.js watchLeaving.)
const BANK_AWAY_MS = 5000;
const awayTimers = new Map();
// (Its pass kept good meanwhile — no page of the store's is there to keep it so — for the confirmation page,
//  however long the approving takes within the half hour.)
const awayExpiry = (run) => Math.max(Date.now() + PASS_TTL, ((run && run.placingAt) || Date.now()) + RETRY_MS + 5 * 60 * 1000);
function bankAwaySoon(tabId) {
  clearTimeout(awayTimers.get(tabId));
  awayTimers.set(tabId, setTimeout(() => { awayTimers.delete(tabId); bankAway(tabId).catch(() => null); }, BANK_AWAY_MS));
}

async function bankAway(tabId) {
  const key = passKey(tabId);
  const pass = (await chrome.storage.session.get(key))[key];
  const run = pass && pass.aco;
  if (!run || !run.runId || !run.placing || run.done || run.stopped || !run.placingAt || Date.now() - run.placingAt > 30 * 60 * 1000) return;
  const r = storeOfUrl((await getState()).flows, run.page || `https://${pass.host}/`);
  if (r && r.flow && r.flow.checkout && r.flow.checkout.leaves) return;
  // (A page this extension may open — the store's, a payment provider's: that page says how it's going. Still
  //  loading: its own "complete" looks again. Looked at twice, a moment apart: a page on its way out isn't one.)
  const here = async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status !== 'complete') return true;
    return chrome.scripting.executeScript({ target: { tabId }, func: () => location.host }).then(() => true, () => false);
  };
  if (await here()) return;
  await new Promise((res) => setTimeout(res, 1500));
  if (await here()) return;
  const cur = (await chrome.storage.session.get(key))[key];
  if (!cur || !cur.aco || cur.aco.runId !== run.runId || cur.aco.done || cur.aco.stopped) return;
  const name = (r && r.name) || 'The store';
  await chrome.storage.session.set({ [key]: { ...cur, aco: { ...cur.aco, stopped: true }, expires: awayExpiry(cur.aco) } });
  turnEnded(tabId, { parked: true }).catch(() => null);
  await api('POST', `/api/ext/aco/${encodeURIComponent(run.runId)}`, {
    status: 'needs_you', reason: 'bank_check', pressed: true, total: null,
    message: `After paying, ${name} sent the checkout on to ${run.awayHost || "a page Mugibot can't see"} — most likely your bank wanting you to approve it: approve it in your bank's app (or with the code it sent you), or in the checkout tab. It's marked placed once ${name} confirms the order.`.slice(0, 300),
  }).catch(() => null);
}

// For tests and the "Check now" button.
globalThis.mugibotGates = async () => ({ gates: await gatesNow(), held: [...(await heldStores())], through: await throughStores() });
globalThis.mugibotRunChecks = runChecks;
globalThis.mugibotSweepLoop = sweepLoop;
globalThis.mugibotAcoLoop = acoLoop;
globalThis.mugibotTurns = async () => (await chrome.storage.session.get(TURNS))[TURNS] || {};
globalThis.mugibotTyping = () => typing.log;
globalThis.mugibotClears = async () => ({ queue: clearQueue.map((j) => j.id), clearing: clearing && clearing.id, tabs: (await chrome.storage.session.get(CLEARS))[CLEARS] || {} });
