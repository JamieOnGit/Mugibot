// Every member's data belongs to their login only: watchlist, delivery
// details, alert settings, activity, connected browsers, ⚡ Buy codes and
// in-browser check results. Two members try to reach each other's data in
// every way the API allows, and must fail.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, makeMember, startApp } from './helpers.js';

let env;
let ash;
let misty;
before(async () => {
  env = await startApp();
  ash = await Client.signup(env.url, 'ash');
  misty = await Client.signup(env.url, 'misty');
  makeMember(env, ash);
  makeMember(env, misty);
});
after(async () => { await env.close(); });

const ASH = { profiles: [{ label: 'Home', firstName: 'Ash', lastName: 'Ketchum', email: 'ash.checkout@example.com', phone: '0400000001', address1: '1 Pallet Rd', suburb: 'Pallet', state: 'VIC', postcode: '3000' }, { label: 'Work', firstName: 'Ash', address1: '9 Lab Lane', suburb: 'Pallet', state: 'VIC', postcode: '3001' }] };
const MISTY = { profiles: [{ label: 'Home', firstName: 'Misty', lastName: 'Waterflower', phone: '0400000002', address1: '9 Cerulean Ave', suburb: 'Cerulean', state: 'QLD', postcode: '4000' }] };

test('each member has their own copy of the watchlist; edits never leak', async () => {
  const a = (await ash.get('/api/items')).body.items;
  const m = (await misty.get('/api/items')).body.items;
  assert.equal(a.length, m.length);
  assert.ok(a.every((p) => !m.some((q) => q.id === p.id)), 'different item ids per member');
  await ash.put(`/api/items/${a[0].id}`, { name: 'Ash renamed', quantity: 4 });
  await ash.del(`/api/items/${a[1].id}`);
  await ash.post('/api/items', { url: 'https://www.ebgames.com.au/product/toys-and-collectibles/312345-one-piece-op-18-booster-box', name: 'OP-18 Box' });
  const m2 = (await misty.get('/api/items')).body.items;
  assert.deepEqual(m2, m, "Misty's list is untouched");
});

test("you can't read, change, reorder, delete, check or ⚡ Buy someone else's SKU", async () => {
  const theirs = (await misty.get('/api/items')).body.items[0];
  assert.equal((await ash.put(`/api/items/${theirs.id}`, { name: 'hacked' })).status, 404);
  assert.equal((await ash.del(`/api/items/${theirs.id}`)).status, 404);
  assert.equal((await ash.post(`/api/items/${theirs.id}/go`, { quantity: 2 })).status, 404);
  assert.equal((await ash.post(`/api/items/${theirs.id}/check`)).status, 404);
  const reordered = await ash.post('/api/items/reorder', { ids: [theirs.id] });
  assert.ok(!reordered.body.items.some((p) => p.id === theirs.id), "reorder ignores ids that aren't yours");
  assert.equal((await ash.get(`/api/items/lookup?store=kmart&sku=${theirs.sku}`)).body.item.id !== theirs.id, true, 'lookup finds your own item only');
  assert.deepEqual((await misty.get('/api/items')).body.items[0], theirs);
});

test('delivery details are per member, encrypted at rest, and bound to their owner', async () => {
  await ash.put('/api/profiles', ASH);
  await misty.put('/api/profiles', MISTY);
  assert.equal((await ash.get('/api/profiles')).body.profiles[1].address1, '9 Lab Lane');
  assert.equal((await misty.get('/api/profiles')).body.profiles[0].address1, '9 Cerulean Ave');
  const rows = env.app.db.all("SELECT user_id, enc FROM user_data WHERE kind = 'profiles'");
  assert.equal(rows.length, 2);
  for (const r of rows) assert.doesNotMatch(r.enc, /Pallet|Cerulean|Ketchum|0400/);
  // Copying Misty's encrypted row onto Ash's account doesn't decrypt.
  const mistyRow = rows.find((r) => r.user_id === misty.user.id);
  env.app.db.run("UPDATE user_data SET enc = :enc WHERE user_id = :u AND kind = 'profiles'", { enc: mistyRow.enc, u: ash.user.id });
  assert.equal((await ash.get('/api/profiles')).status, 500, 'swapped data is rejected, not shown');
  await ash.put('/api/profiles', ASH);
  assert.equal((await ash.get('/api/profiles')).body.profiles[0].address1, '1 Pallet Rd');
});

