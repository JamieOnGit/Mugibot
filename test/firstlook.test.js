// The never-buy rule at a words watch's first look (docs/MONITORING.md → VIP drops, Drop watches): an Auto-checkout
// watch never buys what was on sale before it was added — not what its first look saw beyond the room it keeps, not
// something listed all along that only moves into a full first page later — and its finds at another website are read
// at the website's own pace, never sooner than a page backing off. Against the dummy stores (City Beach's, JB Hi-Fi's —
// whose search returns its top 10 — and Acme Collectibles, another website): tests never touch real stores.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, discordOpts, makeMember, startApp, startFakeDiscord, waitFor } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { otherSku } from '../server/monitor/drops.js';
import { pageFull } from '../server/monitor/sweep.js';

let env;
let store;
let discord;
let boss;
let ash;
let misty;

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  misty = await Client.signup(env.url, 'misty');
  for (const c of [boss, ash, misty]) {
    makeMember(env, c);
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
    // Auto-checkout on, with a browser listening.
    assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 5000, perDay: 50, spendPerDay: 50000 })).status, 200);
    env.app.repo.addDevice(c.user.id, 'Chrome on Mac', '1.16.0');
  }
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-citybeach': 'server', 'demo-jbhifi': 'server' } })).status, 200);
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const R = (id) => env.app.retailers.get(id);
const sw = () => env.app.sweeper;
const drops = () => env.app.drops;
const vip = () => env.app.monitor.vip;
const runsFor = (itemId) => env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: itemId });
const runsOf = (userId) => env.app.db.all('SELECT * FROM aco_runs WHERE user_id = :u', { u: userId });
// The monitor's rounds until a find waiting on its page ('pending') is settled by a read of it.
const settled = (arm) => waitFor(async () => {
  await env.app.monitor.tick();
  return arm() !== 'pending';
}, { message: 'its page read' });
// Whether a watch's first look at a store read a full page (1), or not (0) — or null: no first look kept.
const firstLook = (watchId, store) => {
  const row = env.app.db.get('SELECT full FROM first_looks WHERE watch_id = :w AND store = :s', { w: watchId, s: store });
  return row ? row.full : null;
};

test('📄 a search page is full when the store says it has more, or it holds as many as its link asks for (10 or more where neither says)', () => {
  const jb = 'http://x/jbhifi/search/suggest.json?q=a&resources%5Btype%5D=product&resources%5Blimit%5D=10&resources%5Boptions%5D%5Bunavailable_products%5D=last';
  assert.equal(pageFull({ found: 10, url: jb }), true, "JB Hi-Fi's top 10");
  assert.equal(pageFull({ found: 9, url: jb }), false);
  const cb = 'http://x/citybeach/search?q=a&srule=newest&sz=48';
  assert.equal(pageFull({ found: 12, url: cb }), false, "City Beach's 48");
  assert.equal(pageFull({ found: 48, url: cb }), true);
  assert.equal(pageFull({ total: 12, found: 12, url: cb }), false, 'the store said it had them all');
  assert.equal(pageFull({ total: 13, found: 12 }), true, 'the store said it had more');
  assert.equal(pageFull({ found: 9, url: 'http://x/s?k=a' }), false);
  assert.equal(pageFull({ found: 10, url: 'http://x/s?k=a' }), true, 'neither says: 10 or more is full');
});

