// The Monitor feed (docs/MONITORING.md) against the dummy stores: admins add
// monitors; checks fill in name, image, price and status; confirmed changes
// alert once (cooldown) in the live feed and in the Discord channels whose
// rules match, with the product image, store, price, stock and ⚡ Buy; price
// history, the check log and health; pause, resume, intervals; Shopify cart
// links; blocked stores; admins' browsers for stores that refuse servers; and
// the /monitor and /restocks slash commands.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, discordOpts, interactionKeys, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';

let env;
let store;
let discord;
let keys;
let clock;
let boss;
let ash;
before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  keys = interactionKeys();
  clock = { offset: 0 };
  env = await startApp({
    urlIntervalSeconds: 60, hostGapSeconds: 0, allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss',
    now: () => Date.now() + clock.offset, ...discordOpts(discord), discordPublicKey: keys.publicKey,
  });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  makeMember(env, ash);
  for (const c of [boss, ash]) for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  env.app.repo.updateUser(env.app.repo.userByUsername('boss').id, { discord_id: 'd-boss' });
  env.app.repo.updateUser(env.app.repo.userByUsername('ash').id, { discord_id: 'd-ash' });
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});
beforeEach(() => { store.state.blockNonBrowsers = false; });

async function advance(seconds = 61) {
  clock.offset += seconds * 1000;
  let n = 0;
  for (let i = 0; i < 10; i++) {
    const done = await env.app.monitor.tick();
    n += done;
    if (!done) break;
  }
  return n;
}
const hits = (fragment) => store.state.requests.filter((r) => r.path.includes(fragment)).length;
const posts = (channel) => discord.channelPosts(channel);
const productOf = async (monitorId) => (await boss.get('/api/monitor/products')).body.products.find((p) => p.monitor.id === monitorId);

async function slash(discordId, name, options = []) {
  const body = JSON.stringify({ type: 2, id: 'i1', token: 't', member: { user: { id: discordId } }, data: { name, options } });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${env.url}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': keys.sign(ts, body), 'x-signature-timestamp': ts }, body });
  return (await res.json()).data;
}
const sub = (name, options = []) => [{ type: 1, name, options }];

let op; // the One Piece booster box monitor, used through the file

test('admins add monitors; the first check fills in name, image, price and stock without alerting', async () => {
  store.set('ebgames', '312345', { status: 'out_of_stock', price: 159 });
  let r = await boss.post('/api/monitor/monitors', { url: store.productUrl('ebgames', '312345') });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.created, true);
  op = r.body.monitor;
  assert.equal(r.body.product.store, 'demo-ebgames');
  assert.deepEqual(op.kinds, ['restock', 'listed', 'price_drop'], 'restocks, listings and price drops by default');
  assert.equal((await ash.post('/api/monitor/monitors', { url: store.productUrl('ebgames', '312346') })).status, 404, 'members can\'t add monitors');
  assert.equal((await boss.post('/api/monitor/monitors', { url: store.productUrl('ebgames', '312345') })).body.created, false, 'one monitor per product');
  r = await boss.post('/api/monitor/monitors', { store: 'demo-ebgames', sku: '312345', intervalSeconds: 5 });
  assert.equal(r.body.created, false);
  assert.equal((await boss.put(`/api/monitor/monitors/${op.id}`, { intervalSeconds: 5 })).body.monitor.intervalSeconds, 20, 'never faster than MONITOR_MIN_INTERVAL');
  assert.equal((await boss.put(`/api/monitor/monitors/${op.id}`, { intervalSeconds: null })).body.monitor.intervalSeconds, null, 'back to the default');

  const before = posts('chan-restocks').length;
  await advance();
  const p = await productOf(op.id);
  assert.equal(p.name, 'One Piece Card Game OP-18 Booster Box (24 Packs)', 'name from the store page');
  assert.equal(p.category, 'onepiece', 'category guessed from the name');
  assert.match(p.image, /\/img\/ebgames\/312345\.svg$/, 'image from the store page');
  assert.equal(p.price, 159);
  assert.equal(p.status, 'out_of_stock');
  assert.equal(p.confirmed, true);
  assert.equal(posts('chan-restocks').length, before, 'the first check is not news');
  assert.equal((await ash.get('/api/monitor')).body.alerts.length, 0);
  // Members see the feed's products, not the admin settings.
  const seen = (await ash.get('/api/monitor/products')).body.products.find((x) => x.id === p.id);
  assert.equal(seen.name, p.name);
  assert.equal(seen.monitor.kinds, undefined);
  const lapsed = await Client.signup(env.url, 'lapsed');
  assert.equal((await lapsed.get('/api/monitor')).status, 402, 'the feed is for members');
});

