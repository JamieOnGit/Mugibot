// The SKU monitor against the dummy stores: one server request per page
// however many people watch it, an honest User-Agent, alerts only to
// watchers with a membership, price limits, a SKU found before it's listed,
// Shopify's product JSON, stores that refuse servers (backed off, never
// evaded, and handed to members' own browsers), switching a store's server
// checks off, announced restocks in the Discord channel, and links that
// would point the server at its own network.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { pathHasSku } from '../server/monitor/index.js';

let env;
let store;
let discord;
let clock;
before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  clock = { offset: 0 };
  // The dummy store runs on this computer, so allow private addresses here (off by default).
  env = await startApp({ urlIntervalSeconds: 60, hostGapSeconds: 0, allowPrivateHosts: true, demoStoreUrl: store.url, now: () => Date.now() + clock.offset, ...discordOpts(discord) });
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});
beforeEach(() => { store.state.blockNonBrowsers = false; });

/** Run the monitor as if `seconds` had passed. */
async function advance(seconds = 61) {
  clock.offset += seconds * 1000;
  // A tick checks at most 4 pages at once; keep going until everything due has been checked.
  let n = 0;
  for (let i = 0; i < 10; i++) {
    const done = await env.app.monitor.tick();
    n += done;
    if (!done) break;
  }
  // (Members' alerts go out while the monitor carries on: done once they're out.)
  await env.app.monitor.delivered();
  return n;
}
const hits = (fragment) => store.state.requests.filter((r) => r.path.includes(fragment)).length;
async function member(name) {
  const c = await Client.signup(env.url, name);
  makeMember(env, c);
  for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`); // no real Kmart SKUs in these tests
  return c;
}
const alerted = (c, name, re = /In stock/) => c.get('/api/events').then((r) => r.body.events.some((e) => e.type === 'restock' && e.level === 'urgent' && e.name === name && re.test(e.message)));

test('one request per page however many watch it; honest User-Agent; alerts only to members watching it, under their price', async () => {
  store.set('ebgames', '312345', { status: 'out_of_stock', listed: true });
  const url = store.productUrl('ebgames', '312345');
  const ash = await member('ash');
  const misty = await member('misty');
  const cheap = await member('cheap'); // only at ≤ $100
  const lapsed = await Client.signup(env.url, 'lapsed'); // not a member
  const other = await member('other'); // watches something else
  await ash.put('/api/alerts', { discordWebhook: 'https://discord.com/api/webhooks/1/ash' });
  for (const c of [ash, misty, cheap, lapsed]) {
    const r = await c.post('/api/items', { url, name: 'OP-18 Box', maxPrice: c === cheap ? 100 : undefined });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.store, 'demo-ebgames');
    assert.equal(r.body.status, 'pending');
  }
  await other.post('/api/items', { url: store.productUrl('ebgames', '312346'), name: 'ETB' });

  const before = hits('/312345-');
  await advance();
  assert.equal(hits('/312345-') - before, 1, 'checked once for four watchers');
  assert.match(store.state.requests.filter((r) => r.path.includes('/312345-')).at(-1).ua, /^Mugibot\/1\.0/, 'identifies itself honestly');
  let w = (await ash.get('/api/items')).body.items[0];
  assert.equal(w.status, 'out_of_stock');
  assert.equal(w.lastPrice, 159);
  assert.equal(w.statusSource, 'server');
  assert.equal((await lapsed.get('/api/items')).body.items[0].status, 'pending', 'not checked for non-members');

  await advance(10);
  assert.equal(hits('/312345-') - before, 1, 'not re-checked before the interval');

  // Restock!
  store.set('ebgames', '312345', { status: 'in_stock' });
  const hooksBefore = env.webhooks.length;
  await advance();
  w = (await ash.get('/api/items')).body.items[0];
  assert.equal(w.status, 'in_stock');
  assert.equal(await alerted(ash, 'OP-18 Box'), true);
  assert.equal(await alerted(misty, 'OP-18 Box'), true);
  assert.equal(await alerted(cheap, 'OP-18 Box'), false, 'over their price limit');
  assert.ok((await cheap.get('/api/events')).body.events.some((e) => /over your limit of \$100\.00/.test(e.message)));
  assert.equal(await alerted(lapsed, 'OP-18 Box'), false, 'no alerts without a membership');
  assert.equal(await alerted(other, 'OP-18 Box'), false, "doesn't watch it");
  assert.equal(env.webhooks.length - hooksBefore, 1, 'only Ash has a webhook');
  const hook = env.webhooks.at(-1).body;
  assert.match(hook.embeds[0].title, /In stock: OP-18 Box/);
  assert.match(hook.embeds[0].description, /⚡ Buy:\*\* http/, 'the ⚡ Buy link is in the webhook message');

  // Stays in stock: no repeat. Sells out and pre-orders open: alerts again.
  await advance();
  assert.equal(env.webhooks.length - hooksBefore, 1);
  store.set('ebgames', '312345', { status: 'out_of_stock' });
  await advance();
  store.set('ebgames', '312345', { status: 'preorder' });
  await advance();
  assert.equal(env.webhooks.length - hooksBefore, 2);
  assert.match(env.webhooks.at(-1).body.embeds[0].title, /Pre-order open/);
});

test("a page check whose shared feed fails partway still sends the watching members' alerts", async () => {
  const url = store.addProduct('ebgames', { sku: '312399', name: 'Feed Fail Booster Box', price: 159, status: 'out_of_stock' });
  const c = await member('feedfail');
  await c.put('/api/alerts', { discordWebhook: 'https://discord.com/api/webhooks/1/feedfail' });
  assert.equal((await c.post('/api/items', { url, name: 'Feed Fail Box' })).status, 200);
  await advance();
  store.set('ebgames', '312399', { status: 'in_stock' });
  // A product of the shared feed on that page, whose update breaks (whatever the reason).
  const { catalog, feed } = env.app;
  catalog.productsForPage = (u) => (u === url ? [{ id: 0 }] : Object.getPrototypeOf(catalog).productsForPage.call(catalog, u));
  feed.applyCheck = async () => { throw new Error('the shared feed broke'); };
  const hooks = env.webhooks.length;
  clock.offset += 61 * 1000;
  try {
    await assert.rejects(env.app.monitor.tick(), /the shared feed broke/);
  } finally {
    delete catalog.productsForPage;
    delete feed.applyCheck;
  }
  assert.ok(env.webhooks.slice(hooks).some((h) => /In stock: Feed Fail Box/.test(h.body.embeds[0].title)), "the member's alert went out all the same");
});

test('a SKU before it is listed: "not listed yet", found on the search page when it goes up, then "listed" and restock pings', async () => {
  store.set('bigw', '6012345', { listed: false, status: 'out_of_stock' });
  const c = await member('early');
  const r = await c.post('/api/items', { store: 'demo-bigw', sku: '6012345', name: 'BIG W UPC', quantity: 2 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.url, '', 'no link yet');
  await advance();
  let it = (await c.get('/api/items')).body.items[0];
  assert.equal(it.status, 'not_listed');
  assert.ok(hits('/bigw/search') >= 1, 'looked on the store\'s search page');

  store.set('bigw', '6012345', { listed: true });
  await advance(); // search finds it
  it = (await c.get('/api/items')).body.items[0];
  assert.equal(it.url, store.productUrl('bigw', '6012345'), 'the product page was found from the SKU');
  await advance(); // reads the product page
  it = (await c.get('/api/items')).body.items[0];
  assert.equal(it.status, 'out_of_stock');
  assert.ok((await c.get('/api/events')).body.events.some((e) => e.type === 'listed' && /Listed: BIG W UPC/.test(e.message)), 'listed ping');

  store.set('bigw', '6012345', { status: 'in_stock' });
  await advance();
  assert.equal(await alerted(c, 'BIG W UPC'), true);
});

test('Shopify stores: the product JSON is used (light on the store)', async () => {
  const c = await member('shopper');
  const r = await c.post('/api/items', { store: 'demo-jbhifi', sku: 'pokemon-tcg-30th-celebration-upc', name: 'JB UPC' });
  assert.equal(r.body.url, store.productUrl('jbhifi', 'pokemon-tcg-30th-celebration-upc'), 'a Shopify link is built from the handle');
  const before = hits('pokemon-tcg-30th-celebration-upc.js');
  await advance();
  assert.equal(hits('pokemon-tcg-30th-celebration-upc.js') - before, 1);
  assert.equal((await c.get('/api/items')).body.items[0].status, 'out_of_stock');
  store.set('jbhifi', 'pokemon-tcg-30th-celebration-upc', { status: 'in_stock' });
  await advance();
  assert.equal((await c.get('/api/items')).body.items[0].status, 'in_stock');
  assert.equal(await alerted(c, 'JB UPC'), true);
});

test('a store that refuses server checks: marked, backed off — and members\' browsers take over for their own SKUs', async () => {
  store.set('kmart', '43818648', { status: 'out_of_stock', listed: true });
  const c = await member('kmartfan');
  const r = await c.post('/api/items', { url: store.productUrl('kmart', '43818648'), name: 'Dummy UPC' });
  store.state.blockNonBrowsers = true;
  await advance();
  let it = (await c.get('/api/items')).body.items[0];
  assert.match(it.error, /refused the server check/);
  const page = env.app.db.get('SELECT * FROM page_checks WHERE url = :u', { u: it.url });
  assert.equal(page.fail_count, 1);
  assert.ok(page.next_check_at - (Date.now() + clock.offset) > 60 * 1000, 'waits longer than usual before trying again');
  assert.match(store.state.requests.at(-1).ua, /^Mugibot/, 'still says who it is');

  // The member's browser is asked to check it instead.
  const device = await Device.pair(env.url, c);
  const due = (await device.call('GET', '/api/ext/checks')).body.checks;
  assert.equal(due.length, 1);
  assert.equal(due[0].id, it.id);
  assert.equal(due[0].url, it.url);
  assert.equal((await device.call('GET', '/api/ext/checks')).body.checks.length, 0, 'leased: not handed out twice');
  await device.call('POST', '/api/ext/checks', { results: [{ id: it.id, status: 'in_stock', price: 360, title: 'Dummy UPC' }] });
  it = (await c.get('/api/items')).body.items[0];
  assert.equal(it.status, 'in_stock');
  assert.equal(it.statusSource, 'browser');
  assert.equal(await alerted(c, 'Dummy UPC'), true, 'restock ping from the browser check');

  // The server is still refused: that doesn't overwrite what the browser just saw.
  for (let i = 0; i < 3; i++) await advance(3600);
  it = (await c.get('/api/items')).body.items[0];
  assert.equal(env.app.db.get('SELECT status FROM page_checks WHERE url = :u', { u: it.url }).status, 'blocked');
  // The item follows the browser while its checks are fresh (3 minutes); hours later the server's "blocked" shows.
  assert.equal(it.status, 'blocked');

  // Browser checks switched off: nothing is handed out.
  await c.put('/api/alerts', { browserChecks: false });
  env.app.db.run('UPDATE items SET browser_next_at = 0 WHERE id = :id', { id: it.id });
  assert.equal((await device.call('GET', '/api/ext/checks')).body.checks.length, 0);
  await c.put('/api/alerts', { browserChecks: true });

  store.state.blockNonBrowsers = false;
  await advance(3600);
  assert.equal(env.app.db.get('SELECT status FROM page_checks WHERE url = :u', { u: it.url }).status, 'out_of_stock', 'recovers when the store answers again');
});

test('an admin switches a store\'s server checks off: no server requests, browsers check instead', async () => {
  const boss = await Client.signup(env.url, 'boss');
  env.app.repo.updateUser(boss.user.id, { role: 'admin' });
  assert.equal((await boss.put('/api/admin/retailers/demo-ebgames', { serverChecks: false })).status, 200);
  const c = await member('ebfan');
  const r = await c.post('/api/items', { url: store.productUrl('ebgames', '312346'), name: 'EB ETB' });
  const before = hits('/312346-');
  await advance();
  assert.equal(hits('/312346-'), before, 'the server left it alone');
  const device = await Device.pair(env.url, c);
  const due = (await device.call('GET', '/api/ext/checks')).body.checks;
  assert.ok(due.some((x) => x.id === r.body.id));
  await boss.put('/api/admin/retailers/demo-ebgames', { serverChecks: true });
  assert.ok(env.app.repo.listAudit().some((a) => a.action === 'retailer'));
});

test("BIG W (its bot protection resets every server's connection): the server never asks it, whatever an admin saved; the \"Error\" its old tries left is forgotten; members' browsers read each product by opening its page — one BIG W page a round from a copy older than 1.39.0, within the store's budget (monitor/access.js: in an ordinary window, 20 s between two of its pages), every item in turn — and only an extension that does (1.27.0) is asked", async () => {
  const real = env.app.retailers.get('bigw');
  assert.equal(real.monitor.server, 'never');
  assert.equal(real.monitor.render, true);
  env.app.repo.setSetting('retailer:bigw', { serverChecks: true });
  assert.equal(env.app.retailers.settings(real).serverChecks, false, "an admin's old switch doesn't put the server back on it");
  env.app.repo.setSetting('retailer:bigw', {});

  // What the server's tries said before ("Error" on every BIG W item): forgotten when the monitor starts.
  const c = await member('bigwfan');
  const real1 = (await c.post('/api/items', { url: 'https://www.bigw.com.au/product/pokemon-tcg-test/p/6099001', name: 'Real BIG W' })).body;
  env.app.db.run("UPDATE items SET status = 'error', error = 'HTTP/2 stream error', status_source = 'server' WHERE id = :id", { id: real1.id });
  const kept = (await c.post('/api/items', { url: 'https://www.bigw.com.au/product/pokemon-tcg-kept/p/6099002', name: 'Seen by a browser' })).body;
  env.app.db.run("UPDATE items SET status = 'blocked', error = 'refused your browser', status_source = 'browser' WHERE id = :id", { id: kept.id });
  env.app.monitor.forgetServerFailures();
  const row = (id) => env.app.db.get('SELECT status, error FROM items WHERE id = :id', { id });
  assert.deepEqual(row(real1.id), { status: 'pending', error: '' });
  assert.equal(row(kept.id).status, 'blocked', "a browser's own reading stays");
  for (const it of [real1, kept]) await c.del(`/api/items/${it.id}`);

  // The dummy BIG W, as the real one: its pages opened by members' browsers.
  env.app.repo.setSetting('retailer:demo-bigw', { serverChecks: false });
  try {
    const a = (await c.post('/api/items', { url: store.productUrl('bigw', '6012345'), name: 'BIG W UPC' })).body;
    const b = (await c.post('/api/items', { url: store.productUrl('bigw', '6012346'), name: 'BIG W Bundle' })).body;
    const before = hits('/bigw/product/');
    await advance();
    assert.equal(hits('/bigw/product/'), before, 'the server left it alone');
    const old = await Device.pair(env.url, c, 'Old copy');
    await old.call('GET', '/api/ext/me?v=1.26.0');
    assert.ok(!(await old.call('GET', '/api/ext/checks')).body.checks.some((x) => x.store === 'demo-bigw'), 'an older extension would ask for the page in the background: not asked');
    const device = await Device.pair(env.url, c, 'New copy');
    await device.call('GET', '/api/ext/me?v=1.27.0');
    const round = async () => (await device.call('GET', '/api/ext/checks')).body.checks.filter((x) => x.store === 'demo-bigw');
    const first = await round();
    assert.equal(first.length, 1, 'one BIG W page a round');
    assert.equal(first[0].render, true, 'opened in the extension\'s window, as you would');
    assert.equal(first[0].privateWindow, true, '…its private one, where the browser allows it');
    // (Not in a private window here — the browser didn't say it can: 20 s between two of its pages.)
    clock.offset += 19 * 1000;
    assert.equal((await round()).length, 0, 'not before the gap');
    clock.offset += 2 * 1000;
    const second = await round();
    assert.equal(second.length, 1);
    assert.deepEqual([first[0].id, second[0].id].sort(), [a.id, b.id].sort(), 'the other one\'s turn');
    assert.equal((await round()).length, 0, 'one of its pages at a time, the gap between');
    clock.offset += 21 * 1000;
    assert.equal((await round())[0].id, first[0].id, 'and round again: each asked for every 5 s, the budget deciding');
    // Seen by a live search just now: nothing more to open — its turn pushed back.
    env.app.db.run("UPDATE items SET status_source = 'sweep', checked_at = :t, browser_next_at = 0 WHERE user_id = :u", { t: env.app.repo.now(), u: c.user.id });
    assert.equal((await round()).length, 0, 'a fresh live-search reading: no page opened');
  } finally {
    env.app.repo.setSetting('retailer:demo-bigw', {});
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  }
});

test("BIG W's product pages in a browser that opens them in a private window of its own (allowed in Incognito), within the store's budget (monitor/access.js): 8 s between two of its pages there (20 s in an ordinary window); a copy that waits the gap itself (1.39.0) gets two a round, the gap to wait and the slot it booked, an older one one; each read asks again in 5 s, every item in turn", async () => {
  const c = await member('bigwpriv');
  env.app.repo.setSetting('retailer:demo-bigw', { serverChecks: false });
  try {
    const a = (await c.post('/api/items', { url: store.productUrl('bigw', '6012345'), name: 'BIG W UPC' })).body;
    const b = (await c.post('/api/items', { url: store.productUrl('bigw', '6012346'), name: 'BIG W Bundle' })).body;
    const d = (await c.post('/api/items', { url: `${store.url}/bigw/product/pokemon-tcg-tin/p/6012347`, name: 'BIG W Tin' })).body;
    await advance();
    const device = await Device.pair(env.url, c, 'Private copy');
    await device.call('GET', '/api/ext/me?v=1.39.0');
    const round = async (priv, dev = device) => (await dev.call('GET', `/api/ext/checks?priv=${priv}`)).body.checks.filter((x) => x.store === 'demo-bigw');
    const first = await round(1);
    assert.equal(first.length, 2, 'two a round');
    assert.ok(first.every((x) => x.render && x.privateWindow && x.gapMs === 8000), 'the gap to wait between them said');
    const next = (id) => env.app.db.get('SELECT browser_next_at FROM items WHERE id = :id', { id }).browser_next_at - env.app.repo.now();
    await device.call('POST', '/api/ext/checks', { results: first.map((x) => ({ id: x.id, status: 'out_of_stock', privateWindow: true })) });
    for (const x of first) assert.ok(next(x.id) <= 5 * 1000 && next(x.id) > 0, `asked for again in 5 s: ${next(x.id)}`);
    // (The second of the two started 8 s after the first: the next of its pages 8 s after that — a round asked for a
    //  moment sooner books that slot, and starts then.)
    clock.offset += 15 * 1000;
    const second = await round(1);
    assert.equal(second.length, 2);
    assert.ok(second[0].startInMs > 900 && second[0].startInMs <= 1000, `booked: 8 s after the last round's second (${second[0].startInMs})`);
    assert.equal(second[1].startInMs, undefined);
    assert.ok(second.some((x) => x.id === d.id), 'the one left over first: every item in turn');
    await device.call('POST', '/api/ext/checks', { results: second.map((x) => ({ id: x.id, status: 'out_of_stock', privateWindow: true })) });
    // An older copy (1.36.0) — it waits only its own 4 s between two of a store's pages: one a round.
    const older = await Device.pair(env.url, c, 'Older copy');
    await older.call('GET', '/api/ext/me?v=1.36.0');
    const one = await round(1, older);
    assert.equal(one.length, 1, 'one a round');
    // A browser that can't open a private window: 20 s between two of its pages.
    await older.call('POST', '/api/ext/checks', { results: one.map((x) => ({ id: x.id, status: 'out_of_stock' })) });
    clock.offset += 10 * 1000;
    assert.equal((await round(0, older)).length, 0, 'not after 10 s in an ordinary window');
    clock.offset += 11 * 1000;
    assert.equal((await round(0, older)).length, 1, 'after 20 s');
  } finally {
    env.app.repo.setSetting('retailer:demo-bigw', {});
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  }
});

