// Mugibot extension settings: account connection and the card saved for checkout.
const $ = (id) => document.getElementById(id);
const MGB_CONFIG = globalThis.MGB_CONFIG;
const ask = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));

function say(id, text, ok) {
  $(id).textContent = text || '';
  $(id).className = `msg ${ok ? 'ok' : 'err'}`;
}

async function render() {
  $('app-name').textContent = MGB_CONFIG.appName;
  const s = await ask({ type: 'status' });
  $('foot').textContent = s ? `Version ${s.version} · account server ${s.server}` : '';
  const paired = !!(s && s.paired);
  $('acct-out').hidden = paired;
  $('acct-in').hidden = !paired;
  $('card-none-acct').hidden = paired;
  if (!paired) {
    $('card-saved').hidden = true;
    $('card-form').hidden = true;
    return;
  }
  $('who').textContent = s.user.username;
  $('plan').textContent = s.entitlement ? s.entitlement.label : 'Offline';
  const c = s.card || {};
  $('card-saved').hidden = !c.saved;
  $('card-form').hidden = false;
  $('card-form-title').innerHTML = c.saved ? '<b>Replace card</b>' : '<b>Save a card</b>';
  if (c.saved) {
    $('card-label').textContent = `${c.brand} •••• ${c.last4} · expires ${c.expMonth}/${String(c.expYear).slice(-2)}${c.hasCvc ? '' : ' · no CVV saved'}`;
    $('card-state').textContent = c.ready ? 'Ready for checkout' : c.needsPassphrase ? 'Needs your old passphrase once' : "Couldn't be read — save it again";
    $('card-state').className = `pill ${c.ready ? 'ok' : 'warn'}`;
    $('upgrade-form').hidden = !c.needsPassphrase;
  }
}

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await ask({ type: 'pair', code: $('pair-code').value });
  say('pair-msg', r && r.ok ? `Connected as ${r.user.username}` : (r && r.error) || "Couldn't connect", r && r.ok);
  render();
});

$('unpair').addEventListener('click', async () => {
  await ask({ type: 'unpair' });
  render();
});

$('upgrade-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await ask({ type: 'vault', action: 'upgrade', passphrase: $('upgrade-pass').value });
  $('upgrade-pass').value = '';
  say('saved-msg', r && r.error ? r.error : 'Done. Your card is ready for every checkout now.', !(r && r.error));
  render();
});

$('remove').addEventListener('click', async () => {
  if (!confirm('Remove your card from this browser?')) return;
  await ask({ type: 'vault', action: 'remove' });
  say('saved-msg', '', true);
  render();
});

$('card-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await ask({
    type: 'vault',
    action: 'save',
    card: { number: $('c-number').value, name: $('c-name').value, expiry: $('c-exp').value, cvc: $('c-cvc').value },
  });
  if (!r || r.error) return say('card-msg', (r && r.error) || "Couldn't save the card. Reload this page and try again.", false);
  for (const id of ['c-number', 'c-name', 'c-exp', 'c-cvc']) $(id).value = '';
  say('card-msg', 'Saved. ⚡ Buy will fill it in at checkout from now on.', true);
  render();
});

render();
