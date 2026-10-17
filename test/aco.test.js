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
  assert.deepEqual(ext.aco, { enabled: true, armed: 1 });
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
  assert.deepEqual(claim.aco, { runId: run.id, mode: 'place', maxPrice: 380, maxTotal: 400, name: 'Day UPC', sku: item.sku });
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
  assert.ok((await events(ash)).some((e) => /needs you: Night UPC/.test(e.message)));
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

test('"only where signed in": a drop at a store the browser is signed out of is skipped', async () => {
  await ash.put('/api/aco', { signedInOnly: true });
  const item = await arm(ashItems[5], 100);
  const deviceId = (await ash.get('/api/devices')).body.devices[0].id;
  env.app.repo.setDeviceLogins(ash.user.id, deviceId, { kmart: { status: 'out', at: Date.now(), how: 'page' } });
  await drop(item.id, 65);
  assert.equal(lastRun(item.id).reason, 'signed_out');
  env.app.repo.setDeviceLogins(ash.user.id, deviceId, { kmart: { status: 'in', at: Date.now(), how: 'page' } });
  await drop(item.id, 65);
  assert.equal(lastRun(item.id).status, 'queued');
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
