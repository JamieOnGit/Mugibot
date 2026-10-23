// Auto-checkout (server/aco.js): the switch and its agreement, arming an item, what a drop starts
// (or why it doesn't), the browser's side (picking a run up, claiming it, saying how it went), one
// purchase per arming, the day's limits, runs that go stale — and that every member's runs are
// theirs alone. The browser itself is tested against the dummy stores in extension.e2e.test.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, makeMember, startApp, waitFor } from './helpers.js';
import { toRun } from '../server/aco.js';

let env;
let ash;
let misty;
let aco;
let ashItems;
let ashBrowser;
before(async () => {
  env = await startApp();
  aco = env.app.aco;
  ash = await Client.signup(env.url, 'ash');
  misty = await Client.signup(env.url, 'misty');
  makeMember(env, ash);
  makeMember(env, misty);
  ashItems = (await ash.get('/api/items')).body.items;
});
after(async () => { await env.close(); });

const itemRow = (id) => env.app.db.get('SELECT * FROM items WHERE id = :id', { id });
const runs = (itemId) => env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i ORDER BY rowid', { i: itemId }).map(toRun);
const lastRun = (itemId) => runs(itemId).at(-1);
// An armed item comes in stock, as the monitor sees it (a sweep, a page check…).
const drop = (itemId, price) => env.app.monitor.alertRestock(itemRow(itemId), { status: 'in_stock', price, source: 'sweep' });
const arm = async (it, maxPrice) => {
  const r = await ash.put(`/api/items/${it.id}`, { aco: true, maxPrice });
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const events = async (c) => (await c.get('/api/events')).body.events;
const codeOf = (url) => new URL(url).hash.replace('#mgb-go=', '');
// The browser's side of a run: picks it up, opens the store with its ⚡ Buy code.
async function pickUp(device = ashBrowser) {
  const next = await device.call('GET', '/api/ext/aco/next');
  assert.equal(next.status, 200);
  assert.equal(next.body.runs.length, 1, 'one run to start');
  const [run] = next.body.runs;
  const claim = await device.call('POST', '/api/ext/claim', { code: codeOf(run.url) });
  assert.equal(claim.status, 200);
  return { run, claim: claim.body };
}
const report = (id, body, device = ashBrowser) => device.call('POST', `/api/ext/aco/${id}`, body);

test('switching Auto-checkout on needs the agreement; the limits are kept within bounds', async () => {
  const first = (await ash.get('/api/aco')).body;
  assert.equal(first.settings.enabled, false, 'off until the member switches it on');
  assert.deepEqual(first.runs, []);
  assert.equal(first.armed, 0);
  const refused = await ash.put('/api/aco', { enabled: true });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /agree/i);
  assert.equal((await ash.get('/api/aco')).body.settings.enabled, false);

  const on = await ash.put('/api/aco', { enabled: true, agree: true, mode: 'something else', maxOrder: 400, perDay: 99, spendPerDay: 800 });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.body.settings.enabled, true);
  assert.equal(on.body.settings.mode, 'place', 'an unknown mode places orders, the default');
  assert.equal(on.body.settings.perDay, 10, 'at most 10 orders a day');
  assert.equal(typeof on.body.settings.agreedAt, 'number');
  assert.ok((await events(ash)).some((e) => e.type === 'aco' && /Auto-checkout switched on/.test(e.message)));

  // Agreed once: off and on again doesn't ask again.
  await ash.put('/api/aco', { enabled: false });
  const again = await ash.put('/api/aco', { enabled: true, perDay: 2 });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.settings.agreedAt, on.body.settings.agreedAt);
  assert.equal((await misty.get('/api/aco')).body.settings.enabled, false, "Misty's switch is her own");
});

test('arming an item needs a max price, at a store Mugibot can check out at', async () => {
  const noMax = await ash.put(`/api/items/${ashItems[0].id}`, { aco: true });
  assert.equal(noMax.status, 400);
  assert.match(noMax.body.error, /max price/i);
  const other = await ash.post('/api/items', { url: 'https://shop.example.com/products/booster-box-123', name: 'Somewhere else', maxPrice: 100, aco: true });
  assert.equal(other.status, 400);
  assert.match(other.body.error, /checkout for/i);

  const it = await arm(ashItems[0], 380);
  assert.equal(it.aco, true);
  assert.equal(typeof it.acoAt, 'number');
  assert.equal((await ash.get('/api/aco')).body.armed, 1);
  // The extension hears it's armed (and starts listening).
  ashBrowser = await Device.pair(env.url, ash, 'Ash laptop');
  const ext = (await ashBrowser.call('GET', '/api/ext/items')).body;
  // (listen: it's the checkout browser, the only one connected — Discord's ⚡ Buy may start a run here any time.)
  assert.deepEqual(ext.aco, { enabled: true, armed: 1, pending: 0, listen: true, going: 0, scheduled: 0, clears: 0 });
  assert.equal(ext.items.find((x) => x.id === it.id).aco, true);
});

