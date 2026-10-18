// The dashboard. Everything here is the signed-in member's own data.
import { $, $$, ApiError, ago, api, busy, h, initThemeToggle, money, renderPager, setMsg, toast, when } from './common.js';
import { setupDrops } from './drops.js';
import { setupMonitor } from './monitor.js';

const STATUS = {
  in_stock: 'In stock', preorder: 'Pre-order open', out_of_stock: 'Sold out', coming_soon: 'Coming soon', not_listed: 'Not listed yet',
  not_found: 'Page gone', blocked: 'Blocked by site', error: 'Error', unknown: 'Unknown', pending: 'Checking soon', paused: 'Paused',
};
const FLOW = { verified: 'verified flow', beta: 'beta flow', draft: 'draft flow', none: 'alerts only' };

const state = { me: null, items: [], retailers: [], profiles: null, editing: null, ext: null, alerts: null, logins: null, aco: null, wPage: 1, feedPage: 1, feedTotal: 0, runsPage: 1, cardBackup: null };

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const TABS = ['monitor', 'monitor-settings', 'monitor-log', 'checkout', 'aco', 'discord', 'extension', 'membership', 'account'];
// The Monitor's own pages (Settings and Check log are for admins): the sidebar's Monitor stays lit.
const MONITOR_PAGES = new Set(['monitor', 'monitor-settings', 'monitor-log']);
// The lists on the Monitor page (tracked products, your watchlist, your drop watches, your activity).
// #watch and #activity — the old tabs, still in links and DMs — and #drops open the Monitor page at that list.
const LISTS = ['tracked', 'watch', 'drops', 'activity'];
const LIST_HASH = { watch: 'watch', drops: 'drops', activity: 'activity' };
const LIST_KEY = 'mgb-list';
const loaders = {};

function showTab() {
  const [hash, productId] = location.hash.slice(1).split('/');
  // #update (from the extension's Update button) is the Extension tab's update steps;
  // #monitor/<product> (from a Discord alert's Price history button) opens that product.
  if (LIST_HASH[hash]) state.list = LIST_HASH[hash];
  const tab = hash === 'update' ? 'extension' : LIST_HASH[hash] ? 'monitor' : TABS.includes(hash) ? hash : 'monitor';
  if (tab === 'monitor' && $$('.side a.active')[0]?.dataset.tab === 'monitor' && productId) {
    monitorUI.openProduct(productId);
    return;
  }
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  document.body.classList.toggle('wide-main', MONITOR_PAGES.has(tab)); // the monitor uses the full width
  $$('.side a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab || (a.dataset.tab === 'monitor' && MONITOR_PAGES.has(tab))));
  $$('.mon-tabs a').forEach((a) => { a.classList.toggle('active', a.dataset.mtab === tab); if (a.dataset.mtab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (loaders[tab]) {
    loaders[tab]().then(() => {
      if (hash === 'update') $('#ext-update').scrollIntoView({ block: 'start' });
      if (tab === 'monitor' && productId) monitorUI.openProduct(productId);
    }).catch(showError);
  }
}
window.addEventListener('hashchange', showTab);

// The tracked products (and the admins' drop watches' finds) know which are on your watchlist (☆ Watch adds one).
const onWatchlist = (p) => state.items.find((it) => it.store === p.store && String(it.sku).toLowerCase() === String(p.sku).toLowerCase()) || null;
const monitorUI = setupMonitor({
  showError: (e) => showError(e),
  watching: onWatchlist,
  watch: (p) => watchProduct(p),
});
// 🎯 Drop watches: anything outside the card keywords (drops.js).
const dropsUI = setupDrops({
  isAdmin: () => !!state.me && state.me.user.role === 'admin',
  watching: onWatchlist,
  watch: (p) => watchProduct(p),
  buyUrl: (p) => `/buy?${new URLSearchParams(Object.entries({ store: p.store, sku: p.sku, url: p.url, name: p.name }).filter(([, v]) => v))}`,
});

// --- The lists on the Monitor page --------------------------------------------
function savedList() {
  try { const v = localStorage.getItem(LIST_KEY); return LISTS.includes(v) ? v : null; } catch { return null; }
}

/** Show one of the Monitor page's lists. Members start at Tracked products; before a membership, your watchlist. */
async function showList(name, { load = true } = {}) {
  const member = state.me.entitlement.active;
  // (No choice yet: what the monitor tracks — or, before a membership, your watchlist.)
  let list = LISTS.includes(name) ? name : savedList() || (member ? 'tracked' : 'watch');
  if ((list === 'tracked' || list === 'drops') && !member) list = 'watch';
  state.list = list;
  for (const b of $$('.mon-ptab')) {
    const on = b.dataset.ptab === list;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }
  for (const p of $$('.mon-ppanel')) p.hidden = p.dataset.ppanel !== list;
  $('#w-add-toggle').hidden = list !== 'watch';
  if (!load) return;
  if (list === 'watch') await loadWatch();
  else if (list === 'drops') await dropsUI.load();
  else if (list === 'activity') await loadFeed(state.feedPage);
}
const listOpen = (name) => !$('[data-panel="monitor"]').hidden && state.list === name;
for (const b of $$('.mon-ptab')) {
  b.addEventListener('click', () => {
    try { localStorage.setItem(LIST_KEY, b.dataset.ptab); } catch { /* private window */ }
    // (The address follows, so a reload comes back here — without loading the page again.)
    history.replaceState(null, '', b.dataset.ptab === 'tracked' ? '#monitor' : `#${b.dataset.ptab}`);
    showList(b.dataset.ptab).catch(showError);
  });
}
$('.mon-ptabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tabs = $$('.mon-ptab').filter((b) => !b.hidden);
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next.focus();
  next.click();
});

loaders.monitor = async () => {
  // Your watchlist first: the tracked products show which ones are on it.
  await Promise.all([loadItems(), loadRetailers()]);
  $('#pt-tracked').hidden = !state.me.entitlement.active;
  $('#pt-drops').hidden = !state.me.entitlement.active;
  await Promise.all([monitorUI.load(), showList(state.list)]);
};
loaders['monitor-settings'] = () => monitorUI.loadSettings();
loaders['monitor-log'] = () => monitorUI.loadChecks();
initThemeToggle($('#theme-toggle'));

function showError(e) {
  if (e instanceof ApiError && e.status === 401) return;
  toast('Something went wrong', e.message, 'warn');
}

// ---------------------------------------------------------------------------
// Account, membership and the banner
// ---------------------------------------------------------------------------
async function loadMe() {
  state.me = await api('GET', '/api/me');
  const { user, entitlement: ent, app } = state.me;
  $('#who').textContent = user.username;
  $('#admin-link').hidden = user.role !== 'admin';
  $('#plan-pill').textContent = ent.label;
  $('#plan-pill').className = `pill ${ent.active ? (ent.warning ? 'warn' : 'ok') : 'err'}`;
  $('#w-interval').textContent = app.monitorIntervalSeconds;
  $('#b-interval').textContent = app.browserIntervalSeconds;
  $('#acct-username').value = user.username;
  $('#pw-username').value = user.username;
  $('#acct-email').value = user.email || '';
  $('#acct-name').value = user.name || '';
  $('#w-demo').hidden = !app.demo;
  $('#w-announce-wrap').hidden = user.role !== 'admin';
  renderBanner();
}

function renderBanner() {
  const { entitlement: ent, app } = state.me;
  const b = $('#banner');
  b.textContent = '';
  const q = new URLSearchParams(location.search);
  if (q.get('membership') === 'success') b.append(h('div', { class: 'notice ok' }, 'Thanks for joining! It can take a few seconds for your membership to show up here.'));
  const discordMsg = {
    linked: ['ok', 'Discord connected.'],
    linked_with_problem: ['warn', 'Discord connected, but the bot couldn\'t finish adding you to the server — see below.'],
    cancelled: ['warn', 'Discord connection cancelled.'],
    expired: ['warn', 'That Discord connection link expired — press Connect Discord again.'],
    not_configured: ['warn', 'Discord isn\'t set up on this server yet.'],
    failed: ['err', `Couldn't connect Discord: ${q.get('reason') || 'please try again'}`],
  }[q.get('discord')];
  if (discordMsg) b.append(h('div', { class: `notice ${discordMsg[0]}` }, discordMsg[1]));
  if (!ent.active) {
    b.append(h('div', { class: 'notice err' }, h('b', {}, `${ent.label}. `),
      app.whop.configured || app.whop.link ? `Start your membership (${app.price}) to switch on monitoring, Discord pings and ⚡ Buy. Your watchlist and details are kept.` : 'Ask an admin for access to switch on monitoring, Discord pings and ⚡ Buy.',
      ' ', app.whop.configured || app.whop.link ? h('a', { href: '#membership', class: 'btn small primary' }, 'Become a member') : null));
  } else if (ent.warning) {
    b.append(h('div', { class: 'notice warn' }, ent.label, ' ', h('a', { href: '#membership' }, 'Membership')));
  } else if (ent.plan === 'trial' && ent.trialEndsAt && ent.trialEndsAt - Date.now() < 3 * 86400000) {
    b.append(h('div', { class: 'notice warn' }, `${ent.label}. `, h('a', { href: '#membership' }, 'Become a member'), ' so ⚡ Buy keeps working on drop day.'));
  }
}

// Checkpoints and virtual queues up now (server/monitor/gates.js): what to do before the drop.
async function loadGates() {
  state.gates = (await api('GET', '/api/gates').catch(() => ({ gates: [] }))).gates || [];
  renderGates();
}

function renderGates() {
  const box = $('#gates-banner');
  box.textContent = '';
  for (const g of (state.gates || []).filter((x) => x.status === 'up')) {
    const queue = g.kind === 'queue';
    const wait = queue && typeof g.wait === 'number' ? ` — about ${g.wait} min` : '';
    box.append(h('div', { class: 'notice warn gate-notice', 'data-store': g.store },
      h('b', {}, queue ? `🚦 ${g.name}'s virtual queue is up${wait}. ` : `🛡️ ${g.name}'s checkpoint is up. `),
      queue
        ? 'Get in line in your browser and leave the queue page alone: it refreshes itself, and refreshing it yourself can lose your place. ⚡ Buy and Auto-checkout wait in line, then carry on. '
        : 'Solve it once in your browser before the drop: ⚡ Buy and Auto-checkout stop there for you, then carry on to checkout. ',
      h('a', { href: g.url, target: '_blank', rel: 'noopener', class: 'btn small' }, `Open ${g.name}`)));
  }
}

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => null);
  location.href = '/';
});

