// Live sweeps (docs/MONITORING.md), after MugiWatch: each store's search read
// every few seconds. Reading Target's, Shopify's and any store's results; the
// first sweep only sets the scene; new drops, restocks (once a day) and price
// drops alert at once in the feed, in Discord and to members watching the
// SKU; filters (keyword in the name, trading cards, marketplace sellers);
// refused searches back off; admins' browsers sweep the stores that refuse
// servers; the settings; and the store client that stores answer.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { Client, Device, discordOpts, makeMember, startApp, startFakeDiscord, waitFor } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { mentions, parseGeneric, parseShopifySuggest, parseTarget, termsRegex } from '../server/monitor/listing.js';
import { storeFetch } from '../server/monitor/http.js';
import { Sweeper } from '../server/monitor/sweep.js';

// --- reading results -----------------------------------------------------------
function targetPage(products, total = products.length) {
  const data = { props: { pageProps: { metadata: { totalNumProducts: total, productList: { totalNumProducts: total, products } } } } };
  return `<!doctype html><html><head><title>pokemon | Target Australia</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}
const targetProduct = (code, title, { inStock = true, price = 10, was = 0, variants = 1, displayOnly = false } = {}) => ({
  id: `P${code}`, baseProductUrl: `https://www.target.com.au/p/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/P${code}`, title,
  imageUrl: `https://assets.target.com.au/transform/x/${code}-IMG-000`, displayOnly,
  price: { offerPrice: price, wasPrice: was, priceRange: { min: price, max: price } }, labelProps: { onlineDate: 1790000000 },
  variations: Array.from({ length: variants }, (_, i) => ({
    colourVariantCode: Number(code) + i, url: `https://www.target.com.au/p/x/${Number(code) + i}`, productDisplayType: 'AVAILABLE_FOR_SALE', ...(i === 0 ? { inStock } : {}),
  })),
});

test("Target's results: every product with its code, price, stock (any colour or size in stock), link and picture", () => {
  const r = parseTarget(targetPage([
    targetProduct('72086971', 'Pokemon TCG: Mega Evolution Blisters', { price: 8.5 }),
    targetProduct('73062073', 'Pokemon TCG: Pitch Black Booster', { inStock: false, price: 8.5, was: 10 }),
    targetProduct('71000000', 'Pokemon Pyjamas', { variants: 3 }),
    targetProduct('70000000', 'Pre-Order Pokemon TCG: Ascended Heroes ETB', { price: 89 }),
  ], 136));
  assert.equal(r.problem, null);
  assert.equal(r.total, 136);
  const [a, b, c, d] = r.products;
  assert.deepEqual([a.sku, a.aliases, a.price, a.inStock, a.url], ['72086971', ['P72086971'], 8.5, true, 'https://www.target.com.au/p/x/72086971']);
  assert.equal(b.inStock, false, 'no colour or size in stock = out of stock');
  assert.equal(b.wasPrice, 10);
  assert.equal(c.sku, 'P71000000', 'several sizes: the product itself');
  assert.match(c.url, /\/P71000000$/);
  assert.equal(c.inStock, true);
  assert.equal(d.preorder, true);
  // Clothing: stock per size.
  const sized = (sizes, extra = {}) => ({ ...targetProduct('73086406', 'Pokemon Socks'), variations: [{ colourVariantCode: 73086406, url: 'https://www.target.com.au/p/x/73086406', ...extra, sizeVariants: sizes.map((inStock, i) => ({ inStock, sizeVariantCode: 73086440 + i })) }] });
  const [s1, s2, s3] = parseTarget(targetPage([sized([false, true], { stockAvailable: true }), sized([false, false]), sized([])])).products;
  assert.equal(s1.inStock, true);
  assert.equal(s2.inStock, false, 'every size sold out');
  assert.equal(s3.inStock, null, 'nothing said about stock: unknown, not sold out');
  assert.equal(parseTarget('<html><title>Access Denied</title>Reference #18.e34d517.1792122955.f0ebd5</html>').problem, 'blocked');
  assert.equal(parseTarget('<html><title>Target</title><body>new layout</body></html>').problem, 'layout');
});

