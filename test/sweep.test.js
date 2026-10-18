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
import { mentions, parseAmazon, parseConstructor, parseEbGames, parseGeneric, parseListing, parseShopifyProducts, parseShopifySuggest, parseTarget, termsRegex } from '../server/monitor/listing.js';
import { storeFetch } from '../server/monitor/http.js';
import { Sweeper, olderVersion, retryAfterMs } from '../server/monitor/sweep.js';

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

test("a Shopify collection's product list (Trainer Town): every product, in stock when any option is, and the option to add to the cart", () => {
  const r = parseShopifyProducts(JSON.stringify({ products: [
    { id: 8630270394456, handle: 'pokemon-tcg-ascended-heroes-booster-bundle-sealed-display', title: 'Pokémon - TCG - Ascended Heroes Booster Bundle Sealed Display', tags: ['Pokemon', 'TCG'], product_type: '',
      variants: [{ id: 43647197413464, price: '1899.95', compare_at_price: '2299.95', available: true }], images: [{ src: 'https://cdn.shopify.com/s/files/1/0643/a.png?v=1' }] },
    { id: 2, handle: 'one-piece-tcg-op-14-booster-box', title: 'One Piece - TCG - OP-14 Booster Box', tags: ['Pre-Order'],
      variants: [{ id: 11, price: '219.95', available: false }, { id: 12, price: '189.95', compare_at_price: null, available: true }], images: [] },
    { id: 3, handle: 'pokemon-tcg-pitch-black-booster-bundle', title: 'Pokémon - TCG - Pitch Black Booster Bundle', tags: [], variants: [{ id: 21, price: '69.95', available: false }], images: [{ src: '//cdn.shopify.com/b.png' }] },
    { id: 4, handle: 'mystery-box', title: 'Mystery Box', variants: [] },
  ] }), { base: 'https://trainertown.com.au/collections/pokemon-cards/products.json?limit=250' });
  assert.equal(r.problem, null);
  assert.equal(r.total, 4);
  assert.deepEqual(r.products.map((p) => [p.sku, p.price, p.wasPrice, p.inStock, p.preorder, p.variantId]), [
    ['pokemon-tcg-ascended-heroes-booster-bundle-sealed-display', 1899.95, 2299.95, true, false, '43647197413464'],
    ['one-piece-tcg-op-14-booster-box', 189.95, null, true, true, '12'],
    ['pokemon-tcg-pitch-black-booster-bundle', 69.95, null, false, false, '21'],
    ['mystery-box', null, null, null, false, null],
  ]);
  const [a, b, c] = r.products;
  assert.equal(a.url, 'https://trainertown.com.au/products/pokemon-tcg-ascended-heroes-booster-bundle-sealed-display');
  assert.deepEqual(a.aliases, ['8630270394456']);
  assert.equal(a.image, 'https://cdn.shopify.com/s/files/1/0643/a.png?v=1');
  assert.equal(b.image, '');
  assert.equal(c.image, 'https://cdn.shopify.com/b.png');
  // A shop under a path of its own (the dummy store): the links stay in it.
  const dummy = parseShopifyProducts(JSON.stringify({ products: [{ id: 5, handle: 'x-etb', title: 'X ETB', variants: [] }] }), { base: 'http://127.0.0.1:9/trainertown/collections/pokemon-cards/products.json?limit=250' });
  assert.equal(dummy.products[0].url, 'http://127.0.0.1:9/trainertown/products/x-etb');
  // Search suggestions read the same way (a keyword with no collection of its own); pre-orders marked in the picture's description.
  const s = parseShopifyProducts(JSON.stringify({ resources: { results: { products: [
    { id: 9, handle: 'pokemon-tcg-ascended-heroes-etb', title: 'Pokémon - TCG - Ascended Heroes Elite Trainer Box', price: '139.95', available: true, url: '/products/pokemon-tcg-ascended-heroes-etb?_pos=1', featured_image: { url: 'https://cdn.shopify.com/c.png', alt: '[Pre-Order] Pokémon - TCG - Ascended Heroes Elite Trainer Box' } },
  ] } } }), { base: 'https://trainertown.com.au/search/suggest.json?q=pokemon' });
  assert.deepEqual(s.products.map((p) => [p.sku, p.price, p.inStock, p.preorder, p.url]), [['pokemon-tcg-ascended-heroes-etb', 139.95, true, true, 'https://trainertown.com.au/products/pokemon-tcg-ascended-heroes-etb']]);
  // Shopify's bot check instead of the list.
  assert.equal(parseShopifyProducts('<!DOCTYPE html><html><head><title>Verifying your connection...</title></head><body><script>window._cf_chl_opt = {}</script></body></html>').problem, 'blocked');
  assert.equal(parseShopifyProducts('{"collections":[]}').problem, 'layout');
});

test("Kmart's search provider (Constructor.io): code, price, sellers, pre-orders, and sold out when every state is out of stock", () => {
  const every = Object.fromEntries(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'].map((st) => [st, '6']));
  const r = parseConstructor(JSON.stringify({ response: { total_num_results: 68, results: [
    { value: 'Pokemon TCG: 30th Celebration Elite Trainer Box', data: { id: 'P_43818587', url: '/product/pokemon-tcg:-30th-celebration-elite-trainer-box-43818587/', image_url: 'https://assets.kmart.com.au/transform/x/43818587-1', price: 100, Seller: ['Kmart'], isPreOrderActive: false, stateOOS: { NT: '6', WA: '6', SA: '6', TAS: '6', ACT: '6', VIC: '6', QLD: '6' } } },
    { value: 'OP10 One Piece Trading Card Game: Royal Blood Booster Pack', data: { id: 'P_43556861', url: '/product/op10-one-piece-trading-card-game:-royal-blood-booster-pack-43556861/', price: 8, Seller: ['Kmart'], stateOOS: every, SavePrice: 'WAS $12' } },
    { value: 'Pokemon TCG: 30th Celebration Booster Bundle', data: { id: 'P_43818617', url: '/product/x-43818617/', price: 54, Seller: ['Kmart'], isPreOrderActive: true } },
    { value: 'Pokemon Chaos Rising Booster - Assorted', data: { id: 'P_43756025', url: '/product/y-43756025/', price: 355.14, Seller: ['Marketplace'] } },
  ] } }), { base: 'https://ac.cnstrc.com/search/pokemon?key=k', storeBase: 'https://www.kmart.com.au' });
  assert.equal(r.problem, null);
  assert.equal(r.total, 68);
  assert.deepEqual(r.products.map((p) => [p.sku, p.price, p.wasPrice, p.inStock, p.preorder, p.marketplace]), [
    ['43818587', 100, null, true, false, false],
    ['43556861', 8, 12, false, false, false],
    ['43818617', 54, null, true, true, false],
    ['43756025', 355.14, null, true, false, true],
  ]);
  assert.equal(r.products[0].url, 'https://www.kmart.com.au/product/pokemon-tcg:-30th-celebration-elite-trainer-box-43818587/', 'a link on Kmart, not the search provider');
  assert.deepEqual(r.products[0].aliases, ['P_43818587']);
  assert.equal(parseConstructor('{"nope":1}').problem, 'layout');
});

test("EB Games' (and Zing's) search JSON: what its search page asks for — code, price, promotions, stock, pre-orders", () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  const r = parseEbGames(JSON.stringify({ totalResults: 3, results: [
    { sku: '312346', title: 'Pokémon TCG: 30th Celebration Elite Trainer Box', productUrl: '/product/toys-and-collectibles/312346-pokemon-tcg-30th-celebration-elite-trainer-box', imageUrl: '//c1-ebgames.eb-cdn.com.au/merchandising/images/packshots/a.jpg', price: 99.95, promotionPrice: 89.95, isOutOfStock: false, isComingSoon: false, releaseDate: '2026-03-01T00:00:00' },
    { sku: '312345', title: 'One Piece Card Game OP-18 Booster Box', productUrl: '/product/toys-and-collectibles/312345-one-piece-op-18', price: 159, isOutOfStock: true, releaseDate: '2025-11-01T00:00:00' },
    { sku: '312400', title: 'Pokémon TCG: Mega Evolution Booster Bundle', productUrl: '/product/toys-and-collectibles/312400-x', price: 54.95, isOutOfStock: false, isComingSoon: false, releaseDate: '2026-11-20T00:00:00' },
    { sku: '312401', title: 'Pokémon TCG: Something Later', productUrl: '/product/toys-and-collectibles/312401-y', price: 10, isComingSoon: true, releaseDate: '2027-01-20T00:00:00' },
  ] }), { base: 'https://www.ebgames.com.au/search/query?q=pokemon', storeBase: 'https://www.ebgames.com.au', now });
  assert.equal(r.problem, null);
  assert.equal(r.total, 3);
  assert.deepEqual(r.products.map((p) => [p.sku, p.price, p.wasPrice, p.inStock, p.preorder]), [
    ['312346', 89.95, 99.95, true, false],
    ['312345', 159, null, false, false],
    ['312400', 54.95, null, true, true],
    ['312401', 10, null, false, false],
  ]);
  assert.equal(r.products[0].url, 'https://www.ebgames.com.au/product/toys-and-collectibles/312346-pokemon-tcg-30th-celebration-elite-trainer-box');
  assert.equal(r.products[0].image, 'https://c1-ebgames.eb-cdn.com.au/merchandising/images/packshots/a.jpg');
  assert.equal(parseEbGames('<html><head><title>Just a moment...</title></head><body>cf_chl_opt</body></html>').problem, 'blocked');
});