// ---------------------------------------------------------------------------
// The browser extension on this computer
// ---------------------------------------------------------------------------
function askExtension(type, extra = {}, timeout = 1500) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const onMsg = (e) => {
      if (e.source !== window || e.origin !== location.origin || !e.data || e.data.source !== 'mugibot-ext' || e.data.id !== id) return;
      window.removeEventListener('message', onMsg);
      resolve(e.data.reply);
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ source: 'mugibot-app', type, id, ...extra }, location.origin);
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, timeout);
  });
}

async function detectExtension() {
  const version = document.documentElement.dataset.mugibotExtension || null;
  if (!version) return { installed: false };
  const hello = await askExtension('hello');
  return {
    installed: true, version, paired: !!(hello && hello.paired), userId: hello && hello.userId, username: hello && hello.username, deviceId: (hello && hello.deviceId) || null,
    fromStore: !!(hello && hello.fromStore),
    // A downloaded copy still installed next to the Chrome Web Store copy (it stays out of the way).
    oldCopy: document.documentElement.dataset.mugibotOldCopy || null,
  };
}

async function renderExtStatus() {
  state.ext = await detectExtension();
  const ext = state.ext;
  const me = state.me.user;
  const latest = state.me.app.extensionVersion;
  let level = 'warn';
  let text;
  if (!ext.installed) {
    // A connected extension that talks to another of the site's addresses was downloaded
    // before the site moved: it can't see this page, so it looks like it isn't installed.
    const { devices } = await api('GET', '/api/devices').catch(() => ({ devices: [] }));
    const recent = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const old = devices.find((d) => d.host && d.host !== state.me.app.host && d.host !== location.host && d.lastSeenAt > recent);
    text = old
      ? [h('b', {}, `Your extension (${old.name}${old.version ? `, v${old.version}` : ''}) was downloaded for ${old.host}, so it can't work with this page. `), h('a', { href: '#update' }, 'Download it again from here')]
      : [h('b', {}, "The extension isn't in this browser. "), '⚡ Buy will open the product, but nothing will be added automatically. ', h('a', { href: '#extension' }, 'Install it')];
  } else if (!ext.paired) {
    text = [h('b', {}, 'The extension is installed but not connected. '), h('button', { class: 'btn small primary', type: 'button' }, 'Connect this browser')];
  } else if (ext.userId !== me.id) {
    level = 'err';
    text = [h('b', {}, `This browser's extension is connected to another account (${ext.username}). `), 'Reconnect it to yours: ', h('button', { class: 'btn small primary', type: 'button' }, 'Connect to my account')];
  } else {
    level = 'ok';
    const store = state.me.app.chromeStoreUrl;
    text = [h('b', {}, '✓ Extension connected. '), `⚡ Buy runs automatically in this browser. Version ${ext.version}${ext.fromStore ? ', from the Chrome Web Store (it updates itself)' : ''}.`];
    if (!ext.fromStore && store) {
      level = 'warn';
      text.push(' ', h('b', {}, 'This copy was downloaded, so it won\'t update itself. '), h('a', { href: store, target: '_blank', rel: 'noopener' }, 'Get it from the Chrome Web Store'), ' once, then remove this one (', h('a', { href: '#update' }, 'how'), ').');
    } else if (ext.oldCopy) {
      level = 'warn';
      text.push(' ', h('b', {}, 'The old downloaded copy is still installed. '), 'Click its icon (it shows OLD) → Remove this copy.');
    } else if (ext.version !== latest) {
      if (ext.fromStore) text.push(` Version ${latest} is on its way: Chrome installs it by itself within a few hours.`);
      else {
        level = 'warn';
        text.push(' ', h('b', {}, `Version ${latest} is available — `), h('a', { href: '#update' }, 'update it'));
      }
    }
  }
  for (const id of ['#ext-status', '#ext-status-2']) {
    const el = $(id);
    el.className = `notice ${level}`;
    el.textContent = '';
    el.append(...text.map((t) => (t instanceof Node ? t.cloneNode(true) : t)));
    $$('button', el).forEach((b) => b.addEventListener('click', pairNow));
  }
}

async function pairNow() {
  const msg = $('#pair-msg');
  if (!document.documentElement.dataset.mugibotExtension) {
    setMsg(msg, 'Install the extension first, then reload this page.');
    location.hash = '#extension';
    return;
  }
  try {
    const { code } = await api('POST', '/api/devices/pair-code');
    const reply = await askExtension('pair', { code }, 10000);
    if (reply && reply.ok) {
      toast('Extension connected', `This browser is now connected to ${reply.user.username}.`, 'success');
      setMsg(msg, 'Connected!', true);
    } else {
      setMsg(msg, (reply && reply.error) || "The extension didn't answer — reload this page and try again.");
    }
  } catch (e) {
    setMsg(msg, e.message);
  }
  await renderExtStatus();
  loadDevices().catch(() => null);
}
$('#pair-now').addEventListener('click', pairNow);

