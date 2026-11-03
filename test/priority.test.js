// 🚨 Priority drops (Mugibot 2.2): EB Games' pre-order pages, for everyone — One Piece (anything new on it, from the
// lowest price the admin sets) and Pokémon boosters (what has "booster" or "blister" in its name — key phrases the admin
// can change). Read every 3 s from an admin's browser (EB Games turns servers away); something new up for pre-order
// there: posted in the channel with ⚡ Buy, every member DM'd at once (but those who've muted it), and bought straight
// away for each member who's turned on Auto-checkout of these drops — up to their own max, as many as EB allows or one
// (their choice), every new product (not just the first), within their own Auto-checkout limits.
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
/** Both pages read (a store's pages take turns: a round each, till each has been read). */
async function readBoth() {
  const read = new Set();
  for (let i = 0; i < 4 && read.size < 2; i++) for (const u of await browserRound()) read.add(u);
  return read.size;
}

let onePiece;
let pokemon;

test('🚨 the EB Games pre-order preset (admins): One Piece — anything new, from the lowest price set — and Pokémon boosters ("booster", "blister"), each a priority watch for everyone, read every 3 s, as many as EB allows', async () => {
  // Members can't add watches for everyone.
  assert.equal((await ash.post('/api/drops/presets/ebpreorders', { demo: true })).status, 400);
  const r = await boss.post('/api/drops/presets/ebpreorders', { demo: true, minPrice: 20, qty: 'max' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.added.length, 2);
  [onePiece, pokemon] = r.body.added;
  assert.equal(onePiece.page, `${store.url}/ebgames/search?category=trading-cards&subcategory=trading-cards-one-piece&condition=preorder`);
  assert.equal(pokemon.page, `${store.url}/ebgames/search?category=trading-cards&subcategory=trading-cards-pokemon&attributes=trading-card-type%3Aboosters&condition=preorder`);
  assert.deepEqual([onePiece.priority, onePiece.shared, onePiece.phrases, onePiece.minPrice, onePiece.every, onePiece.qtyRule], [true, true, [], 20, 3, 'max']);
  assert.deepEqual([pokemon.priority, pokemon.phrases, pokemon.minPrice], [true, ['booster', 'blister'], 20]);
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
  assert.equal(await readBoth(), 2);
  for (const w of [onePiece, pokemon]) assert.equal((await watchOf(boss, w.id)).looked, true);
  assert.equal(itemOf(ash, '313000'), null, 'on pre-order already: not bought');
  const before = { ash: dms('d-ash').length, misty: dms('d-misty').length, brock: dms('d-brock').length, boss: dms('d-boss').length };
  // EB puts the OP-15 booster box up for pre-order.
  store.addProduct('ebgames', { sku: '313010', name: 'One Piece TCG OP-15 Booster Box', price: 239, status: 'preorder' });
  await readBoth();
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
  await readBoth();
  assert.equal(runsFor(item.id).length, 1);
  assert.equal(dms('d-misty').length, n, 'DM\'d once');
});

test('🚨 cheaper than the lowest price set: not a drop — no alert, no DM, nothing bought; two at once: both bought (every drop, not just the first)', async () => {
  const n = dms('d-misty').length;
  store.addProduct('ebgames', { sku: '313020', name: 'One Piece TCG Official Sleeves Pack', price: 12, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313021', name: 'One Piece TCG EB-03 Extra Booster Box', price: 189, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313022', name: 'One Piece TCG ST-25 Starter Deck', price: 25, status: 'preorder' });
  await readBoth();
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

test('🚨 Pokémon boosters: only what has a key phrase — "booster", "blister" — and the admin can add more ("mini tin") or set none (every product); Ash buys one (Min), never over his max', async () => {
  const n = dms('d-misty').length;
  store.addProduct('ebgames', { sku: '313030', name: 'Pokémon TCG: Mega Evolution Ascended Heroes Booster Box', price: 249, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313031', name: 'Pokémon TCG: Phantasmal Flames 3-Pack Blister', price: 30, status: 'preorder' });
  store.addProduct('ebgames', { sku: '313032', name: 'Pokémon TCG: Mini Tin 2-Pack', price: 25, status: 'preorder' });
  await readBoth();
  const box = itemOf(ash, '313030');
  assert.equal(box, null, '$249 is over his max of $150 a one: never armed over it');
  assert.ok(env.app.repo.listEvents(ash.user.id, { limit: 20 }).some((e) => /Ascended Heroes Booster Box dropped at \$249\.00 — over your max of \$150\.00/.test(e.message)), "and he's told why");
  const blister = itemOf(ash, '313031');
  assert.ok(blister && blister.aco);
  assert.deepEqual([blister.quantity, blister.qtyRule], [1, ''], 'Min: one');
  assert.equal(runsFor(blister.id).length, 1);
  assert.equal(itemOf(ash, '313032'), null, 'no key phrase: left alone');
  await env.app.monitor.delivered();
  const titles = dms('d-misty').slice(n).map((m) => m.body.embeds[0].title);
  assert.ok(titles.some((t) => /Booster Box/.test(t)) && titles.some((t) => /Blister/.test(t)), JSON.stringify(titles));
  assert.ok(!titles.some((t) => /Mini Tin/.test(t)));
  // The admin's key phrases, changed — none: every product on the page.
  const r = await boss.put(`/api/drops/${pokemon.id}`, { phrases: ['booster', 'blister', 'mini tin'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.watch.phrases, ['booster', 'blister', 'mini tin']);
  assert.equal((await boss.put(`/api/drops/${pokemon.id}`, { minPrice: 0 })).body.watch.minPrice, null, '0: any price');
  assert.equal((await ash.put(`/api/drops/${pokemon.id}`, { phrases: ['x'] })).status, 404, "a member can't change an admin's");
});

test('🚨 a drop another search found first (EB\'s card keyword sweep a moment before the page): still the priority watch\'s drop — Ash\'s Auto-checkout buys it and every member is told, once', async () => {
  const sw = env.app.sweeper;
  const n = dms('d-misty').length;
  store.addProduct('ebgames', { sku: '313040', name: 'One Piece TCG OP-16 Booster Box', price: 229, status: 'preorder' });
  // EB's own search (an admin's browser's keyword sweep) sees it first.
  const url = `${store.url}/ebgames/product/toys-and-collectibles/313040-one-piece-tcg-op-16-booster-box`;
  await sw.browserResults(admin(), [{ store: 'demo-ebgames', keyword: 'one piece', page: 1, ok: true, ms: 300, products: [{ sku: '313040', title: 'One Piece TCG OP-16 Booster Box', price: 229, inStock: true, preorder: true, url }] }]);
  await readBoth();
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
