// VIP drops (docs/MONITORING.md → VIP drops): admins' watches — a store and the words in a
// product's name, or a product page — posted in #vip-drop only, searched / read every few seconds
// around the drop time, and armed for the admin's Auto-checkout when asked. Against the City
// Beach-style dummy store (tests never touch real stores).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { DUMMY_PRODUCTS, dummyProductPath } from '../server/presets.js';

let env;
let store;
let discord;
let boss;
let ash;
let clock;
let vipChannel;
const MISC = '700000000000000777';
const BOARD = '20499999-01';
const NINJA = '20424049-01';

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  clock = { offset: 0 };
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, now: () => Date.now() + clock.offset, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  makeMember(env, boss);
  makeMember(env, ash);
  for (const c of [boss, ash]) for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const R = (id) => env.app.retailers.get(id);
const sw = () => env.app.sweeper;
const product = (sku) => env.app.catalog.productFor('demo-citybeach', sku);
const posts = (id) => discord.channelPosts(id);
const pathOf = (sku) => dummyProductPath('citybeach', DUMMY_PRODUCTS.citybeach.find((p) => p.sku === sku));

test('⭐ #vip-drop: admins only; the bot makes it in a "VIP" category, with a rule that takes VIP drops only', async () => {
  assert.equal((await ash.get('/api/monitor/vip')).status, 404, 'members can\'t see VIP watches');
  assert.equal((await ash.post('/api/monitor/vip/channel', {})).status, 404);
  let r = await boss.get('/api/monitor/vip');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.route, null);
  assert.ok(r.body.stores.some((s) => s.id === 'citybeach' && s.aco), 'City Beach can be watched (and auto-checked out)');
  r = await boss.post('/api/monitor/vip/channel', {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.channel.name, 'vip-drop');
  assert.equal(r.body.channel.made, true);
  const cat = discord.state.channels.find((c) => c.type === 4 && c.name === 'VIP');
  assert.ok(cat, 'a VIP category');
  assert.equal(discord.state.channels.find((c) => c.name === 'vip-drop').parent_id, cat.id);
  assert.equal(r.body.route.vip, true);
  assert.deepEqual(r.body.route.kinds, ['restock', 'listed', 'price_drop']);
  vipChannel = r.body.channel.id;
  // Again: found, not made twice; the same rule.
  const again = await boss.post('/api/monitor/vip/channel', {});
  assert.equal(again.body.channel.made, false);
  assert.equal(again.body.route.id, r.body.route.id);
  // The store channels' set-up (with "remove my other rules") keeps it.
  assert.equal((await boss.post('/api/monitor/routes', { name: '#misc', channelId: MISC, kinds: ['restock', 'listed'], fallback: true })).status, 200);
});

