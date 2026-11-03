// 🚨 Priority drops (Mugibot 2.2): EB Games' pages, for everyone — the owner's three (Nov 2026): One Piece pre-orders and
// Pokémon pre-orders (boosters, collections, decks) — anything new on them, from the lowest price the admin sets — and
// every One Piece product, for what has "one piece booster" in its name. Each read newest first, every 3 s from an
// admin's browser (EB Games turns servers away); something new there: posted in the channel with ⚡ Buy, every member
// DM'd at once (but those who've muted it — and once, whichever page has it first), and bought straight away for each
// member who's turned on Auto-checkout of these drops — up to their own max, as many as EB allows or one (their
// choice), every new product (not just the first), within their own Auto-checkout limits. Never an individual card
// (already unpacked: "… OP01-079 - NM/M") nor an accessory: those are told, never bought.
// Against the dummy EB Games — tests never touch real stores.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { parseEbGames } from '../server/monitor/listing.js';
import { alertItem } from '../server/routes/web.js';

let env;
let store;
let discord;
let boss;
let ash;
let misty;
let brock;
let clock;

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  clock = { offset: 0 };
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, now: () => Date.now() + clock.offset, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  misty = await Client.signup(env.url, 'misty');
  brock = await Client.signup(env.url, 'brock');
  for (const [c, d] of [[boss, 'd-boss'], [ash, 'd-ash'], [misty, 'd-misty'], [brock, 'd-brock']]) {
    makeMember(env, c);
    env.app.repo.updateUser(c.user.id, { discord_id: d });
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
    assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 3000, perDay: 20, spendPerDay: 20000 })).status, 200);
    env.app.repo.addDevice(c.user.id, 'Chrome on Mac', '1.41.0');
  }
  // EB Games searched from an admin's browser, as the real one is.
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-ebgames': 'browser' } })).status, 200);
  // What's up for pre-order already: the pages' "before".
  store.addProduct('ebgames', { sku: '313000', name: 'One Piece TCG OP-14 Booster Box', price: 199, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313001', name: 'Pokémon TCG: Mega Evolution Booster Bundle', price: 59, status: 'preorder' });
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const pages = () => env.app.pages;
const admin = () => env.app.repo.userById(boss.user.id);
const dms = (id) => discord.dmsTo(id);
const runsFor = (itemId) => env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: itemId });
const itemOf = (c, sku) => env.app.repo.itemBySku(c.user.id, 'demo-ebgames', sku);
const watchOf = async (c, id) => (await c.get('/api/drops')).body.watches.find((w) => w.id === id);
const R = () => env.app.retailers.get('demo-ebgames');

/**
 * One round of the admin's browser: each page due handed out, read as the browser reads it — the JSON the page fetches,
 * asked for from inside the page (its filters its own) — and sent back. Returns the pages read.
 */
