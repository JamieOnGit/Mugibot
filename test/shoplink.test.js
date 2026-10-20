// Shop checkout links (server/retailers/shoplink.js): a store's own cart link — /cart/<variant>:<qty>,… —
// at a store that checks out with Shop. Watched option by option (the store's /variants/<id>.js), in
// stock once every one is, its price the link's; armed, Auto-checkout opens the link itself, which goes
// to Shop's checkout. Signed out of Shop (it goes to the store's guest checkout instead), it doesn't
// start; a run whose tab never reached Shop's checkout says so. Never a real store: the dummy store's
// Mattel Creations-style shop and Shop-style checkout.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, makeMember, startApp } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { extensionManifest } from '../server/extension.js';

const PORSCHE = 48835830579405;
const RLC = 40653613531341;
const MATTEL = 'https://creations.mattel.com/cart/48835830579405:2,40653613531341:1';

let env;
let store;
let ash;
let desk;

before(async () => {
  store = await startMockStore();
  env = await startApp({ demoStoreUrl: store.url, allowPrivateHosts: true, hostGapSeconds: 0 });
  ash = await Client.signup(env.url, 'ash');
  makeMember(env, ash);
  for (const it of (await ash.get('/api/items')).body.items) await ash.del(`/api/items/${it.id}`);
  desk = await Device.pair(env.url, ash, 'Ash desktop');
  await desk.call('GET', '/api/ext/me?v=1.27.1');
  const r = await ash.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 200, perDay: 6, spendPerDay: 900 });
  assert.equal(r.status, 200, r.text);
});
after(async () => {
  await env.close();
  await store.close();
});

const runsOf = (itemId) => env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i ORDER BY created_at DESC', { i: itemId });
const finishRuns = () => env.app.db.run("UPDATE aco_runs SET status = 'failed' WHERE status IN ('queued', 'sent', 'started', 'waiting', 'checkout', 'placing')");
const checkLink = (url) => env.app.monitor.checkPage(url);

/** It sells out, then it's back: the monitor's checks see both. */
async function drop(url) {
  for (const id of [PORSCHE, RLC]) store.setVariant(id, { available: false });
  await checkLink(url);
  for (const id of [PORSCHE, RLC]) store.setVariant(id, { available: true });
  await checkLink(url);
}