test('⭐ a keyword watch at City Beach: a new Pokémon skateboard is posted in #vip-drop only, monitored, armed for Auto-checkout — which starts when its page says in stock', async () => {
  // Auto-checkout on for the admin, with a browser listening.
  assert.equal((await boss.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 400, perDay: 5, spendPerDay: 800 })).status, 200);
  env.app.repo.addDevice(boss.user.id, 'Chrome on Mac', '1.12.0');
  // Checked first.
  assert.equal((await boss.post('/api/monitor/vip', { store: 'demo-citybeach', words: 'x' })).status, 400);
  assert.equal((await boss.post('/api/monitor/vip', {})).status, 400);
  assert.equal((await boss.post('/api/monitor/vip', { store: 'demo-citybeach', words: 'pokemon skate', aco: true })).status, 400, 'a max price to auto-checkout');
  const dropAt = Date.now() + 10 * 60 * 1000;
  const r = await boss.post('/api/monitor/vip', { store: 'demo-citybeach', words: 'Pokémon Skate', label: 'Pokémon skateboard', dropAt, aco: true, maxPrice: 150 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.equal(w.words, 'pokemon skate');
  assert.equal(w.fastNow, true, 'in its window (10 minutes before)');
  assert.equal((await boss.post('/api/monitor/vip', { store: 'demo-citybeach', words: 'pokemon skate' })).status, 400, 'not twice');

  // In the window its words are all City Beach is searched for, every 4 s.
  const cb = R('demo-citybeach');
  const term = sw().nextTerm(cb);
  assert.deepEqual(term, { keyword: 'pokemon skate', page: 1, vip: w.id });
  assert.equal(sw().paceFor(cb), 4000);
  assert.equal(sw().urlFor(cb, term.keyword, 1, { vip: true }), `${store.url}/citybeach/search?q=pokemon%20skate&srule=newest&sz=48`);

  // The first search sets the scene (the board isn't listed yet; the booster pack isn't a match).
  let s = await sw().sweepTerm(cb, term);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.baseline, true);
  assert.equal(s.kept, 0);
  // It drops.
  store.set('citybeach', BOARD, { listed: true });
  const vipBefore = posts(vipChannel).length;
  s = await sw().sweepTerm(cb, sw().nextTerm(cb));
  assert.equal(s.new, 1, s.error);
  const board = product(BOARD);
  assert.equal(board.name, 'Pokémon Pikachu Complete Skateboard', 'brand + name, as the tile has them');
  assert.equal(board.category, 'pokemon');
  const [listed] = env.app.catalog.recentAlerts({ kind: 'listed', limit: 5 });
  assert.equal(listed.sku, BOARD);
  assert.equal(listed.vip, true);
  const vipPosts = posts(vipChannel).slice(vipBefore);
  assert.equal(vipPosts.length, 1, 'posted in #vip-drop');
  assert.match(vipPosts[0].body.embeds[0].title, /^⭐ VIP · 🆕 New drop: Pokémon Pikachu Complete Skateboard/);
  assert.ok(vipPosts[0].body.components[0].components.some((b) => b.label === '⚡ Buy with Mugibot'));
  assert.equal(posts(MISC).length, 0, 'not in the catch-all (or any store channel)');

  // A VIP monitor on it, and on the admin's watchlist, armed up to $150.
  const mon = env.app.catalog.monitorForProduct(board.id);
  assert.equal(mon.vip_watch, w.id);
  assert.equal(env.app.monitor.pageInterval(board.url), 5000, 'its page every 5 s in the window');
  const item = env.app.repo.itemBySku(boss.user.id, 'demo-citybeach', BOARD);
  assert.ok(item, 'on the watchlist');
  assert.equal(item.aco, true);
  assert.equal(item.maxPrice, 150);
  const view = (await boss.get('/api/monitor/vip')).body.watches[0];
  assert.deepEqual(view.found.map((p) => p.name), ['Pokémon Pikachu Complete Skateboard']);

  // Its page says in stock: the admin's browser starts checking out. (Its stock read for the first
  // time: the 🆕 already said it dropped — no second alert.)
  const vipPosted = posts(vipChannel).length;
  await env.app.monitor.checkPage(board.url);
  assert.equal(product(BOARD).status, 'in_stock');
  assert.equal(posts(vipChannel).length, vipPosted);
  assert.equal(posts(MISC).length, 0);
  const runs = env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: item.id });
  assert.equal(runs.length, 1, 'Auto-checkout started');
  assert.equal(runs[0].status, 'queued');
  assert.equal(runs[0].price, 129.99);
  // Sold out, then back: a restock — 🟢 in #vip-drop.
  store.set('citybeach', BOARD, { status: 'out_of_stock' });
  await env.app.monitor.checkPage(board.url);
  store.set('citybeach', BOARD, { status: 'in_stock' });
  await env.app.monitor.checkPage(board.url);
  const [restock] = env.app.catalog.recentAlerts({ kind: 'restock', limit: 5 });
  assert.equal(restock.sku, BOARD);
  assert.equal(restock.vip, true);
  assert.match(posts(vipChannel).at(-1).body.embeds[0].title, /⭐ VIP · 🟢 In stock: Pokémon Pikachu Complete Skateboard/);
  assert.equal(posts(MISC).length, 0);
  // Found again by later searches: armed once only (bought → disarmed stays disarmed).
  env.app.aco.disarm(boss.user.id, item.id);
  await sw().sweepTerm(cb, sw().nextTerm(cb));
  assert.equal(env.app.repo.getItem(boss.user.id, item.id).aco, false);

  // The store's ordinary keyword search counts it too ("trading cards only" doesn't leave it out).
  s = await sw().sweepTerm(cb, { keyword: 'pokemon', page: 1 });
  assert.equal(s.kept, 2, 'the booster pack and the VIP skateboard');
  // Out of its window: every other search, at the store's own pace.
  clock.offset = 4 * 3600 * 1000;
  assert.equal(sw().paceFor(cb), 10000);
  const turns = [sw().nextTerm(cb), sw().nextTerm(cb)];
  assert.equal(turns.filter((t) => t.vip).length, 1);
  assert.equal(env.app.monitor.pageInterval(board.url), 15000);
  clock.offset = 0;
});