test("Shopify's search suggestions (JB Hi-Fi): handle, price, stock and a clean link", () => {
  const r = parseShopifySuggest(JSON.stringify({ resources: { results: { products: [
    { id: 7338075586761, handle: 'pokemon-tcg-deck-crafters', title: 'Pokemon TCG - Deck Crafter’s Collection', price: '20.00', available: true, url: '/products/pokemon-tcg-deck-crafters?_pos=1&_sid=a&_ss=r', image: '//cdn.shopify.com/x.jpg' },
    { id: 2, handle: 'one-piece-op-08', title: 'One Piece TCG OP-08 Booster Box', price: '177.54', available: false, url: '/products/one-piece-op-08?_pos=2', featured_image: { url: 'https://cdn.shopify.com/y.jpg' } },
  ] } } }), { base: 'https://www.jbhifi.com.au/search/suggest.json?q=pokemon' });
  assert.deepEqual(r.products.map((p) => [p.sku, p.price, p.inStock, p.url, p.image]), [
    ['pokemon-tcg-deck-crafters', 20, true, 'https://www.jbhifi.com.au/products/pokemon-tcg-deck-crafters', 'https://cdn.shopify.com/x.jpg'],
    ['one-piece-op-08', 177.54, false, 'https://www.jbhifi.com.au/products/one-piece-op-08', 'https://cdn.shopify.com/y.jpg'],
  ]);
  assert.equal(parseShopifySuggest('<html>nope</html>').problem, 'layout');
});

test('any store: product tiles in the page, and product data in its scripts (JSON-LD, Next.js data, embedded state)', () => {
  const opts = { base: 'https://www.kmart.com.au/search/?searchTerm=pokemon', productPath: /^\/product\/[^/]*-\d{6,10}\/?$/, skuFromPath: /-(\d{6,10})\/?$/, storeName: 'Kmart' };
  const tiles = parseGeneric(`<html><body>
    <div class="product-tile"><a href="/product/pokemon-tcg-etb-43818587/"><img src="https://assets.kmart.com.au/a.jpg" alt="">Pokémon TCG: Elite Trainer Box</a><span>$100.00</span><button>Add to bag</button></div>
    <div class="product-tile"><a href="/product/pokemon-tcg-upc-43818648/">Pokémon TCG: Ultra-Premium Collection</a><span>$360</span><button disabled>Out of stock</button></div>
    <div class="product-tile"><a href="/product/pokemon-plush-43800000/">Pokemon Plush</a><span>$20</span><p>Sold by ToyWorld · Marketplace</p></div>
    <a href="/product/pokemon-tcg-etb-43818587/">duplicate link</a><a href="/help">Help</a></body></html>`, opts);
  assert.deepEqual(tiles.products.map((p) => [p.sku, p.title, p.price, p.inStock, p.marketplace]), [
    ['43818587', 'Pokémon TCG: Elite Trainer Box', 100, true, false],
    ['43818648', 'Pokémon TCG: Ultra-Premium Collection', 360, false, false],
    ['43800000', 'Pokemon Plush', 20, null, true],
  ]);
  assert.equal(tiles.products[0].image, 'https://assets.kmart.com.au/a.jpg');

  const scripts = parseGeneric(`<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: [
    { '@type': 'Product', name: 'Pokémon TCG: Booster Bundle', sku: '43811111', url: 'https://www.kmart.com.au/product/pokemon-tcg-booster-bundle-43811111/', offers: { price: '45.00', availability: 'https://schema.org/InStock' } },
  ] })}</script><script>window.__INITIAL_STATE__ = ${JSON.stringify({ search: { results: [
    { productName: 'One Piece Card Game Starter Deck', price: { value: 19 }, pdpUrl: '/product/one-piece-starter-deck-43822222/', isAvailable: false, sellerName: 'Kmart' },
    { productName: 'Pokemon Cards Lot', price: 9, pdpUrl: '/product/pokemon-cards-lot-43833333/', isMarketplace: true },
  ] } })};</script></head><body></body></html>`, opts);
  assert.deepEqual(scripts.products.map((p) => [p.sku, p.price, p.inStock, p.marketplace]), [
    ['43811111', 45, true, false], ['43822222', 19, false, false], ['43833333', 9, null, true],
  ]);
  assert.equal(parseGeneric('<html><title>Just a moment...</title><div class="cf-chl-widget"></div></html>', opts).problem, 'blocked');
  assert.equal(parseGeneric('<html><title>Search</title><p>No results</p></html>', opts).problem, 'empty');
});

