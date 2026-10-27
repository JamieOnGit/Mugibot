// What an Auto-checkout watch buys (docs/MONITORING.md → What an Auto-checkout watch buys), the cases adversarial reviews
// of the design found (two rounds, each one reviewer for wrong buys and one for lost ones): each a wrong buy (something
// on sale when the watch was added, bought) or a lost one (a drop after it was added, not bought). Against the dummy
// stores (tests never touch real stores).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';

let env;
let store;
let discord;
let boss;
let ash;
let clock;
// The stores searched (each test's changes put back after it).
const STORES = { 'demo-citybeach': 'server', 'demo-jbhifi': 'server', 'demo-kmart': 'server', 'demo-target': 'server', 'demo-bigw': 'browser', 'demo-fromthedeep': 'server', 'demo-amazon': 'browser', 'demo-trainertown': 'server' };

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  clock = { offset: 0 };
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, now: () => Date.now() + clock.offset, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  for (const [c, d] of [[boss, 'd-boss'], [ash, 'd-ash']]) {
    makeMember(env, c);
    env.app.repo.updateUser(c.user.id, { discord_id: d });
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
    assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 5000, perDay: 50, spendPerDay: 50000 })).status, 200);
    env.app.repo.addDevice(c.user.id, 'Chrome on Mac', '1.37.0');
  }
  assert.equal((await boss.put('/api/monitor/sweep', { stores: STORES })).status, 200);
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const R = (id) => env.app.retailers.get(id);
const sw = () => env.app.sweeper;
const product = (storeId, sku) => env.app.catalog.productFor(storeId, sku);
const itemOf = (c, storeId, sku) => env.app.repo.itemBySku(c.user.id, storeId, sku);
const runsFor = (item) => (item ? env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: item.id }) : []);
const armed = (c, storeId, sku) => { const it = itemOf(c, storeId, sku); return !!(it && it.aco); };
const tick = async () => { clock.offset += 61 * 1000; const n = await env.app.pages.tick(); await env.app.monitor.delivered(); return n; };