test("EB Games (its Cloudflare refuses the server and the extension's background checks alike): browsers are asked to check its items from inside a tab of EB's — the product page; a product code with no link yet, in EB's own search data — and other stores' checks are asked for as before", async () => {
  const real = env.app.retailers.get('ebgames');
  assert.equal(real.monitor.inPage, true);
  assert.equal(env.app.retailers.get('demo-ebgames').monitor.inPage, true, "the dummy store's copy too");
  assert.ok(!env.app.retailers.get('kmart').monitor.inPage);
  const c = await member('ebcf');
  const S = store.shop('ebgames');
  S.refuseBackground = true;
  store.state.blockNonBrowsers = true;
  try {
    const page = (await c.post('/api/items', { url: store.productUrl('ebgames', '312346'), name: 'EB ETB' })).body;
    const code = (await c.post('/api/items', { store: 'demo-ebgames', sku: '312345', name: 'EB OP-18' })).body;
    const kmart = (await c.post('/api/items', { url: store.productUrl('kmart', '43818587'), name: 'Kmart ETB' })).body;
    await advance();
    const search = env.app.db.get('SELECT status, error FROM page_checks WHERE url = :u', { u: env.app.retailers.searchUrl(env.app.retailers.get('demo-ebgames'), '312345') });
    assert.deepEqual(search, { status: 'blocked', error: 'The store refused the server check (HTTP 403)' });
    const device = await Device.pair(env.url, c);
    const due = (await device.call('GET', '/api/ext/checks')).body.checks;
    const of = (id) => due.find((x) => x.id === id);
    const base = env.app.retailers.get('demo-ebgames').base;
    assert.deepEqual([of(page.id).kind, of(page.id).inPage, of(page.id).storeBase, of(page.id).data], ['product', true, base, undefined]);
    assert.equal(of(code.id).kind, 'search');
    assert.equal(of(code.id).inPage, true);
    assert.equal(of(code.id).data, `${base}/search/query?q=312345&sort=releasedate&order=desc`);
    assert.equal(of(code.id).parser, 'ebgames');
    assert.ok(of(kmart.id), 'Kmart (refusing the server) checked too…');
    assert.equal(of(kmart.id).inPage, undefined, '…asked for as before');
  } finally {
    S.refuseBackground = false;
    store.state.blockNonBrowsers = false;
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  }
});