test('which products count: every word of the keyword in the name (accents ignored), trading-card words', () => {
  assert.equal(mentions('Pokémon TCG: Booster', 'pokemon'), true);
  assert.equal(mentions('Bandai ONE PIECE Card Game', 'one piece'), true);
  assert.equal(mentions('Pokemon TCG Storm Emeralda Box Booster Packs', 'pokemon booster'), true);
  assert.equal(mentions('Pokeball Plush', 'pokemon'), false);
  assert.equal(mentions('Someone Piece', 'one piece'), false);
  const tcg = termsRegex(['card', 'booster', 'elite trainer']);
  assert.equal(tcg.test('pokemon tcg booster box'), true);
  assert.equal(tcg.test('pokemon elite trainer box'), true);
  assert.equal(tcg.test('pokemon plush pikachu'), false);
  assert.equal(tcg.test('pokemon cardigan'), false, 'whole words only');
});

// --- the store client ------------------------------------------------------------
test('store requests: answered like fetch (gzip and brotli unpacked), redirects handed back, slow stores time out', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/html' }); return res.end(zlib.gzipSync('<p>hello gzip</p>')); }
    if (req.url === '/br') { res.writeHead(200, { 'content-encoding': 'br', 'content-type': 'application/json' }); return res.end(zlib.brotliCompressSync('{"ok":true}')); }
    if (req.url === '/moved') { res.writeHead(302, { location: '/gzip' }); return res.end(); }
    if (req.url === '/ua') { res.writeHead(200); return res.end(String(req.headers['user-agent'])); }
    if (req.url === '/slow') return setTimeout(() => res.end('late'), 2000);
    res.writeHead(404);
    return res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const a = await storeFetch(`${base}/gzip`);
    assert.equal(a.status, 200);
    assert.equal(a.ok, true);
    assert.equal(await a.text(), '<p>hello gzip</p>');
    assert.match(a.headers.get('content-type'), /html/);
    assert.deepEqual(await (await storeFetch(`${base}/br`)).json(), { ok: true });
    const m = await storeFetch(`${base}/moved`);
    assert.equal(m.status, 302);
    assert.equal(m.headers.get('location'), '/gzip');
    assert.equal(await (await storeFetch(`${base}/ua`, { headers: { 'user-agent': 'Mugibot/1.0 (test)' } })).text(), 'Mugibot/1.0 (test)');
    await assert.rejects(storeFetch(`${base}/slow`, { timeoutMs: 200 }), (e) => e.name === 'TimeoutError');
    await assert.rejects(storeFetch(`${base}/slow`, { signal: AbortSignal.timeout(200) }), (e) => e.name === 'TimeoutError');
    assert.equal((await storeFetch(`${base}/nope`)).ok, false);
  } finally {
    srv.close();
    srv.closeAllConnections?.();
  }
});

// --- the sweeps, against the dummy stores ------------------------------------------------
let env;
let store;
let discord;
let boss;
let ash;
let sw;
let clock;
before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  clock = { offset: 0 };
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, now: () => Date.now() + clock.offset, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  makeMember(env, ash);
  for (const c of [boss, ash]) for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  env.app.repo.updateUser(ash.user.id, { discord_id: 'd-ash' });
  sw = env.app.sweeper;
});
after(async () => {
  sw.stop();
  await env.close();
  await store.close();
  await discord.close();
});
beforeEach(() => { store.state.blockNonBrowsers = false; });

