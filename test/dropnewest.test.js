// A drop watch and a card shop's newest products (Pokébox's, read as its newest products since this update — each
// keyword's second page before): what isn't a card is a drop for the watch only when the watch's own search finds it, as
// ever — never something the shop's had on sale that the watch's own search didn't return, however the list was read.
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
const plush = (sku, title, n, at = {}) => ({
  sku, aliases: [String(9100000 + n)], title, price: 49.95, inStock: true, url: `${store.url}/pokebox/products/${sku}`,
  variantId: String(9200000 + n), oneVariant: true, marketplace: false, sellers: [], ...at,
});
const CARD = { sku: 'pokemon-tcg-test-etb', aliases: ['9100009'], title: 'Pokemon TCG: Test Elite Trainer Box', price: 79.95, inStock: true, url: '', variantId: '9200009', oneVariant: true, marketplace: false, sellers: [] };
// Its newest products, read from the server.
const read = (products) => sw().ingest(pb(), FEED, { products, total: products.length, problem: null }, { source: 'server', url: sw().urlFor(pb(), NEWEST, 1), ms: 100 });
// A drop watch for everyone, with Auto-checkout, and its own first look (the shop's search doesn't return it).
async function watch(words, { mine = false } = {}) {
  const r = await boss.post('/api/drops', { store: 'demo-pokebox', words, aco: true, maxPrice: 100, ...(mine ? { shared: false } : {}) });
  assert.equal(r.status, 200, r.text);
  const own = { keyword: words, page: 1, drop: mine ? 'private' : 'shared' };
  const s = await sw().ingest(pb(), own, { products: [], total: 0, problem: null }, { source: 'server', url: sw().urlFor(pb(), words, 1, { vip: true }), ms: 100 });
  assert.equal(s.ok, true, s.error);
  assert.ok(env.app.drops.get(r.body.watch.id).baselineAt, 'its first look');
  return r.body.watch;
}
const bought = (sku) => {
  const item = env.app.repo.itemBySku(boss.user.id, 'demo-pokebox', sku);
  return { armed: !!(item && item.aco), runs: item ? runsFor(item.id).length : 0 };
};

test("🛡️ a card shop's newest products show a plush it's had on sale for days, which the drop watch's own search didn't return: not a drop for the watch — never bought", async () => {
  const old = plush('pikachu-plush-30cm', 'Pikachu Plush 30cm', 1, { createdAt: Date.now() - 3 * DAY, publishedAt: Date.now() - 3 * DAY });
  // The newest products before the watch (their scene).
  assert.equal((await read([CARD, old])).baseline, true);
  const w = await watch('pikachu plush');
  // Read again: still there, on sale all along.
  const s = await read([CARD, old]);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.baseline, false);
  assert.deepEqual(bought('pikachu-plush-30cm'), { armed: false, runs: 0 }, 'never armed, no Auto-checkout run');
  assert.deepEqual(env.app.drops.get(w.id).found.map((f) => [f.sku, f.arm]), [['pikachu-plush-30cm', 'skipped']]);
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🛡️ …nor one the shop put up a minute before the watch was added (a member's own watch too)", async () => {
  const fresh = plush('snorlax-plush-30cm', 'Snorlax Plush 30cm', 2, { createdAt: Date.now() - 60 * 1000 });
  const w = await watch('snorlax plush', { mine: true });
  const s = await read([CARD, fresh]);
  assert.equal(s.ok, true, s.error);
  assert.deepEqual(bought('snorlax-plush-30cm'), { armed: false, runs: 0 });
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🛡️ …nor when an admin's browser reads the newest products (its list carries no dates)", async () => {
  const w = await watch('eevee plush');
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-pokebox': 'browser' } })).status, 200);
  const out = await sw().browserResults(env.app.repo.userById(boss.user.id), [{
    store: 'demo-pokebox', keyword: NEWEST, page: 1, ok: true, ms: 300,
    products: [CARD, plush('eevee-plush-30cm', 'Eevee Plush 30cm', 3)].map(({ createdAt, publishedAt, ...p }) => ({ ...p, url: p.url || `${store.url}/pokebox/products/${p.sku}` })),
  }]);
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-pokebox': 'server' } })).status, 200);
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, true, out[0].error);
  assert.deepEqual(bought('eevee-plush-30cm'), { armed: false, runs: 0 });
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🆕 a new plush the watch's own search finds after its first look: its drop — armed and bought the moment it's found", async () => {
  const r = await boss.post('/api/drops', { store: 'demo-pokebox', words: 'charizard plush', aco: true, maxPrice: 100 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  const own = { keyword: 'charizard plush', page: 1, drop: 'shared' };
  const url = sw().urlFor(pb(), 'charizard plush', 1, { vip: true });
  // Its first look (monitor/sightings.js): what's listed then — a read with something in it (an empty one may be the
  // store's hiccup), holding every result (fewer came than the 10 its link asks for).
  const KEY = plush('charizard-plush-keychain', 'Charizard Plush Keychain', 5);
  assert.equal((await sw().ingest(pb(), own, { products: [KEY], total: 1, count: 1, problem: null }, { source: 'server', url, ms: 100 })).ok, true);
  await new Promise((done) => setTimeout(done, 5));
  const s = await sw().ingest(pb(), own, { products: [plush('charizard-plush-30cm', 'Charizard Plush 30cm', 4), KEY], total: 2, count: 2, problem: null }, { source: 'server', url, ms: 100 });
  assert.equal(s.ok, true, s.error);
  await env.app.monitor.delivered();
  assert.deepEqual(bought('charizard-plush-30cm'), { armed: true, runs: 1 });
  assert.deepEqual(bought('charizard-plush-keychain'), { armed: false, runs: 0 }, 'listed already, on sale: never bought');
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});