test('⭐ a broad watch with Auto-checkout arms only what drops: what was already on sale when it was added is left alone (no alerts either); removing it disarms what it armed', async () => {
  const add = (sku, name, status, price) => store.shop('citybeach').products.push({ sku, name, price, status, listed: true, maxQty: 0, qtyStyle: 'input', lateMs: 0, id: 4400000 + Number(sku.slice(4, 8)) });
  add('20481111-01', 'Pokémon Beach Towel', 'in_stock', 39.99);
  add('20482222-01', 'Pokémon Beach Bag', 'coming_soon', 49.99);
  const r = await boss.post('/api/monitor/vip', { store: 'demo-citybeach', words: 'pokemon beach', aco: true, maxPrice: 350 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  const cb = R('demo-citybeach');
  const vipPosted = posts(vipChannel).length;
  // Its first search: both are listed already — neither is armed yet.
  const s = await sw().sweepTerm(cb, { keyword: w.words, page: 1, vip: w.id });
  assert.equal(s.baseline, true);
  assert.equal(s.kept, 2);
  const towel = product('20481111-01');
  const bag = product('20482222-01');
  assert.ok(!env.app.repo.itemBySku(boss.user.id, 'demo-citybeach', '20481111-01'), 'not armed before its page is read');
  // Their pages: the towel is on sale already (left alone), the bag isn't yet (armed).
  await env.app.monitor.checkPage(towel.url);
  await env.app.monitor.checkPage(bag.url);
  assert.equal(product('20481111-01').status, 'in_stock');
  assert.equal(product('20482222-01').status, 'coming_soon');
  assert.ok(!env.app.repo.itemBySku(boss.user.id, 'demo-citybeach', '20481111-01'), 'on sale before the watch: never bought');
  const bagItem = env.app.repo.itemBySku(boss.user.id, 'demo-citybeach', '20482222-01');
  assert.equal(bagItem.aco, true);
  assert.equal(bagItem.maxPrice, 350);
  assert.equal(posts(vipChannel).length, vipPosted, 'no alerts for what was there already');
  const view = (await boss.get('/api/monitor/vip')).body.watches.find((x) => x.id === w.id);
  assert.deepEqual(view.found.map((p) => [p.name, p.arm]), [['Pokémon Beach Towel', 'skipped'], ['Pokémon Beach Bag', 'armed']]);
  assert.ok(env.app.repo.listEvents(boss.user.id).some((e) => /Pokémon Beach Towel was on sale already when the watch was added/.test(e.message)));
  // The bag goes on sale: 🟢 in #vip-drop, and Auto-checkout starts.
  store.set('citybeach', '20482222-01', { status: 'in_stock' });
  await env.app.monitor.checkPage(bag.url);
  assert.match(posts(vipChannel).at(-1).body.embeds[0].title, /⭐ VIP · 🟢 In stock: Pokémon Beach Bag/);
  assert.equal(env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: bagItem.id }).length, 1);
  // Removed: what it armed is disarmed.
  assert.equal(env.app.repo.getItem(boss.user.id, bagItem.id).aco, true);
  assert.equal((await boss.del(`/api/monitor/vip/${w.id}`)).status, 200);
  assert.equal(env.app.repo.getItem(boss.user.id, bagItem.id).aco, false, 'disarmed with the watch');
});

test('⭐ a product page watch: a VIP monitor read every 5 s around its drop time; removing the watch removes its monitor', async () => {
  const url = `${store.url}${pathOf(NINJA)}`;
  const r = await boss.post('/api/monitor/vip', { url, dropAt: Date.now() });
  assert.equal(r.status, 200, r.text);
  const ninja = product(NINJA);
  assert.ok(ninja, 'the product');
  const mon = env.app.catalog.monitorForProduct(ninja.id);
  assert.equal(mon.vip_watch, r.body.watch.id);
  assert.equal(env.app.monitor.pageInterval(url), 5000);
  await env.app.monitor.checkPage(url);
  assert.equal(product(NINJA).status, 'in_stock');
  assert.deepEqual((await boss.get('/api/monitor/vip')).body.watches.find((x) => x.id === r.body.watch.id).found.map((p) => p.status), ['in_stock']);
  // A routine alert of a product nobody picked out never goes to #vip-drop.
  const plain = env.app.catalog.upsertProduct({ store: 'demo-citybeach', sku: '20400000-01', name: 'Pokémon Booster', url: `${store.url}/citybeach/x/20400000-01.html` });
  const before = posts(vipChannel).length;
  await env.app.feed.alert(env.app.catalog.updateProduct(plain.id, { status: 'in_stock' }), 'restock', { sweep: true });
  assert.equal(posts(vipChannel).length, before);
  assert.equal(posts(MISC).length, 1, 'it went to the catch-all');
  assert.equal((await boss.del(`/api/monitor/vip/${r.body.watch.id}`)).status, 200);
  assert.ok(!env.app.catalog.monitorForProduct(ninja.id), 'its monitor is gone');
  assert.equal((await boss.del(`/api/monitor/vip/${r.body.watch.id}`)).status, 404);
});