const R = (id) => env.app.retailers.get(id);
const sweep = (id, keyword = 'pokemon', page = 1) => sw.sweepTerm(R(id), { keyword, page });
const alerts = (kind) => env.app.catalog.recentAlerts({ kind, limit: 100 });
const channel = () => discord.channelPosts('chan-restocks');
const product = (store_, sku) => env.app.catalog.productFor(store_, sku);

test('sweep settings: admins only, checked, and the dummy-store copies are off unless switched on', async () => {
  assert.equal((await ash.get('/api/monitor/sweep')).status, 404, 'members can\'t see the sweep settings');
  let r = await boss.get('/api/monitor/sweep');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.settings.keywords, ['pokemon', 'one piece']);
  const mode = (id) => r.body.stores.find((s) => s.store === id).mode;
  assert.equal(mode('target'), 'server');
  assert.equal(mode('jbhifi'), 'server');
  assert.equal(mode('kmart'), 'browser', 'stores that refuse servers: from an admin\'s browser');
  assert.equal(mode('demo-kmart'), 'off');
  assert.equal((await boss.put('/api/monitor/sweep', { keywords: '' })).status, 400, 'at least one keyword');
  assert.equal((await boss.put('/api/monitor/sweep', { everySeconds: 1 })).body.settings.everySeconds, 3, 'never faster than every 3 seconds');
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-kmart': 'sideways' } })).status, 400);
  // The real stores off (tests never touch them); the dummy ones swept from the server.
  r = await boss.put('/api/monitor/sweep', {
    everySeconds: 5, keywords: 'Pokemon, one piece',
    stores: { target: 'off', jbhifi: 'off', toysrus: 'off', kmart: 'off', bigw: 'off', ebgames: 'off', zing: 'off', 'demo-kmart': 'server', 'demo-jbhifi': 'server', 'demo-bigw': 'server', 'demo-ebgames': 'browser' },
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.settings.keywords, ['pokemon', 'one piece']);
  assert.equal(mode('demo-kmart'), 'server');
  assert.equal(mode('target'), 'off');
});

test('the first sweep sets the scene: everything found is tracked, nothing alerts; non-card products are left out', async () => {
  store.set('kmart', '43818648', { status: 'out_of_stock', price: 360 });
  store.set('kmart', '43818556', { name: 'Pokémon Plush Pikachu 30cm', status: 'in_stock' });
  const r = await sweep('demo-kmart');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.baseline, true);
  assert.equal(r.found, 3);
  assert.equal(r.kept, 2, 'the plush is not a trading-card product');
  assert.equal(r.new, 0);
  const upc = product('demo-kmart', '43818648');
  assert.equal(upc.status, 'out_of_stock');
  assert.equal(upc.price, 360);
  assert.equal(upc.category, 'pokemon');
  assert.match(upc.url, /\/kmart\/product\/.*-43818648\/$/);
  assert.match(upc.image, /\/img\/kmart\/43818648\.svg$/);
  assert.ok(!product('demo-kmart', '43818556'));
  assert.equal(alerts().length, 0);
  // Members see what the sweeps track, with the 🆕 marker data.
  const list = (await ash.get('/api/monitor/products?store=demo-kmart')).body.products;
  assert.deepEqual(list.map((p) => p.sku).sort(), ['43818587', '43818648']);
  assert.equal(list[0].monitor, null);
  assert.equal(list[0].sweep.keyword, 'pokemon');
  assert.equal((await ash.get(`/api/monitor/products/${upc.id}`)).status, 200, 'a swept product has its own page');
  for (const id of ['demo-jbhifi', 'demo-bigw']) assert.equal((await sweep(id)).baseline, true);
  assert.equal((await sweep('demo-jbhifi', 'one piece')).baseline, true);
});

