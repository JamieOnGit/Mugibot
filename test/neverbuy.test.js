// An Auto-checkout watch never buys what was on sale before it was added (docs/MONITORING.md, VIP drops and drop watches):
// whatever the catalogue last said — an old "sold out" or "not listed", a product it never tracked — and whichever read comes
// first (another search, a refused page read, an admin's browser), the product's own page decides. And what sold out before
// the watch and comes back is still bought.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';

let env;
let store;
let discord;
let boss;
let clock;
const DAY = 24 * 3600 * 1000;
const NINJA = '20424049-01';

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  clock = { offset: 0 };
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, now: () => Date.now() + clock.offset, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  makeMember(env, boss);
  env.app.repo.updateUser(boss.user.id, { discord_id: 'd-boss' });
  for (const it of (await boss.get('/api/items')).body.items) await boss.del(`/api/items/${it.id}`);
  assert.equal((await boss.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 2000, perDay: 20, spendPerDay: 20000 })).status, 200);
  env.app.repo.addDevice(boss.user.id, 'Chrome on Mac', '1.34.0');
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-kmart': 'server', 'demo-citybeach': 'server', 'demo-ebgames': 'browser' } })).status, 200);
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const sw = () => env.app.sweeper;
const cb = () => env.app.retailers.get('demo-citybeach');
const product = (sku, s = 'demo-citybeach') => env.app.catalog.productFor(s, sku);
const runsFor = (sku, s = 'demo-citybeach') => env.app.db.all('SELECT r.* FROM aco_runs r JOIN items i ON i.id = r.item_id WHERE i.user_id = :u AND i.store = :s AND i.sku = :k', { u: boss.user.id, s, k: sku });
const vipView = async (id) => (await boss.get('/api/monitor/vip')).body.watches.find((x) => x.id === id);
const clean = async () => { for (const it of (await boss.get('/api/items')).body.items) await boss.del(`/api/items/${it.id}`); };

test("🛡️ a product never tracked (not a card: a hat), on sale for months, found first by the store's own search after a VIP watch is added: its page decides — on sale, never bought", async () => {
  const HAT = '20485555-01';
  store.shop('citybeach').products.push({ sku: HAT, name: 'Pokémon Beach Hat', price: 29.99, status: 'in_stock', listed: true, maxQty: 0, qtyStyle: 'input', lateMs: 0, id: 4485555 });
  // The store's "pokemon" search before the watch: its scene; the hat isn't a card, so it isn't tracked.
  await sw().sweepTerm(cb(), { keyword: 'pokemon', page: 1 });
  assert.equal((await sw().sweepTerm(cb(), { keyword: 'pokemon', page: 1 })).baseline, false);
  assert.equal(product(HAT), null, 'not tracked: not a card');
  const r = await boss.post('/api/monitor/vip', { store: 'demo-citybeach', words: 'pokemon beach hat', aco: true, maxPrice: 100 });
  assert.equal(r.status, 200, r.text);
  // The store's own search comes round before the watch's.
  assert.equal((await sw().sweepTerm(cb(), { keyword: 'pokemon', page: 1 })).baseline, false);
  assert.deepEqual((await vipView(r.body.watch.id)).found.map((p) => p.arm), ['pending'], 'not armed straight away');
  await env.app.monitor.checkPage(product(HAT).url);
  assert.deepEqual((await vipView(r.body.watch.id)).found.map((p) => p.arm), ['skipped']);
  assert.equal(runsFor(HAT).length, 0, 'never bought');
  assert.equal((await boss.del(`/api/monitor/vip/${r.body.watch.id}`)).status, 200);
  await clean();
});

test('🛡️ an old "not listed" reading (a month before the watch, on sale since) is no drop either: never bought', async () => {
  const ninja = product(NINJA);
  assert.ok(ninja);
  env.app.db.run("UPDATE products SET status = 'not_listed', status_at = :t, last_ok_at = :t, checked_at = :t WHERE id = :id", { id: ninja.id, t: sw().now() - 30 * DAY });
  const r = await boss.post('/api/monitor/vip', { store: 'demo-citybeach', words: 'ninja spinner', aco: true, maxPrice: 50 });
  assert.equal(r.status, 200, r.text);
  await sw().sweepTerm(cb(), { keyword: 'pokemon', page: 1 });
  assert.deepEqual((await vipView(r.body.watch.id)).found.map((p) => p.arm), ['pending']);
  await env.app.monitor.checkPage(product(NINJA).url);
  assert.equal(runsFor(NINJA).length, 0, 'never bought');
  assert.equal((await boss.del(`/api/monitor/vip/${r.body.watch.id}`)).status, 200);
  await clean();
});

