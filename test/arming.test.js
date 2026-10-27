// An Auto-checkout watch buys what drops after it was added — a new listing, or a restock of something that wasn't on
// sale when it was added — and never what was on sale when it was added (docs/MONITORING.md → VIP drops, Drop watches).
// Decided by what the watch itself saw: its own first look, the first stock reading it got (a search that says the stock,
// or a page read that worked), and a read that shows a product is new since then — never the catalogue's last status.
// Each case below was a wrong buy or a lost one; against the dummy stores (tests never touch real stores).

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
    // Auto-checkout on, placing orders, with a browser listening.
    assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 5000, perDay: 50, spendPerDay: 50000 })).status, 200);
    env.app.repo.addDevice(c.user.id, 'Chrome on Mac', '1.37.0');
  }
  // The dummy stores' copies, each searched the way its real store is.
  const stores = { 'demo-citybeach': 'server', 'demo-jbhifi': 'server', 'demo-kmart': 'server', 'demo-target': 'server', 'demo-bigw': 'browser' };
  assert.equal((await boss.put('/api/monitor/sweep', { stores })).status, 200);
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const R = (id) => env.app.retailers.get(id);
const sw = () => env.app.sweeper;
const admin = () => env.app.repo.userById(boss.user.id);
const product = (storeId, sku) => env.app.catalog.productFor(storeId, sku);
const itemOf = (c, storeId, sku) => env.app.repo.itemBySku(c.user.id, storeId, sku);
const runsFor = (item) => (item ? env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: item.id }) : []);
const armed = (c, storeId, sku) => { const it = itemOf(c, storeId, sku); return !!(it && it.aco); };
const vipArm = async (id, sku) => {
  const w = (await boss.get('/api/monitor/vip')).body.watches.find((x) => x.id === id);
  const f = w && w.found.find((x) => x.url && x.url.includes(sku));
  return f ? f.arm : null;
};
const tick = async () => { clock.offset += 61 * 1000; const n = await env.app.pages.tick(); await env.app.monitor.delivered(); return n; };