test('with no browser connected, a drop is kept as "didn\'t start" with why, and the item stays armed', async () => {
  const lone = await Client.signup(env.url, 'brock');
  makeMember(env, lone);
  await lone.put('/api/aco', { enabled: true, agree: true });
  const [first] = (await lone.get('/api/items')).body.items;
  await lone.put(`/api/items/${first.id}`, { aco: true, maxPrice: 380 });
  await drop(first.id, 360);
  const run = lastRun(first.id);
  assert.equal(run.status, 'skipped');
  assert.equal(run.reason, 'no_browser');
  assert.match(run.reasonText, /No browser/);
  assert.equal(itemRow(first.id).aco, 1, 'still armed for the next drop');
  assert.ok((await events(lone)).some((e) => e.type === 'aco' && /didn't start/.test(e.message)));
  const page = (await lone.get('/api/aco')).body;
  assert.equal(page.runs[0].id, run.id);
  assert.equal(page.stats.skipped, 1);
});

test('a drop starts a run: the browser picks it up, checks out and places the order — once', async () => {
  const item = ashItems[0];
  await drop(item.id, 360);
  const queued = lastRun(item.id);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.trigger, 'sweep');
  assert.ok((await events(ash)).some((e) => /Auto-checkout started: Day UPC/.test(e.message)));

  const { run, claim } = await pickUp();
  assert.equal(run.id, queued.id);
  assert.match(run.url, /^https:\/\/www\.kmart\.com\.au\/product\/.+#mgb-go=/, "the store's own page, with a one-time ⚡ Buy code");
  assert.equal(run.mode, 'place');
  // What this checkout may do by itself: the item's max plus delivery, never over the member's limit.
  // (orderLimit: the most with other things already in the bag — the limit an order, within the day's spending.
  //  url: the link, opened again if the store asks it to wait and try again — Shopify's "Too many checkout attempts".)
  assert.deepEqual(claim.aco, { runId: run.id, mode: 'place', maxPrice: 380, maxTotal: 400, orderLimit: 400, name: 'Day UPC', sku: item.sku, url: item.url });
  assert.equal(lastRun(item.id).status, 'started');

  assert.equal((await report(run.id, { status: 'checkout', message: "At Kmart's checkout" })).status, 200);
  assert.equal(itemRow(item.id).aco, 1, 'still armed until the final button');
  await report(run.id, { status: 'placing', total: 370.5, message: 'Pressing "Place order"' });
  assert.equal(itemRow(item.id).aco, 0, 'the final button is pressed: this arming is used up');
  const placed = (await report(run.id, { status: 'placed', message: 'Order confirmed at Kmart' })).body.run;
  assert.equal(placed.status, 'placed');
  assert.equal(placed.total, 370.5);
  assert.deepEqual(placed.steps.map((s) => s.status), ['queued', 'sent', 'started', 'checkout', 'placing', 'placed']);
  assert.ok((await events(ash)).some((e) => /placed your order: Day UPC/.test(e.message)));

  // Done is done: a late report changes nothing.
  assert.equal((await report(run.id, { status: 'failed', reason: 'sold_out' })).body.run.status, 'placed');
  // It drops again: not armed, so nothing is bought until the member arms it again.
  await drop(item.id, 360);
  assert.equal(runs(item.id).length, 1, 'no second purchase');
  const page = (await ash.get('/api/aco')).body;
  assert.deepEqual(page.today, { orders: 1, spent: 370.5 });
  assert.equal(page.stats.placed, 1);
  assert.equal(page.stats.spent, 370.5);
  assert.equal(page.armed, 0);
});

test('a browser waiting for a run gets it the moment an armed item drops', async () => {
  const item = await arm(ashItems[0], 380);
  const t0 = Date.now();
  const waiting = ashBrowser.call('GET', '/api/ext/aco/next?wait=10');
  await waitFor(() => aco.waiters.has(ash.user.id), { message: 'the browser to be waiting' });
  await drop(item.id, 360);
  const got = await waiting;
  assert.equal(got.status, 200);
  assert.equal(got.body.runs.length, 1);
  assert.ok(Date.now() - t0 < 5000, 'answered straight away, not at the end of the wait');
  await ashBrowser.call('POST', '/api/ext/claim', { code: codeOf(got.body.runs[0].url) });
  const failed = (await report(got.body.runs[0].id, { status: 'failed', reason: 'sold_out' })).body.run;
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /Sold out/);
  assert.equal(itemRow(item.id).aco, 1, 'failed before the final button: still armed');
  // Nothing to start: an empty answer, straight away without a wait.
  assert.deepEqual((await ashBrowser.call('GET', '/api/ext/aco/next')).body.runs, []);
});

test('failing three times in a day stops it trying until it is armed again', async () => {
  const item = ashItems[0];
  for (const reason of ['not_added', 'no_checkout']) {
    await drop(item.id, 360);
    const { run } = await pickUp();
    await report(run.id, { status: 'failed', reason });
  }
  assert.equal(itemRow(item.id).aco, 1);
  await drop(item.id, 360);
  const run = lastRun(item.id);
  assert.equal(run.status, 'skipped');
  assert.equal(run.reason, 'too_many_failures');
  assert.equal(itemRow(item.id).aco, 0);
});

test("a bank's check after the press: the member finishes it, and it can still turn out placed", async () => {
  const item = await arm(ashItems[1], 380);
  await drop(item.id, 360);
  const { run } = await pickUp();
  await report(run.id, { status: 'checkout' });
  await report(run.id, { status: 'placing', total: 360 });
  const bank = (await report(run.id, { status: 'needs_you', reason: 'bank_check' })).body.run;
  assert.equal(bank.status, 'needs_you');
  assert.equal(itemRow(item.id).aco, 0, 'pressed: disarmed whatever happens next');
  // Said as what it is, straight away: approve it in your bank's app (with its total).
  assert.ok((await events(ash)).some((e) => /^🏦 Approve the payment in your bank's app: Night UPC — .*\$360\.00$/.test(e.message)), JSON.stringify((await events(ash)).slice(0, 3)));
  assert.equal((await report(run.id, { status: 'placed' })).body.run.status, 'placed');
  // An unknown reason from a browser is kept as "something went wrong".
  const other = await arm(ashItems[2], 30);
  await ash.put('/api/aco', { perDay: 3 });
  await drop(other.id, 20);
  const second = (await pickUp()).run;
  assert.equal((await report(second.id, { status: 'failed', reason: 'made_up' })).body.run.reason, 'error');
  await ash.put('/api/items/' + other.id, { aco: false });
});

test("the day's orders and spending stop it — but stopping at the final button doesn't count", async () => {
  await ash.put('/api/aco', { perDay: 2 });
  const item = await arm(ashItems[3], 100);
  await drop(item.id, 30);
  assert.equal(lastRun(item.id).reason, 'daily_orders');
  assert.match(lastRun(item.id).message, /2 of 2 today/);
  await ash.put('/api/aco', { perDay: 5, spendPerDay: 750 });
  await drop(item.id, 30);
  assert.equal(lastRun(item.id).reason, 'daily_spend', '$730.50 spent + $30 is over $750');
  assert.equal(itemRow(item.id).aco, 1);

  // Fill mode: checkout is filled in and stops for the member, so the day's limits don't apply.
  await ash.put('/api/aco', { mode: 'fill' });
  await drop(item.id, 30);
  assert.equal(lastRun(item.id).status, 'queued');
  const { run, claim } = await pickUp();
  assert.equal(claim.aco.mode, 'fill');
  assert.equal(run.mode, 'fill');
  const ready = (await report(run.id, { status: 'ready', total: 40 })).body.run;
  assert.equal(ready.status, 'ready');
  assert.equal(itemRow(item.id).aco, 0, 'filled in for them: armed again only by the member');
  assert.ok((await events(ash)).some((e) => /Checkout ready: Poster Collection/.test(e.message)));
  assert.equal((await ash.get('/api/aco')).body.stats.needsYou, 1, "the bank's check turned out placed; this one waits for them");
  await ash.put('/api/aco', { mode: 'place', spendPerDay: 5000 });
});

test("over the item's max price or the order limit: skipped, still armed", async () => {
  const item = await arm(ashItems[4], 50);
  await drop(item.id, 60);
  assert.equal(lastRun(item.id).reason, 'over_max');
  assert.match(lastRun(item.id).message, /\$60\.00 is over your max of \$50\.00/);
  await ash.put(`/api/items/${item.id}`, { maxPrice: 900 });
  await drop(item.id, 450);
  assert.equal(lastRun(item.id).reason, 'over_limit', '$450 is over the $400 an order limit');
  assert.equal(itemRow(item.id).aco, 1);
  await ash.put(`/api/items/${item.id}`, { aco: false });
});

test('signed in or not, a drop starts the run (the store\'s checkout goes either way, and a reading can be old or wrong)', async () => {
  // (An account saved with "only where signed in" from before: no longer holds a run back.)
  await ash.put('/api/aco', { signedInOnly: true });
  const item = await arm(ashItems[5], 100);
  const deviceId = (await ash.get('/api/devices')).body.devices[0].id;
  env.app.repo.setDeviceLogins(ash.user.id, deviceId, { kmart: { status: 'out', at: Date.now(), how: 'page' } });
  await drop(item.id, 65);
  assert.equal(lastRun(item.id).status, 'queued', 'started, signed out');
  // Switched off before the store opened: the run doesn't start, and the store opens as a plain ⚡ Buy.
  await ash.put('/api/aco', { enabled: false, signedInOnly: false });
  const next = (await ashBrowser.call('GET', '/api/ext/aco/next')).body;
  assert.equal(next.enabled, false);
  const claim = (await ashBrowser.call('POST', '/api/ext/claim', { code: codeOf(next.runs[0].url) })).body;
  assert.equal(claim.aco, null);
  assert.equal(lastRun(item.id).status, 'expired');
  assert.equal(lastRun(item.id).reason, 'stopped');
  assert.equal(itemRow(item.id).aco, 1, "didn't start: still armed");
  // Switched off, a drop starts nothing at all.
  await drop(item.id, 65);
  assert.equal(lastRun(item.id).status, 'expired');
  await ash.put('/api/aco', { enabled: true });
});

test('runs nobody picks up, or that never finish, are closed with why', async () => {
  const item = ashItems[5];
  const age = (id, field, ms) => env.app.db.run(`UPDATE aco_runs SET ${field} = ${field} - :ms WHERE id = :id`, { id, ms });
  // Nobody picked it up within 2 minutes.
  await drop(item.id, 65);
  age(lastRun(item.id).id, 'created_at', 3 * 60 * 1000);
  aco.expire();
  assert.equal(lastRun(item.id).status, 'expired');
  assert.equal(lastRun(item.id).reason, 'no_browser');
  // Opened, but never finished in 10 minutes.
  await drop(item.id, 65);
  const { run } = await pickUp();
  age(run.id, 'updated_at', 11 * 60 * 1000);
  aco.expire();
  assert.equal(lastRun(item.id).status, 'failed');
  assert.equal(lastRun(item.id).reason, 'timeout');
  // The final button pressed, then nothing: it may have been bought — the member checks.
  await drop(item.id, 65);
  const pressed = (await pickUp()).run;
  await report(pressed.id, { status: 'placing', total: 75 });
  age(pressed.id, 'updated_at', 6 * 60 * 1000);
  aco.expire();
  assert.equal(lastRun(item.id).status, 'needs_you');
  assert.equal(lastRun(item.id).reason, 'unconfirmed');
  assert.equal(itemRow(item.id).aco, 0);
  // Switched off between the drop and a browser picking it up: closed, not a failure.
  const other = await arm(ashItems[6], 110);
  await drop(other.id, 100);
  await ash.put(`/api/items/${other.id}`, { aco: false });
  assert.deepEqual((await ashBrowser.call('GET', '/api/ext/aco/next')).body.runs, []);
  assert.equal(lastRun(other.id).status, 'expired');
  assert.equal(lastRun(other.id).reason, 'disarmed');
});

test("another member's browser can't see, pick up or report your runs", async () => {
  const item = await arm(ashItems[6], 110);
  await drop(item.id, 100);
  const mine = lastRun(item.id);
  assert.equal(mine.status, 'queued');
  const mistyBrowser = await Device.pair(env.url, misty, 'Misty laptop');
  assert.deepEqual((await mistyBrowser.call('GET', '/api/ext/aco/next')).body.runs, [], "Misty's browser gets none of Ash's runs");
  assert.equal((await report(mine.id, { status: 'failed', reason: 'stopped' }, mistyBrowser)).status, 404);
  assert.ok(!(await misty.get('/api/aco')).body.runs.some((r) => r.id === mine.id));
  const { run } = await pickUp();
  assert.equal(run.id, mine.id);
  assert.equal((await mistyBrowser.call('POST', '/api/ext/claim', { code: codeOf(run.url) })).status, 404, "Ash's code is Ash's alone");
  assert.equal((await report(run.id, { status: 'placed' }, mistyBrowser)).status, 404);
  assert.equal(lastRun(item.id).status, 'started');
  await report(run.id, { status: 'failed', reason: 'stopped' });
  assert.equal(lastRun(item.id).status, 'failed');
});

test('Trigger ACO: a test run now, armed or not — the same limits, its failures not counted, and never two at once', async () => {
  await ash.put('/api/aco', { enabled: true, mode: 'place', perDay: 10, spendPerDay: 5000, maxOrder: 400, signedInOnly: false });
  const item = ashItems[6]; // Elite Trainer Box, $100
  await ash.put(`/api/items/${item.id}`, { aco: false, maxPrice: null });
  // Not without a max price, nor at another member's item.
  let r = await ash.post(`/api/aco/test/${item.id}`);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /max price/);
  const theirs = (await misty.get('/api/items')).body.items[0];
  assert.equal((await ash.post(`/api/aco/test/${theirs.id}`)).status, 404);
  await ash.put(`/api/items/${item.id}`, { maxPrice: 110 });
  r = await ash.post(`/api/aco/test/${item.id}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.run.status, 'queued');
  assert.equal(r.body.run.trigger, 'test');
  assert.equal(r.body.run.price, 100, 'at its last known price');
  assert.equal(itemRow(item.id).aco, 0, "a test doesn't arm it");
  assert.ok((await events(ash)).some((e) => /Auto-checkout test started: Elite Trainer Box/.test(e.message)));
  // The browser listens while it waits (nothing need be armed), and picks it up.
  assert.equal((await ashBrowser.call('GET', '/api/ext/items')).body.aco.pending, 1);
  assert.equal((await ash.post(`/api/aco/test/${item.id}`)).body.error, "It's already checking out — wait for that run to finish");
  const { run, claim } = await pickUp();
  assert.equal(run.id, r.body.run.id, 'picked up although the item isn\'t armed');
  assert.equal(claim.aco.maxTotal, 150);
  // Its failures don't count towards the 3 a day.
  await report(run.id, { status: 'failed', reason: 'sold_out' });
  for (let i = 0; i < 3; i += 1) {
    const t = (await ash.post(`/api/aco/test/${item.id}`)).body.run;
    assert.equal(t.status, 'queued', `test ${i + 2} starts`);
    const picked = await pickUp();
    await report(picked.run.id, { status: 'failed', reason: 'not_added' });
  }
  await ash.put(`/api/items/${item.id}`, { aco: true });
  await drop(item.id, 100);
  assert.equal(lastRun(item.id).status, 'queued', 'a real drop still starts: test failures are not counted');
  await report(lastRun(item.id).id, { status: 'failed', reason: 'stopped' }).catch(() => null);
  env.app.db.run("UPDATE aco_runs SET status = 'expired' WHERE item_id = :i AND status IN ('queued', 'sent', 'started')", { i: item.id });
  // The same limits: over the max, or Auto-checkout off.
  await ash.put(`/api/items/${item.id}`, { aco: false, maxPrice: 50 });
  r = await ash.post(`/api/aco/test/${item.id}`);
  assert.equal(r.body.run.status, 'skipped');
  assert.equal(r.body.run.reason, 'over_max');
  await ash.put('/api/aco', { enabled: false });
  r = await ash.post(`/api/aco/test/${item.id}`);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Switch Auto-checkout on/);
  await ash.put('/api/aco', { enabled: true });
});

test('stores that only check out signed in (Amazon): started all the same while the browser says you are signed out there (its own sign-in page stops it if you are)', async () => {
  const amazon = (await ash.post('/api/items', { url: 'https://www.amazon.com.au/dp/B0ABCDEF12', name: 'Amazon ETB', maxPrice: 120, aco: true, price: 90 })).body;
  assert.equal(amazon.aco, true, amazon.error);
  const deviceId = (await ash.get('/api/devices')).body.devices[0].id;
  env.app.repo.setDeviceLogins(ash.user.id, deviceId, { amazon: { status: 'out', at: Date.now(), how: 'check' } });
  await drop(amazon.id, 90);
  assert.equal(lastRun(amazon.id).status, 'queued', 'started, seen signed out');
});

test('several at once: drops at the same moment each get a run, all handed to the browser together; one next in line at its store says so (no DM), goes when its turn comes, and gives up after 20 minutes', async () => {
  await ash.put('/api/aco', { enabled: true, mode: 'place', perDay: 10, spendPerDay: 5000, maxOrder: 400, signedInOnly: false });
  env.app.db.run("UPDATE aco_runs SET status = 'expired' WHERE user_id = :u AND status IN ('queued', 'sent', 'started', 'waiting', 'checkout')", { u: ash.user.id });
  // (New items: the ones before have had their failures today.)
  const add = async (n) => (await ash.post('/api/items', { url: `https://www.kmart.com.au/product/several-at-once-${n}-4390000${n}/`, name: `Several ${n}`, maxPrice: 400, aco: true })).body;
  const a = await add(1);
  const b = await add(2);
  await drop(a.id, 100);
  await drop(b.id, 100);
  assert.deepEqual([lastRun(a.id).status, lastRun(b.id).status], ['queued', 'queued'], JSON.stringify([lastRun(a.id), lastRun(b.id)].map((r) => r && [r.status, r.reason, r.message])));
  const next = await ashBrowser.call('GET', '/api/ext/aco/next');
  assert.deepEqual(next.body.runs.map((r) => r.name).sort(), [a.name, b.name].sort(), 'both handed over at once');
  // The browser's: the first opens its store; the second (the same store) is next in line.
  const [first, second] = next.body.runs;
  assert.equal((await ashBrowser.call('POST', '/api/ext/claim', { code: codeOf(first.url) })).status, 200);
  // (What the member was told: their activity — a queue's or checkpoint's wait tells them, a turn doesn't.)
  const told = async () => (await events(ash)).filter((e) => /In .+'s queue|checkpoint needs you/.test(e.message)).length;
  const before = await told();
  let r = await report(second.id, { status: 'waiting', reason: 'turn', message: `Next in line at ${second.storeName}: your checkout of ${first.name} there goes first` });
  assert.equal(r.status, 200, r.text);
  let run = toRun(env.app.db.get('SELECT * FROM aco_runs WHERE id = :id', { id: second.id }));
  assert.equal(run.status, 'waiting');
  assert.equal(run.reason, 'turn');
  assert.equal(run.statusText, 'Next in line');
  assert.match(run.reasonText, /your other checkout at this store goes first/);
  assert.match(aco.remoteText(run, 'Chrome on Mac'), /⏳ Next in line at .+ in \*\*Chrome on Mac\*\*: your other checkout there goes first/);
  assert.equal(await told(), before, 'no "in the queue" message for a turn: it goes in a moment');
  // Still in line a few minutes on (said again): the same one step.
  await report(second.id, { status: 'waiting', reason: 'turn', message: `Next in line at ${second.storeName}: your checkout of ${first.name} there goes first` });
  assert.equal(toRun(env.app.db.get('SELECT * FROM aco_runs WHERE id = :id', { id: second.id })).steps.filter((x) => x.status === 'waiting').length, 1);
  // The first is placed: the second's turn — a fresh link, then the store opens with it.
  await report(first.id, { status: 'placed', total: 110 });
  const fresh = await ashBrowser.call('POST', `/api/ext/aco/${second.id}/link`, {});
  assert.equal(fresh.status, 200, fresh.text);
  const claim = await ashBrowser.call('POST', '/api/ext/claim', { code: codeOf(fresh.body.url) });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.aco.runId, second.id);
  run = toRun(env.app.db.get('SELECT * FROM aco_runs WHERE id = :id', { id: second.id }));
  assert.equal(run.status, 'started');
  assert.deepEqual(run.steps.map((x) => x.status), ['queued', 'sent', 'waiting', 'started']);
  await report(second.id, { status: 'placed', total: 110 });
  assert.equal(lastRun(b.id).status, 'placed');

  // Next in line for 20 minutes (the one before it never finishing): it gives up, saying why.
  const c = await add(3);
  await drop(c.id, 100);
  const third = (await ashBrowser.call('GET', '/api/ext/aco/next')).body.runs[0];
  await report(third.id, { status: 'waiting', reason: 'turn', message: 'Next in line' });
  env.app.db.run('UPDATE aco_runs SET created_at = created_at - :ms WHERE id = :id', { id: third.id, ms: 21 * 60 * 1000 });
  aco.expire();
  run = lastRun(c.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.reason, 'timeout');
  assert.match(run.message, /Your other checkout at .+ was still going after 20 minutes — it stopped waiting for its turn/);
  // (And an extension that gave up on the wait itself says so the same way.)
  for (const it of [a, b, c]) await ash.del(`/api/items/${it.id}`);
});

test("several at once never go over the day's limits together: runs still checking out count towards the orders and spending", async () => {
  await ash.put('/api/aco', { enabled: true, mode: 'place', perDay: 2, spendPerDay: 5000, maxOrder: 400, signedInOnly: false });
  // (A day of its own: the orders the tests before placed count as yesterday's.)
  env.app.db.run('UPDATE aco_runs SET created_at = created_at - 2 * 86400000 WHERE user_id = :u', { u: ash.user.id });
  env.app.db.run("UPDATE aco_runs SET status = 'expired' WHERE user_id = :u AND status IN ('queued', 'sent', 'started', 'waiting', 'checkout')", { u: ash.user.id });
  const add = async (n) => (await ash.post('/api/items', { url: `https://www.kmart.com.au/product/limits-at-once-${n}-4391000${n}/`, name: `Limits ${n}`, maxPrice: 300, aco: true })).body;
  const items = [await add(1), await add(2), await add(3)];
  // Three drop in the same moment, with 2 orders a day allowed: two start, the third waits for tomorrow.
  for (const it of items) await drop(it.id, 100);
  assert.deepEqual(items.map((it) => lastRun(it.id).status), ['queued', 'queued', 'skipped']);
  assert.equal(lastRun(items[2].id).reason, 'daily_orders');
  assert.match(lastRun(items[2].id).message, /2 of 2 today \(2 checking out now\)/);
  // The spending too: $250 a day, two $100 runs on their way — a third $100 would make $300.
  await ash.put('/api/aco', { perDay: 10, spendPerDay: 250 });
  await ash.put(`/api/items/${items[2].id}`, { aco: true });
  await drop(items[2].id, 100);
  assert.equal(lastRun(items[2].id).reason, 'daily_spend');
  assert.match(lastRun(items[2].id).message, /\$200\.00 of \$250\.00 spent today \(2 checking out now\)/);
  // One of them stops short (nothing bought): the third may go now.
  const [first] = (await ashBrowser.call('GET', '/api/ext/aco/next')).body.runs;
  await report(first.id, { status: 'failed', reason: 'sold_out' });
  await ash.put(`/api/items/${items[2].id}`, { aco: true });
  await drop(items[2].id, 100);
  assert.equal(lastRun(items[2].id).status, 'queued');
  env.app.db.run("UPDATE aco_runs SET status = 'expired' WHERE user_id = :u AND status IN ('queued', 'sent', 'started')", { u: ash.user.id });
  for (const it of items) await ash.del(`/api/items/${it.id}`);
  await ash.put('/api/aco', { perDay: 10, spendPerDay: 5000 });
});

test('a drop several members have armed: every member\'s run is made before anyone\'s alerts go out (the last one in doesn\'t wait on the others\' DMs)', async () => {
  const url = 'https://www.kmart.com.au/product/pokemon-tcg-scarlet-and-violet-prismatic-evolutions-elite-trainer-box-43818648/';
  const members = [];
  for (const name of ['drop-brock', 'drop-gary', 'drop-dawn']) {
    const c = await Client.signup(env.url, name);
    makeMember(env, c);
    assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 400, perDay: 5, spendPerDay: 2000 })).status, 200);
    env.app.repo.addDevice(c.user.id, 'Chrome on Mac', '1.19.0');
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
    const added = await c.post('/api/items', { url, name: 'Prismatic ETB', maxPrice: 120, aco: name !== 'drop-dawn' });
    assert.equal(added.status, 200, added.text);
    members.push({ c, item: added.body });
  }
  const rows = members.map((m) => itemRow(m.item.id));
  const runsNow = () => env.app.db.get(`SELECT COUNT(*) AS n FROM aco_runs WHERE item_id IN (${rows.map((r) => `'${r.id}'`).join(',')})`).n;
  // (The alerts are slow to send — Discord taking its time, say: what each finds already made.)
  const notifier = env.app.notifier;
  const itemAlert = notifier.itemAlert.bind(notifier);
  const notify = notifier.notify.bind(notifier);
  const at = [];
  notifier.itemAlert = async (...a) => { at.push(runsNow()); await new Promise((r) => setTimeout(r, 40)); return itemAlert(...a); };
  notifier.notify = async (...a) => { if (a[1] && a[1].type === 'aco') at.push(runsNow()); await new Promise((r) => setTimeout(r, 40)); return notify(...a); };
  try {
    // Dawn's (not armed) comes first in the list: armed ones go first anyway.
    await env.app.monitor.applyAll([rows[2], rows[0], rows[1]], { status: 'in_stock', title: 'Prismatic ETB', price: 99, error: '' }, 'sweep');
  } finally {
    notifier.itemAlert = itemAlert;
    notifier.notify = notify;
  }
  assert.equal(runsNow(), 2, 'a run for each armed member');
  assert.ok(at.length >= 5, 'everyone\'s alerts went out: 3 restock DMs and 2 "Auto-checkout started"');
  assert.ok(at.every((n) => n === 2), `every alert went out with both runs made already (${at.join(', ')})`);
  for (const m of members) {
    assert.equal(itemRow(m.item.id).status, 'in_stock');
    assert.ok((await events(m.c)).some((e) => /In stock|🟢/.test(e.message)), 'and each member heard');
  }
});

