// 🤝 A pool's leader and their group (the members who check out with them) at the stores' gates, and the leader's own
// Discord buttons (server/pools.js, docs/POOLS.md):
//   - 🤝 Group Buy: the leader's ⚡ Buy, as their own DMs name it — it starts the group's checkouts with theirs.
//   - 🤝 Group Queue: on the leader's DM when a virtual queue goes up (and the channel's "📥 Join the queue" pressed by
//     the leader): each member's own checkout browser gets in line too — a tab of its own, its own place.
//   - 🤝 Group Checkpoint: on the leader's DM when a checkpoint goes up: the check page opened in the leader's and each
//     member's checkout browser, each told to solve it themselves (a human check: Mugibot never solves one).
//   - A checkpoint going up where a member is armed with the leader (or the leader arming there while it's up): its
//     check page opened for them, ahead of the drop, with a DM of its own.
// Only the leader has the 🤝 buttons (they're on the leader's own DMs); anyone else pressing one is told it's theirs.
// The member's real browser opening these is tested in extension.e2e.test.js.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, discordOpts, interactionKeys, makeMember, startApp, startFakeDiscord, waitFor } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';

let env;
let store;
let discord;
let keys;
let boss; // an admin: leads the pool
let ash; // joins, and checks out with boss (the group)
let misty; // joins, but doesn't check out with boss
let brock; // not in the pool
let bossBrowser;
let ashBrowser;
let mistyBrowser;
let brockBrowser;
let pool;

async function connect(c, discordId) {
  discord.state.users[discordId] = discord.state.users[discordId] || { id: discordId, username: discordId };
  discord.state.nextUser = discordId;
  const start = await c.get('/auth/discord');
  const consent = await fetch(new URL(start.headers.get('location')), { redirect: 'manual' });
  const cb = new URL(consent.headers.get('location'));
  await c.get(cb.pathname + cb.search);
}

let presses = 0;
async function press(discordId, customId) {
  presses += 1;
  const body = JSON.stringify({ type: 3, id: `i-${presses}`, token: `tok-g${presses}`, user: { id: discordId }, data: { custom_id: customId, component_type: 2 } });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${env.url}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': keys.sign(ts, body), 'x-signature-timestamp': ts }, body });
  const out = await res.json().catch(() => null);
  return { status: res.status, content: out && out.data && out.data.content };
}

/** The buttons on a DM: [label, custom_id or url]. */
const buttonsOf = (m) => ((m.body.components || [])[0] || { components: [] }).components.map((b) => [b.label, b.custom_id || b.url]);
const dmsTitled = (id, re) => discord.dmsTo(id).filter((m) => re.test(m.body.embeds[0].title));
const lobbies = async (device) => (await device.call('GET', '/api/ext/aco/next')).body.lobbies;
const EB = () => env.app.retailers.get('demo-ebgames');
const JB = () => env.app.retailers.get('demo-jbhifi');
const JB_ETB = 'pokemon-tcg-30th-celebration-etb';

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  keys = interactionKeys();
  env = await startApp({ demoStoreUrl: store.url, allowPrivateHosts: true, hostGapSeconds: 0, adminUsernames: 'boss', ...discordOpts(discord), discordPublicKey: keys.publicKey });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  misty = await Client.signup(env.url, 'misty');
  brock = await Client.signup(env.url, 'brock');
  for (const [c, d] of [[boss, 'd-boss'], [ash, 'd-ash'], [misty, 'd-misty'], [brock, 'd-brock']]) {
    makeMember(env, c);
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
    await connect(c, d);
    assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', remoteBuy: true, maxOrder: 2000, perDay: 20, spendPerDay: 20000 })).status, 200);
  }
  bossBrowser = await Device.pair(env.url, boss, 'Boss PC');
  ashBrowser = await Device.pair(env.url, ash, 'Ash desktop');
  mistyBrowser = await Device.pair(env.url, misty, 'Misty laptop');
  brockBrowser = await Device.pair(env.url, brock, 'Brock PC');
  pool = (await boss.post('/api/admin/pools', { name: 'Boss crew' })).body.pool;
  for (const who of ['ash', 'misty']) assert.equal((await boss.post(`/api/admin/pools/${pool.id}/members`, { username: who })).status, 200);
  for (const c of [ash, misty]) assert.equal((await c.post(`/api/pool/${pool.id}/accept`)).status, 200);
  // Brock watches something at the dummy JB Hi-Fi and EB Games (the usual DMs when their gates go up).
  for (const url of [store.productUrl('ebgames', '312345'), store.productUrl('jbhifi', JB_ETB)]) assert.equal((await brock.post('/api/items', { url, maxPrice: 300 })).status, 200);
});

