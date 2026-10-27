// Pools (server/pools.js, docs/POOLS.md): an admin's watchlist, armed items and drop watches shared with the members
// who join their pool — kept in step on each member's own watchlist the moment the admin changes theirs — and, for
// each member who agrees to it themselves, the admin's Auto-checkouts started for them too: on their own account, in
// their own checkout browser, with their own card, details and limits, up to the most they set. Every say a member has
// is theirs alone: joining, checking out with the leader, skipping an item, leaving. The browser's own checkout is
// tested against the dummy stores in extension.e2e.test.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, makeMember, startApp, waitFor } from './helpers.js';
import { toRun } from '../server/aco.js';

let env;
let boss; // an admin: leads the pool
let ash; // a member who joins, and checks out with boss
let misty; // a member who joins, and doesn't
let brock; // another admin, with a pool of their own
let ashBrowser;
let pool;

before(async () => {
  env = await startApp({ adminUsernames: 'boss,brock' });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  misty = await Client.signup(env.url, 'misty');
  brock = await Client.signup(env.url, 'brock');
  for (const c of [boss, ash, misty, brock]) {
    makeMember(env, c);
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  }
  // Auto-checkout on, placing orders — boss's and ash's own switches.
  for (const c of [boss, ash]) assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 2000, perDay: 10, spendPerDay: 20000 })).status, 200);
  env.app.repo.addDevice(boss.user.id, 'Boss PC', '1.36.0');
  ashBrowser = await Device.pair(env.url, ash, 'Ash laptop');
});
after(async () => { await env.close(); });

const KMART = (sku) => `https://www.kmart.com.au/product/pokemon-tcg-test-${sku}/`;
const items = async (c) => (await c.get('/api/items')).body.items;
const copies = async (c) => (await items(c)).filter((it) => it.pool);
const copyOf = async (c, srcId) => (await items(c)).find((it) => it.pool && it.pool.src === srcId) || null;
const runs = (userId) => env.app.db.all('SELECT * FROM aco_runs WHERE user_id = :u ORDER BY rowid', { u: userId }).map(toRun);
const events = async (c) => (await c.get('/api/events')).body.events;
const itemRow = (id) => env.app.db.get('SELECT * FROM items WHERE id = :id', { id });
const settle = () => new Promise((r) => setImmediate(r));

test('🤝 admins make a pool and ask members to join it — members-only routes are admins\' only, and the asks are checked', async () => {
  // Not for members.
  assert.equal((await ash.post('/api/admin/pools', { name: 'Mine' })).status, 404);
  assert.equal((await ash.get('/api/admin/pools')).status, 404);

  assert.equal((await boss.post('/api/admin/pools', { name: '' })).status, 400);
  const made = await boss.post('/api/admin/pools', { name: 'Boss crew' });
  assert.equal(made.status, 200, made.text);
  pool = made.body.pool;
  assert.deepEqual([pool.name, pool.leader.username, pool.members], ['Boss crew', 'boss', []]);

  // Who can be asked: someone who exists, isn't its leader, doesn't lead a pool themselves, isn't asked twice.
  assert.match((await boss.post(`/api/admin/pools/${pool.id}/members`, { username: 'nobody' })).body.error, /no member called/);
  assert.match((await boss.post(`/api/admin/pools/${pool.id}/members`, { username: 'boss' })).body.error, /leads this pool/);
  const brocks = (await brock.post('/api/admin/pools', { name: 'Brock crew' })).body.pool;
  assert.match((await boss.post(`/api/admin/pools/${pool.id}/members`, { username: 'brock' })).body.error, /leads a pool of their own/);
  for (const who of ['ash', 'misty']) assert.equal((await boss.post(`/api/admin/pools/${pool.id}/members`, { username: who })).status, 200);
  const twice = await boss.post(`/api/admin/pools/${pool.id}/members`, { username: 'ash' });
  assert.equal(twice.status, 409);
  // (Brock asks ash too: ash chooses one pool.)
  assert.equal((await brock.post(`/api/admin/pools/${brocks.id}/members`, { username: 'ash' })).status, 200);

  // Asked, not in: nothing of boss's on their watchlists yet, and they're told.
  const view = (await ash.get('/api/pool')).body;
  assert.equal(view.pool, null);
  assert.deepEqual(view.invites.map((i) => [i.name, i.leader]), [['Boss crew', 'boss'], ['Brock crew', 'brock']]);
  assert.ok((await events(ash)).some((e) => /boss asked you to join the pool "Boss crew"/.test(e.message)));
  const list = (await boss.get('/api/admin/pools')).body.pools.find((p) => p.id === pool.id);
  assert.deepEqual(list.members.map((m) => [m.username, m.status, m.followAco]), [['ash', 'invited', false], ['misty', 'invited', false]]);
  assert.ok(env.app.repo.listAudit().some((a) => a.action === 'pool-invite'));
});