test('alert settings and activity belong to their owner', async () => {
  await ash.put('/api/alerts', { discordWebhook: 'https://discord.com/api/webhooks/1/ash-secret', emailOnRestock: false });
  assert.equal((await misty.get('/api/alerts')).body.alerts.discordWebhook, '');
  assert.equal((await misty.put('/api/alerts', { discordWebhook: 'https://evil.example/hook' })).status, 400, 'only Discord webhooks');
  const raw = env.app.db.get("SELECT enc FROM user_data WHERE kind = 'alerts' AND user_id = :u", { u: ash.user.id }).enc;
  assert.doesNotMatch(raw, /ash-secret/);
  await misty.post('/api/alerts/test');
  assert.ok((await misty.get('/api/events')).body.events.some((e) => e.type === 'test'));
  assert.ok(!(await ash.get('/api/events')).body.events.some((e) => e.type === 'test'));
  assert.equal(env.webhooks.length, 0, "Misty has no webhook, and Ash's isn't used for Misty's alert");
  await ash.post('/api/alerts/test');
  assert.equal(env.webhooks.length, 1);
  assert.match(env.webhooks[0].url, /ash-secret/);
});

test('the extension only sees the account it is paired with — and the chosen delivery details', async () => {
  const ashDevice = await Device.pair(env.url, ash, 'Ash laptop');
  const mistyDevice = await Device.pair(env.url, misty, 'Misty laptop');
  assert.equal(ashDevice.user.username, 'ash');
  const ashItems = (await ashDevice.call('GET', '/api/ext/items')).body;
  assert.ok(ashItems.items.some((p) => p.name === 'OP-18 Box'));
  assert.ok(ashItems.flows.some((f) => f.id === 'kmart' && f.flowStatus === 'verified'), 'every store\'s flow');
  assert.ok(!(await mistyDevice.call('GET', '/api/ext/items')).body.items.some((p) => p.name === 'OP-18 Box'));

  assert.equal((await ashDevice.call('GET', '/api/ext/profile')).body.profile.address1, '1 Pallet Rd', 'default');
  const work = (await ash.get('/api/profiles')).body.profiles[1];
  assert.equal((await ashDevice.call('GET', `/api/ext/profile?profile=${work.id}`)).body.profile.address1, '9 Lab Lane', 'the chosen one');
  const mistyWithAshsId = (await mistyDevice.call('GET', `/api/ext/profile?profile=${work.id}`)).body.profile;
  assert.equal(mistyWithAshsId.address1, '9 Cerulean Ave', "another member's profile id just gives your own default");
  assert.ok(!('card' in mistyWithAshsId), 'no card data from the server');

  const ashDevices = (await ash.get('/api/devices')).body.devices;
  assert.equal((await misty.del(`/api/devices/${ashDevices[0].id}`)).status, 404);
  await mistyDevice.call('POST', '/api/ext/events', { type: 'add', name: 'Day UPC', message: 'Clicked Add to bag' });
  assert.ok((await misty.get('/api/events')).body.events.some((e) => /Clicked Add to bag/.test(e.message)));
  assert.ok(!(await ash.get('/api/events')).body.events.some((e) => /Clicked Add to bag/.test(e.message)));
  assert.equal((await new Device(env.url, 'x'.repeat(43)).call('GET', '/api/ext/items')).status, 401);
  await ash.del(`/api/devices/${ashDevices[0].id}`);
  assert.equal((await ashDevice.call('GET', '/api/ext/items')).status, 401, 'disconnected from the dashboard');
});

