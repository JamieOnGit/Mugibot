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