$('#pair-code-btn').addEventListener('click', async () => {
  const r = await api('POST', '/api/devices/pair-code');
  $('#pair-code').textContent = r.code;
  $('#pair-expiry').textContent = `Works once, until ${new Date(r.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  $('#pair-code-box').hidden = false;
});

async function loadDevices() {
  const { devices } = await api('GET', '/api/devices');
  const list = $('#devices');
  list.textContent = '';
  if (!devices.length) list.append(h('li', { class: 'empty' }, 'No browsers connected yet.'));
  for (const d of devices) {
    list.append(h('li', {},
      h('div', { class: 'info' }, h('div', { class: 'name' }, d.name), h('div', { class: 'meta' }, `Connected ${when(d.createdAt)} · last used ${ago(d.lastSeenAt)}${d.version ? ` · v${d.version}` : ''}`)),
      h('div', { class: 'acts' }, h('button', {
        class: 'btn small danger', type: 'button',
        onclick: async () => {
          if (!confirm(`Disconnect ${d.name}? It will stop working until you connect it again.`)) return;
          await api('DELETE', `/api/devices/${d.id}`);
          loadDevices();
        },
      }, 'Disconnect'))));
  }
}

// --- The store login monitor: where this account's browsers are signed in ----------------
const LOGIN_TEXT = { in: 'Signed in', out: 'Signed out', unknown: "Couldn't tell" };

async function loadLogins() {
  state.logins = await api('GET', '/api/logins');
  return state.logins;
}

// Signed out first (the ones to fix), then the stores not seen yet, then the ones you're signed in at.
// Stores on your watchlist go first in each group.
function renderLogins() {
  const d = state.logins;
  const list = $('#logins');
  if (!d || !list) return;
  list.textContent = '';
  const watched = new Set(state.items.map((it) => it.store));
  const rank = (s) => ({ out: 0, unknown: 1, in: 3 }[s.status] ?? 2) * 2 + (watched.has(s.id) ? 0 : 1);
  const stores = [...d.stores].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const ins = stores.filter((s) => s.status === 'in').length;
  const outs = stores.filter((s) => s.status === 'out');
  $('#logins-sum').textContent = !d.browsers ? 'Connect the extension (step 2) and this shows where you\'re signed in.'
    : `Signed in at ${ins} of ${stores.length} stores.${outs.length ? ` Signed out at ${outs.map((s) => s.name).join(', ')}.` : ''}`;
  for (const s of stores) {
    const seen = s.at ? `${LOGIN_TEXT[s.status] || 'Seen'} · ${s.how === 'check' ? 'checked' : 'seen'} ${ago(s.at)}${d.browsers > 1 && s.device ? ` in ${s.device}` : ''}`
      : s.checked ? 'Not checked yet' : 'Not seen yet: open the store once';
    list.append(h('li', { class: `login ${s.status || 'none'}`, dataset: { store: s.id } },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('div', { class: 'info' },
        h('div', { class: 'name' }, s.name, watched.has(s.id) ? h('span', { class: 'pill info', title: 'On your watchlist' }, 'watching') : null),
        h('div', { class: 'meta', title: seen }, seen)),
      s.status === 'in' ? null : h('a', { class: `btn small${s.status === 'out' ? ' primary' : ''}`, href: s.signInUrl, target: '_blank', rel: 'noopener' }, 'Sign in ↗')));
  }
}

$('#logins-check').addEventListener('click', async (e) => {
  const msg = $('#logins-msg');
  if (!state.ext || !state.ext.paired) { setMsg(msg, 'Install the extension and connect it (steps 1 and 2) first.'); return; }
  await busy($('#logins-card'), async () => {
    setMsg(msg, 'Checking…', true);
    const reply = await askExtension('checkLogins', {}, 30000);
    if (!reply || !reply.ok) { setMsg(msg, 'The extension didn\'t answer: reload this page and try again (it needs version 1.9.0 or newer).'); return; }
    await loadLogins();
    renderLogins();
    setMsg(msg, reply.checked ? `Checked ${reply.checked} store${reply.checked === 1 ? '' : 's'}. The others show once you open them.` : 'Up to date (checked in the last minute). The others show once you open them.', true);
  });
});

async function loadRetailers() {
  if (!state.retailers.length) state.retailers = (await api('GET', '/api/retailers')).retailers;
  return state.retailers;
}

async function loadAlerts() {
  state.alerts = (await api('GET', '/api/alerts')).alerts;
  return state.alerts;
}

loaders.extension = async () => {
  // With a Chrome Web Store listing: that copy first (it updates itself), the download folded away.
  const store = state.me.app.chromeStoreUrl;
  $('#store-install').hidden = !store;
  $('#zip-install-summary').hidden = !store;
  $('#zip-install-box').open = !store;
  $('#update-store').hidden = !store;
  $('#update-zip').hidden = !!store;
  if (store) { $('#store-link').href = store; $('#update-store-link').href = store; }
  const [retailers, alerts] = await Promise.all([loadRetailers(), loadAlerts(), renderExtStatus(), loadDevices(), loadLogins(), state.items.length ? null : loadItems()]);
  renderLogins();
  $('#b-checks').checked = alerts.browserChecks;
  const list = $('#stores');
  list.textContent = '';
  for (const r of retailers) {
    list.append(h('li', {},
      h('div', { class: 'info' }, h('div', { class: 'name' }, r.name), h('div', { class: 'meta' }, r.flowNote || '')),
      h('span', { class: `pill flow-${r.flowStatus}` }, FLOW[r.flowStatus] || r.flowStatus)));
  }
};

$('#b-checks').addEventListener('change', async (e) => {
  try {
    await api('PUT', '/api/alerts', { browserChecks: e.target.checked });
    setMsg($('#b-msg'), e.target.checked ? 'On.' : 'Off — only server checks now.', true);
  } catch (err) {
    setMsg($('#b-msg'), err.message);
  }
});
$('#b-check-now').addEventListener('click', async () => {
  if (!state.ext || !state.ext.paired) { setMsg($('#b-msg'), 'Connect the extension in this browser first.'); return; }
  setMsg($('#b-msg'), 'Checking…', true);
  const r = await askExtension('checkNow', {}, 60000);
  setMsg($('#b-msg'), r && typeof r.checked === 'number' ? `Checked ${r.checked} SKU${r.checked === 1 ? '' : 's'}${r.blocked ? ` (${r.blocked} blocked by the store)` : ''}.` : 'Nothing needed checking right now.', true);
});

// ---------------------------------------------------------------------------
// 🔔 Watchlist
// ---------------------------------------------------------------------------
function statusOf(it) {
  return it.monitor ? it.status : 'paused';
}

function itemRow(it, i) {
  const st = statusOf(it);
  // (Another website: no ⚡ Buy — Mugibot checks out at the stores it knows. Its page is the way in.)
  const buy = it.acoCan ? h('button', { class: 'btn primary small', type: 'button', disabled: !it.url, title: it.url ? '' : 'The product page hasn\'t been found yet' }, '⚡ Buy') : null;
  // The one-time ⚡ Buy code is asked for as the button goes down, so the store opens the moment it's clicked.
  buy?.addEventListener('pointerdown', () => primeBuy(it));
  buy?.addEventListener('click', () => goBuy(it));
  const move = async (dir) => {
    const ids = state.items.map((x) => x.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const r = await api('POST', '/api/items/reorder', { ids });
    state.items = r.items;
    renderItems();
  };
  const price = it.lastPrice ?? it.price;
  const checked = it.checkedAt ? `checked ${ago(it.checkedAt)}${it.statusSource === 'browser' ? ' by your browser' : ''}` : '';
  // (Another website's product goes by its address: its made-up code isn't one anyone uses.)
  const meta = [it.storeName, it.acoCan ? `SKU ${it.sku}` : '', money(price), it.maxPrice != null ? `ping at ≤ ${money(it.maxPrice)}` : '', checked].filter(Boolean).join(' · ');
  const isAdmin = state.me.user.role === 'admin';
  return h('li', { class: it.monitor ? '' : 'off', dataset: { id: it.id } },
    h('div', { class: 'info' },
      h('div', { class: 'name' }, `${i + 1}. ${it.name}`, it.announce ? h('span', { class: 'pill info', title: 'Restocks are posted in the members\' Discord channel' }, '📣') : null,
        it.aco ? h('a', { class: 'pill aco-pill', href: '#aco', title: 'Bought by itself when it drops (Auto-checkout)' }, '🤖 Armed') : null,
        it.dropWatch ? h('a', { class: 'pill info', href: '#drops', title: 'Found by one of your drop watches (it goes when the watch does)' }, '🎯') : null),
      h('div', { class: 'meta' }, meta, ' ', h('span', { class: `flow flow-${it.flowStatus}` }, FLOW[it.flowStatus] || '')),
      it.error ? h('div', { class: 'meta warn-text' }, it.error) : null,
      !it.url ? h('div', { class: 'meta' }, 'Waiting for the product page to be listed — it\'s found automatically from the SKU.') : null),
    h('span', { class: `pill ${st}` }, STATUS[st] || st),
    h('div', { class: 'acts' },
      buy,
      it.url ? h('a', { class: 'btn small', href: it.url, target: '_blank', rel: 'noopener' }, 'Open ↗') : null,
      h('button', { class: 'btn small', type: 'button', title: 'Check now', 'aria-label': `Check ${it.name} now`, onclick: () => checkNow(it) }, '↻'),
      h('button', { class: 'btn small', type: 'button', title: 'Move up', 'aria-label': 'Move up', onclick: () => move(-1) }, '↑'),
      h('button', { class: 'btn small', type: 'button', title: 'Move down', 'aria-label': 'Move down', onclick: () => move(1) }, '↓'),
      h('button', { class: 'btn small', type: 'button', onclick: () => editItem(it) }, 'Edit'),
      h('button', { class: 'btn small', type: 'button', onclick: async () => { await api('PUT', `/api/items/${it.id}`, { monitor: !it.monitor }); loadItems(); } }, it.monitor ? 'Pause' : 'Resume'),
      isAdmin ? h('button', { class: 'btn small', type: 'button', title: 'Announce restocks in the members\' Discord channel', onclick: async () => { await api('PUT', `/api/items/${it.id}`, { announce: !it.announce }); loadItems(); } }, it.announce ? 'Stop announcing' : '📣 Announce') : null,
      h('button', {
        class: 'btn small danger', type: 'button', 'aria-label': `Delete ${it.name}`,
        onclick: async () => { if (confirm(`Stop watching ${it.name}?`)) { await api('DELETE', `/api/items/${it.id}`); loadItems(); } },
      }, '✕')));
}

// Your watchlist: 10 to a page (the page kept while things change).
const W_PAGE_SIZE = 10;
function renderItems() {
  const list = $('#w-list');
  list.textContent = '';
  $('#w-count').textContent = state.items.length ? String(state.items.length) : '';
  const pages = Math.max(1, Math.ceil(state.items.length / W_PAGE_SIZE));
  state.wPage = Math.min(Math.max(1, state.wPage || 1), pages);
  renderPager($('#w-pager'), { page: state.wPage, size: W_PAGE_SIZE, total: state.items.length, label: 'Watchlist', onPage: (p) => { state.wPage = p; renderItems(); } });
  if (state.itemsInactive) list.append(h('li', { class: 'notice warn' }, 'Monitoring is paused while your account has no active membership.'));
  if (!state.items.length) list.append(h('li', { class: 'empty' }, 'Nothing on your watchlist yet — press "+ Add SKU", or ☆ Watch a product in Tracked products.'));
  // Signed out at a store you're watching: ⚡ Buy is faster signed in.
  const out = state.logins ? state.logins.stores.filter((s) => s.status === 'out' && state.items.some((it) => it.store === s.id)) : [];
  // A store that only sells to signed-in customers (Amazon): ⚡ Buy and Auto-checkout can't buy there signed out.
  const must = out.filter((s) => s.required);
  if (must.length) {
    list.prepend(h('li', { class: 'notice err login-nudge login-required' },
      h('span', {}, h('b', {}, `Sign in at ${must.map((s) => s.name).join(', ')} to buy there. `), `${must.length === 1 ? 'It only sells' : 'They only sell'} to signed-in customers (no guest checkout): ⚡ Buy and Auto-checkout can't buy there while you're signed out in this browser.`),
      h('span', { class: 'acts' }, ...must.slice(0, 3).map((s) => h('a', { class: 'btn small primary', href: s.signInUrl, target: '_blank', rel: 'noopener' }, `Sign in at ${s.name} ↗`)))));
  }
  const faster = out.filter((s) => !s.required);
  if (faster.length) {
    list.prepend(h('li', { class: 'notice warn login-nudge' },
      h('span', {}, h('b', {}, `You're signed out at ${faster.map((s) => s.name).join(', ')}. `), 'Sign in so ⚡ Buy\'s checkout is faster (the store fills in your saved details).'),
      h('span', { class: 'acts' }, ...faster.slice(0, 3).map((s) => h('a', { class: 'btn small', href: s.signInUrl, target: '_blank', rel: 'noopener' }, `${s.name} ↗`)))));
  }
  const from = (state.wPage - 1) * W_PAGE_SIZE;
  state.items.slice(from, from + W_PAGE_SIZE).forEach((it, i) => list.append(itemRow(it, from + i)));
}

async function loadItems() {
  const r = await api('GET', '/api/items');
  state.items = r.items;
  state.itemsInactive = !r.active;
  renderItems();
  monitorUI.refreshWatched();
}

/** ☆ Watch on a tracked product: it goes on your watchlist (its own page checks and DMs). */
async function watchProduct(p) {
  try {
    await api('POST', '/api/items', p.url ? { url: p.url, sku: p.sku, name: p.name || p.sku } : { store: p.store, sku: p.sku, name: p.name || p.sku });
    await loadItems();
    toast('On your watchlist', p.name || p.sku, 'success');
  } catch (e) {
    if (e.status === 402) { toast('Membership needed', e.message, 'warn'); return; }
    toast("Couldn't add it", e.message, 'warn');
  }
}

async function checkNow(it) {
  try {
    await api('POST', `/api/items/${it.id}/check`);
    if (state.ext && state.ext.paired) askExtension('checkNow', {}, 60000);
    toast('Checking now', it.name);
  } catch (e) { showError(e); }
}

// ⚡ Buy codes asked for ahead of the click (each works once, for a while).
const primed = new Map();

function primeBuy(it) {
  const hit = primed.get(it.id);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit;
  const entry = { at: Date.now(), result: null };
  entry.promise = api('POST', `/api/items/${it.id}/go`, {});
  entry.promise.then((r) => { entry.result = r; }, () => { if (primed.get(it.id) === entry) primed.delete(it.id); });
  primed.set(it.id, entry);
  return entry;
}

