// Drop watches on a search page (docs/MONITORING.md → Search pages): a store's search, category or collection page
// pasted with key phrases ("magic the gathering") — read every few seconds (3 s at the fastest, a store's own pace
// where it's slower), from Mugibot's server or an admin's browser, and what has a phrase in its name found the way a
// drop watch's finds are: an admin's posted in the channel and role they chose, and bought for them; a member's on
// their watchlist and DM'd — Auto-checkout at stores Mugibot checks out at, for what drops after the first look.
// Against the dummy stores and the dummy "other website" (Acme Collectibles) — tests never touch real stores.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { floorFor, phrasesOf, planFor } from '../server/monitor/pages.js';
import { wordsOf } from '../server/monitor/drops.js';
import { Retailers } from '../server/retailers/index.js';

let env;
let store;
let discord;
let boss;
let ash;
let clock;

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  clock = { offset: 0 };
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, now: () => Date.now() + clock.offset, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  for (const [c, d] of [[boss, 'd-boss'], [ash, 'd-ash']]) {
    makeMember(env, c);
    env.app.repo.updateUser(c.user.id, { discord_id: d });
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
    // Auto-checkout on, placing orders, with a browser listening.
    assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 2000, perDay: 20, spendPerDay: 20000 })).status, 200);
    env.app.repo.addDevice(c.user.id, 'Chrome on Mac', '1.34.0');
  }
  // The dummy stores' copies, each searched the way its real store is.
  assert.equal((await boss.put('/api/monitor/sweep', { stores: MODES })).status, 200);
});
const MODES = { 'demo-kmart': 'server', 'demo-trainertown': 'server', 'demo-jbhifi': 'auto', 'demo-ebgames': 'browser', 'demo-bigw': 'browser', 'demo-target': 'server' };
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const R = (id) => env.app.retailers.get(id);
const pages = () => env.app.pages;
const posts = (id) => discord.channelPosts(id);
const dms = (id) => discord.dmsTo(id);
const buttons = (msg) => (msg.body.components ? msg.body.components[0].components.map((b) => b.label) : []);
const runsFor = (itemId) => env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: itemId });
const watchOf = async (c, id) => (await c.get('/api/drops')).body.watches.find((w) => w.id === id);
const admin = () => env.app.repo.userById(boss.user.id);
// The next read of every page due (the timer's job, every second): from the server, waited for.
const tick = async () => { clock.offset += 61 * 1000; return pages().tick(); };