after(async () => {
  env.app.gates.stop();
  await env.app.gates.settled();
  await env.close();
  await store.close();
  await discord.close();
});

beforeEach(async () => {
  await env.app.gates.settled();
  store.reset();
  // (Every gate down to start with — and so every browser's lobby gone — whatever the test before left.)
  for (const r of [EB(), JB()]) if (env.app.gates.get(r.id).status === 'up') env.app.gates.flip(r, 'down', { source: r.id === 'demo-jbhifi' ? 'server' : 'probe' });
  await env.app.gates.settled();
});

/** Ends every run still going (nobody's browser checks out here). */
async function endRuns() {
  for (const r of env.app.db.all("SELECT id, user_id FROM aco_runs WHERE status IN ('queued', 'sent', 'started', 'waiting', 'checkout')")) {
    await env.app.aco.finish(r.user_id, env.app.aco.get(r.user_id, r.id), 'failed', 'stopped', 'stopped');
  }
}

test('🤝 Group Buy: the ⚡ Buy on a pool leader\'s own DMs reads "🤝 Group Buy" once someone checks out with them — and pressing it starts their checkouts too; members\' DMs say ⚡ Buy', async () => {
  const d = (await boss.post('/api/items', { url: store.productUrl('kmart', '43818648'), name: 'Day UPC', maxPrice: 380 })).body;
  const row = (id) => env.app.db.get('SELECT * FROM items WHERE id = :id', { id });
  // Nobody checks out with boss yet: ⚡ Buy.
  assert.equal(env.app.pools.leadsGroup(boss.user.id), false);
  await env.app.notifier.itemAlert(boss.user.id, row(d.id), 'restock', { status: 'in_stock', price: 360 });
  let dm = discord.dmsTo('d-boss').at(-1);
  assert.deepEqual(buttonsOf(dm)[0], ['⚡ Buy', `buy:i:${d.id}`]);
  assert.match(dm.body.embeds[0].description, /Press ⚡ Buy to go straight to checkout\./);

  // Ash switches on checking out with boss: boss's DMs say 🤝 Group Buy (the same button: boss's ⚡ Buy).
  assert.equal((await ash.put('/api/pool/follow', { on: true, agree: true, cap: 500 })).status, 200);
  assert.equal(env.app.pools.leadsGroup(boss.user.id), true);
  assert.equal(env.app.pools.leadsGroup(ash.user.id), false, 'a member leads nothing');
  await env.app.notifier.itemAlert(boss.user.id, row(d.id), 'restock', { status: 'in_stock', price: 360 });
  dm = discord.dmsTo('d-boss').at(-1);
  assert.deepEqual(buttonsOf(dm)[0], ['🤝 Group Buy', `buy:i:${d.id}`]);
  assert.match(dm.body.embeds[0].description, /Press 🤝 Group Buy: your checkout starts, and so do those of your pool's members who check out with you/);
  // Ash's own DM for the same item (his copy): ⚡ Buy.
  await waitFor(() => env.app.db.get('SELECT id FROM items WHERE user_id = :u AND pool_src = :s', { u: ash.user.id, s: d.id }), { message: "ash's copy" });
  const copy = env.app.db.get('SELECT * FROM items WHERE user_id = :u AND pool_src = :s', { u: ash.user.id, s: d.id });
  await env.app.notifier.itemAlert(ash.user.id, copy, 'restock', { status: 'in_stock', price: 360 });
  assert.deepEqual(buttonsOf(discord.dmsTo('d-ash').at(-1))[0], ['⚡ Buy', `buy:i:${copy.id}`]);

  // Boss presses it: boss's checkout, and ash's — the reply says so.
  const res = await press('d-boss', `buy:i:${d.id}`);
  assert.match(res.content, /Boss PC/);
  assert.match(res.content, /🤝 \*\*Group Buy\*\*: the 1 member of your pool who check out with you starts theirs too — each in their own checkout browser, with their own card and within their own limits\./);
  await waitFor(() => env.app.db.get("SELECT 1 AS y FROM aco_runs WHERE user_id = :u AND item_id = :i AND trigger = 'pool'", { u: ash.user.id, i: copy.id }), { message: "ash's run" });
  assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM aco_runs WHERE user_id = :u AND trigger = 'pool'", { u: misty.user.id }).n, 0, "misty doesn't check out with boss");
  // Ash pressing his own ⚡ Buy: just his (no group line).
  await endRuns();
  const own = await press('d-ash', `buy:i:${copy.id}`);
  assert.doesNotMatch(own.content, /Group Buy/);
  await endRuns();
  await boss.del(`/api/items/${d.id}`);
});

test('🤝 Group Queue: a queue going up DMs boss with a 🤝 Group Queue button (only boss: members\' DMs have none); pressed, boss\'s and ash\'s checkout browsers get in line — misty\'s (not checking out with boss) and brock\'s don\'t; ash is DM\'d once', async () => {
  const g = env.app.gates;
  g.flip(EB(), 'up', { source: 'probe', wait: 20 });
  await g.settled();
  // Boss (watching nothing there) hears it — with the button. Brock (watching there): the usual DM, no 🤝.
  const bossDm = dmsTitled('d-boss', /EB Games \(dummy store\)'s virtual queue is up/).at(-1);
  assert.ok(bossDm, "boss's DM");
  assert.deepEqual(buttonsOf(bossDm), [['🤝 Group Queue', 'gq:demo-ebgames'], ['Open EB Games (dummy store)', `${store.url}/ebgames/`]]);
  assert.match(bossDm.body.embeds[0].description, /🤝 \*\*Group Queue\*\* puts your checkout browser in line, and the checkout browsers of the 1 member of your pool who check out with you/);
  const brockDm = dmsTitled('d-brock', /virtual queue is up/).at(-1);
  assert.ok(brockDm);
  assert.ok(!buttonsOf(brockDm).some(([l]) => /🤝/.test(l)), 'no 🤝 button for anyone else');
  assert.equal(dmsTitled('d-ash', /virtual queue is up/).length, 0, "ash isn't watching anything there");

  // Anyone else pressing it: told it's the leader's — nothing happens.
  for (const who of ['d-ash', 'd-misty', 'd-brock']) {
    const r = await press(who, 'gq:demo-ebgames');
    assert.match(r.content, /That button is for a pool's leader/);
  }
  assert.deepEqual(await lobbies(ashBrowser), []);

  // Boss presses it.
  const res = await press('d-boss', 'gq:demo-ebgames');
  assert.match(res.content, /🚦 \*\*Boss PC\*\* is getting in line at EB Games \(dummy store\)/);
  assert.match(res.content, /🤝 \*\*Group Queue\*\*: the member of your pool who check out with you is getting in line too — each a tab of its own in their own checkout browser, their own place in line\./);
  assert.deepEqual((await lobbies(bossBrowser)).map((l) => [l.store, l.kind, l.url, l.by]), [['demo-ebgames', 'queue', `${store.url}/ebgames/`, 'discord']]);
  assert.deepEqual((await lobbies(ashBrowser)).map((l) => [l.store, l.kind, l.url, l.by]), [['demo-ebgames', 'queue', `${store.url}/ebgames/`, 'pool']]);
  assert.deepEqual(await lobbies(mistyBrowser), [], "misty doesn't check out with boss");
  assert.deepEqual(await lobbies(brockBrowser), []);
  await waitFor(() => dmsTitled('d-ash', /Getting in line at EB Games \(dummy store\) with boss/).length === 1, { message: "ash's DM" });
  const ashDm = dmsTitled('d-ash', /Getting in line at EB Games/)[0];
  assert.match(ashDm.body.embeds[0].description, /boss got in line at EB Games \(dummy store\)'s virtual queue, and you check out with them \(your pool\): your checkout browser \(Ash desktop\) is getting in line too — a tab of its own, waiting its turn\.\nLeave that tab alone/);

  // Pressed again (or the channel's "📥 Join the queue" by boss): nothing doubled — no second tab, no second DM.
  await press('d-boss', 'gq:demo-ebgames');
  await press('d-boss', 'queue:demo-ebgames');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await lobbies(ashBrowser), [], 'handed over once');
  assert.equal(dmsTitled('d-ash', /Getting in line at EB Games/).length, 1, 'told once');
  g.flip(EB(), 'down', { source: 'probe' });
  await g.settled();
});

test('📥 the channel\'s "Join the queue" pressed by boss starts the group too; by a member, just their own browser; a member with Auto-checkout off (or no checkout browser) isn\'t put in line, and is told — boss\'s reply says how many', async () => {
  const g = env.app.gates;
  g.flip(EB(), 'up', { source: 'probe', wait: 5 });
  // A member pressing it: theirs alone.
  let res = await press('d-misty', 'queue:demo-ebgames');
  assert.match(res.content, /\*\*Misty laptop\*\* is getting in line/);
  assert.doesNotMatch(res.content, /Group Queue/);
  assert.deepEqual((await lobbies(mistyBrowser)).map((l) => l.by), ['discord']);
  assert.deepEqual(await lobbies(ashBrowser), []);

  // Ash's Auto-checkout off: boss's press doesn't put him in line; he's told why.
  assert.equal((await ash.put('/api/aco', { enabled: false })).status, 200);
  res = await press('d-boss', 'queue:demo-ebgames');
  assert.match(res.content, /🤝 \*\*Group Queue\*\*: none of the member of your pool who check out with you could — their Auto-checkout is off, or no checkout browser is connected to their account \(they're told\)\./);
  assert.deepEqual(await lobbies(ashBrowser), []);
  assert.ok((await ash.get('/api/events')).body.events.some((e) => /boss got in line at EB Games \(dummy store\)'s virtual queue, but your Auto-checkout is switched off — nothing opened on yours/.test(e.message)));
  assert.equal((await ash.put('/api/aco', { enabled: true })).status, 200);

  // Back on: boss's next press puts him in line.
  res = await press('d-boss', 'queue:demo-ebgames');
  assert.match(res.content, /the member of your pool who check out with you is getting in line too/);
  assert.deepEqual((await lobbies(ashBrowser)).map((l) => [l.store, l.by]), [['demo-ebgames', 'pool']]);

  // Boss with no checkout browser connected: his own can't, the group's still do.
  g.flip(EB(), 'down', { source: 'probe' });
  g.flip(EB(), 'up', { source: 'probe', wait: 5 });
  const devices = env.app.repo.listDevices(boss.user.id);
  env.app.db.run('UPDATE devices SET user_id = :x WHERE user_id = :u', { x: brock.user.id, u: boss.user.id });
  try {
    res = await press('d-boss', 'queue:demo-ebgames');
    assert.match(res.content, /⚠️ No browser with the Mugibot extension is connected yet/);
    assert.match(res.content, /🤝 \*\*Group Queue\*\*: the member of your pool who check out with you is getting in line too/);
    assert.deepEqual((await lobbies(ashBrowser)).map((l) => [l.store, l.by]), [['demo-ebgames', 'pool']]);
  } finally {
    for (const dv of devices) env.app.db.run('UPDATE devices SET user_id = :u WHERE id = :id', { u: boss.user.id, id: dv.id });
  }
  g.flip(EB(), 'down', { source: 'probe' });
  await g.settled();
});

test('🛡️ a checkpoint going up where ash is armed with boss: its check page opened in ash\'s checkout browser, ahead of the drop, and a DM of its own (not the usual one too); boss\'s DM has 🤝 Group Checkpoint; misty, not checking out with boss, gets nothing of it', async () => {
  const g = env.app.gates;
  const jb = (await boss.post('/api/items', { url: store.productUrl('jbhifi', JB_ETB), name: 'JB ETB', maxPrice: 120 })).body;
  assert.equal((await boss.put(`/api/items/${jb.id}`, { aco: true, maxPrice: 120 })).status, 200);
  await waitFor(() => env.app.db.get('SELECT aco FROM items WHERE user_id = :u AND pool_src = :s', { u: ash.user.id, s: jb.id })?.aco === 1, { message: "armed on ash's" });
  assert.equal(env.app.db.get('SELECT aco FROM items WHERE user_id = :u AND pool_src = :s', { u: misty.user.id, s: jb.id }).aco, 0, "not on misty's");

  g.flip(JB(), 'up', { source: 'server' });
  await g.settled();
  assert.deepEqual((await lobbies(ashBrowser)).map((l) => [l.store, l.kind, l.url, l.by]), [['demo-jbhifi', 'checkpoint', `${store.url}/jbhifi/checkpoint`, 'pool']]);
  assert.deepEqual(await lobbies(mistyBrowser), []);
  await waitFor(() => dmsTitled('d-ash', /Solve JB Hi-Fi \(dummy store\)'s check now — before the drop/).length === 1, { message: "ash's DM" });
  const ashDm = dmsTitled('d-ash', /Solve JB Hi-Fi/)[0];
  assert.match(ashDm.body.embeds[0].description, /JB Hi-Fi \(dummy store\)'s checkpoint is up: boss has something armed there, and you check out with them \(your pool\)\.\nYour checkout browser \(Ash desktop\) has opened JB Hi-Fi \(dummy store\)'s check page in a tab — solve the human check there now/);
  assert.deepEqual(buttonsOf(ashDm).map(([l]) => l), ['🖥️ Open my computer', 'Auto-checkout']);
  assert.equal(dmsTitled('d-ash', /JB Hi-Fi \(dummy store\)'s checkpoint is up/).length, 0, 'not the usual DM as well');
  // Boss: the usual words, and 🤝 Group Checkpoint.
  const bossDm = dmsTitled('d-boss', /JB Hi-Fi \(dummy store\)'s checkpoint is up/).at(-1);
  assert.deepEqual(buttonsOf(bossDm), [['🤝 Group Checkpoint', 'gc:demo-jbhifi'], ['Open JB Hi-Fi (dummy store)', `${store.url}/jbhifi/checkpoint`]]);
  // Brock (watching JB): the usual DM, no 🤝.
  assert.ok(!buttonsOf(dmsTitled('d-brock', /JB Hi-Fi \(dummy store\)'s checkpoint is up/).at(-1)).some(([l]) => /🤝/.test(l)));

  // 🤝 Group Checkpoint: boss's own browser too; ash told once already (this time it's up), so no second DM.
  assert.match((await press('d-ash', 'gc:demo-jbhifi')).content, /That button is for a pool's leader/);
  const res = await press('d-boss', 'gc:demo-jbhifi');
  assert.match(res.content, /🛡️ \*\*Boss PC\*\* is opening JB Hi-Fi \(dummy store\)'s check page in a tab: solve it there/);
  assert.match(res.content, /🤝 \*\*Group Checkpoint\*\*: the member of your pool who check out with you has it opened in their checkout browser too, and told to solve it there before the drop — a human check: each solves their own\./);
  assert.deepEqual((await lobbies(bossBrowser)).map((l) => [l.store, l.kind, l.url]), [['demo-jbhifi', 'checkpoint', `${store.url}/jbhifi/checkpoint`]]);
  assert.equal(dmsTitled('d-ash', /Solve JB Hi-Fi/).length, 1);

  // Down: the lobbies go; up again later — opened, and told, again.
  g.flip(JB(), 'down', { source: 'server' });
  await g.settled();
  assert.deepEqual(await lobbies(ashBrowser), []);
  g.flip(JB(), 'up', { source: 'server' });
  await g.settled();
  assert.deepEqual((await lobbies(ashBrowser)).map((l) => l.kind), ['checkpoint']);
  await waitFor(() => dmsTitled('d-ash', /Solve JB Hi-Fi/).length === 2, { message: 'told again' });

  // Ash skips boss's JB item: the next time it's up, nothing opened for him (he's told the usual way, watching it).
  g.flip(JB(), 'down', { source: 'server' });
  const copy = env.app.db.get('SELECT id FROM items WHERE user_id = :u AND pool_src = :s', { u: ash.user.id, s: jb.id });
  await ash.post(`/api/items/${copy.id}/pool-hold`, { hold: true });
  g.flip(JB(), 'up', { source: 'server' });
  await g.settled();
  assert.deepEqual(await lobbies(ashBrowser), []);
  assert.equal(dmsTitled('d-ash', /Solve JB Hi-Fi/).length, 2);
  await waitFor(() => dmsTitled('d-ash', /JB Hi-Fi \(dummy store\)'s checkpoint is up/).length === 1, { message: 'the usual DM' });
  await ash.post(`/api/items/${copy.id}/pool-hold`, { hold: false });
  g.flip(JB(), 'down', { source: 'server' });
  await g.settled();
  await boss.del(`/api/items/${jb.id}`);
});

test('🛡️ boss arming something at JB while its checkpoint is up: ash\'s check page opened then (and told), once', async () => {
  const g = env.app.gates;
  g.flip(JB(), 'up', { source: 'server' });
  await g.settled();
  assert.deepEqual(await lobbies(ashBrowser), [], 'nothing armed there yet');
  const before = dmsTitled('d-ash', /Solve JB Hi-Fi/).length;
  const jb = (await boss.post('/api/items', { url: store.productUrl('jbhifi', JB_ETB), name: 'JB ETB 2', maxPrice: 120 })).body;
  assert.equal((await boss.put(`/api/items/${jb.id}`, { aco: true, maxPrice: 120 })).status, 200);
  await waitFor(async () => (await lobbies(ashBrowser)).some((l) => l.store === 'demo-jbhifi' && l.kind === 'checkpoint'), { message: 'opened for ash' });
  await waitFor(() => dmsTitled('d-ash', /Solve JB Hi-Fi/).length === before + 1, { message: 'told' });
  // Synced again (every half minute): not again.
  env.app.pools.syncAll();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(dmsTitled('d-ash', /Solve JB Hi-Fi/).length, before + 1);
  g.flip(JB(), 'down', { source: 'server' });
  await g.settled();
  await boss.del(`/api/items/${jb.id}`);
});

test('🤝 Group Checkpoint while the checkpoint is down, at a store without one, or by a member: refused, nothing opened; ash checking out with boss switched off: boss has no group — no 🤝 buttons', async () => {
  assert.match((await press('d-boss', 'gc:demo-jbhifi')).content, /JB Hi-Fi \(dummy store\)'s checkpoint isn't up right now — nothing to solve/);
  assert.match((await press('d-boss', 'gc:demo-ebgames')).content, /That store doesn't have a checkpoint Mugibot knows/);
  assert.match((await press('d-nobody', 'gc:demo-jbhifi')).content, /isn't connected to a Mugibot account/);
  assert.deepEqual(await lobbies(bossBrowser), []);

  assert.equal((await ash.put('/api/pool/follow', { on: false })).status, 200);
  assert.equal(env.app.pools.leadsGroup(boss.user.id), false);
  assert.match((await press('d-boss', 'gq:demo-ebgames')).content, /That button is for a pool's leader/);
  const g = env.app.gates;
  const before = dmsTitled('d-boss', /EB Games \(dummy store\)'s virtual queue is up/).length;
  g.flip(EB(), 'up', { source: 'probe', wait: 5 });
  await g.settled();
  // (Boss watches nothing at EB Games, and leads no group now: not told at all.)
  assert.equal(dmsTitled('d-boss', /EB Games \(dummy store\)'s virtual queue is up/).length, before, 'no DM: no group to start, nothing watched there');
  g.flip(EB(), 'down', { source: 'probe' });
  await g.settled();
  assert.equal((await ash.put('/api/pool/follow', { on: true, cap: 500 })).status, 200);
});

test("🤝 Group Buy from the phone while boss's own computer can't check out (no checkout browser connected, or Discord's ⚡ Buy switched off for it): boss is told why — and the group's checkouts start all the same", async () => {
  const d = (await boss.post('/api/items', { url: store.productUrl('kmart', '43818587'), name: 'Phone Group Buy', maxPrice: 200 })).body;
  await waitFor(() => env.app.db.get('SELECT id FROM items WHERE user_id = :u AND pool_src = :s', { u: ash.user.id, s: d.id }), { message: "ash's copy" });
  const copy = env.app.db.get('SELECT id FROM items WHERE user_id = :u AND pool_src = :s', { u: ash.user.id, s: d.id });
  const ashRuns = () => env.app.db.get("SELECT COUNT(*) AS n FROM aco_runs WHERE user_id = :u AND item_id = :i AND trigger = 'pool'", { u: ash.user.id, i: copy.id }).n;
  // No checkout browser of boss's connected.
  const devices = env.app.repo.listDevices(boss.user.id);
  env.app.db.run('UPDATE devices SET user_id = :x WHERE user_id = :u', { x: brock.user.id, u: boss.user.id });
  try {
    const res = await press('d-boss', `buy:i:${d.id}`);
    assert.match(res.content, /⚠️ No browser with the Mugibot extension is connected yet/);
    assert.match(res.content, /🤝 \*\*Group Buy\*\*: the 1 member of your pool who check out with you starts theirs all the same/);
    await waitFor(() => ashRuns() === 1, { message: "ash's run" });
  } finally {
    for (const dv of devices) env.app.db.run('UPDATE devices SET user_id = :u WHERE id = :id', { u: boss.user.id, id: dv.id });
  }
  await endRuns();
  // Discord's ⚡ Buy switched off for boss's computer: the same.
  assert.equal((await boss.put('/api/aco', { remoteBuy: false })).status, 200);
  const res = await press('d-boss', `buy:i:${d.id}`);
  assert.match(res.content, /⚡ Buy from Discord on your computer is switched off/);
  assert.match(res.content, /starts theirs all the same/);
  await waitFor(() => ashRuns() === 2, { message: "ash's second run" });
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM aco_runs WHERE user_id = :u AND item_id = :i', { u: boss.user.id, i: d.id }).n, 0, "nothing on boss's own (it couldn't)");
  assert.equal((await boss.put('/api/aco', { remoteBuy: true })).status, 200);
  // A member pressing their own ⚡ Buy with nothing connected: just told (no group).
  await endRuns();
  await boss.del(`/api/items/${d.id}`);
});