test("Kmart (its pages turn servers away): the server reads each product from Kmart's search provider by its keycode — never its page — in stock, in some states, pre-order, \"In store only\" and not listed yet as Kmart says; refused there, it's said and backed off", async () => {
  const c = await member('kmartlookup');
  // (Products of its own: no other test's checks of them due at another time.)
  const KC = '43819901';
  const KE = '43819902';
  store.addProduct('kmart', { sku: KC, name: 'Pokemon TCG Lookup Elite Trainer Box', price: 89, status: 'out_of_stock' });
  store.addProduct('kmart', { sku: KE, name: 'Pokemon TCG Lookup Booster Bundle', price: 49, status: 'in_stock', listed: false });
  const r = await c.post('/api/items', { url: store.productUrl('kmart', KC), name: 'Kmart Lookup ETB' });
  assert.equal(r.status, 200, r.text);
  const S = store.shop('kmart');
  const pages = () => hits('/kmart/product/');
  const lookups = () => S.lookups || 0;
  const [p0, l0] = [pages(), lookups()];
  await advance();
  let it = (await c.get('/api/items')).body.items.find((x) => x.id === r.body.id);
  assert.equal(it.status, 'out_of_stock');
  assert.equal(it.statusSource, 'server');
  assert.equal(pages() - p0, 0, 'its page never asked for');
  assert.equal(lookups() - l0, 1, 'looked up once, by keycode');
  assert.ok(store.state.requests.some((x) => x.path === '/kmart/cnstrc/browse/items' && /^Mugibot\/1\.0/.test(x.ua)), 'honestly Mugibot');
  // Back in stock: the restock ping, from the lookup.
  store.set('kmart', KC, { status: 'in_stock' });
  await advance();
  it = (await c.get('/api/items')).body.items.find((x) => x.id === r.body.id);
  assert.equal(it.status, 'in_stock');
  assert.equal(await alerted(c, 'Kmart Lookup ETB'), true);
  // Pre-order, and in Kmart's shops only: as Kmart says.
  store.set('kmart', KC, { status: 'preorder' });
  await advance();
  assert.equal((await c.get('/api/items')).body.items.find((x) => x.id === r.body.id).status, 'preorder');
  store.set('kmart', KC, { status: 'in_stock', inStoreOnly: true });
  await advance();
  assert.equal((await c.get('/api/items')).body.items.find((x) => x.id === r.body.id).status, 'in_store');
  store.set('kmart', KC, { inStoreOnly: false });
  // A keycode Kmart hasn't listed yet: not listed — then its link, once it is.
  const early = await c.post('/api/items', { store: 'demo-kmart', sku: KE, name: 'Kmart Early' });
  assert.equal(early.status, 200, early.text);
  await advance();
  let e = (await c.get('/api/items')).body.items.find((x) => x.id === early.body.id);
  assert.equal(e.status, 'not_listed');
  store.set('kmart', KE, { listed: true });
  await advance();
  e = (await c.get('/api/items')).body.items.find((x) => x.id === early.body.id);
  assert.equal(e.url, store.productUrl('kmart', KE), 'its link, from the lookup');
  await advance();
  e = (await c.get('/api/items')).body.items.find((x) => x.id === early.body.id);
  assert.equal(e.status, 'in_stock');
  // The search provider refusing: said, backed off, the last stock kept.
  S.lookupDown = true;
  try {
    await advance();
    it = (await c.get('/api/items')).body.items.find((x) => x.id === r.body.id);
    assert.match(it.error, /search provider refused the server check \(HTTP 503\)/);
    assert.equal(it.status, 'in_stock', 'a refusal never reads as a change');
    assert.equal(pages() - p0, 0, 'its page still never asked for');
  } finally {
    S.lookupDown = false;
  }
  // The admin console's page checks: Kmart's reads count as fine.
  const kmart = env.app.catalog.health().find((h) => h.store === 'demo-kmart');
  if (kmart) assert.ok(kmart.ok > 0);
  for (const id of [r.body.id, early.body.id]) await c.del(`/api/items/${id}`);
});