test("🛡️ a product Mugibot never tracked (not a card: a skateboard) found first by another of the store's searches, on sale before the watch was added: never bought", async () => {
  const cb = R('demo-citybeach');
  const BOARD = '20499999-01';
  // On sale for a while — but not a card, so the card search never kept it.
  store.set('citybeach', BOARD, { listed: true, status: 'in_stock' });
  await sw().sweepTerm(cb, { keyword: 'pokemon', page: 1 });
  assert.equal((await sw().sweepTerm(cb, { keyword: 'pokemon', page: 1 })).baseline, false);
  assert.equal(product('demo-citybeach', BOARD), null, 'never tracked');
  const r = await boss.post('/api/monitor/vip', { store: 'demo-citybeach', words: 'pikachu skateboard', aco: true, maxPrice: 200 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  // The card search sees it first — after the watch was added, before its own first look.
  await sw().sweepTerm(cb, { keyword: 'pokemon', page: 1 });
  assert.equal(armed(boss, 'demo-citybeach', BOARD), false, 'not armed on the spot');
  // Its page: on sale. On sale since before the watch: left alone.
  await env.app.monitor.checkPage(product('demo-citybeach', BOARD).url);
  await sw().sweepTerm(cb, { keyword: 'pikachu skateboard', page: 1, vip: w.id });
  await sw().sweepTerm(cb, { keyword: 'pokemon', page: 1 });
  assert.equal(armed(boss, 'demo-citybeach', BOARD), false);
  assert.equal(runsFor(itemOf(boss, 'demo-citybeach', BOARD)).length, 0, 'never bought');
  assert.equal(await vipArm(w.id, BOARD), 'skipped');
  assert.equal((await boss.del(`/api/monitor/vip/${w.id}`)).status, 200);
});

test("🛡️ a drop watch's own search: a product on sale all along that only moved up into its results (JB Hi-Fi's search shows its top 10) is never bought", async () => {
  const jb = R('demo-jbhifi');
  const sku = (i) => `zelda-amiibo-figure-${i}`;
  for (let i = 1; i <= 11; i++) store.addProduct('jbhifi', { sku: sku(i), name: `Zelda Amiibo Figure ${i}`, price: 30 + i, status: 'in_stock' });
  const shared = (await boss.post('/api/drops', { store: 'demo-jbhifi', words: 'zelda amiibo', aco: true, maxPrice: 100 })).body.watch;
  const own = (await ash.post('/api/drops', { store: 'demo-jbhifi', words: 'zelda amiibo', aco: true, maxPrice: 100 })).body.watch;
  assert.ok(shared && own);
  // Its first look: the top 10 (the 11th is further down, on sale all the same).
  const s = await sw().sweepTerm(jb, { keyword: 'zelda amiibo', page: 1, drop: 'shared' });
  assert.equal(s.found, 10, s.error);
  // One above it leaves the results: the 11th moves up into view.
  store.set('jbhifi', sku(1), { listed: false });
  await sw().sweepTerm(jb, { keyword: 'zelda amiibo', page: 1, drop: 'shared' });
  await env.app.monitor.delivered();
  for (const c of [boss, ash]) {
    assert.equal(armed(c, 'demo-jbhifi', sku(11)), false, `${c.user.username}: not armed`);
    assert.equal(runsFor(itemOf(c, 'demo-jbhifi', sku(11))).length, 0, `${c.user.username}: never bought`);
  }
  for (const [c, w] of [[boss, shared], [ash, own]]) assert.equal((await c.del(`/api/drops/${w.id}`)).status, 200);
});

test("🛡️ a drop watch's first look that sees more than it keeps (10 on your own watchlist): the rest aren't bought at its next search", async () => {
  const km = R('demo-kmart');
  const sku = (i) => String(44100000 + i);
  for (let i = 1; i <= 12; i++) store.addProduct('kmart', { sku: sku(i), name: `Lego Galaxy Cruiser Set ${i}`, price: 40 + i, status: 'in_stock' });
  const w = (await ash.post('/api/drops', { store: 'demo-kmart', words: 'lego galaxy cruiser', aco: true, maxPrice: 100 })).body.watch;
  assert.ok(w);
  const s = await sw().sweepTerm(km, { keyword: 'lego galaxy cruiser', page: 1, drop: 'private' });
  assert.equal(s.ok, true, s.error);
  assert.equal(env.app.drops.get(w.id).found.length, 10, 'it keeps 10');
  await sw().sweepTerm(km, { keyword: 'lego galaxy cruiser', page: 1, drop: 'private' });
  await env.app.monitor.delivered();
  for (let i = 1; i <= 12; i++) {
    assert.equal(armed(ash, 'demo-kmart', sku(i)), false, `${sku(i)}: on sale at the first look — not armed`);
    assert.equal(runsFor(itemOf(ash, 'demo-kmart', sku(i))).length, 0, `${sku(i)}: never bought`);
  }
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("🛡️ a search page watch's first look never goes by the catalogue's old \"sold out\": on sale on the page, it's never bought", async () => {
  const SKU = '44200001';
  const url = store.addProduct('kmart', { sku: SKU, name: 'Magic: The Gathering Bloomburrow Bundle', price: 79, status: 'in_stock' });
  // The catalogue's last word on it, a month old: sold out.
  const p = env.app.catalog.upsertProduct({ store: 'demo-kmart', sku: SKU, url, name: 'Magic: The Gathering Bloomburrow Bundle' });
  const month = Date.now() + clock.offset - 30 * 86400000;
  env.app.catalog.updateProduct(p.id, { status: 'out_of_stock', status_source: 'sweep', status_at: month, last_ok_at: month, checked_at: month, confirmed: 1 });
  const r = await boss.post('/api/drops', { page: `${store.url}/kmart/search/?searchTerm=bloomburrow`, phrases: ['bloomburrow bundle'], every: 3, aco: true, maxPrice: 300 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.equal(await tick(), 1);
  assert.equal(armed(boss, 'demo-kmart', SKU), false, 'on sale at its first look: not armed');
  await tick();
  assert.equal(runsFor(itemOf(boss, 'demo-kmart', SKU)).length, 0, 'never bought');
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test('🛡️ a page read that says "sold out" after the watch saw it on sale never arms it — from the server or an admin\'s browser — so the next search never buys it', async () => {
  const jb = R('demo-jbhifi');
  const SKU = 'steam-deck-oled-1tb-limited';
  const url = store.addProduct('jbhifi', { sku: SKU, name: 'Steam Deck OLED 1TB Limited Edition', price: 1049, status: 'in_stock' });
  const w = (await boss.post('/api/monitor/vip', { store: 'demo-jbhifi', words: 'steam deck oled', aco: true, maxPrice: 1200 })).body.watch;
  // Its own search: on sale.
  await sw().sweepTerm(jb, { keyword: 'steam deck oled', page: 1, vip: w.id });
  // A while later (the search's reading isn't fresh any more) its page says sold out.
  clock.offset += 4 * 60 * 1000;
  store.set('jbhifi', SKU, { status: 'out_of_stock' });
  await env.app.monitor.checkPage(url);
  assert.equal(armed(boss, 'demo-jbhifi', SKU), false, 'seen on sale by the watch: not armed');
  store.set('jbhifi', SKU, { status: 'in_stock' });
  await sw().sweepTerm(jb, { keyword: 'steam deck oled', page: 1, vip: w.id });
  assert.equal(runsFor(itemOf(boss, 'demo-jbhifi', SKU)).length, 0, 'never bought');
  assert.equal((await boss.del(`/api/monitor/vip/${w.id}`)).status, 200);

  // BIG W (an admin's browser searches it and reads its pages): its search said on sale; the page read in the browser
  // says it isn't — not armed either.
  const bw = R('demo-bigw');
  const BIG = '6099001';
  const big = store.addProduct('bigw', { sku: BIG, name: 'Steam Deck OLED 512GB', price: 899, status: 'in_stock' });
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-bigw', words: 'steam deck oled', aco: true, maxPrice: 1200 })).body.watch;
  const tile = (inStock) => ({ store: 'demo-bigw', keyword: 'steam deck oled', page: 1, ok: true, products: [{ sku: BIG, title: 'Steam Deck OLED 512GB', price: 899, inStock, url: big }] });
  await sw().browserResults(admin(), [tile(true)]);
  const bp = product('demo-bigw', BIG);
  assert.ok(bp, 'found');
  clock.offset += 4 * 60 * 1000;
  await env.app.monitor.browserProductResult(admin(), { id: `p:${bp.id}`, status: 'out_of_stock', price: 899 });
  assert.equal(armed(boss, 'demo-bigw', BIG), false, 'seen on sale by the watch: not armed');
  await sw().browserResults(admin(), [tile(true)]);
  assert.equal(runsFor(itemOf(boss, 'demo-bigw', BIG)).length, 0, 'never bought');
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

test("💸 sold out before the watch was added, and left out of the store's search while it is (Target): when it's back it's bought — whichever search sees it first", async () => {
  const tg = R('demo-target');
  const ONE = '71299001';
  const TWO = '71299002';
  store.addProduct('target', { sku: ONE, name: 'Pokémon TCG: Destined Rivals Elite Trainer Box', price: 89, status: 'in_stock' });
  store.addProduct('target', { sku: TWO, name: 'Pokémon TCG: Destined Rivals Booster Bundle', price: 49, status: 'in_stock' });
  // Seen on sale by the card search a while ago — then sold out, and Target leaves it out of its results.
  await sw().sweepTerm(tg, { keyword: 'pokemon', page: 1 });
  await sw().sweepTerm(tg, { keyword: 'pokemon', page: 1 });
  store.set('target', ONE, { status: 'out_of_stock' });
  store.set('target', TWO, { status: 'out_of_stock' });
  clock.offset += 60 * 60 * 1000;
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-target', words: 'destined rivals', aco: true, maxPrice: 200 })).body.watch;
  const d = (await ash.post('/api/drops', { store: 'demo-target', words: 'destined rivals', aco: true, maxPrice: 200 })).body.watch;
  // Their first look (the drop watch's search is the same words — one search for both): neither is there.
  for (let i = 0; i < 2; i++) assert.equal((await sw().sweepTerm(tg, { keyword: 'destined rivals', page: 1, vip: v.id })).found, 0);
  // Back: the card search sees the ETB first, the watches' own search the bundle.
  store.set('target', ONE, { status: 'in_stock' });
  store.set('target', TWO, { status: 'in_stock' });
  await sw().sweepTerm(tg, { keyword: 'pokemon', page: 1 });
  await sw().sweepTerm(tg, { keyword: 'destined rivals', page: 1, vip: v.id });
  await env.app.monitor.delivered();
  for (const sku of [ONE, TWO]) {
    assert.equal(armed(ash, 'demo-target', sku), true, `${sku}: armed for the drop watch`);
    assert.equal(runsFor(itemOf(ash, 'demo-target', sku)).length, 1, `${sku}: bought for the drop watch`);
    assert.equal(armed(boss, 'demo-target', sku), true, `${sku}: armed for the VIP watch`);
  }
  // The VIP watch's next read of each: bought.
  for (const sku of [ONE, TWO]) await env.app.monitor.checkPage(product('demo-target', sku).url);
  for (const sku of [ONE, TWO]) assert.equal(runsFor(itemOf(boss, 'demo-target', sku)).length, 1, `${sku}: bought for the VIP watch`);
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
  assert.equal((await ash.del(`/api/drops/${d.id}`)).status, 200);
});

test("💸 a store only an admin's browser reads (BIG W): a VIP find waiting on its page is settled by the browser's read of it — not on sale yet, armed, and bought when it is", async () => {
  const SKU = '6099101';
  const url = store.addProduct('bigw', { sku: SKU, name: 'Pokémon TCG: Ascended Heroes Booster Bundle', price: 59, status: 'coming_soon' });
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-bigw', words: 'ascended heroes', aco: true, maxPrice: 100 })).body.watch;
  // Its search from the admin's browser: the tile has no buy button (no stock either way).
  const tile = (inStock) => ({ store: 'demo-bigw', keyword: 'ascended heroes', page: 1, ok: true, products: [{ sku: SKU, title: 'Pokémon TCG: Ascended Heroes Booster Bundle', price: 59, inStock, url }] });
  await sw().browserResults(admin(), [tile(null)]);
  const p = product('demo-bigw', SKU);
  assert.ok(p, 'found');
  assert.equal(armed(boss, 'demo-bigw', SKU), false, 'its page decides');
  // The admin's browser reads its page: coming soon.
  await env.app.monitor.browserProductResult(admin(), { id: `p:${p.id}`, status: 'coming_soon', price: 59 });
  assert.equal(armed(boss, 'demo-bigw', SKU), true, 'not on sale yet: armed');
  assert.equal(await vipArm(v.id, SKU), 'armed');
  // On sale: bought.
  await sw().browserResults(admin(), [tile(true)]);
  assert.equal(runsFor(itemOf(boss, 'demo-bigw', SKU)).length, 1, 'bought');
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
});

test('💸 a new card listing seen first by another watch\'s search (or by a card search) is bought for every Auto-checkout watch it matches', async () => {
  const jb = R('demo-jbhifi');
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-jbhifi', words: 'heavy hitters', aco: true, maxPrice: 200 })).body.watch;
  const d = (await boss.post('/api/drops', { store: 'demo-jbhifi', words: 'heavy hitters premium' })).body.watch;
  // Both watches' first looks; the card search's scene.
  for (let i = 0; i < 2; i++) {
    await sw().sweepTerm(jb, { keyword: 'heavy hitters', page: 1, vip: v.id });
    await sw().sweepTerm(jb, { keyword: 'heavy hitters premium', page: 1, drop: 'shared' });
    await sw().sweepTerm(jb, { keyword: 'pokemon', page: 1 });
  }
  // A new one: the drop watch's search sees it first.
  const ONE = 'pokemon-tcg-heavy-hitters-premium-collection';
  store.addProduct('jbhifi', { sku: ONE, name: 'Pokémon TCG Heavy Hitters Premium Collection', price: 99, status: 'in_stock' });
  await sw().sweepTerm(jb, { keyword: 'heavy hitters premium', page: 1, drop: 'shared' });
  assert.equal(armed(boss, 'demo-jbhifi', ONE), true, 'armed for the VIP watch');
  await env.app.monitor.checkPage(product('demo-jbhifi', ONE).url);
  assert.equal(runsFor(itemOf(boss, 'demo-jbhifi', ONE)).length, 1, 'bought');
  // Another: the card search sees it first.
  const TWO = 'pokemon-tcg-heavy-hitters-elite-trainer-box';
  store.addProduct('jbhifi', { sku: TWO, name: 'Pokémon TCG Heavy Hitters Elite Trainer Box', price: 79, status: 'in_stock' });
  await sw().sweepTerm(jb, { keyword: 'pokemon', page: 1 });
  assert.equal(armed(boss, 'demo-jbhifi', TWO), true, 'armed for the VIP watch');
  await env.app.monitor.checkPage(product('demo-jbhifi', TWO).url);
  assert.equal(runsFor(itemOf(boss, 'demo-jbhifi', TWO)).length, 1, 'bought');
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
  assert.equal((await boss.del(`/api/drops/${d.id}`)).status, 200);
});

test('⏳ a find never reads a page that is backing off (the store refused it) early; another website\'s new listing is read in the monitor\'s turn (its gap between requests), never straight away', async () => {
  const jb = R('demo-jbhifi');
  const SKU = 'nintendo-switch-pro-controller-limited';
  const url = store.addProduct('jbhifi', { sku: SKU, name: 'Nintendo Switch Pro Controller Limited', price: 109, status: 'in_stock' });
  const now = Date.now() + clock.offset;
  // Its page refused the server a few times: next asked in 10 minutes.
  env.app.repo.ensurePage(url, 'product', 'demo-jbhifi', SKU);
  env.app.db.run('UPDATE page_checks SET fail_count = 3, next_check_at = :n WHERE url = :url', { n: now + 10 * 60 * 1000, url });
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-jbhifi', words: 'switch pro controller', aco: true, maxPrice: 200 })).body.watch;
  const d = (await boss.post('/api/drops', { store: 'demo-jbhifi', words: 'switch pro controller limited', aco: true, maxPrice: 200 })).body.watch;
  await sw().sweepTerm(jb, { keyword: 'switch pro controller', page: 1, vip: v.id });
  await sw().sweepTerm(jb, { keyword: 'switch pro controller limited', page: 1, drop: 'shared' });
  assert.equal(env.app.db.get('SELECT next_check_at FROM page_checks WHERE url = :url', { url }).next_check_at, now + 10 * 60 * 1000, 'still backing off');
  assert.equal((await boss.del(`/api/monitor/vip/${v.id}`)).status, 200);
  assert.equal((await boss.del(`/api/drops/${d.id}`)).status, 200);

  // Another website: a new listing for a watch there (its own, and one for everyone) — the website was asked a moment
  // ago, so its page waits for the monitor's turn.
  const base = store.state.acme.products.length;
  try {
    const site = store.acmeUrl();
    const own = (await ash.post('/api/drops', { store: 'other', site, words: 'zenith figure' })).body.watch;
    const shared = (await boss.post('/api/drops', { store: 'other', site, words: 'zenith figure' })).body.watch;
    for (const w of [own, shared]) assert.equal((await env.app.drops.look(env.app.drops.get(w.id))).ok, true);
    store.state.acme.products.push({ handle: 'zenith-figure-deluxe', name: 'Zenith Figure Deluxe', price: 120, status: 'in_stock', listed: true });
    const host = new URL(store.url).host;
    env.app.monitor.hostNext.set(host, Date.now() + clock.offset + 60 * 1000);
    const asked = () => store.state.requests.filter((x) => /zenith-figure-deluxe/.test(x.path)).length;
    for (const w of [own, shared]) {
      env.app.db.run('UPDATE drop_watches SET next_at = 0 WHERE id = :id', { id: w.id });
      env.app.drops.changed();
      await env.app.drops.look(env.app.drops.get(w.id));
    }
    await env.app.monitor.delivered();
    assert.equal(asked(), 0, 'not read straight away: the website was just asked');
    const page = env.app.db.get("SELECT next_check_at FROM page_checks WHERE url LIKE '%zenith-figure-deluxe%'");
    assert.equal(page.next_check_at, 0, "next in the monitor's turn");
    for (const [c, w] of [[ash, own], [boss, shared]]) assert.equal((await c.del(`/api/drops/${w.id}`)).status, 200);
  } finally {
    store.state.acme.products.splice(base);
  }
});
