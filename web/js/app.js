// The dashboard. Everything here is the signed-in member's own data.
import { $, $$, ApiError, ago, api, busy, h, initThemeToggle, money, setMsg, toast, when } from './common.js';
import { setupMonitor } from './monitor.js';

const STATUS = {
  in_stock: 'In stock', preorder: 'Pre-order open', out_of_stock: 'Sold out', coming_soon: 'Coming soon', not_listed: 'Not listed yet',
  not_found: 'Page gone', blocked: 'Blocked by site', error: 'Error', unknown: 'Unknown', pending: 'Checking soon', paused: 'Paused',
};
const FLOW = { verified: 'verified flow', beta: 'beta flow', draft: 'draft flow', none: 'alerts only' };

const state = { me: null, items: [], retailers: [], profiles: null, editing: null, ext: null, feedOldest: null, alerts: null };

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const TABS = ['watch', 'monitor', 'checkout', 'discord', 'extension', 'membership', 'activity', 'account'];
const loaders = {};

function showTab() {
  const [hash, productId] = location.hash.slice(1).split('/');
  // #update (from the extension's Update button) is the Extension tab's update steps;
  // #monitor/<product> (from a Discord alert's Price history button) opens that product.
  const tab = hash === 'update' ? 'extension' : TABS.includes(hash) ? hash : 'watch';
  if (tab === 'monitor' && $$('.side a.active')[0]?.dataset.tab === 'monitor' && productId) {
    monitorUI.openProduct(productId);
    return;
  }
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  $$('.side a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (loaders[tab]) {
    loaders[tab]().then(() => {
      if (hash === 'update') $('#ext-update').scrollIntoView({ block: 'start' });
      if (tab === 'monitor' && productId) monitorUI.openProduct(productId);
    }).catch(showError);
  }
}
window.addEventListener('hashchange', showTab);