test('🛍️ a store\'s checkout link is a Shop checkout link — its options and quantities are the item; a store Mugibot knows keeps its own; a Shop page isn\'t one', async () => {
  const R = env.app.retailers;
  assert.equal(R.forUrl(MATTEL).id, 'shoplink');
  assert.equal(R.skuFromUrl(MATTEL), '48835830579405:2,40653613531341:1');
  assert.equal(R.forUrl('https://creations.mattel.com/cart/48835830579405:1').id, 'shoplink');
  assert.equal(R.forUrl('https://www.jbhifi.com.au/cart/4455667788:1').id, 'jbhifi', "JB Hi-Fi's own cart link is JB Hi-Fi's");
  assert.equal(R.forUrl('https://creations.mattel.com/products/rlc-porsche'), null, 'a product page at a store Mugibot doesn\'t know: another website');
  assert.equal(R.forUrl(store.cartLink([[PORSCHE, 1]])).id, 'demo-shoplink', "the dummy store's link: the dummy Shop");
  assert.equal(R.siteName('shoplink', MATTEL), 'creations.mattel.com · Shop');

  let r = await ash.post('/api/items', { url: 'https://shop.app/checkout/56811323597/cn/abc/en-us/shoppay', maxPrice: 50 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /store's own link/);
  r = await ash.post('/api/items', { store: 'shoplink', sku: '48835830579405:2' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /checkout link/);
  r = await ash.post('/api/items', { url: MATTEL, maxPrice: 100, aco: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.store, 'shoplink');
  assert.equal(r.body.sku, '48835830579405:2,40653613531341:1');
  assert.equal(r.body.name, 'Checkout link at creations.mattel.com');
  assert.equal(r.body.storeName, 'creations.mattel.com · Shop');
  assert.equal(r.body.shopLink, true);
  assert.equal(r.body.acoCan, true);
  assert.equal(r.body.acoPlaces, true, "Auto-checkout presses Shop's \"Pay now\"");
  assert.equal(r.body.acoVersion, '1.27.1');
  await ash.del(`/api/items/${r.body.id}`);

  // The extension runs on Shop's checkout, and knows each link is its own order.
  assert.ok(extensionManifest(env.app.cfg).host_permissions.includes('https://shop.app/*'));
  const flow = R.forExtension().find((x) => x.id === 'shoplink');
  assert.equal(flow.cartLinks, true);
  assert.equal(flow.flow.checkout.leaves, true);
  // In the store picker? Only by its link.
  assert.equal((await ash.get('/api/retailers')).body.retailers.find((x) => x.id === 'shoplink').cartLinks, true);
  // Clear cart has no Shop bag (there's none behind a link).
  assert.ok(!env.app.bags.storeList().some((x) => x.cartLinks));
  // Shop's sign-in, on the login monitor's list: required (no guest checkout through it).
  const shop = (await ash.get('/api/logins')).body.stores.find((x) => x.id === 'shoplink');
  assert.equal(shop.required, true);
  assert.equal(shop.cartLinks, true);
  assert.equal(shop.signInUrl, 'https://shop.app/account');
});

test("🛍️ watched option by option (the store's /variants/<id>.js, asked honestly as Mugibot): sold out while one is; in stock once every one is, its price the link's — armed, Auto-checkout opens the link itself", async () => {
  const link = store.cartLink([[PORSCHE, 2], [RLC, 1]]);
  const add = await ash.post('/api/items', { url: link, name: 'RLC Porsche ×2 + membership', maxPrice: 90, aco: true });
  assert.equal(add.status, 200, add.text);
  const item = add.body;
  assert.equal(item.store, 'demo-shoplink');
  // Checked more often than the default minute: what these links are for goes in moments.
  assert.ok(env.app.monitor.pageInterval(link) <= 5000, `every 5 seconds at most (${env.app.monitor.pageInterval(link)} ms)`);

  store.state.requests.length = 0;
  store.setVariant(RLC, { available: false });
  await checkLink(link);
  let it = (await ash.get('/api/items')).body.items.find((x) => x.id === item.id);
  assert.equal(it.status, 'out_of_stock', 'one option sold out: the link can\'t be bought');
  const asked = store.state.requests.filter((x) => /^\/creations\/variants\/\d+\.js$/.test(x.path));
  assert.deepEqual(asked.map((x) => x.path).sort(), [`/creations/variants/${RLC}.js`, `/creations/variants/${PORSCHE}.js`].sort());
  assert.ok(asked.every((x) => /^Mugibot\//.test(x.ua)), 'as Mugibot, honestly');
  assert.ok(!store.state.requests.some((x) => x.path.startsWith('/creations/cart')), 'the link itself is never opened by the server (it would start a checkout)');
  assert.equal(runsOf(item.id).length, 0);

  store.setVariant(RLC, { available: true });
  await checkLink(link);
  it = (await ash.get('/api/items')).body.items.find((x) => x.id === item.id);
  assert.equal(it.status, 'in_stock');
  assert.equal(it.lastPrice, 85.99, '$38 × 2 + $9.99');
  assert.equal(it.title, 'Hot Wheels RLC Exclusive RWB Porsche 930 ×2 + Hot Wheels Red Line Club 1-Year Digital Membership');
  const [run] = runsOf(item.id);
  assert.ok(run, 'armed: a run');
  assert.equal(run.status, 'queued');
  assert.equal(run.price, 85.99);
  // The checkout browser opens the link itself (Shop's checkout, from it), with the run's ⚡ Buy code.
  const next = (await desk.call('GET', '/api/ext/aco/next')).body;
  assert.equal(next.runs.length, 1);
  assert.equal(next.runs[0].url.split('#')[0], link);
  assert.match(next.runs[0].storeName, /^Shop\b/);
  const code = new URL(next.runs[0].url).hash.replace('#mgb-go=', '');
  const claim = await desk.call('POST', '/api/ext/claim', { code });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.aco.runId, run.id);
  assert.equal(claim.body.aco.maxTotal, 130, 'its max, plus up to $40 delivery');
  finishRuns();
  await ash.del(`/api/items/${item.id}`);
});

test("🛍️ Shop sign-in: an older extension's reading of Shop's account page (its source says \"Sign in to your account\" either way) is left out; a run starts whatever was seen last — signed out, it finds out in seconds, buying nothing; each link says how its checkout last opened", async () => {
  const link = store.cartLink([[PORSCHE, 1]]);
  const item = (await ash.post('/api/items', { url: link, name: 'RLC Porsche', maxPrice: 60, aco: true })).body;
  const shopLogin = async () => (await ash.get('/api/logins')).body.stores.find((x) => x.id === 'demo-shoplink');
  const seen = async () => (await ash.get('/api/items')).body.items.find((x) => x.id === item.id).shopSeen;
  assert.equal(await seen(), null, 'not opened yet');
  // An extension before 1.24.0 read Shop's account page and took it for signed out: not believed.
  let r = await desk.call('POST', '/api/ext/logins', { logins: { 'demo-shoplink': { status: 'out', at: Date.now(), how: 'check' } } });
  assert.equal(r.status, 200);
  assert.equal((await shopLogin()).status, null, "a fetched page's reading isn't Shop's");
  await drop(link);
  let [run] = runsOf(item.id);
  assert.equal(run.status, 'queued', `started: ${run.reason} ${run.message}`);
  // Its tab never reaches Shop's checkout (the browser says so, 25 s on): the link says signed out.
  await desk.call('GET', '/api/ext/aco/next');
  r = await desk.call('POST', `/api/ext/aco/${run.id}`, { status: 'needs_you', reason: 'no_shop', message: "Shop's checkout didn't open in this browser" });
  assert.equal(r.status, 200);
  assert.equal(r.body.run.status, 'needs_you');
  assert.equal(r.body.run.reason, 'no_shop');
  assert.equal(r.body.run.reasonText, "Shop's checkout didn't open — this browser isn't signed in to Shop");
  assert.deepEqual([(await seen()).status, (await seen()).how], ['out', 'run']);

  // Seen signed out on a page (that run's browser says so): the next drop still starts — signed in since,
  // unseen, it would otherwise cost the drop.
  await desk.call('POST', '/api/ext/logins', { logins: { 'demo-shoplink': { status: 'out', at: Date.now(), how: 'run' } } });
  assert.equal((await shopLogin()).status, 'out');
  await ash.put(`/api/items/${item.id}`, { aco: true });
  await drop(link);
  [run] = runsOf(item.id);
  assert.equal(run.status, 'queued', `${run.reason}: ${run.message}`);
  // This one reached Shop's checkout (its code taken up there: only signed in does it get that far) — the link
  // says signed in, and a late "never reached" changes nothing.
  const next = (await desk.call('GET', '/api/ext/aco/next')).body;
  const code = new URL(next.runs[0].url).hash.replace('#mgb-go=', '');
  assert.equal((await desk.call('POST', '/api/ext/claim', { code })).status, 200);
  assert.deepEqual([(await seen()).status, (await seen()).how], ['in', 'run']);
  r = await desk.call('POST', `/api/ext/aco/${run.id}`, { status: 'needs_you', reason: 'no_shop', message: 'late' });
  assert.equal(r.body.run.status, 'started', 'left as it is');
  assert.equal((await seen()).status, 'in');
  finishRuns();
  await ash.del(`/api/items/${item.id}`);
});

test("🛍️ not on sale yet at the checkout (\"not available for purchase\" to \"Pay now\"): the run waits there — said once, after the press too — and pressing again when it's live places it; still not on sale at the end, nothing's bought and it's armed again", async () => {
  const link = store.cartLink([[PORSCHE, 1]]);
  const item = (await ash.post('/api/items', { url: link, name: 'RLC Porsche (not live)', maxPrice: 60, aco: true })).body;
  const ashId = env.app.repo.userByUsername('ash').id;
  await drop(link);
  let [run] = runsOf(item.id);
  await desk.call('GET', '/api/ext/aco/next');
  const say = (body) => desk.call('POST', `/api/ext/aco/${run.id}`, body);
  await say({ status: 'checkout', message: "At Shop's checkout" });
  await say({ status: 'placing', message: 'Pressing "Pay now"', total: 70 });
  let r = await say({ status: 'waiting', reason: 'not_live', message: 'Shop says "This Product is not available for purchase" — not on sale yet' });
  assert.equal(r.body.run.status, 'waiting', 'from "placing": the store said no');
  assert.equal(r.body.run.reason, 'not_live');
  assert.equal(r.body.run.active, true);
  const dms = () => env.app.repo.listEvents(ashId, { limit: 500 }).filter((e) => /Not on sale yet at checkout/.test(JSON.stringify(e)));
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(dms().length, 1, 'told once');
  // Pressed again once the notice went — refused again (it came back): not told again. Then it's live: placed.
  await say({ status: 'placing', message: 'Pressing "Pay now"', total: 70 });
  await say({ status: 'waiting', reason: 'not_live', message: 'Shop says "This Product is not available for purchase" — not on sale yet' });
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(dms().length, 1, 'still once');
  await say({ status: 'placing', message: 'Pressing "Pay now"', total: 70 });
  r = await say({ status: 'placed', message: 'Order placed', total: 70 });
  assert.equal(r.body.run.status, 'placed');
  assert.equal((await ash.get('/api/items')).body.items.find((x) => x.id === item.id).aco, false, 'one purchase per arming');

  // Another: still not on sale when the browser gives up — nothing bought, armed again.
  await ash.put(`/api/items/${item.id}`, { aco: true });
  await drop(link);
  [run] = runsOf(item.id);
  await desk.call('GET', '/api/ext/aco/next');
  await say({ status: 'placing', message: 'Pressing "Pay now"', total: 70 });
  await say({ status: 'waiting', reason: 'not_live', message: 'not on sale yet' });
  r = await say({ status: 'failed', reason: 'not_live', message: 'Shop still says "This Product is not available for purchase" after 30 minutes — nothing was bought' });
  assert.equal(r.body.run.status, 'failed');
  assert.equal((await ash.get('/api/items')).body.items.find((x) => x.id === item.id).aco, true, 'armed again');
  // …and one still waiting long after (its browser lost): the server ends it the same way.
  await drop(link);
  [run] = runsOf(item.id);
  await desk.call('GET', '/api/ext/aco/next');
  await say({ status: 'placing', message: 'Pressing "Pay now"', total: 70 });
  await say({ status: 'waiting', reason: 'not_live', message: 'not on sale yet' });
  // (Not after 2 hours — a queue's limit — nor 3: a run started the evening before a 3AM drop keeps waiting.)
  env.app.db.run('UPDATE aco_runs SET created_at = created_at - 3 * 60 * 60 * 1000 WHERE id = :id', { id: run.id });
  env.app.aco.expire();
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(env.app.db.get('SELECT status FROM aco_runs WHERE id = :id', { id: run.id }).status, 'waiting', 'still waiting 3 hours on');
  env.app.db.run('UPDATE aco_runs SET created_at = created_at - 5.6 * 60 * 60 * 1000 WHERE id = :id', { id: run.id });
  env.app.aco.expire();
  await new Promise((res) => setTimeout(res, 50));
  run = env.app.db.get('SELECT * FROM aco_runs WHERE id = :id', { id: run.id });
  assert.equal(run.status, 'failed');
  assert.equal(run.reason, 'not_live');
  assert.match(run.message, /still said it isn't on sale — nothing was bought, and it's armed again/);
  assert.equal((await ash.get('/api/items')).body.items.find((x) => x.id === item.id).aco, true);
  finishRuns();
  await ash.del(`/api/items/${item.id}`);
});

test("🛍️ not on sale yet, \"Pay now\" pressed again every couple of seconds (live presses): the run stays waiting for the sale — one step for the presses, its count kept up to date, Stop from your account heard at the next press — and its browser lost after a press, it's needs-you (the last press may have gone through), never armed again", async () => {
  const link = store.cartLink([[PORSCHE, 1]]);
  const item = (await ash.post('/api/items', { url: link, name: 'RLC Porsche (pressing)', maxPrice: 60, aco: true })).body;
  await drop(link);
  let [run] = runsOf(item.id);
  await desk.call('GET', '/api/ext/aco/next');
  const say = (body) => desk.call('POST', `/api/ext/aco/${run.id}`, body);
  await say({ status: 'checkout', message: "At Shop's checkout" });
  await say({ status: 'placing', message: 'Pressing "Pay now" — total $70.00', total: 70 });
  await say({ status: 'waiting', reason: 'not_live', message: 'Shop says "This Product is not available for purchase" — not on sale yet' });
  let r;
  for (let n = 2; n <= 6; n++) r = await say({ status: 'placing', live: true, again: true, message: `Pressing "Pay now" again (${n}) — Shop says it isn't on sale yet (for 0 min)`, total: 70 });
  assert.equal(r.body.run.status, 'waiting', 'still waiting for the sale');
  assert.equal(r.body.run.reason, 'not_live');
  assert.equal(r.body.run.active, true);
  assert.equal(r.body.run.statusText, 'Not on sale yet — pressing "Pay now"');
  const presses = r.body.run.steps.filter((x) => /Pressing "Pay now" again/.test(x.message));
  assert.equal(presses.length, 1, 'one step for them');
  assert.match(presses[0].message, /again \(6\)/, 'its count up to date');
  assert.equal(presses[0].status, 'placing');
  assert.equal((await ash.get('/api/items')).body.items.find((x) => x.id === item.id).aco, false, 'the arming used up while it presses');
  // Its browser lost (nothing heard for 10 minutes) after a press: for you to check, never armed again.
  env.app.db.run('UPDATE aco_runs SET updated_at = updated_at - 11 * 60 * 1000 WHERE id = :id', { id: run.id });
  env.app.aco.expire();
  await new Promise((res) => setTimeout(res, 50));
  run = env.app.db.get('SELECT * FROM aco_runs WHERE id = :id', { id: run.id });
  assert.equal(run.status, 'needs_you');
  assert.equal(run.reason, 'unconfirmed');
  assert.match(run.message, /pressing "Pay now" .* check your email/);
  assert.equal((await ash.get('/api/items')).body.items.find((x) => x.id === item.id).aco, false);
  // A closed run refuses the next press: the browser stops pressing.
  r = await say({ status: 'placing', live: true, again: true, message: 'Pressing "Pay now" again (7) — Shop says it isn\'t on sale yet (for 11 min)', total: 70 });
  assert.equal(r.body.run.active, false);
  assert.equal(env.app.db.get('SELECT status FROM aco_runs WHERE id = :id', { id: run.id }).status, 'needs_you');
  finishRuns();
  await ash.del(`/api/items/${item.id}`);
});

test('🛍️ a checkout browser with an extension older than 1.27.1 (one that can\'t find Mattel\'s "Pay now $47.99", nor tick its membership box, and doesn\'t press "Pay now" while it says "not available"): not started — it says to update; Discord\'s ⚡ Buy says so too', async () => {
  const link = store.cartLink([[RLC, 1]]);
  const item = (await ash.post('/api/items', { url: link, name: 'RLC membership', maxPrice: 20, aco: true })).body;
  await desk.call('GET', '/api/ext/me?v=1.27.0');
  try {
    await drop(link);
    const [run] = runsOf(item.id);
    assert.equal(run.status, 'skipped');
    assert.equal(run.reason, 'old_extension');
    assert.match(run.message, /Ash desktop has 1\.27\.0 — update it to 1\.27\.1/);
    await ash.put('/api/aco', { remoteBuy: true });
    const out = await env.app.aco.remote(env.app.repo.userByUsername('ash').id, item.id);
    assert.match(out.error, /update it to 1\.27\.1 to buy from Shop/);
  } finally {
    await desk.call('GET', '/api/ext/me?v=1.27.1');
    finishRuns();
    await ash.del(`/api/items/${item.id}`);
  }
});

test('🛍️🚦🏷️ Wait for queue, then ACO, and a discount code: a run of its own that places the order, its pass saying so (the link to open again) and carrying the code; only while Auto-checkout places the order', async () => {
  const link = store.cartLink([[PORSCHE, 1]]);
  const item = (await ash.post('/api/items', { url: link, name: 'RLC Porsche (queue)', maxPrice: 60, discount: ' rlc 10 ' })).body;
  assert.equal(item.discount, 'rlc10', 'kept without its spaces');
  assert.equal((await ash.put(`/api/items/${item.id}`, { aco: true })).body.discount, 'rlc10', 'kept when the link is armed');
  let r = await ash.post(`/api/aco/test/${item.id}`, { queue: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.run.trigger, 'queue');
  const ashId = env.app.repo.userByUsername('ash').id;
  const pass = env.app.aco.passFor(ashId, env.app.db.get('SELECT * FROM aco_runs WHERE id = :id', { id: r.body.run.id }));
  assert.equal(pass.queue, true);
  assert.equal(pass.url, link);
  assert.equal(pass.discount, 'rlc10');
  finishRuns();
  // An ordinary run of it: the code, but no looking for the queue.
  r = await ash.post(`/api/aco/test/${item.id}`);
  const plain = env.app.aco.passFor(ashId, env.app.db.get('SELECT * FROM aco_runs WHERE id = :id', { id: r.body.run.id }));
  assert.equal(plain.queue, undefined);
  assert.equal(plain.discount, 'rlc10');
  finishRuns();
  // The code cleared: none.
  assert.equal((await ash.put(`/api/items/${item.id}`, { discount: '' })).body.discount, '');
  // Only while Auto-checkout places the order (it presses "Pay now").
  await ash.put('/api/aco', { mode: 'fill' });
  r = await ash.post(`/api/aco/test/${item.id}`, { queue: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Place the order for me/);
  await ash.put('/api/aco', { mode: 'place' });
  finishRuns();
  await ash.del(`/api/items/${item.id}`);
});

test('■ Stop on the dashboard: a run still going ends at once — "Pay now" pressed already (turned away: not on sale), for you to check; its browser told on its next ask, and its next press refused; not pressed yet, nothing bought — never counted as a drop that failed', async () => {
  const link = store.cartLink([[PORSCHE, 1]]);
  const item = (await ash.post('/api/items', { url: link, name: 'RLC Porsche (stop)', maxPrice: 60, aco: true })).body;
  const ashId = env.app.repo.userByUsername('ash').id;
  await drop(link);
  let [run] = runsOf(item.id);
  await desk.call('GET', '/api/ext/aco/next');
  const say = (body) => desk.call('POST', `/api/ext/aco/${run.id}`, body);
  await say({ status: 'checkout', message: "At Shop's checkout" });
  await say({ status: 'placing', message: 'Pressing "Pay now"', total: 70 });
  await say({ status: 'waiting', reason: 'not_live', message: 'Shop says "This Product is not available for purchase" — not on sale yet' });
  const dms = () => env.app.repo.listEvents(ashId, { limit: 500 }).filter((e) => /RLC Porsche \(stop\)/.test(JSON.stringify(e)) && /needs you|didn't buy/i.test(JSON.stringify(e))).length;
  const before = dms();
  let r = await ash.post(`/api/aco/runs/${run.id}/stop`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.run.status, 'needs_you');
  assert.equal(r.body.run.reason, 'stopped');
  assert.equal(r.body.run.active, false);
  assert.match(r.body.run.message, /You stopped it on your dashboard.*turned away: not on sale yet.*check your email/);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(dms(), before, 'no DM for what you did yourself');
  r = await desk.call('GET', '/api/ext/aco/next');
  assert.ok(r.body.stops.includes(run.id), 'its browser told');
  r = await say({ status: 'placing', live: true, again: true, message: 'Pressing "Pay now" again (2) — not on sale yet', total: 70 });
  assert.equal(r.body.run.active, false, 'its next press refused');
  assert.equal(env.app.db.get('SELECT status FROM aco_runs WHERE id = :id', { id: run.id }).status, 'needs_you');
  // Not pressed yet: nothing bought, and it isn't a failed drop (3 a day disarm an item).
  await ash.put(`/api/items/${item.id}`, { aco: true });
  await drop(link);
  [run] = runsOf(item.id);
  r = await ash.post(`/api/aco/runs/${run.id}/stop`);
  assert.equal(r.body.run.status, 'failed');
  assert.match(r.body.run.message, /nothing was bought/);
  assert.equal((await ash.get('/api/items')).body.items.find((x) => x.id === item.id).aco, true, 'still armed');
  for (let i = 0; i < 3; i++) env.app.db.run("INSERT INTO aco_runs (id, user_id, item_id, store, sku, name, url, mode, trigger, status, reason, message, steps, created_at, updated_at) VALUES (:id, :u, :i, 'demo-shoplink', 'x', 'x', '', 'place', 'server', 'failed', 'stopped', '', '[]', :t, :t)", { id: `acr_stop${i}`, u: ashId, i: item.id, t: Date.now() });
  await drop(link);
  assert.notEqual(runsOf(item.id)[0].reason, 'too_many_failures', 'stopped runs never count as failed drops');
  // Stopped again: as it was. Not yours: not found.
  assert.equal((await ash.post(`/api/aco/runs/${run.id}/stop`)).body.run.status, 'failed');
  assert.equal((await ash.post('/api/aco/runs/acr_nope/stop')).status, 404);
  finishRuns();
  await ash.del(`/api/items/${item.id}`);
});

test('⏰ 🚦 Wait for queue, then ACO at a time you pick: set (checked now as it will be then), its browser kept listening, started by itself when due — once — and cancellable; one that can\'t start then is said, not started', async () => {
  const link = store.cartLink([[PORSCHE, 1]]);
  const item = (await ash.post('/api/items', { url: link, name: 'RLC Porsche (scheduled)', maxPrice: 60 })).body;
  const ashId = env.app.repo.userByUsername('ash').id;
  const at = Date.now() + 5 * 60 * 1000;
  let r = await ash.post(`/api/items/${item.id}/queue-at`, { at });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.item.queueAt, at);
  assert.equal((await ash.get('/api/items')).body.items.find((x) => x.id === item.id).queueAt, at);
  // Its browser listens meanwhile (nothing armed).
  r = await desk.call('GET', '/api/ext/aco/next');
  assert.equal(r.body.scheduled, 1);
  // Not yet: nothing started.
  assert.equal(await env.app.aco.startScheduled(), 0);
  assert.equal(runsOf(item.id).length, 0);
  // Due: started once, as the button would.
  env.app.db.run('UPDATE items SET queue_at = :t WHERE id = :id', { t: Date.now() - 1000, id: item.id });
  assert.equal(await env.app.aco.startScheduled(), 1);
  let runs = runsOf(item.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, 'queue');
  assert.equal(runs[0].status, 'queued');
  assert.equal((await ash.get('/api/items')).body.items.find((x) => x.id === item.id).queueAt, null, 'used up');
  assert.equal(await env.app.aco.startScheduled(), 0, 'once');
  finishRuns();
  // Cancelled: never starts.
  await ash.post(`/api/items/${item.id}/queue-at`, { at: Date.now() + 60 * 60 * 1000 });
  r = await ash.post(`/api/items/${item.id}/queue-at`, { at: null });
  assert.equal(r.body.item.queueAt, null);
  // Checked as it will be then: a time gone, or too far off; Auto-checkout not placing the order.
  assert.equal((await ash.post(`/api/items/${item.id}/queue-at`, { at: Date.now() - 1000 })).status, 409);
  assert.equal((await ash.post(`/api/items/${item.id}/queue-at`, { at: Date.now() + 8 * 86400000 })).status, 409);
  await ash.put('/api/aco', { mode: 'fill' });
  r = await ash.post(`/api/items/${item.id}/queue-at`, { at: Date.now() + 60 * 60 * 1000 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Place the order for me/);
  // Set while placing, then switched to stop at the final button before it's due: said, not started.
  await ash.put('/api/aco', { mode: 'place' });
  await ash.post(`/api/items/${item.id}/queue-at`, { at: Date.now() + 60 * 60 * 1000 });
  await ash.put('/api/aco', { mode: 'fill' });
  env.app.db.run('UPDATE items SET queue_at = :t WHERE id = :id', { t: Date.now() - 1000, id: item.id });
  await env.app.aco.startScheduled();
  assert.equal(runsOf(item.id).length, 1, 'not started');
  assert.ok(env.app.repo.listEvents(ashId, { limit: 200 }).some((e) => /didn't start at the time you picked.*Place the order for me/.test(e.message)));
  await ash.put('/api/aco', { mode: 'place' });
  finishRuns();
  await ash.del(`/api/items/${item.id}`);
});

test("🛍️ a link whose option the store doesn't sell any more: not found (said, never alerted as a restock)", async () => {
  const link = `${store.url}/creations/cart/123456789:1`;
  const item = (await ash.post('/api/items', { url: link, name: 'Gone' })).body;
  await checkLink(link);
  const it = (await ash.get('/api/items')).body.items.find((x) => x.id === item.id);
  assert.equal(it.status, 'not_found');
  assert.match(it.error, /isn't at the store any more/);
  await ash.del(`/api/items/${item.id}`);
});