test("🛡️ on sale for weeks, it moves up into a card search's top 10 (JB Hi-Fi's): not a new card listing — a broad VIP watch never buys it", async () => {
  const jb = R('demo-jbhifi');
  for (const p of store.shop('jbhifi').products) p.listed = false;
  const fill = (i) => `pokemon-tcg-filler-tin-${i}`;
  for (let i = 1; i <= 10; i++) store.addProduct('jbhifi', { sku: fill(i), name: `Pokemon TCG Filler Tin ${i}`, price: 20, status: 'in_stock' });
  const OLD = 'pokemon-tcg-charizard-ultra-premium-collection';
  store.addProduct('jbhifi', { sku: OLD, name: 'Pokemon TCG Charizard Ultra Premium Collection', price: 199, status: 'in_stock' });
  // The card search for weeks: its top 10 (the UPC, 11th, never in view).
  await sw().sweepTerm(jb, { keyword: 'pokemon', page: 1 });
  await sw().sweepTerm(jb, { keyword: 'pokemon', page: 1 });
  clock.offset += 60 * 1000;
  // A broad VIP watch, Auto-checkout on. The UPC has been on sale all along.
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-jbhifi', words: 'pokemon tcg', aco: true, maxPrice: 300 })).body.watch;
  await sw().sweepTerm(jb, { keyword: 'pokemon tcg', page: 1, vip: v.id }); // its own first look: top 10, not whole
  clock.offset += 10 * 1000;
  await sw().sweepTerm(jb, { keyword: 'pokemon', page: 1 }); // card search, after the watch was added
  // A tin sells out (unavailable_products=last pushes it down): the UPC moves up into the card search's top 10.
  store.set('jbhifi', fill(1), { listed: false });
  clock.offset += 10 * 1000;
  await sw().sweepTerm(jb, { keyword: 'pokemon', page: 1 });
  await env.app.monitor.delivered();
  const it = itemOf(boss, 'demo-jbhifi', OLD);
  assert.equal(runsFor(it).length, 0, `on sale before the watch was added: never bought (armed=${it && it.aco})`);
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

test("🛡️ a collection page watch (From The Deep's sealed products): a pre-order, on sale all along, put in the collection on release day is never bought", async () => {
  const PRE = 'pokemon-tcg-destined-rivals-elite-trainer-box';
  store.addProduct('fromthedeep', { sku: PRE, name: 'Pokemon TCG Destined Rivals Elite Trainer Box', price: 95, status: 'preorder' });
  // The live sweeps know it: its Preorders collection (the store's newest list) says pre-order (on sale).
  const ftd = R('demo-fromthedeep');
  await sw().sweepTerm(ftd, { keyword: '+', page: 1 });
  assert.equal(product('demo-fromthedeep', PRE).status, 'preorder', 'catalogue: on sale (pre-order)');
  const page = `${store.url}/fromthedeep/collections/pokemon-tcg`;
  const r = await ash.post('/api/drops', { page, phrases: ['elite trainer box'], every: 15, aco: true, maxPrice: 200 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  await tick(); // first look: the sealed collection (pre-orders left out)
  assert.equal(itemOf(ash, 'demo-fromthedeep', PRE), null);
  // Release day: the pre-order is in stock, and the store moves it into its Sealed collection.
  store.set('fromthedeep', PRE, { status: 'in_stock' });
  await tick();
  const it = itemOf(ash, 'demo-fromthedeep', PRE);
  assert.equal(runsFor(it).length, 0, `on sale (pre-order) when the watch was added: never bought (armed=${it && it.aco})`);
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("🛡️ two empty answers in a row at a first look (a search hiccup): what was on sale all along isn't bought when the search answers again", async () => {
  const km = R('demo-kmart');
  const sku = (i) => String(44300000 + i);
  for (let i = 1; i <= 3; i++) store.addProduct('kmart', { sku: sku(i), name: `Bluey Plush Mega Set ${i}`, price: 30 + i, status: 'in_stock' });
  const w = (await ash.post('/api/drops', { store: 'demo-kmart', words: 'bluey plush', aco: true, maxPrice: 100 })).body.watch;
  store.shop('kmart').noResultsFor = 'bluey';
  for (let i = 0; i < 2; i++) assert.equal((await sw().sweepTerm(km, { keyword: 'bluey plush', page: 1, drop: 'private' })).found, 0);
  store.shop('kmart').noResultsFor = null;
  clock.offset += 10 * 1000;
  await sw().sweepTerm(km, { keyword: 'bluey plush', page: 1, drop: 'private' });
  await env.app.monitor.delivered();
  const bought = [1, 2, 3].filter((i) => runsFor(itemOf(ash, 'demo-kmart', sku(i))).length > 0);
  assert.deepEqual(bought, [], 'on sale all along: never bought');
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("🛡️ a product on sale that the store renames to have the watch's words (a set announced): never bought", async () => {
  const km = R('demo-kmart');
  const SKU = '44400001';
  store.addProduct('kmart', { sku: SKU, name: 'Pokemon TCG Booster Bundle Pre-Order', price: 45, status: 'preorder' });
  await sw().sweepTerm(km, { keyword: 'pokemon', page: 1 });
  await sw().sweepTerm(km, { keyword: 'pokemon', page: 1 });
  assert.equal(product('demo-kmart', SKU).status, 'preorder', 'catalogue: on sale');
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-kmart', words: 'surging sparks', aco: true, maxPrice: 100 })).body.watch;
  for (let i = 0; i < 2; i++) await sw().sweepTerm(km, { keyword: 'surging sparks', page: 1, vip: v.id });
  // The set is announced: the store renames its listing.
  store.set('kmart', SKU, { name: 'Pokemon TCG Surging Sparks Booster Bundle' });
  clock.offset += 10 * 1000;
  await sw().sweepTerm(km, { keyword: 'surging sparks', page: 1, vip: v.id });
  await env.app.monitor.delivered();
  const it = itemOf(boss, 'demo-kmart', SKU);
  assert.equal(runsFor(it).length, 0, `on sale when the watch was added: never bought (armed=${it && it.aco})`);
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

test("🛡️ the catalogue has it under another of its codes (Target's P-code): a page read saying sold out never arms what the watch saw on sale", async () => {
  const tg = R('demo-target');
  const SKU = '71288001';
  const url = store.addProduct('target', { sku: SKU, name: 'Nintendo Switch OLED Zelda Edition', price: 539, status: 'in_stock' });
  // The catalogue knows it under its product code (as Target's search names it when it has two colours).
  env.app.catalog.upsertProduct({ store: 'demo-target', sku: `P${SKU}`, url, name: 'Nintendo Switch OLED Zelda Edition' });
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-target', words: 'switch oled zelda', aco: true, maxPrice: 600 })).body.watch;
  await sw().sweepTerm(tg, { keyword: 'switch oled zelda', page: 1, vip: v.id }); // its own search: on sale
  const vf = () => env.app.monitor.vip.get(v.id).found.map((f) => f.arm);
  assert.deepEqual(vf(), ['skipped'], 'seen on sale: skipped');
  clock.offset += 4 * 60 * 1000;
  store.set('target', SKU, { status: 'out_of_stock' });
  await env.app.monitor.checkPage(product('demo-target', `P${SKU}`).url);
  const armedNow = vf();
  store.set('target', SKU, { status: 'in_stock' });
  await sw().sweepTerm(tg, { keyword: 'switch oled zelda', page: 1, vip: v.id });
  await env.app.monitor.delivered();
  const it = env.app.repo.itemBySku(boss.user.id, 'demo-target', `P${SKU}`) || itemOf(boss, 'demo-target', SKU);
  assert.deepEqual(armedNow, ['skipped'], 'a later sold-out page read never arms it');
  assert.equal(runsFor(it).length, 0, 'never bought');
});

test("🛡️ a search page watch's key phrases changed: what was on the page, on sale, all along isn't bought", async () => {
  const A = '44600001';
  const B = '44600002';
  store.addProduct('kmart', { sku: A, name: 'Magic: The Gathering Duskmourn Bundle', price: 79, status: 'in_stock' });
  store.addProduct('kmart', { sku: B, name: 'Magic: The Gathering Duskmourn Collector Booster Box', price: 299, status: 'in_stock' });
  const r = await boss.post('/api/drops', { page: `${store.url}/kmart/search/?searchTerm=duskmourn`, phrases: ['duskmourn bundle'], every: 3, aco: true, maxPrice: 400 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  await tick(); // its first look: both on the page, on sale
  await tick();
  // The admin adds a phrase.
  const u = await boss.put(`/api/drops/${w.id}`, { phrases: ['duskmourn bundle', 'collector booster'] });
  assert.equal(u.status, 200, u.text);
  await tick();
  const it = itemOf(boss, 'demo-kmart', B);
  assert.equal(runsFor(it).length, 0, `on the page, on sale, since before the watch was added: never bought (armed=${it && it.aco})`);
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🛡️ a VIP watch whose first answers were empty: products the catalogue had on sale aren't bought when the search answers again", async () => {
  const km = R('demo-kmart');
  const sku = (i) => String(44700000 + i);
  for (let i = 1; i <= 2; i++) store.addProduct('kmart', { sku: sku(i), name: `Pokemon TCG Stellar Crown Tin ${i}`, price: 30 + i, status: 'in_stock' });
  await sw().sweepTerm(km, { keyword: 'pokemon', page: 1 });
  await sw().sweepTerm(km, { keyword: 'pokemon', page: 1 });
  assert.equal(product('demo-kmart', sku(1)).status, 'in_stock');
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-kmart', words: 'stellar crown', aco: true, maxPrice: 100 })).body.watch;
  store.shop('kmart').noResultsFor = 'stellar';
  for (let i = 0; i < 2; i++) await sw().sweepTerm(km, { keyword: 'stellar crown', page: 1, vip: v.id });
  store.shop('kmart').noResultsFor = null;
  clock.offset += 10 * 1000;
  await sw().sweepTerm(km, { keyword: 'stellar crown', page: 1, vip: v.id });
  await env.app.monitor.delivered();
  const bought = [1, 2].filter((i) => runsFor(itemOf(boss, 'demo-kmart', sku(i))).length > 0);
  assert.deepEqual(bought, [], 'on sale all along: never bought');
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

test("🛡️ in the watch's first look all along under a misspelt name: the store fixes the name — never bought", async () => {
  const km = R('demo-kmart');
  const SKU = '44800001';
  store.addProduct('kmart', { sku: SKU, name: 'Pokemon TCG Prismatic Evolution Elite Trainer Box', price: 89, status: 'in_stock' });
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-kmart', words: 'prismatic evolutions', aco: true, maxPrice: 150 })).body.watch;
  const s = await sw().sweepTerm(km, { keyword: 'prismatic evolutions', page: 1, vip: v.id });
  assert.ok(s.found >= 1, 'the store returned it in the first look');
  store.set('kmart', SKU, { name: 'Pokemon TCG Prismatic Evolutions Elite Trainer Box' });
  clock.offset += 10 * 1000;
  await sw().sweepTerm(km, { keyword: 'prismatic evolutions', page: 1, vip: v.id });
  await env.app.monitor.delivered();
  const it = itemOf(boss, 'demo-kmart', SKU);
  assert.equal(runsFor(it).length, 0, `in the first look, on sale: never bought (armed=${it && it.aco})`);
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

test("💸 a new listing another search sees first (City Beach: no stock in its tiles), then shown new by the watch's own search: armed and bought", async () => {
  const cb = R('demo-citybeach');
  const w = (await ash.post('/api/drops', { store: 'demo-citybeach', words: 'charizard skate', aco: true, maxPrice: 300 })).body.watch;
  assert.ok(w);
  // Its first look (nothing yet, twice); the card search goes on as usual.
  // (Two empty reads a minute apart: its first look's done.)
  for (let i = 0; i < 2; i++) { await sw().sweepTerm(cb, { keyword: 'charizard skate', page: 1, drop: 'private' }); clock.offset += 61 * 1000; }
  await sw().sweepTerm(cb, { keyword: 'pokemon', page: 1 });
  await sw().sweepTerm(cb, { keyword: 'pokemon', page: 1 });
  // The drop: listed after the watch's first look, on sale. The card search ("pokemon") sees it first — not a card,
  // so nothing says it's new yet (City Beach's tiles have no stock either).
  const SKU = '20477701-01';
  const url = store.addProduct('citybeach', { sku: SKU, name: 'Pokémon Charizard Skateboard', price: 129, status: 'in_stock' });
  await sw().sweepTerm(cb, { keyword: 'pokemon', page: 1 });
  // Its own search: new since the watch was added (its whole first look didn't have it) — armed.
  await sw().sweepTerm(cb, { keyword: 'charizard skate', page: 1, drop: 'private' });
  assert.equal(armed(ash, 'demo-citybeach', SKU), true, 'armed (new since the watch was added)');
  // Its page, read: on sale. And its own search again.
  await env.app.monitor.checkPage(url);
  await sw().sweepTerm(cb, { keyword: 'charizard skate', page: 1, drop: 'private' });
  await env.app.monitor.checkPage(url);
  await env.app.monitor.delivered();
  assert.equal(itemOf(ash, 'demo-citybeach', SKU).status, 'in_stock');
  assert.equal(runsFor(itemOf(ash, 'demo-citybeach', SKU)).length, 1, 'new, armed and on sale: bought');
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("💸 a watch whose first look came long after it was added (one from before this update; Target): a new listing its own search finds is bought", async () => {
  const tg = R('demo-target');
  const OLD = '71388001';
  const NEW = '71388002';
  store.addProduct('target', { sku: OLD, name: 'Zelda Hylian Shield Lamp', price: 59, status: 'in_stock' });
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-target', words: 'hylian shield', aco: true, maxPrice: 200 })).body.watch;
  // An hour on (the deploy; or Target couldn't be searched for a while), its first look.
  clock.offset += 60 * 60 * 1000;
  await sw().sweepTerm(tg, { keyword: 'hylian shield', page: 1, vip: v.id });
  await sw().sweepTerm(tg, { keyword: 'hylian shield', page: 1, vip: v.id });
  // The drop: a new listing, on sale.
  store.addProduct('target', { sku: NEW, name: 'Zelda Hylian Shield Replica', price: 149, status: 'in_stock' });
  await sw().sweepTerm(tg, { keyword: 'hylian shield', page: 1, vip: v.id });
  assert.equal(armed(boss, 'demo-target', NEW), true, 'a new listing after the watch was added: armed');
  await env.app.monitor.checkPage(product('demo-target', NEW).url);
  await env.app.monitor.delivered();
  assert.equal(runsFor(itemOf(boss, 'demo-target', NEW)).length, 1, 'bought');
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

test("💸 a VIP link added before the product is listed (Kmart: not listed yet): bought when it goes on sale", async () => {
  const SKU = '44388001';
  const url = store.addProduct('kmart', { sku: SKU, name: 'Nintendo Switch 2 Mario Kart World Bundle', price: 699, status: 'in_stock', listed: false });
  const r = await boss.post('/api/monitor/vip', { url, aco: true, maxPrice: 800 });
  assert.equal(r.status, 200, r.text);
  const v = r.body.watch;
  await env.app.monitor.checkPage(url);
  assert.equal(product('demo-kmart', SKU).status, 'not_listed');
  // (Said again a minute on: not listed — one answer alone may be its search provider's hiccup.)
  clock.offset += 60 * 1000;
  await env.app.monitor.checkPage(url);
  // Listed, on sale: the drop.
  store.set('kmart', SKU, { listed: true });
  clock.offset += 60 * 1000;
  await env.app.monitor.checkPage(url);
  await env.app.monitor.delivered();
  assert.equal(armed(boss, 'demo-kmart', SKU), true, 'not on sale (not listed) when the watch was added: armed');
  assert.equal(runsFor(itemOf(boss, 'demo-kmart', SKU)).length, 1, 'bought');
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

test("💸 a drop watch whose first look filled its room (10): a new listing another search sees first is still kept, armed and bought", async () => {
  const cb = R('demo-citybeach');
  for (let i = 1; i <= 11; i++) store.addProduct('citybeach', { sku: `${20466100 + i}-01`, name: `Bulbasaur Skate Tee ${i}`, price: 40 + i, status: 'in_stock' });
  const w = (await ash.post('/api/drops', { store: 'demo-citybeach', words: 'bulbasaur skate', aco: true, maxPrice: 300 })).body.watch;
  assert.ok(w);
  await sw().sweepTerm(cb, { keyword: 'bulbasaur skate', page: 1, drop: 'private' });
  assert.equal(env.app.drops.get(w.id).found.length, 10, 'its first look filled what it keeps');
  await sw().sweepTerm(cb, { keyword: 'pokemon', page: 1 });
  // The drop: a new listing, on sale; the card search ("pokemon") sees it first.
  const SKU = '20466199-01';
  const url = store.addProduct('citybeach', { sku: SKU, name: 'Pokémon Bulbasaur Skateboard', price: 119, status: 'in_stock' });
  await sw().sweepTerm(cb, { keyword: 'pokemon', page: 1 });
  await sw().sweepTerm(cb, { keyword: 'bulbasaur skate', page: 1, drop: 'private' });
  assert.ok(itemOf(ash, 'demo-citybeach', SKU), 'on the watchlist');
  assert.equal(armed(ash, 'demo-citybeach', SKU), true, 'new since the watch was added: armed');
  await env.app.monitor.checkPage(url);
  await env.app.monitor.delivered();
  assert.equal(runsFor(itemOf(ash, 'demo-citybeach', SKU)).length, 1, 'bought');
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("💸 JB Hi-Fi searched from an admin's browser (the same address as the server's) after the watch's first look was the server's: a new listing is bought", async () => {
  const jb = R('demo-jbhifi');
  store.addProduct('jbhifi', { sku: 'game-boy-color-classic-console', name: 'Game Boy Color Classic Console', price: 199, status: 'in_stock' });
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-jbhifi', words: 'game boy color', aco: true, maxPrice: 400 })).body.watch;
  await sw().sweepTerm(jb, { keyword: 'game boy color', page: 1, vip: v.id });
  // The store refuses the server under the drop's load: an admin's browser searches it.
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { ...STORES, 'demo-jbhifi': 'browser' } })).status, 200);
  const tile = (sku, title, price) => ({ sku, title, price, inStock: true, url: store.productUrl('jbhifi', sku) });
  const admin = env.app.repo.userById(boss.user.id);
  // The browser's first read of it (nothing new yet).
  await sw().browserResults(admin, [{ store: 'demo-jbhifi', keyword: 'game boy color', page: 1, ok: true, products: [tile('game-boy-color-classic-console', 'Game Boy Color Classic Console', 199)] }]);
  const NEW = 'game-boy-color-pikachu-edition';
  const url = store.addProduct('jbhifi', { sku: NEW, name: 'Game Boy Color Pikachu Edition', price: 249, status: 'in_stock' });
  await sw().browserResults(admin, [{ store: 'demo-jbhifi', keyword: 'game boy color', page: 1, ok: true, count: 2, products: [tile(NEW, 'Game Boy Color Pikachu Edition', 249), tile('game-boy-color-classic-console', 'Game Boy Color Classic Console', 199)] }]);
  assert.ok(product('demo-jbhifi', NEW), 'found');
  assert.equal(armed(boss, 'demo-jbhifi', NEW), true, 'a new listing after the watch was added: armed');
  await env.app.monitor.checkPage(url);
  await env.app.monitor.delivered();
  assert.equal(runsFor(itemOf(boss, 'demo-jbhifi', NEW)).length, 1, 'bought');
  assert.equal((await boss.put('/api/monitor/sweep', { stores: STORES })).status, 200);
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

// ---------------------------------------------------------------------------
// The second round
// ---------------------------------------------------------------------------
const now = () => Date.now() + clock.offset;

test("🛡️ a VIP link to a Kmart product on sale: one empty answer from its search provider (a hiccup) isn't \"not listed yet\" — never bought", async () => {
  const SKU = '44900101';
  const url = store.addProduct('kmart', { sku: SKU, name: 'Nintendo Switch 2 Donkey Kong Bananza Bundle', price: 649, status: 'in_stock' });
  const v = (await boss.post('/api/monitor/vip', { url, aco: true, maxPrice: 800 })).body.watch;
  // Its first page read: the lookup comes back without it — "not listed".
  store.set('kmart', SKU, { listed: false });
  await env.app.monitor.checkPage(url);
  // A minute later it has it again: on sale, as it was all along.
  store.set('kmart', SKU, { listed: true });
  clock.offset += 60 * 1000;
  await env.app.monitor.checkPage(url);
  await env.app.monitor.delivered();
  assert.equal(armed(boss, 'demo-kmart', SKU), false, 'on sale when the watch was added: not armed');
  assert.equal(runsFor(itemOf(boss, 'demo-kmart', SKU)).length, 0, 'never bought');
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

test("🛡️ a Kmart link read on sale before, then \"not listed\" for minutes (its search provider dropping it — the page may be on sale all along): a VIP link added meanwhile never buys it", async () => {
  const SKU = '44900201';
  const url = store.addProduct('kmart', { sku: SKU, name: 'Nintendo Switch 2 Pokemon Legends Z-A Bundle', price: 649, status: 'in_stock' });
  assert.equal((await boss.post('/api/monitor/monitors', { url })).status, 200);
  await env.app.monitor.checkPage(url);
  assert.equal(product('demo-kmart', SKU).status, 'in_stock');
  store.set('kmart', SKU, { listed: false });
  clock.offset += 60 * 1000;
  await env.app.monitor.checkPage(url);
  const v = (await boss.post('/api/monitor/vip', { url, aco: true, maxPrice: 800 })).body.watch;
  clock.offset += 61 * 1000;
  await env.app.monitor.checkPage(url); // "not listed" a minute on: but its page's read said on sale before
  store.set('kmart', SKU, { listed: true });
  clock.offset += 60 * 1000;
  await env.app.monitor.checkPage(url);
  await env.app.monitor.delivered();
  assert.equal(runsFor(itemOf(boss, 'demo-kmart', SKU)).length, 0, 'never bought');
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

test("🛡️ Amazon: a sponsored result for an old listing, at the top of the card search above a known product, isn't a new listing — never bought", async () => {
  const admin = env.app.repo.userById(boss.user.id);
  const tile = (sku, title, price) => ({ sku, title, price, inStock: true, url: `${store.url}/amazon/dp/${sku}` });
  const K1 = tile('B0KNOWN001', 'Pokemon TCG Surging Sparks Booster Bundle', 59);
  const K2 = tile('B0KNOWN002', 'Pokemon TCG Stellar Crown Booster Box', 229);
  const card = (products) => sw().browserResults(admin, [{ store: 'demo-amazon', keyword: 'pokemon', page: 1, ok: true, products }]);
  await card([K1, K2]);
  clock.offset += 30 * 1000;
  await card([K1, K2]);
  assert.ok(product('demo-amazon', 'B0KNOWN001'), 'the card search knows its products');
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-amazon', words: 'elite trainer box', aco: true, maxPrice: 300 })).body.watch;
  clock.offset += 30 * 1000;
  await card([K1, K2]);
  // Amazon's ads sit at the top whatever the sort: an ETB on sale since last year.
  const AD = tile('B0OLDETB01', 'Pokemon TCG Paldean Fates Elite Trainer Box', 129);
  clock.offset += 30 * 1000;
  await card([AD, K1, K2]);
  await env.app.monitor.delivered();
  assert.equal(armed(boss, 'demo-amazon', 'B0OLDETB01'), false, 'not armed');
  assert.equal(runsFor(itemOf(boss, 'demo-amazon', 'B0OLDETB01')).length, 0, 'never bought');
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

test("🛡️ City Beach (no stock in its search): on sale when the watch was added, sold out by its page's first read 20 minutes on (the store refusing the server meanwhile), restocked — never bought", async () => {
  const cb = R('demo-citybeach');
  const SKU = '20499901-01';
  const url = store.addProduct('citybeach', { sku: SKU, name: 'Pokemon Gengar Hoodie', price: 89, status: 'in_stock' });
  const w = (await ash.post('/api/drops', { store: 'demo-citybeach', words: 'gengar hoodie', aco: true, maxPrice: 200 })).body.watch;
  await sw().sweepTerm(cb, { keyword: 'gengar hoodie', page: 1, drop: 'private' }); // its first look: in it, its stock not said
  store.set('citybeach', SKU, { status: 'out_of_stock' });
  clock.offset += 20 * 60 * 1000;
  await env.app.monitor.checkPage(url); // its first reading: sold out — but long after the watch first saw it
  store.set('citybeach', SKU, { status: 'in_stock' });
  clock.offset += 60 * 1000;
  await env.app.monitor.checkPage(url);
  await env.app.monitor.delivered();
  assert.equal(armed(ash, 'demo-citybeach', SKU), false, 'not armed');
  assert.equal(runsFor(itemOf(ash, 'demo-citybeach', SKU)).length, 0, 'never bought');
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("💸 City Beach: what wasn't on sale at the watch's first look, its page's first read says so soon after — armed, and bought when it comes on sale", async () => {
  const cb = R('demo-citybeach');
  const SKU = '20499902-01';
  const url = store.addProduct('citybeach', { sku: SKU, name: 'Pokemon Mimikyu Hoodie', price: 89, status: 'out_of_stock' });
  const w = (await ash.post('/api/drops', { store: 'demo-citybeach', words: 'mimikyu hoodie', aco: true, maxPrice: 200 })).body.watch;
  await sw().sweepTerm(cb, { keyword: 'mimikyu hoodie', page: 1, drop: 'private' });
  clock.offset += 60 * 1000;
  await env.app.monitor.checkPage(url); // a minute on: sold out
  assert.equal(armed(ash, 'demo-citybeach', SKU), true, 'armed');
  store.set('citybeach', SKU, { status: 'in_stock' });
  clock.offset += 60 * 1000;
  await env.app.monitor.checkPage(url);
  await env.app.monitor.delivered();
  assert.equal(runsFor(itemOf(ash, 'demo-citybeach', SKU)).length, 1, 'bought');
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("💸 a page watch whose server reads are empty (JB Hi-Fi's collection: its products.json shut), read in an admin's browser: the browser's first read is its first look — a new listing after it is bought", async () => {
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { ...STORES, 'demo-jbhifi': 'auto' } })).status, 200);
  const OLD = 'lorcana-archazia-island-booster-box';
  store.addProduct('jbhifi', { sku: OLD, name: 'Disney Lorcana Archazias Island Booster Box', price: 199, status: 'in_stock' });
  const page = `${store.url}/jbhifi/collections/disney-lorcana`;
  const r = await boss.post('/api/drops', { page, phrases: ['disney lorcana'], every: 3, shared: false, aco: true, maxPrice: 300 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  const pages = env.app.pages;
  const admin = () => env.app.repo.userById(boss.user.id);
  const about = () => pages.browserDue(admin(), { version: '1.38.0' });
  about();
  await tick();
  about();
  await tick(); // the server's answer empty twice: an admin's browser reads it
  const look = () => env.app.db.get('SELECT * FROM watch_looks WHERE watch = :w', { w: w.id });
  assert.ok(!look() || !look().done_at, "the server's empty answers aren't its first look");
  const tile = (sku, title, price) => ({ sku, title, price, inStock: true, url: `${store.url}/jbhifi/products/${sku}` });
  let t = about().pages.find((x) => x.store === 'demo-jbhifi');
  assert.ok(t, 'handed to the browser');
  // (A browser read that says it holds every result: the store's count and its page size.)
  await pages.browserResults(admin(), [{ id: t.id, ok: true, how: 'page', total: 1, perPage: 24, products: [tile(OLD, 'Disney Lorcana Archazias Island Booster Box', 199)] }]);
  assert.equal(look().how, 'browser:page', "the browser's read is");
  assert.equal(runsFor(itemOf(boss, 'demo-jbhifi', OLD)).length, 0, 'there already: never bought');
  const NEW = 'disney-lorcana-whispers-in-the-well-booster-box';
  store.addProduct('jbhifi', { sku: NEW, name: 'Disney Lorcana Whispers in the Well Booster Box', price: 209, status: 'in_stock' });
  clock.offset += 3100;
  t = about().pages.find((x) => x.store === 'demo-jbhifi');
  assert.ok(t);
  await pages.browserResults(admin(), [{ id: t.id, ok: true, how: 'page', total: 2, perPage: 24, products: [tile(NEW, 'Disney Lorcana Whispers in the Well Booster Box', 209), tile(OLD, 'Disney Lorcana Archazias Island Booster Box', 199)] }]);
  await env.app.monitor.delivered();
  assert.equal(runsFor(itemOf(boss, 'demo-jbhifi', NEW)).length, 1, 'listed after its first look: bought');
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
  assert.equal((await boss.put('/api/monitor/sweep', { stores: STORES })).status, 200);
});

test("💸 a Shopify collection page watch (Trainer Town): a drop the shop drafted weeks before the watch, put up for sale after it, is bought", async () => {
  const drafted = now() - 21 * 86400000;
  store.addProduct('trainertown', { sku: 'one-piece-tcg-op-13-booster-box', name: 'One Piece - TCG - OP-13 Booster Box', price: 189, status: 'in_stock', createdAt: drafted });
  const page = `${store.url}/trainertown/collections/one-piece-trading-card-game`;
  const r = await ash.post('/api/drops', { page, phrases: ['one piece op 16'], every: 15, aco: true, maxPrice: 300 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  await tick();
  await tick(); // its first look
  const NEW = 'one-piece-tcg-op-16-booster-box';
  store.addProduct('trainertown', { sku: NEW, name: 'One Piece - TCG - OP-16 Booster Box', price: 199.95, status: 'in_stock', createdAt: drafted, publishedAt: now() - 1000 });
  await tick();
  const it = itemOf(ash, 'demo-trainertown', NEW);
  assert.ok(it, 'on the watchlist');
  assert.equal(runsFor(it).length, 1, 'put up for sale after the watch was added: bought');
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("🛡️ a Shopify collection page watch (Trainer Town): what was on the page, on sale, at its first look, republished since — never bought", async () => {
  const OLD = 'one-piece-tcg-op-15-booster-box';
  const made = now() - 30 * 86400000;
  store.addProduct('trainertown', { sku: OLD, name: 'One Piece - TCG - OP-15 Booster Box', price: 189, status: 'in_stock', createdAt: made });
  const page = `${store.url}/trainertown/collections/one-piece-trading-card-game`;
  const w = (await ash.post('/api/drops', { page, phrases: ['one piece op 15'], every: 15, aco: true, maxPrice: 300 })).body.watch;
  await tick();
  await tick(); // its first look: on sale
  store.set('trainertown', OLD, { publishedAt: now() - 1000 });
  await tick();
  assert.equal(armed(ash, 'demo-trainertown', OLD), false, 'not armed');
  assert.equal(runsFor(itemOf(ash, 'demo-trainertown', OLD)).length, 0, 'never bought');
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("💸 a VIP keyword watch at Kmart; the drop's link monitored ahead (not listed yet): when it's listed, on sale, its own search sees it — bought", async () => {
  const km = R('demo-kmart');
  const SKU = '44399001';
  const url = store.addProduct('kmart', { sku: SKU, name: 'Pokemon TCG Ascended Zenith Elite Trainer Box', price: 89, status: 'in_stock', listed: false });
  assert.equal((await boss.post('/api/monitor/monitors', { url })).status, 200);
  await env.app.monitor.checkPage(url);
  assert.equal(product('demo-kmart', SKU).status, 'not_listed');
  clock.offset += 60 * 1000;
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-kmart', words: 'ascended zenith', aco: true, maxPrice: 150 })).body.watch;
  for (let i = 0; i < 2; i++) {
    assert.equal((await sw().sweepTerm(km, { keyword: 'ascended zenith', page: 1, vip: v.id })).found, 0);
    clock.offset += 61 * 1000;
  }
  await env.app.monitor.checkPage(url); // still not listed, since the watch was added
  store.set('kmart', SKU, { listed: true });
  await sw().sweepTerm(km, { keyword: 'ascended zenith', page: 1, vip: v.id });
  await env.app.monitor.checkPage(url);
  await env.app.monitor.delivered();
  assert.equal(runsFor(itemOf(boss, 'demo-kmart', SKU)).length, 1, 'not listed when the watch was added: bought');
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

test("💸 a VIP link added before the product is published (JB Hi-Fi: its page not found till then): bought when it goes on sale", async () => {
  const SKU = 'pokemon-tcg-ascended-heroes-premium-poster-collection';
  const url = store.addProduct('jbhifi', { sku: SKU, name: 'Pokemon TCG Ascended Heroes Premium Poster Collection', price: 69, status: 'in_stock', listed: false });
  const v = (await boss.post('/api/monitor/vip', { url, aco: true, maxPrice: 100 })).body.watch;
  await env.app.monitor.checkPage(url);
  assert.equal(product('demo-jbhifi', SKU).status, 'not_found');
  clock.offset += 60 * 1000;
  await env.app.monitor.checkPage(url);
  store.set('jbhifi', SKU, { listed: true });
  clock.offset += 60 * 1000;
  await env.app.monitor.checkPage(url);
  await env.app.monitor.delivered();
  assert.equal(armed(boss, 'demo-jbhifi', SKU), true, 'armed');
  assert.equal(runsFor(itemOf(boss, 'demo-jbhifi', SKU)).length, 1, 'bought');
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});