async function goBuy(it) {
  const entry = primeBuy(it);
  primed.delete(it.id); // this code is used now
  const warn = () => {
    if (!state.ext || !state.ext.paired) toast('Opened the product', "The extension isn't connected in this browser, so it won't take you to checkout automatically.", 'warn');
    // (A store that only sells to signed-in customers, where this browser was last seen signed out.)
    const l = state.logins && state.logins.stores.find((x) => x.id === it.store);
    if (l && l.required && l.status === 'out') toast(`Sign in at ${l.name} first`, `${l.name} only sells to signed-in customers — sign in there in this browser, then ⚡ Buy again.`, 'warn', 9000);
  };
  // The code is here already: open the store straight away.
  if (entry.result) {
    if (!window.open(entry.result.url, '_blank', 'noopener')) location.href = entry.result.url;
    warn();
    return;
  }
  // Open the tab straight away (browsers block pop-ups opened after a delay), then send it on.
  const win = window.open('about:blank', '_blank');
  try {
    const r = await entry.promise;
    if (win) {
      win.opener = null;
      win.location.href = r.url;
    } else {
      location.href = r.url;
    }
    warn();
  } catch (e) {
    if (win) win.close();
    if (e.status === 402) {
      toast('Membership needed', e.message, 'warn');
      location.hash = '#membership';
    } else showError(e);
  }
}

function fillStoreSelect() {
  const sel = $('#w-store');
  sel.textContent = '';
  sel.append(h('option', { value: '' }, '— from the link —'));
  for (const r of state.retailers) sel.append(h('option', { value: r.id }, `${r.name}${r.flowStatus === 'verified' ? '' : ` (${r.flowStatus})`}`));
}

function fillProfileSelect(selected) {
  const sel = $('#w-profile');
  sel.textContent = '';
  const { profiles, defaultId } = state.profiles;
  sel.append(h('option', { value: '' }, `Default (${(profiles.find((p) => p.id === defaultId) || profiles[0]).label})`));
  for (const p of profiles) sel.append(h('option', { value: p.id, selected: p.id === selected }, p.label));
}

function storeNote() {
  const r = state.retailers.find((x) => x.id === $('#w-store').value);
  $('#w-store-note').textContent = r ? `${r.skuLabel || 'SKU'}: ${r.skuHint || ''}${r.searchable ? '' : ' — paste the product link for this store.'}` : '';
}
$('#w-store').addEventListener('change', storeNote);

async function editItem(it) {
  await Promise.all([loadRetailers(), loadProfiles()]);
  fillStoreSelect();
  fillProfileSelect(it ? it.profileId : '');
  state.editing = it ? it.id : null;
  $('#w-form').hidden = false;
  $('#w-form-title').textContent = it ? `Edit ${it.name}` : 'Add a SKU';
  $('#w-save').textContent = it ? 'Save changes' : 'Add SKU';
  $('#w-url').value = it ? it.url : '';
  $('#w-store').value = it && !it.url ? it.store : '';
  $('#w-sku').value = it ? it.sku : '';
  $('#w-name').value = it ? it.name : '';
  $('#w-price').value = it && typeof it.price === 'number' ? it.price : '';
  $('#w-max').value = it && typeof it.maxPrice === 'number' ? it.maxPrice : '';
  $('#w-announce').checked = !!(it && it.announce);
  $('#w-aco').checked = !!(it && it.aco);
  storeNote();
  setMsg($('#w-msg'), '');
  $('#w-url').focus();
}

$('#w-add-toggle').addEventListener('click', () => editItem(null));
$('#w-cancel').addEventListener('click', () => { $('#w-form').hidden = true; state.editing = null; });
$('#w-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    const body = {
      url: $('#w-url').value, store: $('#w-store').value, sku: $('#w-sku').value, name: $('#w-name').value,
      price: $('#w-price').value, maxPrice: $('#w-max').value, profileId: $('#w-profile').value, aco: $('#w-aco').checked,
    };
    if (state.me.user.role === 'admin') body.announce = $('#w-announce').checked;
    try {
      if (state.editing) await api('PUT', `/api/items/${state.editing}`, body);
      else await api('POST', '/api/items', body);
      $('#w-form').hidden = true;
      state.editing = null;
      await loadItems();
      toast(body.url ? 'Watching' : 'Watching — looking for the product page', body.name || body.sku || 'SKU', 'success');
    } catch (err) {
      setMsg($('#w-msg'), err.message);
    }
  });
});
$('#w-starter').addEventListener('click', async () => {
  const r = await api('POST', '/api/items/starter');
  state.items = r.items;
  renderItems();
  toast(r.added ? `Added ${r.added} SKU${r.added === 1 ? '' : 's'}` : 'You already have the starter list');
});
$('#w-demo').addEventListener('click', async () => {
  const r = await api('POST', '/api/items/demo');
  state.items = r.items;
  renderItems();
  toast(r.added ? `Added ${r.added} dummy-store item${r.added === 1 ? '' : 's'}` : 'You already have the dummy-store items', `Change their stock at ${state.me.app.demoStoreUrl}`);
});

// Your watchlist, on the Monitor page.
async function loadWatch() {
  await Promise.all([renderExtStatus(), loadLogins().catch(() => null)]);
  renderItems();
}

// ---------------------------------------------------------------------------
// 📦 Checkout details (delivery profiles) and the card in the extension
// ---------------------------------------------------------------------------
const PROFILE_FIELDS = [
  ['label', 'Name for this address', 'text', 'e.g. Home, Work, Mum'],
  ['firstName', 'First name', 'text', '', 'given-name'], ['lastName', 'Last name', 'text', '', 'family-name'],
  ['email', 'Checkout email', 'email', '', 'email'], ['phone', 'Mobile', 'tel', '', 'tel'],
  ['address1', 'Street address', 'text', '', 'address-line1'], ['address2', 'Unit / apartment (optional)', 'text', '', 'address-line2'],
  ['suburb', 'Suburb', 'text', '', 'address-level2'], ['state', 'State', 'state'], ['postcode', 'Postcode', 'text', '', 'postal-code'],
];

async function loadProfiles() {
  state.profiles = await api('GET', '/api/profiles');
  return state.profiles;
}

function profileCard(p, index) {
  const card = h('fieldset', { class: 'card profile', dataset: { id: p.id } });
  const legend = h('legend', {}, index === 0 ? 'Delivery details' : `Address ${index + 1}`);
  const isDefault = h('input', { type: 'radio', name: 'defaultProfile', value: p.id, checked: state.profiles.defaultId === p.id });
  const grid = h('div', { class: 'grid2' });
  for (const [key, label, type, placeholder, auto] of PROFILE_FIELDS) {
    const id = `p-${index}-${key}`;
    let input;
    if (type === 'state') {
      input = h('select', { id, name: key, autocomplete: 'address-level1' }, h('option', { value: '' }, '—'), ...['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'].map((s) => h('option', { value: s, selected: p.state === s }, s)));
    } else {
      input = h('input', { id, name: key, type, placeholder: placeholder || (key === 'email' ? state.me.user.email || 'Your email' : ''), autocomplete: auto || 'off', inputmode: key === 'postcode' ? 'numeric' : null, maxlength: key === 'postcode' ? '4' : null });
      input.value = p[key] || '';
    }
    grid.append(h('div', { class: key === 'address1' || key === 'address2' ? 'span2' : '' }, h('label', { for: id }, label), input));
  }
  const remove = h('button', { class: 'btn small danger', type: 'button', onclick: () => { card.remove(); } }, 'Remove this address');
  card.append(legend, grid, h('div', { class: 'form-actions' }, h('label', { class: 'check' }, isDefault, h('span', {}, 'Use by default')), state.profiles.profiles.length > 1 || index > 0 ? remove : null));
  return card;
}

function renderProfiles() {
  const list = $('#p-list');
  list.textContent = '';
  state.profiles.profiles.forEach((p, i) => list.append(profileCard(p, i)));
}

function readProfiles() {
  const cards = $$('#p-list fieldset.profile');
  const profiles = cards.map((c) => {
    const out = { id: c.dataset.id };
    for (const [key] of PROFILE_FIELDS) out[key] = $(`[name="${key}"]`, c).value;
    return out;
  });
  const def = $('#p-list input[name=defaultProfile]:checked');
  return { profiles, defaultId: def ? def.value : (profiles[0] && profiles[0].id) };
}

$('#p-add').addEventListener('click', () => {
  if ($$('#p-list fieldset.profile').length >= state.me.app.limits.profiles) { toast(`Up to ${state.me.app.limits.profiles} addresses`); return; }
  const fresh = { id: `pf_${Math.random().toString(36).slice(2, 10)}`, label: 'Another address', state: '' };
  $('#p-list').append(profileCard(fresh, $$('#p-list fieldset.profile').length));
});

$('#p-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      state.profiles = await api('PUT', '/api/profiles', readProfiles());
      renderProfiles();
      setMsg($('#p-msg'), 'Saved.', true);
    } catch (err) {
      setMsg($('#p-msg'), err.message);
    }
  });
});

const cardLabel = (c) => `${c.brand} •••• ${c.last4} · expires ${c.expMonth}/${String(c.expYear).slice(-2)}`;

// The card's backup in your account (locked in the extension with your card passphrase).
function renderCardBackup() {
  const box = $('#card-backup');
  const b = state.cardBackup;
  box.textContent = '';
  if (b) {
    box.append(h('p', {}, h('span', { class: 'pill ok' }, 'Backed up'), ' ', `${cardLabel(b)} is backed up in your account, locked with your card passphrase. A new install of the extension, or another browser, restores it with that passphrase (Card settings). Mugibot can't open it.`),
      h('div', { class: 'form-actions' }, h('button', {
        class: 'btn small danger', type: 'button', id: 'card-unbackup',
        onclick: async () => {
          if (!confirm('Delete the backup of your card from your account? The card stays in the extensions it\'s saved in.')) return;
          await api('DELETE', '/api/card-backup');
          state.cardBackup = null;
          renderCardBackup();
          renderCard().catch(() => null);
        },
      }, 'Delete the backup')));
  } else {
    box.append(h('p', { class: 'muted small' }, 'Not backed up. In Card settings you can back it up to your account, locked with a card passphrase only you know, so a new install of the extension doesn\'t need the card typed in again.'));
  }
}

async function loadCardBackup() {
  state.cardBackup = (await api('GET', '/api/card-backup')).backup;
}