test('🔎 how each store\'s search page is read: from the server where the store answers it — its own page, or what the page is built from — else drawn in an admin\'s browser; never faster than the store allows', () => {
  const real = new Retailers({ demoStoreUrl: '' });
  const get = (id) => real.get(id);
  // (A store's own search for some words, as its drop watches search it.)
  const urlFor = (r, q) => env.app.sweeper.urlFor(r, q, 1, { vip: true });
  // EB Games: no products in its search page — the data it fetches, learned from the page (its filters the page's own).
  const eb = planFor(get('ebgames'), 'https://www.ebgames.com.au/search?category=trading-cards&condition=preorder');
  assert.equal(eb.server, null);
  assert.equal(eb.browser.render, true);
  assert.equal(eb.browser.learn, true);
  assert.equal(eb.browser.parser, 'ebgames');
  assert.equal(eb.browser.guess, 'https://www.ebgames.com.au/search/query?category=trading-cards&condition=preorder');
  // JB Hi-Fi (Shopify): a collection is its products.json, a search its suggestions — a browser where those come back empty.
  const jbCol = planFor(get('jbhifi'), 'https://www.jbhifi.com.au/collections/trading-cards?sort=new');
  assert.equal(jbCol.server.url, 'https://www.jbhifi.com.au/collections/trading-cards/products.json?limit=250');
  assert.equal(jbCol.server.parser, 'shopify');
  assert.equal(jbCol.browser.render, true);
  const jbSearch = planFor(get('jbhifi'), 'https://www.jbhifi.com.au/search?query=magic%20the%20gathering');
  assert.match(jbSearch.server.url, /^https:\/\/www\.jbhifi\.com\.au\/search\/suggest\.json\?q=magic%20the%20gathering&/);
  // Kmart: its search provider, as its drop watches search it.
  const km = planFor(get('kmart'), 'https://www.kmart.com.au/search/?searchTerm=magic%20the%20gathering', { urlFor });
  assert.match(km.server.url, /^https:\/\/ac\.cnstrc\.com\/search\/magic%20the%20gathering\?key=/);
  assert.equal(km.server.parser, 'constructor');
  // Target, City Beach, The Games Cube: their own pages, from the server.
  assert.deepEqual([planFor(get('target'), 'https://www.target.com.au/search?text=lego').server.parser, planFor(get('citybeach'), 'https://www.citybeach.com/au/search?q=pokemon').server.parser, planFor(get('thegamescube'), 'https://www.thegamescube.com/products/search?q=magic').server.parser], ['target', 'citybeach', 'crystal']);
  // BIG W and Pokémon Center: drawn in a browser only (BIG W's in its private window).
  const bigw = planFor(get('bigw'), 'https://www.bigw.com.au/search?text=lego');
  assert.equal(bigw.server, null);
  assert.equal(bigw.browser.privateWindow, true);
  // Amazon: its own HTML, asked for from inside an Amazon page.
  assert.equal(planFor(get('amazon'), 'https://www.amazon.com.au/s?k=magic+the+gathering').browser.inPage, true);
  // Games World (WooCommerce): a search through its product API; a category page as it is.
  assert.match(planFor(get('gamesworld'), 'https://www.gamesworld.com.au/?s=magic&post_type=product', { urlFor }).server.url, /\/wp-json\/wc\/store\/v1\/products\?search=magic/);
  assert.equal(planFor(get('gamesworld'), 'https://www.gamesworld.com.au/product-category/trading-card-games/').server.parser, 'generic');
  // Another website: its page as it is.
  assert.deepEqual(planFor(null, 'https://www.example.com/collections/new#top').server, { url: 'https://www.example.com/collections/new', parser: 'site' });
  // How fast: 3 s — a store whose searches go slower, at its pace.
  assert.deepEqual(['ebgames', 'jbhifi', 'bigw', 'pokemoncenter', 'citybeach'].map((id) => floorFor(get(id))), [3, 3, 20, 30, 10]);
  assert.equal(floorFor(null), 3);
  // Key phrases: one a line (or ;), as drop watch words, 3 letters or more, each once.
  assert.deepEqual(phrasesOf('Magic: The Gathering\n\nx\nmagic the gathering; One Piece OP-15', wordsOf), ['magic the gathering', 'one piece op 15']);
});