test('🤝 joining: boss\'s watchlist shows on the member\'s own, kept in step the moment boss changes theirs — added, changed, paused, removed — and the member can\'t change boss\'s', async () => {
  const a = (await boss.post('/api/items', { url: KMART('43818648'), name: 'Day UPC', maxPrice: 380 })).body;
  // Ash has one of their own at the same store and SKU as one of boss's: theirs stays theirs.
  const ownB = (await ash.post('/api/items', { url: KMART('43818649'), name: 'Ash own Night UPC', maxPrice: 200 })).body;
  const b = (await boss.post('/api/items', { url: KMART('43818649'), name: 'Night UPC', maxPrice: 380 })).body;
  // Only one pool at a time: Brock's ask declined, boss's taken.
  const brocks = (await brock.get('/api/admin/pools')).body.pools.find((p) => p.leader.username === 'brock');
  assert.equal((await ash.post(`/api/pool/${brocks.id}/decline`)).status, 200);
  const joined = await ash.post(`/api/pool/${pool.id}/accept`);
  assert.equal(joined.status, 200, joined.text);
  assert.equal(joined.body.pool.leader, 'boss');
  assert.equal(joined.body.pool.followAco, false, 'checking out with boss: off until ash switches it on');
  assert.equal((await misty.post(`/api/pool/${pool.id}/accept`)).status, 200);

  // Boss's item on ash's watchlist (a copy of it, from the pool) — not the one ash has already.
  let mine = await copies(ash);
  assert.deepEqual(mine.map((it) => [it.name, it.pool.src, it.maxPrice, it.aco]), [['Day UPC', a.id, 380, false]]);
  assert.equal((await items(ash)).find((it) => it.id === ownB.id).name, 'Ash own Night UPC', 'their own, as they have it');
  assert.equal(b.name, 'Night UPC');
  // (Not counted towards ash's own SKUs.)
  assert.equal(env.app.repo.countItems(ash.user.id), 1);

  // Boss adds, changes, pauses: ash's copies follow at once.
  const c = (await boss.post('/api/items', { url: KMART('43818650'), name: 'ETB', maxPrice: 120 })).body;
  await settle();
  assert.ok(await copyOf(ash, c.id), 'added');
  assert.ok(await copyOf(misty, c.id), "on misty's too");
  await boss.put(`/api/items/${a.id}`, { name: 'Day UPC (30th)', maxPrice: 400, quantity: 2 });
  await boss.put(`/api/items/${c.id}`, { monitor: false });
  await settle();
  let copy = await copyOf(ash, a.id);
  assert.deepEqual([copy.name, copy.maxPrice, copy.quantity], ['Day UPC (30th)', 400, 2]);
  assert.equal((await copyOf(ash, c.id)).monitor, false, 'paused, as boss paused it');

  // The member can't change boss's — they skip it instead, or leave.
  const edit = await ash.put(`/api/items/${copy.id}`, { name: 'Mine now' });
  assert.equal(edit.status, 409);
  assert.match(edit.body.error, /boss's pool/);
  assert.equal((await ash.del(`/api/items/${copy.id}`)).status, 409);

  // Boss removes one: gone from theirs.
  await boss.del(`/api/items/${c.id}`);
  await settle();
  assert.equal(await copyOf(ash, c.id), null);
  mine = await copies(ash);
  assert.deepEqual(mine.map((it) => it.pool.src), [a.id]);

  // Real time: ash's open dashboard was told (an SSE 'watch' event) each time.
  const told = [];
  env.app.hub.tap((type, userId) => { if (userId === ash.user.id && type === 'watch') told.push(type); });
  await boss.put(`/api/items/${a.id}`, { name: 'Day UPC', quantity: 1 });
  await settle();
  assert.ok(told.length >= 1, 'a live update for ash');
  copy = await copyOf(ash, a.id);
  assert.equal(copy.name, 'Day UPC');
});

test('🤝 checking out with boss is the member\'s own switch: agreed to, with the most it may cost an item, with their own Auto-checkout on — then boss\'s armed items are armed on theirs, never over their most', async () => {
  const a = (await items(boss)).find((it) => it.name === 'Day UPC');
  // Boss arms it.
  assert.equal((await boss.put(`/api/items/${a.id}`, { aco: true, maxPrice: 400 })).status, 200);
  await settle();
  assert.equal((await copyOf(ash, a.id)).aco, false, 'not armed on ash\'s: ash hasn\'t said so');

  // Ash's say: the agreement, a most, and their own Auto-checkout on.
  let r = await ash.put('/api/pool/follow', { on: true, cap: 350 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /agree/);
  r = await ash.put('/api/pool/follow', { on: true, agree: true });
  assert.match(r.body.error, /most it may cost/);
  r = await misty.put('/api/pool/follow', { on: true, agree: true, cap: 300 });
  assert.match(r.body.error, /your own Auto-checkout on first/, "misty's Auto-checkout is off");
  r = await ash.put('/api/pool/follow', { on: true, agree: true, cap: 350 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.pool.followAco, r.body.pool.cap, r.body.pool.agreed], [true, 350, true]);
  assert.ok((await events(ash)).some((e) => /Checking out with boss/.test(e.message) && /\$350\.00 an item/.test(e.message)));

  // Armed on ash's copy, up to ash's most (350), not boss's (400).
  let copy = await copyOf(ash, a.id);
  assert.deepEqual([copy.aco, copy.maxPrice], [true, 350]);
  assert.equal((await copyOf(misty, a.id)).aco, false, "misty doesn't check out with boss");
  const list = (await boss.get('/api/admin/pools')).body.pools.find((p) => p.id === pool.id);
  assert.deepEqual(list.members.map((m) => [m.username, m.status, m.followAco]), [['ash', 'active', true], ['misty', 'active', false]]);
  // (Ash's most, as a value anywhere in it — not three digits inside a time or an id.)
  assert.doesNotMatch(JSON.stringify(list), /(?<![\d.])350(?!\d)/, "what ash would spend is ash's");

  // Boss disarms: disarmed on ash's. Boss switches their Auto-checkout off: nothing of theirs armed on anyone's.
  await boss.put(`/api/items/${a.id}`, { aco: false });
  await settle();
  assert.equal((await copyOf(ash, a.id)).aco, false);
  await boss.put(`/api/items/${a.id}`, { aco: true, maxPrice: 400 });
  await settle();
  assert.equal((await copyOf(ash, a.id)).aco, true);
  await boss.put('/api/aco', { enabled: false });
  await settle();
  assert.equal((await copyOf(ash, a.id)).aco, false, "boss's Auto-checkout off");
  await boss.put('/api/aco', { enabled: true });
  await settle();
  copy = await copyOf(ash, a.id);
  assert.equal(copy.aco, true, 'and on again');

  // Ash skips it: never armed on theirs — and follows it again.
  assert.equal((await ash.post(`/api/items/${copy.id}/pool-hold`, { hold: true })).body.item.aco, false);
  await boss.put(`/api/items/${a.id}`, { aco: true, maxPrice: 400 });
  await settle();
  assert.equal((await copyOf(ash, a.id)).aco, false, 'skipped');
  assert.equal((await ash.post(`/api/items/${copy.id}/pool-hold`, { hold: false })).status, 200);
  assert.equal((await copyOf(ash, a.id)).aco, true, 'followed again');
});

test('🤝 a drop of boss\'s armed item starts ash\'s run at once — on ash\'s account, up to ash\'s most — and ash\'s browser checks it out; bought once, it isn\'t armed again till boss arms theirs again', async () => {
  const a = (await items(boss)).find((it) => it.name === 'Day UPC');
  const copy = await copyOf(ash, a.id);
  const before = runs(ash.user.id).length;
  await env.app.monitor.alertRestock(itemRow(a.id), { status: 'in_stock', price: 340, source: 'sweep' });
  const bossRun = runs(boss.user.id).at(-1);
  assert.equal(bossRun.status, 'queued', "boss's own run");
  const mine = runs(ash.user.id);
  assert.equal(mine.length, before + 1, 'one run for ash');
  const run = mine.at(-1);
  assert.deepEqual([run.itemId, run.trigger, run.status, run.maxPrice, run.mode], [copy.id, 'pool', 'queued', 350, 'place']);
  assert.match(run.message, /boss's drop \(your pool\)/);
  assert.ok((await events(ash)).some((e) => /Auto-checkout started with boss: Day UPC/.test(e.message)));
  assert.equal(runs(misty.user.id).length, 0, "misty doesn't check out with boss");

  // The same drop seen on ash's own copy (the same page): no second run.
  await env.app.monitor.alertRestock(itemRow(copy.id), { status: 'in_stock', price: 340, source: 'sweep' });
  assert.equal(runs(ash.user.id).length, before + 1);

  // Ash's browser picks it up and places the order — ash's own.
  const next = (await ashBrowser.call('GET', '/api/ext/aco/next')).body;
  assert.equal(next.runs.length, 1);
  assert.equal(next.runs[0].id, run.id);
  const code = new URL(next.runs[0].url).hash.replace('#mgb-go=', '');
  assert.equal((await ashBrowser.call('POST', '/api/ext/claim', { code })).status, 200);
  await ashBrowser.call('POST', `/api/ext/aco/${run.id}`, { status: 'placing', total: 345 });
  await ashBrowser.call('POST', `/api/ext/aco/${run.id}`, { status: 'placed', message: 'Order confirmed' });
  assert.equal(itemRow(copy.id).aco, 0, 'bought: this arming is used up');
  // Boss's own run fails (sold out by then): boss's stays armed — ash's isn't armed again for it.
  await env.app.aco.finish(boss.user.id, env.app.aco.get(boss.user.id, bossRun.id), 'failed', 'sold_out', 'Sold out');
  env.app.pools.sync(boss.user.id);
  assert.equal(itemRow(copy.id).aco, 0, 'not bought twice for one arming');
  // Boss arms it again (a new arming): ash's is armed again.
  await boss.put(`/api/items/${a.id}`, { aco: false });
  await boss.put(`/api/items/${a.id}`, { aco: true, maxPrice: 400 });
  await settle();
  assert.equal(itemRow(copy.id).aco, 1);
});

test('🤝 boss starting a checkout themselves — Trigger ACO, Discord\'s ⚡ Buy — starts ash\'s for the same item at once, armed or not on ash\'s (unless ash skips it); never two at once; ash\'s Auto-checkout off: told, nothing started', async () => {
  const d = (await boss.post('/api/items', { url: KMART('43818651'), name: 'Booster Bundle', maxPrice: 60 })).body;
  await settle();
  const copy = await copyOf(ash, d.id);
  assert.equal(copy.aco, false, 'not armed on boss\'s either');

  // Trigger ACO.
  const t = await boss.post(`/api/aco/test/${d.id}`, {});
  assert.equal(t.status, 200, t.text);
  await waitFor(() => runs(ash.user.id).some((r) => r.itemId === copy.id), { message: "ash's run" });
  let run = runs(ash.user.id).find((r) => r.itemId === copy.id);
  assert.deepEqual([run.trigger, run.status, run.maxPrice], ['pool', 'queued', 60]);
  assert.match(run.message, /boss started it \(your pool\)/);
  // Ash's checkout browser takes it up — not armed on ash's, and it goes all the same (boss started it).
  const taken = (await ashBrowser.call('GET', '/api/ext/aco/next')).body.runs;
  assert.deepEqual(taken.map((x) => x.id), [run.id], JSON.stringify(taken));
  assert.equal(env.app.aco.get(ash.user.id, run.id).status, 'sent');
  // Again while it's going: no second run for ash.
  await env.app.aco.finish(boss.user.id, env.app.aco.get(boss.user.id, runs(boss.user.id).at(-1).id), 'failed', 'stopped', 'stopped');
  assert.equal((await boss.post(`/api/aco/test/${d.id}`, {})).status, 200);
  await settle();
  assert.equal(runs(ash.user.id).filter((r) => r.itemId === copy.id).length, 1, 'never two at once for an item');
  await env.app.aco.finish(ash.user.id, env.app.aco.get(ash.user.id, run.id), 'failed', 'stopped', 'stopped');
  await env.app.aco.finish(boss.user.id, env.app.aco.get(boss.user.id, runs(boss.user.id).at(-1).id), 'failed', 'stopped', 'stopped');

  // Discord's ⚡ Buy (the same as "Send to my computer").
  const remote = await boss.post(`/api/aco/remote/${d.id}`, { price: 55 });
  assert.equal(remote.status, 200, remote.text);
  await waitFor(() => runs(ash.user.id).filter((r) => r.itemId === copy.id).length === 2, { message: "ash's second run" });
  run = runs(ash.user.id).filter((r) => r.itemId === copy.id).at(-1);
  assert.deepEqual([run.trigger, run.price], ['pool', 55]);
  await env.app.aco.finish(ash.user.id, env.app.aco.get(ash.user.id, run.id), 'failed', 'stopped', 'stopped');
  await env.app.aco.finish(boss.user.id, env.app.aco.get(boss.user.id, runs(boss.user.id).at(-1).id), 'failed', 'stopped', 'stopped');

  // Skipped after boss started it, before ash's browser took it up: it doesn't start.
  assert.equal((await boss.post(`/api/aco/test/${d.id}`, {})).status, 200);
  await waitFor(() => runs(ash.user.id).filter((r) => r.itemId === copy.id).length === 3, { message: "ash's third run" });
  run = runs(ash.user.id).filter((r) => r.itemId === copy.id).at(-1);
  await ash.post(`/api/items/${copy.id}/pool-hold`, { hold: true });
  assert.deepEqual((await ashBrowser.call('GET', '/api/ext/aco/next')).body.runs, []);
  assert.deepEqual([env.app.aco.get(ash.user.id, run.id).status, env.app.aco.get(ash.user.id, run.id).reason], ['expired', 'disarmed']);
  await env.app.aco.finish(boss.user.id, env.app.aco.get(boss.user.id, runs(boss.user.id).at(-1).id), 'failed', 'stopped', 'stopped');
  await ash.post(`/api/items/${copy.id}/pool-hold`, { hold: false });

  // Ash skips it: boss's checkouts don't start ash's.
  await ash.post(`/api/items/${copy.id}/pool-hold`, { hold: true });
  await boss.post(`/api/aco/test/${d.id}`, {});
  await settle();
  assert.equal(runs(ash.user.id).filter((r) => r.itemId === copy.id).length, 3, 'skipped: nothing started');
  await env.app.aco.finish(boss.user.id, env.app.aco.get(boss.user.id, runs(boss.user.id).at(-1).id), 'failed', 'stopped', 'stopped');
  await ash.post(`/api/items/${copy.id}/pool-hold`, { hold: false });

  // Ash's own Auto-checkout off: told, and nothing started on ash's account.
  await ash.put('/api/aco', { enabled: false });
  await boss.post(`/api/aco/test/${d.id}`, {});
  await settle();
  assert.equal(runs(ash.user.id).filter((r) => r.itemId === copy.id).length, 3);
  assert.ok((await events(ash)).some((e) => /boss started Auto-checkout on Booster Bundle, but yours is switched off/.test(e.message)));
  await env.app.aco.finish(boss.user.id, env.app.aco.get(boss.user.id, runs(boss.user.id).at(-1).id), 'failed', 'stopped', 'stopped');
  await ash.put('/api/aco', { enabled: true });

  // Ash's limits are ash's: over ash's most an item, skipped on ash's account (said why), boss's goes on.
  await boss.put(`/api/items/${d.id}`, { maxPrice: 500 });
  await ash.put('/api/pool/follow', { on: true, cap: 40 });
  assert.equal((await boss.post(`/api/aco/remote/${d.id}`, { price: 55 })).status, 200);
  await waitFor(() => runs(ash.user.id).filter((r) => r.itemId === copy.id).length === 4, { message: "ash's run for it" });
  run = runs(ash.user.id).filter((r) => r.itemId === copy.id).at(-1);
  assert.deepEqual([run.status, run.reason], ['skipped', 'over_max']);
  assert.match(run.message, /\$55\.00 is over your max of \$40\.00/);
  await env.app.aco.finish(boss.user.id, env.app.aco.get(boss.user.id, runs(boss.user.id).at(-1).id), 'failed', 'stopped', 'stopped');
  await ash.put('/api/pool/follow', { on: true, cap: 350 });
});

test("🤝 boss's drop watches show on the pool's members' Drop watches (boss's, as they are), and what they find is on the members' watchlists as boss's items are", async () => {
  const added = await boss.post('/api/drops', { store: 'kmart', words: 'charizard premium', shared: false });
  assert.equal(added.status, 200, added.text);
  const w = { body: added.body.watch };
  await settle();
  const seen = (await ash.get('/api/drops')).body.watches.find((x) => x.id === w.body.id);
  assert.ok(seen, "boss's own watch, on ash's Drop watches");
  assert.deepEqual([seen.pool, seen.mine, seen.canChange], ['boss', false, false]);
  assert.equal((await ash.get('/api/drops')).body.used, 0, "not counted as ash's");
  // (Someone not in the pool doesn't see it.)
  assert.equal((await brock.get('/api/drops')).body.watches.some((x) => x.id === w.body.id), false);
  // What it finds goes on boss's watchlist — and so on ash's.
  const found = env.app.repo.addItem(boss.user.id, { store: 'kmart', sku: '43818699', name: 'Charizard Premium Collection', url: KMART('43818699'), price: 90, maxPrice: 120, quantity: 1, profileId: null, monitor: true, announce: false, aco: true });
  env.app.db.run('UPDATE items SET drop_watch = :w WHERE id = :id', { w: w.body.id, id: found.id });
  env.app.db.run('UPDATE drop_watches SET found = :f WHERE id = :w', { f: JSON.stringify([{ itemId: found.id, sku: '43818699', at: Date.now(), arm: 'armed' }]), w: w.body.id });
  env.app.drops.changed();
  env.app.pools.sync(boss.user.id);
  const copy = await copyOf(ash, found.id);
  assert.deepEqual([copy.name, copy.aco, copy.maxPrice], ['Charizard Premium Collection', true, 120]);
  assert.equal(itemRow(copy.id).pool_watch, w.body.id);
  const view = (await ash.get('/api/drops')).body.watches.find((x) => x.id === w.body.id);
  assert.deepEqual(view.found.map((f) => [f.itemId, f.aco]), [[copy.id, true]], "its find, as ash's own copy");
  await boss.del(`/api/drops/${w.body.id}`);
  await settle();
  assert.equal((await ash.get('/api/drops')).body.watches.some((x) => x.id === w.body.id), false, 'removed: gone from theirs');
  assert.equal(await copyOf(ash, found.id), null, 'and its find');
});

test('🤝 leaving, being taken out, a pool closed: the leader\'s items go from the member\'s watchlist (their own stay); a pool\'s leader isn\'t in another; one checking out finishes first', async () => {
  // Misty leaves.
  assert.ok((await copies(misty)).length > 0);
  const left = await misty.post('/api/pool/leave');
  assert.equal(left.status, 200);
  assert.equal(left.body.pool, null);
  assert.deepEqual(await copies(misty), []);
  assert.ok((await events(boss)).some((e) => /misty left your pool/.test(e.message)));
  // Boss's changes don't reach misty any more.
  await boss.post('/api/items', { url: KMART('43818652'), name: 'Tin', maxPrice: 30 });
  await settle();
  assert.deepEqual(await copies(misty), []);

  // A pool's leader can't join another — nor lead one while in someone's.
  assert.equal((await brock.post(`/api/admin/pools/${(await brock.get('/api/admin/pools')).body.pools.find((p) => p.leader.username === 'brock').id}/members`, { username: 'boss' })).status, 400);

  // Ash taken out by an admin, with a run of ash's going: that copy stays till it's done, the rest go now.
  const a = (await items(boss)).find((it) => it.name === 'Day UPC');
  const copy = await copyOf(ash, a.id);
  await env.app.monitor.alertRestock(itemRow(a.id), { status: 'in_stock', price: 300, source: 'sweep' });
  const going = runs(ash.user.id).at(-1);
  assert.equal(going.itemId, copy.id);
  assert.equal(going.status, 'queued');
  const ownBefore = (await items(ash)).filter((it) => !it.pool).map((it) => it.id);
  const out = await boss.del(`/api/admin/pools/${pool.id}/members/${ash.user.id}`);
  assert.equal(out.status, 200);
  assert.deepEqual((await copies(ash)).map((it) => it.id), [copy.id], 'the one checking out stays till it\'s done');
  await env.app.aco.finish(ash.user.id, env.app.aco.get(ash.user.id, going.id), 'failed', 'stopped', 'stopped');
  env.app.pools.syncAll();
  assert.deepEqual(await copies(ash), []);
  assert.deepEqual((await items(ash)).map((it) => it.id), ownBefore, 'their own stay');
  // Boss's checkouts don't start ash's any more.
  const n = runs(ash.user.id).length;
  await boss.post(`/api/aco/test/${a.id}`, {});
  await settle();
  assert.equal(runs(ash.user.id).length, n);

  // Asked again, joined again, then the pool closed: gone again.
  await boss.post(`/api/admin/pools/${pool.id}/members`, { username: 'ash' });
  await ash.post(`/api/pool/${pool.id}/accept`);
  assert.ok((await copies(ash)).length > 0);
  assert.equal((await ash.get('/api/pool')).body.pool.followAco, false, 'joined again: checking out with boss is off again');
  assert.equal((await boss.del(`/api/admin/pools/${pool.id}`)).status, 200);
  assert.deepEqual(await copies(ash), []);
  assert.equal((await ash.get('/api/pool')).body.pool, null);
  assert.ok(env.app.repo.listAudit().some((a2) => a2.action === 'pool-close'));
});