test("EB Games (its Cloudflare turns away every server): the server never asks it, whatever an admin saved — browsers do — and the admin console says server checks are off there", async () => {
  const eb = env.app.retailers.get('ebgames');
  assert.equal(eb.monitor.server, 'never');
  assert.equal(env.app.retailers.settings(eb).serverChecks, false);
  env.app.repo.setSetting('retailer:ebgames', { serverChecks: true });
  try {
    assert.equal(env.app.retailers.settings(eb).serverChecks, false, 'whatever was saved');
    assert.equal(env.app.retailers.settings(eb).browserChecks, true);
  } finally {
    env.app.repo.setSetting('retailer:ebgames', {});
  }
});

test("page checks: up to 50 due pages a round (oldest first, an armed item's page ahead of its turn), so one store's long list doesn't keep another store's page waiting — and a store slow to answer is still asked again once its gap is over, as ever", async () => {
  const mon = env.app.monitor;
  const { catalog, repo, db, cfg } = env.app;
  const gap = cfg.monitor.hostGapSeconds;
  const real = mon.checkPage;
  const dispatched = [];
  const release = [];
  // (Checks that stay open until released: a store slow to answer.)
  mon.checkPage = (url) => {
    dispatched.push(url);
    db.run('UPDATE page_checks SET next_check_at = :t WHERE url = :url', { url, t: mon.now() + 600000 }); // (as a check does: its next one later)
    return new Promise((resolve) => release.push(resolve));
  };
  cfg.monitor.hostGapSeconds = 5;
  const a = store.url; // 127.0.0.1
  const b = store.url.replace('127.0.0.1', 'localhost');
  const now = mon.now();
  const add = (base, i, dueAgo) => {
    const url = `${base}/fairness/${i}`;
    const p = catalog.upsertProduct({ store: 'other', sku: `fair-${base === a ? 'a' : 'b'}-${i}`, url, name: `Fairness ${i}` });
    catalog.addMonitor(p.id);
    repo.ensurePage(url, 'product', 'other', p.sku);
    db.run('UPDATE page_checks SET next_check_at = :t WHERE url = :url', { url, t: now - dueAgo });
    return url;
  };
  const pending = [];
  try {
    // Store A: 40 pages overdue (a backlog, a tenth of a second apart); store B: one page, just due.
    const aPages = Array.from({ length: 40 }, (_, i) => add(a, i, 600000 - i * 100));
    const bPage = add(b, 0, 1000);
    // An armed item on A's newest page (its member's Auto-checkout): up to 15 s ahead of its turn there.
    const ash = await member('fairness-ash');
    db.run(`INSERT INTO items (id, user_id, position, store, sku, name, url, aco, created_at, updated_at)
      VALUES ('itm-fair', :u, 999, 'other', 'fair-a-39', 'Fairness 39', :url, 1, :t, :t)`, { u: ash.user.id, url: aPages[39], t: now });
    pending.push(mon.tick());
    await new Promise((r) => setImmediate(r));
    assert.ok(dispatched.includes(bPage), "store B's page checked at once, however long A's list");
    assert.equal(dispatched.filter((u) => u.startsWith(`${a}/fairness/`)).length, 1, 'one a gap at store A');
    assert.equal(dispatched.find((u) => u.startsWith(`${a}/fairness/`)), aPages[39], "A's armed page first");
    // Still inside A's gap: not asked again.
    clock.offset += 2000;
    pending.push(mon.tick());
    await new Promise((r) => setImmediate(r));
    assert.equal(dispatched.filter((u) => u.startsWith(`${a}/fairness/`)).length, 1, 'inside its gap: not again');
    // Past its gap, the first check still going (slow to answer): A's next page is asked all the same, as ever.
    clock.offset += 4000;
    pending.push(mon.tick());
    await new Promise((r) => setImmediate(r));
    assert.equal(dispatched.filter((u) => u.startsWith(`${a}/fairness/`)).length, 2, 'the next one once its gap is over');
    assert.equal(dispatched.at(-1), aPages[0], 'then oldest first');
  } finally {
    release.splice(0).forEach((r) => r());
    await Promise.all(pending);
    mon.checkPage = real;
    cfg.monitor.hostGapSeconds = gap;
    db.run("DELETE FROM items WHERE id = 'itm-fair'");
    db.run("DELETE FROM monitors WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'fair-%')");
    db.run("DELETE FROM page_checks WHERE url LIKE '%/fairness/%'");
    mon.hostNext.clear();
  }
});

