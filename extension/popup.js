// Mugibot toolbar popup: connect your account, unlock your card, see your watchlist.
const $ = (id) => document.getElementById(id);
const ask = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));
const CONFIG = globalThis.MGB_CONFIG;
const dash = `${CONFIG.server}/app`;
const STATUS = { in_stock: 'In stock', preorder: 'Pre-order', out_of_stock: 'Sold out', coming_soon: 'Coming soon', not_listed: 'Not listed', not_found: 'Gone', blocked: 'Blocked', error: 'Error', pending: '…' };

function cardText(c) {
  if (!c || !c.saved) return 'Not saved in this browser';
  return `${c.brand} •••• ${c.last4} — ${c.unlocked ? 'unlocked' : 'locked'}`;
}

function checksText(l) {
  if (!l) return 'Waiting for the first run';
  const mins = Math.round((Date.now() - l.at) / 60000);
  return `${l.checked} checked ${mins < 1 ? 'just now' : `${mins} min ago`}${l.blocked ? ` · ${l.blocked} blocked` : ''}`;
}

function renderUpdate(u) {
  const box = $('update');
  box.hidden = !(u && u.available);
  if (!u || !u.available) return;
  const host = new URL(u.url).host;
  $('update-title').textContent = u.moved ? `${CONFIG.appName} has moved to ${host}` : `Update available: v${u.latest}`;
  $('update-text').textContent = u.moved
    ? `This copy was downloaded for ${new URL(CONFIG.server).host}, so it can't work with your dashboard at ${host}. Download it again from there.`
    : `You have v${u.current}. Press Update for the new version and how to install it.`;
  $('update-go').href = u.store && !u.moved ? u.store : `${u.url}/app#update`;
}

async function render() {
  $('app-name').textContent = CONFIG.appName;
  $('open-dash').href = `${dash}#extension`;
  $('open-dash2').href = dash;
  const s = await ask({ type: 'status' });
  $('foot').textContent = s ? `v${s.version} · ${new URL(s.server).host}` : '';
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
  $('unlock-form').hidden = !(s.card && s.card.saved && !s.card.unlocked);
  $('lock').hidden = !(s.card && s.card.unlocked);
  $('checks-status').textContent = checksText(s.lastChecks);
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
    meta.textContent = `${STATUS[p.status] || p.status}${p.quantity > 1 ? ` · ×${p.quantity}` : ''}`;
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

$('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await ask({ type: 'vault', action: 'unlock', passphrase: $('unlock-pass').value, hours: 0 });
  $('unlock-pass').value = '';
  $('card-msg').textContent = r && r.error ? r.error : 'Unlocked until you close the browser.';
  $('card-msg').className = `msg ${r && r.error ? 'err' : 'ok'}`;
  render();
});

$('lock').addEventListener('click', async () => {
  await ask({ type: 'vault', action: 'lock' });
  $('card-msg').textContent = 'Locked.';
  render();
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
$('reload2').addEventListener('click', reload);

$('check-update').addEventListener('click', async (e) => {
  e.preventDefault();
  $('check-update').textContent = 'Checking…';
  const u = await ask({ type: 'update' });
  renderUpdate(u);
  $('check-update').textContent = u && u.available ? 'Update available' : (u ? 'Up to date' : "Couldn't check");
});

render();