const monitorUI = setupMonitor({ showError: (e) => showError(e) });
loaders.monitor = () => monitorUI.load();
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
  return { installed: true, version, paired: !!(hello && hello.paired), userId: hello && hello.userId, username: hello && hello.username };
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
    text = [h('b', {}, '✓ Extension connected. '), `⚡ Buy runs automatically in this browser. Version ${ext.version}.`];
    if (ext.version !== latest) {
      level = 'warn';
      text.push(' ', h('b', {}, `Version ${latest} is available — `), h('a', { href: '#update' }, 'update it'));
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

async function loadRetailers() {
  if (!state.retailers.length) state.retailers = (await api('GET', '/api/retailers')).retailers;
  return state.retailers;
}

async function loadAlerts() {
  state.alerts = (await api('GET', '/api/alerts')).alerts;
  return state.alerts;
}

loaders.extension = async () => {
  const store = state.me.app.chromeStoreUrl;
  $('#store-install').hidden = !store;
  if (store) $('#store-link').href = store;
  const [retailers, alerts] = await Promise.all([loadRetailers(), loadAlerts(), renderExtStatus(), loadDevices()]);
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
  const qty = h('input', { class: 'qty', type: 'number', min: '1', max: '10', value: String(it.quantity || 1), 'aria-label': `Quantity for ${it.name}` });
  qty.addEventListener('change', async () => {
    const q = Math.max(1, Math.min(10, parseInt(qty.value, 10) || 1));
    qty.value = q;
    await api('PUT', `/api/items/${it.id}`, { quantity: q }).catch(showError);
  });
  const buy = h('button', { class: 'btn primary small', type: 'button', disabled: !it.url, title: it.url ? '' : 'The product page hasn\'t been found yet' }, '⚡ Buy');
  buy.addEventListener('click', () => goBuy(it, qty));
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
  const meta = [it.storeName, `SKU ${it.sku}`, money(price), it.maxPrice != null ? `ping at ≤ ${money(it.maxPrice)}` : '', checked].filter(Boolean).join(' · ');
  const isAdmin = state.me.user.role === 'admin';
  return h('li', { class: it.monitor ? '' : 'off', dataset: { id: it.id } },
    h('div', { class: 'info' },
      h('div', { class: 'name' }, `${i + 1}. ${it.name}`, it.announce ? h('span', { class: 'pill info', title: 'Restocks are posted in the members\' Discord channel' }, '📣') : null),
      h('div', { class: 'meta' }, meta, ' ', h('span', { class: `flow flow-${it.flowStatus}` }, FLOW[it.flowStatus] || '')),
      it.error ? h('div', { class: 'meta warn-text' }, it.error) : null,
      !it.url ? h('div', { class: 'meta' }, 'Waiting for the product page to be listed — it\'s found automatically from the SKU.') : null),
    h('span', { class: `pill ${st}` }, STATUS[st] || st),
    h('div', { class: 'acts' },
      h('label', { class: 'small muted' }, 'Qty'), qty, buy,
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

function renderItems() {
  const list = $('#w-list');
  list.textContent = '';
  if (state.itemsInactive) list.append(h('li', { class: 'notice warn' }, 'Monitoring is paused while your account has no active membership.'));
  if (!state.items.length) list.append(h('li', { class: 'empty' }, 'Nothing on your watchlist yet — press "+ Add SKU".'));
  state.items.forEach((it, i) => list.append(itemRow(it, i)));
}

async function loadItems() {
  const r = await api('GET', '/api/items');
  state.items = r.items;
  state.itemsInactive = !r.active;
  renderItems();
}

async function checkNow(it) {
  try {
    await api('POST', `/api/items/${it.id}/check`);
    if (state.ext && state.ext.paired) askExtension('checkNow', {}, 60000);
    toast('Checking now', it.name);
  } catch (e) { showError(e); }
}

async function goBuy(it, qtyInput) {
  const quantity = Math.max(1, Math.min(10, parseInt(qtyInput.value, 10) || 1));
  // Open the tab straight away (browsers block pop-ups opened after a delay).
  const win = window.open('about:blank', '_blank');
  try {
    const r = await api('POST', `/api/items/${it.id}/go`, { quantity });
    if (win) {
      win.opener = null;
      win.location.href = r.url;
    } else {
      location.href = r.url;
    }
    if (!state.ext || !state.ext.paired) toast('Opened the product', "The extension isn't connected in this browser, so it won't add to bag automatically.", 'warn');
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
  $('#w-qty').value = it ? it.quantity : 1;
  $('#w-price').value = it && typeof it.price === 'number' ? it.price : '';
  $('#w-max').value = it && typeof it.maxPrice === 'number' ? it.maxPrice : '';
  $('#w-announce').checked = !!(it && it.announce);
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
      quantity: $('#w-qty').value, price: $('#w-price').value, maxPrice: $('#w-max').value, profileId: $('#w-profile').value,
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

loaders.watch = async () => {
  await Promise.all([loadItems(), renderExtStatus(), loadRetailers()]);
};

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

async function renderCard() {
  const box = $('#card-state');
  const ext = state.ext || await detectExtension();
  state.ext = ext;
  if (!ext.installed) { box.className = 'notice warn'; box.textContent = 'Install the extension (Extension tab) to save a card in this browser.'; return; }
  if (!ext.paired || ext.userId !== state.me.user.id) { box.className = 'notice warn'; box.textContent = 'Connect the extension to your account (Extension tab) first.'; return; }
  const r = await askExtension('cardStatus');
  const c = r && r.card;
  $('#card-open').textContent = c && c.saved ? 'Card settings' : 'Add your card';
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
  await loadProfiles();
  renderProfiles();
  await renderCard();
};

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
async function loadFeed(more = false) {
  const before = more && state.feedOldest ? `&before=${state.feedOldest}` : '';
  const { events } = await api('GET', `/api/events?limit=50${before}`);
  const list = $('#feed');
  if (!more) list.textContent = '';
  if (!events.length && !more) list.append(h('li', { class: 'empty' }, 'Nothing yet.'));
  events.forEach((ev) => list.append(feedItem(ev)));
  if (events.length) state.feedOldest = events[events.length - 1].id;
  $('#feed-more').hidden = events.length < 50;
}
loaders.activity = () => loadFeed(false);
$('#feed-more').addEventListener('click', () => loadFeed(true).catch(showError));

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
    const list = $('#feed');
    if (!$('[data-panel="activity"]').hidden) {
      $('.empty', list)?.remove();
      list.prepend(feedItem(ev));
    }
    if (ev.type === 'billing' || ev.type === 'account') loadMe().catch(() => null);
  });
  es.addEventListener('watch', () => {
    if ($('[data-panel="watch"]').hidden) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => loadItems().catch(() => null), 300);
  });
  es.addEventListener('monitor-feed', (e) => monitorUI.onFeed(JSON.parse(e.data)));
  es.addEventListener('monitor-product', () => monitorUI.onProduct());
  es.addEventListener('devices', () => {
    if (!$('[data-panel="extension"]').hidden) loadDevices().catch(() => null);
    renderExtStatus().catch(() => null);
  });
}

// ---------------------------------------------------------------------------
await loadMe();
showTab();
connectStream();
if (new URLSearchParams(location.search).get('welcome')) toast('Welcome!', 'Start with Membership, then the Extension tab and Discord.', 'success', 10000);