test('⭐ a drop watch whose first look sees more than it keeps (12 on sale, room for 10): the other 2 are remembered — never on the watchlist, never bought when its next search shows them again', async () => {
  for (let i = 1; i <= 12; i++) store.addProduct('citybeach', { sku: `310000${String(i).padStart(2, '0')}-01`, name: `Lego Castle Set ${i}`, price: 50 + i, status: 'in_stock' });
  const w = (await ash.post('/api/drops', { store: 'demo-citybeach', words: 'lego castle set', aco: true, maxPrice: 200 })).body.watch;
  assert.ok(w);
  const cb = R('demo-citybeach');
  // Its first look: 10 on the watchlist (waiting on their pages: City Beach's search has no stock), 2 remembered.
  let s = await sw().sweepTerm(cb, { keyword: 'lego castle set', page: 1, drop: 'private' });
  assert.equal(s.ok, true, s.error);
  const first = drops().get(w.id).found;
  assert.equal(first.filter((f) => !f.quiet).length, 10, 'the most it keeps');
  assert.equal(first.filter((f) => f.quiet).length, 2, 'the rest remembered');
  assert.ok(first.every((f) => f.base === true), 'all listed already');
  assert.equal((await ash.get('/api/drops')).body.watches.find((x) => x.id === w.id).found.length, 10, "what it only remembers isn't shown");
  assert.ok(env.app.repo.listEvents(ash.user.id, { limit: 10 }).some((e) => /2 more are listed too — more than one watch keeps/.test(e.message)), 'its first look says so');
  // Its own search again: the 2 are listed already, not drops — nothing added, nothing armed, nothing bought.
  s = await sw().sweepTerm(cb, { keyword: 'lego castle set', page: 1, drop: 'private' });
  assert.equal(s.ok, true, s.error);
  assert.equal(drops().get(w.id).found.length, 12);
  for (const sku of ['31000011-01', '31000012-01']) assert.equal(env.app.repo.itemBySku(ash.user.id, 'demo-citybeach', sku), null, `${sku} not on the watchlist`);
  assert.equal(runsOf(ash.user.id).length, 0, 'nothing bought');
  // (What drops after it still has room of its own: a new set is found, armed — and bought once its page says it's on sale.)
  store.addProduct('citybeach', { sku: '31000013-01', name: 'Lego Castle Set Dragon Keep', price: 99, status: 'in_stock' });
  await sw().sweepTerm(cb, { keyword: 'lego castle set', page: 1, drop: 'private' });
  const fresh = env.app.repo.itemBySku(ash.user.id, 'demo-citybeach', '31000013-01');
  assert.ok(fresh && fresh.aco, 'a real drop is armed');
  await waitFor(() => runsFor(fresh.id).length === 1, { message: 'bought' });
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("⭐ a drop watch whose first look filled JB Hi-Fi's page (its top 10 of 12): one on sale all along that moves into the page later isn't bought — its page is read first (on sale: skipped); one sold out that moves in is armed for its return", async () => {
  for (let i = 1; i <= 12; i++) store.addProduct('jbhifi', { sku: `retro-arcade-cabinet-${i}`, name: `Retro Arcade Cabinet ${i}`, price: 300 + i, status: i === 12 ? 'out_of_stock' : 'in_stock' });
  const w = (await ash.post('/api/drops', { store: 'demo-jbhifi', words: 'retro arcade cabinet', aco: true, maxPrice: 500 })).body.watch;
  assert.ok(w);
  const jb = R('demo-jbhifi');
  let s = await sw().sweepTerm(jb, { keyword: 'retro arcade cabinet', page: 1, drop: 'private' });
  assert.equal(s.ok, true, s.error);
  assert.equal(s.found, 10, 'a full page');
  // Two of the ten are taken down: the eleventh (on sale all along) and the twelfth (sold out) move into the page.
  store.set('jbhifi', 'retro-arcade-cabinet-1', { listed: false });
  store.set('jbhifi', 'retro-arcade-cabinet-2', { listed: false });
  s = await sw().sweepTerm(jb, { keyword: 'retro arcade cabinet', page: 1, drop: 'private' });
  assert.equal(s.ok, true, s.error);
  const onSale = env.app.repo.itemBySku(ash.user.id, 'demo-jbhifi', 'retro-arcade-cabinet-11');
  const soldOut = env.app.repo.itemBySku(ash.user.id, 'demo-jbhifi', 'retro-arcade-cabinet-12');
  assert.ok(onSale && soldOut, 'on the watchlist (and alerted: new to the watch)');
  assert.equal(onSale.aco, false, 'not armed on the search\'s say');
  assert.equal(runsFor(onSale.id).length, 0, 'not bought');
  const arm = (item) => () => drops().get(w.id).found.find((x) => x.itemId === item.id).arm;
  assert.equal(arm(onSale)(), 'pending');
  assert.equal(arm(soldOut)(), 'pending');
  // Their pages are read, whatever the searches saw of them lately: on sale — skipped; sold out — armed for its return.
  assert.equal(env.app.monitor.sweptLately(onSale.url, env.app.repo.now()), false);
  await settled(arm(onSale));
  await settled(arm(soldOut));
  assert.equal(arm(onSale)(), 'skipped');
  assert.equal(env.app.repo.getItem(ash.user.id, onSale.id).aco, false);
  assert.equal(runsFor(onSale.id).length, 0, 'never bought');
  assert.equal(arm(soldOut)(), 'armed');
  assert.equal(env.app.repo.getItem(ash.user.id, soldOut.id).aco, true);
  // (Its first look's page full, as the watch keeps it.)
  assert.equal(firstLook(w.id, 'demo-jbhifi'), 1);
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("⭐ an admin's drop watch for everyone, and a VIP watch, whose first search filled JB Hi-Fi's page: one on sale all along that moves into the page later isn't bought (its page is read first)", async () => {
  // An admin's drop watch for everyone.
  for (let i = 1; i <= 12; i++) store.addProduct('jbhifi', { sku: `air-hockey-table-${i}`, name: `Air Hockey Table ${i}`, price: 300 + i, status: 'in_stock' });
  const w = (await boss.post('/api/drops', { store: 'demo-jbhifi', words: 'air hockey table', aco: true, maxPrice: 500 })).body.watch;
  assert.ok(w);
  const jb = R('demo-jbhifi');
  await sw().sweepTerm(jb, { keyword: 'air hockey table', page: 1, drop: 'shared' });
  store.set('jbhifi', 'air-hockey-table-1', { listed: false });
  await sw().sweepTerm(jb, { keyword: 'air hockey table', page: 1, drop: 'shared' });
  const table = env.app.catalog.productFor('demo-jbhifi', 'air-hockey-table-11');
  const tableArm = () => drops().get(w.id).found.find((x) => x.productId === table.id).arm;
  assert.equal(tableArm(), 'pending');
  await settled(tableArm);
  assert.equal(tableArm(), 'skipped');
  const tableItem = env.app.repo.itemBySku(boss.user.id, 'demo-jbhifi', 'air-hockey-table-11');
  assert.ok(!tableItem || !tableItem.aco, 'not armed');

  // A VIP watch: its first search's page was full.
  for (let i = 1; i <= 12; i++) store.addProduct('jbhifi', { sku: `jukebox-deluxe-${i}`, name: `Jukebox Deluxe ${i}`, price: 300 + i, status: 'in_stock' });
  const r = await boss.post('/api/monitor/vip', { store: 'demo-jbhifi', words: 'jukebox deluxe', aco: true, maxPrice: 500 });
  assert.equal(r.status, 200, r.text);
  const v = r.body.watch;
  assert.equal((await sw().sweepTerm(jb, { keyword: 'jukebox deluxe', page: 1, vip: v.id })).ok, true);
  assert.equal(firstLook(v.id, 'demo-jbhifi'), 1);
  await waitFor(async () => { await env.app.monitor.tick(); return vip().get(v.id).found.every((f) => f.arm !== 'pending'); }, { message: 'its first finds settled' });
  store.set('jbhifi', 'jukebox-deluxe-1', { listed: false });
  await sw().sweepTerm(jb, { keyword: 'jukebox deluxe', page: 1, vip: v.id });
  const jukebox = env.app.catalog.productFor('demo-jbhifi', 'jukebox-deluxe-11');
  const jukeboxArm = () => vip().get(v.id).found.find((f) => f.productId === jukebox.id).arm;
  assert.equal(jukeboxArm(), 'pending', 'as one listed already');
  await settled(jukeboxArm);
  assert.equal(jukeboxArm(), 'skipped');
  const jukeboxItem = env.app.repo.itemBySku(boss.user.id, 'demo-jbhifi', 'jukebox-deluxe-11');
  assert.ok(!jukeboxItem || !jukeboxItem.aco, 'not armed');
  assert.equal(runsOf(boss.user.id).length, 0, 'nothing bought');
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("⭐ a find waiting on its page is settled by what that page read said — not by a search's say moments before (sold out in the search, on sale on its page: on sale all along, never armed)", async () => {
  for (let i = 1; i <= 11; i++) store.addProduct('jbhifi', { sku: `zephyrine-foosball-${i}`, name: `Zephyrine Foosball ${i}`, price: 300 + i, status: i === 11 ? 'out_of_stock' : 'in_stock' });
  const w = (await boss.post('/api/drops', { store: 'demo-jbhifi', words: 'zephyrine foosball', aco: true, maxPrice: 500 })).body.watch;
  const jb = R('demo-jbhifi');
  await sw().sweepTerm(jb, { keyword: 'zephyrine foosball', page: 1, drop: 'shared' });
  // The eleventh moves into the full page, the search saying it's sold out…
  store.set('jbhifi', 'zephyrine-foosball-1', { listed: false });
  await sw().sweepTerm(jb, { keyword: 'zephyrine foosball', page: 1, drop: 'shared' });
  const table = env.app.catalog.productFor('demo-jbhifi', 'zephyrine-foosball-11');
  const arm = () => drops().get(w.id).found.find((x) => x.productId === table.id).arm;
  assert.equal(arm(), 'pending');
  // …and its page, read a moment later, says it's on sale (the catalogue keeps the search's word for now).
  store.set('jbhifi', 'zephyrine-foosball-11', { status: 'in_stock' });
  await settled(arm);
  assert.equal(arm(), 'skipped', "what its page said: on sale — it isn't armed");
  const item = env.app.repo.itemBySku(boss.user.id, 'demo-jbhifi', 'zephyrine-foosball-11');
  assert.ok(!item || !item.aco, 'not armed');
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🧭 at a store only browsers read, a find waiting on its page is settled by a browser's read of it — a member's own item by their browser, a VIP find by an admin's: sold out there, it's armed for its return", async () => {
  const jb = R('demo-jbhifi');
  // Someone's own watch: a sold-out product moves into its full first page.
  for (let i = 1; i <= 11; i++) store.addProduct('jbhifi', { sku: `quokkaroll-skeeball-${i}`, name: `Quokkaroll Skeeball ${i}`, price: 300 + i, status: i === 11 ? 'out_of_stock' : 'in_stock' });
  const w = (await ash.post('/api/drops', { store: 'demo-jbhifi', words: 'quokkaroll skeeball', aco: true, maxPrice: 500 })).body.watch;
  await sw().sweepTerm(jb, { keyword: 'quokkaroll skeeball', page: 1, drop: 'private' });
  store.set('jbhifi', 'quokkaroll-skeeball-1', { listed: false });
  await sw().sweepTerm(jb, { keyword: 'quokkaroll skeeball', page: 1, drop: 'private' });
  const item = env.app.repo.itemBySku(ash.user.id, 'demo-jbhifi', 'quokkaroll-skeeball-11');
  const arm = () => drops().get(w.id).found.find((x) => x.itemId === item.id).arm;
  assert.equal(arm(), 'pending');
  // A read that failed settles nothing; one that worked does.
  await env.app.monitor.browserResults(env.app.repo.userById(ash.user.id), [{ id: item.id, status: 'blocked', error: 'Access Denied' }]);
  assert.equal(arm(), 'pending');
  await env.app.monitor.browserResults(env.app.repo.userById(ash.user.id), [{ id: item.id, status: 'out_of_stock', title: 'Quokkaroll Skeeball 11', price: 311 }]);
  assert.equal(arm(), 'armed');
  assert.equal(env.app.repo.getItem(ash.user.id, item.id).aco, true);
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);

  // A VIP watch: its first search's finds wait on their pages; an admin's browser reads one, sold out.
  for (let i = 1; i <= 3; i++) store.addProduct('jbhifi', { sku: `grabbatron-claw-${i}`, name: `Grabbatron Claw ${i}`, price: 300 + i, status: 'out_of_stock' });
  const v = (await boss.post('/api/monitor/vip', { store: 'demo-jbhifi', words: 'grabbatron claw', aco: true, maxPrice: 500 })).body.watch;
  await sw().sweepTerm(jb, { keyword: 'grabbatron claw', page: 1, vip: v.id });
  const claw = env.app.catalog.productFor('demo-jbhifi', 'grabbatron-claw-1');
  const clawArm = () => vip().get(v.id).found.find((f) => f.productId === claw.id).arm;
  assert.equal(clawArm(), 'pending');
  await env.app.monitor.browserResults(env.app.repo.userById(boss.user.id), [{ id: `p:${claw.id}`, status: 'out_of_stock', title: 'Grabbatron Claw 1', price: 301 }]);
  assert.equal(clawArm(), 'armed');
  assert.equal(env.app.repo.itemBySku(boss.user.id, 'demo-jbhifi', 'grabbatron-claw-1').aco, true);
});

test('🐢 a new listing at another website: its page read at the website\'s pace — never sooner than a page backing off (its back-off kept), and two at once: one read now, the other once the gap between reads is over', async () => {
  const handle = 'mega-figure-limited';
  store.state.acme.products.push({ handle, name: 'Mega Figure Limited Edition', price: 199, status: 'in_stock', listed: false });
  const url = store.acmeUrl(handle);
  // Misty watches its page already; the website refused it lately: backing off for 10 minutes.
  assert.equal((await misty.post('/api/items', { url, name: 'Mega figure' })).status, 200);
  const until = env.app.repo.now() + 10 * 60 * 1000;
  env.app.db.run('UPDATE page_checks SET fail_count = 3, next_check_at = :n WHERE url = :u', { n: until, u: url });
  const site = store.acmeUrl();
  const own = (await ash.post('/api/drops', { store: 'other', site, words: 'mega figure' })).body.watch;
  const shared = (await boss.post('/api/drops', { store: 'other', site, words: 'mega figure limited' })).body.watch;
  assert.ok(own && shared);
  await drops().look(drops().get(own.id));
  await drops().look(drops().get(shared.id));
  // It's listed: both watches find it new — your own's (on your watchlist) and the admin's (a monitored product).
  store.setAcme(handle, { listed: true });
  const reads = (h) => store.state.requests.filter((x) => x.path.startsWith(`/acme/products/${h}`)).length;
  const n0 = reads(handle);
  await drops().look(drops().get(own.id));
  await drops().look(drops().get(shared.id));
  assert.ok(env.app.repo.itemBySku(ash.user.id, 'other', otherSku(url)), 'found by your own watch');
  assert.ok(env.app.catalog.productFor('other', otherSku(url)), "found by the admin's");
  assert.equal(reads(handle) - n0, 0, 'its page is not read while it backs off');
  assert.equal(env.app.db.get('SELECT next_check_at FROM page_checks WHERE url = :u', { u: url }).next_check_at, until, 'its back-off is kept');
  // The website's gap between reads: two new listings at once — one read now, the other when the gap's over.
  const gap = env.app.cfg.monitor.hostGapSeconds;
  env.app.cfg.monitor.hostGapSeconds = 60;
  try {
    for (const h of ['mega-figure-red', 'mega-figure-blue']) store.state.acme.products.push({ handle: h, name: `Mega Figure ${h}`, price: 99, status: 'in_stock', listed: true });
    const was = { red: reads('mega-figure-red'), blue: reads('mega-figure-blue') };
    env.app.monitor.hostNext.clear();
    env.app.db.run('UPDATE drop_watches SET next_at = 0 WHERE id = :id', { id: own.id });
    drops().changed();
    await drops().look(drops().get(own.id));
    assert.equal([reads('mega-figure-red') > was.red, reads('mega-figure-blue') > was.blue].filter(Boolean).length, 1, 'one page read now');
  } finally {
    env.app.cfg.monitor.hostGapSeconds = gap;
  }
});
