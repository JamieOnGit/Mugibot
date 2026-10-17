// The dashboard round (docs/MONITORING.md, docs/EXTENSION.md): the card's locked backup in the
// member's account, Activity in pages, each member's own switched-off stores, admins switching a
// store's monitoring off and on, and members never seeing where the live searches come from.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { Client, Device, makeMember, startApp } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';

let env;
let store;
let boss;
let ash;
let misty;
let ashBrowser;
let mistyBrowser;
before(async () => {
  store = await startMockStore();
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0 });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  misty = await Client.signup(env.url, 'misty');
  makeMember(env, ash);
  makeMember(env, misty);
  ashBrowser = await Device.pair(env.url, ash, 'Ash laptop');
  mistyBrowser = await Device.pair(env.url, misty, 'Misty laptop');
});
after(async () => {
  await env.close();
  await store.close();
});

// What the extension sends (vault.js): the card locked with the card passphrase, made in the browser.
const b64 = (buf) => Buffer.from(buf).toString('base64');
async function lockCard(userId, card, passphrase, iterations = 600000) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`mugibot-card-backup:${userId}`) }, key, enc.encode(JSON.stringify(card)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: b64(salt), iv: b64(iv), ct: b64(ct), last4: card.number.slice(-4), brand: 'Visa', expMonth: card.expMonth, expYear: card.expYear, hasCvc: true };
}
async function unlockCard(userId, backup, passphrase) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: Buffer.from(backup.salt, 'base64'), iterations: backup.iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(backup.iv, 'base64'), additionalData: enc.encode(`mugibot-card-backup:${userId}`) }, key, Buffer.from(backup.ct, 'base64'));
  return JSON.parse(new TextDecoder().decode(pt));
}
const CARD = { number: '4242424242424242', name: 'Ash Ketchum', expMonth: '12', expYear: '2031', cvc: '123' };