test('a brand-new listing\'s only option (the search said so) takes its run straight to the store\'s add-to-cart link — before the catalogue knows the product', async () => {
  const c = await Client.signup(env.url, 'variant-vic');
  makeMember(env, c);
  assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 400, perDay: 5, spendPerDay: 2000 })).status, 200);
  const device = await Device.pair(env.url, c);
  for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  const url = 'https://www.gamesworld.com.au/product/one-piece-op-15-booster-box/';
  const added = await c.post('/api/items', { url, name: 'OP-15 Booster Box', maxPrice: 250, aco: true });
  assert.equal(added.status, 200, added.text);
  assert.equal(env.app.catalog.productFor('gamesworld', added.body.sku), null, 'not in the catalogue yet');
  await env.app.monitor.applyAll([itemRow(added.body.id)], { status: 'in_stock', title: 'OP-15 Booster Box', price: 199, error: '', variantId: '424242' }, 'sweep');
  const next = await device.call('GET', '/api/ext/aco/next');
  assert.equal(next.status, 200, next.text);
  assert.equal(next.body.runs.length, 1);
  assert.match(next.body.runs[0].url, /^https:\/\/www\.gamesworld\.com\.au\/checkout\/\?add-to-cart=424242&quantity=1#mgb-go=/, 'straight to its add-to-cart link');
  // Without one (an item whose listing has options): its product page, as before.
  const other = await c.post('/api/items', { url: 'https://www.gamesworld.com.au/product/one-piece-op-15-booster-case/', name: 'OP-15 Case', maxPrice: 250, aco: true });
  await env.app.monitor.applyAll([itemRow(other.body.id)], { status: 'in_stock', title: 'OP-15 Case', price: 199, error: '', variantId: null }, 'sweep');
  const next2 = await device.call('GET', '/api/ext/aco/next');
  assert.equal(next2.body.runs.length, 1);
  assert.match(next2.body.runs[0].url, /^https:\/\/www\.gamesworld\.com\.au\/product\/one-piece-op-15-booster-case\/#mgb-go=/);
});