test('🆕 a new drop alerts the moment a sweep sees it: the feed, Discord (with ⚡ Buy) and the open dashboards', async () => {
  store.set('kmart', '43818648', { listed: false });
  await sweep('demo-kmart');
  store.set('kmart', '43818648', { listed: true });
  // Not new: it was there before. A product the store adds is.
  store.shop('kmart').products.push({ sku: '43899999', name: 'Pokémon TCG: Mega Evolution Booster Box', price: 199, status: 'in_stock', listed: true, maxQty: 0, qtyStyle: 'input', lateMs: 0, id: 4499999 });
  const before = channel().length;
  const r = await sweep('demo-kmart');
  assert.equal(r.baseline, false);
  assert.equal(r.new, 1);
  const [a] = alerts('listed');
  assert.equal(a.sku, '43899999');
  assert.equal(a.status, 'in_stock');
  assert.equal(a.price, 199);
  assert.match(a.note, /New in "pokemon" at Kmart/);
  const post = channel().slice(before);
  assert.equal(post.length, 1, 'posted in the restock channel');
  const embed = post[0].body.embeds[0];
  assert.match(embed.title, /🆕 New drop: Pokémon TCG: Mega Evolution Booster Box/);
  assert.ok(post[0].body.components[0].components.some((b) => b.label === '⚡ Buy with Mugibot' && /\/buy\?store=demo-kmart&sku=43899999/.test(b.url)));
  assert.equal((await sweep('demo-kmart')).new, 0, 'only once');
});

test('🟢 out of stock → in stock alerts a restock, once a day per product; no alert for sold out', async () => {
  store.set('kmart', '43818648', { status: 'in_stock' });
  let r = await sweep('demo-kmart');
  assert.equal(r.restock, 1);
  const [a] = alerts('restock');
  assert.equal(a.sku, '43818648');
  assert.equal(product('demo-kmart', '43818648').status, 'in_stock');
  store.set('kmart', '43818648', { status: 'out_of_stock' });
  r = await sweep('demo-kmart');
  assert.equal(product('demo-kmart', '43818648').status, 'out_of_stock');
  assert.equal(alerts('sold_out').length, 0, 'sold out shows on the dashboard; no ping');
  // Back in stock later the same day: no second ping (MugiWatch's once a day), even after the cooldown.
  clock.offset += 20 * 60 * 1000;
  store.set('kmart', '43818648', { status: 'in_stock' });
  r = await sweep('demo-kmart');
  assert.equal(r.restock, 0);
  assert.equal(alerts('restock').length, 1);
  assert.equal(product('demo-kmart', '43818648').status, 'in_stock');
  // The next day it can ping again.
  store.set('kmart', '43818648', { status: 'out_of_stock' });
  await sweep('demo-kmart');
  clock.offset += 24 * 3600 * 1000;
  await sweep('demo-kmart'); // (a search not run for hours sets the scene again first)
  store.set('kmart', '43818648', { status: 'in_stock' });
  assert.equal((await sweep('demo-kmart')).restock, 1);
});

test('📉 a price that falls by the set percentage alerts a price drop; smaller changes are only recorded', async () => {
  store.set('jbhifi', 'pokemon-tcg-30th-celebration-etb', { price: 99 });
  await sweep('demo-jbhifi');
  store.set('jbhifi', 'pokemon-tcg-30th-celebration-etb', { price: 94 });
  assert.equal((await sweep('demo-jbhifi')).price, 0, '5% is under the 10% setting');
  store.set('jbhifi', 'pokemon-tcg-30th-celebration-etb', { price: 79 });
  assert.equal((await sweep('demo-jbhifi')).price, 1);
  const [a] = alerts('price_drop');
  assert.equal(a.price, 79);
  assert.equal(a.previousPrice, 94);
  assert.match(a.note, /-16\.0%/);
  const p = product('demo-jbhifi', 'pokemon-tcg-30th-celebration-etb');
  assert.deepEqual(env.app.catalog.priceHistory(p.id).map((x) => x.price), [99, 94, 79]);
  store.set('jbhifi', 'pokemon-tcg-30th-celebration-etb', { price: 99 });
  await sweep('demo-jbhifi');
  assert.equal(alerts('price_rise').length, 0);
});

