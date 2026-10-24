/* Mugibot — your cards, kept only in this browser.

   Save a card once and ⚡ Buy fills it in at checkout from then on, even after
   the browser is closed and opened again. Nothing to unlock. From 1.33 you can
   keep several (up to 6) and choose the default: the one every checkout uses.

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
   card again.

   A copy for reinstalls (from 1.20): the card locked with a key your Mugibot
   dashboard keeps in this browser (its own storage, which outlives the
   extension). Mugibot keeps the locked copy and never has the key, so it can't
   open it by itself. Update the extension — even remove it and load a new
   copy — and press Connect this browser: the dashboard hands the new copy its
   key, and your card is back, with no passphrase. Clearing the dashboard's
   site data in this browser loses the key (the card stays saved in the
   extension: it makes a new copy). */

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
  var restoreAad = function (userId, keyId) { return enc.encode('mugibot-card-restore:' + userId + ':' + keyId); };

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

  // --- your cards (from 1.33: several, one of them the default) ----------------------
  // The record: { v: 3, cards: [{ id, iv, ct, last4, brand, expMonth, expYear, hasCvc, label, savedAt }],
  // defaultId, savedAt } — each card encrypted on its own with this browser's key. A card saved by 1.3–1.32
  // (v: 2, the one card) is read as a list of one, and kept as v: 3 the next time anything changes.
  var MAX_CARDS = 6;
  var newId = function () {
    var b = crypto.getRandomValues(new Uint8Array(6));
    var s = 'c';
    for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  };
  var legacyId = function (rec) { return 'c' + Number(rec.savedAt || 0).toString(36); };
  var cleanLabel = function (v) { return String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30); };
  var expired = function (c) {
    var now = new Date();
    var y = +c.expYear;
    var m = +c.expMonth;
    return y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1);
  };

  /** The cards in a saved record (a 1.3–1.32 card: a list of one). A passphrase card (1.2 or older) isn't in it. */
  function cardsOf(rec) {
    if (!rec) return [];
    if (rec.v === 3) return Array.isArray(rec.cards) ? rec.cards : [];
    if (rec.v === 2) return [{ id: legacyId(rec), iv: rec.iv, ct: rec.ct, last4: rec.last4, brand: rec.brand, expMonth: rec.expMonth, expYear: rec.expYear, hasCvc: !!rec.hasCvc, label: '', savedAt: rec.savedAt || null }];
    return [];
  }
  function defaultOf(rec, cards) {
    var want = rec && rec.v === 3 ? rec.defaultId : null;
    return cards.find(function (c) { return c.id === want; }) || cards[0] || null;
  }

  /** One card, encrypted with this browser's key: what the record keeps of it. */
  async function seal(userId, card, id, label, savedAt) {
    var key = await browserKey();
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aad(userId) }, key, enc.encode(JSON.stringify(card)));
    return {
      id: id, iv: b64(iv), ct: b64(ct),
      last4: card.number.slice(-4), brand: brandOf(card.number), expMonth: card.expMonth, expYear: card.expYear, hasCvc: !!card.cvc,
      label: cleanLabel(label), savedAt: savedAt || Date.now(),
    };
  }

  /** A card in the record, opened — or null if it can't be read here. */
  async function openEntry(userId, entry) {
    try {
      var key = await browserKey();
      var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(entry.iv), additionalData: aad(userId) }, key, unb64(entry.ct));
      return JSON.parse(dec.decode(pt));
    } catch (e) {
      return null;
    }
  }

  async function writeCards(userId, cards, defaultId) {
    await chrome.storage.session.remove(oldOpenKey(userId));
    if (!cards.length) { await chrome.storage.local.remove(vaultKey(userId)); return; }
    var set = {};
    set[vaultKey(userId)] = { v: 3, cards: cards, defaultId: cards.some(function (c) { return c.id === defaultId; }) ? defaultId : cards[0].id, savedAt: Date.now() };
    await chrome.storage.local.set(set);
  }

  /** The record's cards and default, ready to change (a passphrase card from 1.2 or older: none — saving replaces it). */
  async function current(userId) {
    var rec = await record(userId);
    var cards = cardsOf(rec).slice();
    var d = defaultOf(rec, cards);
    return { rec: rec, cards: cards, defaultId: d ? d.id : null };
  }

  /**
   * Cards into this browser's list (restored, or the old single card moved over): one with the same
   * number as a card here takes its place, the others are added (up to the most kept). defaultNumber:
   * the card to make the default when there wasn't one. The new list's default id.
   */
  async function merge(userId, list, defaultNumber) {
    var now = await current(userId);
    var cards = now.cards;
    var opened = await Promise.all(cards.map(function (c) { return openEntry(userId, c); }));
    var defaultId = now.defaultId && opened[cards.findIndex(function (c) { return c.id === now.defaultId; })] ? now.defaultId : null;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var at = opened.findIndex(function (o) { return o && o.number === c.card.number; });
      if (at < 0) at = cards.findIndex(function (x, j) { return !opened[j] && x.last4 === c.card.number.slice(-4); }); // (one that can't be read here: the same card, by its last 4)
      if (at < 0 && cards.length >= MAX_CARDS) continue;
      var id = at >= 0 ? cards[at].id : newId();
      var entry = await seal(userId, c.card, id, c.label || (at >= 0 ? cards[at].label : ''), null);
      if (at >= 0) { cards[at] = entry; opened[at] = c.card; } else { cards.push(entry); opened.push(c.card); }
      if (!defaultId && defaultNumber && c.card.number === defaultNumber) defaultId = id;
    }
    await writeCards(userId, cards, defaultId);
    return defaultId;
  }

  /** The card for checkout from a saved record, or null if it can't be read (yet). (A passphrase card unlocked before the update: moved over now.) */
  async function openDefault(userId, rec, id) {
    if (rec.v === 2 || rec.v === 3) {
      var cards = cardsOf(rec);
      var entry = (id && cards.find(function (c) { return c.id === id; })) || defaultOf(rec, cards);
      return entry ? openEntry(userId, entry) : null;
    }
    // Saved with a passphrase by an older version. Unlocked before the update? Move it over now.
    var old = (await chrome.storage.session.get(oldOpenKey(userId)))[oldOpenKey(userId)];
    if (old && old.card) {
      await writeCards(userId, [await seal(userId, old.card, newId(), '', null)], null);
      return old.card;
    }
    return null;
  }

  /**
   * Save a card: a new one (added to your cards: up to 6), or — opts.id — one of yours replaced. The same
   * number as a card already here replaces that one. Your first card is the default; opts.makeDefault
   * makes this one the default. { ...status, savedId }.
   */
  async function save(userId, input, opts) {
    opts = opts || {};
    if (!userId) throw new Error('Connect the extension to your account first');
    var card = normalizeCard(input);
    var now = await current(userId);
    var cards = now.cards;
    var at = opts.id ? cards.findIndex(function (c) { return c.id === opts.id; }) : -1;
    if (at < 0) {
      var opened = await Promise.all(cards.map(function (c) { return openEntry(userId, c); }));
      at = opened.findIndex(function (o) { return o && o.number === card.number; });
    }
    if (at < 0 && cards.length >= MAX_CARDS) throw new Error('You can keep up to ' + MAX_CARDS + ' cards here — remove one first');
    var id = at >= 0 ? cards[at].id : newId();
    var label = opts.label !== undefined ? opts.label : at >= 0 ? cards[at].label : '';
    var entry = await seal(userId, card, id, label, null);
    if (at >= 0) cards[at] = entry; else cards.push(entry);
    await writeCards(userId, cards, opts.makeDefault || !now.defaultId ? id : now.defaultId);
    var st = await status(userId);
    st.savedId = id;
    return st;
  }

  /** Make one of your cards the default: the one every checkout uses. */
  async function setDefault(userId, id) {
    var now = await current(userId);
    if (!now.cards.some(function (c) { return c.id === id; })) throw new Error('That card isn\'t saved in this browser');
    if (now.defaultId !== id || now.rec.v !== 3) await writeCards(userId, now.cards, id);
    return status(userId);
  }

  /** Name one of your cards ("Business", "Amex for EB Games"…). */
  async function rename(userId, id, label) {
    var now = await current(userId);
    var c = now.cards.find(function (x) { return x.id === id; });
    if (!c) throw new Error('That card isn\'t saved in this browser');
    c.label = cleanLabel(label);
    await writeCards(userId, now.cards, now.defaultId);
    return status(userId);
  }

  /** A card saved with a passphrase by an older version: enter it once to move the card over. */
  async function upgrade(userId, passphrase) {
    var rec = await record(userId);
    if (!rec) throw new Error('No card saved for this account');
    if (rec.v === 2 || rec.v === 3) return status(userId);
    var card;
    try {
      var base = await crypto.subtle.importKey('raw', enc.encode(String(passphrase || '').normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
      var key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(rec.salt), iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv), additionalData: aad(userId) }, key, unb64(rec.ct));
      card = JSON.parse(dec.decode(pt));
    } catch (e) {
      throw new Error('Wrong passphrase');
    }
    await writeCards(userId, [await seal(userId, card, newId(), '', null)], null);
    return status(userId);
  }

  // --- what a backup or copy holds -------------------------------------------------------
  // Every card readable here, the default first at the top (what a 1.32 or older extension restores: the
  // default card), and all of them in cards (from 1.33). Meta: what the dashboard shows of them.
  async function payloadOf(userId) {
    var now = await current(userId);
    var opened = await Promise.all(now.cards.map(function (c) { return openEntry(userId, c); }));
    var list = [];
    for (var i = 0; i < now.cards.length; i++) if (opened[i]) list.push({ entry: now.cards[i], card: opened[i] });
    if (!list.length) return null;
    var d = list.find(function (x) { return x.entry.id === now.defaultId; }) || list[0];
    var top = d.card;
    var payload = {
      number: top.number, name: top.name, expMonth: top.expMonth, expYear: top.expYear, cvc: top.cvc,
      cards: list.map(function (x) { return { number: x.card.number, name: x.card.name, expMonth: x.card.expMonth, expYear: x.card.expYear, cvc: x.card.cvc, label: x.entry.label || '' }; }),
      defaultNumber: top.number,
    };
    var meta = {
      last4: d.entry.last4, brand: d.entry.brand, expMonth: d.entry.expMonth, expYear: d.entry.expYear, hasCvc: !!d.entry.hasCvc,
      count: list.length,
      cards: list.map(function (x) { return { last4: x.entry.last4, brand: x.entry.brand, expMonth: x.entry.expMonth, expYear: x.entry.expYear, hasCvc: !!x.entry.hasCvc, label: x.entry.label || '', isDefault: x === d }; }),
    };
    return { payload: payload, meta: meta };
  }

  /** The cards in an opened backup or copy (one from 1.32 or older: its one card), checked. */
  function cardsIn(p) {
    var list = Array.isArray(p.cards) && p.cards.length ? p.cards : [p];
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX_CARDS; i++) {
      try {
        out.push({ card: normalizeCard({ number: list[i].number, name: list[i].name, expMonth: list[i].expMonth, expYear: list[i].expYear, cvc: list[i].cvc }), label: cleanLabel(list[i].label) });
      } catch (e) { /* expired since, or not a card: left out */ }
    }
    if (!out.length) throw new Error('The cards in it have expired — save a card again');
    return out;
  }

  // --- the locked backup in your account ---------------------------------------
  async function passphraseKey(passphrase, salt, iterations, use) {
    var base = await crypto.subtle.importKey('raw', enc.encode(String(passphrase || '').normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, [use]);
  }

  /** Your saved cards, locked with a card passphrase, for your account. Throws an Error with a friendly message. */
  async function lock(userId, passphrase) {
    if (String(passphrase || '').length < MIN_PASSPHRASE) throw new Error('Use a card passphrase of at least ' + MIN_PASSPHRASE + ' characters — a few words is easiest to remember');
    var all = await payloadOf(userId);
    if (!all) throw new Error('Save your card in this browser first');
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var key = await passphraseKey(passphrase, salt, BACKUP_ITERATIONS, 'encrypt');
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: backupAad(userId) }, key, enc.encode(JSON.stringify(all.payload)));
    return Object.assign({ v: 1, kdf: 'PBKDF2-SHA256', iterations: BACKUP_ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) }, all.meta);
  }

  /** Your cards from their locked backup, kept in this browser from now on. A wrong passphrase: an Error. */
  async function unlock(userId, backup, passphrase) {
    if (!userId) throw new Error('Connect the extension to your account first');
    if (!backup || backup.kdf !== 'PBKDF2-SHA256') throw new Error('There is no card backup in your account');
    var p;
    try {
      var key = await passphraseKey(passphrase, unb64(backup.salt), backup.iterations, 'decrypt');
      var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(backup.iv), additionalData: backupAad(userId) }, key, unb64(backup.ct));
      p = JSON.parse(dec.decode(pt));
    } catch (e) {
      throw new Error('That card passphrase isn\'t right');
    }
    await merge(userId, cardsIn(p), p.defaultNumber || p.number);
    return status(userId);
  }

  // --- the copy for reinstalls (from 1.20) ---------------------------------------
  /** A restore key from the dashboard — { id, k }: its name, and 32 random bytes (base64). Throws if it isn't one. */
  async function restoreKey(k) {
    var raw = null;
    try { raw = k && /^[A-Za-z0-9_-]{16,40}$/.test(String(k.id || '')) && typeof k.k === 'string' ? unb64(k.k) : null; } catch (e) { raw = null; }
    if (!raw || raw.length !== 32) throw new Error('That isn\'t a restore key');
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  /** Your cards saved here, locked with the dashboard's restore key, for your account — or null (no card ready here). */
  async function lockForRestore(userId, k) {
    var all = await payloadOf(userId);
    if (!all) return null;
    var key = await restoreKey(k);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: restoreAad(userId, k.id) }, key, enc.encode(JSON.stringify(all.payload)));
    return Object.assign({ v: 1, iv: b64(iv), ct: b64(ct) }, all.meta);
  }

  /** Your cards from their copy for reinstalls, kept in this browser from now on. A copy this key doesn't open: an Error. */
  async function unlockRestore(userId, copy, k) {
    if (!userId) throw new Error('Connect the extension to your account first');
    var p;
    try {
      var key = await restoreKey(k);
      var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(copy.iv), additionalData: restoreAad(userId, k.id) }, key, unb64(copy.ct));
      p = JSON.parse(dec.decode(pt));
    } catch (e) {
      throw new Error('The copy of your card couldn\'t be opened with this browser\'s key');
    }
    await merge(userId, cardsIn(p), p.defaultNumber || p.number);
    return status(userId);
  }

  /** Remove one of your cards (id) — or, with none, every card saved here for this account. The default gone: the next one is. */
  async function remove(userId, id) {
    if (!id) {
      await chrome.storage.session.remove(oldOpenKey(userId));
      await chrome.storage.local.remove(vaultKey(userId));
      return;
    }
    var now = await current(userId);
    var cards = now.cards.filter(function (c) { return c.id !== id; });
    if (cards.length === now.cards.length) throw new Error('That card isn\'t saved in this browser');
    await writeCards(userId, cards, now.defaultId === id ? null : now.defaultId);
  }

  /** The card for checkout — the one with this id (yours), else your default — or null. */
  async function card(userId, id) {
    if (!userId) return null;
    var rec = await record(userId);
    return rec ? openDefault(userId, rec, id) : null;
  }

  /**
   * Your cards here, and the default's details at the top (what dashboards from before 1.33 read):
   * { saved, ready, last4, brand, expMonth, expYear, hasCvc, savedAt, defaultId, count,
   *   cards: [{ id, last4, brand, expMonth, expYear, hasCvc, label, savedAt, ready, expired, isDefault }] }.
   * savedAt: when anything here last changed (a card added, removed or made the default).
   */
  async function status(userId) {
    if (!userId) return { saved: false, ready: false, cards: [], count: 0 };
    var rec = await record(userId);
    if (!rec) return { saved: false, ready: false, cards: [], count: 0 };
    if (rec.v !== 2 && rec.v !== 3) {
      // A passphrase card (1.2 or older): unlocked before the update, it's moved over now.
      if (await openDefault(userId, rec)) return status(userId);
      return {
        saved: true, ready: false, unlocked: false, needsPassphrase: true, unreadable: false,
        last4: rec.last4, brand: rec.brand, expMonth: rec.expMonth, expYear: rec.expYear, hasCvc: rec.hasCvc, savedAt: rec.savedAt || null,
        defaultId: null, count: 1, cards: [],
      };
    }
    var cards = cardsOf(rec);
    var d = defaultOf(rec, cards);
    var ready = await Promise.all(cards.map(function (c) { return openEntry(userId, c).then(function (x) { return !!x; }); }));
    var list = cards.map(function (c, i) {
      return { id: c.id, last4: c.last4, brand: c.brand, expMonth: c.expMonth, expYear: c.expYear, hasCvc: !!c.hasCvc, label: c.label || '', savedAt: c.savedAt || null, ready: ready[i], expired: expired(c), isDefault: !!d && c.id === d.id };
    });
    var dr = !!d && ready[cards.indexOf(d)];
    return {
      saved: !!d,
      ready: dr,
      unlocked: dr, // what dashboards from before 1.3 look for
      needsPassphrase: false,
      unreadable: !!d && !dr,
      last4: d && d.last4, brand: d && d.brand, expMonth: d && d.expMonth, expYear: d && d.expYear, hasCvc: !!(d && d.hasCvc), label: (d && d.label) || '',
      expired: !!d && expired(d),
      savedAt: rec.savedAt || null,
      defaultId: d ? d.id : null,
      count: cards.length,
      cards: list,
    };
  }

  return {
    save: save, upgrade: upgrade, remove: remove, card: card, status: status, normalizeCard: normalizeCard, lock: lock, unlock: unlock,
    lockForRestore: lockForRestore, unlockRestore: unlockRestore, setDefault: setDefault, rename: rename, MAX_CARDS: MAX_CARDS,
  };
})();
