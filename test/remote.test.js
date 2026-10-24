// ⚡ Buy from anywhere (server/aco.js remote(), routes/discord.js press()): a ⚡ Buy pressed in
// Discord — on a phone, with no browser and nothing signed in — checks out in the member's
// checkout browser: the one browser runs go to (picked on the dashboard, or the newest connected).
// With Auto-checkout on it places the order within their limits; otherwise it fills checkout in
// and stops at the final button. Discord's reply (only they see it) follows the run.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, discordOpts, interactionKeys, makeMember, startApp, startFakeDiscord, waitFor } from './helpers.js';

let env;
let discord;
let keys;
let gary;
let laptop;
let desktop;
let etb;
let misty;

const ETB_URL = 'https://www.kmart.com.au/product/pokemon-tcg%3A-30th-celebration-elite-trainer-box-43818587/';

before(async () => {
  discord = await startFakeDiscord();
  keys = interactionKeys();
  env = await startApp({ ...discordOpts(discord), discordPublicKey: keys.publicKey });
  gary = await Client.signup(env.url, 'gary');
  makeMember(env, gary);
  await connect(gary, 'd-gary');
  etb = (await gary.get('/api/items')).body.items.find((x) => x.sku === '43818587');
});
after(async () => {
  await env.close();
  await discord.close();
});

async function connect(c, discordId) {
  discord.state.users[discordId] = discord.state.users[discordId] || { id: discordId, username: discordId };
  discord.state.nextUser = discordId;
  const start = await c.get('/auth/discord');
  const consent = await fetch(new URL(start.headers.get('location')), { redirect: 'manual' });
  const cb = new URL(consent.headers.get('location'));
  await c.get(cb.pathname + cb.search);
}

let presses = 0;
/** A button pressed in Discord by `discordId` (Discord signs it and says who pressed it). */
async function press(discordId, customId) {
  presses += 1;
  const token = `tok-${presses}`;
  const body = JSON.stringify({ type: 3, id: `i-${presses}`, token, member: { user: { id: discordId } }, data: { custom_id: customId, component_type: 2 } });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${env.url}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': keys.sign(ts, body), 'x-signature-timestamp': ts }, body });
  const out = await res.json().catch(() => null);
  return { status: res.status, content: out && out.data && out.data.content, flags: out && out.data && out.data.flags, token };
}

const runOf = (itemId) => env.app.db.get("SELECT * FROM aco_runs WHERE item_id = :i ORDER BY created_at DESC LIMIT 1", { i: itemId });
const codeOf = (url) => new URL(url).hash.replace('#mgb-go=', '');
const finishRuns = () => env.app.db.run("UPDATE aco_runs SET status = 'failed' WHERE status IN ('queued', 'sent', 'started', 'checkout', 'placing')");