test('💳 the card backup: only a copy locked in the extension is kept (the server can\'t open it); a new install gets it back with the passphrase; only for its own account', async () => {
  assert.equal((await ashBrowser.call('GET', '/api/ext/card-backup')).body.backup, null);
  const locked = await lockCard(ashBrowser.user.id, CARD, 'correct horse battery');
  // Checked first: the lock, and what the dashboard shows.
  for (const bad of [{ ...locked, iterations: 1000 }, { ...locked, kdf: 'none' }, { ...locked, ct: 'not base64!!' }, { ...locked, iv: 'AAAA' }, { ...locked, last4: '42424242' }, { ...locked, expMonth: '13' }]) {
    assert.equal((await ashBrowser.call('PUT', '/api/ext/card-backup', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  const r = await ashBrowser.call('PUT', '/api/ext/card-backup', locked);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body.backup).sort(), ['brand', 'expMonth', 'expYear', 'hasCvc', 'last4', 'savedAt']);
  // Nothing in it the server could read the card from: just the locked data and its label.
  const stored = env.app.repo.getData(ash.user.id, 'cardBackup');
  assert.ok(!JSON.stringify(stored).includes(CARD.number), 'the card number is not in it');
  assert.ok(!JSON.stringify(stored).includes(CARD.cvc + '"'), 'nor the CVV');
  const raw = env.app.db.get("SELECT enc FROM user_data WHERE user_id = :u AND kind = 'cardBackup'", { u: ash.user.id }).enc;
  assert.ok(!raw.includes('4242'), 'and it is encrypted at rest as well');
  // A new install of the extension: the locked copy, opened there with the passphrase.
  const newInstall = await Device.pair(env.url, ash, 'Ash laptop (new install)');
  const got = (await newInstall.call('GET', '/api/ext/card-backup')).body.backup;
  assert.deepEqual(await unlockCard(ash.user.id, got, 'correct horse battery'), CARD);
  await assert.rejects(unlockCard(ash.user.id, got, 'wrong horse battery'), 'a wrong passphrase opens nothing');
  // (Locked for this account: the same data under another account's id doesn't open.)
  await assert.rejects(unlockCard(misty.user.id, got, 'correct horse battery'));
  // The dashboard: brand, last 4 and expiry — never the locked data.
  const info = (await ash.get('/api/card-backup')).body.backup;
  assert.deepEqual([info.brand, info.last4, info.expMonth, info.expYear], ['Visa', '4242', '12', '2031']);
  assert.equal(info.ct, undefined);
  assert.ok((await ash.get('/api/events')).body.events.some((e) => /Card backed up: Visa •••• 4242/.test(e.message)));
  // Another account sees nothing of it.
  assert.equal((await mistyBrowser.call('GET', '/api/ext/card-backup')).body.backup, null);
  assert.equal((await misty.get('/api/card-backup')).body.backup, null);
  assert.equal((await new Device(env.url, 'x'.repeat(43)).call('GET', '/api/ext/card-backup')).status, 401);
  // "Download my data" says it's there (locked), without the locked data.
  const exp = (await ash.get('/api/me/export')).body;
  assert.equal(exp.cardBackup.last4, '4242');
  assert.equal(exp.cardBackup.locked, true);
  assert.ok(!JSON.stringify(exp).includes(locked.ct), 'not the locked data');
  // Deleted from the dashboard (or the extension).
  assert.equal((await ash.del('/api/card-backup')).status, 200);
  assert.equal((await newInstall.call('GET', '/api/ext/card-backup')).body.backup, null);
  assert.equal((await ashBrowser.call('PUT', '/api/ext/card-backup', locked)).status, 200);
  assert.equal((await newInstall.call('DELETE', '/api/ext/card-backup')).status, 200);
  assert.equal((await ash.get('/api/card-backup')).body.backup, null);
});

test('📋 Activity comes in pages: 20 at a time, newest first, with how many there are', async () => {
  for (let i = 1; i <= 45; i++) env.app.repo.addEvent(misty.user.id, { type: 'info', message: `Event ${i}` });
  const total = env.app.repo.countEvents(misty.user.id);
  const p1 = (await misty.get('/api/events?limit=20&page=1')).body;
  assert.equal(p1.total, total);
  assert.equal(p1.events.length, 20);
  assert.equal(p1.events[0].message, 'Event 45');
  const p2 = (await misty.get('/api/events?limit=20&page=2')).body;
  assert.equal(p2.events[0].message, 'Event 25');
  const last = (await misty.get(`/api/events?limit=20&page=${Math.ceil(total / 20)}`)).body;
  assert.equal(last.events.length, total - 20 * (Math.ceil(total / 20) - 1));
  // (The old way still works: the newest, or older than an id.)
  assert.equal((await misty.get('/api/events?limit=5')).body.events.length, 5);
  assert.equal((await misty.get('/api/events?limit=5')).body.total, undefined);
});

test('🔕 each member can switch a store off for themselves: kept with their account, only stores Mugibot searches', async () => {
  assert.deepEqual((await ash.get('/api/monitor/prefs')).body, { hiddenStores: [] });
  let r = await ash.put('/api/monitor/prefs', { hiddenStores: ['demo-kmart', 'nowhere', 'demo-kmart', 'target'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.hiddenStores, ['demo-kmart', 'target']);
  assert.deepEqual((await ash.get('/api/monitor/live')).body.prefs.hiddenStores, ['demo-kmart', 'target']);
  assert.deepEqual((await misty.get('/api/monitor/prefs')).body.hiddenStores, [], 'only for that member');
  assert.equal((await ash.put('/api/monitor/prefs', { hiddenStores: 'target' })).status, 400);
  r = await ash.put('/api/monitor/prefs', { hiddenStores: [] });
  assert.deepEqual(r.body.hiddenStores, []);
});

test('🛰 members never see where the live searches come from — the store list, its events and the live stream; admins do, and see switched-off stores to switch back on', async () => {
  const sw = env.app.sweeper;
  // The dummy Kmart searched from an admin's browser; the dummy BIG W off.
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-kmart': 'browser', 'demo-target': 'server', 'demo-bigw': 'off' } })).status, 200);
  sw.sys("boss's browser is searching Kmart (dummy)", { store: 'demo-kmart' });
  sw.sys('Target (dummy) refused a search — searching it at a third of the pace for 10 minutes', { store: 'demo-target', level: 'warn' });
  sw.record(env.app.retailers.get('demo-target'), { keyword: 'pokemon', page: 1 }, { ok: false, url: `${store.url}/target/search?text=pokemon`, source: 'server', ms: 120, error: "Couldn't reach the store" });
  const sent = [];
  const publish = env.app.hub.publish.bind(env.app.hub);
  env.app.hub.publish = (userId, type, data) => { sent.push({ userId, type, data }); return publish(userId, type, data); };
  env.app.hub.userIds = () => [boss.user.id, ash.user.id];
  try {
    sw.record(env.app.retailers.get('demo-target'), { keyword: 'pokemon', page: 1 }, { ok: true, url: `${store.url}/target/search?text=pokemon`, source: 'server', ms: 90, found: 2, kept: 2 });
    sw.sys("boss's browser is searching Kmart (dummy)", { store: 'demo-kmart' });
    env.app.feed.broadcast('product', { id: 'p-x', store: 'demo-kmart', name: 'Pokémon TCG ETB', status: 'blocked', statusSource: 'browser', error: "Refused the admin's browser (HTTP 403)" });
  } finally {
    env.app.hub.publish = publish;
    delete env.app.hub.userIds;
  }
  // The live stream: admins get each search with where it came from; members without it — and no
  // "…'s browser is searching it" at all.
  const toBoss = sent.filter((x) => x.userId === boss.user.id && x.type === 'monitor-sweep').map((x) => x.data);
  const toAsh = sent.filter((x) => x.userId === ash.user.id && x.type === 'monitor-sweep').map((x) => x.data);
  assert.equal(toBoss.find((e) => e.type === 'hb').source, 'server');
  assert.ok(toBoss.some((e) => e.type === 'sys' && /browser/.test(e.message)));
  assert.equal(toAsh.find((e) => e.type === 'hb').source, undefined);
  assert.ok(!toAsh.some((e) => e.type === 'sys'), 'the browser note is admins only');
  const productTo = (u) => sent.find((x) => x.userId === u.user.id && x.type === 'monitor-product').data;
  assert.deepEqual([productTo(boss).statusSource, productTo(boss).error], ['browser', "Refused the admin's browser (HTTP 403)"]);
  assert.equal(productTo(ash).statusSource, undefined, "a product's update: not where it was read from");
  assert.doesNotMatch(productTo(ash).error, /admin|browser/);
  assert.equal(productTo(ash).name, 'Pokémon TCG ETB');

  // The live view: the same.
  const member = (await ash.get('/api/monitor/live')).body;
  const text = JSON.stringify(member);
  assert.doesNotMatch(text, /admin's browser|"mode"|"from"|"endpoint"|"source"|boss's browser|Mugibot's server/);
  const kmart = member.stores.find((s) => s.id === 'demo-kmart');
  assert.ok(kmart, 'the store is listed');
  assert.notEqual(kmart.status, 'waiting', '"waiting for an admin\'s browser" is just "starting" to a member');
  assert.ok(!member.stores.some((s) => s.id === 'demo-bigw'), 'a store switched off is not listed for members');
  assert.ok(member.events.some((e) => /refused a search/.test(e.message || '')), 'store problems are still said');
  const admin = (await boss.get('/api/monitor/live')).body;
  assert.equal(admin.stores.find((s) => s.id === 'demo-kmart').mode, 'browser');
  const bigw = admin.stores.find((s) => s.id === 'demo-bigw');
  assert.deepEqual([bigw.status, bigw.defaultMode], ['off', 'off'], 'admins see it, to switch it back on');
  assert.equal(admin.stores.find((s) => s.id === 'demo-target').defaultMode, 'off');
  assert.ok(admin.events.some((e) => /boss's browser is searching/.test(e.message || '')));

  // A product's page: where its stock was read from is for admins.
  const p = env.app.catalog.upsertProduct({ store: 'demo-target', sku: '1234', name: 'Pokémon TCG test' });
  env.app.catalog.updateProduct(p.id, { status: 'in_stock', status_source: 'browser', sweep_seen_at: Date.now(), sweep_first_at: Date.now() });
  const list = (await ash.get('/api/monitor/products?store=demo-target')).body.products;
  assert.equal(list.find((x) => x.id === p.id).statusSource, undefined);
  assert.equal((await ash.get(`/api/monitor/products/${p.id}`)).body.product.statusSource, undefined);
  assert.equal((await boss.get(`/api/monitor/products/${p.id}`)).body.product.statusSource, 'browser');
  // Switched back on: listed for members again.
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-kmart': 'browser', 'demo-target': 'server', 'demo-bigw': 'server' } })).status, 200);
  assert.ok((await ash.get('/api/monitor/live')).body.stores.some((s) => s.id === 'demo-bigw'));
});
