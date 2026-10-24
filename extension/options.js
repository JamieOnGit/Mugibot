// Mugibot extension settings: account connection and the cards saved for checkout (one of them the default).
const $ = (id) => document.getElementById(id);
const MGB_CONFIG = globalThis.MGB_CONFIG;
const MAX_CARDS = 6;
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
  const cards = c.cards || [];
  const full = cards.length >= MAX_CARDS;
  $('card-saved').hidden = !c.saved;
  $('card-form').hidden = false;
  $('card-form-title').innerHTML = full ? `<b>You have ${MAX_CARDS} cards</b> <span class="muted">— remove one to add another (saving one you already have, by its number, updates it)</span>`
    : c.saved ? '<b>Add another card</b> <span class="muted">(or save one you already have again — by its number — to update it)</span>' : b ? '<b>…or save a different card</b>' : '<b>Save a card</b>';
  $('c-default-wrap').hidden = !cards.length;
  // A new install (or another browser): the cards in the account's backup, restored with its passphrase.
  $('restore-form').hidden = !(b && !c.ready);
  if (b) $('restore-label').textContent = `${label(b)}${b.count > 1 ? ` · and ${b.count - 1} more` : ''}`;
  if (c.saved) {
    const d = cards.find((x) => x.isDefault) || null;
    $('cards-count').textContent = cards.length > 1 ? `${cards.length} cards saved here · the default (★) is the one every checkout uses` : '';
    $('card-default-pill').hidden = cards.length < 2;
    $('card-label').textContent = `${label(c)}${c.label ? ` · ${c.label}` : ''}${c.hasCvc ? '' : ' · no CVV saved'}`;
    $('card-state').textContent = c.ready ? (c.expired ? 'Expired — save a new one' : 'Ready for checkout') : c.needsPassphrase ? 'Needs your old passphrase once' : "Couldn't be read — save it again";
    $('card-state').className = `pill ${c.ready && !c.expired ? 'ok' : 'warn'}`;
    $('upgrade-form').hidden = !c.needsPassphrase;
    $('rename').hidden = !d;
    $('rename').dataset.id = d ? d.id : '';
    $('remove').dataset.id = d ? d.id : '';
    $('remove').textContent = cards.length > 1 ? 'Remove this card' : 'Remove card from this browser';
    // Your other cards: each with its own buttons (make it the default, name it, remove it).
    const list = $('cards');
    list.textContent = '';
    for (const x of cards.filter((y) => !y.isDefault)) {
      const li = document.createElement('li');
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = `${label(x)}${x.label ? ` · ${x.label}` : ''}${x.hasCvc ? '' : ' · no CVV saved'}`;
      const state = document.createElement('span');
      state.className = `pill ${x.ready && !x.expired ? '' : 'warn'}`;
      state.textContent = !x.ready ? "Couldn't be read" : x.expired ? 'Expired' : 'Ready';
      li.append(what, state, button('Make default', 'card-make-default', x.id), button('Name it', 'card-rename', x.id), button('Remove', 'card-remove', x.id));
      list.append(li);
    }
  }
  // The backup in your account: of these cards — or of others (a card added or removed since, or another browser's).
  const same = !!(b && c.ready && backupIsOf(b, cards));
  $('backup-on').hidden = !(c.ready && same);
  $('backup-form').hidden = !(c.ready && b !== undefined && !same);
  $('backup-go').textContent = cards.length > 1 ? `Back up my ${cards.length} cards` : 'Back up my card';
  $('backup-other').textContent = b && !same ? (b.count > 1 || cards.length > 1 ? `Your account's backup has ${b.count || 1} card${(b.count || 1) === 1 ? '' : 's'} (the default: ${b.brand} •••• ${b.last4}) — not the ${cards.length} saved here now: backing up again replaces it with these.` : `Your account's backup is a different card (${b.brand} •••• ${b.last4}): backing up this one replaces it.`) : '';
}

const label = (x) => `${x.brand} •••• ${x.last4} · expires ${x.expMonth}/${String(x.expYear).slice(-2)}`;
const cardKey = (x) => `${x.last4}:${x.expMonth}:${x.expYear}`;