test('🎯 Target leaves sold-out products out of its results: gone from every page for a while = sold out, and back = a restock', async () => {
  const pages = { 1: [], 2: [] };
  let total = 0;
  const fakeTarget = async (url) => {
    const page = Number(new URL(url).searchParams.get('page') || 1);
    return new Response(targetPage(pages[page] || [], total), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const { cfg, repo, catalog, feed, monitor, retailers, hub } = env.app;
  const t = new Sweeper({ cfg, repo, catalog, feed, monitor, retailers, hub, fetchImpl: fakeTarget, now: () => Date.now() + clock.offset });
  const target = retailers.get('target');
  const etb = (inStock = true) => targetProduct('70100001', 'Pokemon TCG: Gone Elite Trainer Box', { price: 89, inStock });
  const fill = (withEtb) => {
    pages[1] = [1, 2, 3].map((i) => targetProduct(`7020000${i}`, `Pokemon TCG: Booster ${i}`));
    pages[2] = [targetProduct('70300001', 'Pokemon TCG: Tin'), ...(withEtb ? [etb()] : [])];
    total = withEtb ? 5 : 4;
  };
  const round = async () => [await t.sweepTerm(target, { keyword: 'pokemon', page: 1 }), await t.sweepTerm(target, { keyword: 'pokemon', page: 2 })];
  fill(true);
  await round();
  assert.equal(product('target', '70100001').status, 'in_stock');
  assert.deepEqual(t.nextTerm(target), { keyword: 'pokemon', page: 1 });
  assert.deepEqual([t.nextTerm(target), t.nextTerm(target)].map((x) => x.page), [1, 2], 'only the pages that have results: 2, not 4');
  // It drops out of the results. Not sold out straight away (it may just be moving between pages)…
  fill(false);
  let [, r] = await round();
  assert.equal(r.gone, 0);
  assert.equal(product('target', '70100001').status, 'in_stock');
  // …but after six minutes of every page being read without it, it is.
  clock.offset += 7 * 60 * 1000;
  [, r] = await round();
  assert.equal(r.gone, 1);
  assert.equal(product('target', '70100001').status, 'out_of_stock');
  // Back in the results: 🟢 a restock.
  const before = alerts('restock').length;
  fill(true);
  [, r] = await round();
  assert.equal(r.restock, 1);
  assert.equal(alerts('restock').length, before + 1);
  assert.equal(alerts('restock')[0].sku, '70100001');
  // With more results than the pages Mugibot reads, a missing product may just be further down: never marked.
  fill(false);
  total = 400;
  clock.offset += 7 * 60 * 1000;
  [, r] = await round();
  assert.equal(r.gone, 0);
  assert.equal(product('target', '70100001').status, 'in_stock');
});

test("members' own SKUs update straight away: a restock DM from a sweep, and a page check can't flip it back", async () => {
  store.set('bigw', '6012345', { status: 'out_of_stock' });
  const add = await ash.post('/api/items', { url: store.productUrl('bigw', '6012345'), name: 'BIG W UPC' });
  assert.equal(add.status, 200, add.text);
  const id = add.body.id;
  await sweep('demo-bigw');
  assert.equal(env.app.repo.getItem(ash.user.id, id).status, 'out_of_stock');
  const dms = discord.dmsTo('d-ash').length;
  store.set('bigw', '6012345', { status: 'in_stock' });
  await sweep('demo-bigw');
  const it = env.app.repo.getItem(ash.user.id, id);
  assert.equal(it.status, 'in_stock');
  assert.equal(it.statusSource, 'sweep');
  assert.equal(discord.dmsTo('d-ash').length, dms + 1, 'their own DM');
  // A slower page check that disagrees changes nothing while the sweep's view is fresh…
  await env.app.monitor.applyResult(env.app.db.get('SELECT * FROM items WHERE id = :id', { id }), { status: 'out_of_stock' }, 'server');
  assert.equal(env.app.repo.getItem(ash.user.id, id).status, 'in_stock');
  // …and the page isn't fetched at all while a sweep covers it.
  env.app.db.run('UPDATE page_checks SET next_check_at = 0');
  const pageHits = () => store.state.requests.filter((x) => x.path.includes('/p/6012345')).length;
  const before = pageHits();
  await env.app.monitor.tick();
  assert.equal(pageHits(), before);
  await ash.del(`/api/items/${id}`);
});

test("a SKU a member added before it was listed: the sweep finds its page and says it's in stock (any product, not just cards)", async () => {
  store.set('kmart', '43818556', { listed: false, status: 'in_stock' }); // (the plush: not in the feed, but a member can watch it)
  await sweep('demo-kmart');
  const add = await ash.post('/api/items', { store: 'demo-kmart', sku: '43818556', name: 'Pikachu plush' });
  assert.equal(add.status, 200, add.text);
  assert.equal(add.body.url, '', 'waiting for its page');
  store.set('kmart', '43818556', { listed: true });
  await sweep('demo-kmart');
  const it = env.app.repo.getItem(ash.user.id, add.body.id);
  assert.match(it.url, /\/kmart\/product\/.*-43818556\/$/);
  assert.equal(it.status, 'in_stock');
  assert.ok(!product('demo-kmart', '43818556'), 'still not in the shared feed');
  await ash.del(`/api/items/${add.body.id}`);
});

test('a store that refuses the search: no alert, the products keep their stock, and the store backs off', async () => {
  const before = product('demo-kmart', '43818587').status;
  store.state.blockNonBrowsers = true;
  const r = await sweep('demo-kmart');
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.match(r.error, /refused the search \(HTTP 403\)/);
  assert.equal(product('demo-kmart', '43818587').status, before);
  const h = sw.health().find((s) => s.store === 'demo-kmart');
  assert.equal(h.fails, 1);
  assert.match(h.lastError, /refused/);
  assert.ok(h.terms.find((t) => t.keyword === 'pokemon').fails >= 1);
  store.state.blockNonBrowsers = false;
  assert.equal((await sweep('demo-kmart')).ok, true);
  const after = sw.health().find((s) => s.store === 'demo-kmart');
  assert.equal(after.fails, 0);
  assert.ok(after.slowedUntil > Date.now(), 'answering again, but searched at a third of the pace for a while');
  assert.equal(sw.waitFor(sw.stat('demo-kmart'), 5000), 15000);
  sw.sweepNow();
  assert.equal(sw.waitFor(sw.stat('demo-kmart'), 5000), 5000, 'Sweep now: back to the set pace');
});

test('new keywords or filters set the scene again (no flood of "new" products), then alert as usual', async () => {
  const r = await boss.put('/api/monitor/sweep', { keywords: 'pokemon, one piece, elite trainer' });
  assert.equal(r.status, 200);
  const res = await sweep('demo-kmart', 'elite trainer');
  assert.equal(res.baseline, true);
  assert.equal(res.new, 0);
  assert.equal((await sweep('demo-kmart')).baseline, true, 'the old keywords too: the filters changed what counts');
  assert.equal((await boss.put('/api/monitor/sweep', { keywords: 'pokemon, one piece' })).status, 200);
});

test("admins' browsers sweep the stores that refuse servers; members' browsers never do", async () => {
  const admin = await Device.pair(env.url, boss, 'Boss Chrome');
  const member = await Device.pair(env.url, ash, 'Ash Chrome');
  assert.deepEqual((await member.call('GET', '/api/ext/sweeps')).body, { terms: [], waitMs: null });
  let due = await admin.call('GET', '/api/ext/sweeps');
  assert.equal(due.status, 200);
  const [t] = due.body.terms;
  assert.equal(t.store, 'demo-ebgames');
  assert.equal(t.parser, 'generic');
  assert.match(t.url, /\/ebgames\/search\?q=pokemon$/);
  assert.equal(t.productPath.re, R('demo-ebgames').productPath.source);
  assert.ok(due.body.waitMs >= 1000);
  assert.equal((await admin.call('GET', '/api/ext/sweeps')).body.terms.length, 0, 'leased: the next one comes after the wait');

  // The browser reads the page with the same code the server uses (lib/listing.js) and sends what it found.
  const html = await (await fetch(t.url, { headers: { 'user-agent': 'Mozilla/5.0 Chrome' } })).text();
  const found = parseGeneric(html, { base: t.url, productPath: R('demo-ebgames').productPath, skuFromPath: R('demo-ebgames').skuFromPath, storeName: 'EB Games' });
  assert.equal(found.products.length, 1);
  found.products.push({ sku: '999', title: 'Pokemon TCG: Elsewhere Box', price: 5, inStock: true, url: 'https://evil.example/product/x/999', image: 'javascript:alert(1)' });
  let r = await admin.call('POST', '/api/ext/sweeps', { results: [{ store: t.store, keyword: t.keyword, page: t.page, ok: true, status: 200, ms: 300, products: found.products }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].ok, true);
  assert.equal(r.body.results[0].baseline, true);
  const etb = product('demo-ebgames', '312346');
  assert.equal(etb.status, 'in_stock');
  const other = product('demo-ebgames', '999');
  assert.equal(other.url, '', 'links to other websites are dropped');
  assert.equal(other.image, '');
  assert.equal(sw.health().find((s) => s.store === 'demo-ebgames').terms[0].source, 'browser');

  // A member's browser can't change the shared feed.
  r = await member.call('POST', '/api/ext/sweeps', { results: [{ store: t.store, keyword: t.keyword, page: 1, ok: true, products: [{ sku: '312346', title: 'Pokémon TCG: 30th Celebration Elite Trainer Box', price: 1, inStock: false }] }] });
  assert.deepEqual(r.body.results, []);
  assert.equal(product('demo-ebgames', '312346').status, 'in_stock');
  // A refused search from the admin's browser backs off.
  r = await admin.call('POST', '/api/ext/sweeps', { results: [{ store: t.store, keyword: t.keyword, page: 1, ok: false, status: 403 }] });
  assert.match(r.body.results[0].error, /refused the admin's browser \(HTTP 403\)/);
  // A store that's swept from the server isn't the browser's to report on.
  r = await admin.call('POST', '/api/ext/sweeps', { results: [{ store: 'demo-kmart', keyword: 'pokemon', page: 1, ok: true, products: [] }] });
  assert.deepEqual(r.body.results, []);
  sw.sweepNow();
  due = await admin.call('GET', '/api/ext/sweeps');
  assert.equal(due.body.terms.length, 1, 'Sweep now: straight away');
});

test('the loops: each store swept from the server on its own loop, every few seconds; switched off, it stops', async () => {
  const before = store.state.requests.filter((x) => x.path.startsWith('/kmart/search')).length;
  sw.running = false;
  sw.cfg.monitor.enabled = true;
  sw.start();
  try {
    await waitFor(() => store.state.requests.filter((x) => x.path.startsWith('/kmart/search')).length >= before + 2, { timeout: 15000, message: 'two Kmart searches' });
    assert.ok(sw.loops.has('demo-kmart'));
    assert.ok(sw.loops.has('demo-jbhifi'));
    assert.ok(!sw.loops.has('demo-ebgames'), 'browser stores have no server loop');
    const h = (await boss.get('/api/monitor/sweep')).body.stores.find((s) => s.store === 'demo-kmart');
    assert.equal(h.running, true);
    assert.ok(h.requests1h >= 2);
    assert.ok((await boss.get('/api/monitor')).body.overview.sweeps1h >= 2);
    await boss.put('/api/monitor/sweep', { stores: { 'demo-kmart': 'off' } });
    await waitFor(() => !sw.loops.has('demo-kmart'), { timeout: 15000, message: 'the Kmart loop to stop' });
  } finally {
    sw.stop();
    sw.cfg.monitor.enabled = false;
  }
});