test("Amazon's search page: each result's ASIN, full name (brand + title), price, was-price and picture", () => {
  const tile = (asin, { brand = '', title, price = '', was = '', extra = '' }) => `<div data-asin="${asin}" data-component-type="s-search-result" class="s-result-item">
    <img class="s-image" src="https://m.media-amazon.com/images/I/${asin}.jpg">${brand ? `<h2 class="a-size-mini s-line-clamp-1"><span>${brand}</span></h2>` : ''}
    <a class="a-link-normal" href="/x/dp/${asin}/ref=sr_1_1"><h2 aria-label="${title}" class="a-size-base-plus"><span>${title}</span></h2></a>
    ${price ? `<span class="a-price"><span class="a-offscreen">${price}</span><span aria-hidden="true">${price}</span></span>` : ''}
    ${was ? `<span class="a-price a-text-price"><span class="a-offscreen">${was}</span></span>` : ''}${extra}</div>`;
  const html = `<html><head><title>Amazon.com.au : pokemon tcg</title></head><body><div class="s-main-slot">
    ${tile('B0H8SV3WJ8', { brand: 'Pokémon', title: 'TCG: 30th Celebration Elite Trainer Box', price: '$314.95' })}
    ${tile('B0H783FY5Z', { title: 'Pokemon TCG 30th Celebration Booster Bundle', price: '$159.95', was: '$168.00' })}
    ${tile('B0HJJQJHYF', { title: 'One Piece Card Game Official Sleeves Vol. 16', extra: '<span>Currently unavailable.</span>' })}
    ${tile('B0GP9QHQ3Y', { title: 'Pokemon Card Game MEGA Expansion Pack', extra: '<span>No featured offers available</span>' })}
    </div></body></html>`;
  const r = parseAmazon(html, { base: 'https://www.amazon.com.au/s?k=pokemon+tcg&s=date-desc-rank' });
  assert.equal(r.problem, null);
  assert.deepEqual(r.products.map((p) => [p.sku, p.title, p.price, p.wasPrice, p.inStock]), [
    ['B0H8SV3WJ8', 'Pokémon TCG: 30th Celebration Elite Trainer Box', 314.95, null, true],
    ['B0H783FY5Z', 'Pokemon TCG 30th Celebration Booster Bundle', 159.95, 168, true],
    ['B0HJJQJHYF', 'One Piece Card Game Official Sleeves Vol. 16', null, null, false],
    ['B0GP9QHQ3Y', 'Pokemon Card Game MEGA Expansion Pack', null, null, null],
  ]);
  assert.equal(r.products[0].url, 'https://www.amazon.com.au/dp/B0H8SV3WJ8');
  assert.equal(r.products[0].image, 'https://m.media-amazon.com/images/I/B0H8SV3WJ8.jpg');
  assert.equal(parseAmazon('<html><body>To discuss automated access to Amazon data please contact api-services-support@amazon.com.</body></html>').problem, 'blocked');
  assert.equal(parseAmazon('<html><body><div class="s-main-slot"></div></body></html>').problem, 'empty');
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
  // Server first, every store: Mugibot's server searches it, and an admin's browser stands in only
  // while the store refuses the server (Amazon, BIG W, Pokémon Center and Premium Bandai often do).
  for (const id of ['target', 'jbhifi', 'trainertown', 'kmart', 'amazon', 'bigw', 'ebgames', 'pokemoncenter', 'pbandai']) assert.equal(mode(id), 'auto', id);
  assert.equal(mode('zing'), 'off', "Zing: EB Games' search, already searched there");
  assert.equal(mode('demo-kmart'), 'off');
  assert.equal((await boss.put('/api/monitor/sweep', { keywords: '' })).status, 400, 'at least one keyword');
  assert.equal((await boss.put('/api/monitor/sweep', { everySeconds: 1 })).body.settings.everySeconds, 3, 'never faster than every 3 seconds');
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-kmart': 'sideways' } })).status, 400);
  // The real stores off (tests never touch them); the dummy ones swept from the server.
  r = await boss.put('/api/monitor/sweep', {
    everySeconds: 5, keywords: 'Pokemon, one piece',
    stores: { target: 'off', jbhifi: 'off', toysrus: 'off', trainertown: 'off', amazon: 'off', kmart: 'off', bigw: 'off', ebgames: 'off', zing: 'off', thegamescube: 'off', gamerholic: 'off', pokemoncenter: 'off', pbandai: 'off', 'demo-kmart': 'server', 'demo-jbhifi': 'server', 'demo-bigw': 'server', 'demo-ebgames': 'browser', 'demo-trainertown': 'server' },
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
  // "Once a day" is Sydney's calendar day: keep this test's 20 minutes clear of midnight there
  // (well inside the 6 hours after which a search sets the scene again).
  const sydney = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const [h, m] = sydney.format(Date.now() + clock.offset).split(':').map(Number);
  if (h * 60 + m >= 22 * 60) clock.offset += 3 * 3600 * 1000;
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
  const out = t.events.filter((e) => e.type === 'out').at(-1);
  assert.equal(out.product.sku, '70100001', 'the live event log says it dropped out');
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

test("🃏 Trainer Town: each game's whole collection read in one go — new drops with an add-to-cart link, restocks; other keywords searched", async () => {
  const tt = R('demo-trainertown');
  assert.equal(sw.modeFor(R('trainertown')), 'off', '(tests never touch the real store)');
  const shop = store.shop('trainertown');
  // The first read: the store's collections, then the game's whole collection (it sets the scene).
  let r = await sweep('demo-trainertown');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.baseline, true);
  assert.equal(r.found, 1);
  assert.equal(r.kept, 1);
  const row = (k) => env.app.db.get('SELECT * FROM sweep_terms WHERE store = :s AND keyword = :k AND page = 1', { s: 'demo-trainertown', k });
  assert.match(row('pokemon').url, /\/trainertown\/collections\/pokemon-cards\/products\.json\?limit=250$/);
  assert.ok(sw.events.some((e) => e.type === 'sys' && /Trainer Town \(dummy store\): reading each game's whole collection — "pokemon" → pokemon-cards, "one piece" → one-piece-trading-card-game/.test(e.message)));
  const etb = product('demo-trainertown', 'pokemon-tcg-ascended-heroes-elite-trainer-box');
  assert.equal(etb.status, 'in_stock');
  assert.equal(etb.price, 129.95);
  assert.match(etb.url, /\/trainertown\/products\/pokemon-tcg-ascended-heroes-elite-trainer-box$/);
  assert.equal(etb.variant_id, String(shop.products[0].id), 'the option to buy, for the add-to-cart link');
  assert.equal((await sweep('demo-trainertown', 'one piece')).baseline, true);
  assert.equal(product('demo-trainertown', 'one-piece-tcg-op-14-booster-box').status, 'out_of_stock');
  assert.match(sw.live().stores.find((x) => x.id === 'demo-trainertown').endpoint, /^\/collections\/…\/products\.json$/);

  // 🆕 A product the store adds (a pre-order): alerted at once, with Shopify's add-to-cart link.
  shop.products.push({ sku: 'pokemon-tcg-mega-evolution-booster-box', name: 'Pokémon - TCG - Mega Evolution Booster Box', price: 269.95, status: 'preorder', listed: true, maxQty: 0, qtyStyle: 'input', lateMs: 0, id: 4499997 });
  const before = channel().length;
  r = await sweep('demo-trainertown');
  assert.equal(r.baseline, false);
  assert.equal(r.new, 1);
  const [a] = alerts('listed');
  assert.equal(a.sku, 'pokemon-tcg-mega-evolution-booster-box');
  assert.equal(a.status, 'preorder');
  assert.equal(a.price, 269.95);
  const [post] = channel().slice(before);
  const buttons = post.body.components[0].components;
  assert.ok(buttons.some((b) => b.label === '⚡ Buy with Mugibot' && /\/buy\?store=demo-trainertown&sku=pokemon-tcg-mega-evolution-booster-box/.test(b.url)));
  const cart = buttons.find((b) => b.label === 'Add to cart');
  assert.equal(cart.url, `${store.url}/trainertown/cart/4499997:1`);
  // 🟢 Sold out → in stock at the next read of that collection.
  store.set('trainertown', 'one-piece-tcg-op-14-booster-box', { status: 'in_stock' });
  assert.equal((await sweep('demo-trainertown', 'one piece')).restock, 1);
  assert.equal(alerts('restock')[0].sku, 'one-piece-tcg-op-14-booster-box');

  // A keyword with no collection of its own: Shopify's search, as at JB Hi-Fi.
  assert.match(sw.urlFor(tt, 'lorcana'), /\/trainertown\/search\/suggest\.json\?q=lorcana&/);
  // Read somewhere else (the collection gone, so the search instead): what's there already was — no flood of "new".
  const known = sw.collections.get('demo-trainertown');
  sw.collections.set('demo-trainertown', { list: [], nextAt: Infinity });
  shop.products.push({ sku: 'pokemon-tcg-surging-sparks-etb', name: 'Pokémon - TCG - Surging Sparks Elite Trainer Box', price: 89.95, status: 'in_stock', listed: true, maxQty: 0, qtyStyle: 'input', lateMs: 0, id: 4499996 });
  r = await sweep('demo-trainertown');
  assert.equal(r.baseline, true);
  assert.equal(r.new, 0);
  assert.match(row('pokemon').url, /\/search\/suggest\.json/);
  sw.collections.set('demo-trainertown', known);
  assert.equal((await sweep('demo-trainertown')).baseline, true, 'back to the collection: the scene is set again');
  assert.equal((await sweep('demo-trainertown')).baseline, false);
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
  assert.equal(t.parser, 'ebgames');
  assert.equal(t.inPage, true, "EB Games' search JSON, asked for from inside one of its pages");
  assert.match(t.url, /\/ebgames\/search\/query\?q=pokemon&sort=releasedate&order=desc$/);
  assert.match(t.pageUrl, /\/ebgames\/search\?q=pokemon$/);
  assert.equal(t.productPath.re, R('demo-ebgames').productPath.source);
  assert.ok(due.body.waitMs >= 1000);
  assert.equal((await admin.call('GET', '/api/ext/sweeps')).body.terms.length, 0, 'leased: the next one comes after the wait');

  // The browser reads EB Games' search JSON with the same code the server uses (lib/listing.js) and sends what it found.
  const json = await (await fetch(t.url, { headers: { 'user-agent': 'Mozilla/5.0 Chrome' } })).text();
  const found = parseEbGames(json, { base: t.url, storeBase: t.storeBase });
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

test('the live monitor: every search, fault and setting change as an event for members, the counters, and how fast alerts go out', async () => {
  const before = sw.totals.searches;
  const errorsBefore = sw.totals.errors;
  await sweep('demo-jbhifi');
  store.state.blockNonBrowsers = true;
  await sweep('demo-kmart');
  store.state.blockNonBrowsers = false;
  assert.equal(sw.totals.searches, before + 2);
  assert.equal(sw.totals.errors, errorsBefore + 1);
  assert.equal(sw.totals.streak, 0);
  await sweep('demo-kmart');
  assert.equal(sw.totals.streak, 1);
  const recent = sw.events.slice(-6);
  const hb = recent.find((e) => e.type === 'hb' && e.store === 'demo-jbhifi');
  assert.equal(hb.storeName, 'JB Hi-Fi (dummy store)');
  assert.equal(hb.keyword, 'pokemon');
  assert.equal(typeof hb.ms, 'number');
  assert.ok(hb.found >= 1);
  const err = recent.find((e) => e.type === 'err' && e.store === 'demo-kmart');
  assert.match(err.error, /refused the search \(HTTP 403\)/);
  assert.ok(recent.some((e) => e.type === 'sys' && /Kmart \(dummy store\) refused a search — searching it at a third of the pace/.test(e.message)));
  // A new drop: the alert says how long it took from the store's answer to the dashboards.
  store.shop('jbhifi').products.push({ sku: 'pokemon-tcg-live-test-etb', name: 'Pokémon TCG Live Test Elite Trainer Box', price: 99, status: 'in_stock', listed: true, maxQty: 0, qtyStyle: 'input', lateMs: 0, id: 4499998 });
  await sweep('demo-jbhifi');
  const [a] = alerts('listed');
  assert.equal(a.sku, 'pokemon-tcg-live-test-etb');
  assert.equal(typeof sw.ttns.at(-1), 'number');
  // What a member's dashboard gets when it opens: stores, counters, the latest events and alerts.
  const live = (await ash.get('/api/monitor/live')).body;
  assert.equal(live.admin, false);
  const jb = live.stores.find((x) => x.id === 'demo-jbhifi');
  assert.equal(jb.status, 'ok');
  assert.ok(jb.searches >= 1);
  assert.equal(typeof jb.lastMs, 'number');
  assert.ok(jb.latency.length >= 1);
  // Where a store is searched from (Mugibot's server or an admin's browser): admins only.
  assert.deepEqual([jb.from, jb.mode, jb.endpoint], [undefined, undefined, undefined]);
  assert.equal(live.stores.find((x) => x.id === 'demo-ebgames').mode, undefined);
  assert.ok(!live.stores.some((x) => x.id === 'target'), 'stores that are off are left out');
  const asAdmin = (await boss.get('/api/monitor/live')).body.stores;
  assert.equal(asAdmin.find((x) => x.id === 'demo-jbhifi').from, "Mugibot's server");
  assert.match(asAdmin.find((x) => x.id === 'demo-jbhifi').endpoint, /\/search\/suggest\.json\?q=$/);
  assert.equal(asAdmin.find((x) => x.id === 'demo-ebgames').mode, 'browser');
  assert.equal(typeof live.meanAlertMs, 'number');
  assert.ok(live.events.some((e) => e.type === 'hb'));
  assert.ok(live.alerts.some((x) => x.sku === 'pokemon-tcg-live-test-etb'));
  assert.deepEqual(live.settings.keywords, ['pokemon', 'one piece']);
  assert.equal(live.settings.tcgTerms, undefined, 'members see the keywords and pace, not the admin-only settings');
  assert.equal((await boss.get('/api/monitor/live')).body.settings.tcgTerms.length > 0, true);
  // Settings changes are events too.
  assert.equal((await boss.put('/api/monitor/sweep', { everySeconds: 6 })).status, 200);
  assert.match(sw.events.at(-1).message, /boss changed the sweeps — a search every 6 s at each store/);
  await boss.put('/api/monitor/sweep', { everySeconds: 5 });
  sw.sweepNow(); // (Kmart was slowed after the refusal above)
});

test('not trading cards: "3 Pack Socks" and "Short Sleeve T-Shirt" are left out (unless the name says TCG); a filter change takes them off the list', async () => {
  const counts = sw.filters();
  assert.equal(counts({ title: 'Licensed Pokemon 3 Pack Quarter Crew Socks' }, 'pokemon'), false);
  assert.equal(counts({ title: 'Pokemon Short Sleeve T-Shirt' }, 'pokemon'), false);
  assert.equal(counts({ title: 'Pokémon TCG: Pikachu Plush Collection' }, 'pokemon'), true, 'says TCG: counts');
  assert.equal(counts({ title: 'Pokemon Booster Pack' }, 'pokemon'), true);
  assert.equal(counts({ title: 'One Piece Card Game Double Pack Set' }, 'one piece'), true);
  // Something tracked before the filter existed drops off the list when the filters change.
  const shirt = env.app.catalog.upsertProduct({ store: 'demo-kmart', sku: '43800001', name: 'Pokemon 2 Pack Trunks', url: '' });
  env.app.catalog.updateProduct(shirt.id, { sweep_seen_at: Date.now() + clock.offset, sweep_first_at: Date.now() + clock.offset, sweep_keyword: 'pokemon' });
  assert.ok((await ash.get('/api/monitor/products?store=demo-kmart')).body.products.some((p) => p.sku === '43800001'));
  assert.equal((await boss.put('/api/monitor/sweep', { notCardTerms: [...sw.settings.notCardTerms, 'onesie'] })).status, 200);
  assert.ok(!(await ash.get('/api/monitor/products?store=demo-kmart')).body.products.some((p) => p.sku === '43800001'));
  assert.equal((await boss.put('/api/monitor/sweep', { notCardTerms: sw.settings.notCardTerms.filter((x) => x !== 'onesie') })).status, 200);
});

test("EB Games' search JSON read end to end (from the server here, so the dummy store answers): products tracked, stock and links right", async () => {
  const eb = R('demo-ebgames');
  const r = await sw.sweepTerm(eb, { keyword: 'pokemon', page: 1 });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.found >= 1);
  const etb = product('demo-ebgames', '312346');
  assert.equal(etb.status, 'in_stock');
  assert.match(etb.url, /\/ebgames\/product\/toys-and-collectibles\/312346-/);
  assert.match(etb.image, /\/img\/ebgames\/312346\.svg$/);
  assert.equal(store.state.requests.at(-1).path, '/ebgames/search/query');
});

test("where each store is searched: server first everywhere (saved modes from before give way, 'off' stays), Amazon at most every 20 s, BIG W opened in the browser", async () => {
  const saved = env.app.repo.getSetting('sweep');
  try {
    // Settings saved before only changed modes were kept: every store's mode, old defaults among them.
    env.app.repo.setSetting('sweep', { ...saved, modesVersion: undefined, stores: { ...saved.stores, kmart: 'browser', amazon: 'server' } });
    assert.equal(sw.modeFor(R('kmart')), 'auto', 'an old default, saved with the rest, gives way to server first');
    assert.equal(sw.modeFor(R('amazon')), 'auto');
    assert.equal(sw.modeFor(R('target')), 'off', 'a store switched off stays off');
    assert.equal(sw.modeFor(R('demo-kmart')), saved.stores['demo-kmart'], "the dummy stores keep theirs (they're off unless switched on)");
    // Saved before server first (version 2): a store set to the server or a browser is searched server first now.
    env.app.repo.setSetting('sweep', { ...saved, modesVersion: 2, stores: { ...saved.stores, bigw: 'browser', pbandai: 'server' } });
    assert.deepEqual([sw.modeFor(R('bigw')), sw.modeFor(R('pbandai'))], ['auto', 'auto']);
    // A store's own default isn't saved, so a better default later reaches everyone.
    const r = await boss.put('/api/monitor/sweep', { stores: { ...saved.stores, kmart: 'auto', bigw: 'auto' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.settings.stores.kmart, undefined);
    assert.equal(r.body.settings.stores.bigw, undefined);
    assert.equal(r.body.settings.modesVersion, 3);
    // An admin who wants Kmart from a browser after all (or the server only): that sticks.
    assert.equal((await boss.put('/api/monitor/sweep', { stores: { ...saved.stores, kmart: 'browser', bigw: 'server' } })).body.settings.stores.kmart, 'browser');
    assert.deepEqual([sw.modeFor(R('kmart')), sw.modeFor(R('bigw'))], ['browser', 'server']);
  } finally {
    env.app.repo.setSetting('sweep', saved);
  }
  assert.match(sw.urlFor(R('kmart'), 'one piece'), /^https:\/\/ac\.cnstrc\.com\/search\/one%20piece\?key=key_\w+&.*filters%5Bgroup_id%5D=\w+&filters%5BSeller%5D=Kmart&filters%5BSeller%5D=Target$/);
  assert.equal(sw.urlFor(R('demo-kmart'), 'pokemon').startsWith(`${store.url}/kmart/cnstrc/search/pokemon?`), true, "the dummy Kmart's own search provider");
  assert.equal(sw.endpoint(R('kmart')), 'ac.cnstrc.com/search/');
  assert.equal(sw.urlFor(R('amazon'), 'pokemon', 2), 'https://www.amazon.com.au/s?k=pokemon%20tcg&s=date-desc-rank&page=2');
  assert.equal(sw.paceFor(R('amazon')), 20000);
  assert.equal(sw.paceFor(R('target')), 5000);
  // BIG W builds its product list once the page is open: the browser is told to open it and wait.
  await boss.put('/api/monitor/sweep', { stores: { ...saved.stores, 'demo-bigw': 'browser', 'demo-ebgames': 'browser' } });
  try {
    const due = sw.browserDue(env.app.repo.userByUsername('boss'));
    const t = due.terms.find((x) => x.store === 'demo-bigw');
    assert.equal(t.render, true);
    // EB Games: its search JSON, asked for from inside one of its pages.
    const eb = due.terms.find((x) => x.store === 'demo-ebgames');
    assert.equal(eb.inPage, true);
    assert.equal(eb.parser, 'ebgames');
    const q = encodeURIComponent(eb.keyword);
    assert.equal(eb.url.startsWith(`${store.url}/ebgames/search/query?q=${q}&sort=releasedate&order=desc`), true, eb.url);
    assert.equal(eb.pageUrl, `${store.url}/ebgames/search?q=${q}`);
    assert.equal(t.storeBase, `${store.url}/bigw`);
    assert.equal(sw.paceFor(R('demo-bigw'), true), 20000);
    assert.equal(eb.expect, 'json');
  } finally {
    await boss.put('/api/monitor/sweep', { stores: saved.stores });
  }
  // Amazon: its search page (HTML, not JSON) asked for from inside an Amazon page — from extension 1.11.0.
  await boss.put('/api/monitor/sweep', { stores: { ...saved.stores, 'demo-amazon': 'browser' } });
  try {
    assert.equal(sw.browserDue(env.app.repo.userByUsername('boss'), { version: '1.10.0' }).terms.some((x) => x.store === 'demo-amazon'), false, 'not for an older extension');
    sw.stat('demo-amazon').browserNext = 0;
    const amz = sw.browserDue(env.app.repo.userByUsername('boss'), { version: '1.11.0' }).terms.find((x) => x.store === 'demo-amazon');
    assert.equal(amz.inPage, true);
    assert.equal(amz.expect, 'html');
    assert.equal(amz.parser, 'amazon');
    assert.equal(amz.pageUrl, `${store.url}/amazon`, "Amazon's front page");
    assert.equal(amz.url, `${store.url}/amazon/s?k=${encodeURIComponent(amz.keyword)}%20tcg&s=date-desc-rank`);
  } finally {
    await boss.put('/api/monitor/sweep', { stores: saved.stores });
  }
  // The four added in 1.8.0: The Games Cube and Gamerholic from the server; Pokémon Center and
  // Premium Bandai (both turn servers away) opened in an admin's browser.
  assert.equal(R('thegamescube').sweep.from, 'server');
  assert.equal(sw.urlFor(R('thegamescube'), 'one piece', 2), 'https://www.thegamescube.com/products/search?q=one%20piece&page=2');
  assert.equal(R('gamerholic').sweep.from, 'server');
  assert.equal(sw.urlFor(R('gamerholic'), 'pokemon'), 'https://gamerholic.com.au/products.json?limit=100', 'its newest products, for every keyword');
  assert.equal(sw.paceFor(R('gamerholic')), 15000);
  assert.equal(R('pokemoncenter').sweep.from, 'browser');
  assert.equal(sw.urlFor(R('pokemoncenter'), 'one piece'), 'https://www.pokemoncenter.com/en-au/search/one%20piece');
  assert.equal(R('pokemoncenter').sweep.render, true);
  assert.equal(R('pbandai').sweep.from, 'browser');
  // Premium Bandai: the site's own search JSON (not under /au), asked for from inside its page.
  assert.equal(sw.urlFor(R('pbandai'), 'one piece'), 'https://p-bandai.com/api/search?keyword=one%20piece&limit=100&offset=0&sortType=NewArrival');
  assert.equal(R('pbandai').sweep.inPage, true);
  assert.equal(sw.endpoint(R('pbandai')), '/api/search?keyword=');
  assert.equal(sw.paceFor(R('pbandai'), true), 30000);
});

test("an admin's browser with an extension too old for a store isn't given its searches, and the live monitor says to update it", async () => {
  const admin = { role: 'admin', username: 'boss' };
  const saved = { ...sw.settings.stores };
  sw.save({ stores: { ...saved, 'demo-pbandai': 'browser', 'demo-pokemoncenter': 'browser' } }, null);
  try {
    const said = () => sw.events.filter((e) => e.type === 'sys' && /Premium Bandai \(dummy store\): Needs Mugibot's extension 1\.8\.1 or newer/.test(e.message)).length;
    let due = sw.browserDue(admin, { version: '1.8.0', who: 'boss' });
    assert.deepEqual(due.terms.map((t) => t.store), [], 'neither store, with 1.8.0');
    const card = sw.live().stores.find((s) => s.id === 'demo-pbandai');
    assert.equal(card.status, 'waiting');
    assert.match(card.lastError, /^Needs Mugibot's extension 1\.8\.1 or newer in an admin's browser \(boss's has 1\.8\.0\) — update it/);
    assert.equal(card.fails, 0);
    sw.browserDue(admin, { version: '1.8.0', who: 'boss' });
    assert.equal(said(), 1, 'said once, not every time that browser asks');
    // An extension that doesn't say which version it is (before 1.8.1) counts as too old.
    assert.deepEqual(sw.browserDue(admin, {}).terms, []);

    // An up-to-date one gets both: Premium Bandai's search JSON with the region its own code sends,
    // asked from its front page; Pokémon Center's search page, opened and read.
    due = sw.browserDue(admin, { version: '1.8.1' });
    const pb = due.terms.find((t) => t.store === 'demo-pbandai');
    assert.ok(pb, JSON.stringify(due));
    assert.equal(pb.inPage, true);
    assert.equal(pb.render, false);
    assert.equal(pb.parser, 'pbandai');
    assert.deepEqual(pb.headers, { 'x-g1-area-code': 'au' });
    assert.equal(pb.url, `${store.url}/pbandai/api/search?keyword=${encodeURIComponent(pb.keyword)}&limit=100&offset=0&sortType=NewArrival`);
    assert.equal(pb.pageUrl, `${store.url}/pbandai`);
    const pc = due.terms.find((t) => t.store === 'demo-pokemoncenter');
    assert.equal(pc.render, true);
    assert.equal(pc.headers, null);
    // While it's searching, a second admin's browser with an old extension doesn't take it over or change its card.
    await sw.browserResults(admin, [{ store: 'demo-pbandai', keyword: pb.keyword, page: 1, ok: true, status: 200, ms: 300, products: [] }]);
    const n = said();
    assert.deepEqual(sw.browserDue(admin, { version: '1.7.2', who: 'misty' }).terms, []);
    assert.equal(said(), n);
    assert.notEqual(sw.live().stores.find((s) => s.id === 'demo-pbandai').status, 'waiting');
  } finally {
    sw.save({ stores: saved }, null);
  }
  assert.equal(olderVersion('1.8.0', '1.8.1'), true);
  assert.equal(olderVersion('1.10.0', '1.8.1'), false);
  assert.equal(olderVersion('1.8.1', '1.8.1'), false);
  assert.equal(olderVersion('', '1.8.1'), true);
});

test('🚫 the blacklist: a product, a SKU or a whole store never pings, isn\'t tracked and stays off the lists; its monitor goes', async () => {
  const bl = () => boss.get('/api/admin/blacklist');
  // The upgrade puts the Kmart bookcase that kept pinging on it.
  let r = await bl();
  assert.equal(r.status, 200);
  const first = r.body.entries.find((e) => e.store === 'kmart' && e.sku === '43746880');
  assert.equal(first.name, 'Wave Book Storage - Oak - One Size');
  assert.notEqual((await ash.get('/api/admin/blacklist')).status, 200, 'admins only');
  assert.equal((await boss.post('/api/admin/blacklist', {})).status, 400, 'a store, a SKU, or both');
  const listed = async (storeId) => (await ash.get(`/api/monitor/products?store=${storeId}`)).body.products.map((p) => p.sku);
  const added = [];
  const add = async (body) => {
    const res = await boss.post('/api/admin/blacklist', body);
    assert.equal(res.status, 200, res.text);
    added.push(res.body.entry.id);
    return res.body;
  };
  try {
    // A product link: its store and SKU, and its name from the catalogue.
    assert.ok((await listed('demo-kmart')).includes('43818587'));
    const etb = await add({ sku: store.productUrl('kmart', '43818587'), note: 'testing' });
    assert.equal(etb.entry.store, 'demo-kmart');
    assert.equal(etb.entry.sku, '43818587');
    assert.match(etb.entry.name, /Elite Trainer Box/);
    assert.ok(!(await listed('demo-kmart')).includes('43818587'), 'off the products list');
    assert.equal((await boss.post('/api/admin/blacklist', { store: 'demo-kmart', sku: '43818587' })).body.created, false, 'once');

    // A monitor on a product that goes on the blacklist is removed, and can't be added again.
    const m = await boss.post('/api/monitor/monitors', { store: 'demo-kmart', sku: '43818556' });
    assert.equal(m.status, 200, m.text);
    assert.equal((await add({ store: 'demo-kmart', sku: '43818556' })).monitorsRemoved, 1);
    assert.ok(!env.app.catalog.monitorById(m.body.monitor.id));
    const again = await boss.post('/api/monitor/monitors', { store: 'demo-kmart', sku: '43818556' });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /blacklist/);

    // A new drop that's on the blacklist: not tracked, no alert.
    await add({ store: 'demo-kmart', sku: '43899990' });
    store.shop('kmart').products.push({ sku: '43899990', name: 'Pokémon TCG: Blacklisted Booster Box', price: 199, status: 'in_stock', listed: true, maxQty: 0, qtyStyle: 'input', lateMs: 0, id: 4499990 });
    const swept = await sweep('demo-kmart');
    assert.equal(swept.new, 0);
    assert.ok(!product('demo-kmart', '43899990'));
    const p = env.app.catalog.upsertProduct({ store: 'demo-kmart', sku: '43899990', url: '', name: 'Pokémon TCG: Blacklisted Booster Box' });
    assert.equal(await env.app.feed.alert(p, 'listed', { sweep: true }), null, 'no alert, anywhere');

    // A SKU at every store.
    await add({ sku: 'pokemon-tcg-30th-celebration-etb' });
    assert.ok(!(await listed('demo-jbhifi')).includes('pokemon-tcg-30th-celebration-etb'));
    // A whole store.
    const jb = await add({ store: 'demo-jbhifi' });
    assert.equal(jb.entry.sku, '');
    assert.equal((await sweep('demo-jbhifi')).kept, 0);
    assert.deepEqual(await listed('demo-jbhifi'), []);
    r = await bl();
    assert.equal(r.body.entries.find((e) => e.id === jb.entry.id).storeName, 'JB Hi-Fi (dummy store)');
    assert.equal(r.body.entries.find((e) => e.sku === 'pokemon-tcg-30th-celebration-etb').storeName, 'Every store');
  } finally {
    for (const id of added) assert.equal((await boss.del(`/api/admin/blacklist/${id}`)).status, 200);
  }
  // Off the blacklist: back on the lists.
  assert.ok((await listed('demo-kmart')).includes('43818587'));
  assert.ok((await listed('demo-jbhifi')).length > 0);
  const audit = env.app.repo.listAudit(80).map((a) => a.action);
  assert.ok(audit.includes('blacklist-add') && audit.includes('blacklist-remove'));
});

test("🛒 JB Hi-Fi Marketplace: a seller's product never alerts and leaves the list; JB's own still do — each asked once, never as part of a search", async () => {
  const jb = store.shop('jbhifi');
  const add = (sku, name, seller) => jb.products.push({ sku, name, price: 144.24, status: 'in_stock', listed: true, maxQty: 0, qtyStyle: 'input', lateMs: 0, id: 4500000 + jb.products.length, seller });
  const fest = 'one-piece-card-game-premium-card-collection-fest-23-24';
  const op15 = 'one-piece-card-game-op-15-booster-box';
  await sweep('demo-jbhifi', 'one piece');
  add(fest, 'One Piece Card Game: Premium Card Collection - Bandai Card Games Fest. 23-24 Edition', 'Gameology');
  add(op15, 'One Piece Card Game OP-15 Booster Box', null);
  const asked = () => store.state.requests.filter((x) => /^\/jbhifi\/products\/[^/]+\.js$/.test(x.path)).length;
  const n = asked();
  const r = await sweep('demo-jbhifi', 'one piece');
  assert.equal(r.ok, true, r.error);
  assert.ok(alerts('listed').some((a) => a.sku === op15), "JB's own new drop alerts");
  assert.ok(!alerts('listed').some((a) => a.sku === fest), "the marketplace seller's doesn't");
  assert.equal(product('demo-jbhifi', fest).seller, 'Gameology');
  assert.equal(product('demo-jbhifi', op15).seller, '', 'sold by JB Hi-Fi itself');
  assert.equal(asked() - n, 2, 'asked once each, just before their first alert');
  const listed = async () => (await ash.get('/api/monitor/products?store=demo-jbhifi')).body.products.map((p) => p.sku);
  assert.ok(!(await listed()).includes(fest), 'off the list');
  assert.ok((await listed()).includes(op15));
  // Known now: the next searches leave it out without asking again.
  jb.products.find((p) => p.sku === fest).price = 99;
  await sweep('demo-jbhifi', 'one piece');
  assert.equal(asked() - n, 2);
  assert.ok(!alerts('price_drop').some((a) => a.sku === fest));
  assert.ok(!(await listed()).includes(fest));
  // Products listed before this: asked one at a time between searches (at most every 20 s).
  const unknown = () => env.app.db.get("SELECT COUNT(*) AS n FROM products WHERE store = 'demo-jbhifi' AND seller IS NULL AND sweep_seen_at IS NOT NULL").n;
  const left = unknown();
  assert.ok(left >= 1);
  sw.stat('demo-jbhifi').sellerAt = 0;
  await sw.checkSellers(R('demo-jbhifi'));
  assert.equal(unknown(), left - 1);
  await sw.checkSellers(R('demo-jbhifi'));
  assert.equal(unknown(), left - 1, 'one at a time');
  // Stores whose search says who sells (Kmart) are never asked.
  assert.equal(R('demo-kmart').sweep.sellers, undefined);
  assert.equal(R('toysrus').sweep.sellers, null, 'Toys"R"Us has no marketplace');
});

test('↻ Reset: a store asking to wait (429, Retry-After) is waited for; Reset (one store, or all) starts it again gently; a browser store gets a fresh tab', async () => {
  store.state.tooMany = { kmart: 60 };
  try {
    const r = await sweep('demo-kmart');
    assert.equal(r.ok, false);
    assert.match(r.error, /refused the search \(HTTP 429\) — it asked to wait 60 s/);
    const st = sw.stat('demo-kmart');
    assert.ok(st.retryAt - sw.now() > 55000);
    assert.ok(sw.waitFor(st, 5000) >= 55000, "no search before the store said");
    await sweep('demo-kmart');
    assert.equal(sw.stat('demo-kmart').fails >= 2, true);
  } finally {
    store.state.tooMany = {};
  }
  assert.equal((await ash.post('/api/monitor/sweep/reset', { store: 'demo-kmart' })).status, 404, 'admins only');
  assert.equal((await boss.post('/api/monitor/sweep/reset', { store: 'nope' })).status, 400);
  const res = await boss.post('/api/monitor/sweep/reset', { store: 'demo-kmart' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.reset, ['demo-kmart']);
  const st = sw.stat('demo-kmart');
  assert.equal(st.fails, 0);
  assert.equal(st.lastError, '');
  assert.ok(st.slowUntil > sw.now(), 'gently, for a while');
  assert.ok(sw.events.some((e) => e.type === 'sys' && /boss reset Kmart \(dummy store\): searching it again now/.test(e.message)));
  assert.ok(env.app.repo.listAudit(20).some((a) => a.action === 'sweep-reset'));
  const card = sw.live().stores.find((s) => s.id === 'demo-kmart');
  assert.ok(card.resetAt);
  assert.equal((await sweep('demo-kmart')).ok, true, 'answering again');
  // Reset all: every store being swept, none of the switched-off ones.
  const all = await boss.post('/api/monitor/sweep/reset', {});
  assert.ok(all.body.reset.includes('demo-kmart') && all.body.reset.includes('demo-jbhifi'));
  assert.ok(!all.body.reset.includes('kmart'), 'not the ones that are off');
  // A store searched from an admin's browser: its tab is closed and opened again at its front page (once).
  const saved = { ...sw.settings.stores };
  sw.save({ stores: { ...saved, 'demo-ebgames': 'browser' } }, null);
  try {
    const admin = { role: 'admin', username: 'boss' };
    sw.reset('demo-ebgames');
    let t = sw.browserDue(admin, { version: '9.9.9' }).terms.find((x) => x.store === 'demo-ebgames');
    assert.equal(t.fresh, true);
    assert.equal(t.frontUrl, `${store.url}/ebgames`);
    sw.stat('demo-ebgames').browserNext = 0;
    t = sw.browserDue(admin, { version: '9.9.9' }).terms.find((x) => x.store === 'demo-ebgames');
    assert.equal(t.fresh, false);
  } finally {
    sw.save({ stores: saved }, null);
    // (The gentle 10 minutes after the resets, and the dummy Kmart's "wait 60 s": over, for the tests that follow.)
    for (const s of sw.state.values()) Object.assign(s, { slowUntil: 0, retryAt: 0 });
  }
});

test('Retry-After: seconds or a date, at most 15 minutes', () => {
  const now = Date.parse('2026-10-16T10:00:00Z');
  assert.equal(retryAfterMs('30', now), 30000);
  assert.equal(retryAfterMs(new Date(now + 90000).toUTCString(), now), 90000);
  assert.equal(retryAfterMs('99999', now), 15 * 60 * 1000);
  assert.equal(retryAfterMs('', now), 0);
  assert.equal(retryAfterMs('soon', now), 0);
});

test("EB Games' results: a marketplace seller's product only when the result says so (never guessed from the name)", () => {
  const r = parseEbGames(JSON.stringify({ results: [
    { sku: '1', title: 'Dragon Ball Super Card Game Booster Box', price: 150 },
    { sku: '2', title: 'Riftbound Booster Display', price: 160, sellerName: 'EB Games' },
    { sku: '3', title: 'Gundam Card Game Booster Box', price: 170, sellerName: 'Cardz Galore' },
    { sku: '4', title: 'Pokémon TCG Elite Trainer Box', price: 80, isMarketplace: true },
  ] }), { base: 'https://www.ebgames.com.au/search/query', storeBase: 'https://www.ebgames.com.au' });
  assert.deepEqual(r.products.map((p) => [p.sku, p.marketplace]), [['1', false], ['2', false], ['3', true], ['4', true]]);
});

test('the loops: each store swept from the server on its own loop, every few seconds; switched off, it stops', async () => {
  const before = store.state.requests.filter((x) => x.path.startsWith('/kmart/cnstrc/search')).length;
  sw.running = false;
  sw.cfg.monitor.enabled = true;
  sw.start();
  try {
    await waitFor(() => store.state.requests.filter((x) => x.path.startsWith('/kmart/cnstrc/search')).length >= before + 2, { timeout: 15000, message: 'two Kmart searches' });
    assert.ok(sw.loops.has('demo-kmart'));
    assert.ok(sw.events.some((e) => e.type === 'sys' && /Live sweeps started — .*Kmart \(dummy store\).* from Mugibot's server only · .*EB Games \(dummy store\) from admins' browsers/.test(e.message)));
    assert.ok(sw.loops.has('demo-jbhifi'));
    assert.ok(!sw.loops.has('demo-ebgames'), 'browser stores have no server loop');
    const h = (await boss.get('/api/monitor/sweep')).body.stores.find((s) => s.store === 'demo-kmart');
    assert.equal(h.running, true);
    assert.ok(h.requests1h >= 2);
    assert.ok((await boss.get('/api/monitor')).body.overview.sweeps1h >= 2);
    // A store that asked to wait (Retry-After) isn't searched before then, even woken by Sweep now or a Reset…
    const kmartSearches = () => store.state.requests.filter((x) => x.path.startsWith('/kmart/cnstrc/search')).length;
    sw.stat('demo-kmart').retryAt = sw.now() + 60000;
    const asked = kmartSearches();
    sw.sweepNow();
    sw.reset('demo-kmart');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(kmartSearches(), asked, 'no search before the store said');
    // …and Reset wakes only the store it resets: another store's backoff stands.
    const jbSearches = () => store.state.requests.filter((x) => x.path.startsWith('/jbhifi/search/suggest')).length;
    sw.stat('demo-jbhifi').retryAt = sw.now() + 60000;
    sw.stat('demo-kmart').retryAt = 0;
    const jbBefore = jbSearches();
    sw.reset('demo-kmart');
    await waitFor(() => kmartSearches() > asked, { timeout: 5000, message: 'Kmart searched straight after its reset' });
    assert.equal(jbSearches(), jbBefore, 'JB Hi-Fi left alone');
    sw.stat('demo-jbhifi').retryAt = 0;
    await boss.put('/api/monitor/sweep', { stores: { ...sw.settings.stores, 'demo-kmart': 'off' } });
    await waitFor(() => !sw.loops.has('demo-kmart'), { timeout: 15000, message: 'the Kmart loop to stop' });
  } finally {
    sw.stop();
    sw.cfg.monitor.enabled = false;
    for (const st of sw.state.values()) Object.assign(st, { slowUntil: 0, retryAt: 0 });
  }
});

test("The Games Cube (CrystalCommerce): each tile's product, the dearest option in stock, sold out, pre-orders by category; the store's buylist left out", () => {
  const tile = (href, name, body) => `<li class="product" itemscope itemtype="http://schema.org/Product"><div class="inner"><div class="image"><a href="${href}" itemprop="url" title="${name}"><img src="https://cdn.example/${name.length}.jpg" alt="" itemprop="image"></a></div>
    <div class="meta"><a href="${href}" itemprop="url"><h4 class="name small-12" itemprop="name" title="${name}">${name}</h4></a><a href="/catalog/x/5888"><span class="category">Cat</span></a>${body}</div></div></li>`;
  const form = (vid, price) => `<form class="add-to-cart-form" data-vid="${vid}" data-name="x" data-id="1" data-price="AUD$ ${price}"><span class="regular price">AUD$ ${price}</span><input class="qty" name="qty" type="number" value="1"><input class="utility-button add-to-cart" name="commit" type="submit" value="&#xf217;"></form>`;
  const html = `<html><head><title>Search</title></head><body><div class="products-container browse"><ul class="products">
    ${tile('/catalog/one_piece_tcg-one_piece_booster_boxes/one_piece_two_legends_booster_box_op08/695722', 'One Piece Two Legends Booster Box OP08', `<div class="variant-row in-stock"><span class="variant-qty">3 In Stock</span>${form(8670590, '450.00')}${form(8670591, '420.00')}</div>`)}
    ${tile('/catalog/accessories-playmats/ultra_pro_pokemon_pikachu_playmat/712165', 'ULTRA PRO Pokemon: Pikachu Playmat', '<div class="variant-row no-stock"><span class="variant-qty">Out of stock.</span><span class="price no-stock hide" itemprop="price">AUD$ 50.00</span></div>')}
    ${tile('/catalog/riftbound_pre_orders/radiance_booster_display/731930', 'Radiance Booster Display', `<div class="variant-row in-stock">${form(8700001, '199.95')}</div>`)}
    ${tile('/buylist/magic_singles-pioneer-guilds_of_ravnica/assassins_trophy/594123', "Assassin's Trophy", '<span class="price buylist">AUD$ 1.00</span>')}
  </ul></div></body></html>`;
  const r = parseListing('crystal', html, { base: 'https://www.thegamescube.com/products/search?q=x' });
  assert.equal(r.problem, null);
  assert.deepEqual(r.products.map((p) => [p.sku, p.title, p.price, p.inStock, p.preorder]), [
    ['695722', 'One Piece Two Legends Booster Box OP08', 450, true, false],
    ['712165', 'ULTRA PRO Pokemon: Pikachu Playmat', 50, false, false],
    ['731930', 'Radiance Booster Display', 199.95, true, true],
  ]);
  assert.equal(r.products[0].url, 'https://www.thegamescube.com/catalog/one_piece_tcg-one_piece_booster_boxes/one_piece_two_legends_booster_box_op08/695722');
  assert.equal(r.products[0].image, 'https://cdn.example/38.jpg');
  assert.equal(parseListing('crystal', '<html><title>Search</title><body><p>Nothing</p></body></html>', { base: 'https://www.thegamescube.com/' }).problem, 'layout');
});

test("Premium Bandai: the product data in the search page's PRELOAD_DATA", () => {
  const data = { searchResult: { total: 1, items: [{ productCode: 'N2903432001', name: 'ONE PIECE CARD GAME Premium Card Collection -29th Anniversary Edition-', price: 25, url: '/au/item/N2903432001', image: 'https://p-bandai.com/img/N2903432001.jpg', inStock: true }] } };
  const html = `<html><head><title>SEARCH RESULT</title></head><body><div id="app"></div><script>window.PRELOAD_DATA = ${JSON.stringify(data)};</script></body></html>`;
  const r = parseListing('generic', html, { base: 'https://p-bandai.com/au/search?keyword=one%20piece', productPath: R('pbandai').productPath, skuFromPath: R('pbandai').skuFromPath, storeName: 'Premium Bandai' });
  assert.equal(r.products.length, 1);
  assert.equal(r.products[0].sku, 'N2903432001');
  assert.equal(r.products[0].price, 25);
  assert.equal(r.products[0].url, 'https://p-bandai.com/au/item/N2903432001');
});

test("Premium Bandai: its search JSON (/api/search) — on sale, pre-orders, closed pre-orders and sold out", () => {
  const item = (code, name, saleStatus, flags, amount = 18) => ({
    areaProductNo: `NAP${code}AU`, productCode: code, areaCode: 'AU', productName: { en: name }, productType: 'PreOrder', fixedPrice: true,
    fixedListPrice: { amount, currency: 'AUD' }, saleStatus, displayStatus: 'On', flags,
    productImages: [{ fileUrl: `files/seller-products/${code}/a.webp`, mediaType: 'Image' }],
  });
  const json = JSON.stringify({
    text: 'one piece',
    productResults: {
      products: [
        item('N2903432001', 'ONE PIECE CARD GAME Premium Card Collection -29th Anniversary Edition-', 'On', ['PRE_ORDER']),
        item('N2873815002', 'ONE PIECE CARD GAME Japanese 4th Anniversary Set', 'End', ['PRE_ORDER_CLOSED'], 280),
        item('A2870005001', 'LUFFY’s ARTCANVAS 1/8 -20th Anniversary-', 'On', ['OUT_OF_STOCK'], 148),
        { productCode: 'nope', productName: { en: 'Not a product code' } },
      ],
      sortType: 'NewArrival', limit: 100, offset: 0, totalCount: 3,
    },
    aggs: {},
  });
  const r = parseListing('pbandai', json, { base: 'https://p-bandai.com/api/search?keyword=one%20piece', storeBase: 'https://p-bandai.com/au' });
  assert.equal(r.problem, null);
  assert.equal(r.total, 3);
  assert.deepEqual(r.products.map((p) => [p.sku, p.price, p.inStock, p.preorder]), [
    ['N2903432001', 18, true, true],
    ['N2873815002', 280, false, true],
    ['A2870005001', 148, false, true],
  ]);
  assert.equal(r.products[0].url, 'https://p-bandai.com/au/item/N2903432001');
  assert.equal(r.products[0].image, 'https://p-bandai.com/files/seller-products/N2903432001/a.webp');
  // Without the region header the site answers with an error, not a list.
  assert.equal(parseListing('pbandai', '{"timestamp":"2026-10-16T13:27:22.023Z","status":500,"error":"Internal Server Error","path":"/api/search"}', { storeBase: 'https://p-bandai.com/au' }).problem, 'layout');
  // Each one counts as Premium Bandai's own (the sweeps keep only the store's own links).
  assert.equal(env.app.retailers.forUrl(r.products[0].url).id, 'pbandai');
});