async function browserRound() {
  clock.offset += 3100;
  const due = pages().browserDue(admin(), { version: '1.41.0' });
  const out = [];
  for (const t of due.pages) {
    const data = t.dataUrl || t.guess;
    const res = await fetch(data, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/130' } });
    const parsed = parseEbGames(await res.text(), { base: data, storeBase: R().base });
    await pages().browserResults(admin(), [{ id: t.id, ok: true, how: 'data', learned: data, products: parsed.products, total: parsed.total, perPage: parsed.perPage }]);
    out.push(t.url);
    // (A store's pages take turns: about one a second.)
    clock.offset += 1100;
  }
  await env.app.monitor.delivered();
  // (Every member's DM goes out straight after the reads: let them.)
  await env.app.drops.allTold();
  return out;
}
/** Every page read (a store's pages take turns: a round each, till each has been read). */
async function readAll() {
  const read = new Set();
  for (let i = 0; i < 6 && read.size < 3; i++) for (const u of await browserRound()) read.add(u);
  return read.size;
}

let onePiece;
let pokemon;
let boosters;

test('🚨 the EB Games pre-order preset (admins): the owner\'s three pages, newest first — One Piece pre-orders and Pokémon pre-orders (boosters, collections, decks), anything new from the lowest price set; every One Piece product, for "one piece booster" — each a priority watch for everyone, read every 3 s, as many as EB allows', async () => {
  // Members can't add watches for everyone.
  assert.equal((await ash.post('/api/drops/presets/ebpreorders', { demo: true })).status, 400);
  const r = await boss.post('/api/drops/presets/ebpreorders', { demo: true, minPrice: 20, qty: 'max' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.added.length, 3);
  [onePiece, pokemon, boosters] = r.body.added;
  assert.equal(onePiece.page, `${store.url}/ebgames/search?category=trading-cards&subcategory=trading-cards-one-piece&condition=preorder&sort=releasedate&order=desc`);
  assert.equal(pokemon.page, `${store.url}/ebgames/search?category=trading-cards&subcategory=trading-cards-pokemon&attributes=trading-card-type%3Aboosters&attributes=trading-card-type%3Acollections&attributes=trading-card-type%3Adecks&condition=preorder&sort=releasedate&order=desc`);
  assert.equal(boosters.page, `${store.url}/ebgames/search?category=trading-cards&subcategory=trading-cards-one-piece&sort=releasedate&order=desc`);
  assert.deepEqual([onePiece.priority, onePiece.shared, onePiece.phrases, onePiece.minPrice, onePiece.every, onePiece.qtyRule], [true, true, [], 20, 3, 'max']);
  assert.deepEqual([pokemon.priority, pokemon.phrases, pokemon.minPrice], [true, [], 20]);
  assert.deepEqual([boosters.priority, boosters.shared, boosters.phrases, boosters.minPrice, boosters.every], [true, true, ['one piece booster'], 20, 3]);
  assert.deepEqual([onePiece, pokemon, boosters].map((w) => env.app.drops.get(w.id).category), ['onepiece', 'pokemon', 'onepiece']);
  // Again: each page once.
  const again = await boss.post('/api/drops/presets/ebpreorders', { demo: true });
  assert.equal(again.status, 400);
  assert.match(again.text, /watching that page already/);
  // Members see both — told by DM by default, their own Auto-checkout of them off till they turn it on.
  const w = await watchOf(ash, onePiece.id);
  assert.deepEqual(w.follow, { aco: false, maxPrice: null, qty: 'max', dm: true, acoOn: true });
  assert.equal(w.followers, undefined, 'how many follow it: admins only');
});

test('🚨 a member turns on Auto-checkout of a priority watch\'s drops (their max, Min or Max), or mutes its DMs — checked like any setting', async () => {
  let r = await ash.put(`/api/drops/${onePiece.id}/follow`, { aco: true });
  assert.equal(r.status, 400);
  assert.match(r.text, /Set your max price/);
  r = await ash.put(`/api/drops/${onePiece.id}/follow`, { aco: true, maxPrice: 300, qty: 'max' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.watch.follow, { aco: true, maxPrice: 300, qty: 'max', dm: true, acoOn: true });
  r = await ash.put(`/api/drops/${pokemon.id}/follow`, { aco: true, maxPrice: 150, qty: 'min' });
  assert.deepEqual(r.body.watch.follow.qty, 'min');
  // Brock mutes the One Piece one; Misty leaves both as they are (DM'd, no Auto-checkout).
  assert.equal((await brock.put(`/api/drops/${onePiece.id}/follow`, { dm: false })).status, 200);
  assert.equal((await brock.put(`/api/drops/${boosters.id}/follow`, { dm: false })).status, 200);
  assert.ok(env.app.repo.listEvents(ash.user.id, { limit: 5 }).some((e) => /Auto-checkout buys what drops there from now on — up to \$300\.00 each, as many as EB Games \(dummy store\) allows/.test(e.message)));
  // Admins see how many have it on.
  assert.equal((await watchOf(boss, onePiece.id)).followers, 1);
  // Not a priority watch: nothing to follow.
  const own = await ash.post('/api/drops', { page: `${store.url}/ebgames/search?category=trading-cards&condition=new`, phrases: ['magic the gathering'] });
  assert.equal(own.status, 200, own.text);
  assert.equal((await ash.put(`/api/drops/${own.body.watch.id}/follow`, { aco: true, maxPrice: 10 })).status, 404);
  await ash.del(`/api/drops/${own.body.watch.id}`);
  // A lapsed member can't.
  env.app.repo.updateUser(misty.user.id, { plan: 'none', trial_ends_at: 1 });
  assert.equal((await misty.put(`/api/drops/${onePiece.id}/follow`, { aco: true, maxPrice: 100 })).status, 402, 'membership needed');
  makeMember(env, misty);
});

test('🚨 the first read of each page is how things are (nothing in it a drop); then something new up for pre-order: posted with ⚡ Buy, every member DM\'d at once (not Brock, who muted it), and bought straight away for Ash — as many as EB allows, up to his max', async () => {
  assert.equal(await readAll(), 3);
  for (const w of [onePiece, pokemon, boosters]) assert.equal((await watchOf(boss, w.id)).looked, true);
  assert.equal(itemOf(ash, '313000'), null, 'on pre-order already: not bought');
  const before = { ash: dms('d-ash').length, misty: dms('d-misty').length, brock: dms('d-brock').length, boss: dms('d-boss').length };
  // EB puts the OP-15 booster box up for pre-order.
  store.addProduct('ebgames', { sku: '313010', name: 'One Piece TCG OP-15 Booster Box', price: 239, status: 'preorder' });
  await readAll();
  const item = itemOf(ash, '313010');
  assert.ok(item, "on Ash's watchlist");
  assert.deepEqual([item.aco, item.maxPrice, item.qtyRule], [true, 300, 'max'], 'as many as EB allows');
  const runs = runsFor(item.id);
  assert.equal(runs.length, 1, 'his Auto-checkout started at once');
  assert.equal(itemOf(misty, '313010'), null, "Misty didn't turn Auto-checkout on: nothing bought for her");
  // Every member's DM — a priority drop's, with ⚡ Buy — but Brock's.
  await env.app.monitor.delivered();
  const fresh = (id, n) => dms(id).slice(n).map((m) => m.body);
  const mistyDm = fresh('d-misty', before.misty).find((b) => /OP-15 Booster Box/.test(b.embeds[0].title));
  assert.ok(mistyDm, 'Misty DM\'d');
  assert.equal(fresh('d-misty', before.misty).filter((b) => /OP-15 Booster Box/.test(b.embeds[0].title)).length, 1, 'once — though two of the pages have it (One Piece pre-orders, One Piece boosters)');
  assert.equal(mistyDm.embeds[0].author.name, '🚨 PRIORITY DROP — buy it now');
  assert.match(mistyDm.embeds[0].description, /\$239\.00 · Pre-order/);
  assert.ok(mistyDm.components[0].components.some((b) => b.label === '⚡ Buy with Mugibot'));
  assert.ok(fresh('d-ash', before.ash).some((b) => /OP-15 Booster Box/.test(b.embeds[0].title) && /Your Auto-checkout is buying it/.test(b.embeds[0].description)));
  assert.ok(fresh('d-boss', before.boss).some((b) => /OP-15 Booster Box/.test(b.embeds[0].title)), 'admins too');
  assert.ok(!fresh('d-brock', before.brock).some((b) => /OP-15 Booster Box/.test(b.embeds[0].title)), 'muted: not Brock');
  // Posted in the channel, with ⚡ Buy, once.
  const alert = env.app.db.get("SELECT * FROM feed_alerts WHERE sku = '313010' ORDER BY id DESC");
  assert.ok(alert, 'alerted');
  // Read again: nothing twice.
  const n = dms('d-misty').length;
  await readAll();
  assert.equal(runsFor(item.id).length, 1);
  assert.equal(dms('d-misty').length, n, 'DM\'d once');
});

test('🚨 cheaper than the lowest price set: not a drop — no alert, no DM, nothing bought; two at once: both bought (every drop, not just the first)', async () => {
  const n = dms('d-misty').length;
  store.addProduct('ebgames', { sku: '313020', name: 'One Piece TCG Official Sleeves Pack', price: 12, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313021', name: 'One Piece TCG EB-03 Extra Booster Box', price: 189, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313022', name: 'One Piece TCG ST-25 Starter Deck', price: 25, status: 'preorder' });
  await readAll();
  assert.equal(itemOf(ash, '313020'), null, 'under $20: not bought');
  assert.equal(env.app.db.get("SELECT 1 AS y FROM feed_alerts WHERE sku = '313020'"), null, 'nor alerted');
  for (const sku of ['313021', '313022']) {
    const it = itemOf(ash, sku);
    assert.ok(it && it.aco, `${sku} armed`);
    assert.equal(runsFor(it.id).length, 1, `${sku} bought`);
  }
  await env.app.monitor.delivered();
  const titles = dms('d-misty').slice(n).map((m) => m.body.embeds[0].title);
  assert.ok(titles.some((t) => /EB-03 Extra Booster Box/.test(t)) && titles.some((t) => /ST-25 Starter Deck/.test(t)), JSON.stringify(titles));
  assert.ok(!titles.some((t) => /Sleeves/.test(t)));
  // One placed: the watch's other buys carry on (no "one purchase per drop watch" for a priority one).
  const first = itemOf(ash, '313021');
  const run = runsFor(first.id)[0];
  env.app.aco.oncePerWatch(ash.user.id, first.id);
  assert.equal(itemOf(ash, '313022').aco, true, 'still armed');
  assert.ok(run);
});

test('🚨 Pokémon pre-orders — boosters, collections, decks: anything new on the page (no key phrases), from the lowest price; Ash buys one (Min), never over his max — and the admin can still set key phrases', async () => {
  const n = dms('d-misty').length;
  store.addProduct('ebgames', { sku: '313030', name: 'Pokémon TCG: Mega Evolution Ascended Heroes Booster Box', price: 249, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313031', name: 'Pokémon TCG: Phantasmal Flames 3-Pack Blister', price: 30, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313033', name: 'Pokémon TCG: Mega Evolution Premium Collection', price: 89, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313034', name: 'Pokémon TCG: Mega Evolution ex Battle Deck', price: 35, status: 'preorder' });
  // (Not a booster, collection or deck: not on the page at all.)
  store.addProduct('ebgames', { sku: '313035', name: 'Pokémon TCG: Mega Evolution Playmat', price: 49, status: 'preorder' });
  await readAll();
  const box = itemOf(ash, '313030');
  assert.equal(box, null, '$249 is over his max of $150 a one: never armed over it');
  assert.ok(env.app.repo.listEvents(ash.user.id, { limit: 20 }).some((e) => /Ascended Heroes Booster Box dropped at \$249\.00 — over your max of \$150\.00/.test(e.message)), "and he's told why");
  for (const sku of ['313031', '313033', '313034']) {
    const it = itemOf(ash, sku);
    assert.ok(it && it.aco, `${sku} armed`);
    assert.deepEqual([it.quantity, it.qtyRule], [1, ''], `${sku}: Min — one`);
    assert.equal(runsFor(it.id).length, 1, `${sku} bought`);
  }
  assert.equal(itemOf(ash, '313035'), null, 'not on the page: left alone');
  await env.app.monitor.delivered();
  const titles = dms('d-misty').slice(n).map((m) => m.body.embeds[0].title);
  for (const t of ['Booster Box', 'Blister', 'Premium Collection', 'Battle Deck']) assert.ok(titles.some((x) => x.includes(t)), `${t}: ${JSON.stringify(titles)}`);
  assert.ok(!titles.some((t) => /Playmat/.test(t)));
  // The admin's key phrases, changed — and back to none: every product on the page.
  let r = await boss.put(`/api/drops/${pokemon.id}`, { phrases: ['booster', 'blister', 'mini tin'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.watch.phrases, ['booster', 'blister', 'mini tin']);
  r = await boss.put(`/api/drops/${pokemon.id}`, { phrases: [] });
  assert.deepEqual(r.body.watch.phrases, []);
  assert.equal((await boss.put(`/api/drops/${pokemon.id}`, { minPrice: 0 })).body.watch.minPrice, null, '0: any price');
  assert.equal((await boss.put(`/api/drops/${pokemon.id}`, { minPrice: 20 })).body.watch.minPrice, 20);
  assert.equal((await ash.put(`/api/drops/${pokemon.id}`, { phrases: ['x'] })).status, 404, "a member can't change an admin's");
});

test('🚨 an individual card — already unpacked ("… OP01-079 - NM/M") — up on the One Piece pre-order page: every member told (it\'s a drop), never bought for anyone; nor an accessory (a playmat)', async () => {
  const n = dms('d-misty').length;
  const single = 'One Piece - TCG - One Piece Promotion Cards - Ms. All Sunday (Promotion Pack 2023) Normal OP01-079 - NM/M';
  store.addProduct('ebgames', { sku: '313050', name: single, price: 45, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313051', name: 'One Piece - TCG - Adventure on Kami\'s Island - Borsalino Foil EB04-058 - NM/M', price: 30, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313052', name: 'One Piece TCG Official Playmat - Luffy Gear 5', price: 39, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313053', name: 'One Piece TCG OP-16 Hangsell Booster', price: 24, status: 'preorder' });
  await readAll();
  for (const sku of ['313050', '313051', '313052']) {
    const it = itemOf(ash, sku);
    assert.ok(!it || !it.aco, `${sku}: never armed (${it ? 'on his watchlist, not armed' : 'not on his watchlist'})`);
    if (it) assert.equal(runsFor(it.id).length, 0, `${sku}: never bought`);
  }
  const hang = itemOf(ash, '313053');
  assert.ok(hang && hang.aco, 'the hangsell beside them: armed');
  assert.equal(runsFor(hang.id).length, 1, 'and bought');
  await env.app.monitor.delivered();
  const titles = dms('d-misty').slice(n).map((m) => m.body.embeds[0].title);
  assert.ok(titles.some((t) => t.includes('Ms. All Sunday')), `told of the single: ${JSON.stringify(titles)}`);
  assert.ok(titles.some((t) => t.includes('Playmat')), 'and of the playmat');
  // Ash's own DM of the single: never "Your Auto-checkout is buying it".
  const ashDm = dms('d-ash').map((m) => m.body.embeds[0]).filter((e) => e.title.includes('Ms. All Sunday'));
  assert.ok(ashDm.length >= 1 && ashDm.every((e) => !/Auto-checkout is buying it/.test(e.description)), JSON.stringify(ashDm));
  // Even if something armed it (an item someone's watch put there): its run is never made — disarmed, and why.
  const row = env.app.db.get("SELECT * FROM items WHERE user_id = :u AND sku = '313050'", { u: ash.user.id });
  if (row) {
    env.app.db.run('UPDATE items SET aco = 1, drop_watch = :w WHERE id = :i', { w: onePiece.id, i: row.id });
    const run = await env.app.aco.trigger(env.app.db.get('SELECT * FROM items WHERE id = :i', { i: row.id }), { status: 'preorder', price: 45 });
    assert.equal(run && run.status, 'skipped');
    assert.equal(run.reason, 'single');
    assert.equal(itemOf(ash, '313050').aco, false, 'disarmed');
  }
});

test('🚨 every One Piece product, for "one piece booster": a booster in stock or for pre-order — armed for each member with Auto-checkout of it on; a single card with "booster" in its name, and anything without the words, never bought', async () => {
  assert.equal((await misty.put(`/api/drops/${boosters.id}/follow`, { aco: true, maxPrice: 60, qty: 'max' })).status, 200);
  const n = dms('d-brock').length;
  store.addProduct('ebgames', { sku: '313060', name: 'One Piece TCG OP-17 Hangsell Booster', price: 9, status: 'in_stock' });
  store.addProduct('ebgames', { sku: '313061', name: 'One Piece TCG EB-04 Extra Booster', price: 32, status: 'in_stock' });
  store.addProduct('ebgames', { sku: '313062', name: 'One Piece - TCG - Booster Pack Promo Monkey D. Luffy OP05-119 - NM/M', price: 55, status: 'in_stock' });
  store.addProduct('ebgames', { sku: '313063', name: 'One Piece TCG Double Pack Set Vol.9', price: 30, status: 'in_stock' });
  await readAll();
  const ext = itemOf(misty, '313061');
  assert.ok(ext && ext.aco, 'the extra booster: armed for Misty');
  assert.equal(ext.qtyRule, 'max', 'as many as EB allows');
  assert.equal(runsFor(ext.id).length, 1, 'and bought');
  assert.equal(itemOf(misty, '313060'), null, '$9: under the lowest price ($20) — not a drop');
  const single = itemOf(misty, '313062');
  assert.ok(!single || !single.aco, 'the single card with "booster" in its name: never armed');
  assert.equal(itemOf(misty, '313063'), null, 'no "booster": not this page\'s');
  await env.app.monitor.delivered();
  // Brock muted the One Piece pages: not told.
  assert.ok(!dms('d-brock').slice(n).some((m) => /EB-04 Extra Booster/.test(m.body.embeds[0].title)));
});

test('🚨 a drop another search found first (EB\'s card keyword sweep a moment before the page): still the priority watch\'s drop — Ash\'s Auto-checkout buys it and every member is told, once', async () => {
  const sw = env.app.sweeper;
  const n = dms('d-misty').length;
  store.addProduct('ebgames', { sku: '313040', name: 'One Piece TCG OP-16 Booster Box', price: 229, status: 'preorder' });
  // EB's own search (an admin's browser's keyword sweep) sees it first.
  const url = `${store.url}/ebgames/product/toys-and-collectibles/313040-one-piece-tcg-op-16-booster-box`;
  await sw.browserResults(admin(), [{ store: 'demo-ebgames', keyword: 'one piece', page: 1, ok: true, ms: 300, products: [{ sku: '313040', title: 'One Piece TCG OP-16 Booster Box', price: 229, inStock: true, preorder: true, url }] }]);
  await readAll();
  const it = itemOf(ash, '313040');
  assert.ok(it && it.aco, 'armed for Ash all the same');
  assert.equal(runsFor(it.id).length, 1, 'and bought');
  await env.app.drops.allTold();
  assert.equal(dms('d-misty').slice(n).filter((m) => /OP-16 Booster Box/.test(m.body.embeds[0].title)).length, 1, 'Misty told once');
});

test('🚨 ⚡ Buy pressed on a priority drop\'s alert (Discord, the dashboard): as many as that member said for these drops — else as the watch says (as many as EB allows)', async () => {
  const a = env.app.db.get("SELECT * FROM feed_alerts WHERE sku = '313010' ORDER BY id DESC");
  const mine = alertItem(env.app.ctx, env.app.repo.userById(misty.user.id), a);
  assert.equal(mine.qtyRule, 'max', "Misty never said: the watch's — as many as EB allows");
  await brock.put(`/api/drops/${onePiece.id}/follow`, { qty: 'min' });
  const his = alertItem(env.app.ctx, env.app.repo.userById(brock.user.id), a);
  assert.deepEqual([his.quantity, his.qtyRule], [1, ''], 'Brock said Min: one');
});

test("🚨 read every 3 s, by whichever admin's browser asks — two of them share the reads (never one page twice at once); none open: the watch says it's waiting, and the first that opens reads at once", async () => {
  const other = await Client.signup(env.url, 'boss2');
  env.app.repo.updateUser(other.user.id, { role: 'admin' });
  makeMember(env, other);
  const second = env.app.repo.userById(other.user.id);
  clock.offset += 3100;
  const a = pages().browserDue(admin(), { version: '1.41.0' }).pages;
  const b = pages().browserDue(second, { version: '1.41.0' }).pages;
  assert.equal(a.length + b.length >= 1, true);
  assert.equal(new Set([...a, ...b].map((t) => t.url)).size, a.length + b.length, 'never the same page to both at once');
  for (const t of [...a, ...b]) await pages().browserResults(admin(), [{ id: t.id, ok: true, how: 'data', products: [] }]);
  // Nobody's browser for a while: waiting — said on the watch.
  clock.offset += 3 * 60 * 1000;
  assert.equal(pages().viewOf(env.app.drops.get(onePiece.id)).waiting, 'browser');
  // The first to ask reads at once.
  assert.ok(pages().browserDue(second, { version: '1.41.0' }).pages.length >= 1);
});

test('🤝 a pool: the leader\'s Auto-checkout of a priority drop starts the same order for each member who checks out with them — at once, on their own account; a single card is bought for neither; the leader\'s ⚡ Buy of it starts theirs too', async () => {
  const gary = await Client.signup(env.url, 'gary');
  makeMember(env, gary);
  env.app.repo.updateUser(gary.user.id, { discord_id: 'd-gary' });
  for (const it of (await gary.get('/api/items')).body.items) await gary.del(`/api/items/${it.id}`);
  assert.equal((await gary.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 3000, perDay: 20, spendPerDay: 20000 })).status, 200);
  env.app.repo.addDevice(gary.user.id, 'Gary laptop', '1.42.0');
  const pool = (await boss.post('/api/admin/pools', { name: 'Boss crew' })).body.pool;
  assert.equal((await boss.post(`/api/admin/pools/${pool.id}/members`, { username: 'gary' })).status, 200);
  assert.equal((await gary.post(`/api/pool/${pool.id}/accept`)).status, 200);
  const f = await gary.put('/api/pool/follow', { on: true, agree: true, cap: 400 });
  assert.equal(f.status, 200, f.text);
  // Boss turns on his own Auto-checkout of the One Piece pre-orders.
  assert.equal((await boss.put(`/api/drops/${onePiece.id}/follow`, { aco: true, maxPrice: 300, qty: 'max' })).status, 200);
  const garyRuns = () => env.app.db.all('SELECT * FROM aco_runs WHERE user_id = :u ORDER BY rowid', { u: gary.user.id });
  store.addProduct('ebgames', { sku: '313070', name: 'One Piece TCG OP-18 Booster Box', price: 249, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313071', name: 'One Piece - TCG - Nami Foil OP01-016 - NM/M', price: 60, status: 'preorder' });
  await readAll();
  await new Promise((r) => setImmediate(r));
  const bossBox = itemOf(boss, '313070');
  assert.ok(bossBox && bossBox.aco, "armed on boss's");
  assert.equal(runsFor(bossBox.id).length, 1, "boss's run started");
  const copy = env.app.db.get('SELECT * FROM items WHERE user_id = :u AND pool_src = :s', { u: gary.user.id, s: bossBox.id });
  assert.ok(copy, "boss's item on gary's watchlist");
  const run = garyRuns().find((x) => x.item_id === copy.id);
  assert.ok(run, `gary's run of the same order: ${JSON.stringify(garyRuns())}`);
  assert.equal(run.trigger, 'pool');
  assert.notEqual(run.status, 'skipped', run.message);
  // The single card: armed for neither, run for neither.
  assert.ok(!itemOf(boss, '313071') || !itemOf(boss, '313071').aco);
  assert.ok(!garyRuns().some((x) => x.item_id !== copy.id));
  // Boss's ⚡ Buy (Trigger ACO) on something: gary's checkout of it starts as well.
  const own = (await boss.post('/api/items', { url: `${R().base}/product/toys-and-collectibles/313072-one-piece-tcg-op-18-hangsell-booster`, name: 'One Piece TCG OP-18 Hangsell Booster', maxPrice: 60 })).body;
  assert.ok(own.id, JSON.stringify(own));
  await new Promise((r) => setImmediate(r));
  const t = await boss.post(`/api/aco/test/${own.id}`);
  assert.equal(t.status, 200, t.text);
  const copy2 = env.app.db.get('SELECT * FROM items WHERE user_id = :u AND pool_src = :s', { u: gary.user.id, s: own.id });
  assert.ok(copy2 && garyRuns().some((x) => x.item_id === copy2.id && x.trigger === 'pool'), JSON.stringify(garyRuns()));
});

test("🤝 a member who has the same product on their own watchlist already (not armed — an alert's, say): the leader's priority drop still starts it for them, as the group's order — never left out", async () => {
  const gary = env.app.repo.userByUsername ? env.app.repo.userByUsername('gary') : env.app.db.get("SELECT * FROM users WHERE username = 'gary'");
  const url = `${R().base}/product/toys-and-collectibles/313080-one-piece-tcg-op-19-booster-box`;
  const mine = env.app.repo.addItem(gary.id, { store: 'demo-ebgames', sku: '313080', name: 'One Piece TCG OP-19 Booster Box', url, price: null, maxPrice: null, quantity: 1, profileId: null, cardId: '', monitor: true, announce: false, aco: false, discount: '' });
  store.addProduct('ebgames', { sku: '313080', name: 'One Piece TCG OP-19 Booster Box', price: 259, status: 'preorder' });
  await readAll();
  await new Promise((r) => setImmediate(r));
  const bossBox = itemOf(boss, '313080');
  assert.ok(bossBox && bossBox.aco && runsFor(bossBox.id).length === 1, "boss's bought");
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM items WHERE user_id = :u AND sku = :k', { u: gary.id, k: '313080' }).n, 1, 'one item of it on his watchlist: his own');
  const run = env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: mine.id });
  assert.equal(run.length, 1, 'his own item checked out with the group');
  assert.deepEqual([run[0].trigger, run[0].status !== 'skipped'], ['pool', true], run[0].message);
  assert.equal(env.app.db.get('SELECT max_price FROM items WHERE id = :i', { i: mine.id }).max_price, 300, "up to the leader's max (his most for the pool is $400)");
});

test('🚨 a page longer than one read (EB Games gives one page of results — every One Piece product is hundreds): its newest first, a new booster at the top is a drop all the same — armed and bought at once', async () => {
  const S = store.shop('ebgames');
  S.pageSize = 3;
  try {
    const boss3 = await Client.signup(env.url, 'boss3');
    env.app.repo.updateUser(boss3.user.id, { role: 'admin', discord_id: 'd-boss3' });
    makeMember(env, boss3);
    for (const it of (await boss3.get('/api/items')).body.items) await boss3.del(`/api/items/${it.id}`);
    assert.equal((await boss3.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 3000, perDay: 20, spendPerDay: 20000 })).status, 200);
    env.app.repo.addDevice(boss3.user.id, 'Chrome', '1.42.0');
    const r = await boss3.post('/api/drops', { page: boosters.page, phrases: ['one piece booster'], shared: true, priority: true, category: 'onepiece', minPrice: 20, aco: true, maxPrice: 100, qty: 'max', every: 3 });
    assert.equal(r.status, 200, r.text);
    const w = r.body.watch;
    // Its first look: the newest 3 of many (not every result).
    await readAll();
    await readAll();
    assert.equal((await watchOf(boss3, w.id)).looked, true);
    store.addProduct('ebgames', { sku: '313090', name: 'One Piece TCG OP-20 Hangsell Booster', price: 45, status: 'in_stock' });
    await readAll();
    const it = env.app.repo.itemBySku(boss3.user.id, 'demo-ebgames', '313090');
    assert.ok(it && it.aco, `armed: ${JSON.stringify(env.app.drops.get(w.id).found.slice(-3))}`);
    assert.equal(runsFor(it.id).length, 1, 'and bought at once');
    // What was below the cut before (an old product coming up into view): never a drop.
    const vis = await (await fetch(`${boosters.page.replace('/search?', '/search/query?')}`)).json();
    assert.equal(vis.results.length, 3);
  } finally {
    S.pageSize = 0;
  }
});