test('the browser doesn\'t wait for its "placing" to be heard (it says "pressed" with how it ended): placed first and "placing" second, or never, is still one order — disarmed, and the day\'s limits exact; "at checkout" after "placing" is old news', async () => {
  const c = await Client.signup(env.url, 'pressed-pat');
  makeMember(env, c);
  assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 400, perDay: 5, spendPerDay: 2000 })).status, 200);
  const device = await Device.pair(env.url, c);
  for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  const add = async (n) => {
    const r = await c.post('/api/items', { url: `https://www.kmart.com.au/product/pressed-test-${n}-4399000${n}/`, name: `Pressed ${n}`, maxPrice: 150, aco: true });
    assert.equal(r.status, 200, r.text);
    return r.body;
  };
  const start = async (it) => {
    await env.app.monitor.alertRestock(itemRow(it.id), { status: 'in_stock', price: 100, source: 'sweep' });
    return (await pickUp(device)).run;
  };
  const today = async () => (await c.get('/api/aco')).body.today;

  // Placed, heard before its "placing": the press is kept as a step, then the order.
  const a = await add(1);
  const runA = await start(a);
  await report(runA.id, { status: 'checkout' }, device);
  const placed = (await report(runA.id, { status: 'placed', total: 110, pressed: true }, device)).body.run;
  assert.equal(placed.status, 'placed');
  assert.deepEqual(placed.steps.map((s) => s.status), ['queued', 'sent', 'started', 'checkout', 'placing', 'placed']);
  assert.equal(itemRow(a.id).aco, 0, 'disarmed');
  // …and the "placing" coming in after it changes nothing.
  const late = (await report(runA.id, { status: 'placing', total: 110 }, device)).body.run;
  assert.equal(late.status, 'placed');
  assert.equal(late.steps.length, placed.steps.length);
  assert.deepEqual(await today(), { orders: 1, spent: 110 });

  // The bank's check after the press, its "placing" never heard: counted towards the day all the same.
  const b = await add(2);
  const runB = await start(b);
  await report(runB.id, { status: 'checkout' }, device);
  const bank = (await report(runB.id, { status: 'needs_you', reason: 'bank_check', total: 120, pressed: true }, device)).body.run;
  assert.equal(bank.status, 'needs_you');
  assert.ok(bank.steps.some((s) => s.status === 'placing'), 'kept as pressed');
  assert.equal(itemRow(b.id).aco, 0);
  assert.deepEqual(await today(), { orders: 2, spent: 230 });

  // Stopped short of the final button (not pressed): not an order, and still armed for the next drop.
  const d = await add(3);
  const runD = await start(d);
  await report(runD.id, { status: 'checkout' }, device);
  const short = (await report(runD.id, { status: 'failed', reason: 'sold_out', pressed: false }, device)).body.run;
  assert.equal(short.status, 'failed');
  assert.ok(!short.steps.some((s) => s.status === 'placing'));
  assert.equal(itemRow(d.id).aco, 1);
  assert.deepEqual(await today(), { orders: 2, spent: 230 });

  // "At checkout" heard after "placing": old news — it stays pressed.
  const runE = await start(d);
  await report(runE.id, { status: 'placing', total: 95 }, device);
  const stale = (await report(runE.id, { status: 'checkout' }, device)).body.run;
  assert.equal(stale.status, 'placing');
  assert.ok(!stale.steps.some((s) => s.status === 'checkout'));
  assert.equal(itemRow(d.id).aco, 0, 'pressed: this arming is used up');
  assert.equal((await report(runE.id, { status: 'placed' }, device)).body.run.status, 'placed');
  assert.deepEqual(await today(), { orders: 3, spent: 325 });
});

