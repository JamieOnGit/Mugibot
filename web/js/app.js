// The dashboard. Everything here is the signed-in member's own data.
import { $, $$, ApiError, ago, api, busy, h, initThemeToggle, money, renderPager, setMsg, toast, when } from './common.js';
import { setupDrops } from './drops.js';
import { setupMonitor } from './monitor.js';
import { setupNews } from './news.js';

const STATUS = {
  in_stock: 'In stock', preorder: 'Pre-order open', out_of_stock: 'Sold out', coming_soon: 'Coming soon', in_store: 'In store only', not_listed: 'Not listed yet',
  not_found: 'Page gone', blocked: 'Blocked by site', error: 'Error', unknown: 'Unknown', pending: 'Checking soon', paused: 'Paused',
};
const FLOW = { verified: 'verified flow', beta: 'beta flow', draft: 'draft flow', none: 'alerts only' };

const state = { me: null, items: [], retailers: [], profiles: null, editing: null, ext: null, alerts: null, logins: null, aco: null, wPage: 1, feedPage: 1, feedTotal: 0, runsPage: 1, cardBackup: null };

// ---------------------------------------------------------------------------
// Pages: four in the sidebar (a tab bar at the bottom on phones), each showing a few sections in order
// ---------------------------------------------------------------------------
//   🔥 Drops     the live monitor: new drops and restocks, your watchlist, your armed items (and whether
//               each is ready to check out), drop watches, your activity
//   ⚡ Checkout  Auto-checkout (switch, limits, ready?, phone ⚡ Buy, bags, runs)
//   🧰 Setup     the extension (install, connect, store sign-ins, browsers), the delivery details and card
//               every checkout uses, then Discord and pings
//   👤 Account   membership, then your account
// The Monitor's admin pages (Settings, Check log) sit under Drops.
const PAGES = {
  monitor: ['monitor'], 'monitor-settings': ['monitor-settings'], 'monitor-log': ['monitor-log'],
  aco: ['aco'], setup: ['extension', 'checkout', 'discord'], account: ['membership', 'account'],
};
// Addresses from before (in DMs, emails, the extension's Update button): the page each is on now, and where on it.
const MOVED = { checkout: 'setup', extension: 'setup', discord: 'setup', update: 'setup', membership: 'account' };
const SCROLL_TO = { checkout: '[data-panel="checkout"]', discord: '[data-panel="discord"]', update: '#ext-update', membership: '[data-panel="membership"]' };
// The Monitor's own pages (Settings and Check log are for admins): the sidebar's Drops stays lit.
const MONITOR_PAGES = new Set(['monitor', 'monitor-settings', 'monitor-log']);
// The lists on the Drops page (tracked products, your watchlist, your armed items, your drop watches,
// the release news, your activity). #watch and #activity — the old tabs, still in links and DMs —
// #armed, #drops and #news open the Drops page at that list.
const LISTS = ['tracked', 'watch', 'armed', 'drops', 'news', 'activity'];
const LIST_HASH = { watch: 'watch', armed: 'armed', drops: 'drops', news: 'news', activity: 'activity' };
const LIST_KEY = 'mgb-list';
const loaders = {};