test("🛡️ a pending find whose page read is refused stays pending (the catalogue's old \"sold out\" never decides it): the next good read does — on sale, never bought", async () => {
  const ninja = product(NINJA);
  env.app.db.run("UPDATE products SET status = 'out_of_stock', status_at = :t, checked_at = :t, confirmed = 1 WHERE id = :id", { id: ninja.id, t: sw().now() - 30 * DAY });
  const r = await boss.post('/api/monitor/vip', { store: 'demo-citybeach', words: 'ninja spinner', aco: true, maxPrice: 50 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  await sw().sweepTerm(cb(), { keyword: 'pokemon', page: 1 });
  assert.deepEqual((await vipView(w.id)).found.map((p) => p.arm), ['pending']);
  store.state.blockNonBrowsers = true;
  try {
    await env.app.monitor.checkPage(product(NINJA).url);
  } finally {
    store.state.blockNonBrowsers = false;
  }
  assert.deepEqual((await vipView(w.id)).found.map((p) => p.arm), ['pending'], 'a refused read decides nothing');
  assert.ok(!env.app.repo.itemBySku(boss.user.id, 'demo-citybeach', NINJA), 'nothing armed');
  env.app.db.run('UPDATE page_checks SET fail_count = 0, next_check_at = 0 WHERE url = :u', { u: product(NINJA).url });
  await env.app.monitor.checkPage(product(NINJA).url);
  assert.deepEqual((await vipView(w.id)).found.map((p) => p.arm), ['skipped']);
  assert.equal(runsFor(NINJA).length, 0, 'never bought');
  assert.equal((await boss.del(`/api/monitor/vip/${w.id}`)).status, 200);
  await clean();
});

test('🛡️ …and one that sold out before the watch was added (hidden from the store\'s search, as Target does) is looked at when the watch is added: sold out on its page, armed — bought when it\'s back', async () => {
  store.set('citybeach', NINJA, { status: 'out_of_stock' });
  const ninja = product(NINJA);
  env.app.db.run("UPDATE products SET status = 'out_of_stock', status_at = :t, checked_at = :t, confirmed = 1 WHERE id = :id", { id: ninja.id, t: sw().now() - 60 * 1000 });
  const r = await boss.post('/api/monitor/vip', { store: 'demo-citybeach', words: 'ninja spinner', aco: true, maxPrice: 50 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.deepEqual((await vipView(w.id)).found.map((p) => p.arm), ['pending'], 'off sale in the catalogue: its page read straight away');
  await env.app.monitor.checkPage(product(NINJA).url);
  assert.deepEqual((await vipView(w.id)).found.map((p) => p.arm), ['armed'], 'sold out on its page: armed for its return');
  const item = env.app.repo.itemBySku(boss.user.id, 'demo-citybeach', NINJA);
  assert.ok(item && item.aco, 'armed for Auto-checkout');
  // Back on sale: bought.
  store.set('citybeach', NINJA, { status: 'in_stock' });
  env.app.db.run('UPDATE page_checks SET next_check_at = 0 WHERE url = :u', { u: product(NINJA).url });
  await env.app.monitor.checkPage(product(NINJA).url);
  assert.equal(runsFor(NINJA).length, 1, 'its restock: Auto-checkout');
  assert.equal((await boss.del(`/api/monitor/vip/${w.id}`)).status, 200);
  await clean();
});

test('🛡️ a search-page watch: a product on sale at its first look, the catalogue\'s "sold out" a month old — left alone, never bought', async () => {
  store.addProduct('kmart', { sku: '43900001', name: 'Magic: The Gathering Foundations Play Booster Box', price: 199, status: 'in_stock' });
  const p = env.app.catalog.upsertProduct({ store: 'demo-kmart', sku: '43900001', url: '', name: 'Magic: The Gathering Foundations Play Booster Box' });
  const old = sw().now() - 30 * DAY;
  env.app.db.run("UPDATE products SET status = 'out_of_stock', status_at = :t, last_ok_at = :t, checked_at = :t, confirmed = 1 WHERE id = :id", { id: p.id, t: old });
  const r = await boss.post('/api/drops', { page: `${store.url}/kmart/search/?searchTerm=magic`, phrases: ['Magic the Gathering'], every: 3, label: 'Kmart MTG', aco: true, maxPrice: 300 });
  assert.equal(r.status, 200, r.text);
  const tick = async () => { clock.offset += 61 * 1000; const n = await env.app.pages.tick(); await env.app.monitor.delivered(); return n; };
  assert.equal(await tick(), 1);
  const view = (await boss.get('/api/drops')).body.watches.find((x) => x.id === r.body.watch.id);
  assert.deepEqual(view.found.map((f) => f.arm), ['skipped'], 'on sale at its first look');
  await tick();
  assert.equal(runsFor('43900001', 'demo-kmart').length, 0, 'never bought');
  assert.equal((await boss.del(`/api/drops/${r.body.watch.id}`)).status, 200);
  await clean();
});

test("🛡️ at a store only an admin's browser reads (EB Games): a VIP find waiting on its page is decided by the browser's page read — sold out, armed; back, bought", async () => {
  const eb = env.app.retailers.get('demo-ebgames');
  assert.equal((await boss.put('/api/admin/retailers/demo-ebgames', { serverChecks: false })).status, 200);
  const r = await boss.post('/api/monitor/vip', { store: 'demo-ebgames', words: 'halo infinite', aco: true, maxPrice: 200 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  const url = `${store.url}/ebgames/product/xbox-one/999001-halo-infinite-collectors-edition`;
  const admin = env.app.repo.userById(boss.user.id);
  // The watch's own first search (an admin's browser): sold out — pending, its page to decide.
  const out = await sw().browserResults(admin, [{ store: 'demo-ebgames', keyword: 'halo infinite', page: 1, ok: true, ms: 300, products: [{ sku: '999001', title: 'Halo Infinite Collectors Edition', price: 150, inStock: false, url }] }]);
  assert.equal(out[0].ok, true, JSON.stringify(out));
  assert.equal(eb.flow ? 'flow' : 'none', 'flow');
  const p = product('999001', 'demo-ebgames');
  assert.deepEqual((await vipView(w.id)).found.map((f) => f.arm), ['pending']);
  // The admin's browser reads its page: sold out — armed.
  assert.equal(await env.app.monitor.browserProductResult(admin, { id: `p:${p.id}`, status: 'out_of_stock', price: 150 }), true);
  assert.deepEqual((await vipView(w.id)).found.map((f) => f.arm), ['armed']);
  const item = env.app.repo.itemBySku(boss.user.id, 'demo-ebgames', '999001');
  assert.ok(item && item.aco, 'armed for Auto-checkout');
  assert.equal((await boss.del(`/api/monitor/vip/${w.id}`)).status, 200);
  await clean();
});

test("🛡️ a drop watch's own search: a product the catalogue already had, on sale all along, that only moves up into its results later (JB's search shows its top 10) is no drop — never bought", async () => {
  for (let i = 1; i <= 11; i++) store.addProduct('jbhifi', { sku: `lego-castle-set-${i}`, name: `Lego Castle Set ${i}`, price: 50 + i, status: 'in_stock' });
  // The 11th: in the catalogue (on sale) since an hour before the watch.
  const p11 = env.app.catalog.upsertProduct({ store: 'demo-jbhifi', sku: 'lego-castle-set-11', url: `${store.url}/jbhifi/products/lego-castle-set-11`, name: 'Lego Castle Set 11' });
  env.app.db.run("UPDATE products SET status = 'in_stock', status_at = :t, checked_at = :t, confirmed = 1 WHERE id = :id", { id: p11.id, t: sw().now() - 3600 * 1000 });
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-jbhifi': 'server' } })).status, 200);
  const r = await boss.post('/api/drops', { store: 'demo-jbhifi', words: 'lego castle set', aco: true, maxPrice: 900 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  const jb = env.app.retailers.get('demo-jbhifi');
  let s = await sw().sweepTerm(jb, { keyword: 'lego castle set', page: 1, drop: 'shared' });
  assert.equal(s.ok, true, s.error);
  assert.ok(!env.app.drops.get(w.id).found.some((f) => f.sku === 'lego-castle-set-11'), 'not in its first look (its top 10)');
  store.set('jbhifi', 'lego-castle-set-1', { listed: false });
  s = await sw().sweepTerm(jb, { keyword: 'lego castle set', page: 1, drop: 'shared' });
  assert.equal(s.ok, true, s.error);
  await env.app.monitor.delivered();
  const f = env.app.drops.get(w.id).found.find((x) => x.sku === 'lego-castle-set-11');
  assert.ok(f, 'seen now');
  assert.notEqual(f.arm, 'armed', JSON.stringify(f));
  assert.equal(runsFor('lego-castle-set-11', 'demo-jbhifi').length, 0, 'never bought');
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
  await clean();
});