test('⚡ Buy you press yourself (the dashboard\'s, a channel link, the store panel\'s "Add to bag → Checkout") with Auto-checkout set to "Place the order for me": a run of its own that places the order within your limits — not with it off or set to stop at the final button, over a limit, with the item already checking out, or in an older extension', async () => {
  const c = await Client.signup(env.url, 'own-olive');
  makeMember(env, c);
  assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 300, perDay: 3, spendPerDay: 350 })).status, 200);
  const device = await Device.pair(env.url, c, 'Olive laptop');
  for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  const item = (await c.post('/api/items', { url: 'https://www.kmart.com.au/product/own-buy-test-43990011/', name: 'Own Buy ETB', maxPrice: 120 })).body;
  // (price: what the page or the alert said — none known, the most it may cost is your limit an order.)
  const own = (product, price) => device.call('POST', '/api/ext/aco/own', { product: { ...product, price } });
  // An older extension (or one that hasn't said its version): left at the final button, as before.
  assert.equal((await own({ id: item.id }, 100)).body.aco, null, "a browser that hasn't said its version");
  await device.call('GET', '/api/ext/me?v=1.26.0');
  assert.equal((await own({ id: item.id }, 100)).body.aco, null, 'an extension older than 1.27.0');
  await device.call('GET', `/api/ext/me?v=${encodeURIComponent('1.27.0')}`);

  // On your watchlist: the item's max (one of it, plus delivery), within your limit an order and the day's spending.
  let r = await own({ id: item.id }, 100);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.aco, { runId: r.body.aco.runId, mode: 'place', maxPrice: 120, maxTotal: 160, orderLimit: 300, name: 'Own Buy ETB', sku: item.sku, url: item.url });
  const row = env.app.db.get('SELECT * FROM aco_runs WHERE id = :id', { id: r.body.aco.runId });
  assert.equal(row.status, 'started');
  assert.equal(row.trigger, 'buy');
  assert.ok(row.device_id, 'taken up by this browser');
  assert.equal((await c.get('/api/aco')).body.runs[0].trigger, 'buy');
  // The item already checking out: none for a second ⚡ Buy (it fills checkout in, stopping at the final button).
  assert.equal((await own({ id: item.id }, 100)).body.aco, null);
  assert.equal((await report(r.body.aco.runId, { status: 'placing', total: 109.95 }, device)).status, 200);
  assert.equal((await report(r.body.aco.runId, { status: 'placed', total: 109.95 }, device)).body.run.status, 'placed');
  assert.equal(itemRow(item.id).aco, 0, 'not armed, and not armed by it');
  // The day's spending so far counts: the most with other things in the bag is what's left of it.
  r = await own({ id: item.id }, 100);
  assert.equal(r.body.aco.orderLimit, 240.05, '$350 a day, $109.95 spent');
  await report(r.body.aco.runId, { status: 'failed', reason: 'stopped' }, device);
  // The dashboard's ⚡ Buy (its one-time code, claimed by the browser on the store's page): the same — a run of its own.
  const go = await c.post(`/api/items/${item.id}/go`, {});
  assert.equal(go.status, 200, go.text);
  const claim = await device.call('POST', '/api/ext/claim', { code: codeOf(go.body.url) });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.aco.mode, 'place');
  assert.equal(claim.body.aco.maxPrice, 120);
  assert.equal(env.app.db.get('SELECT trigger FROM aco_runs WHERE id = :id', { id: claim.body.aco.runId }).trigger, 'buy');
  await report(claim.body.aco.runId, { status: 'failed', reason: 'stopped' }, device);

  // A product that isn't on your watchlist (the page's own): up to your limit an order.
  r = await own({ store: 'kmart', sku: '43990099', name: 'A Link From Elsewhere', url: 'https://www.kmart.com.au/product/elsewhere-43990099/' }, 90);
  assert.equal(r.body.aco.maxPrice, 300);
  assert.equal(r.body.aco.maxTotal, 240.05, "your limit an order — never over what's left of the day's spending");
  const elsewhere = env.app.db.get('SELECT * FROM aco_runs WHERE id = :id', { id: r.body.aco.runId });
  assert.deepEqual([elsewhere.item_id, elsewhere.sku, elsewhere.name], [null, '43990099', 'A Link From Elsewhere']);
  await report(r.body.aco.runId, { status: 'failed', reason: 'stopped' }, device);
  // Over its max, or your limit an order: none — filled in, left for you.
  assert.equal((await own({ id: item.id }, 130)).body.aco, null, "over the item's max");
  assert.equal((await own({ store: 'kmart', sku: '43990098', name: 'Pricey' }, 320)).body.aco, null, 'over the limit an order');
  // A store Mugibot can't check out at, or a link of no store at all: none.
  assert.equal((await own({ store: 'nowhere', sku: '1', name: 'x' }, 10)).body.aco, null);
  // Set to stop at the final button, or switched off: none.
  await c.put('/api/aco', { mode: 'fill' });
  assert.equal((await own({ id: item.id }, 100)).body.aco, null);
  await c.put('/api/aco', { mode: 'place', enabled: false });
  assert.equal((await own({ id: item.id }, 100)).body.aco, null);
  await c.put('/api/aco', { enabled: true });
  // The day's orders reached (3 a day): the runs that stopped short counted as placed, for the test.
  env.app.db.run("UPDATE aco_runs SET status = 'placed', total = 10 WHERE user_id = :u AND status != 'placed'", { u: c.user.id });
  assert.equal((await own({ id: item.id }, 100)).body.aco, null, "the day's 3 orders reached");
  // …and the dashboard's ⚡ Buy then fills checkout in for you, stopping at the final button.
  const late = await c.post(`/api/items/${item.id}/go`, {});
  const lateClaim = await device.call('POST', '/api/ext/claim', { code: codeOf(late.body.url) });
  assert.equal(lateClaim.status, 200);
  assert.equal(lateClaim.body.aco, null);
});

