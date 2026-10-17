/* Mugibot — your card, kept only in this browser.

   Save it once and ⚡ Buy fills it in at checkout from then on, even after
   the browser is closed and opened again. Nothing to unlock.

   The card is encrypted (AES-256-GCM) with a key this browser's Mugibot
   extension made for itself. The key can't be exported and is kept in the
   extension's own database; the encrypted card is saved under the account it
   belongs to. It is never sent to the Mugibot server, web pages can't read
   it, and another account connected to this browser can't see or use it.

   Cards saved by version 1.2 or older were encrypted with a passphrase.
   Entering it once (or saving the card again) moves the card over.

   A backup in your Mugibot account (optional, from 1.13): the card locked with
   a card passphrase only you know (PBKDF2-SHA256, 600,000 rounds → AES-256-GCM),
   made here. Mugibot keeps the locked copy and can't open it. A new install
   of the extension — or another browser — restores the card with that
   passphrase. Forget it, and the backup can't be opened by anyone: save the
   card again. */

globalThis.MGBVault = (function () {
  'use strict';

  var ITERATIONS = 310000; // the old passphrase cards (PBKDF2-SHA256)
  var BACKUP_ITERATIONS = 600000; // the backup in your account
  var MIN_PASSPHRASE = 10;
  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function b64(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(s) {
    return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); });
  }
  var vaultKey = function (userId) { return 'vault:' + userId; };
  var oldOpenKey = function (userId) { return 'card:' + userId; }; // an old card, unlocked before the update
  var aad = function (userId) { return enc.encode('mugibot-card:' + userId); };
  var backupAad = function (userId) { return enc.encode('mugibot-card-backup:' + userId); };

  // --- this browser's own key ------------------------------------------------
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('mugibot-vault', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('keys'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function inStore(db, mode, fn) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('keys', mode);
      var req = fn(tx.objectStore('keys'));
      tx.oncomplete = function () { resolve(req.result); };
      tx.onerror = tx.onabort = function () { reject(tx.error); };
    });
  }
  async function loadOrMakeKey() {
    var db = await openDb();
    try {
      var key = await inStore(db, 'readonly', function (s) { return s.get('card'); });
      if (key) return key;
      var made = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      try {
        await inStore(db, 'readwrite', function (s) { return s.add(made, 'card'); });
        return made;
      } catch (e) {
        // Made at the same moment elsewhere: use that one.
        var other = await inStore(db, 'readonly', function (s) { return s.get('card'); });
        if (other) return other;
        throw e;
      }
    } finally {
      db.close();
    }
  }
  var keyPromise = null;
  function browserKey() {
    if (!keyPromise) keyPromise = loadOrMakeKey().catch(function (e) { keyPromise = null; throw e; });
    return keyPromise;
  }

  // --- card details ----------------------------------------------------------
  function luhn(num) {
    var sum = 0;
    for (var i = 0; i < num.length; i++) {
      var d = +num[num.length - 1 - i];
      if (i % 2) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  }

  function brandOf(num) {
    if (/^4/.test(num)) return 'Visa';
    if (/^(5[1-5]|2[2-7])/.test(num)) return 'Mastercard';
    if (/^3[47]/.test(num)) return 'Amex';
    return 'Card';
  }

  /** Check and tidy card details. Throws an Error with a friendly message. */
  function normalizeCard(input) {
    var number = String(input.number || '').replace(/[\s-]/g, '');
    if (!/^\d{12,19}$/.test(number) || !luhn(number)) throw new Error('That card number doesn\'t look right');
    var name = String(input.name || '').trim().slice(0, 80);
    var m = String(input.expiry || '').match(/^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/);
    var expMonth = m ? parseInt(m[1], 10) : parseInt(input.expMonth, 10);
    var expYear = m ? parseInt(m[2], 10) : parseInt(input.expYear, 10);
    if (expYear < 100) expYear += 2000;
    if (!(expMonth >= 1 && expMonth <= 12) || !(expYear >= 2000 && expYear < 2100)) throw new Error('Expiry should look like MM/YY');
    var now = new Date();
    if (expYear < now.getFullYear() || (expYear === now.getFullYear() && expMonth < now.getMonth() + 1)) throw new Error('That card has expired');
    var cvc = String(input.cvc || '').trim();
    if (cvc && !/^\d{3,4}$/.test(cvc)) throw new Error('Security code (CVV) is 3 or 4 digits');
    return { number: number, name: name, expMonth: String(expMonth).padStart(2, '0'), expYear: String(expYear), cvc: cvc };
  }

  async function record(userId) {
    return (await chrome.storage.local.get(vaultKey(userId)))[vaultKey(userId)] || null;
  }

  async function store(userId, card) {
    var key = await browserKey();
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aad(userId) }, key, enc.encode(JSON.stringify(card)));
    var set = {};
    set[vaultKey(userId)] = {
      v: 2, iv: b64(iv), ct: b64(ct),
      last4: card.number.slice(-4), brand: brandOf(card.number), expMonth: card.expMonth, expYear: card.expYear, hasCvc: !!card.cvc, savedAt: Date.now(),
    };
    await chrome.storage.local.set(set);
    await chrome.storage.session.remove(oldOpenKey(userId));
  }

  /** The card in a saved record, or null if it can't be read (yet). */
  async function open(userId, rec) {
    if (rec.v === 2) {
      try {
        var key = await browserKey();
        var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv), additionalData: aad(userId) }, key, unb64(rec.ct));
        return JSON.parse(dec.decode(pt));
      } catch (e) {
        return null;
      }
    }
    // Saved with a passphrase by an older version. Unlocked before the update? Move it over now.
    var old = (await chrome.storage.session.get(oldOpenKey(userId)))[oldOpenKey(userId)];
    if (old && old.card) {
      await store(userId, old.card);
      return old.card;
    }
    return null;
  }

  async function save(userId, input) {
    if (!userId) throw new Error('Connect the extension to your account first');
    await store(userId, normalizeCard(input));
    return status(userId);
  }

  /** A card saved with a passphrase by an older version: enter it once to move the card over. */
  async function upgrade(userId, passphrase) {
    var rec = await record(userId);
    if (!rec) throw new Error('No card saved for this account');
    if (rec.v === 2) return status(userId);
    var card;
    try {
      var base = await crypto.subtle.importKey('raw', enc.encode(String(passphrase || '').normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
      var key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(rec.salt), iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv), additionalData: aad(userId) }, key, unb64(rec.ct));
      card = JSON.parse(dec.decode(pt));
    } catch (e) {
      throw new Error('Wrong passphrase');
    }
    await store(userId, card);
    return status(userId);
  }

  // --- the locked backup in your account ---------------------------------------
  async function passphraseKey(passphrase, salt, iterations, use) {
    var base = await crypto.subtle.importKey('raw', enc.encode(String(passphrase || '').normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, [use]);
  }

  /** The saved card, locked with a card passphrase, for your account. Throws an Error with a friendly message. */
  async function lock(userId, passphrase) {
    if (String(passphrase || '').length < MIN_PASSPHRASE) throw new Error('Use a card passphrase of at least ' + MIN_PASSPHRASE + ' characters — a few words is easiest to remember');
    var c = await card(userId);
    var rec = await record(userId);
    if (!c || !rec) throw new Error('Save your card in this browser first');
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var key = await passphraseKey(passphrase, salt, BACKUP_ITERATIONS, 'encrypt');
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: backupAad(userId) }, key, enc.encode(JSON.stringify(c)));
    return {
      v: 1, kdf: 'PBKDF2-SHA256', iterations: BACKUP_ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct),
      last4: rec.last4, brand: rec.brand, expMonth: rec.expMonth, expYear: rec.expYear, hasCvc: rec.hasCvc,
    };
  }

  /** Your card from its locked backup, kept in this browser from now on. A wrong passphrase: an Error. */
  async function unlock(userId, backup, passphrase) {
    if (!userId) throw new Error('Connect the extension to your account first');
    if (!backup || backup.kdf !== 'PBKDF2-SHA256') throw new Error('There is no card backup in your account');
    var c;
    try {
      var key = await passphraseKey(passphrase, unb64(backup.salt), backup.iterations, 'decrypt');
      var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(backup.iv), additionalData: backupAad(userId) }, key, unb64(backup.ct));
      c = JSON.parse(dec.decode(pt));
    } catch (e) {
      throw new Error('That card passphrase isn\'t right');
    }
    await store(userId, normalizeCard({ number: c.number, name: c.name, expMonth: c.expMonth, expYear: c.expYear, cvc: c.cvc }));
    return status(userId);
  }

  async function remove(userId) {
    await chrome.storage.session.remove(oldOpenKey(userId));
    await chrome.storage.local.remove(vaultKey(userId));
  }

  /** The card for checkout, or null. */
  async function card(userId) {
    if (!userId) return null;
    var rec = await record(userId);
    return rec ? open(userId, rec) : null;
  }

  async function status(userId) {
    if (!userId) return { saved: false, ready: false };
    var rec = await record(userId);
    if (!rec) return { saved: false, ready: false };
    var ready = !!(await open(userId, rec));
    if (ready && rec.v !== 2) rec = await record(userId);
    return {
      saved: true,
      ready: ready,
      unlocked: ready, // what dashboards from before 1.3 look for
      needsPassphrase: !ready && rec.v !== 2,
      unreadable: !ready && rec.v === 2,
      last4: rec.last4, brand: rec.brand, expMonth: rec.expMonth, expYear: rec.expYear, hasCvc: rec.hasCvc,
    };
  }

  return { save: save, upgrade: upgrade, remove: remove, card: card, status: status, normalizeCard: normalizeCard, lock: lock, unlock: unlock };
})();