async function renderCard() {
  const box = $('#card-state');
  const ext = state.ext || await detectExtension();
  state.ext = ext;
  if (!ext.installed) { box.className = 'notice warn'; box.textContent = 'Install the extension (Extension tab) to save a card in this browser.'; return; }
  if (!ext.paired || ext.userId !== state.me.user.id) { box.className = 'notice warn'; box.textContent = 'Connect the extension to your account (Extension tab) first.'; return; }
  const r = await askExtension('cardStatus');
  const c = r && r.card;
  const b = state.cardBackup;
  $('#card-open').textContent = c && c.ready ? 'Card settings' : b ? 'Restore your card' : c && c.saved ? 'Card settings' : 'Add your card';
  if ((!c || !c.ready) && b) {
    box.className = 'notice warn';
    box.textContent = `${cardLabel(b)} is backed up in your account, but not in this browser yet. Press Restore your card and enter your card passphrase.`;
    return;
  }
  if (!c || !c.saved) { box.className = 'notice warn'; box.textContent = 'No card saved in this browser yet. Press Add your card: save it once and every ⚡ Buy fills it in.'; return; }
  const label = `${c.brand} •••• ${c.last4} · expires ${c.expMonth}/${String(c.expYear).slice(-2)}`;
  // Extensions from 1.3 keep the card ready ("ready"); older ones have to be unlocked after every browser restart.
  const ready = c.ready || (c.ready === undefined && c.unlocked);
  box.className = `notice ${ready ? 'ok' : 'warn'}`;
  box.textContent = ready ? `${label} — ready: ⚡ Buy fills it in at checkout${c.hasCvc === false ? ' (no CVV saved: you type that in)' : ''}.`
    : c.needsPassphrase ? `${label} — saved by an older version. Press Card settings and enter its passphrase once, and it stays ready from then on.`
      : c.unreadable ? `${label} — couldn't be read in this browser. Press Card settings and save it again.`
        : `${label} — locked. Update the extension (Extension tab) and the card stays ready without unlocking.`;
}
$('#card-open').addEventListener('click', async () => {
  const r = await askExtension('openCardSettings');
  if (!r) toast('Extension not found', 'Install and connect the extension first (Extension tab).', 'warn');
});

loaders.checkout = async () => {
  await Promise.all([loadProfiles(), loadCardBackup().catch(() => null)]);
  renderProfiles();
  renderCardBackup();
  await renderCard();
};

// ---------------------------------------------------------------------------
// 🤖 Auto-checkout (docs/AUTO-CHECKOUT.md)
// ---------------------------------------------------------------------------
const ACO_ICON = { placed: '✅', ready: '🛒', needs_you: '⚠️', failed: '❌', expired: '❌', skipped: '⏭️', waiting: '🚦' };
const ACO_TONE = { placed: 'ok', ready: 'info', needs_you: 'warn', failed: 'err', expired: 'err', skipped: '', waiting: 'warn' };
const ACO_STEP = {
  queued: 'Dropped', sent: 'Sent to your browser', started: 'Store opened', waiting: 'Waiting (a queue, a checkpoint, or its turn at the store)', checkout: 'At checkout', placing: 'Final button pressed',
  placed: 'Order placed', ready: 'Filled in', needs_you: 'Needs you', failed: 'Failed', skipped: "Didn't start", expired: "Didn't start",
};
const ACO_FILTER = { placed: ['placed'], needs: ['needs_you', 'ready'], failed: ['failed', 'expired'], skipped: ['skipped'] };
const TRIGGER = { sweep: 'seen by the live monitor', server: 'seen by the monitor', browser: 'seen by your browser', manual: 'reported by an admin', test: 'test run (Trigger ACO)', remote: '⚡ Buy pressed in Discord' };
const versionBelow = (a, b) => {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
};

async function loadAco() {
  // (Every run of the last while: the run history is paged here.)
  state.aco = await api('GET', '/api/aco?limit=200');
  return state.aco;
}

function renderAcoStats() {
  const s = state.aco.stats;
  const box = $('#aco-stats');
  box.textContent = '';
  const tile = (k, v, sub, tone = '') => h('div', { class: `aco-stat${tone ? ` ${tone}` : ''}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), sub ? h('div', { class: 's' }, sub) : null);
  box.append(
    tile('Orders placed', String(s.placed), s.spent ? `${money(s.spent)} spent` : 'in the last 30 days', 'ok'),
    tile('Attempts', String(s.attempts), `${s.drops} drop${s.drops === 1 ? '' : 's'} of armed items`),
    tile('Needed you', String(s.needsYou), 'stopped for you to finish', s.needsYou ? 'warn' : ''),
    tile('Failed or didn\'t start', String(s.failed + s.skipped), s.skipped ? `${s.skipped} didn't start` : 'last 30 days', s.failed ? 'err' : ''),
  );
}

function renderAcoSettings() {
  const s = state.aco.settings;
  const sw = $('#aco-enabled');
  sw.setAttribute('aria-checked', s.enabled ? 'true' : 'false');
  $('#aco-state').className = `pill ${s.enabled ? 'ok' : ''}`;
  $('#aco-state').textContent = s.enabled ? (s.mode === 'place' ? 'On — places orders' : 'On — stops at the final button') : 'Off';
  $('#aco-enabled-label').textContent = s.enabled ? 'Auto-checkout is on' : 'Auto-checkout is off';
  $('#aco-enabled-note').textContent = !s.enabled ? 'Nothing is bought by itself until you switch it on.'
    : s.mode === 'place' ? `Armed items are bought by themselves when they drop: up to ${money(s.maxOrder)} an order, ${s.perDay} order${s.perDay === 1 ? '' : 's'} and ${money(s.spendPerDay)} a day.`
      : 'Armed items are filled in at checkout by themselves when they drop; you press the final button.';
  $('#aco-agree-wrap').hidden = !!s.agreedAt;
  for (const r of $$('input[name="aco-mode"]')) r.checked = r.value === s.mode;
  $('#aco-max').value = s.maxOrder;
  $('#aco-perday').value = s.perDay;
  $('#aco-spend').value = s.spendPerDay;
  $('#aco-signedin').checked = !!s.signedInOnly;
}

/** A store's sign-in status (the store login monitor), for the armed items. */
function signInPill(store) {
  const l = state.logins && state.logins.stores.find((x) => x.id === store);
  if (!l) return null;
  if (l.status === 'in') return h('span', { class: 'pill ok', title: `Seen ${ago(l.at)}` }, 'Signed in');
  if (l.status === 'out') return h('a', { class: 'pill warn', href: l.signInUrl, target: '_blank', rel: 'noopener', title: 'Sign in so checkout is faster' }, 'Signed out — sign in ↗');
  return h('a', { class: 'pill', href: l.signInUrl, target: '_blank', rel: 'noopener', title: 'Open the store once in the browser with the extension' }, 'Sign-in not seen yet');
}

// Armed items: a table, 10 to a page (the page kept while things change).
const ACO_PAGE_SIZE = 10;
function renderAcoItems() {
  const body = $('#aco-items');
  body.textContent = '';
  const armed = state.items.filter((it) => it.aco).length;
  $('#aco-armed-count').textContent = `${armed} armed`;
  const show = $('#aco-show').value;
  const items = state.items.filter((it) => show !== 'armed' || it.aco);
  const pages = Math.max(1, Math.ceil(items.length / ACO_PAGE_SIZE));
  state.acoPage = Math.min(Math.max(1, state.acoPage || 1), pages);
  renderPager($('#aco-pager'), { page: state.acoPage, size: ACO_PAGE_SIZE, total: items.length, label: 'Armed items', onPage: (p) => { state.acoPage = p; renderAcoItems(); } });
  if (!items.length) {
    body.append(h('tr', { class: 'empty' }, h('td', { colspan: '5' }, show === 'armed'
      ? 'Nothing armed yet — show every item and switch one on.'
      : ['Your watchlist is empty — add SKUs on the ', h('a', { href: '#watch' }, 'Monitor page (My watchlist)'), ', then arm them here.'])));
    return;
  }
  const lastRun = (id) => (state.aco.runs || []).find((r) => r.itemId === id);
  const from = (state.acoPage - 1) * ACO_PAGE_SIZE;
  for (const it of items.slice(from, from + ACO_PAGE_SIZE)) {
    const can = it.acoCan;
    const toggle = h('button', { type: 'button', class: 'sn-sw', role: 'switch', 'aria-checked': it.aco ? 'true' : 'false', 'aria-label': `Auto-checkout ${it.name}`, disabled: !can });
    const max = h('input', { type: 'number', min: '0', step: '0.01', value: it.maxPrice ?? '', placeholder: 'Max $', 'aria-label': `Max price for ${it.name}`, class: 'aco-max' });
    const save = async (patch) => {
      try {
        await api('PUT', `/api/items/${it.id}`, patch);
        await Promise.all([loadItems(), loadAco()]);
        renderAco();
        if (patch.aco) askExtension('acoListen', {}, 4000);
      } catch (e) {
        toast("Couldn't change it", e.message, 'warn');
        renderAcoItems();
      }
    };
    toggle.addEventListener('click', () => save({ aco: !it.aco, maxPrice: max.value }));
    max.addEventListener('change', () => save({ maxPrice: max.value }));
    const on = state.aco.settings.enabled;
    const test = h('button', {
      type: 'button', class: 'btn small aco-test', disabled: !can || !on,
      title: !can ? 'No checkout for this store yet' : !on ? 'Switch Auto-checkout on first (above)' : 'Run Auto-checkout for this item now, as if it had just dropped',
    }, 'Trigger ACO');
    test.addEventListener('click', () => triggerAco(it, max, test));
    const run = lastRun(it.id);
    body.append(h('tr', { class: `aco-item${it.aco ? ' armed' : ''}`, dataset: { id: it.id } },
      h('td', { class: 'sw' }, toggle),
      h('td', { class: 'info' },
        h('div', { class: 'name' }, it.name),
        h('div', { class: 'meta' }, [it.storeName, `SKU ${it.sku}`, money(it.lastPrice ?? it.price)].filter(Boolean).join(' · '),
          !can ? ' · no checkout for this store yet' : !it.acoPlaces ? (it.acoStops === 'paypal' ? ' · stops at PayPal here (this store only takes PayPal)' : ' · stops at the final button here (its payment form is another site\'s)') : ''),
        run ? h('div', { class: `meta aco-last ${ACO_TONE[run.status] || ''}` }, `Last: ${ACO_ICON[run.status] || '⏳'} ${run.statusText}${run.reasonText ? ` — ${run.reasonText}` : ''} · ${ago(run.createdAt)}`) : null),
      h('td', { class: 'signin' }, signInPill(it.store) || h('span', { class: 'muted' }, '—')),
      h('td', { class: 'max' }, h('label', { class: 'aco-max-wrap' }, h('span', { 'aria-hidden': 'true' }, '$'), max)),
      h('td', { class: 'act' }, test)));
  }
}

/** Trigger ACO: a test run for one item, now (after saying what it will do). */
async function triggerAco(it, maxInput, btn) {
  const s = state.aco.settings;
  const maxNow = maxInput.value === '' ? null : Number(maxInput.value);
  const how = s.mode === 'place'
    ? `If everything checks out it PLACES A REAL ORDER — one of it${maxNow != null ? `, up to ${money(maxNow)} plus delivery` : ''}, within your limits.`
    : 'It fills checkout in and stops at the final button for you (your mode).';
  if (!confirm(`Trigger ACO for ${it.name}?\n\nYour browser opens ${it.storeName} now and checks out as if it had just dropped. ${how}`)) return;
  btn.disabled = true;
  try {
    // A max price typed in but not saved yet: saved first.
    if (String(maxInput.value) !== String(it.maxPrice ?? '')) await api('PUT', `/api/items/${it.id}`, { maxPrice: maxInput.value });
    const { run } = await api('POST', `/api/aco/test/${it.id}`);
    if (run.status === 'skipped') toast("Auto-checkout didn't start", run.message || run.reasonText, 'warn');
    else toast('Auto-checkout test started', `Your checkout browser is opening ${it.storeName} — follow it in the run history below.`, 'success');
    // This browser picks it up now (it listens while something waits for it).
    askExtension('acoListen', {}, 4000);
    await Promise.all([loadItems(), loadAco()]);
    renderAco();
  } catch (e) {
    toast("Couldn't trigger it", e.message, 'warn');
  } finally {
    btn.disabled = false;
  }
}

// Run history: 10 to a page.
const RUNS_PAGE_SIZE = 10;
function renderAcoRuns() {
  const list = $('#aco-runs');
  list.textContent = '';
  const want = ACO_FILTER[$('#aco-filter').value];
  const runs = (state.aco.runs || []).filter((r) => !want || want.includes(r.status));
  const pages = Math.max(1, Math.ceil(runs.length / RUNS_PAGE_SIZE));
  state.runsPage = Math.min(Math.max(1, state.runsPage || 1), pages);
  renderPager($('#aco-runs-pager'), { page: state.runsPage, size: RUNS_PAGE_SIZE, total: runs.length, label: 'Run history', onPage: (p) => { state.runsPage = p; renderAcoRuns(); } });
  if (!runs.length) {
    list.append(h('li', { class: 'empty' }, want ? 'Nothing here.' : 'Nothing yet. When an armed item drops, each attempt shows up here — what happened, and why.'));
    return;
  }
  const from = (state.runsPage - 1) * RUNS_PAGE_SIZE;
  for (const r of runs.slice(from, from + RUNS_PAGE_SIZE)) {
    const icon = ACO_ICON[r.status] || '⏳';
    const money2 = r.total != null ? `${money(r.total)} total` : r.price != null ? money(r.price) : '';
    const steps = h('ol', { class: 'aco-steps' }, ...r.steps.map((x) => h('li', {},
      h('time', { datetime: new Date(x.at).toISOString(), title: when(x.at) }, new Date(x.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })),
      h('b', {}, ACO_STEP[x.status] || x.status), x.message ? ` — ${x.message}` : '')));
    list.append(h('li', { class: `aco-run st-${r.status}${r.active ? ' active' : ''}`, dataset: { id: r.id } },
      h('div', { class: 'head' },
        h('span', { class: 'ic', 'aria-hidden': 'true' }, icon),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, r.name),
          h('div', { class: 'meta' }, [state.retailers.find((x) => x.id === r.store)?.name || r.store, money2, TRIGGER[r.trigger] || '', r.mode === 'fill' ? 'stop at the final button' : ''].filter(Boolean).join(' · '))),
        h('span', { class: `pill ${ACO_TONE[r.status] || ''}` }, r.statusText),
        h('time', { class: 'muted small', datetime: new Date(r.createdAt).toISOString(), title: when(r.createdAt) }, ago(r.createdAt))),
      r.reasonText || r.message ? h('div', { class: `why ${ACO_TONE[r.status] || ''}` }, r.reasonText && r.message && !r.message.startsWith(r.reasonText) ? `${r.reasonText}: ${r.message}` : (r.message || r.reasonText)) : null,
      h('details', { class: 'aco-detail' }, h('summary', {}, `Steps (${r.steps.length})`), steps)));
  }
}