test("a run's notes (other things in the bag, being bought too) go on its history and your activity; a slow checkout saying the same again (its count aside) is one step, not one a press", async () => {
  const c = await Client.signup(env.url, 'note-nell');
  makeMember(env, c);
  await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 300, perDay: 5, spendPerDay: 900 });
  const device = await Device.pair(env.url, c);
  await device.call('GET', '/api/ext/me?v=1.27.0');
  for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  const item = (await c.post('/api/items', { url: 'https://www.kmart.com.au/product/note-test-43990021/', name: 'Note ETB', maxPrice: 120, aco: true })).body;
  await env.app.monitor.alertRestock(itemRow(item.id), { status: 'in_stock', price: 100, source: 'sweep' });
  const { run } = await pickUp(device);
  await report(run.id, { status: 'note', reason: 'others', message: 'Your Kmart bag already had 1 item in it — Auto-checkout carries on' }, device);
  let r = (await c.get('/api/aco')).body.runs[0];
  assert.equal(r.status, 'started', 'a note changes nothing of where it is');
  assert.ok(r.steps.some((x) => /already had 1 item/.test(x.message)));
  assert.ok((await events(c)).some((e) => e.level === 'warn' && /Note ETB: Your Kmart bag already had 1 item/.test(e.message)));
  for (let n = 1; n <= 4; n++) await report(run.id, { status: 'placing', message: n === 1 ? 'Pressing "Checkout securely" — total $110.00' : `Pressing "Checkout securely" again (${n}) — Kmart hasn't taken the order yet` }, device);
  r = (await c.get('/api/aco')).body.runs[0];
  assert.equal(r.status, 'placing');
  assert.equal(r.steps.filter((x) => x.status === 'placing').length, 2, 'the first press, and "again" once (its count aside)');
  await report(run.id, { status: 'placed', total: 110 }, device);
  // (A note on a run that's over: nothing.)
  await report(run.id, { status: 'note', message: 'late' }, device);
  assert.ok(!(await c.get('/api/aco')).body.runs[0].steps.some((x) => x.message === 'late'));
});