/** Is the account's backup of exactly the cards saved here (its default the same)? */
function backupIsOf(b, cards) {
  const here = cards.filter((x) => x.ready);
  const d = here.find((x) => x.isDefault) || here[0];
  if (!d || cardKey(b) !== cardKey(d)) return false;
  const theirs = (b.cards || [b]).map(cardKey).sort().join(',');
  return theirs === here.map(cardKey).sort().join(',');
}

function button(text, cls, id) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = cls;
  el.dataset.id = id;
  el.textContent = text;
  return el;
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
  const n = (r.status && r.status.count) || 1;
  say('saved-msg', n > 1 ? `Restored: your ${n} cards are ready for every checkout in this browser.` : 'Restored. Your card is ready for every checkout in this browser.', true);
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

async function removeCard(id) {
  const r = await ask({ type: 'vault', action: 'remove', cardId: id || undefined });
  // (The last one: the copy kept for extension updates goes too — said if Mugibot couldn't be reached to delete it.)
  if (r && r.error) say('saved-msg', r.error, false);
  else say('saved-msg', r && r.restoreError ? `Removed from this browser. ${r.restoreError}.` : '', !(r && r.restoreError));
  render();
}

$('remove').addEventListener('click', async () => {
  if (!confirm(($('cards').children.length ? 'Remove this card from this browser? Your next card becomes the default.' : 'Remove your card from this browser?'))) return;
  await removeCard($('remove').dataset.id);
});

async function renameCard(id) {
  const name = prompt('A name for this card ("Personal", "Business"…) — leave it empty for none:');
  if (name === null) return;
  const r = await ask({ type: 'vault', action: 'rename', cardId: id, label: name });
  say('saved-msg', r && r.error ? r.error : 'Named.', !(r && r.error));
  render();
}
$('rename').addEventListener('click', () => renameCard($('rename').dataset.id));

// Your other cards' buttons.
$('cards').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const id = b.dataset.id;
  if (b.classList.contains('card-make-default')) {
    const r = await ask({ type: 'vault', action: 'setDefault', cardId: id });
    say('saved-msg', r && r.error ? r.error : 'Done: that card is your default — every checkout uses it from now on.', !(r && r.error));
    render();
  } else if (b.classList.contains('card-rename')) {
    await renameCard(id);
  } else if (b.classList.contains('card-remove')) {
    if (!confirm('Remove this card from this browser?')) return;
    await removeCard(id);
  }
});

$('card-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const backup = $('c-backup').checked ? passphrase('c-pass', 'c-pass2', 'card-msg') : '';
  if (backup === null) return;
  const r = await ask({
    type: 'vault',
    action: 'save',
    card: { number: $('c-number').value, name: $('c-name').value, expiry: $('c-exp').value, cvc: $('c-cvc').value },
    // (Left empty: a card you already have keeps its name — "Name it" changes or clears one.)
    label: $('c-label').value.trim() || undefined,
    makeDefault: $('c-default').checked,
    passphrase: backup || undefined,
  });
  if (!r || r.error) return say('card-msg', (r && r.error) || "Couldn't save the card. Reload this page and try again.", false);
  for (const id of ['c-number', 'c-name', 'c-label', 'c-exp', 'c-cvc', 'c-pass', 'c-pass2']) $(id).value = '';
  $('c-backup').checked = false;
  $('c-default').checked = false;
  $('c-backup-fields').hidden = true;
  if (r.backupError) say('card-msg', `Saved in this browser — but the backup didn't go through: ${r.backupError}`, false);
  else {
    const st = r.status || {};
    const isDefault = st.defaultId && st.defaultId === st.savedId;
    const what = (st.count || 1) > 1 ? (isDefault ? 'It\'s your default: every ⚡ Buy fills it in at checkout from now on.' : 'Your default card is still the one checkouts use — press Make default on this one to use it instead.') : '⚡ Buy will fill it in at checkout from now on.';
    say('card-msg', `${backup ? 'Saved and backed up.' : 'Saved.'} ${what}`, true);
  }
  render();
});

render();