test('announced SKUs (an admin\'s): restocks are posted in the Discord channel once', async () => {
  const boss = new Client(env.url);
  await boss.post('/api/auth/login', { username: 'boss', password: 'correct horse battery staple' });
  for (const it of (await boss.get('/api/items')).body.items) await boss.del(`/api/items/${it.id}`);
  store.set('kmart', '43818587', { status: 'out_of_stock', listed: true });
  const it = (await boss.post('/api/items', { url: store.productUrl('kmart', '43818587'), name: 'Dummy ETB', announce: true })).body;
  assert.equal(it.announce, true);
  const notAdmin = await member('pleb');
  const pleb = (await notAdmin.post('/api/items', { url: store.productUrl('kmart', '43818556'), name: 'Pleb', announce: true })).body;
  assert.equal(pleb.announce, false, 'only admins can announce');

  const posts = discord.channelPosts('chan-restocks').length;
  await advance();
  store.set('kmart', '43818587', { status: 'in_stock' });
  await advance();
  const post = discord.channelPosts('chan-restocks').slice(posts);
  assert.equal(post.length, 1);
  assert.match(post[0].body.embeds[0].title, /In stock: Dummy ETB/);
  store.set('kmart', '43818587', { status: 'out_of_stock' });
  await advance();
  store.set('kmart', '43818587', { status: 'in_stock' });
  await advance();
  assert.equal(discord.channelPosts('chan-restocks').length - posts, 1, 'not posted again within 10 minutes');
});