async function renderAcoChecks() {
  const list = $('#aco-checks');
  const s = state.aco.settings;
  const ext = await detectExtension();
  state.ext = ext;
  const mine = ext.installed && ext.paired && ext.userId === state.me.user.id;
  const minV = state.aco.extensionVersion || '1.10.0';
  const extOk = mine && !versionBelow(ext.version, minV);
  const card = mine ? ((await askExtension('cardStatus')) || {}).card : null;
  const backup = card && card.ready ? null : (await api('GET', '/api/card-backup').catch(() => ({}))).backup;
  const profiles = await api('GET', '/api/profiles').catch(() => null);
  const profile = profiles && profiles.profiles && profiles.profiles.find((p) => p.id === profiles.defaultId) || (profiles && profiles.profiles && profiles.profiles[0]);
  const listening = extOk && (s.enabled || s.remoteBuy) ? await askExtension('acoListen', {}, 4000) : null;
  // Which browser checks out: this one, or another of yours (runs go to that one alone).
  renderAcoRemote();
  const checkout = (state.aco.browsers || []).find((b) => b.checkout);
  const isHere = !!(checkout && mine && ext.deviceId && checkout.id === ext.deviceId);
  const rows = [
    [state.me.entitlement.active, 'Membership active', 'Start your membership', '#membership'],
    [extOk, extOk ? `Extension connected in this browser (v${ext.version})` : !ext.installed ? 'Install the extension in the browser you keep open' : !mine ? 'Connect the extension in this browser to your account' : `Update the extension to ${minV} or newer (this one is ${ext.version})`, 'Extension tab', '#extension'],
    [!!(card && card.ready), card && card.ready ? `${card.brand} •••• ${card.last4} saved in the extension`
      : backup ? `${backup.brand} •••• ${backup.last4} is backed up in your account — restore it in this browser with your card passphrase`
        : card && card.saved ? `${card.brand} •••• ${card.last4} saved in the extension — open Card settings once to make it ready` : 'Save your card in the extension (we never see it)', 'Card settings', '#checkout'],
    [!!(profile && profile.address1 && profile.email), profile && profile.address1 ? `Delivery details: ${profile.label} (${profile.suburb || profile.postcode})` : 'Save your delivery details', 'Checkout details', '#checkout'],
    [!!state.me.user.discord, state.me.user.discord ? 'Discord connected: a DM for every attempt' : 'Connect Discord to get a DM for every attempt (optional)', 'Discord', '#discord'],
  ];
  if (checkout) {
    rows.push([isHere || checkout.listening, isHere ? 'This is your checkout browser: Auto-checkout and Discord\'s ⚡ Buy check out here'
      : `Your checkout browser is ${checkout.name}${checkout.listening ? ' (open now)' : ' — it isn\'t open right now'}: runs go there, not here (change it under "⚡ Buy from your phone")`, null, null]);
  }
  if (s.enabled || (s.remoteBuy && isHere)) {
    rows.push([!!(listening && listening.listening), listening && listening.listening ? (isHere && s.remoteBuy ? 'This browser is listening for runs — your armed items\' drops and Discord\'s ⚡ Buy. Keep Chrome open' : 'This browser is listening for your armed items to drop — keep Chrome open')
      : state.items.some((it) => it.aco) || isHere ? 'This browser isn\'t listening yet — reload this page, or check the extension is connected (and up to date)' : 'Arm an item below, and this browser starts listening for it', null, null]);
  }
  list.textContent = '';
  for (const [ok, text, label, href] of rows) {
    list.append(h('li', {}, h('span', { class: ok ? 'ok-mark' : 'no-mark', 'aria-hidden': 'true' }, ok ? '✓' : '✗'), h('span', {}, text, !ok && href ? [' — ', h('a', { href }, label)] : null)));
  }
}

/** ⚡ Buy from your phone: the switch, and the checkout browser (the one browser runs go to). */
function renderAcoRemote() {
  const s = state.aco.settings;
  const browsers = state.aco.browsers || [];
  const here = state.ext && state.ext.userId === state.me.user.id ? state.ext.deviceId : null;
  const checkout = browsers.find((b) => b.checkout);
  $('#aco-remote-on').setAttribute('aria-checked', s.remoteBuy ? 'true' : 'false');
  $('#aco-remote-label').textContent = s.remoteBuy ? 'Discord\'s ⚡ Buy checks out on your computer' : 'Discord\'s ⚡ Buy is off for your computer';
  const pill = $('#aco-remote-state');
  pill.className = `pill ${!s.remoteBuy ? '' : checkout && checkout.listening ? 'ok' : 'warn'}`;
  pill.textContent = !s.remoteBuy ? 'Off' : !checkout ? 'No browser connected' : checkout.listening ? 'Ready' : 'Checkout browser not open';
  const sel = $('#aco-device');
  sel.textContent = '';
  for (const b of browsers) {
    const bits = [b.listening ? 'open now' : `seen ${ago(b.lastSeenAt)}`, b.id === here ? 'this browser' : ''].filter(Boolean).join(' · ');
    sel.append(h('option', { value: b.id, selected: b.checkout }, `${b.name} (${bits})`));
  }
  if (!browsers.length) sel.append(h('option', { value: '' }, 'No browser connected yet'));
  sel.disabled = browsers.length < 2;
  $('#aco-device-here').hidden = !here || !checkout || checkout.id === here || !browsers.some((b) => b.id === here);
  const note = $('#aco-device-note');
  note.textContent = '';
  if (!browsers.length) {
    note.append('Connect the extension in the browser on the computer you keep on (', h('a', { href: '#extension' }, 'Extension tab'), ').');
    return;
  }
  const old = checkout && versionBelow(checkout.version, state.aco.remoteVersion);
  note.append('Auto-checkout\'s runs and Discord\'s ⚡ Buy go to this one browser — never to all of them, so two of your browsers never race for the same order. Keep it open (minimised is fine).',
    checkout && !checkout.listening ? ` ${checkout.name} isn't open right now: a ⚡ Buy waits 2 minutes for it.` : '',
    old ? ` Update the extension there to ${state.aco.remoteVersion} so ⚡ Buy starts the moment you press it (it has ${checkout.version || 'an older one'}).` : '');
}

