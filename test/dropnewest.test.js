// A drop watch and a card shop's newest products (Pokébox's): what isn't a card is a drop for the watch only when the
// shop put it up after the watch's first look — not something it's had on sale for days that the watch's own search
// didn't return.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { NEWEST } from '../server/monitor/sweep.js';

let env;
let store;
let discord;
let boss;
const DAY = 24 * 3600 * 1000;

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  makeMember(env, boss);
  for (const it of (await boss.get('/api/items')).body.items) await boss.del(`/api/items/${it.id}`);
  // Auto-checkout on, with a browser listening.
  assert.equal((await boss.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 2000, perDay: 10, spendPerDay: 20000 })).status, 200);
  env.app.repo.addDevice(boss.user.id, 'Chrome on Mac', '1.16.0');
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-pokebox': 'server' } })).status, 200);
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const sw = () => env.app.sweeper;
const pb = () => env.app.retailers.get('demo-pokebox');
const FEED = { keyword: NEWEST, page: 1 };
const runsFor = (itemId) => env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: itemId });
const plush = (sku, title, n, at) => ({
  sku, aliases: [String(9100000 + n)], title, price: 49.95, inStock: true, url: `${store.url}/pokebox/products/${sku}`,
  variantId: String(9200000 + n), oneVariant: true, marketplace: false, sellers: [], ...at,
});
const CARD = { sku: 'pokemon-tcg-test-etb', aliases: ['9100009'], title: 'Pokemon TCG: Test Elite Trainer Box', price: 79.95, inStock: true, url: '', variantId: '9200009', oneVariant: true, marketplace: false, sellers: [] };
// Its newest products, read from the server.
const read = (products) => sw().ingest(pb(), FEED, { products, total: products.length, problem: null }, { source: 'server', url: sw().urlFor(pb(), NEWEST, 1), ms: 100 });
// A drop watch for everyone, with Auto-checkout, and its own first look (the shop's search doesn't return it).
async function watch(words) {
  const r = await boss.post('/api/drops', { store: 'demo-pokebox', words, aco: true, maxPrice: 100 });
  assert.equal(r.status, 200, r.text);
  const own = { keyword: words, page: 1, drop: 'shared' };
  const s = await sw().ingest(pb(), own, { products: [], total: 0, problem: null }, { source: 'server', url: sw().urlFor(pb(), words, 1, { vip: true }), ms: 100 });
  assert.equal(s.ok, true, s.error);
  assert.ok(env.app.drops.get(r.body.watch.id).baselineAt, 'its first look');
  return r.body.watch;
}

test("🛡️ a card shop's newest products show a plush it's had on sale for days, which the drop watch's own search didn't return: not a drop for the watch — never bought", async () => {
  const old = plush('pikachu-plush-30cm', 'Pikachu Plush 30cm', 1, { createdAt: Date.now() - 3 * DAY, publishedAt: Date.now() - 3 * DAY });
  // The newest products before the watch (their scene).
  assert.equal((await read([CARD, old])).baseline, true);
  const w = await watch('pikachu plush');
  // Read again: still there, on sale all along.
  const s = await read([CARD, old]);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.baseline, false);
  const item = env.app.repo.itemBySku(boss.user.id, 'demo-pokebox', 'pikachu-plush-30cm');
  assert.ok(!item || !item.aco, 'never armed');
  assert.equal(item ? runsFor(item.id).length : 0, 0, 'no Auto-checkout run');
  assert.deepEqual(env.app.drops.get(w.id).found.map((f) => [f.sku, f.arm]), [['pikachu-plush-30cm', 'skipped']]);
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🆕 …but one the shop drafted days ago and publishes after the watch's first look is its drop: armed and bought the moment the newest products show it", async () => {
  const w = await watch('charizard plush');
  // Drafted three days ago; put up just now.
  const drafted = plush('charizard-plush-30cm', 'Charizard Plush 30cm', 2, { createdAt: Date.now() - 3 * DAY, publishedAt: Date.now() });
  const s = await read([CARD, drafted]);
  assert.equal(s.ok, true, s.error);
  const item = env.app.repo.itemBySku(boss.user.id, 'demo-pokebox', 'charizard-plush-30cm');
  assert.ok(item && item.aco && item.dropWatch === w.id, 'armed for the admin, as the watch says');
  assert.equal(runsFor(item.id).length, 1, 'bought the moment it was found');
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🆕 …and one the shop's list says nothing of when it was made is a drop, as ever", async () => {
  const w = await watch('eevee plush');
  const s = await read([CARD, plush('eevee-plush-30cm', 'Eevee Plush 30cm', 3, {})]);
  assert.equal(s.ok, true, s.error);
  const item = env.app.repo.itemBySku(boss.user.id, 'demo-pokebox', 'eevee-plush-30cm');
  assert.ok(item && item.aco && item.dropWatch === w.id, 'armed');
  assert.equal(runsFor(item.id).length, 1, 'bought');
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});