test('a press the browser made after the run was closed here for want of news (timed out): counted as an order — needs you, disarmed, in the day\'s limits — and never pressed again', async () => {
  const c = await Client.signup(env.url, 'late-lou');
  makeMember(env, c);
  await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 300, perDay: 5, spendPerDay: 900 });
  const device = await Device.pair(env.url, c);
  for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  const item = (await c.post('/api/items', { url: 'https://www.kmart.com.au/product/late-test-43990031/', name: 'Late ETB', maxPrice: 120, aco: true })).body;
  await env.app.monitor.alertRestock(itemRow(item.id), { status: 'in_stock', price: 100, source: 'sweep' });
  const { run } = await pickUp(device);
  await report(run.id, { status: 'checkout' }, device);
  // Closed here: no news for too long.
  env.app.db.run("UPDATE aco_runs SET status = 'failed', reason = 'timeout' WHERE id = :id", { id: run.id });
  // Pressing again, the browser asks first: a closed run says no.
  let r = (await report(run.id, { status: 'placing', again: true }, device)).body.run;
  assert.equal(r.status, 'failed');
  assert.equal(r.active, false);
  // Its first press, heard late: an order after all — for you to check.
  r = (await report(run.id, { status: 'placing', total: 110, message: 'Pressing "Checkout securely"' }, device)).body.run;
  assert.equal(r.status, 'needs_you');
  assert.equal(r.reason, 'unconfirmed');
  assert.ok(r.steps.some((x) => x.status === 'placing'));
  assert.equal(itemRow(item.id).aco, 0, 'the arming used up');
  assert.deepEqual((await c.get('/api/aco')).body.today, { orders: 1, spent: 110 });
  // …and never pressed again from here.
  r = (await report(run.id, { status: 'placing', again: true }, device)).body.run;
  assert.equal(r.status, 'needs_you');
  // The order confirmed after all: placed.
  assert.equal((await report(run.id, { status: 'placed', total: 110 }, device)).body.run.status, 'placed');
});

