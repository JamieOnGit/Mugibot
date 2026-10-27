// An Auto-checkout watch never buys what was on sale before it was added (docs/MONITORING.md, VIP drops): a product the
// catalogue had before the watch, whatever it last said of it (an old "sold out" or "not listed"), is decided by its own
// page — and only by a read of it that worked (a refused one decides nothing).
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

test('🛡️ an old "not listed" reading (a month before the watch, on sale since) is no drop either: never bought', async () => {
  // The store's "pokemon" search before the watch: its scene, the spinner in the catalogue.
  await sw().sweepTerm(cb(), { keyword: 'pokemon', page: 1 });
  assert.equal((await sw().sweepTerm(cb(), { keyword: 'pokemon', page: 1 })).baseline, false);
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