async function saveRemote(patch, done) {
  try {
    const r = await api('PUT', '/api/aco', patch);
    Object.assign(state.aco, r);
    renderAcoRemote();
    // This browser hears now (if it's the checkout browser, it starts listening).
    askExtension('acoListen', {}, 4000);
    if (done) toast(done[0], done[1], 'success');
  } catch (e) {
    toast("Couldn't change it", e.message, 'warn');
    renderAcoRemote();
  }
}

// --- Clear cart: your bag at each store, emptied in your checkout browser (server/bags.js) ----------
async function loadBags() {
  state.bags = await api('GET', '/api/bags');
  return state.bags;
}

const BAG_TONE = { cleared: 'ok', empty: 'ok', busy: 'warn', failed: 'err', expired: 'err' };

/** How a store's bag is: being emptied now, or how it went last time. */
function bagMeta(s, deviceName) {
  if (s.active) return s.status === 'queued' ? `⏳ Waiting for ${s.device || deviceName || 'your checkout browser'}…` : `🧹 Emptying it…${s.removed ? ` ${s.removed} removed so far` : ''}`;
  if (!s.status) return 'Not emptied from here yet';
  const at = s.at ? ` · ${ago(s.at)}` : '';
  if (s.status === 'cleared') return `✓ Emptied — ${s.removed} item${s.removed === 1 ? '' : 's'} removed${at}`;
  if (s.status === 'empty') return `✓ Already empty${at}`;
  if (s.status === 'busy') return `Left alone: ${s.message}${at}`;
  return `✗ ${s.statusText}: ${s.message}${at}`;
}

function renderBags() {
  const d = state.bags;
  const list = $('#bags');
  if (!d || !list) return;
  list.textContent = '';
  const device = d.device;
  const old = !!device && versionBelow(device.version, d.extensionVersion);
  $('#bags-sum').textContent = !device ? "Connect the extension in the browser you check out with (Extension tab), and its bags can be emptied from here."
    : old ? `Update the extension in ${device.name} to ${d.extensionVersion} or newer to empty its bags from here (it has ${device.version || 'an older one'}).`
      : `Emptied in ${device.name}, your checkout browser${device.listening ? ' (open now)' : " — it isn't open right now: it empties them when it next is"}.`;
  $('#bags-all').disabled = !device || old;
  for (const s of d.stores) {
    const btn = h('button', { class: 'btn small', type: 'button', disabled: !device || old || s.active, 'aria-label': `Clear cart at ${s.name}` }, s.active ? 'Emptying…' : 'Clear cart');
    btn.addEventListener('click', () => clearBags(s.id, `Empty your ${s.name} bag in ${device.name}?\n\nEverything in it is removed.`));
    list.append(h('li', { class: `bag ${s.active ? 'active' : BAG_TONE[s.status] || 'none'}`, dataset: { store: s.id } },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('div', { class: 'info' }, h('div', { class: 'name' }, s.name), h('div', { class: 'meta', title: s.message || '' }, bagMeta(s, device && device.name))),
      btn));
  }
}

/** Clear cart (a store) or Clear all ('all'), after asking. */
async function clearBags(stores, question) {
  if (!confirm(question)) return;
  const msg = $('#bags-msg');
  try {
    const r = await api('POST', '/api/bags/clear', stores === 'all' ? { stores: 'all' } : { store: stores });
    setMsg(msg, `${r.device.name} is emptying ${stores === 'all' ? 'your bags, one store at a time' : 'it'}${r.listening ? '.' : " — it isn't open right now: it does it when it next is (within a few minutes)."}`, true);
    // (This browser, if it's the checkout browser, starts now rather than at its next check.)
    askExtension('acoListen', {}, 4000);
  } catch (e) {
    setMsg(msg, e.message);
  }
  await loadBags().catch(() => null);
  renderBags();
}

$('#bags-all').addEventListener('click', () => {
  const d = state.bags;
  if (!d || !d.device) return;
  clearBags('all', `Empty your bags at all ${d.stores.length} stores in ${d.device.name}?\n\nEverything in them is removed — one store at a time. A store where a checkout of yours is going is left alone.`);
});

function renderAco() {
  if (!state.aco) return;
  renderAcoStats();
  renderAcoSettings();
  renderAcoRemote();
  renderBags();
  renderAcoItems();
  renderAcoRuns();
}

loaders.aco = async () => {
  await Promise.all([loadAco(), loadRetailers(), loadItems(), loadLogins().catch(() => null), loadBags().catch(() => null)]);
  renderAco();
  renderAcoChecks().catch(() => null);
};

$('#aco-enabled').addEventListener('click', async () => {
  const s = state.aco.settings;
  const next = !s.enabled;
  const msg = $('#aco-msg');
  if (next && !s.agreedAt && !$('#aco-agree').checked) {
    $('#aco-agree-wrap').hidden = false;
    $('#aco-agree').focus();
    setMsg(msg, 'Tick the box to agree first, then switch it on.');
    return;
  }
  try {
    const r = await api('PUT', '/api/aco', { enabled: next, agree: next && !s.agreedAt ? true : undefined });
    Object.assign(state.aco, r);
    renderAcoSettings();
    setMsg(msg, next ? 'On.' : 'Off — nothing is bought by itself.', true);
    renderAcoChecks().catch(() => null);
  } catch (e) {
    setMsg(msg, e.message);
  }
});
$('#aco-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      const mode = ($$('input[name="aco-mode"]').find((r) => r.checked) || {}).value || 'place';
      const r = await api('PUT', '/api/aco', { mode, maxOrder: $('#aco-max').value, perDay: $('#aco-perday').value, spendPerDay: $('#aco-spend').value, signedInOnly: $('#aco-signedin').checked });
      Object.assign(state.aco, r);
      renderAcoSettings();
      setMsg($('#aco-msg'), 'Saved.', true);
    } catch (err) {
      setMsg($('#aco-msg'), err.message);
    }
  });
});
$('#aco-remote-on').addEventListener('click', () => saveRemote({ remoteBuy: !state.aco.settings.remoteBuy }));
$('#aco-device').addEventListener('change', (e) => {
  const b = (state.aco.browsers || []).find((x) => x.id === e.target.value);
  saveRemote({ deviceId: e.target.value }, b ? ['Checkout browser changed', `${b.name} checks out from now on.`] : null);
});
$('#aco-device-here').addEventListener('click', () => saveRemote({ deviceId: state.ext.deviceId }, ['Checkout browser changed', 'This browser checks out from now on.']));
$('#aco-filter').addEventListener('change', () => { state.runsPage = 1; renderAcoRuns(); });
$('#aco-show').addEventListener('change', () => { state.acoPage = 1; renderAcoItems(); });
$('#aco-recheck').addEventListener('click', async () => {
  // (Which browsers are open now, too.)
  await loadAco().catch(() => null);
  renderAco();
  renderAcoChecks().catch(() => null);
});

// ---------------------------------------------------------------------------
// 💬 Discord
// ---------------------------------------------------------------------------
async function loadDiscord() {
  const d = await api('GET', '/api/discord');
  const box = $('#d-status');
  const actions = $('#d-actions');
  actions.textContent = '';
  if (!d.oauth) {
    box.className = 'notice warn';
    box.textContent = 'Discord isn\'t set up on this server yet — an admin needs to add the Discord app details.';
    return;
  }
  const active = state.me.entitlement.active;
  if (!d.linked) {
    box.className = 'notice warn';
    box.textContent = 'Not connected. Connect your Discord to get DM pings' + (d.bot ? ' and join the members\' server.' : '.');
    actions.append(h('a', { class: 'btn primary', href: '/auth/discord' }, 'Connect Discord'));
  } else {
    const parts = [h('b', {}, `Connected as ${d.username}. `)];
    let level = 'ok';
    if (d.bot) {
      if (d.inServer) parts.push(d.hasRole ? '✓ You\'re in the members\' server. ' : 'You\'re in the server. ');
      else if (active) { parts.push('Not in the members\' server yet. '); level = 'warn'; }
      else parts.push('The members\' server opens once your membership is active. ');
    }
    if (d.error) { parts.push(h('span', { class: 'warn-text' }, d.error)); level = 'warn'; }
    box.className = `notice ${level}`;
    box.textContent = '';
    box.append(...parts);
    if (d.bot && active && (!d.inServer || d.error)) actions.append(h('a', { class: 'btn primary', href: '/auth/discord' }, 'Join the server'));
    if (d.bot) actions.append(h('button', { class: 'btn', type: 'button', onclick: async () => { try { await api('POST', '/api/discord/test'); toast('Test DM sent', 'Check your Discord DMs.', 'success'); } catch (e) { showError(e); } loadDiscord(); } }, 'Send me a test DM'));
    if (d.bot) actions.append(h('button', { class: 'btn', type: 'button', onclick: async () => { try { const r = await api('POST', '/api/discord/sync'); toast(r.sync.error ? 'Not quite' : 'Up to date', r.sync.error || 'Your server access matches your membership.', r.sync.error ? 'warn' : 'success'); } catch (e) { showError(e); } loadDiscord(); } }, 'Re-check server access'));
    actions.append(h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (confirm('Disconnect Discord? You\'ll stop getting DM pings and lose the members\' role.')) { await api('POST', '/api/discord/unlink'); loadDiscord(); } } }, 'Disconnect'));
  }
  if (d.inviteUrl) actions.append(h('a', { class: 'btn', href: d.inviteUrl, target: '_blank', rel: 'noopener' }, 'Open the server ↗'));
}

