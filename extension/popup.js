// Mugibot toolbar popup: connect your account, your card for checkout, your watchlist.
const $ = (id) => document.getElementById(id);
const ask = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));
const CONFIG = globalThis.MGB_CONFIG;
const dash = `${CONFIG.server}/app`;
const STATUS = { in_stock: 'In stock', preorder: 'Pre-order', out_of_stock: 'Sold out', coming_soon: 'Coming soon', not_listed: 'Not listed', not_found: 'Gone', blocked: 'Blocked', error: 'Error', pending: '…' };

function cardText(c) {
  if (!c || !c.saved) return 'Not saved yet: add it in Card settings';
  return `${c.brand} •••• ${c.last4} — ${c.ready ? 'ready for checkout' : c.needsPassphrase ? 'open Card settings once' : 'save it again'}`;
}

function checksText(l) {
  if (!l) return 'Waiting for the first run';
  const mins = Math.round((Date.now() - l.at) / 60000);
  return `${l.checked} checked ${mins < 1 ? 'just now' : `${mins} min ago`}${l.blocked ? ` · ${l.blocked} blocked` : ''}`;
}

function renderUpdate(u) {
  const box = $('update');
  // The Chrome Web Store copy updates itself: no Reload, nothing to replace.
  $('reload2-wrap').hidden = !!(u && u.fromStore);
  box.hidden = !(u && (u.available || u.retired));
  if (box.hidden) return;
  const host = new URL(u.url).host;
  let title;
  let text;
  let go = `${u.url}/app#update`;
  let goLabel = 'Update';
  let remove = false;
  if (u.retired) {
    title = 'This is an old copy';
    text = `${CONFIG.appName} from the Chrome Web Store is installed in this browser and does everything now. Remove this copy.`;
    go = null;
    remove = true;
  } else if (u.moved) {
    title = `${CONFIG.appName} has moved to ${host}`;
    text = `This copy was downloaded for ${new URL(CONFIG.server).host}, so it can't work with your dashboard at ${host}. ${u.store ? 'Get it from the Chrome Web Store instead: it updates itself.' : 'Download it again from there.'}`;
    if (u.store) { go = u.store; goLabel = 'Open the Chrome Web Store'; remove = true; }
  } else if (u.store && !u.fromStore) {
    title = `Get ${CONFIG.appName} from the Chrome Web Store`;
    text = 'That version updates itself, so you never have to replace it again. Install it, press Connect this browser on your dashboard, save your card in it, then remove this copy.';
    go = u.store;
    goLabel = 'Open the Chrome Web Store';
    remove = true;
  } else {
    title = `Update available: v${u.latest}`;
    text = `You have v${u.current}. Press Update for the new version and how to install it.`;
  }
  $('update-title').textContent = title;
  $('update-text').textContent = text;
  $('update-go').hidden = !go;
  if (go) { $('update-go').href = go; $('update-go').textContent = goLabel; }
  $('reload').hidden = remove;
  $('remove-copy').hidden = !remove;
}

async function render() {
  $('app-name').textContent = CONFIG.appName;
  $('open-dash').href = `${dash}#extension`;
  $('open-dash2').href = dash;
  const s = await ask({ type: 'status' });
  $('foot').textContent = s ? `v${s.version} · ${new URL(s.server).host}${s.update && s.update.fromStore ? ' · updates itself' : ''}` : '';
  renderUpdate(s && s.update);
  if (!s || !s.paired) {
    $('signed-out').hidden = false;
    $('signed-in').hidden = true;
    if (s && s.disconnected) $('pair-msg').textContent = 'This browser was disconnected from your account.';
    return;
  }
  $('signed-out').hidden = true;
  $('signed-in').hidden = false;
  $('who').textContent = s.user.username;
  $('plan').textContent = s.online ? (s.entitlement ? s.entitlement.label : '') : 'Offline';
  $('plan').className = `pill ${s.entitlement && !s.entitlement.active ? 'warn' : ''}`;
  $('card-status').textContent = cardText(s.card);
  $('card-settings').textContent = s.card && s.card.saved ? 'Card settings' : 'Add your card';
  $('checks-status').textContent = checksText(s.lastChecks);
  const sweeps = Object.values(s.lastSweeps || {}).filter((x) => Date.now() - x.at < 30 * 60 * 1000);
  $('sweeps').hidden = !sweeps.length;
  $('sweeps-list').textContent = '';
  for (const x of sweeps) {
    const li = document.createElement('li');
    const secs = Math.round((Date.now() - x.at) / 1000);
    li.textContent = `${x.name}: ${x.ok ? `${x.found} products` : `refused${x.status ? ` (HTTP ${x.status})` : ''}, backing off`} · ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`} ago`;
    li.className = x.ok ? '' : 'muted';
    $('sweeps-list').appendChild(li);
  }
  const st = await ask({ type: 'state' });
  const list = $('items');
  list.textContent = '';
  const shown = (st && st.items) || [];
  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Nothing on your watchlist yet — add SKUs in your dashboard.';
    list.appendChild(li);
  }
  for (const p of shown) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = p.url || dash;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = p.name;
    a.title = `${p.storeName} · SKU ${p.sku}`;
    const meta = document.createElement('span');
    meta.className = `muted st-${p.status}`;
    meta.textContent = STATUS[p.status] || p.status;
    li.append(a, meta);
    list.appendChild(li);
  }
}

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pair-msg').textContent = 'Connecting…';
  const r = await ask({ type: 'pair', code: $('pair-code').value });
  $('pair-msg').textContent = r && r.ok ? `Connected as ${r.user.username}` : (r && r.error) || 'Couldn\'t connect';
  $('pair-msg').className = `msg ${r && r.ok ? 'ok' : 'err'}`;
  if (r && r.ok) render();
});

$('check-now').addEventListener('click', async () => {
  $('check-now').disabled = true;
  $('checks-status').textContent = 'Checking…';
  await ask({ type: 'checkNow' });
  $('check-now').disabled = false;
  render();
});

async function reload(e) {
  if (e) e.preventDefault();
  await ask({ type: 'reload' });
}
$('reload').addEventListener('click', reload);
$('remove-copy').addEventListener('click', () => ask({ type: 'removeSelf' }));
$('reload2').addEventListener('click', reload);

$('check-update').addEventListener('click', async (e) => {
  e.preventDefault();
  $('check-update').textContent = 'Checking…';
  const u = await ask({ type: 'update' });
  renderUpdate(u);
  $('check-update').textContent = u && u.available ? 'Update available' : u && u.fromStore ? 'Up to date (updates itself)' : (u ? 'Up to date' : "Couldn't check");
});

render();