test('⚡ Buy codes only work for the account that made them, once, for 2 minutes — with the item\'s delivery details', async () => {
  const ashDevice = await Device.pair(env.url, ash, 'Ash desktop');
  const mistyDevice = await Device.pair(env.url, misty, 'Misty desktop');
  const work = (await ash.get('/api/profiles')).body.profiles[1];
  const p = (await ash.get('/api/items')).body.items.find((x) => x.name === 'OP-18 Box');
  await ash.put(`/api/items/${p.id}`, { profileId: work.id });
  const go = await ash.post(`/api/items/${p.id}/go`, {});
  assert.equal(go.status, 200);
  const code = new URL(go.body.url).hash.match(/^#mgb-go=([\w-]+)$/)[1];
  assert.equal((await mistyDevice.call('POST', '/api/ext/claim', { code })).status, 404, "Misty's extension can't use Ash's code");
  const claim = await ashDevice.call('POST', '/api/ext/claim', { code });
  assert.equal(claim.status, 200);
  assert.deepEqual({ sku: claim.body.sku, host: claim.body.host, profileId: claim.body.profileId }, { sku: '312345', host: 'www.ebgames.com.au', profileId: work.id });
  assert.equal(claim.body.quantity, undefined, 'one of it — no quantities for now');
  assert.equal((await ashDevice.call('POST', '/api/ext/claim', { code })).status, 404, 'single use');
  const go2 = await ash.post(`/api/items/${p.id}/go`, {});
  const code2 = new URL(go2.body.url).hash.split('=')[1];
  env.app.db.run('UPDATE go_codes SET expires_at = 0');
  assert.equal((await ashDevice.call('POST', '/api/ext/claim', { code: code2 })).status, 404, 'expired');
});

test("⚡ Buy at a Shopify store: Shopify's own cart link (straight to checkout) once Mugibot knows the product's option", async () => {
  const add = await ash.post('/api/items', { store: 'jbhifi', sku: 'pokemon-tcg-test-etb', name: 'JB test ETB' });
  assert.equal(add.status, 200);
  const it = add.body;
  // Not seen by the monitor yet: the product page (the extension finds the option there).
  let go = await ash.post(`/api/items/${it.id}/go`, {});
  assert.match(go.body.url, /^https:\/\/www\.jbhifi\.com\.au\/products\/pokemon-tcg-test-etb#mgb-go=[\w-]+$/);
  const p = env.app.catalog.upsertProduct({ store: 'jbhifi', sku: 'pokemon-tcg-test-etb', url: it.url, name: 'JB test ETB' });
  env.app.catalog.updateProduct(p.id, { variant_id: '4012345678' });
  go = await ash.post(`/api/items/${it.id}/go`, {});
  assert.match(go.body.url, /^https:\/\/www\.jbhifi\.com\.au\/cart\/4012345678:1#mgb-go=[\w-]+$/);
  // Misty's copy of the same product gets the cart link too, with her own code.
  const hers = (await misty.post('/api/items', { store: 'jbhifi', sku: 'pokemon-tcg-test-etb' })).body;
  const mine = new URL(go.body.url).hash;
  const theirs = (await misty.post(`/api/items/${hers.id}/go`, {})).body.url;
  assert.match(theirs, /\/cart\/4012345678:1#mgb-go=/);
  assert.notEqual(new URL(theirs).hash, mine);
  // Other stores: always the product page.
  const kmart = (await ash.get('/api/items')).body.items.find((x) => x.store === 'kmart' && x.url);
  assert.equal(new URL((await ash.post(`/api/items/${kmart.id}/go`, {})).body.url).pathname, new URL(kmart.url).pathname);
});

test('in-browser check results only change your own items', async () => {
  const mistyDevice = await Device.pair(env.url, misty, 'Misty checker');
  const ashItem = (await ash.get('/api/items')).body.items[0];
  const r = await mistyDevice.call('POST', '/api/ext/checks', { results: [{ id: ashItem.id, status: 'in_stock' }] });
  assert.equal(r.body.applied, 0);
  assert.equal((await ash.get('/api/items')).body.items[0].status, ashItem.status);
  const mine = (await misty.get('/api/items')).body.items[0];
  const ok = await mistyDevice.call('POST', '/api/ext/checks', { results: [{ id: mine.id, status: 'in_stock', price: 360 }] });
  assert.equal(ok.body.applied, 1);
  const after = (await misty.get('/api/items')).body.items[0];
  assert.equal(after.status, 'in_stock');
  assert.equal(after.statusSource, 'browser');
  const ashSame = (await ash.get('/api/items')).body.items.find((x) => x.sku === mine.sku);
  assert.notEqual(ashSame && ashSame.status, 'in_stock', "Misty's browser doesn't change Ash's copy of the same SKU");
});

test('admins see accounts and memberships, not personal details', async () => {
  const boss = await Client.signup(env.url, 'boss');
  env.app.repo.updateUser(boss.user.id, { role: 'admin' });
  const users = (await boss.get('/api/admin/users')).body.users;
  const ashRow = users.find((u) => u.username === 'ash');
  assert.ok(ashRow);
  assert.doesNotMatch(JSON.stringify(users), /Pallet|Cerulean|password_hash|data_key|webhooks/i);
  assert.equal(typeof ashRow.items, 'number', 'only counts');
  const skus = (await boss.get('/api/admin/skus')).body.skus;
  assert.ok(skus.some((s) => s.sku === '43818648' && s.watchers >= 2), 'SKU totals');
  assert.doesNotMatch(JSON.stringify(skus), /ash|misty|usr_/, 'not who');
});

test('the extension can check for updates, and each connected extension shows which address it was built for', async () => {
  const app = await fetch(`${env.url}/api/ext/app`).then((r) => r.json());
  assert.equal(app.url, env.url);
  assert.match(app.extensionVersion, /^\d+\.\d+\.\d+$/);
  const device = await Device.pair(env.url, ash, 'Old download');
  await device.call('GET', '/api/ext/me?v=1.0.0');
  let mine = (await ash.get('/api/devices')).body.devices.find((d) => d.name === 'Old download');
  assert.equal(mine.version, '1.0.0');
  assert.equal(mine.host, new URL(env.url).host);
  // The same extension talking to another of the site's addresses (e.g. the old fly.dev one).
  const other = new Device(env.url.replace('127.0.0.1', 'localhost'), device.token);
  await other.call('GET', '/api/ext/items');
  mine = (await ash.get('/api/devices')).body.devices.find((d) => d.name === 'Old download');
  assert.equal(mine.host, `localhost:${new URL(env.url).port}`);
  assert.equal((await misty.get('/api/devices')).body.devices.some((d) => d.name === 'Old download'), false);
  const me = (await ash.get('/api/me')).body;
  assert.equal(me.app.host, new URL(env.url).host, 'the dashboard knows its own address to compare');
});