test('no browser connected yet: pressing ⚡ Buy says to connect the one on your computer — nothing starts', async () => {
  const r = await press('d-gary', `buy:i:${etb.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.flags, 64, 'only Gary sees the reply');
  assert.match(r.content, /No browser with the Mugibot extension is connected yet — connect the one on your computer/);
  assert.ok(!runOf(etb.id));
});

test('⚡ Buy pressed in Discord (Auto-checkout off): the checkout browser — the newest connected, alone — fills checkout in and stops at the final button; the reply follows it', async () => {
  laptop = await Device.pair(env.url, gary, 'Gary laptop');
  desktop = await Device.pair(env.url, gary, 'Gary desktop');
  // The extension: the checkout browser listens with nothing armed — and, the backup on (the default), the
  // member's other browsers too, so one that's open can stand in (only the one checking out is handed a run).
  assert.equal((await desktop.call('GET', '/api/ext/items')).body.aco.listen, true);
  assert.equal((await laptop.call('GET', '/api/ext/items')).body.aco.listen, true);

  const r = await press('d-gary', `buy:i:${etb.id}`);
  assert.match(r.content, /\*\*Elite Trainer Box\*\*\n⏳ Sent to \*\*Gary desktop\*\* — waiting for it to open Kmart/);
  assert.match(r.content, /It fills checkout in and stops at the final button — Auto-checkout is off, so it stops at the final button for you\./);
  assert.match(r.content, /Gary desktop\*\* isn't open right now, nor is any other browser of yours — it starts as soon as one is \(within 2 minutes\)/, 'not asked for runs yet');
  const row = runOf(etb.id);
  assert.deepEqual([row.trigger, row.mode, row.status, row.price], ['remote', 'fill', 'queued', 100]);
  assert.equal((await gary.get('/api/items')).body.items.find((x) => x.id === etb.id).aco, false, 'not armed by it');

  // The desktop (the checkout browser) asks: it gets the run. The laptop isn't the checkout browser, and the
  // desktop's open: it never gets it.
  const next = (await desktop.call('GET', '/api/ext/aco/next')).body;
  assert.deepEqual((await laptop.call('GET', '/api/ext/aco/next')).body.runs, []);
  assert.equal(next.runs.length, 1);
  assert.equal(next.runs[0].mode, 'fill');
  assert.equal(next.listen, true);
  const claim = (await desktop.call('POST', '/api/ext/claim', { code: codeOf(next.runs[0].url) })).body;
  assert.equal(claim.aco.mode, 'fill', 'Auto-checkout off: still filled in, the button left to Gary');
  await desktop.call('POST', `/api/ext/aco/${row.id}`, { status: 'checkout', message: 'At checkout' });
  await desktop.call('POST', `/api/ext/aco/${row.id}`, { status: 'ready', message: 'Filled in' });
  // (Discord's reply is changed as it goes: each change sent as it happens.)
  await waitFor(() => /Checkout's ready/.test(discord.repliesFor(r.token).at(-1) || ''), { message: 'the reply changed to "ready"' });
  const replies = discord.repliesFor(r.token);
  assert.ok(replies.some((x) => /Adding it to the bag at Kmart in \*\*Gary desktop\*\*/.test(x)), replies.join(' | '));
  assert.ok(replies.some((x) => /At Kmart's checkout in \*\*Gary desktop\*\*/.test(x)));
  assert.match(replies.at(-1), /🛒 \*\*Checkout's ready\*\* in Gary desktop — press Kmart's final button there to buy\./);
  assert.doesNotMatch(replies.at(-1), /stops at the final button for you/, 'the note goes once it\'s over');
  assert.equal(runOf(etb.id).status, 'ready');
  // The dashboard: which browser checks out, and which are listening.
  const browsers = (await gary.get('/api/aco')).body.browsers;
  assert.deepEqual(browsers.map((b) => [b.name, b.checkout, b.listening]), [['Gary desktop', true, true], ['Gary laptop', false, true]]);
  // A DM says how it went (Auto-checkout always DMs).
  assert.ok(discord.dmsTo('d-gary').some((m) => /Checkout ready: Elite Trainer Box/.test(m.body.embeds[0].title)));
});

test('with Auto-checkout on: a channel alert\'s ⚡ Buy places the order — up to the price it showed, within the limits — added to the watchlist of whoever pressed it', async () => {
  assert.equal((await gary.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 500, perDay: 3, spendPerDay: 1000 })).status, 200);
  const alert = env.app.catalog.addAlert({ product_id: null, kind: 'restock', store: 'kmart', sku: '43818580', name: 'Booster Bundle', url: 'https://www.kmart.com.au/product/pokemon-tcg-booster-bundle-43818580/', category: 'pokemon', status: 'in_stock', price: 54 });
  const r = await press('d-gary', `buy:a:${alert.id}`);
  assert.match(r.content, /\*\*Booster Bundle\*\*\n⏳ Sent to \*\*Gary desktop\*\*/);
  assert.match(r.content, /It places the order by itself, within your Auto-checkout limits \(up to \$54\.00 for it, plus delivery\)/);
  const item = (await gary.get('/api/items')).body.items.find((x) => x.sku === '43818580');
  assert.ok(item, 'on his watchlist now');
  const row = runOf(item.id);
  assert.deepEqual([row.trigger, row.mode, row.max_price, row.price], ['remote', 'place', 54, 54]);
  const next = (await desktop.call('GET', '/api/ext/aco/next')).body;
  const claim = (await desktop.call('POST', '/api/ext/claim', { code: codeOf(next.runs[0].url) })).body;
  assert.deepEqual([claim.aco.mode, claim.aco.maxTotal], ['place', 94], 'the total: up to $54 + $40 delivery');
  await desktop.call('POST', `/api/ext/aco/${row.id}`, { status: 'placing', total: 63 });
  await desktop.call('POST', `/api/ext/aco/${row.id}`, { status: 'placed', total: 63 });
  await waitFor(() => /Order placed/.test(discord.repliesFor(r.token).at(-1) || ''), { message: 'the reply changed to "placed"' });
  assert.match(discord.repliesFor(r.token).at(-1), /✅ \*\*Order placed\*\* at Kmart — \$63\.00\. The store emails you the confirmation\./);
  const runs = (await gary.get('/api/aco')).body.runs;
  assert.equal(runs[0].trigger, 'remote');
  assert.equal((await gary.get('/api/aco')).body.today.orders, 1, 'it counts towards the day\'s orders');
});

test('a limit in the way: it fills checkout in and stops at the final button instead, and says why', async () => {
  // Over the order limit (the price shown is the most it may cost).
  await gary.put('/api/aco', { maxOrder: 50 });
  let r = await press('d-gary', `buy:i:${etb.id}`);
  assert.match(r.content, /stops at the final button — \$100\.00 is over your limit of \$50\.00 an order/);
  assert.equal(runOf(etb.id).mode, 'fill');
  finishRuns();
  // The day's orders used up.
  await gary.put('/api/aco', { maxOrder: 500, perDay: 1 });
  r = await press('d-gary', `buy:i:${etb.id}`);
  assert.match(r.content, /you've placed your 1 orders for today, so it stops at the final button/);
  finishRuns();
  // Set to stop at the final button.
  await gary.put('/api/aco', { perDay: 5, mode: 'fill' });
  r = await press('d-gary', `buy:i:${etb.id}`);
  assert.match(r.content, /Auto-checkout is set to stop at the final button/);
  finishRuns();
  // Over the item's own max price.
  await gary.put('/api/aco', { mode: 'place' });
  await gary.put(`/api/items/${etb.id}`, { maxPrice: 80 });
  r = await press('d-gary', `buy:i:${etb.id}`);
  assert.match(r.content, /\$100\.00 is over your max of \$80\.00, so it stops at the final button/);
  // Pressed again while it's running: one at a time.
  r = await press('d-gary', `buy:i:${etb.id}`);
  assert.match(r.content, /It's already checking out in Gary desktop\./);
  finishRuns();
});

test('the checkout browser: picked on the dashboard (only your own), runs go to it alone; disconnected, the newest takes over', async () => {
  const laptopId = (await gary.get('/api/aco')).body.browsers.find((b) => b.name === 'Gary laptop').id;
  let r = await gary.put('/api/aco', { deviceId: laptopId });
  assert.equal(r.status, 200);
  assert.equal(r.body.browsers.find((b) => b.checkout).name, 'Gary laptop');
  assert.ok((await gary.get('/api/events')).body.events.some((e) => /Checkout browser: Gary laptop/.test(e.message)));
  assert.equal((await laptop.call('GET', '/api/ext/items')).body.aco.listen, true);
  assert.equal((await desktop.call('GET', '/api/ext/items')).body.aco.listen, true, 'the backup: listening, in case the laptop isn\'t open');
  await laptop.call('GET', '/api/ext/aco/next'); // (the laptop's open)
  const p = await press('d-gary', `buy:i:${etb.id}`);
  assert.match(p.content, /Sent to \*\*Gary laptop\*\*/);
  assert.deepEqual((await desktop.call('GET', '/api/ext/aco/next')).body.runs, [], 'the desktop stays out of it');
  assert.equal((await laptop.call('GET', '/api/ext/aco/next')).body.runs.length, 1);
  finishRuns();
  // Someone else's browser can't be picked.
  misty = await Client.signup(env.url, 'misty');
  const mistyBrowser = await Device.pair(env.url, misty, 'Misty laptop');
  const mistyId = (await misty.get('/api/devices')).body.devices[0].id;
  r = await gary.put('/api/aco', { deviceId: mistyId });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /isn't connected to your account/);
  assert.ok(mistyBrowser);
  // The laptop disconnected: the desktop (the newest left) checks out.
  assert.equal((await gary.del(`/api/devices/${laptopId}`)).status, 200);
  assert.equal((await gary.get('/api/aco')).body.browsers.find((b) => b.checkout).name, 'Gary desktop');
  // Switched off: Discord's ⚡ Buy says so, and the browser stops listening with nothing armed.
  const saved = await gary.put('/api/aco', { remoteBuy: false });
  assert.equal(saved.status, 200, 'the disconnected pick doesn\'t stop settings saving');
  assert.equal(saved.body.settings.deviceId, '');
  assert.equal((await desktop.call('GET', '/api/ext/items')).body.aco.listen, false);
  const off = await press('d-gary', `buy:i:${etb.id}`);
  assert.match(off.content, /⚡ Buy from Discord on your computer is switched off — switch it on at .*\/app#aco/);
  await gary.put('/api/aco', { remoteBuy: true });
});

test("the checkout browser isn't open: another of yours that is checks out instead (the backup, on by default) — and says so; backup off, it waits for the checkout browser alone", async () => {
  finishRuns();
  // A new browser: the newest, so the checkout browser (nothing chosen) — and never opened.
  const tablet = await Device.pair(env.url, gary, 'Gary tablet');
  assert.equal((await gary.get('/api/aco')).body.settings.fallback, true, 'on by default');
  await desktop.call('GET', '/api/ext/aco/next'); // the desktop's open
  let b = (await gary.get('/api/aco/browsers')).body.browsers;
  assert.deepEqual(b.map((x) => [x.name, x.chosen, x.checkout, x.listening]), [['Gary tablet', true, false, false], ['Gary desktop', false, true, true]]);
  let r = await press('d-gary', `buy:i:${etb.id}`);
  assert.match(r.content, /Sent to \*\*Gary desktop\*\*/);
  assert.match(r.content, /ℹ️ \*\*Gary tablet\*\* \(your checkout browser\) isn't open, so \*\*Gary desktop\*\* checks out instead\./);
  assert.equal((await desktop.call('GET', '/api/ext/aco/next')).body.runs.length, 1, 'the desktop, open, takes it');
  assert.equal(runOf(etb.id).device_id, b.find((x) => x.name === 'Gary desktop').id);
  assert.deepEqual((await tablet.call('GET', '/api/ext/aco/next')).body.runs, [], 'never two browsers for one run');
  finishRuns();
  // Backup off: only the checkout browser — the desktop isn't handed runs, and stops listening with nothing armed.
  let s = await gary.put('/api/aco', { fallback: false });
  assert.equal(s.status, 200);
  assert.ok((await gary.get('/api/events')).body.events.some((e) => /backup off: only your checkout browser checks out/.test(e.message)));
  assert.equal((await desktop.call('GET', '/api/ext/items')).body.aco.listen, false);
  // (The tablet closed for a while.)
  env.app.aco.listening.delete((await gary.get('/api/aco/browsers')).body.browsers.find((x) => x.name === 'Gary tablet').id);
  r = await press('d-gary', `buy:i:${etb.id}`);
  assert.match(r.content, /Sent to \*\*Gary tablet\*\*/);
  assert.match(r.content, /Gary tablet\*\* isn't open right now — it starts as soon as it is \(within 2 minutes\)/);
  assert.deepEqual((await desktop.call('GET', '/api/ext/aco/next')).body.runs, [], 'the desktop stays out of it');
  assert.equal((await tablet.call('GET', '/api/ext/aco/next')).body.runs.length, 1, 'the tablet, once open, takes it');
  finishRuns();
  // Back on, and the tablet gone again.
  s = await gary.put('/api/aco', { fallback: true });
  assert.equal(s.body.settings.fallback, true);
  b = (await gary.get('/api/aco/browsers')).body.browsers;
  assert.equal((await gary.del(`/api/devices/${b.find((x) => x.name === 'Gary tablet').id}`)).status, 200);
});

test('only the member who pressed it: someone else\'s DM button, an unconnected Discord, no membership, a store that sells signed in only, an old button', async () => {
  // Misty presses Gary's DM button (forwarded): it isn't her SKU.
  makeMember(env, misty);
  await connect(misty, 'd-misty');
  let r = await press('d-misty', `buy:i:${etb.id}`);
  assert.match(r.content, /That SKU isn't on your watchlist any more\./);
  assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM aco_runs WHERE user_id = :u", { u: misty.user.id }).n, 0);
  // A Discord account nobody connected.
  r = await press('d-stranger', `buy:i:${etb.id}`);
  assert.match(r.content, /Your Discord isn't connected to a Mugibot account yet\. Log in at .*\/app#discord/);
  // No membership.
  env.app.repo.updateUser(misty.user.id, { plan: 'canceled' });
  const alert = env.app.catalog.addAlert({ product_id: null, kind: 'restock', store: 'kmart', sku: '43818549', name: 'ex Box', url: 'https://www.kmart.com.au/product/pokemon-ex-box-43818549/', category: 'pokemon', status: 'in_stock', price: 45 });
  r = await press('d-misty', `buy:a:${alert.id}`);
  assert.match(r.content, /⚡ Buy needs an active membership/);
  // Amazon, signed out in the checkout browser.
  const amazon = (await gary.post('/api/items', { url: 'https://www.amazon.com.au/dp/B0ABCDEF12', name: 'Amazon ETB', price: 90 })).body;
  const deskId = (await gary.get('/api/aco')).body.browsers.find((b) => b.checkout).id;
  env.app.repo.setDeviceLogins(gary.user.id, deskId, { amazon: { status: 'out', at: Date.now(), how: 'check' } });
  r = await press('d-gary', `buy:i:${amazon.id}`);
  assert.doesNotMatch(r.content, /only sells to signed-in customers/, 'started all the same: a reading of signed out may be wrong');
  env.app.db.run("UPDATE aco_runs SET status = 'failed' WHERE item_id = :i", { i: amazon.id });
  // An alert that's gone, and a button Mugibot didn't make.
  r = await press('d-gary', 'buy:a:999999');
  assert.match(r.content, /That alert is too old to buy from/);
  r = await press('d-gary', 'something-else');
  assert.match(r.content, /That button is from an older message/);
});

test('"Send to my computer" on the buy page (a phone, signed in, no extension): the same, from the website', async () => {
  const r = await gary.post(`/api/aco/remote/${etb.id}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.device.name, 'Gary desktop');
  assert.equal(r.body.run.trigger, 'remote');
  assert.match(r.body.why, /over your max of \$80\.00/);
  const again = await gary.post(`/api/aco/remote/${etb.id}`, {});
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already checking out/);
  finishRuns();
  // The buy page has the button.
  const page = await gary.get(`/buy/${etb.id}`);
  assert.match(page.text, /id="b-remote"/);
});

test("⚡ Buys from Discord that fail don't count towards an armed item's 3 failures a day: its next drop still starts", async () => {
  await gary.put('/api/aco', { mode: 'place', maxOrder: 500, perDay: 10, spendPerDay: 5000 });
  await gary.put(`/api/items/${etb.id}`, { aco: true, maxPrice: 150 });
  for (let i = 0; i < 3; i += 1) {
    await press('d-gary', `buy:i:${etb.id}`);
    const r = await desktop.call('POST', `/api/ext/aco/${runOf(etb.id).id}`, { status: 'failed', reason: 'sold_out' });
    assert.equal(r.status, 200);
  }
  const run = await env.app.aco.trigger(env.app.db.get('SELECT * FROM items WHERE id = :id', { id: etb.id }), { price: 100, source: 'sweep' });
  assert.equal(run.status, 'queued', 'the drop starts');
  assert.equal(run.trigger, 'sweep');
  finishRuns();
});