test('a restock alerts once: live feed + Discord embed with image, store, price, stock and ⚡ Buy; not again within the cooldown', async () => {
  const before = posts('chan-restocks').length;
  store.set('ebgames', '312345', { status: 'in_stock' });
  await advance();
  const sent = posts('chan-restocks').slice(before);
  assert.equal(sent.length, 1);
  const msg = sent[0].body;
  assert.equal(msg.content, '<@&role-restock-pings>', 'pings the restock role');
  const e = msg.embeds[0];
  assert.match(e.title, /^🟢 In stock: One Piece Card Game OP-18 Booster Box/);
  assert.match(e.thumbnail.url, /\/img\/ebgames\/312345\.svg$/);
  const field = (n) => e.fields.find((f) => f.name === n).value;
  assert.equal(field('Price'), '$159.00');
  assert.equal(field('Stock'), 'In stock');
  assert.equal(field('SKU'), '312345');
  assert.equal(field('Category'), 'One Piece');
  assert.ok(e.timestamp);
  const buttons = msg.components[0].components;
  assert.match(buttons[0].url, /\/buy\?store=demo-ebgames&sku=312345/, '⚡ Buy runs the member\'s own checkout');
  assert.equal(buttons[1].label, 'Open product');
  assert.match(buttons.at(-1).url, /\/app#monitor\/prd_/, 'price history in the dashboard');

  const feed = (await ash.get('/api/monitor')).body;
  assert.equal(feed.alerts[0].kind, 'restock');
  assert.deepEqual(feed.alerts[0].posted, ['chan-restocks']);
  assert.equal(feed.overview.restocks24h, 1);

  store.set('ebgames', '312345', { status: 'out_of_stock' });
  await advance();
  store.set('ebgames', '312345', { status: 'in_stock' });
  await advance();
  assert.equal(posts('chan-restocks').length - before, 1, 'no second restock post within the cooldown');
  store.set('ebgames', '312345', { status: 'out_of_stock' });
  await advance(11 * 60);
  store.set('ebgames', '312345', { status: 'in_stock' });
  await advance();
  assert.equal(posts('chan-restocks').length - before, 2, 'after the cooldown it alerts again');
});

test('price changes: history kept; alert rules choose channels by category, store, kind and keyword', async () => {
  let r = await boss.post('/api/monitor/routes', { name: 'One Piece prices', channelId: '111111111111111001', categories: ['onepiece'], kinds: ['price_drop', 'price_rise'] });
  assert.equal(r.status, 200, r.text);
  await boss.post('/api/monitor/routes', { name: 'Pokémon restocks', channelId: '111111111111111002', roleId: '222222222222222002', categories: ['pokemon'], kinds: ['restock'] });
  await boss.post('/api/monitor/routes', { name: 'Booster boxes', channelId: '111111111111111003', kinds: ['restock', 'price_drop'], keywords: 'booster box, bundle' });
  assert.equal((await boss.post('/api/monitor/routes', { name: 'Bad', channelId: 'general' })).status, 400, 'channel IDs are checked');
  assert.equal((await ash.get('/api/monitor/routes')).status, 404, 'members can\'t see the rules');

  store.set('ebgames', '312345', { price: 129 });
  await advance();
  const detail = (await ash.get(`/api/monitor/products/${(await productOf(op.id)).id}`)).body;
  assert.deepEqual(detail.history.map((h) => h.price), [159, 129], 'price history');
  assert.equal(detail.product.previousPrice, 159);
  assert.equal(detail.log, null, 'members don\'t get the check log');
  assert.equal(posts('111111111111111001').length, 1, 'One Piece price rule');
  assert.match(posts('111111111111111001')[0].body.embeds[0].title, /^📉 Price drop/);
  assert.equal(posts('111111111111111001')[0].body.embeds[0].fields.find((f) => f.name === 'Price').value, '$129.00 (was $159.00)');
  assert.equal(posts('111111111111111003').length, 1, 'keyword rule (booster box)');
  assert.equal(posts('111111111111111002').length, 0, 'not a Pokémon product');
  assert.equal(posts('chan-restocks').filter((m) => /Price/.test(m.body.embeds[0].title)).length, 0, 'with rules set up, the default channel is no longer used');

  // A small wobble isn't news, and a rise only alerts monitors that ask for rises.
  store.set('ebgames', '312345', { price: 129.5 });
  await advance();
  assert.equal(posts('111111111111111001').length, 1, 'under MONITOR_PRICE_CHANGE_PERCENT');
  store.set('ebgames', '312345', { price: 149 });
  await advance();
  assert.equal(posts('111111111111111001').length, 1, 'price rises are off for this monitor');
  await boss.put(`/api/monitor/monitors/${op.id}`, { kinds: ['restock', 'price_drop', 'price_rise'] });
  store.set('ebgames', '312345', { price: 169 });
  await advance();
  assert.equal(posts('111111111111111001').length, 2);
  assert.match(posts('111111111111111001')[1].body.embeds[0].title, /^📈 Price up/);

  // A Pokémon product's restock goes to the Pokémon rule, with its role ping.
  store.set('bigw', '6012345', { status: 'out_of_stock' });
  const upc = (await boss.post('/api/monitor/monitors', { url: store.productUrl('bigw', '6012345') })).body;
  assert.equal(upc.product.category, 'other', 'not guessed until the page is read');
  await advance();
  assert.equal((await productOf(upc.monitor.id)).category, 'pokemon');
  store.set('bigw', '6012345', { status: 'in_stock' });
  await advance();
  assert.equal(posts('111111111111111002').length, 1);
  assert.equal(posts('111111111111111002')[0].body.content, '<@&222222222222222002>');
  assert.equal(posts('111111111111111003').length, 1, 'no keyword match');
});

test('pause, resume, interval and remove; Check now', async () => {
  await boss.put(`/api/monitor/monitors/${op.id}`, { intervalSeconds: 300 });
  await advance();
  const page = '/312345-';
  let before = hits(page);
  await advance(120);
  assert.equal(hits(page), before, 'checked every 5 minutes now');
  await advance(240);
  assert.equal(hits(page) - before, 1);

  assert.equal((await boss.put(`/api/monitor/monitors/${op.id}`, { paused: true })).body.monitor.paused, true);
  before = hits(page);
  await advance(400);
  assert.equal(hits(page), before, 'paused: not checked');
  assert.equal((await ash.get('/api/monitor/products')).body.products.some((p) => p.monitor.id === op.id), false, 'members don\'t see paused monitors');
  await boss.put(`/api/monitor/monitors/${op.id}`, { paused: false });
  await advance(1);
  assert.equal(hits(page) - before, 1, 'resuming checks straight away');
  await boss.post(`/api/monitor/monitors/${op.id}/check`);
  await advance(1);
  assert.equal(hits(page) - before, 2, 'Check now');

  const audit = env.app.repo.listAudit(50).map((a) => a.action);
  assert.ok(audit.includes('monitor-add') && audit.includes('monitor-pause') && audit.includes('monitor-resume'));
});

test('Shopify store: image and variant from the product JSON; the Add to cart link puts it in the cart', async () => {
  const r = await boss.post('/api/monitor/monitors', { url: store.productUrl('jbhifi', 'pokemon-tcg-30th-celebration-etb'), category: 'pokemon' });
  await advance();
  const detail = (await boss.get(`/api/monitor/products/${r.body.product.id}`)).body;
  assert.equal(detail.product.status, 'in_stock');
  assert.match(detail.product.image, /\/img\/jbhifi\/pokemon-tcg-30th-celebration-etb\.svg$/);
  assert.ok(detail.product.variantId);
  assert.equal(detail.cartUrl, `${store.url}/jbhifi/cart/${detail.product.variantId}:1`);
  assert.ok(detail.log.length >= 1, 'admins see the check log');
  const res = await fetch(detail.cartUrl, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(store.shop('jbhifi').cart[0].sku, 'pokemon-tcg-30th-celebration-etb');
});

test('a store refusing the server: last known stock kept, no alert, shown in health and the log', async () => {
  const before = (await ash.get('/api/monitor')).body.alerts.length;
  store.state.blockNonBrowsers = true;
  await boss.post(`/api/monitor/monitors/${op.id}/check`);
  await advance(1);
  await boss.post(`/api/monitor/monitors/${op.id}/check`);
  await advance(1);
  const p = await productOf(op.id);
  assert.equal(p.status, 'in_stock', 'last confirmed status kept');
  assert.ok(p.failCount >= 1);
  assert.equal((await ash.get('/api/monitor')).body.alerts.length, before, 'a block never alerts');
  const health = (await boss.get('/api/monitor/health')).body;
  const eb = health.stores.find((s) => s.store === 'demo-ebgames');
  assert.ok(eb.blocked >= 1);
  assert.ok(health.loop.lastTickAt);
  const errors = (await boss.get('/api/monitor/log?errors=1')).body.log;
  assert.ok(errors.some((l) => l.status === 'blocked' && l.store === 'demo-ebgames'));
  assert.equal((await ash.get('/api/monitor/health')).status, 404);
  store.state.blockNonBrowsers = false;
});

test('stores that refuse servers: admins\' browsers check the monitors there; members\' browsers can\'t change the feed', async () => {
  await boss.put('/api/admin/retailers/demo-kmart', { serverChecks: false });
  store.set('kmart', '43818648', { status: 'out_of_stock' });
  const m = (await boss.post('/api/monitor/monitors', { url: store.productUrl('kmart', '43818648') })).body;
  const bossDevice = await Device.pair(env.url, boss, 'Boss laptop');
  const ashDevice = await Device.pair(env.url, ash, 'Ash laptop');
  const due = (await bossDevice.call('GET', '/api/ext/checks')).body.checks;
  const mine = due.find((c) => c.id === `p:${m.product.id}`);
  assert.ok(mine, 'the admin\'s browser is asked to check it');
  assert.equal((await ashDevice.call('GET', '/api/ext/checks')).body.checks.some((c) => String(c.id).startsWith('p:')), false);
  // A member's browser claiming a restock is ignored.
  await ashDevice.call('POST', '/api/ext/checks', { results: [{ id: `p:${m.product.id}`, status: 'in_stock', price: 1 }] });
  let p = (await boss.get(`/api/monitor/products/${m.product.id}`)).body.product;
  assert.equal(p.status, 'pending');
  await bossDevice.call('POST', '/api/ext/checks', { results: [{ id: `p:${m.product.id}`, status: 'out_of_stock', price: 360, title: 'Day UPC' }] });
  p = (await boss.get(`/api/monitor/products/${m.product.id}`)).body.product;
  assert.equal(p.status, 'out_of_stock');
  assert.equal(p.statusSource, 'browser');
  await boss.put('/api/admin/retailers/demo-kmart', { serverChecks: true });
});

test('Discord: /monitor add, list, pause, resume, remove, status for admins; /restocks for members', async () => {
  let r = await slash('d-boss', 'monitor', sub('add', [{ name: 'link', value: store.productUrl('ebgames', '312346') }, { name: 'category', value: 'pokemon' }, { name: 'interval', value: 120 }]));
  assert.match(r.content, /📡 Monitoring .*312346.* Pokémon · every 120s/);
  r = await slash('d-boss', 'monitor', sub('add', [{ name: 'link', value: '312346' }, { name: 'store', value: 'demo-ebgames' }]));
  assert.match(r.content, /already monitored/);
  r = await slash('d-ash', 'monitor', sub('list'));
  assert.match(r.content, /Only Mugibot admins/);

  await advance();
  r = await slash('d-boss', 'monitor', sub('list', [{ name: 'category', value: 'pokemon' }]));
  assert.match(r.embeds[0].title, /^Monitors \(\d+\)/);
  assert.match(r.embeds[0].description, /Pokémon TCG: 30th Celebration Elite Trainer Box/);
  assert.doesNotMatch(r.embeds[0].description, /One Piece/);

  r = await slash('d-boss', 'monitor', sub('pause', [{ name: 'target', value: '312346' }]));
  assert.match(r.content, /⏸ Paused/);
  r = await slash('d-boss', 'monitor', sub('list', [{ name: 'status', value: 'paused' }]));
  assert.match(r.embeds[0].description, /⏸ .*312346/);
  r = await slash('d-boss', 'monitor', sub('resume', [{ name: 'target', value: store.productUrl('ebgames', '312346') }]));
  assert.match(r.content, /▶️ Resumed/);
  r = await slash('d-boss', 'monitor', sub('pause', [{ name: 'target', value: 'nope' }]));
  assert.match(r.content, /No monitor matches/);
  r = await slash('d-boss', 'monitor', sub('status'));
  assert.equal(r.embeds[0].title, 'Monitor status');
  assert.match(r.embeds[0].fields.map((f) => f.value).join('\n'), /active/);
  r = await slash('d-boss', 'monitor', sub('remove', [{ name: 'target', value: '312346' }]));
  assert.match(r.content, /Stopped monitoring/);

  r = await slash('d-ash', 'restocks');
  assert.equal(r.embeds[0].title, 'Latest from the Monitor');
  assert.match(r.embeds[0].description, /🟢 \*\*One Piece Card Game OP-18 Booster Box.*\[⚡ Buy\]\(.*\/buy\?store=demo-ebgames&sku=312345/);
});

test('an admin\'s 📣 SKU and a manual /restock go through the same feed and cooldown', async () => {
  const product = env.app.catalog.upsertProduct({ store: 'demo-ebgames', sku: '312346', name: 'EB ETB' });
  const before = (await ash.get(`/api/monitor/alerts`)).body.alerts.length;
  const r = await env.app.monitor.broadcastRestock({ store: 'demo-ebgames', sku: '312346', note: 'limit 2' });
  assert.equal(r.posted, true);
  const alerts = (await ash.get('/api/monitor/alerts')).body.alerts;
  assert.equal(alerts.length, before + 1);
  assert.equal(alerts[0].manual, true);
  assert.equal(alerts[0].productId, product.id);
  const again = await env.app.monitor.broadcastRestock({ store: 'demo-ebgames', sku: '312346' });
  assert.equal(again.posted, true, 'manual pings skip the cooldown');
  // 📣 announcements respect it.
  assert.equal(await env.app.monitor.announce({ store: 'demo-ebgames', sku: '312346', name: 'EB ETB', url: '' }, { status: 'in_stock' }), false);
});