loaders.discord = async () => {
  const [alerts] = await Promise.all([loadAlerts(), loadDiscord()]);
  $('#a-dm').checked = alerts.discordDm;
  $('#a-dm-listed').checked = alerts.discordDmListed;
  $('#a-dm-checkout').checked = alerts.discordDmCheckout;
  $('#a-hook').value = alerts.discordWebhook;
  $('#a-mention').value = alerts.discordMention;
  $('#a-email-restock').checked = alerts.emailOnRestock;
  $('#a-email-checkout').checked = alerts.emailOnCheckout;
  const email = state.me.user.email;
  $('#a-email-note').textContent = !state.me.app.email ? 'Email isn\'t set up on this server.' : email ? `Emails go to ${email}.` : 'Add an email address under Account to get emails.';
};
$('#a-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      await api('PUT', '/api/alerts', {
        discordDm: $('#a-dm').checked, discordDmListed: $('#a-dm-listed').checked, discordDmCheckout: $('#a-dm-checkout').checked,
        discordWebhook: $('#a-hook').value, discordMention: $('#a-mention').value,
        emailOnRestock: $('#a-email-restock').checked, emailOnCheckout: $('#a-email-checkout').checked,
      });
      setMsg($('#a-msg'), 'Saved.', true);
    } catch (err) {
      setMsg($('#a-msg'), err.message);
    }
  });
});
$('#a-test').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/alerts/test');
    setMsg($('#a-msg'), r.sent && r.sent.length ? `Test ping sent (${r.sent.join(', ').replace('discord-dm', 'Discord DM')}).` : 'Test ping is in your activity feed (connect Discord or add a webhook to get it there too).', true);
  } catch (err) {
    setMsg($('#a-msg'), err.message);
  }
});

// ---------------------------------------------------------------------------
// ⭐ Membership
// ---------------------------------------------------------------------------
loaders.membership = async () => {
  const m = await api('GET', '/api/membership');
  const e = m.entitlement;
  const info = $('#m-info');
  info.textContent = '';
  const row = (k, v) => info.append(h('dt', {}, k), h('dd', {}, v));
  row('Status', e.label);
  row('Price', m.price);
  if (m.membership) {
    row('Whop membership', m.membership.id);
    if (m.membership.renewsAt) row(m.membership.cancelAtPeriodEnd ? 'Access until' : 'Renews', new Date(m.membership.renewsAt).toLocaleDateString());
  }
  if (e.plan === 'trial' && e.trialEndsAt) row('Trial ends', new Date(e.trialEndsAt).toLocaleString());
  const member = ['active', 'past_due'].includes(e.plan);
  $('#m-subscribe').hidden = !m.checkout || member || e.plan === 'comped' || e.label === 'Admin';
  $('#m-manage').hidden = !m.membership;
  $('#m-sync').hidden = !m.membership || !m.canClaim;
  $('#m-claim').hidden = !m.canClaim || member;
  $('#m-note').textContent = m.checkout ? 'Payments are handled securely by Whop. Cancel any time from "Manage membership on Whop".' : 'Memberships aren\'t open on this server yet — ask an admin.';
};
async function goWhop(path, btn) {
  btn.disabled = true;
  try {
    const { url } = await api('POST', path);
    location.href = url;
  } catch (err) {
    setMsg($('#m-msg'), err.message);
    btn.disabled = false;
  }
}
$('#m-subscribe').addEventListener('click', (e) => goWhop('/api/membership/checkout', e.target));
$('#m-manage').addEventListener('click', async (e) => {
  try {
    const { url } = await api('POST', '/api/membership/manage');
    window.open(url, '_blank', 'noopener');
  } catch (err) { setMsg($('#m-msg'), err.message); }
});
$('#m-sync').addEventListener('click', async () => {
  try {
    await api('POST', '/api/membership/sync');
    await loadMe();
    await loaders.membership();
    setMsg($('#m-msg'), 'Up to date.', true);
  } catch (err) { setMsg($('#m-msg'), err.message); }
});
$('#m-claim').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      await api('POST', '/api/membership/claim', { membership: $('#m-claim-id').value });
      await loadMe();
      await loaders.membership();
      setMsg($('#m-claim-msg'), 'Linked!', true);
    } catch (err) {
      setMsg($('#m-claim-msg'), err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// 📋 Activity
// ---------------------------------------------------------------------------
function feedItem(ev) {
  return h('li', { dataset: { id: ev.id } },
    h('span', { class: `lvl ${ev.level}` }),
    h('time', { datetime: new Date(ev.createdAt).toISOString() }, when(ev.createdAt)),
    h('span', {}, ev.message, /^https?:\/\//i.test(ev.url || '') ? [' ', h('a', { href: ev.url, target: '_blank', rel: 'noopener' }, '↗')] : null));
}
// Your activity, on the Monitor page: 20 to a page, newest first.
const FEED_PAGE_SIZE = 20;
async function loadFeed(page = 1) {
  const r = await api('GET', `/api/events?limit=${FEED_PAGE_SIZE}&page=${page}`);
  const pages = Math.max(1, Math.ceil(r.total / FEED_PAGE_SIZE));
  if (page > pages && r.total) return loadFeed(pages);
  state.feedPage = page;
  state.feedTotal = r.total;
  const list = $('#feed');
  list.textContent = '';
  if (!r.events.length) list.append(h('li', { class: 'empty' }, 'Nothing yet.'));
  r.events.forEach((ev) => list.append(feedItem(ev)));
  renderFeedPager();
}
function renderFeedPager() {
  renderPager($('#feed-pager'), { page: state.feedPage, size: FEED_PAGE_SIZE, total: state.feedTotal, label: 'Activity', onPage: (p) => loadFeed(p).catch(showError) });
}

// ---------------------------------------------------------------------------
// 👤 Account
// ---------------------------------------------------------------------------
$('#acct-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      const r = await api('PUT', '/api/me', { name: $('#acct-name').value, email: $('#acct-email').value });
      state.me.user = r.user;
      setMsg($('#acct-msg'), 'Saved.', true);
    } catch (err) {
      setMsg($('#acct-msg'), err.message);
    }
  });
});
$('#pw-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      await api('POST', '/api/me/password', { current: $('#pw-current').value, next: $('#pw-next').value });
      $('#pw-current').value = '';
      $('#pw-next').value = '';
      setMsg($('#pw-msg'), 'Password changed.', true);
    } catch (err) {
      setMsg($('#pw-msg'), err.message);
    }
  });
});
$('#del-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!confirm('Delete your account and everything in it? This can\'t be undone.')) return;
  busy(e.target, async () => {
    try {
      await api('POST', '/api/me/delete', { password: $('#del-pw').value });
      location.href = '/?deleted=1';
    } catch (err) {
      setMsg($('#del-msg'), err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------
let watchTimer = null;
function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('event', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.level === 'urgent' || ev.level === 'success' || ev.level === 'warn') toast(ev.title || ev.message, ev.title ? ev.message : '', ev.level, ev.level === 'urgent' ? 15000 : 6000);
    // On the first page of your activity: it shows up at the top (the pages move along on the next load).
    if (listOpen('activity') && state.feedPage === 1) {
      const list = $('#feed');
      $('.empty', list)?.remove();
      list.prepend(feedItem(ev));
      while (list.children.length > FEED_PAGE_SIZE) list.lastElementChild.remove();
      state.feedTotal = (state.feedTotal || 0) + 1;
      renderFeedPager();
    }
    if (ev.type === 'billing' || ev.type === 'account') loadMe().catch(() => null);
  });
  // A drop watch looked, or found something (drops.js).
  es.addEventListener('drop', () => { if (listOpen('drops')) dropsUI.refreshSoon(); });
  es.addEventListener('watch', () => {
    if (listOpen('drops')) dropsUI.refreshSoon();
    if ($('[data-panel="monitor"]').hidden && $('[data-panel="aco"]').hidden) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => loadItems().catch(() => null), 300);
  });
  // Auto-checkout: a run started, moved on or ended (and the item it was for, disarmed).
  let acoTimer = null;
  es.addEventListener('aco', () => {
    if ($('[data-panel="aco"]').hidden) return;
    clearTimeout(acoTimer);
    acoTimer = setTimeout(() => Promise.all([loadAco(), loadItems()]).then(renderAco).catch(() => null), 250);
  });
  // Clear cart: a bag being emptied, or done.
  let bagsTimer = null;
  es.addEventListener('bags', () => {
    if ($('[data-panel="aco"]').hidden) return;
    clearTimeout(bagsTimer);
    bagsTimer = setTimeout(() => loadBags().then(renderBags).catch(() => null), 200);
  });
  es.addEventListener('monitor-feed', (e) => { monitorUI.onFeed(JSON.parse(e.data)); if (listOpen('drops')) dropsUI.refreshSoon(); });
  es.addEventListener('monitor-product', (e) => { monitorUI.onProduct(JSON.parse(e.data)); if (listOpen('drops')) dropsUI.refreshSoon(); });
  es.addEventListener('monitor-sweep', (e) => monitorUI.onSweep(JSON.parse(e.data)));
  // A checkpoint or virtual queue went up, or came down.
  es.addEventListener('monitor-gate', (e) => {
    const g = JSON.parse(e.data);
    state.gates = [...(state.gates || []).filter((x) => x.store !== g.store), g];
    renderGates();
  });
  // The card's backup changed (made, updated or deleted in an extension).
  es.addEventListener('card', (e) => {
    state.cardBackup = JSON.parse(e.data).backup;
    if (!$('[data-panel="checkout"]').hidden) { renderCardBackup(); renderCard().catch(() => null); }
  });
  es.addEventListener('devices', () => {
    if (!$('[data-panel="extension"]').hidden) {
      loadDevices().catch(() => null);
      loadLogins().then(renderLogins).catch(() => null);
    }
    if (listOpen('watch')) loadLogins().then(renderItems).catch(() => null);
    renderExtStatus().catch(() => null);
  });
}

// ---------------------------------------------------------------------------
await loadMe();
showTab();
connectStream();
if (state.me.entitlement.active) loadGates();
if (new URLSearchParams(location.search).get('welcome')) toast('Welcome!', 'Start with Membership, then the Extension tab and Discord.', 'success', 10000);