test('🔎 what can be added: a page and a key phrase or more, every 3 s at the fastest (BIG W every 20 s), not a product\'s own page, Auto-checkout only where Mugibot checks out, each page once', async () => {
  const eb = `${store.url}/ebgames/search?category=trading-cards&condition=preorder`;
  let r = await boss.post('/api/drops', { page: eb, phrases: ['x'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /key phrase/);
  r = await boss.post('/api/drops', { page: eb, phrases: ['Magic the Gathering'], every: 2 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Every 3 seconds is the fastest/);
  r = await boss.post('/api/drops', { page: `${store.url}/bigw/search?text=lego`, phrases: ['lego'], every: 5 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /every 20 seconds at the fastest/);
  r = await boss.post('/api/drops', { page: `${store.url}/ebgames/product/toys-and-collectibles/312346-pokemon-tcg-30th-celebration-elite-trainer-box`, phrases: ['pokemon'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /product's own page/);
  // (A link that does something — a cart, a checkout, an account, an add — is never a page to read: an admin's
  //  browser opens a store's pages signed in as them.)
  for (const bad of [`${store.url}/ebgames/cart`, `${store.url}/kmart/checkout`, `${store.url}/jbhifi/account/logout`, `${store.url}/gamesworld/?add-to-cart=4400001`]) {
    r = await boss.post('/api/drops', { page: bad, phrases: ['pokemon'] });
    assert.equal(r.status, 400, bad);
    assert.match(r.body.error, /That link does something/);
  }
  r = await boss.post('/api/drops', { page: `${store.url}/acme/collections/new`, phrases: ['xbox'], aco: true, maxPrice: 900 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Auto-checkout works at stores Mugibot has a checkout for/);
  r = await boss.post('/api/drops', { page: eb, phrases: ['Magic the Gathering', 'One Piece OP-15'], every: 3, aco: true });
  assert.equal(r.status, 400, 'a max price to auto-checkout');
  r = await boss.post('/api/drops', { page: eb, phrases: ['Magic the Gathering', 'One Piece OP-15'], every: 3, label: 'EB pre-orders', shared: false });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.equal(w.kind, 'page');
  assert.deepEqual(w.phrases, ['magic the gathering', 'one piece op 15'], 'one watch for all its phrases');
  assert.equal(w.every, 3);
  assert.equal(w.floor, 3);
  assert.equal(w.page, eb);
  assert.equal(w.storeName, 'EB Games (dummy store)');
  assert.equal(w.canBuy, true);
  r = await boss.post('/api/drops', { page: `${eb}#again`, phrases: ['pokemon'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /watching that page already/);
  // Its phrases and pace changed in place.
  r = await boss.put(`/api/drops/${w.id}`, { phrases: 'magic the gathering\nlorcana', every: 10 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.watch.phrases, ['magic the gathering', 'lorcana']);
  assert.equal(r.body.watch.every, 10);
  assert.equal((await boss.put(`/api/drops/${w.id}`, { every: 1 })).status, 400);
  assert.equal((await boss.put(`/api/drops/${w.id}`, { phrases: [] })).status, 400);
  assert.equal((await ash.put(`/api/drops/${w.id}`, { phrases: ['hi there'] })).status, 404, 'only its owner changes it');
  // (A switched-off store's pages aren't read: nothing to add there.)
  r = await boss.post('/api/drops', { page: `${store.url}/pokebox/collections/all`, phrases: ['pokemon'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /isn't monitored at the moment/);
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🔎 an admin's search page read from the server (Kmart's search, as its search provider has it): what's on it at the first look is the scene; a new listing with a phrase is posted in the channel and role chosen, with ⚡ Buy, and bought for the admin within the max price — once; what's on the page without a phrase is left alone", async () => {
  const ROLE = '800000000000000101';
  discord.state.roles.push({ id: ROLE, name: 'MTG pings', position: 3, permissions: '0' });
  const general = discord.state.channels.find((c) => c.name === 'general').id;
  store.addProduct('kmart', { sku: '43900001', name: 'Magic: The Gathering Foundations Play Booster Box', price: 199, status: 'in_stock' });
  const page = `${store.url}/kmart/search/?searchTerm=magic`;
  const r = await boss.post('/api/drops', { page, phrases: ['Magic the Gathering'], every: 3, label: 'Kmart MTG', aco: true, maxPrice: 300, channelId: general, roleId: ROLE });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.deepEqual([w.shared, w.channelId, w.roleId, w.aco, w.maxPrice], [true, general, ROLE, true, 300]);
  assert.equal(w.looked, false);
  const before = posts(general).length;
  const asked = () => store.state.requests.filter((x) => x.path === '/kmart/cnstrc/search/magic');
  assert.equal(await tick(), 1);
  assert.ok(asked().length >= 1 && asked().every((x) => /^Mugibot\/1\.0/.test(x.ua)), 'as Mugibot, from its server');
  let view = await watchOf(boss, w.id);
  assert.equal(view.looked, true);
  assert.equal(view.seen, 1);
  assert.deepEqual(view.found.map((f) => [f.name, f.arm]), [['Magic: The Gathering Foundations Play Booster Box', 'skipped']], 'on sale at the first look: not bought');
  assert.equal(posts(general).length, before, 'the scene, not a drop');
  // Not read again before its time (every 3 s).
  assert.equal(await pages().tick(), 0);

  // A new one drops — and something else on the page without the phrase.
  store.addProduct('kmart', { sku: '43900002', name: 'Magic: The Gathering Edge of Eternities Collector Booster Box', price: 289, status: 'in_stock' });
  store.addProduct('kmart', { sku: '43900003', name: 'Magic Sand Deluxe Kit', price: 15, status: 'in_stock' });
  await tick();
  assert.equal(posts(general).length, before + 1, 'posted once');
  const post = posts(general).at(-1);
  assert.match(post.body.embeds[0].title, /^🆕 New drop: Magic: The Gathering Edge of Eternities Collector Booster Box/);
  assert.equal(post.body.content, `<@&${ROLE}>`);
  assert.ok(buttons(post).includes('⚡ Buy with Mugibot'));
  const item = env.app.repo.itemBySku(boss.user.id, 'demo-kmart', '43900002');
  assert.equal(item.aco, true);
  assert.equal(item.maxPrice, 300);
  assert.equal(item.dropWatch, w.id);
  assert.equal(runsFor(item.id).length, 1, 'bought the moment it was found');
  assert.equal(env.app.catalog.productFor('demo-kmart', '43900003'), null, 'no phrase: left alone');
  view = await watchOf(boss, w.id);
  assert.deepEqual(view.found.map((f) => f.arm), ['skipped', 'armed']);
  // Read again and again: told once, bought once.
  await tick();
  await tick();
  assert.equal(posts(general).length, before + 1);
  assert.equal(runsFor(item.id).length, 1);
  // One purchase per watch: once it's bought one (the run placed), what drops next is told, not bought…
  env.app.aco.oncePerWatch(boss.user.id, item.id);
  assert.equal(env.app.drops.get(w.id).aco, false);
  store.addProduct('kmart', { sku: '43900004', name: 'Magic: The Gathering Duskmourn Bundle', price: 79, status: 'in_stock' });
  await tick();
  assert.equal(posts(general).length, before + 2, 'told');
  const next = env.app.repo.itemBySku(boss.user.id, 'demo-kmart', '43900004');
  assert.ok(!next || !next.aco, 'not bought');
  // …until its owner arms it again (✎): then the next drop is bought.
  assert.equal((await ash.put(`/api/drops/${w.id}`, { aco: true, maxPrice: 300 })).status, 404, 'not theirs');
  let u = await boss.put(`/api/drops/${w.id}`, { aco: true });
  assert.equal(u.status, 200, u.text);
  assert.deepEqual([u.body.watch.aco, u.body.watch.maxPrice], [true, 300], 'its max price kept');
  store.addProduct('kmart', { sku: '43900005', name: 'Magic: The Gathering Aetherdrift Collector Booster', price: 189, status: 'in_stock' });
  await tick();
  const armed = env.app.repo.itemBySku(boss.user.id, 'demo-kmart', '43900005');
  assert.equal(armed.aco, true);
  assert.equal(runsFor(armed.id).length, 1, 'bought');
  u = await boss.put(`/api/drops/${w.id}`, { aco: false });
  assert.equal(u.body.watch.aco, false);
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🔎 EB Games' \"Trading cards, pre-order\" page, read from an admin's browser (its search page has no products in it): the data the page fetches, learned from the page and asked for again from inside it; a member's own watch — on their watchlist, DM'd, and bought within its max price", async () => {
  const eb = R('demo-ebgames');
  store.addProduct('ebgames', { sku: '312400', name: 'Magic: The Gathering Avatar The Last Airbender Play Booster Box', price: 229, status: 'preorder' });
  const page = `${store.url}/ebgames/search?category=trading-cards&condition=preorder`;
  const r = await ash.post('/api/drops', { page, phrases: ['magic the gathering', 'one piece op 15'], every: 3, aco: true, maxPrice: 250 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.equal(w.shared, false);
  assert.equal(w.waiting, 'browser', "waiting for an admin's browser");
  assert.equal(await tick(), 0, 'never from the server');
  // An admin's browser on an older extension: none handed to it — its card says to update.
  assert.deepEqual(pages().browserDue(admin(), { version: '1.33.0' }).pages, []);
  assert.equal(pages().viewOf(env.app.drops.get(w.id)).waiting, 'update');
  // 1.34.0: in a tab of its own, the page opened and its data learned.
  let due = pages().browserDue(admin(), { version: '1.34.0' });
  assert.equal(due.pages.length, 1);
  let t = due.pages[0];
  assert.equal(t.tab, 'page:demo-ebgames');
  assert.equal(t.url, page);
  assert.deepEqual([t.render, t.learn, t.dataUrl], [true, true, '']);
  assert.equal(t.guess, `${store.url}/ebgames/search/query?category=trading-cards&condition=preorder`);
  assert.equal(pages().browserDue(admin(), { version: '1.34.0' }).pages.length, 0, 'not again while it\'s out');
  assert.deepEqual(pages().browserDue(ash.user, { version: '1.34.0' }).pages, [], "a member's browser never reads pages");
  // What the browser read: the JSON the page fetched (its own filters).
  const data = t.guess;
  const read = async () => {
    const res = await fetch(data, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/130' } });
    const { parseEbGames } = await import('../server/monitor/listing.js');
    return parseEbGames(await res.text(), { base: data, storeBase: eb.base }).products;
  };
  let products = await read();
  assert.deepEqual(products.map((p) => p.sku), ['312400'], 'only the pre-order trading cards');
  let out = await pages().browserResults(admin(), [{ id: t.id, ok: true, how: 'data', learned: data, products }]);
  assert.equal(out[0].ok, true);
  let view = await watchOf(ash, w.id);
  assert.equal(view.looked, true);
  assert.deepEqual(view.found.map((f) => f.sku), ['312400']);
  const first = env.app.repo.itemBySku(ash.user.id, 'demo-ebgames', '312400');
  assert.equal(first.aco, false, 'up for pre-order at the first look: not bought');
  // Its next read: the learned data, asked for from inside the page.
  clock.offset += 3100;
  due = pages().browserDue(admin(), { version: '1.34.0' });
  t = due.pages[0];
  assert.equal(t.dataUrl, data);
  // A new pre-order with a phrase, and one without.
  const dmsBefore = dms('d-ash').length;
  store.addProduct('ebgames', { sku: '312401', name: 'Magic: The Gathering Lorwyn Eclipsed Collector Booster Box', price: 239, status: 'preorder' });
  store.addProduct('ebgames', { sku: '312402', name: 'Pokémon TCG: Phantasmal Flames Booster Bundle', price: 60, status: 'preorder' });
  products = await read();
  assert.equal(products.length, 3);
  await pages().browserResults(admin(), [{ id: t.id, ok: true, how: 'data', products }]);
  const item = env.app.repo.itemBySku(ash.user.id, 'demo-ebgames', '312401');
  assert.ok(item, "on Ash's watchlist");
  assert.equal(item.aco, true);
  assert.equal(item.maxPrice, 250);
  assert.equal(runsFor(item.id).length, 1, 'bought the moment it was found');
  assert.ok(dms('d-ash').slice(dmsBefore).some((m) => /Lorwyn Eclipsed Collector Booster Box/.test(m.body.embeds[0].title)), "DM'd at once");
  assert.equal(env.app.repo.itemBySku(ash.user.id, 'demo-ebgames', '312402'), null, 'no phrase: left alone');
  assert.equal(env.app.catalog.productFor('demo-ebgames', '312401'), null, "a member's own: never in everyone's catalogue");
  // Turned away in the browser: said, and asked again later.
  clock.offset += 3100;
  t = pages().browserDue(admin(), { version: '1.34.0' }).pages[0];
  await pages().browserResults(admin(), [{ id: t.id, ok: false, status: 429 }]);
  assert.match(env.app.drops.get(w.id).error, /refused the admin's browser \(HTTP 429\) — backing off/);
  assert.equal((await watchOf(ash, w.id)).error, 'Not searched at the moment — Mugibot tries again shortly', 'members: in plain words');
  clock.offset += 3100;
  assert.equal(pages().browserDue(admin(), { version: '1.34.0' }).pages.length, 0, 'backing off');
  clock.offset += 30 * 1000;
  t = pages().browserDue(admin(), { version: '1.34.0' }).pages[0];
  assert.ok(t, 'asked again half a minute later');
  await pages().browserResults(admin(), [{ id: t.id, ok: true, how: 'data', products: await read() }]);
  view = await watchOf(ash, w.id);
  assert.equal(view.fails, 0);
  assert.equal(runsFor(item.id).length, 1, 'bought once');
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
  assert.equal(env.app.repo.itemBySku(ash.user.id, 'demo-ebgames', '312401'), null, 'what it put on the watchlist goes too');
});

test("🔎 a collection page whose products.json comes back empty (JB Hi-Fi's — its page drawn by its own code): Mugibot's server reads nothing there, so an admin's browser draws the page instead — and that first read is the scene (nothing in it a drop)", async () => {
  store.addProduct('jbhifi', { sku: 'magic-the-gathering-foundations-bundle', name: 'Magic: The Gathering Foundations Bundle', price: 69, status: 'in_stock' });
  const page = `${store.url}/jbhifi/collections/magic-the-gathering`;
  const r = await boss.post('/api/drops', { page, phrases: ['magic the gathering'], every: 3, shared: false, aco: true, maxPrice: 100 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  // An admin's browser is about (it's asked for pages lately).
  const about = () => pages().browserDue(admin(), { version: '1.34.0' });
  about();
  await tick();
  assert.equal((await watchOf(boss, w.id)).seen, 0);
  about();
  await tick();
  let view = await watchOf(boss, w.id);
  assert.match(view.error, /Mugibot's server reads no products on this page — an admin's browser reads it instead/);
  assert.equal(pages().wayFor(pages().groups().get(`demo-jbhifi|${page}`)), 'browser');
  // The browser: the page opened, its tiles read.
  const t = pages().browserDue(admin(), { version: '1.34.0' }).pages.find((x) => x.store === 'demo-jbhifi');
  assert.ok(t, 'handed to the browser');
  assert.deepEqual([t.render, t.learn, t.parser, t.url], [true, false, 'generic', page]);
  const url = `${store.url}/jbhifi/products/magic-the-gathering-foundations-bundle`;
  await pages().browserResults(admin(), [{ id: t.id, ok: true, how: 'page', products: [{ sku: 'magic-the-gathering-foundations-bundle', title: 'Magic: The Gathering Foundations Bundle', price: 69, inStock: true, url }] }]);
  view = await watchOf(boss, w.id);
  assert.equal(view.via, 'browser', 'admins see where it was read');
  assert.equal(view.error, '');
  const item = env.app.repo.itemBySku(boss.user.id, 'demo-jbhifi', 'magic-the-gathering-foundations-bundle');
  assert.ok(item, 'on the watchlist');
  assert.equal(item.aco, false, 'there already (the first read from the browser): not bought');
  assert.equal(runsFor(item.id).length, 0);
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🔎 a product Mugibot knew as sold out comes onto the page on sale (Trainer Town's collection, its products.json): a drop — the member's watch DMs them and buys it; the same watch, read again, buys nothing twice", async () => {
  const page = `${store.url}/trainertown/collections/one-piece-trading-card-game`;
  const r = await ash.post('/api/drops', { page, phrases: ['one piece op 14', 'one piece op 15'], every: 15, aco: true, maxPrice: 220 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  await tick();
  let view = await watchOf(ash, w.id);
  assert.equal(view.looked, true);
  const op14 = env.app.repo.itemBySku(ash.user.id, 'demo-trainertown', 'one-piece-tcg-op-14-booster-box');
  assert.ok(op14, 'sold out at the first look: on the watchlist, armed for when it comes back');
  assert.equal(op14.aco, true);
  assert.equal(op14.status, 'out_of_stock');
  // It comes back in stock: bought (the watchlist item's own Auto-checkout), and DM'd.
  const before = dms('d-ash').length;
  store.set('trainertown', 'one-piece-tcg-op-14-booster-box', { status: 'in_stock' });
  await tick();
  assert.equal(runsFor(op14.id).length, 1, 'bought as it came back');
  assert.ok(dms('d-ash').slice(before).some((m) => /OP-14 Booster Box/.test(m.body.embeds[0].title)));
  // A new one on the page: bought at once.
  store.addProduct('trainertown', { sku: 'one-piece-tcg-op-15-booster-box', name: 'One Piece - TCG - OP-15 Booster Box', price: 199.95, status: 'in_stock' });
  await tick();
  const op15 = env.app.repo.itemBySku(ash.user.id, 'demo-trainertown', 'one-piece-tcg-op-15-booster-box');
  assert.ok(op15);
  assert.equal(runsFor(op15.id).length, 1);
  await tick();
  assert.equal(runsFor(op14.id).length, 1);
  assert.equal(runsFor(op15.id).length, 1);
  view = await watchOf(ash, w.id);
  assert.deepEqual(view.found.map((f) => f.sku).sort(), ['one-piece-tcg-op-14-booster-box', 'one-piece-tcg-op-15-booster-box']);
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("🔎 another website's page (Acme Collectibles' New arrivals): an admin's watch for everyone posts what drops in #non-tcg-alerts, alerts only (no ⚡ Buy); a member's own DMs them; a website that refuses the server is let be, then read again", async () => {
  const setup = await boss.post('/api/drops/channel', {});
  assert.equal(setup.status, 200, setup.text);
  const nontcg = discord.state.channels.find((c) => c.name === 'non-tcg-alerts').id;
  const page = `${store.url}/acme/collections/new`;
  const shared = await boss.post('/api/drops', { page, phrases: ['xbox series x', 'gear 5 figure'], every: 3 });
  assert.equal(shared.status, 200, shared.text);
  const own = await ash.post('/api/drops', { page, phrases: ['xbox series x'], every: 3 });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.watch.canBuy, false);
  const reads = () => store.state.requests.filter((x) => x.path === '/acme/collections/new').length;
  let n = reads();
  const before = posts(nontcg).length;
  await tick();
  assert.equal(reads(), n + 1, 'one read for both watches');
  assert.equal(posts(nontcg).length, before, 'its first look: the scene');
  assert.deepEqual((await watchOf(ash, own.body.watch.id)).found.map((f) => f.name), ['Xbox Series X Console 1TB'], 'on Ash\'s watchlist (alerts only)');
  // The limited edition drops: posted for everyone (alerts only), and DM'd to Ash.
  const dmsBefore = dms('d-ash').length;
  store.setAcme('xbox-series-x-25th-anniversary-edition', { listed: true });
  await tick();
  const post = posts(nontcg).slice(before).find((m) => /25th Anniversary/.test(m.body.embeds[0].title));
  assert.ok(post, 'posted in #non-tcg-alerts');
  assert.ok(!buttons(post).some((b) => /Buy/.test(b)), 'another website: no ⚡ Buy');
  assert.ok(dms('d-ash').slice(dmsBefore).some((m) => /25th Anniversary/.test(m.body.embeds[0].title)), "DM'd to Ash");
  // It turns Mugibot away: said, and let be a while.
  store.state.acme.refuse = true;
  await tick();
  assert.match(env.app.drops.get(shared.body.watch.id).error, /refused/);
  n = reads();
  clock.offset += 5 * 1000;
  await pages().tick();
  assert.equal(reads(), n, 'let be');
  store.state.acme.refuse = false;
  await tick();
  assert.equal(env.app.drops.get(shared.body.watch.id).fails, 0, 'read again');
  assert.equal((await boss.del(`/api/drops/${shared.body.watch.id}`)).status, 200);
  assert.equal((await ash.del(`/api/drops/${own.body.watch.id}`)).status, 200);
});

test("🔎 pacing: each watch's page read as often as it asks (two watches on one page: one read, at the quicker one's pace); a store that says to wait (HTTP 429, Retry-After) is waited for; a switched-off store's pages wait", async () => {
  const page = `${store.url}/target/search?text=pokemon`;
  const a = await boss.post('/api/drops', { page, phrases: ['mega evolution'], every: 30, shared: false });
  const b = await ash.post('/api/drops', { page, phrases: ['prismatic evolutions'], every: 4 });
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  const g = () => pages().groups().get(`demo-target|${page}`);
  assert.equal(g().every, 4);
  assert.equal(g().watches.length, 2);
  const reads = () => store.state.requests.filter((x) => x.path === '/target/search').length;
  let n = reads();
  await tick();
  assert.equal(reads(), n + 1);
  clock.offset += 2000;
  assert.equal(await pages().tick(), 0, 'not before its 4 s');
  clock.offset += 2100;
  assert.equal(await pages().tick(), 1, 'at 4 s');
  // "Too many requests — try again in 60 s": nothing asked before then.
  store.state.tooMany.target = 60;
  clock.offset += 4100;
  await pages().tick();
  delete store.state.tooMany.target;
  assert.match(env.app.drops.get(b.body.watch.id).error, /refused Mugibot's server \(HTTP 429\)/);
  n = reads();
  clock.offset += 30 * 1000;
  assert.equal(await pages().tick(), 0, 'still waiting');
  clock.offset += 31 * 1000;
  assert.equal(await pages().tick(), 1, 'asked again once the wait was up');
  // Switched off: its pages wait (and say so).
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { ...MODES, 'demo-target': 'off' } })).status, 200);
  n = reads();
  await tick();
  assert.equal(reads(), n);
  assert.equal((await watchOf(ash, b.body.watch.id)).waiting, 'off');
  assert.equal((await boss.put('/api/monitor/sweep', { stores: MODES })).status, 200);
  assert.equal((await boss.del(`/api/drops/${a.body.watch.id}`)).status, 200);
  assert.equal((await ash.del(`/api/drops/${b.body.watch.id}`)).status, 200);
  assert.equal(pages().groups().get(`demo-target|${page}`), undefined);
});

test("🔎 the admin's browser asks for its page reads beside its searches (GET /api/ext/sweeps: pages — each store's in a tab of its own, none for a tab still reading), and sends back what it read (POST: pages)", async () => {
  const device = await Device.pair(env.url, boss, 'Admin Chrome');
  const page = `${store.url}/ebgames/search?category=trading-cards&condition=preorder`;
  const r = await boss.post('/api/drops', { page, phrases: ['lorcana'], every: 3 });
  assert.equal(r.status, 200, r.text);
  try {
    let due = await device.call('GET', '/api/ext/sweeps?v=1.33.0');
    assert.equal(due.status, 200);
    assert.deepEqual(due.body.pages, [], 'an older extension: none');
    due = await device.call('GET', `/api/ext/sweeps?v=1.34.0&busy=${encodeURIComponent('page:demo-ebgames')}`);
    assert.deepEqual(due.body.pages, [], 'its tab still reading: none yet');
    due = await device.call('GET', '/api/ext/sweeps?v=1.34.0');
    const t = due.body.pages.find((x) => x.store === 'demo-ebgames');
    assert.ok(t, 'handed out');
    assert.equal(t.tab, 'page:demo-ebgames');
    assert.ok(typeof due.body.waitMs === 'number');
    store.addProduct('ebgames', { sku: '312500', name: 'Disney Lorcana TCG Whispers in the Well Booster Box', price: 199, status: 'preorder' });
    const res = await device.call('POST', '/api/ext/sweeps', { pages: [{ id: t.id, ok: true, how: 'page', products: [{ sku: '312500', title: 'Disney Lorcana TCG Whispers in the Well Booster Box', price: 199, inStock: true, preorder: true, url: `${store.url}/ebgames/product/toys-and-collectibles/312500-disney-lorcana` }] }] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.pages, [{ id: t.id, ok: true, products: 1 }]);
    const view = await watchOf(boss, r.body.watch.id);
    assert.equal(view.looked, true);
    assert.equal(view.via, 'browser');
    // (A product link off the store, or junk: never taken.)
    const t2 = (await device.call('GET', '/api/ext/sweeps?v=1.34.0')).body.pages.find((x) => x.store === 'demo-ebgames');
    if (t2) {
      const junk = await device.call('POST', '/api/ext/sweeps', { pages: [{ id: t2.id, ok: true, how: 'page', products: [{ sku: '1', title: 'Lorcana elsewhere', url: 'https://evil.example/p/1' }, 'x', null] }] });
      assert.deepEqual(junk.body.pages, [{ id: t2.id, ok: true, products: 0 }]);
    }
    // A member's browser: never handed pages, and what it sends is ignored.
    const memberDevice = await Device.pair(env.url, ash, 'Ash Chrome');
    assert.equal((await memberDevice.call('GET', '/api/ext/sweeps?v=1.34.0')).body.pages, undefined);
    assert.deepEqual((await memberDevice.call('POST', '/api/ext/sweeps', { pages: [{ id: t.id, ok: true, products: [] }] })).body.results, []);
  } finally {
    await boss.del(`/api/drops/${r.body.watch.id}`);
  }
});

test("🔎 a store's pages read from an admin's browser take turns: one at a time in its tab, and all of them together about once a second at most (BIG W's every 7 s) — never a burst the store would turn away", async () => {
  const pageA = `${store.url}/ebgames/search?category=trading-cards`;
  const pageB = `${store.url}/ebgames/search?q=lorcana`;
  const a = await boss.post('/api/drops', { page: pageA, phrases: ['magic the gathering'], every: 3, shared: false });
  const b = await ash.post('/api/drops', { page: pageB, phrases: ['lorcana'], every: 3 });
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  try {
    clock.offset += 60 * 1000;
    const due = () => pages().browserDue(admin(), { version: '1.34.0' }).pages;
    const first = due();
    assert.equal(first.length, 1, 'one at a time in the store\'s tab');
    await pages().browserResults(admin(), [{ id: first[0].id, ok: true, how: 'page', products: [] }]);
    assert.equal(due().length, 0, 'the other waits its turn');
    clock.offset += 1100;
    const second = due();
    assert.equal(second.length, 1);
    assert.notEqual(second[0].url, first[0].url, 'then the other page');
  } finally {
    await boss.del(`/api/drops/${a.body.watch.id}`);
    await ash.del(`/api/drops/${b.body.watch.id}`);
  }
});
