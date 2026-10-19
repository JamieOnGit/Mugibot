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
  // (undefined: Mugibot couldn't be reached to say whether there's a backup.)
  const b = s.cardBackup;
  $('card-saved').hidden = !c.saved;
  $('card-form').hidden = false;
  $('card-form-title').innerHTML = c.saved ? '<b>Replace card</b>' : b ? '<b>…or save a different card</b>' : '<b>Save a card</b>';
  // A new install (or another browser): the card in the account's backup, restored with its passphrase.
  $('restore-form').hidden = !(b && !c.ready);
  if (b) $('restore-label').textContent = `${b.brand} •••• ${b.last4} · expires ${b.expMonth}/${String(b.expYear).slice(-2)}`;
  if (c.saved) {
    $('card-label').textContent = `${c.brand} •••• ${c.last4} · expires ${c.expMonth}/${String(c.expYear).slice(-2)}${c.hasCvc ? '' : ' · no CVV saved'}`;
    $('card-state').textContent = c.ready ? 'Ready for checkout' : c.needsPassphrase ? 'Needs your old passphrase once' : "Couldn't be read — save it again";
    $('card-state').className = `pill ${c.ready ? 'ok' : 'warn'}`;
    $('upgrade-form').hidden = !c.needsPassphrase;
  }
  const same = !!(b && c.ready && b.last4 === c.last4 && b.expMonth === c.expMonth && b.expYear === c.expYear);
  $('backup-on').hidden = !(c.ready && same);
  $('backup-form').hidden = !(c.ready && b !== undefined && !same);
  $('backup-other').textContent = b && !same ? `Your account's backup is a different card (${b.brand} •••• ${b.last4}): backing up this one replaces it.` : '';
}

$('c-backup').addEventListener('change', () => { $('c-backup-fields').hidden = !$('c-backup').checked; });

/** A card passphrase typed twice: the passphrase, or null (and why, in the message box). */
function passphrase(a, b, msgId) {
  const p = $(a).value;
  if (p.length < 10) { say(msgId, 'Use a card passphrase of at least 10 characters — a few words is easiest to remember.', false); return null; }
  if (p !== $(b).value) { say(msgId, "The two passphrases don't match.", false); return null; }
  return p;
}

$('restore-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await ask({ type: 'vault', action: 'restore', passphrase: $('restore-pass').value });
  $('restore-pass').value = '';
  if (!r || r.error) return say('restore-msg', (r && r.error) || "Couldn't restore the card. Reload this page and try again.", false);
  say('saved-msg', 'Restored. Your card is ready for every checkout in this browser.', true);
  render();
});

$('backup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = passphrase('backup-pass', 'backup-pass2', 'backup-msg');
  if (!p) return;
  const r = await ask({ type: 'vault', action: 'backup', passphrase: p });
  $('backup-pass').value = '';
  $('backup-pass2').value = '';
  if (!r || r.error) return say('backup-msg', (r && r.error) || "Couldn't back up the card. Reload this page and try again.", false);
  say('backup-msg', 'Backed up. Keep your card passphrase somewhere safe: Mugibot can\'t tell you what it is.', true);
  render();
});

$('unbackup').addEventListener('click', async () => {
  if (!confirm('Delete the backup of your card from your Mugibot account? The card stays in this browser.')) return;
  const r = await ask({ type: 'vault', action: 'unbackup' });
  say('backup-msg', r && r.error ? r.error : 'Backup deleted.', !(r && r.error));
  render();
});

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
  const r = await ask({ type: 'vault', action: 'remove' });
  // (The copy kept for extension updates goes too — said if Mugibot couldn't be reached to delete it.)
  say('saved-msg', r && r.restoreError ? `Removed from this browser. ${r.restoreError}.` : '', !(r && r.restoreError));
  render();
});

$('card-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const backup = $('c-backup').checked ? passphrase('c-pass', 'c-pass2', 'card-msg') : '';
  if (backup === null) return;
  const r = await ask({
    type: 'vault',
    action: 'save',
    card: { number: $('c-number').value, name: $('c-name').value, expiry: $('c-exp').value, cvc: $('c-cvc').value },
    passphrase: backup || undefined,
  });
  if (!r || r.error) return say('card-msg', (r && r.error) || "Couldn't save the card. Reload this page and try again.", false);
  for (const id of ['c-number', 'c-name', 'c-exp', 'c-cvc', 'c-pass', 'c-pass2']) $(id).value = '';
  $('c-backup').checked = false;
  $('c-backup-fields').hidden = true;
  if (r.backupError) say('card-msg', `Saved in this browser — but the backup didn't go through: ${r.backupError}`, false);
  else say('card-msg', backup ? 'Saved and backed up. ⚡ Buy will fill it in at checkout from now on.' : 'Saved. ⚡ Buy will fill it in at checkout from now on.', true);
  render();
});

render();