function showTab() {
  const [hash, productId] = location.hash.slice(1).split('/');
  // #update (from the extension's Update button) is Setup's update steps; #checkout, #discord and
  // #membership (from before) are parts of Checkout, Setup and Account; #monitor/<product> (from a
  // Discord alert's Price history button) opens that product.
  if (LIST_HASH[hash]) state.list = LIST_HASH[hash];
  const tab = LIST_HASH[hash] ? 'monitor' : PAGES[hash] ? hash : MOVED[hash] || 'monitor';
  if (tab === 'monitor' && $$('.side a.active')[0]?.dataset.tab === 'monitor' && productId) {
    monitorUI.openProduct(productId);
    return;
  }
  const panels = PAGES[tab];
  $$('[data-panel]').forEach((p) => { p.hidden = !panels.includes(p.dataset.panel); });
  $$('.jump').forEach((n) => { n.hidden = n.dataset.for !== tab; });
  document.body.classList.toggle('wide-main', MONITOR_PAGES.has(tab)); // the monitor uses the full width
  $$('.side a').forEach((a) => {
    const on = a.dataset.tab === tab || (a.dataset.tab === 'monitor' && MONITOR_PAGES.has(tab));
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $$('.mon-tabs a').forEach((a) => { a.classList.toggle('active', a.dataset.mtab === tab); if (a.dataset.mtab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const go = SCROLL_TO[hash] && $(SCROLL_TO[hash]);
  if (!go) window.scrollTo(0, 0);
  Promise.all(panels.map((p) => (loaders[p] ? loaders[p]() : null))).then(() => {
    if (go) go.scrollIntoView({ block: 'start' });
    if (tab === 'monitor' && productId) monitorUI.openProduct(productId);
  }).catch(showError);
}
window.addEventListener('hashchange', showTab);
// The row at the top of a page with several parts: straight to each one.
$$('.jump [data-jump]').forEach((b) => b.addEventListener('click', () => {
  const el = $(b.dataset.jump);
  if (el) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}));

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
// 📰 News: what's being released, when and at which stores (news.js).
const newsUI = setupNews({ isAdmin: () => !!state.me && state.me.user.role === 'admin' });

// --- The lists on the Drops page --------------------------------------------
function savedList() {
  try { const v = localStorage.getItem(LIST_KEY); return LISTS.includes(v) ? v : null; } catch { return null; }
}

/** Show one of the Drops page's lists. Members start at Tracked products; before a membership, your watchlist. */
async function showList(name, { load = true } = {}) {
  const member = state.me.entitlement.active;
  // (No choice yet: what the monitor tracks — or, before a membership, your watchlist.)
  let list = LISTS.includes(name) ? name : savedList() || (member ? 'tracked' : 'watch');
  if ((list === 'tracked' || list === 'drops' || list === 'armed' || list === 'news') && !member) list = 'watch';
  state.list = list;
  for (const b of $$('.mon-ptab')) {
    const on = b.dataset.ptab === list;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }
  for (const p of $$('.mon-ppanel')) p.hidden = p.dataset.ppanel !== list;
  $('#w-add-toggle').hidden = list !== 'watch';
  $('#sl-add').hidden = list !== 'watch';
  if (!load) return;
  if (list === 'watch') await loadWatch();
  else if (list === 'armed') await loadArmed();
  else if (list === 'drops') await dropsUI.load();
  else if (list === 'news') await newsUI.load();
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
  $('#pt-armed').hidden = !state.me.entitlement.active;
  $('#pt-drops').hidden = !state.me.entitlement.active;
  $('#pt-news').hidden = !state.me.entitlement.active;
  renderLoadout().catch(() => null);
  await Promise.all([monitorUI.load(), showList(state.list)]);
};

/**
 * Your loadout, at the top of Drops: is everything ready for the next drop? Your membership,
 * Auto-checkout (on, and how many armed), this browser's extension and your saved card — each a
 * chip that says so, and takes you to where it's set up when it isn't.
 */
async function renderLoadout() {
  const box = $('#loadout');
  const me = state.me;
  const [aco, ext] = await Promise.all([api('GET', '/api/aco?limit=1').catch(() => null), detectExtension()]);
  const mine = ext.installed && ext.paired && ext.userId === me.user.id;
  const card = mine ? ((await askExtension('cardStatus')) || {}).card : null;
  const chip = (tone, icon, label, sub, href) => h('a', { class: `lo-chip ${tone}`, href }, h('span', { class: 'lo-ic', 'aria-hidden': 'true' }, icon),
    h('span', { class: 'lo-tx' }, h('b', {}, label), sub ? h('small', {}, sub) : null));
  const minV = (aco && aco.extensionVersion) || me.app.extensionVersion;
  const chips = [
    me.entitlement.active ? chip(me.entitlement.warning ? 'warn' : 'ok', '⭐', 'Membership', me.entitlement.label || 'Active', '#membership') : chip('warn', '⭐', 'Start your membership', 'to see every drop', '#membership'),
    aco && aco.settings && aco.settings.enabled
      ? chip('ok', '🤖', 'Auto-checkout on', `${aco.armed || 0} armed`, '#aco')
      : chip('idle', '🤖', 'Auto-checkout off', aco && aco.armed ? `${aco.armed} armed` : 'arm an item to buy it the moment it drops', '#aco'),
    !ext.installed ? chip('warn', '🧩', 'Install the extension', 'for ⚡ Buy in this browser', '#extension')
      : !mine ? chip('warn', '🧩', 'Connect the extension', 'to your account', '#extension')
        : versionBelow(ext.version, minV) ? chip('warn', '🧩', `Update the extension`, `v${ext.version} → ${minV}`, '#update')
          : chip('ok', '🧩', 'Extension ready', `v${ext.version}`, '#extension'),
    card && card.ready ? chip('ok', '💳', `${card.brand} •••• ${card.last4}`, 'saved in this browser', '#checkout')
      : chip(mine ? 'warn' : 'idle', '💳', 'Save your card', 'it never leaves your browser', '#checkout'),
  ];
  box.replaceChildren(...chips);
  box.hidden = false;
  const stores = (state.retailers || []).filter((r) => !r.demo && r.id !== 'other').length;
  if (stores) $('#side-stores').textContent = `${stores} stores`;
}
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
  // A new copy of the extension (after an update): your card back from its copy, with no passphrase.
  const back = await syncCardKey().catch(() => null);
  if (back && back.restored) setMsg(msg, `Connected — and ${back.card.brand} •••• ${back.card.last4} is back in this browser.`, true);
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

/** One watchlist item. i: its place in `list` (its own list: the watchlist, or the Shop checkout links). */
function itemRow(it, i, list = state.items) {
  const st = statusOf(it);
  // (Another website: no ⚡ Buy — Mugibot checks out at the stores it knows. Its page is the way in.)
  // (×2: ⚡ Buy puts that many in the bag.)
  const many = it.quantity > 1 && !(it.shopLink && it.sku.includes(',')) ? ` ×${it.quantity}` : '';
  const buy = it.acoCan ? h('button', { class: 'btn primary small', type: 'button', disabled: !it.url, title: it.url ? (many ? `Puts ${it.quantity} in your bag` : '') : 'The product page hasn\'t been found yet' }, `⚡ Buy${many}`) : null;
  // The one-time ⚡ Buy code is asked for as the button goes down, so the store opens the moment it's clicked.
  buy?.addEventListener('pointerdown', () => primeBuy(it));
  buy?.addEventListener('click', () => goBuy(it));
  // (A Shop checkout link: its checkout opened again and again until the store's queue is up, then in line, then "Pay now".)
  const queue = it.shopLink && it.acoCan ? h('button', {
    class: 'btn small', type: 'button', disabled: !it.url,
    title: 'Opens the link now and, while the checkout says it isn\'t on sale yet, opens it again every 90 seconds until the store\'s queue is up — then waits in line (never refreshing it) and presses "Pay now" until the store takes the order',
  }, '🚦 Wait for queue, then ACO') : null;
  queue?.addEventListener('click', () => queueAco(it, queue));
  // (The same, by itself at a time you pick — a drop's: so it isn't going for hours before it.)
  const later = it.shopLink && it.acoCan ? h('button', {
    class: `btn small${it.queueAt ? ' primary' : ''}`, type: 'button', disabled: !it.url,
    title: it.queueAt ? `🚦 Wait for queue, then ACO starts by itself at ${whenAt(it.queueAt)} — press to change or cancel it` : 'Start 🚦 Wait for queue, then ACO by itself at a time you pick (your time zone)',
  }, it.queueAt ? `⏰ ${whenAt(it.queueAt)}` : '⏰ Schedule') : null;
  later?.addEventListener('click', () => scheduleQueueAco(it, later));
  const move = async (dir) => {
    const ids = state.items.map((x) => x.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const a = ids.indexOf(it.id);
    const b = ids.indexOf(list[j].id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    const r = await api('POST', '/api/items/reorder', { ids });
    state.items = r.items;
    renderItems();
  };
  const price = it.lastPrice ?? it.price;
  const checked = it.checkedAt ? `checked ${ago(it.checkedAt)}${it.statusSource === 'browser' ? ' by your browser' : ''}` : '';
  // (Another website's product goes by its address: its made-up code isn't one anyone uses.)
  // (A Shop checkout link: what's in it, as the store names its options — its code is the link.)
  const what = it.shopLink ? (it.title || `${it.sku.split(',').length} option${it.sku.includes(',') ? 's' : ''} in the link`) : it.acoCan ? `SKU ${it.sku}` : '';
  const meta = [it.storeName, what, money(price), it.quantity > 1 && !(it.shopLink && it.sku.includes(',')) ? `× ${it.quantity}` : '', it.maxPrice != null ? `ping at ≤ ${money(it.maxPrice)}${it.quantity > 1 && !it.shopLink ? ' each' : ''}` : '', it.discount ? `🏷️ code ${it.discount}` : '', it.queueAt ? `⏰ 🚦 starts ${whenAt(it.queueAt)}` : '', checked].filter(Boolean).join(' · ');
  const isAdmin = state.me.user.role === 'admin';
  return h('li', { class: it.monitor ? '' : 'off', dataset: { id: it.id } },
    h('div', { class: 'info' },
      h('div', { class: 'name' }, `${i + 1}. ${it.name}`, it.announce ? h('span', { class: 'pill info', title: 'Restocks are posted in the members\' Discord channel' }, '📣') : null,
        it.aco ? h('a', { class: 'pill aco-pill', href: '#aco', title: 'Bought by itself when it drops (Auto-checkout)' }, '🤖 Armed') : null,
        it.dropWatch ? h('a', { class: 'pill info', href: '#drops', title: 'Found by one of your drop watches (it goes when the watch does)' }, '🎯') : null),
      h('div', { class: 'meta' }, meta, ' ', h('span', { class: `flow flow-${it.flowStatus}` }, FLOW[it.flowStatus] || '')),
      it.error ? h('div', { class: 'meta warn-text' }, it.error) : null,
      it.shopLink ? shopSeenLine(it) : null,
      !it.url ? h('div', { class: 'meta' }, 'Waiting for the product page to be listed — it\'s found automatically from the SKU.') : null),
    h('span', { class: `pill ${st}` }, STATUS[st] || st),
    h('div', { class: 'acts' },
      buy,
      queue,
      later,
      // (A Shop checkout link opens Shop's checkout: Open would start one, so it isn't offered.)
      it.url && !it.shopLink ? h('a', { class: 'btn small', href: it.url, target: '_blank', rel: 'noopener' }, 'Open ↗') : null,
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
  // (Shop checkout links have a section of their own, below.)
  const items = state.items.filter((it) => !it.shopLink);
  $('#w-count').textContent = state.items.length ? String(state.items.length) : '';
  const pages = Math.max(1, Math.ceil(items.length / W_PAGE_SIZE));
  state.wPage = Math.min(Math.max(1, state.wPage || 1), pages);
  renderPager($('#w-pager'), { page: state.wPage, size: W_PAGE_SIZE, total: items.length, label: 'Watchlist', onPage: (p) => { state.wPage = p; renderItems(); } });
  if (state.itemsInactive) list.append(h('li', { class: 'notice warn' }, 'Monitoring is paused while your account has no active membership.'));
  if (!items.length) list.append(h('li', { class: 'empty' }, 'Nothing on your watchlist yet — press "+ Add SKU", or ☆ Watch a product in Tracked products.'));
  // Signed out at a store you're watching: ⚡ Buy is faster signed in. (Shop: said in its own section.)
  const out = state.logins ? state.logins.stores.filter((s) => s.status === 'out' && !s.cartLinks && items.some((it) => it.store === s.id)) : [];
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
  items.slice(from, from + W_PAGE_SIZE).forEach((it, i) => list.append(itemRow(it, from + i, items)));
  renderShopLinks();
}

/** A Shop checkout link: whether Shop's checkout knew you the last time the link was opened. */
function shopSeenLine(it) {
  const s = it.shopSeen;
  const by = s && s.how === 'run' ? 'Auto-checkout' : '⚡ Buy';
  if (s && s.status === 'in') return h('div', { class: 'sl-seen ok' }, `✅ Signed in to Shop on this link: its checkout opened with your Shop details (${by}, ${ago(s.at)}).`);
  if (s && s.status === 'out') return h('div', { class: 'sl-seen err' }, `⚠️ Signed out of Shop on this link: it went on to the store's guest checkout (${ago(s.at)}). Sign in to Shop in your checkout browser.`);
  return h('div', { class: 'sl-seen muted' }, 'Not opened yet: press ⚡ Buy once to check — it opens Shop\'s checkout, ticks the boxes and stops at "Pay now" (nothing is bought).');
}

/**
 * 🛍️ Shop checkout links: their own list, and whether you're signed in to Shop in your browsers (as
 * Shop's checkout last showed it) — signed out, Shop sends the link to the store's own checkout as a
 * guest, where Mugibot doesn't run.
 */
function renderShopLinks() {
  const links = state.items.filter((it) => it.shopLink);
  const list = $('#sl-list');
  list.textContent = '';
  $('#sl-count').textContent = links.length ? String(links.length) : '';
  if (!links.length) list.append(h('li', { class: 'empty' }, 'No checkout links yet — press "+ Add checkout link" and paste one.'));
  links.forEach((it, i) => list.append(itemRow(it, i, links)));
  const box = $('#sl-signin');
  box.textContent = '';
  const stores = state.logins ? state.logins.stores.filter((x) => x.cartLinks) : [];
  // (The real Shop, unless only the dummy store's copy is on your list.)
  const shop = stores.find((x) => links.some((it) => it.store === x.id)) || stores.find((x) => !x.demo) || stores[0];
  if (!shop) return;
  const where = shop.device ? ` in ${shop.device}` : '';
  const link = (label, primary) => h('a', { class: `btn small${primary ? ' primary' : ''}`, href: shop.signInUrl, target: '_blank', rel: 'noopener' }, label);
  // (Read on Shop's checkout itself — your email and saved details on it — never from shop.app's own
  //  pages: Shop Pay can know you on a checkout while those show you signed out.)
  if (shop.status === 'in') {
    box.className = 'notice ok';
    box.append(h('span', {}, `✅ Signed in to Shop${where} (seen on Shop's checkout ${ago(shop.at)}): your links open Shop's checkout with your details and card.`));
  } else if (shop.status === 'out') {
    box.className = 'notice err';
    box.append(h('span', {}, h('b', {}, `Signed out of Shop${where}: `), `a link went on to the store's own checkout as a guest ${ago(shop.at)}, where ⚡ Buy can't fill it in. Sign in to Shop in your checkout browser. (Auto-checkout still tries each drop, and says so if it happens again.)`), link('Sign in to Shop ↗', true));
  } else {
    box.className = 'notice warn';
    box.append(h('span', {}, `Not seen on Shop's checkout yet${where}. Press ⚡ Buy on a link once: it opens Shop's checkout and stops at "Pay now", and the link then says whether Shop knew you.`), link('Open Shop ↗', false));
  }
}

async function loadItems() {
  const r = await api('GET', '/api/items');
  state.items = r.items;
  state.itemsInactive = !r.active;
  renderItems();
  if (listOpen('armed')) renderArmed();
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
  // (Shop checkout links go by their link alone: + Add checkout link.)
  for (const r of state.retailers.filter((x) => !x.cartLinks)) sel.append(h('option', { value: r.id }, `${r.name}${r.flowStatus === 'verified' ? '' : ` (${r.flowStatus})`}`));
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

const W_HELP = "Paste the product link — or pick the store and type the SKU (handy before it's listed: Mugibot finds the page when it goes up).";
const SL_HELP = "Paste the store's checkout link: …/cart/<option>:<how many>, one or more of them (at a store that checks out with Shop). The max price is for the whole link, quantities included.";

/** The add / edit form: a SKU, or (shop: true, or a Shop checkout link) a Shop checkout link. */
async function editItem(it, { shop = false } = {}) {
  await Promise.all([loadRetailers(), loadProfiles()]);
  fillStoreSelect();
  fillProfileSelect(it ? it.profileId : '');
  state.editing = it ? it.id : null;
  const link = shop || !!(it && it.shopLink);
  $('#w-form').hidden = false;
  $('#w-form').dataset.mode = link ? 'shop' : 'sku';
  $('#w-form-title').textContent = it ? `Edit ${it.name}` : link ? 'Add a Shop checkout link' : 'Add a SKU';
  $('#w-form-help').textContent = link ? SL_HELP : W_HELP;
  $('#w-url-label').textContent = link ? 'Checkout link' : 'Product link ';
  if (!link) $('#w-url-label').append(h('span', { class: 'muted' }, '(optional if you enter the SKU)'));
  $('#w-url').placeholder = link ? 'https://creations.mattel.com/cart/48835830579405:2,40653613531341:1' : 'https://www.kmart.com.au/product/…-43818648/';
  $('#w-url').required = link;
  $('#w-store-row').hidden = link;
  $('#w-store-note').hidden = link;
  $('#w-save').textContent = it ? 'Save changes' : link ? 'Add checkout link' : 'Add SKU';
  $('#w-url').value = it ? it.url : '';
  $('#w-store').value = it && !it.url ? it.store : '';
  $('#w-sku').value = it ? it.sku : '';
  $('#w-name').value = it ? it.name : '';
  $('#w-price').value = it && typeof it.price === 'number' ? it.price : '';
  $('#w-max').value = it && typeof it.maxPrice === 'number' ? it.maxPrice : '';
  // (How many: 1 unless set. A Shop checkout link goes by the link's own numbers: …/cart/<number>:<quantity>.)
  $('#w-qty').value = it && it.quantity ? it.quantity : 1;
  $('#w-qty').disabled = !!link;
  $('#w-qty').parentElement.hidden = !!link;
  $('#w-announce').checked = !!(it && it.announce);
  $('#w-aco').checked = !!(it && it.aco);
  $('#w-discount-row').hidden = !link;
  $('#w-discount').value = (it && it.discount) || '';
  storeNote();
  setMsg($('#w-msg'), '');
  if (link) $('#w-form').scrollIntoView({ block: 'nearest' });
  $('#w-url').focus();
}

$('#w-add-toggle').addEventListener('click', () => editItem(null));
$('#sl-add').addEventListener('click', () => editItem(null, { shop: true }));
$('#w-cancel').addEventListener('click', () => { $('#w-form').hidden = true; state.editing = null; });
$('#w-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    const shop = $('#w-form').dataset.mode === 'shop';
    const body = {
      url: $('#w-url').value, store: shop ? '' : $('#w-store').value, sku: shop ? '' : $('#w-sku').value, name: $('#w-name').value,
      price: $('#w-price').value, maxPrice: $('#w-max').value, profileId: $('#w-profile').value, aco: $('#w-aco').checked,
    };
    // (A store's checkout link pasted in, …/cart/<number>:<quantity>: its own quantities, never the box's.)
    if (!$('#w-qty').disabled && !/\/cart\/\d+:\d+/.test(body.url)) body.quantity = $('#w-qty').value || 1;
    if (shop) body.discount = $('#w-discount').value.trim();
    if (state.me.user.role === 'admin') body.announce = $('#w-announce').checked;
    try {
      if (state.editing) await api('PUT', `/api/items/${state.editing}`, body);
      else await api('POST', '/api/items', body);
      $('#w-form').hidden = true;
      state.editing = null;
      await loadItems();
      toast(body.url ? 'Watching' : 'Watching — looking for the product page', body.name || body.sku || (shop ? 'Checkout link' : 'SKU'), 'success');
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

// Your watchlist, on the Drops page.
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
  // Click & Collect when a store doesn't offer home delivery for an order (a pick-up-only pre-order): on unless
  // you say home delivery only — near your postcode, or where you say.
  const collect = h('input', { type: 'checkbox', name: 'collect', checked: p.collect !== false });
  const near = h('input', { id: `p-${index}-collectNear`, name: 'collectNear', type: 'text', maxlength: '60', placeholder: 'Your postcode', autocomplete: 'off' });
  near.value = p.collectNear || '';
  grid.append(
    h('div', { class: 'span2' }, h('label', { class: 'check' }, collect, h('span', {}, 'No home delivery for an order (a pick-up-only pre-order, say)? Click & Collect it from the nearest store instead'))),
    h('div', {}, h('label', { for: near.id }, 'Collect near (postcode or suburb, optional)'), near),
  );
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
    out.collect = $('[name="collect"]', c).checked;
    out.collectNear = $('[name="collectNear"]', c).value;
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

// --- 🔁 Your card through extension updates (from extension 1.20) --------------------------------
// The extension keeps a copy of your card in your account, locked with a key this dashboard keeps in this
// browser (its own storage, which outlives the extension: removing the extension, or loading a new copy,
// doesn't touch it). Mugibot's server keeps the locked copy and never has the key. Connect a new copy of
// the extension here and it's handed the key: your card is back, with no passphrase.
const restoreKeyName = () => `mgb-card-key:${state.me.user.id}`;

function storedRestoreKey() {
  try {
    const v = JSON.parse(localStorage.getItem(restoreKeyName()) || 'null');
    return v && typeof v.id === 'string' && typeof v.k === 'string' ? v : null;
  } catch { return null; }
}

/** This browser's restore key (made the first time) — or null where nothing can be kept (a private window). */
function restoreKeyHere() {
  const have = storedRestoreKey();
  if (have) return have;
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
  const key = { id: b64(crypto.getRandomValues(new Uint8Array(18))).replace(/\+/g, '-').replace(/\//g, '_'), k: b64(crypto.getRandomValues(new Uint8Array(32))) };
  try { localStorage.setItem(restoreKeyName(), JSON.stringify(key)); } catch { return null; }
  // (Only a key that's really kept: a copy under a lost key would be no use.)
  return storedRestoreKey() && storedRestoreKey().id === key.id ? key : null;
}

/**
 * Hand this browser's extension the restore key (once it's connected to your account, 1.20 or newer, and
 * it's switched on): it makes your card's copy under it — or, with no card in it (a new install), has your
 * card back from it. The extension's answer, or null.
 */
async function syncCardKey({ quiet = false } = {}) {
  const ext = state.ext && state.ext.installed ? state.ext : await detectExtension();
  state.ext = ext;
  if (!ext.installed || !ext.paired || ext.userId !== state.me.user.id) return null;
  if (!state.cardRestore) await loadCardBackup().catch(() => null);
  const r = state.cardRestore;
  if (!r || r.on === false || versionBelow(ext.version, r.extensionVersion || '1.20.0')) return null;
  const key = restoreKeyHere();
  if (!key) return null;
  const reply = await askExtension('cardKey', { key, has: r.copies.some((c) => c.id === key.id) }, 15000);
  state.restoreReply = reply;
  if (reply && reply.restored && !quiet) toast('Your card is back', `${reply.card.brand} •••• ${reply.card.last4} is ready in this browser again — no passphrase needed.`, 'success', 9000);
  if (reply && (reply.restored || reply.ok)) {
    await loadCardBackup().catch(() => null);
    if (!$('[data-panel="checkout"]').hidden) { renderCardRestore(); renderCardBackup(); renderCard().catch(() => null); }
  }
  return reply;
}

function renderCardRestore() {
  const box = $('#card-restore');
  if (!box) return;
  const r = state.cardRestore;
  box.textContent = '';
  if (!r) return;
  const key = storedRestoreKey();
  const mine = key && r.copies.find((c) => c.id === key.id);
  const others = r.copies.filter((c) => !key || c.id !== key.id).length;
  const ext = state.ext || {};
  const old = ext.installed && versionBelow(ext.version, r.extensionVersion || '1.20.0');
  const sw = h('button', { type: 'button', class: 'sn-sw', role: 'switch', id: 'card-restore-on', 'aria-checked': r.on ? 'true' : 'false', 'aria-label': 'Keep my card through extension updates' });
  sw.addEventListener('click', () => setCardRestore(!r.on));
  const status = !r.on ? 'Off: after an extension update you add your card again (or restore your passphrase backup).'
    : mine ? `${cardLabel(mine)} comes back by itself after an extension update in this browser — even a new copy of it: press Connect this browser (Setup) and it's there.`
      : old ? `Update the extension to ${r.extensionVersion} or newer, and from then on your card comes back by itself after every update.`
        : !ext.installed || !ext.paired ? 'Connect the extension in this browser, and save your card in it: it then comes back by itself after every update.'
          : 'Save your card in the extension, and it comes back by itself after every update (a copy is made in a moment).';
  box.append(h('div', { class: 'aco-switch-row' }, sw,
    h('div', {},
      h('b', {}, r.on ? '🔁 Keep my card through extension updates — on' : '🔁 Keep my card through extension updates — off'),
      h('div', { class: 'muted small' }, status,
        r.on ? ' Your account keeps a copy locked with a key that stays in this browser — Mugibot never has the key, so it can\'t open the copy. Clearing this site\'s data in your browser loses the key (the extension then makes a new copy).' : ''),
      r.on && (mine || others) ? h('div', { class: 'form-actions' },
        h('span', { class: 'muted small' }, `${r.copies.length} cop${r.copies.length === 1 ? 'y' : 'ies'} kept${others ? ` (${others} for another browser or address of this site)` : ''}.`),
        h('button', { class: 'btn small danger', type: 'button', id: 'card-restore-delete', onclick: deleteCardRestore }, 'Delete the copies')) : null)));
}

async function setCardRestore(on) {
  try {
    const r = await api('PUT', '/api/card-restore', { on });
    state.cardRestore = { ...state.cardRestore, ...r.restore };
    // Off: the key goes too, here and in the extension.
    if (!on) try { localStorage.removeItem(restoreKeyName()); } catch { /* private window */ }
    renderCardRestore();
    if (!on && document.documentElement.dataset.mugibotExtension) await askExtension('cardKey', { off: true }, 4000);
    if (on) await syncCardKey({ quiet: true });
    toast(on ? 'On' : 'Off', on ? 'Your card comes back by itself after an extension update.' : 'Your card isn\'t kept for extension updates: the copies are deleted.', 'success');
  } catch (e) {
    toast("Couldn't change it", e.message, 'warn');
  }
}

async function deleteCardRestore() {
  if (!confirm('Delete the copies of your card kept for extension updates? The card stays in the extensions it\'s saved in (each makes a new copy the next time you open this dashboard, unless you switch this off).')) return;
  try {
    const r = await api('DELETE', '/api/card-restore');
    state.cardRestore = { ...state.cardRestore, ...r.restore };
    renderCardRestore();
  } catch (e) {
    toast("Couldn't delete them", e.message, 'warn');
  }
}

// The card's backup in your account (locked in the extension with your card passphrase).
function renderCardBackup() {
  const box = $('#card-backup');
  const b = state.cardBackup;
  box.textContent = '';
  if (b) {
    box.append(h('p', {}, h('span', { class: 'pill ok' }, 'Backed up'), ' ', `${cardLabel(b)} is backed up in your account, locked with your card passphrase. Another browser (or computer) restores it with that passphrase (Card settings). Mugibot can't open it.`),
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
    box.append(h('p', { class: 'muted small' }, 'For another browser or computer: in Card settings you can back your card up to your account, locked with a card passphrase only you know, and restore it there with that passphrase.'));
  }
}

async function loadCardBackup() {
  const r = await api('GET', '/api/card-backup');
  state.cardBackup = r.backup;
  state.cardRestore = r.restore || null;
}

async function renderCard() {
  const box = $('#card-state');
  const ext = state.ext || await detectExtension();
  state.ext = ext;
  if (!ext.installed) { box.className = 'notice warn'; box.textContent = 'Install the extension (Setup page) to save a card in this browser.'; return; }
  if (!ext.paired || ext.userId !== state.me.user.id) { box.className = 'notice warn'; box.textContent = 'Connect the extension to your account (Setup page) first.'; return; }
  const r = await askExtension('cardStatus');
  const c = r && r.card;
  const b = state.cardBackup;
  $('#card-open').textContent = c && c.ready ? 'Card settings' : b ? 'Restore your card' : c && c.saved ? 'Card settings' : 'Add your card';
  // (A copy for updates that didn't open here: what went wrong.)
  const failed = state.restoreReply && state.restoreReply.ok === false && state.restoreReply.error;
  if ((!c || !c.ready) && failed) {
    box.className = 'notice warn';
    box.textContent = `Your card couldn't be brought back in this browser by itself (${failed}). Press ${b ? 'Restore your card and enter your card passphrase' : 'Add your card and save it again'}.`;
    return;
  }
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
        : `${label} — locked. Update the extension (Setup page) and the card stays ready without unlocking.`;
}
$('#card-open').addEventListener('click', async () => {
  const r = await askExtension('openCardSettings');
  if (!r) toast('Extension not found', 'Install and connect the extension first (Setup page).', 'warn');
});

loaders.checkout = async () => {
  await Promise.all([loadProfiles(), loadCardBackup().catch(() => null)]);
  renderProfiles();
  renderCardBackup();
  await renderCard();
  renderCardRestore();
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
const TRIGGER = { sweep: 'seen by the live monitor', server: 'seen by the monitor', browser: 'seen by your browser', manual: 'reported by an admin', test: 'test run (Trigger ACO)', queue: '🚦 Wait for queue, then ACO', remote: '⚡ Buy pressed in Discord' };
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

/** 11.0 s, 950 ms, 1 min 4 s. */
const secs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);

function renderAcoStats() {
  const s = state.aco.stats;
  const box = $('#aco-stats');
  box.textContent = '';
  const tile = (k, v, sub, tone = '') => h('div', { class: `aco-stat${tone ? ` ${tone}` : ''}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), sub ? h('div', { class: 's' }, sub) : null);
  box.append(
    tile('Orders placed', String(s.placed), [s.spent ? `${money(s.spent)} spent` : 'in the last 30 days', typeof s.medianMs === 'number' ? `typically ${secs(s.medianMs)} from drop to order (fastest ${secs(s.fastestMs)})` : ''].filter(Boolean).join(' · '), 'ok'),
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
}

// ---------------------------------------------------------------------------
// 🤖 Armed (a list on the Drops page): your watchlist's items for Auto-checkout, each with its switch,
// its max price, whether everything its run needs is ready, and its buttons
// ---------------------------------------------------------------------------
// The delivery details a checkout fills in (the email: the account's, when the address has none).
const ADDRESS_NEEDS = { firstName: 'first name', lastName: 'last name', phone: 'mobile', address1: 'street address', suburb: 'suburb', state: 'state', postcode: 'postcode' };
// A run that got to the store and ended without an order may have left its item in the bag.
const LEFT_IN_BAG = ['ready', 'needs_you', 'failed'];

async function loadArmed() {
  await Promise.all([
    loadAco(), loadLogins().catch(() => null), loadBags().catch(() => null), loadProfiles().catch(() => null), loadCardBackup().catch(() => null),
    renderExtStatus().catch(() => null),
  ]);
  // This browser's card, when it's the one that checks out (another browser's is reported by it).
  const mine = state.ext && state.ext.installed && state.ext.paired && state.ext.userId === state.me.user.id;
  state.armedCard = mine ? ((await askExtension('cardStatus')) || {}).card || null : null;
  renderArmed();
}

/** The browser Auto-checkout's runs go to, and whether it's this one. */
function checkoutBrowser() {
  const b = ((state.aco && state.aco.browsers) || []).find((x) => x.checkout) || null;
  return { b, here: !!(b && state.ext && state.ext.deviceId && b.id === state.ext.deviceId && state.ext.userId === state.me.user.id) };
}

/**
 * What one item's run needs, each check { key, label, tone: 'ok' | 'no' | 'warn' | 'na', text, fix }:
 * its bag at the store, signed in there, the card and the address it checks out with, and the browser
 * it checks out in. 'no' stops the run (or makes it stop for you); 'warn' slows it; 'na': nothing to do, or
 * can't tell from here.
 */
function readiness(it) {
  const { b: browser, here } = checkoutBrowser();
  const out = [];
  // 🧹 The bag: Auto-checkout buys the one item, so anything else in the store's bag stops it there.
  // (A Shop checkout link is its own order: no bag of yours behind it.)
  const bag = state.bags && state.bags.stores.find((x) => x.id === it.store);
  if (it.shopLink) out.push({ key: 'bag', label: 'Bag', tone: 'na', text: 'No bag: the link is the order, its quantities included' });
  else if (!bag) out.push({ key: 'bag', label: 'Bag', tone: 'na', text: 'No bag to empty from here at this store' });
  else if (bag.active) out.push({ key: 'bag', label: 'Bag', tone: 'warn', text: 'Being emptied now…' });
  else if (bag.status === 'cleared' || bag.status === 'empty') {
    const since = (state.aco.runs || []).find((r) => r.store === it.store && LEFT_IN_BAG.includes(r.status) && r.createdAt > (bag.at || 0));
    out.push(since
      ? { key: 'bag', label: 'Bag', tone: 'no', text: `A run at ${new Date(since.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ended without an order and may have left its item in your bag — empty it`, fix: 'bag' }
      : { key: 'bag', label: 'Bag', tone: 'ok', text: `Emptied ${ago(bag.at)}` });
  } else if (bag.status === 'failed' || bag.status === 'expired') out.push({ key: 'bag', label: 'Bag', tone: 'no', text: `Couldn't empty it: ${bag.message || bag.statusText}`, fix: 'bag' });
  else out.push({ key: 'bag', label: 'Bag', tone: 'warn', text: 'Not emptied from here yet: anything already in it stops the run — press Clear bag to be sure', fix: 'bag' });
  // 🔑 Signed in at the store: faster (the store fills in your saved details) — or needed, at some.
  const l = state.logins && state.logins.stores.find((x) => x.id === it.store);
  // (Never stops a run: it goes signed in or not — only a store that sells signed in alone stops it, at its own sign-in page.)
  if (!l || !l.at) out.push({ key: 'signin', label: 'Sign-in', tone: l && l.required ? 'warn' : 'na', text: l && l.required ? `${l.name} only sells signed in: open it once in your checkout browser and sign in` : 'Not seen yet: open the store once in your checkout browser', href: l && l.signInUrl });
  else if (l.status === 'in') out.push({ key: 'signin', label: 'Sign-in', tone: 'ok', text: `Signed in (${l.how === 'check' ? 'checked' : 'seen'} ${ago(l.at)})` });
  else if (l.status === 'out') {
    out.push({ key: 'signin', label: 'Sign-in', tone: 'warn', href: l.signInUrl,
      text: l.required ? `Seen signed out ${ago(l.at)} — ${l.name} only sells signed in: it still tries, and stops at its sign-in page if you are` : `Seen signed out ${ago(l.at)} — it checks out as a guest then (signed in is a little faster)` });
  } else out.push({ key: 'signin', label: 'Sign-in', tone: 'na', text: "Couldn't tell whether you're signed in", href: l.signInUrl });
  // 💳 The card, in the browser that checks out (a store that only takes PayPal stops there: no card needed).
  const card = here ? state.armedCard : browser ? browser.card : null;
  const saved = state.cardBackup;
  if (it.acoStops === 'paypal') out.push({ key: 'card', label: 'Card', tone: 'na', text: 'This store only takes PayPal: it stops there for you' });
  else if (it.shopLink) out.push({ key: 'card', label: 'Card', tone: 'na', text: 'Shop pays with the card saved in your Shop account' });
  else if (!browser) out.push({ key: 'card', label: 'Card', tone: 'no', text: 'Connect the extension in the browser you check out with', href: '#extension' });
  else if (card && card.ready) out.push({ key: 'card', label: 'Card', tone: 'ok', text: card.last4 ? `${card.brand} •••• ${card.last4} ready in ${browser.name}` : `Card ready in ${browser.name}` });
  else if (card && (card.saved || card.state === 'saved')) out.push({ key: 'card', label: 'Card', tone: 'no', text: `Saved in ${browser.name}, but not ready — open Card settings there`, href: '#checkout' });
  else if (card) {
    // (A copy kept for updates comes back by itself once the dashboard's opened there; a passphrase backup, with its passphrase.)
    const kept = state.cardRestore && state.cardRestore.on && state.cardRestore.copies[0];
    out.push({ key: 'card', label: 'Card', tone: 'no', href: '#checkout',
      text: kept ? `Not in ${browser.name} yet — open this dashboard there and ${kept.brand} •••• ${kept.last4} comes back by itself`
        : saved ? `Not in ${browser.name} yet — restore ${saved.brand} •••• ${saved.last4} there with your card passphrase (Card settings)`
          : `No card saved in ${browser.name} — add it (Setup → Delivery & card)` });
  }
  else out.push({ key: 'card', label: 'Card', tone: 'na', text: `Can't tell from here: ${browser.name} says once it's open with the extension up to date` });
  // 📦 The address this item is delivered to (its own, else your default).
  const profiles = (state.profiles && state.profiles.profiles) || [];
  const p = profiles.find((x) => x.id === it.profileId) || profiles.find((x) => x.id === (state.profiles && state.profiles.defaultId)) || profiles[0];
  const missing = p ? Object.keys(ADDRESS_NEEDS).filter((k) => !String(p[k] || '').trim()) : Object.keys(ADDRESS_NEEDS);
  if (p && !p.email && !state.me.user.email) missing.push('email');
  out.push(it.shopLink ? { key: 'addr', label: 'Address', tone: 'na', text: 'Shop delivers to the address saved in your Shop account' } : !missing.length
    ? { key: 'addr', label: 'Address', tone: 'ok', text: `Delivers to ${p.label || 'your address'} (${p.suburb} ${p.state})` }
    : { key: 'addr', label: 'Address', tone: 'no', text: `Delivery details missing: ${missing.map((k) => ADDRESS_NEEDS[k] || k).join(', ')}`, href: '#checkout' });
  // 🧩 The checkout browser: connected, up to date, open and listening (runs wait 2 minutes for it).
  // (A store the extension checks out at from a later version: Shop checkout links, on Shop's checkout.)
  const minV = it.acoVersion && versionBelow(state.aco.extensionVersion || '1.10.0', it.acoVersion) ? it.acoVersion : state.aco.extensionVersion || '1.10.0';
  if (!browser) out.push({ key: 'browser', label: 'Browser', tone: 'no', text: 'No browser connected — install and connect the extension (Setup)', href: '#extension' });
  else if (versionBelow(browser.version, minV)) out.push({ key: 'browser', label: 'Browser', tone: 'no', text: `Update the extension in ${browser.name} to ${minV} or newer (it has ${browser.version || 'an older one'})`, href: '#update' });
  else if (browser.listening) out.push({ key: 'browser', label: 'Browser', tone: 'ok', text: `${browser.name} is open and listening` });
  else if (!it.aco) out.push({ key: 'browser', label: 'Browser', tone: 'na', text: `${browser.name} starts listening once something's armed` });
  else out.push({ key: 'browser', label: 'Browser', tone: 'no', text: `${browser.name} isn't open right now: keep Chrome open there (a run waits 2 minutes for it)` });
  return out;
}

/** What stops this item's run before any check: no checkout at the store, no page yet, no max price… */
function blockers(it) {
  const s = state.aco.settings;
  const price = it.lastPrice ?? it.price;
  return [
    !it.acoCan ? 'no checkout for this store yet' : '',
    it.acoCan && !it.url ? 'its product page hasn\'t been found yet' : '',
    it.maxPrice == null ? 'set a max price' : '',
    it.maxPrice != null && typeof price === 'number' && price > it.maxPrice ? `it's ${money(price)} now, over your max` : '',
    it.maxPrice != null && it.maxPrice > s.maxOrder ? `your max is over your ${money(s.maxOrder)} an order limit` : '',
  ].filter(Boolean);
}

/** The line at the top: Auto-checkout on or off, how many are armed, and how many of those are ready. */
function renderArmedState(armed, ready) {
  const s = state.aco.settings;
  const box = $('#ar-state');
  box.textContent = '';
  box.className = `ar-state notice ${!s.enabled ? 'warn' : armed && ready < armed ? 'warn' : armed ? 'ok' : ''}`;
  if (!s.enabled) {
    box.append(h('b', {}, '🤖 Auto-checkout is off. '), armed ? `${armed} armed, but nothing is bought by itself until you ` : 'Nothing is bought by itself until you ', h('a', { href: '#aco' }, 'switch it on'), '.');
    return;
  }
  box.append(h('b', {}, s.mode === 'place' ? '🤖 Auto-checkout is on — it places the order. ' : '🤖 Auto-checkout is on — it stops at the final button for you. '),
    !armed ? 'Arm an item below (with its max price) and it\'s bought the moment it drops.'
      : ready === armed ? `${armed} armed, ${armed === 1 ? 'and it\'s' : 'all'} ready to check out.`
        : `${armed} armed, ${ready} ready — the ✗ checks below say what to fix.`);
}

// Armed: 10 to a page (the page kept while things change).
const ACO_PAGE_SIZE = 10;
function renderArmed() {
  if (!state.aco) return;
  const list = $('#aco-items');
  list.textContent = '';
  const s = state.aco.settings;
  const armedItems = state.items.filter((it) => it.aco);
  const isReady = (it) => !blockers(it).length && !readiness(it).some((c) => c.tone === 'no');
  $('#aco-armed-count').textContent = armedItems.length ? String(armedItems.length) : '';
  renderArmedState(armedItems.length, armedItems.filter(isReady).length);
  const show = $('#aco-show').value;
  const items = state.items.filter((it) => show !== 'armed' || it.aco);
  const pages = Math.max(1, Math.ceil(items.length / ACO_PAGE_SIZE));
  state.acoPage = Math.min(Math.max(1, state.acoPage || 1), pages);
  renderPager($('#aco-pager'), { page: state.acoPage, size: ACO_PAGE_SIZE, total: items.length, label: 'Armed items', onPage: (p) => { state.acoPage = p; renderArmed(); } });
  $('#ar-ready').disabled = !armedItems.length;
  if (!items.length) {
    list.append(h('li', { class: 'empty' }, show === 'armed'
      ? 'Nothing armed yet — show every item and switch one on.'
      : ['Your watchlist is empty — add SKUs on ', h('a', { href: '#watch' }, 'My watchlist'), ' (or ☆ Watch a tracked product), then arm them here.']));
    return;
  }
  const lastRun = (id) => (state.aco.runs || []).find((r) => r.itemId === id);
  const device = state.bags && state.bags.device;
  const bagsOld = !!device && versionBelow(device.version, state.bags.extensionVersion);
  const from = (state.acoPage - 1) * ACO_PAGE_SIZE;
  for (const it of items.slice(from, from + ACO_PAGE_SIZE)) {
    const can = it.acoCan;
    const toggle = h('button', { type: 'button', class: 'sn-sw', role: 'switch', 'aria-checked': it.aco ? 'true' : 'false', 'aria-label': `Auto-checkout ${it.name}`, disabled: !can });
    const max = h('input', { type: 'number', min: '0', step: '0.01', value: it.maxPrice ?? '', placeholder: 'Max', 'aria-label': `Max price for ${it.name}`, class: 'aco-max' });
    const save = async (patch) => {
      try {
        await api('PUT', `/api/items/${it.id}`, patch);
        await Promise.all([loadItems(), loadAco()]);
        renderArmed();
        if (patch.aco) askExtension('acoListen', {}, 4000).then(() => loadAco()).then(renderArmed).catch(() => null);
      } catch (e) {
        toast("Couldn't change it", e.message, 'warn');
        renderArmed();
      }
    };
    toggle.addEventListener('click', () => save({ aco: !it.aco, maxPrice: max.value }));
    max.addEventListener('change', () => save({ maxPrice: max.value }));
    const test = h('button', {
      type: 'button', class: 'btn small aco-test', disabled: !can || !s.enabled,
      title: !can ? 'No checkout for this store yet' : !s.enabled ? 'Switch Auto-checkout on first (Checkout page)' : 'Run Auto-checkout for this item now, as if it had just dropped',
    }, 'Trigger ACO');
    test.addEventListener('click', () => triggerAco(it, max, test));
    const bag = state.bags && state.bags.stores.find((x) => x.id === it.store);
    const clear = bag ? h('button', {
      type: 'button', class: 'btn small ar-clear', disabled: !device || bagsOld || bag.active, 'aria-label': `Clear cart at ${bag.name}`,
      title: !device ? 'Connect the extension in the browser you check out with (Setup)' : bagsOld ? `Update the extension in ${device.name} first` : `Empty your ${bag.name} bag in ${device.name}`,
    }, bag.active ? 'Emptying…' : 'Clear bag') : null;
    clear?.addEventListener('click', () => clearBags(bag.id, `Empty your ${bag.name} bag in ${device.name}?\n\nEverything in it is removed.`, $('#ar-msg')));
    const checks = readiness(it);
    const stop = blockers(it);
    const fix = [...stop, ...checks.filter((c) => c.tone === 'no').map((c) => c.text)];
    const run = lastRun(it.id);
    const ready = !fix.length;
    const meta = [it.storeName, `SKU ${it.sku}`, money(it.lastPrice ?? it.price)].filter(Boolean).join(' · ')
      + (!can ? '' : !it.acoPlaces ? (it.acoStops === 'paypal' ? ' · stops at PayPal here' : ' · stops at the final button here (its payment form is another site\'s)') : '');
    list.append(h('li', { class: `ar-row${it.aco ? ' armed' : ''}${it.aco && !ready ? ' unready' : ''}`, dataset: { id: it.id } },
      h('div', { class: 'sw' }, toggle),
      h('div', { class: 'info' },
        h('div', { class: 'name' }, h('span', { class: 'nm', title: it.name }, it.name),
          it.aco ? h('span', { class: `pill ${ready && s.enabled ? 'ok' : 'warn'}` }, !s.enabled ? 'Armed · Auto-checkout off' : ready ? 'Armed · ready' : `Armed · ${fix.length} to fix`) : null),
        h('div', { class: 'meta' }, meta),
        h('div', { class: 'ar-checks', role: 'list', 'aria-label': `Ready to check out ${it.name}?` }, ...checks.map((c) => {
          const mark = { ok: '✓', no: '✗', warn: '!', na: '–' }[c.tone];
          const attrs = { class: `ck ${c.tone}`, title: c.text, role: 'listitem', dataset: { check: c.key } };
          const body = [h('span', { class: 'mk', 'aria-hidden': 'true' }, mark), h('span', { class: 'lb' }, c.label), h('span', { class: 'sr-only' }, `: ${c.text}`)];
          return c.href ? h('a', { ...attrs, href: c.href, ...(c.href.startsWith('http') ? { target: '_blank', rel: 'noopener' } : {}) }, ...body) : h('span', attrs, ...body);
        })),
        it.aco && fix.length ? h('div', { class: 'ar-fix' }, `To fix: ${fix.join(' · ')}`) : null,
        run ? h('div', { class: `meta aco-last ${ACO_TONE[run.status] || ''}` }, `Last: ${ACO_ICON[run.status] || '⏳'} ${run.statusText}${run.reasonText ? ` — ${run.reasonText}` : ''}${typeof run.tookMs === 'number' ? ` · ⏱ ${secs(run.tookMs)}` : ''} · ${ago(run.createdAt)}`) : null),
      h('div', { class: 'max' }, h('label', { class: 'aco-max-wrap' }, h('span', { 'aria-hidden': 'true' }, '$'), max)),
      h('div', { class: 'acts' }, test, clear)));
  }
}

/** 🧹 Get ready: empty the bag at every store with something armed (in your checkout browser), and check sign-ins again. */
async function getReady() {
  const msg = $('#ar-msg');
  const stores = [...new Set(state.items.filter((it) => it.aco).map((it) => it.store))].filter((id) => state.bags && state.bags.stores.some((b) => b.id === id));
  if (!stores.length) { setMsg(msg, 'Nothing armed at a store whose bag can be emptied from here.'); return; }
  const names = stores.map((id) => state.bags.stores.find((b) => b.id === id).name);
  if (!confirm(`Empty your bag${stores.length === 1 ? '' : 's'} at ${names.join(', ')} in your checkout browser?\n\nEverything in ${stores.length === 1 ? 'it' : 'them'} is removed, so Auto-checkout finds ${stores.length === 1 ? 'it' : 'them'} empty when your item drops.`)) return;
  try {
    const r = await api('POST', '/api/bags/clear', { stores });
    setMsg(msg, `${r.device.name} is emptying ${stores.length === 1 ? `your ${names[0]} bag` : `your bags at ${names.join(', ')}, one at a time`}${r.listening ? '.' : " — it isn't open right now: it does it when it next is."}`, true);
    askExtension('acoListen', {}, 4000);
  } catch (e) {
    setMsg(msg, e.message);
  }
  // (Sign-ins too, where this browser can look.)
  if (state.ext && state.ext.paired && state.ext.userId === state.me.user.id) askExtension('checkLogins', {}, 30000).then(() => loadLogins()).then(() => listOpen('armed') && renderArmed()).catch(() => null);
  await loadBags().catch(() => null);
  renderArmed();
}
$('#ar-ready').addEventListener('click', getReady);
$('#ar-recheck').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try {
    await loadArmed();
    setMsg($('#ar-msg'), 'Up to date.', true);
  } catch (err) {
    showError(err);
  } finally {
    b.disabled = false;
  }
});
$('#aco-show').addEventListener('change', () => { state.acoPage = 1; renderArmed(); });

/** "2:45 am", or "Wed 2:45 am" when it isn't today — in this browser's time zone (AEDT, in Australia's east). */
function whenAt(ms) {
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}
/** This browser's time zone, as it's usually written ("AEDT"). */
function tzName() {
  try { return new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value; } catch { return 'your time'; }
}
/** A time typed in ("2:45 am", "2.45am", "14:30", "3"): the next one from now (today, or tomorrow once it's passed), or null. */
function nextTime(v) {
  const m = String(v || '').trim().toLowerCase().replace(/\s+/g, ' ').match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2] || 0);
  if (mm > 59) return null;
  if (m[3]) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (m[3].startsWith('p') ? 12 : 0);
  } else if (hh > 23) return null;
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  if (d.getTime() <= Date.now() + 30 * 1000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** ⏰ Schedule: 🚦 Wait for queue, then ACO by itself at a time you pick — or changed, or cancelled. */
async function scheduleQueueAco(it, btn) {
  const s = (state.aco && state.aco.settings) || {};
  if (!s.enabled || s.mode !== 'place') { toast('Auto-checkout first', 'Switch Auto-checkout on and set it to "Place the order for me" (Checkout page) — this presses "Pay now" for you.', 'warn', 9000); return; }
  const tz = tzName();
  const v = prompt(`⏰ 🚦 Wait for queue, then ACO by itself — ${it.name}\n\nAt what time (${tz})? For example 2:45 am. Today, or tomorrow once that time's passed.\n${it.queueAt ? `\nIt's set for ${whenAt(it.queueAt)} now. Leave it empty to cancel it.` : ''}`, it.queueAt ? new Date(it.queueAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
  if (v === null) return;
  const at = v.trim() ? nextTime(v) : null;
  if (v.trim() && !at) { toast("Couldn't read that time", 'Try 2:45 am, or 14:30.', 'warn'); return; }
  btn.disabled = true;
  try {
    await api('POST', `/api/items/${it.id}/queue-at`, { at });
    toast(at ? `⏰ Set for ${whenAt(at)} (${tz})` : '⏰ Cancelled', at ? `🚦 Wait for queue, then ACO starts by itself then, in your checkout browser — keep it open and the computer awake. It places a real order, within your limits.` : `${it.name} won't start by itself.`, 'success', 9000);
    askExtension('acoListen', {}, 4000);
    await loadItems();
  } catch (e) {
    toast("Couldn't set it", e.message, 'warn');
    btn.disabled = false;
  }
}

/** Wait for queue, then ACO (a Shop checkout link): a run now that gets in the store's queue the moment it's up, then places the order. */
async function queueAco(it, btn) {
  const s = (state.aco && state.aco.settings) || {};
  if (!s.enabled || s.mode !== 'place') { toast('Auto-checkout first', 'Switch Auto-checkout on and set it to "Place the order for me" (Checkout page) — this presses "Pay now" for you.', 'warn', 9000); return; }
  if (!confirm(`Wait for queue, then ACO: ${it.name}?\n\nYour checkout browser opens the link now. While the checkout says it isn't on sale yet, it opens the link again every 90 seconds — like refreshing — until the store's queue is up. In the queue it waits its turn and never refreshes it. Then, on the checkout, it presses "Pay now" every couple of seconds until the store takes the order: it PLACES A REAL ORDER, within your limits (up to ${money(it.maxPrice)} plus delivery). Sent back to the queue at the drop, it waits there again.\n\nKeep that computer on and the tab open. Stop it any time with the panel's Stop, or on the Checkout page.`)) return;
  btn.disabled = true;
  try {
    const { run } = await api('POST', `/api/aco/test/${it.id}`, { queue: true });
    if (run.status === 'skipped') toast("Auto-checkout didn't start", run.message || run.reasonText, 'warn');
    else toast('🚦 Waiting for the queue, then Auto-checkout', `Your checkout browser is opening ${it.storeName} — follow it here, or in the run history (Checkout page).`, 'success');
    askExtension('acoListen', {}, 4000);
    await Promise.all([loadItems(), loadAco()]);
  } catch (e) {
    toast("Couldn't start it", e.message, 'warn');
  } finally {
    btn.disabled = false;
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
    else toast('Auto-checkout test started', `Your checkout browser is opening ${it.storeName} — follow it here, or in the run history (Checkout page).`, 'success');
    // This browser picks it up now (it listens while something waits for it).
    askExtension('acoListen', {}, 4000);
    await Promise.all([loadItems(), loadAco()]);
    renderArmed();
  } catch (e) {
    toast("Couldn't trigger it", e.message, 'warn');
  } finally {
    btn.disabled = false;
  }
}

/** ■ Stop on a run that's still going: over on your account, and its browser presses nothing more. */
async function stopRun(r, btn) {
  if (!confirm(`Stop this Auto-checkout run?\n\n${r.name}\n\nYour checkout browser presses nothing more for it. Its tab is left as it is.`)) return;
  btn.disabled = true;
  try {
    const { run } = await api('POST', `/api/aco/runs/${r.id}/stop`);
    toast('Auto-checkout stopped', run && run.status === 'needs_you' ? '"Pay now" had been pressed — check your email from the store before buying it again.' : 'Nothing was bought.', 'success');
    await loadAco();
    renderAcoRuns();
  } catch (e) {
    toast("Couldn't stop it", e.message, 'warn');
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
    // (Each step: when, and how long after the drop — the run's first step.)
    const t0 = r.steps.length ? r.steps[0].at : r.createdAt;
    const steps = h('ol', { class: 'aco-steps' }, ...r.steps.map((x, i) => h('li', {},
      h('time', { datetime: new Date(x.at).toISOString(), title: when(x.at) }, new Date(x.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })),
      i ? h('span', { class: 'aco-dt', title: 'After the drop' }, `+${secs(x.at - t0)}`) : null,
      h('b', {}, ACO_STEP[x.status] || x.status), x.message ? ` — ${x.message}` : '')));
    list.append(h('li', { class: `aco-run st-${r.status}${r.active ? ' active' : ''}`, dataset: { id: r.id } },
      h('div', { class: 'head' },
        h('span', { class: 'ic', 'aria-hidden': 'true' }, icon),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, r.name),
          h('div', { class: 'meta' }, [state.retailers.find((x) => x.id === r.store)?.name || r.store, money2, TRIGGER[r.trigger] || '', r.mode === 'fill' ? 'stop at the final button' : '', typeof r.tookMs === 'number' ? `⏱ ${secs(r.tookMs)} drop to order` : ''].filter(Boolean).join(' · '))),
        h('span', { class: `pill ${ACO_TONE[r.status] || ''}` }, r.statusText),
        // (Still going — its tab closed by mistake, say, or not wanted any more: stopped from here.)
        r.active ? h('button', { class: 'btn small danger aco-stop', type: 'button', title: 'Stop this Auto-checkout run: its browser presses nothing more', onclick: (e) => stopRun(r, e.currentTarget) }, '■ Stop') : null,
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
    [extOk, extOk ? `Extension connected in this browser (v${ext.version})` : !ext.installed ? 'Install the extension in the browser you keep open' : !mine ? 'Connect the extension in this browser to your account' : `Update the extension to ${minV} or newer (this one is ${ext.version})`, 'Setup', '#extension'],
    [!!(card && card.ready), card && card.ready ? `${card.brand} •••• ${card.last4} saved in the extension`
      : backup ? `${backup.brand} •••• ${backup.last4} is backed up in your account — restore it in this browser with your card passphrase`
        : card && card.saved ? `${card.brand} •••• ${card.last4} saved in the extension — open Card settings once to make it ready` : 'Save your card in the extension (we never see it)', 'Card settings', '#checkout'],
    [!!(profile && profile.address1 && profile.email), profile && profile.address1 ? `Delivery details: ${profile.label} (${profile.suburb || profile.postcode})` : 'Save your delivery details', 'Delivery & card', '#checkout'],
    [!!state.me.user.discord, state.me.user.discord ? 'Discord connected: a DM for every attempt' : 'Connect Discord to get a DM for every attempt (optional)', 'Discord', '#discord'],
  ];
  if (checkout) {
    rows.push([isHere || checkout.listening, isHere ? 'This is your checkout browser: Auto-checkout and Discord\'s ⚡ Buy check out here'
      : `Your checkout browser is ${checkout.name}${checkout.listening ? ' (open now)' : ' — it isn\'t open right now'}: runs go there, not here (change it under "⚡ Buy from your phone")`, null, null]);
  }
  if (s.enabled || (s.remoteBuy && isHere)) {
    rows.push([!!(listening && listening.listening), listening && listening.listening ? (isHere && s.remoteBuy ? 'This browser is listening for runs — your armed items\' drops and Discord\'s ⚡ Buy. Keep Chrome open' : 'This browser is listening for your armed items to drop — keep Chrome open')
      : state.items.some((it) => it.aco) || isHere ? 'This browser isn\'t listening yet — reload this page, or check the extension is connected (and up to date)' : 'Arm an item on the Armed tab (Drops page), and this browser starts listening for it', 'Armed', '#armed']);
  }
  const armed = state.items.filter((it) => it.aco).length;
  rows.push([!!armed, armed ? `${armed} item${armed === 1 ? '' : 's'} armed — each one's own checks (bag, sign-in, card, address) are on the Armed tab` : 'Nothing armed yet', 'Arm an item', '#armed']);
  list.textContent = '';
  for (const [ok, text, label, href] of rows) {
    list.append(h('li', {}, h('span', { class: ok ? 'ok-mark' : 'no-mark', 'aria-hidden': 'true' }, ok ? '✓' : '✗'), h('span', {}, text, !ok && href ? [' — ', h('a', { href }, label)] : ok && href === '#armed' ? [' — ', h('a', { href }, 'see them')] : null)));
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
    note.append('Connect the extension in the browser on the computer you keep on (', h('a', { href: '#extension' }, 'Setup page'), ').');
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
  $('#bags-sum').textContent = !device ? "Connect the extension in the browser you check out with (Setup page), and its bags can be emptied from here."
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
async function clearBags(stores, question, msg = $('#bags-msg')) {
  if (!confirm(question)) return;
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
  if (listOpen('armed')) renderArmed();
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
      const r = await api('PUT', '/api/aco', { mode, maxOrder: $('#aco-max').value, perDay: $('#aco-perday').value, spendPerDay: $('#aco-spend').value });
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
// Your activity, on the Drops page: 20 to a page, newest first.
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
    if ($('[data-panel="aco"]').hidden && !listOpen('armed')) return;
    clearTimeout(acoTimer);
    acoTimer = setTimeout(() => Promise.all([loadAco(), loadItems()]).then(() => { renderAco(); if (listOpen('armed')) renderArmed(); }).catch(() => null), 250);
  });
  // Clear cart: a bag being emptied, or done.
  let bagsTimer = null;
  es.addEventListener('bags', () => {
    if ($('[data-panel="aco"]').hidden && !listOpen('armed')) return;
    clearTimeout(bagsTimer);
    bagsTimer = setTimeout(() => loadBags().then(() => { renderBags(); if (listOpen('armed')) renderArmed(); }).catch(() => null), 200);
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
    const d = JSON.parse(e.data) || {};
    if ('backup' in d) state.cardBackup = d.backup;
    if (d.restore) state.cardRestore = { ...state.cardRestore, ...d.restore };
    if (!$('[data-panel="checkout"]').hidden) { renderCardBackup(); renderCardRestore(); renderCard().catch(() => null); }
    if (listOpen('armed')) loadArmed().catch(() => null);
  });
  es.addEventListener('devices', () => {
    if (!$('[data-panel="extension"]').hidden) {
      loadDevices().catch(() => null);
      loadLogins().then(renderLogins).catch(() => null);
    }
    if (listOpen('watch')) loadLogins().then(renderItems).catch(() => null);
    if (listOpen('armed')) Promise.all([loadLogins(), loadAco()]).then(renderArmed).catch(() => null);
    renderExtStatus().catch(() => null);
  });
}

// ---------------------------------------------------------------------------
await loadMe();
showTab();
connectStream();
// (Once a page load: the extension here gets this browser's restore key — your card's copy for updates
// made, or, in a new copy of the extension, your card back.)
syncCardKey().catch(() => null);
if (state.me.entitlement.active) loadGates();
if (new URLSearchParams(location.search).get('welcome')) toast('Welcome!', 'Start with your membership (Account), then Setup: the extension and Discord.', 'success', 10000);