test('how many: an item of 3 buys 3 — its max price is for one, the run\'s limit for all 3 (over the max, the limit an order or the day\'s spending: skipped); the browser is told 3; an extension older than 1.29.0 (one at a time) is never sent a run of more than one; a Shop checkout link\'s price and max are already the whole link\'s', async () => {
  const c = await Client.signup(env.url, 'qty-quinn');
  makeMember(env, c);
  await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 300, perDay: 5, spendPerDay: 1000 });
  const device = await Device.pair(env.url, c);
  for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  const item = (await c.post('/api/items', { url: 'https://www.kmart.com.au/product/qty-test-43990041/', name: 'Three ETBs', maxPrice: 90, quantity: 3, aco: true })).body;
  assert.equal(item.quantity, 3);
  const dropAt = (price) => env.app.monitor.alertRestock(itemRow(item.id), { status: 'in_stock', price, source: 'sweep' });

  // An extension that doesn't say its version, or an older one: one at a time — not sent a run of 3.
  await dropAt(80);
  let r = lastRun(item.id);
  assert.deepEqual([r.status, r.reason], ['skipped', 'old_extension']);
  assert.match(r.message, /buys one at a time — update it to 1\.29\.0 to buy 3/);
  await device.call('GET', '/api/ext/me?v=1.28.0');
  await dropAt(80);
  assert.equal(lastRun(item.id).reason, 'old_extension', '1.28.0: still one at a time');
  await device.call('GET', '/api/ext/me?v=1.29.0');

  // Its max is for one: $95 each is over the $90 max.
  await dropAt(95);
  assert.equal(lastRun(item.id).reason, 'over_max');
  // 3 × $110 = $330 is over the $300 an order — each one under its max wouldn't be.
  await c.put(`/api/items/${item.id}`, { maxPrice: 120 });
  await dropAt(110);
  r = lastRun(item.id);
  assert.equal(r.reason, 'over_limit');
  assert.match(r.message, /3 × \$110\.00 = \$330\.00 is over your limit of \$300\.00 an order/);
  // The day's spending counts all 3: $1,000 a day with $750 spent → 3 × $90 = $270 is over.
  await c.put(`/api/items/${item.id}`, { maxPrice: 90 });
  env.app.db.run("INSERT INTO aco_runs (id, user_id, item_id, store, sku, name, status, mode, price, total, created_at, updated_at) VALUES ('run_qty_spent', :u, NULL, 'kmart', 'x', 'Earlier', 'placed', 'place', 750, 750, :t, :t)", { u: c.user.id, t: Date.now() });
  await dropAt(90);
  assert.equal(lastRun(item.id).reason, 'daily_spend');
  env.app.db.run("DELETE FROM aco_runs WHERE id = 'run_qty_spent'");

  // Within every limit: the run is for 3 — its most for all 3 together, the browser told 3.
  await dropAt(85);
  r = lastRun(item.id);
  assert.equal(r.status, 'queued', JSON.stringify(r));
  assert.equal(r.quantity, 3);
  assert.equal(r.maxPrice, 270, '3 × the $90 max');
  const { run, claim } = await pickUp(device);
  assert.equal(claim.quantity, 3, 'the ⚡ Buy code says 3');
  assert.equal(claim.aco.maxPrice, 270);
  assert.equal(claim.aco.maxTotal, 300, '$270 + delivery, never over the $300 an order');
  await report(run.id, { status: 'placing', total: 265 }, device);
  await report(run.id, { status: 'placed', total: 265 }, device);
  assert.deepEqual((await c.get('/api/aco')).body.today, { orders: 1, spent: 265 });

  // Trigger ACO and Discord's ⚡ Buy: the same — 3, the limit for all 3.
  await c.put(`/api/items/${item.id}`, { aco: true, price: 85 });
  const test3 = await c.post(`/api/aco/test/${item.id}`);
  assert.equal(test3.status, 200, test3.text);
  assert.equal(test3.body.run.quantity, 3);
  env.app.db.run("UPDATE aco_runs SET status = 'failed', reason = 'stopped' WHERE item_id = :i AND status IN ('queued', 'sent', 'started')", { i: item.id });
  const remote = await env.app.aco.remote(c.user.id, item.id, { price: 85 });
  assert.equal(remote.mode, 'place', remote.why);
  assert.equal(remote.run.quantity, 3);
  assert.equal(remote.run.maxPrice, 270);
  env.app.db.run("UPDATE aco_runs SET status = 'failed', reason = 'stopped' WHERE item_id = :i AND status IN ('queued', 'sent', 'started')", { i: item.id });
  // (Back on 1.28.0: Discord's ⚡ Buy says why it can't buy 3 there.)
  await device.call('GET', '/api/ext/me?v=1.28.0');
  assert.match((await env.app.aco.remote(c.user.id, item.id, { price: 85 })).error, /buys one at a time — update it to 1\.29\.0 to buy 3/);
  await device.call('GET', '/api/ext/me?v=1.29.0');

  // A Shop checkout link of 2 (…:2): its price is the link's ($50 for both), its max the link's — never times 2.
  const link = (await c.post('/api/items', { url: 'https://creations.mattel.com/cart/48835830579405:2', name: 'Two figures', maxPrice: 60, aco: true })).body;
  assert.equal(link.quantity, 2, 'the link\'s own 2');
  await device.call('GET', '/api/ext/me?v=1.29.0');
  await env.app.monitor.alertRestock(itemRow(link.id), { status: 'in_stock', price: 50, source: 'monitor' });
  r = lastRun(link.id);
  assert.equal(r.status, 'queued', JSON.stringify(r));
  assert.deepEqual([r.quantity, r.maxPrice], [1, 60], 'the link is the order: its max as it is');
  const shop = await pickUp(device);
  assert.match(shop.run.url, /\/cart\/48835830579405:2#mgb-go=/, 'the link as it is — 2 in it');
});
