// Clear cart (server/bags.js): a member empties their bag at a store — or at every store, Clear all —
// from the dashboard, wherever they are; their checkout browser does it (the one Auto-checkout's runs go
// to, where those bags are), and says how each one went. The server never touches a store.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, makeMember, startApp } from './helpers.js';

let env;
let gary;
let laptop;
let desktop;

before(async () => {
  env = await startApp();
  gary = await Client.signup(env.url, 'gary');
  makeMember(env, gary);
});
after(async () => env.close());

const bags = async (c = gary) => (await c.get('/api/bags')).body;
const storeOf = async (id, c = gary) => (await bags(c)).stores.find((s) => s.id === id);
/** The extension says which version it is (it does, every time it asks for your items). */
const seenAs = (d, v) => d.call('GET', `/api/ext/me?v=${v}`);

test('each store Mugibot checks out at, with how its bag is — nothing yet; no browser connected: Clear cart says to connect one', async () => {
  const d = await bags();
  assert.equal(d.device, null);
  assert.equal(d.extensionVersion, '1.18.0');
  const ids = d.stores.map((s) => s.id);
  assert.ok(['kmart', 'bigw', 'target', 'ebgames', 'jbhifi', 'amazon', 'pbandai', 'pokemoncenter', 'thegamescube', 'citybeach'].every((x) => ids.includes(x)), ids.join());
  assert.ok(d.stores.every((s) => s.status === null && !s.active));
  const r = await gary.post('/api/bags/clear', { store: 'kmart' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /No browser with the Mugibot extension is connected yet/);
});

test('an extension too old to empty bags: Clear cart says to update it there (nothing is sent)', async () => {
  laptop = await Device.pair(env.url, gary, 'Gary laptop');
  await seenAs(laptop, '1.17.0');
  const r = await gary.post('/api/bags/clear', { store: 'kmart' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Clear cart needs the extension 1\.18\.0 or newer in Gary laptop \(it has 1\.17\.0\) — update it there/);
  assert.equal((await laptop.call('GET', '/api/ext/aco/next')).body.clears.length, 0);
});

test('Clear cart at one store: handed to the checkout browser alone, once — it says how it goes, and the dashboard keeps how it went', async () => {
  desktop = await Device.pair(env.url, gary, 'Gary desktop');
  await seenAs(desktop, '1.18.0');
  await seenAs(laptop, '1.18.0');
  // (The desktop's open: the checkout browser — the laptop, open too, is only its backup.)
  await desktop.call('GET', '/api/ext/aco/next');
  assert.equal((await gary.post('/api/bags/clear', { store: 'nowhere' })).status, 409, 'not a store Mugibot checks out at');
  const r = await gary.post('/api/bags/clear', { store: 'kmart' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.device.name, 'Gary desktop', 'the checkout browser: the newest connected');
  assert.deepEqual(r.body.jobs.map((j) => [j.id, j.status]), [['kmart', 'queued']]);
  assert.equal((await storeOf('kmart')).statusText, 'Waiting for your checkout browser');
  // The extension asks for its items: there's a bag to empty (so it listens, even with nothing armed).
  assert.equal((await desktop.call('GET', '/api/ext/items')).body.aco.clears, 1);
  assert.equal((await laptop.call('GET', '/api/ext/items')).body.aco.clears, 0, 'not the checkout browser');
  // Only the checkout browser gets it — at once, without waiting for runs.
  assert.equal((await laptop.call('GET', '/api/ext/aco/next')).body.clears.length, 0);
  const started = Date.now();
  const next = (await desktop.call('GET', '/api/ext/aco/next?wait=20')).body;
  assert.ok(Date.now() - started < 3000, 'answered straight away');
  assert.equal(next.clears.length, 1);
  const job = next.clears[0];
  assert.equal(job.store, 'kmart');
  assert.equal(job.storeName, 'Kmart');
  assert.equal(job.url, 'https://www.kmart.com.au/cart', "the store's bag page");
  assert.equal(next.clearing, 1, 'still to do: it keeps asking');
  assert.equal((await desktop.call('GET', '/api/ext/aco/next')).body.clears.length, 0, 'handed over once');
  // How it goes…
  assert.equal((await desktop.call('POST', `/api/ext/bags/${job.id}`, { status: 'clearing', removed: 1 })).status, 200);
  let k = await storeOf('kmart');
  assert.equal(k.active, true);
  assert.equal(k.statusText, 'Emptying the bag');
  assert.equal(k.removed, 1);
  // Someone else's browser can't say how it went.
  const misty = await Client.signup(env.url, 'misty');
  makeMember(env, misty);
  const hers = await Device.pair(env.url, misty, 'Misty browser');
  assert.equal((await hers.call('POST', `/api/ext/bags/${job.id}`, { status: 'cleared', removed: 9 })).status, 404);
  assert.equal((await desktop.call('POST', `/api/ext/bags/${job.id}`, { status: 'sold' })).status, 400);
  // …and how it ended.
  assert.equal((await desktop.call('POST', `/api/ext/bags/${job.id}`, { status: 'cleared', removed: 2 })).status, 200);
  k = await storeOf('kmart');
  assert.equal(k.active, false);
  assert.equal(k.status, 'cleared');
  assert.equal(k.removed, 2);
  assert.equal(k.message, '2 items removed');
  assert.equal(k.device, 'Gary desktop');
  assert.ok(k.at > 0);
  assert.equal((await desktop.call('POST', `/api/ext/bags/${job.id}`, { status: 'cleared' })).status, 404, 'done is done');
  assert.equal((await desktop.call('GET', '/api/ext/items')).body.aco.clears, 0);
  const events = env.app.repo.listEvents(gary.user.id).map((e) => e.message);
  assert.ok(events.some((m) => /🧹 Clear cart: your Kmart bag — emptied in Gary desktop/.test(m)), events.join('\n'));
  assert.ok(events.some((m) => /🧹 Emptied your Kmart bag — 2 items removed/.test(m)));
  // Misty's dashboard shows nothing of Gary's.
  assert.equal((await storeOf('kmart', misty)).status, null);
});

test('Clear all: every store, in the stores\' order — one already on its way isn\'t asked twice; each says how it went (empty, left alone, couldn\'t)', async () => {
  const all = (await bags()).stores;
  let r = await gary.post('/api/bags/clear', { store: 'target' });
  assert.equal(r.status, 200);
  r = await gary.post('/api/bags/clear', { stores: 'all' });
  assert.equal(r.status, 200);
  assert.equal(r.body.jobs.length, all.length);
  const next = (await desktop.call('GET', '/api/ext/aco/next')).body;
  assert.deepEqual(next.clears.map((j) => j.store), all.map((s) => s.id), 'each store once, in order');
  const byStore = Object.fromEntries(next.clears.map((j) => [j.store, j]));
  await desktop.call('POST', `/api/ext/bags/${byStore.kmart.id}`, { status: 'empty' });
  await desktop.call('POST', `/api/ext/bags/${byStore.target.id}`, { status: 'busy', message: 'Your checkout of ETB at Target is going in this browser — its bag was left alone.' });
  await desktop.call('POST', `/api/ext/bags/${byStore.bigw.id}`, { status: 'failed', removed: 1, message: "BIG W didn't take it out" });
  const d = await bags();
  const s = (id) => d.stores.find((x) => x.id === id);
  assert.equal(s('kmart').status, 'empty');
  assert.equal(s('kmart').statusText, 'Already empty');
  assert.equal(s('kmart').message, 'Nothing was in it');
  assert.equal(s('target').status, 'busy');
  assert.match(s('target').message, /left alone/);
  assert.equal(s('bigw').status, 'failed');
  assert.equal(s('bigw').removed, 1);
  assert.equal(s('ebgames').active, true, 'still to do');
  const events = env.app.repo.listEvents(gary.user.id).map((e) => e.message);
  assert.ok(events.some((m) => /Clear cart: your bags at \d+ stores/.test(m)));
  assert.ok(events.some((m) => /Couldn't empty your BIG W bag: BIG W didn't take it out/.test(m)));
  // The rest, done.
  for (const j of next.clears.filter((x) => !['kmart', 'target', 'bigw'].includes(x.store))) await desktop.call('POST', `/api/ext/bags/${j.id}`, { status: 'empty' });
  assert.ok((await bags()).stores.every((x) => !x.active));
});

test('a request the checkout browser never picks up lapses (it says why); one it went quiet on is handed over again, then given up on', async () => {
  const realNow = env.app.bags.now;
  let now = Date.now();
  env.app.bags.now = () => now;
  try {
    await gary.post('/api/bags/clear', { store: 'kmart' });
    now += 5 * 60 * 1000;
    let k = await storeOf('kmart');
    assert.equal(k.status, 'expired');
    assert.match(k.message, /Gary desktop didn't pick it up — is it open, with the extension connected\?/);

    await gary.post('/api/bags/clear', { store: 'kmart' });
    const first = (await desktop.call('GET', '/api/ext/aco/next')).body.clears[0];
    assert.ok(first);
    now += 70 * 1000; // quiet: handed over again (a request waiting its turn in the browser never looks lost)
    const again = (await desktop.call('GET', '/api/ext/aco/next')).body.clears[0];
    assert.equal(again && again.id, first.id, 'the same one again');
    now += 4 * 60 * 1000; // and nothing since
    k = await storeOf('kmart');
    assert.equal(k.status, 'failed');
    assert.match(k.message, /Lost touch with Gary desktop while it emptied the bag/);
  } finally {
    env.app.bags.now = realNow;
  }
});

test('only members, and only with the dashboard\'s own requests', async () => {
  const bob = await Client.signup(env.url, 'bob');
  await Device.pair(env.url, bob, 'Bob browser').catch(() => null);
  const r = await bob.post('/api/bags/clear', { store: 'kmart' });
  assert.equal(r.status, 402, 'no membership');
  // (A request from another website can't press it: the dashboard's header is missing.)
  const res = await fetch(`${env.url}/api/bags/clear`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: gary.cookie }, body: JSON.stringify({ store: 'kmart' }) });
  assert.ok([401, 403].includes(res.status), String(res.status));
});