test('paused items and pages nobody watches are not checked, and are forgotten', async () => {
  const c = await member('pauser');
  const w = (await c.post('/api/items', { url: store.productUrl('kmart', '43818556'), name: 'KO' })).body;
  await c.put(`/api/items/${w.id}`, { monitor: false });
  const before = hits('-43818556/');
  const plebsCopy = env.app.db.all('SELECT id FROM items WHERE url = :u AND user_id != :me', { u: w.url, me: c.user.id });
  env.app.db.run('UPDATE items SET monitor = 0 WHERE url = :u', { u: w.url }); // nobody else either
  await advance();
  assert.equal(hits('-43818556/'), before);
  await c.del(`/api/items/${w.id}`);
  for (const p of plebsCopy) env.app.db.run('DELETE FROM items WHERE id = :id', { id: p.id });
  env.app.monitor.ticks = 0;
  await advance();
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM page_checks WHERE url = :u', { u: w.url }).n, 0, 'forgotten');
});

test('watch input checks and limits', async () => {
  const c = await member('limits');
  assert.equal((await c.post('/api/items', { url: 'ftp://example.com/x' })).status, 400);
  assert.equal((await c.post('/api/items', { url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await c.post('/api/items', {})).status, 400);
  assert.equal((await c.post('/api/items', { store: 'kmart' })).status, 400, 'store without SKU');
  assert.equal((await c.post('/api/items', { store: 'nope', sku: '1' })).status, 400);
  const dup = await c.post('/api/items', { store: 'kmart', sku: '43818648' });
  assert.equal(dup.status, 200);
  assert.equal((await c.post('/api/items', { url: 'https://www.kmart.com.au/product/anything-43818648/' })).status, 409, 'same SKU twice');
  const limit = env.app.cfg.limits.items;
  for (let i = (await c.get('/api/items')).body.items.length; i < limit; i++) assert.equal((await c.post('/api/items', { url: `https://example.com/p/${1000000 + i}` })).status, 200);
  const over = await c.post('/api/items', { url: 'https://example.com/p/over' });
  assert.equal(over.status, 400);
  assert.match(over.body.error, new RegExp(`up to ${limit}`));
  assert.equal(pathHasSku('https://x.example/product/abc-43818648/', '43818648'), true);
  assert.equal(pathHasSku('https://x.example/product/abc-143818648/', '43818648'), false, 'part of a longer number');
  assert.equal(pathHasSku('https://x.example/products/pokemon-etb', 'pokemon-etb'), true);
});

test('member links can never make the server fetch its own network', async () => {
  const { assertPublicUrl, isPrivateIp } = await import('../server/monitor/safeurl.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '104.18.0.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  const publicLookup = async () => [{ address: '104.18.0.1' }];
  await assert.doesNotReject(assertPublicUrl('https://www.kmart.com.au/product/x-1/', { lookup: publicLookup }));
  for (const bad of ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'https://www.kmart.com.au:8443/x', 'file:///etc/passwd', 'http://[::1]/']) {
    await assert.rejects(assertPublicUrl(bad, { lookup: publicLookup }), bad);
  }
  await assert.rejects(assertPublicUrl('https://sneaky.example/', { lookup: async () => [{ address: '10.0.0.5' }] }), 'a name that points inside');

  // End to end with the default (strict) setting: a watched link on a local address is refused by the monitor.
  const strict = await startApp({ hostGapSeconds: 0 });
  try {
    const c = await Client.signup(strict.url, 'ssrf');
    strict.app.repo.updateUser(c.user.id, { plan: 'comped' });
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
    await c.post('/api/items', { url: `${strict.url}/api/me`, name: 'internal', sku: 'x1' });
    const before = store.state.requests.length;
    await strict.app.monitor.tick();
    const item = (await c.get('/api/items')).body.items[0];
    assert.equal(item.status, 'error');
    assert.match(item.error, /standard web ports|public internet/);
    assert.equal(store.state.requests.length, before);
  } finally {
    await strict.close();
  }
});
