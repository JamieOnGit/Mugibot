// Reads the product list from a store's search results: every product's code,
// name, price, stock, link and picture. Used by the live sweeps
// (docs/MONITORING.md) on the server, and by the admin's browser (the
// extension gets a copy of this file) for stores that refuse servers.
//
//   target           Target's search page: the product list the page is built from
//                    (__NEXT_DATA__), stock per colour/size.
//   shopify-suggest  Shopify's search suggestions (JB Hi-Fi): JSON, with stock.
//   shopify          A Shopify collection's product list (Trainer Town): JSON, every
//                    product in it with each option's stock; reads suggestions too.
//   constructor      Constructor.io search results (Kmart's search provider): JSON, with
//                    sellers and the states each product is out of stock in.
//   amazon           Amazon's search page: a tile per result, with its ASIN.
//   ebgames          EB Games' and Zing's search JSON (what their search page fetches).
//   crystal          A CrystalCommerce store's search page (The Games Cube): a tile per product.
//   pbandai          Premium Bandai's search JSON (/api/search, what its search page fetches).
//   woo              WooCommerce's product API (Gamesworld): JSON, with stock and the add-to-cart id.
//   magento          Magento's search page (Gamesmen): a tile per product, with its price and stock.
//   generic          Any other store: product data in the page's scripts (Next.js
//                    data, JSON-LD, embedded state), plus product tiles in the HTML.
//
// A product: { sku, aliases, title, price, wasPrice, inStock (true/false/null),
//              preorder, url, image, marketplace }

import { decodeEntities, findAll, findFirst, parseHTML, textContent } from './html.js';
import { looksBlocked, parsePrice } from './extract.js';
import { TILE_ADD_RE } from './words.js';

const clean = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const httpsUrl = (v, base) => {
  if (typeof v !== 'string' || !v.trim()) return '';
  try {
    const u = new URL(v.trim().replace(/^\/\//, 'https://'), base);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch { return ''; }
};
const money = (v) => {
  const n = parsePrice(v);
  return n !== null && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
};

function titleOf(html) {
  const m = String(html).match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1] : '';
}

function nextData(html) {
  const m = String(html).match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** What a page that isn't a result list says about why. */
function pageProblem(html) {
  return looksBlocked(html, titleOf(html)) ? 'blocked' : null;
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------
// Stock per colour: `inStock` on a single item, `stockAvailable` and each size's `inStock` on
// clothing. Target leaves products that are sold out online out of its results altogether
// (see sweep.js: a product gone from the results for a while is sold out).
function targetStock(v) {
  if (!v || typeof v !== 'object') return null;
  const sizes = Array.isArray(v.sizeVariants) ? v.sizeVariants.filter(Boolean) : [];
  if (v.inStock === true || v.stockAvailable === true || sizes.some((s) => s.inStock === true)) return true;
  if (v.inStock === false || v.stockAvailable === false || (sizes.length && sizes.every((s) => s.inStock === false))) return false;
  if (v.comingSoon === true || /out_?of_?stock|sold_?out|unavailable|coming_?soon/i.test(String(v.productDisplayType || ''))) return false;
  return null;
}

export function parseTarget(html, { base = 'https://www.target.com.au' } = {}) {
  const data = nextData(html);
  const list = data && data.props && data.props.pageProps && data.props.pageProps.metadata && data.props.pageProps.metadata.productList;
  if (!list || !Array.isArray(list.products)) return { products: [], total: null, problem: pageProblem(html) || 'layout' };
  const products = [];
  for (const p of list.products) {
    if (!p || !p.id || !p.title) continue;
    const vars = Array.isArray(p.variations) ? p.variations : [];
    const code = String(p.id).replace(/^P/i, '');
    const one = vars.length === 1 ? vars[0] : null;
    const url = httpsUrl(one && one.url, base) || httpsUrl(p.baseProductUrl, base);
    const sku = one && one.colourVariantCode ? String(one.colourVariantCode) : String(p.id);
    const stock = vars.map(targetStock);
    let inStock = null;
    if (stock.includes(true)) inStock = true;
    else if (p.displayOnly || (stock.length && stock.every((x) => x === false))) inStock = false;
    const price = money(p.price && (p.price.offerPrice || (p.price.priceRange && p.price.priceRange.min)));
    const was = money(p.price && p.price.wasPrice);
    products.push({
      sku, aliases: [...new Set([String(p.id), code, sku])].filter((a) => a !== sku), title: clean(p.title),
      price, wasPrice: was && price && was > price ? was : null, inStock,
      preorder: /^pre-?order\b/i.test(p.title) || vars.some((v) => /pre_?order/i.test(String(v && v.productDisplayType))),
      url, image: httpsUrl(p.imageUrl, base), marketplace: false,
    });
  }
  return { products, total: typeof list.totalNumProducts === 'number' ? list.totalNumProducts : null, perPage: list.products.length, problem: null };
}

// ---------------------------------------------------------------------------
// Shopify: search suggestions (JB Hi-Fi), and a collection's product list (Trainer Town)
// ---------------------------------------------------------------------------
const shopifyJson = (text) => {
  try { return JSON.parse(text); } catch { return undefined; }
};
const PREORDER_RE = /\bpre-?orders?\b/i;

export function parseShopifySuggest(text, { base } = {}) {
  const j = typeof text === 'string' ? shopifyJson(text) : text;
  if (j === undefined) return { products: [], problem: pageProblem(text) || 'layout' };
  const list = j && j.resources && j.resources.results && j.resources.results.products;
  if (!Array.isArray(list)) return { products: [], problem: 'layout' };
  const products = [];
  for (const p of list) {
    if (!p || !p.handle || !p.title) continue;
    let url = httpsUrl(p.url, base);
    if (url) { const u = new URL(url); u.search = ''; u.hash = ''; url = u.href; }
    const image = p.image || (p.featured_image && p.featured_image.url) || '';
    const price = money(p.price ?? p.price_min);
    const was = money(p.compare_at_price_max);
    products.push({
      sku: String(p.handle), aliases: p.id ? [String(p.id)] : [], title: clean(p.title), price,
      wasPrice: was && price && was > price ? was : null, inStock: typeof p.available === 'boolean' ? p.available : null,
      // (Trainer Town marks pre-orders in the picture's description: "[Pre-Order] Pokémon - TCG - …")
      preorder: PREORDER_RE.test(`${p.title} ${(p.tags || []).join(' ')} ${(p.featured_image && p.featured_image.alt) || ''}`),
      url, image: httpsUrl(image, base), marketplace: false,
    });
  }
  return { products, problem: null };
}

/**
 * A Shopify collection's product list (/collections/<handle>/products.json): every product in it,
 * sold-out ones too, with each option's stock. In stock when any option is.
 */
export function parseShopifyProducts(text, { base } = {}) {
  const j = typeof text === 'string' ? shopifyJson(text) : text;
  if (j === undefined) return { products: [], problem: pageProblem(text) || 'layout' };
  if (j && j.resources) return parseShopifySuggest(j, { base });
  const list = j && j.products;
  if (!Array.isArray(list)) return { products: [], problem: 'layout' };
  // Product links sit next to the collections (the same shop, under any path the shop is at).
  let shop = '';
  try { shop = new URL(base).pathname.replace(/\/(collections|products)(\/.*)?$/, '').replace(/\/$/, ''); } catch { /* no base */ }
  const products = [];
  for (const p of list) {
    if (!p || !p.handle || !p.title) continue;
    const vars = (Array.isArray(p.variants) ? p.variants : []).filter((v) => v && typeof v === 'object');
    const selling = vars.filter((v) => v.available === true);
    const prices = (selling.length ? selling : vars).map((v) => money(v.price)).filter((n) => n !== null);
    const price = prices.length ? Math.min(...prices) : null;
    const cheapest = (selling.length ? selling : vars).find((v) => money(v.price) === price);
    const was = cheapest ? money(cheapest.compare_at_price) : null;
    let inStock = null;
    if (selling.length) inStock = true;
    else if (vars.length && vars.every((v) => v.available === false)) inStock = false;
    const images = Array.isArray(p.images) ? p.images : [];
    const tags = Array.isArray(p.tags) ? p.tags : typeof p.tags === 'string' ? p.tags.split(',') : [];
    products.push({
      sku: String(p.handle), aliases: p.id ? [String(p.id)] : [], title: clean(p.title), price,
      wasPrice: was && price && was > price ? was : null, inStock,
      // The option to buy, for Shopify's add-to-cart link (the cheapest one in stock). oneVariant: the only
      // one there is (a drop's run goes straight to its cart link: nothing to choose between).
      variantId: cheapest && /^\d{1,20}$/.test(String(cheapest.id)) ? String(cheapest.id) : null,
      oneVariant: vars.length === 1,
      preorder: PREORDER_RE.test(`${p.title} ${tags.join(' ')} ${p.product_type || ''}`),
      url: httpsUrl(`${shop}/products/${encodeURIComponent(p.handle)}`, base), image: httpsUrl(images[0] && images[0].src, base), marketplace: false,
    });
  }
  return { products, total: products.length, problem: null };
}

// ---------------------------------------------------------------------------
// Constructor.io search results (Kmart)
// ---------------------------------------------------------------------------
// Kmart's search page has no products in it: the page asks Kmart's search provider,
// Constructor.io, for them once it's open. Its answer has every product's code, name, price,
// picture, sellers, pre-order flag, and the states it's out of stock in ("stateOOS").
export const AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
const storeLink = (root, path) => {
  if (typeof path !== 'string' || !path.trim()) return '';
  if (/^https?:\/\//i.test(path)) return httpsUrl(path);
  return httpsUrl(`${String(root || '').replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`);
};

export function parseConstructor(text, { base, storeBase } = {}) {
  const j = typeof text === 'string' ? shopifyJson(text) : text;
  const r = j && j.response;
  if (!r || !Array.isArray(r.results)) return { products: [], problem: (j === undefined && pageProblem(text)) || 'layout' };
  const products = [];
  for (const x of r.results) {
    const d = x && x.data;
    if (!d || !d.id || typeof x.value !== 'string') continue;
    const price = money(d.price);
    const was = money((String(d.SavePrice || '').match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/) || [])[1]);
    const oos = d.stateOOS && typeof d.stateOOS === 'object' ? Object.keys(d.stateOOS) : [];
    const sellers = Array.isArray(d.Seller) ? d.Seller.map(String) : [];
    products.push({
      sku: String(d.id).replace(/^P_/, ''), aliases: [String(d.id)], title: clean(x.value), price,
      wasPrice: was && price && was > price ? was : null,
      // Out of stock in every state = sold out online; in stock somewhere otherwise.
      inStock: !AU_STATES.every((s) => oos.includes(s)),
      // In stock in some states only: which (its alerts say so).
      ...(oos.length && !AU_STATES.every((s) => oos.includes(s)) ? { states: AU_STATES.filter((s) => !oos.includes(s)) } : {}),
      preorder: d.isPreOrderActive === true, url: storeLink(storeBase || base, d.url || d.uri), image: httpsUrl(d.image_url, base),
      marketplace: sellers.length > 0 && sellers.every((s) => /market ?place/i.test(s)),
    });
  }
  return { products, total: typeof r.total_num_results === 'number' ? r.total_num_results : null, perPage: r.results.length, problem: null };
}

// ---------------------------------------------------------------------------
// EB Games and Zing (one platform): the search page's own JSON (/search/query)
// ---------------------------------------------------------------------------
// The search page has no products in it: its script asks /search/query for them. Each result:
// sku, title, productUrl, imageUrl, price, promotionPrice, isOutOfStock, isUnavailable,
// isComingSoon, isPreowned, releaseDate.
export function parseEbGames(text, { base, storeBase, now = Date.now() } = {}) {
  const j = typeof text === 'string' ? shopifyJson(text) : text;
  if (j === undefined) return { products: [], problem: pageProblem(text) || 'layout' };
  if (!j || !Array.isArray(j.results)) return { products: [], problem: 'layout' };
  const products = [];
  for (const r of j.results) {
    if (!r || !r.sku || !r.title) continue;
    const full = money(r.price);
    const promo = money(r.promotionPrice);
    const price = promo && (!full || promo < full) ? promo : full;
    const released = Date.parse(r.releaseDate || '');
    products.push({
      sku: String(r.sku), aliases: [], title: clean(`${r.title}${r.isPreowned ? ' (pre-owned)' : ''}`), price,
      wasPrice: promo && full && promo < full ? full : null,
      inStock: r.isOutOfStock === true || r.isUnavailable === true || r.isComingSoon === true ? false : true,
      preorder: !r.isComingSoon && Number.isFinite(released) && released > now,
      url: storeLink(storeBase || base, r.productUrl), image: httpsUrl(r.imageUrl, storeBase || base),
      // Only when the result itself says another seller sells it (never guessed from the name).
      marketplace: r.isMarketplace === true || r.marketplace === true || r.isThirdParty === true
        || (typeof r.sellerName === 'string' && r.sellerName.trim() !== '' && !/\b(eb ?games|zing)\b/i.test(r.sellerName)),
    });
  }
  return { products, total: typeof j.totalResults === 'number' ? j.totalResults : null, perPage: j.results.length, problem: null };
}

// ---------------------------------------------------------------------------
// Premium Bandai: its search JSON (/api/search?keyword=…, with the region in x-g1-area-code)
// ---------------------------------------------------------------------------
// productResults.products: productCode (the code in /<region>/item/<code>), productName.en,
// fixedListPrice.amount, saleStatus (On, Waiting = not on sale yet, End), productType (PreOrder…),
// flags (PRE_ORDER, PRE_ORDER_CLOSED, OUT_OF_STOCK…) and productImages[].fileUrl (under the site).
export function parsePBandai(text, { base, storeBase } = {}) {
  const j = typeof text === 'string' ? shopifyJson(text) : text;
  if (j === undefined) return { products: [], problem: pageProblem(text) || 'layout' };
  const r = j && j.productResults;
  // (A search with nothing found has no products list at all, only its count: 0.)
  if (r && !Array.isArray(r.products) && r.totalCount === 0) return { products: [], total: 0, perPage: 0, problem: null };
  if (!r || !Array.isArray(r.products)) return { products: [], problem: 'layout' };
  const site = (() => { try { return new URL(storeBase || base).origin; } catch { return ''; } })();
  const products = [];
  for (const p of r.products) {
    const sku = p && typeof p.productCode === 'string' && /^[A-Z]\d{6,15}$/.test(p.productCode) ? p.productCode : null;
    const name = p && p.productName && (p.productName.en || Object.values(p.productName).find((v) => typeof v === 'string'));
    if (!sku || !name) continue;
    const flags = Array.isArray(p.flags) ? p.flags.map(String) : [];
    const image = Array.isArray(p.productImages) && p.productImages.find((x) => x && x.fileUrl && x.mediaType !== 'Video');
    products.push({
      sku, aliases: [], title: clean(name), price: money(p.fixedListPrice && p.fixedListPrice.amount), wasPrice: null,
      inStock: p.saleStatus === 'On' && !flags.includes('OUT_OF_STOCK') && !flags.includes('PRE_ORDER_CLOSED'),
      preorder: p.productType === 'PreOrder' || flags.includes('PRE_ORDER'),
      url: storeLink(storeBase || base, `/item/${sku}`), image: image ? httpsUrl(image.fileUrl, `${site}/`) : '', marketplace: false,
    });
  }
  return { products, total: typeof r.totalCount === 'number' ? r.totalCount : null, perPage: r.products.length, problem: null };
}

// ---------------------------------------------------------------------------
// Amazon's search results
// ---------------------------------------------------------------------------
// Each result is a tile marked data-component-type="s-search-result" with its ASIN. The name is
// in two parts (the brand, then the rest: "Pokémon" + "TCG: 30th Celebration Elite Trainer Box").
const AMAZON_BLOCK_RE = /api-services-support@amazon\.com|\/errors\/validateCaptcha|Type the characters you see in this image/i;

export function parseAmazon(html, { base, storeBase } = {}) {
  const s = String(html || '');
  if (AMAZON_BLOCK_RE.test(s)) return { products: [], problem: 'blocked' };
  const problem = pageProblem(s);
  if (problem) return { products: [], problem };
  const doc = parseHTML(s);
  const cls = (n) => String((n.attrs && n.attrs.class) || '');
  const results = findAll(doc, (n) => n.attrs && n.attrs['data-component-type'] === 's-search-result' && /^[A-Z0-9]{10}$/.test(n.attrs['data-asin'] || ''));
  if (!results.length) return { products: [], problem: /s-main-slot|s-search-results/.test(s) ? 'empty' : 'layout' };
  // Product links on the store's own address (the dummy store keeps Amazon's copy under /amazon).
  let origin = 'https://www.amazon.com.au';
  try { origin = storeBase ? String(storeBase).replace(/\/+$/, '') : new URL(base).origin; } catch { /* default */ }
  const products = [];
  for (const t of results) {
    const asin = t.attrs['data-asin'];
    const heads = findAll(t, (n) => n.tag === 'h2').map((h) => clean(h.attrs['aria-label'] || textContent(h))).filter(Boolean).sort((a, b) => b.length - a.length);
    let title = heads[0] || '';
    const brand = heads.slice(1).find((b) => b.length < 40 && !norm(title).includes(norm(b)));
    if (brand) title = `${brand} ${title}`;
    if (title.length < 4) continue;
    const priceBox = findFirst(t, (n) => /\ba-price\b/.test(cls(n)) && !/\ba-text-price\b/.test(cls(n)));
    const priceText = priceBox && findFirst(priceBox, (n) => /\ba-offscreen\b/.test(cls(n)));
    const wasBox = findFirst(t, (n) => /\ba-text-price\b/.test(cls(n)));
    const wasText = wasBox && findFirst(wasBox, (n) => /\ba-offscreen\b/.test(cls(n)));
    const price = priceText ? money(textContent(priceText)) : null;
    const was = wasText ? money(textContent(wasText)) : null;
    const img = findFirst(t, (n) => n.tag === 'img' && /\bs-image\b/.test(cls(n)));
    const text = tileText(t);
    products.push({
      sku: asin, aliases: [], title: clean(title), price, wasPrice: was && price && was > price ? was : null,
      inStock: /\bcurrently unavailable\b/i.test(text) ? false : price !== null ? true : null,
      preorder: /\bpre-?order\b|\bwill be released on\b/i.test(text), url: `${origin}/dp/${asin}`,
      image: img ? httpsUrl(img.attrs.src, base) : '', marketplace: false,
    });
  }
  return { products, total: null, problem: null };
}

// ---------------------------------------------------------------------------
// City Beach search results (Salesforce Commerce Cloud)
// ---------------------------------------------------------------------------
// Server-made pages: a tile per product (<div class="product" data-pid="20424049-01">) with its
// name, brand and price in the tile's analytics data (data-gtmdata) and its link. Stock isn't
// on the tiles (a sold-out tile says so); the product page's own data says it, which the
// monitor reads.
export function parseCityBeach(html, { base, storeBase } = {}) {
  const s = String(html || '');
  const problem = pageProblem(s);
  if (problem) return { products: [], problem };
  const doc = parseHTML(s);
  const tiles = findAll(doc, (n) => n.tag === 'div' && /(^|\s)product(\s|$)/.test(String((n.attrs && n.attrs.class) || '')) && /^\d{6,10}-\d{2}$/.test((n.attrs && n.attrs['data-pid']) || ''));
  if (!tiles.length) return { products: [], problem: /no-results|did not return any results|0 results/i.test(s) ? 'empty' : 'layout' };
  const products = [];
  const seen = new Set();
  for (const t of tiles) {
    const sku = t.attrs['data-pid'];
    if (seen.has(sku)) continue;
    seen.add(sku);
    let gtm = {};
    try { gtm = JSON.parse(String(t.attrs['data-gtmdata'] || '{}').replace(/&quot;/g, '"').replace(/&amp;/g, '&')) || {}; } catch { gtm = {}; }
    const link = findFirst(t, (n) => n.tag === 'a' && /\/\d{6,10}-\d{2}\.html/.test((n.attrs && n.attrs.href) || ''));
    const img = findFirst(t, (n) => n.tag === 'img' && ((n.attrs && (n.attrs['data-src'] || n.attrs.src)) || ''));
    const text = tileText(t);
    const name = clean(String(gtm.name || '').replace(/&eacute;/g, 'é').replace(/&amp;/g, '&') || (link ? textContent(link) : ''));
    const brand = clean(gtm.brand || '', 60);
    const title = brand && !norm(name).includes(norm(brand)) ? `${brand} ${name}` : name;
    if (title.length < 4) continue;
    products.push({
      sku, aliases: [], title, price: money(gtm.price), wasPrice: null,
      // (Stock is read from the product page: the tiles don't say it reliably.)
      inStock: null,
      preorder: /\bpre-?order\b/i.test(text),
      url: link ? httpsUrl(link.attrs.href, storeBase || base) : '',
      image: img ? httpsUrl(img.attrs['data-src'] || img.attrs.src, base) : '', marketplace: false,
    });
  }
  return { products, total: null, problem: null };
}

// ---------------------------------------------------------------------------
// CrystalCommerce search results (The Games Cube)
// ---------------------------------------------------------------------------
// Server-made pages: a tile per product (<li class="product">) with its link, name, picture and
// each option ("Sealed"…). An option in stock has an add-to-cart form with its price; with none
// in stock the tile says "Out of stock.". Pre-orders sit in a "… Pre-Orders" category (in the link).
export function parseCrystal(html, { base } = {}) {
  const s = String(html || '');
  const problem = pageProblem(s);
  if (problem) return { products: [], problem };
  const doc = parseHTML(s);
  const cls = (n) => ` ${String((n.attrs && n.attrs.class) || '')} `;
  const tilesFound = findAll(doc, (n) => n.tag === 'li' && / product /.test(cls(n)));
  if (!tilesFound.length) return { products: [], problem: /class="products?[\s"]|no results|0 results/i.test(s) ? 'empty' : 'layout' };
  const products = [];
  for (const t of tilesFound) {
    const link = findFirst(t, (n) => n.tag === 'a' && /\/catalog\/[^/]+\/[^/]+\/\d+\/?$/.test(n.attrs.href || ''));
    if (!link) continue;
    const href = link.attrs.href;
    const sku = href.match(/\/(\d+)\/?$/)[1];
    const nameNode = findFirst(t, (n) => /\bname\b/.test(cls(n)) && (n.attrs.itemprop === 'name' || n.tag === 'h4'));
    const title = clean((nameNode && (nameNode.attrs.title || textContent(nameNode))) || link.attrs.title || '');
    if (title.length < 3) continue;
    const forms = findAll(t, (n) => n.tag === 'form' && / add-to-cart-form /.test(cls(n)) && /^\d+$/.test(n.attrs['data-vid'] || ''));
    const prices = forms.map((f) => money(f.attrs['data-price'])).filter((n) => n !== null);
    const anyPrice = findFirst(t, (n) => / price /.test(cls(n)) && !/ (buylist|store-credit) /.test(cls(n)) && money(textContent(n)) !== null);
    const price = prices.length ? Math.max(...prices) : anyPrice ? money(textContent(anyPrice)) : null;
    const text = tileText(t);
    const inStock = forms.length ? true : /\bout of stock\b/i.test(text) ? false : null;
    const img = findFirst(t, (n) => n.tag === 'img' && (n.attrs.itemprop === 'image' || n.attrs.src));
    products.push({
      sku, aliases: [], title, price, wasPrice: null, inStock,
      preorder: /pre_?orders?\b/i.test(href) || PREORDER_RE.test(title),
      url: httpsUrl(href, base), image: img ? httpsUrl(img.attrs.src, base) : '', marketplace: false,
    });
  }
  return { products, total: null, problem: products.length ? null : 'empty' };
}

// ---------------------------------------------------------------------------
// WooCommerce's product API (/wp-json/wc/store/v1/products — Gamesworld's): JSON, a product a row
// with its link, price (in cents), stock and add-to-cart words ("Add to cart", "Pre-order now").
// Names come with HTML entities in them ("&amp;"). A simple product's id is what the store's own
// add-to-cart link takes (/checkout/?add-to-cart=<id>).
// ---------------------------------------------------------------------------
export function parseWoo(text, { base } = {}) {
  let j;
  try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch { return { products: [], problem: pageProblem(text) || 'layout' }; }
  if (!Array.isArray(j)) return { products: [], problem: 'layout' };
  const products = [];
  for (const p of j) {
    if (!p || typeof p !== 'object' || !p.name || typeof p.permalink !== 'string') continue;
    const url = httpsUrl(p.permalink, base);
    if (!url) continue;
    const slug = (new URL(url).pathname.match(/\/product\/([^/?#]+)\/?$/) || [])[1] || String(p.slug || p.id);
    const pr = p.prices && typeof p.prices === 'object' ? p.prices : {};
    const unit = 10 ** (Number.isInteger(pr.currency_minor_unit) ? pr.currency_minor_unit : 2);
    const cents = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : money(Number(v) / unit));
    const price = cents(pr.price);
    const was = cents(pr.regular_price);
    const words = `${(p.add_to_cart && p.add_to_cart.text) || ''} ${(p.stock_availability && p.stock_availability.text) || ''}`;
    const inStock = p.is_in_stock === true && p.is_purchasable !== false ? true : p.is_in_stock === false ? false : null;
    const title = clean(decodeEntities(p.name));
    const img = Array.isArray(p.images) && p.images[0] ? p.images[0].thumbnail || p.images[0].src : '';
    products.push({
      sku: slug, aliases: [String(p.id), ...(p.sku ? [String(p.sku)] : [])], title, price,
      wasPrice: was && price && was > price ? was : null, inStock,
      // (Only a simple product goes in with its id alone: one with options needs one chosen first.)
      variantId: p.type === 'simple' && /^\d{1,20}$/.test(String(p.id)) ? String(p.id) : null,
      oneVariant: p.type === 'simple',
      preorder: PREORDER_RE.test(`${words} ${title}`) || p.is_on_backorder === true,
      url, image: httpsUrl(img, base), marketplace: false,
    });
  }
  return { products, total: null, problem: null };
}

// ---------------------------------------------------------------------------
// Magento's search results (/catalogsearch/result/?q=… — Gamesmen's): a tile per product
// (li.product-item, or a Hyvä form.product-item) with its link (a.product-item-link), its price
// (data-price-amount), and "Add to Cart" / "Pre-order" — or "Out of stock".
// ---------------------------------------------------------------------------
export function parseMagento(html, { base, skuFromPath = null, productPath = null, storeName = '' } = {}) {
  const s = String(html || '');
  const problem = pageProblem(s);
  if (problem) return { products: [], problem };
  const doc = parseHTML(s);
  const cls = (n) => ` ${String((n.attrs && n.attrs.class) || '')} `;
  const tilesFound = findAll(doc, (n) => ['li', 'div', 'form', 'article'].includes(n.tag) && / product-item /.test(cls(n)) && !!findFirst(n, (x) => x.tag === 'a' && / product-item-link /.test(cls(x))));
  // (Only the outermost tile: Luma's li.product-item holds a div.product-item-info.)
  const tiles = tilesFound.filter((t) => !tilesFound.some((o) => o !== t && findFirst(o, (x) => x === t)));
  if (!tiles.length) {
    // The Gamesmen's own tiles (its Hyvä theme, Oct 2026), before anything looser.
    const ga = gamesmenTiles(doc, { base, skuFromPath });
    if (ga.length) return { products: ga, total: null, problem: null };
    // Results drawn some other way (a search provider's own tiles, or its answer the browser asked for
    // again: see the extension's renderedPage): any product with its link and a price. Only priced
    // ones — the site's menu links look like product links at a store whose products are /<name>.
    const other = parseGeneric(s, { base, productPath, skuFromPath, storeName }).products.filter((p) => p.price !== null);
    if (other.length) return { products: other, total: null, problem: null };
    return { products: [], problem: /returned no results|no results|did not match any/i.test(s) ? 'empty' : 'layout' };
  }
  const products = [];
  const seen = new Set();
  for (const t of tiles) {
    const link = findFirst(t, (n) => n.tag === 'a' && / product-item-link /.test(cls(n)));
    const url = httpsUrl(link.attrs.href, base);
    if (!url) continue;
    const path = new URL(url).pathname;
    const m = skuFromPath ? path.match(skuFromPath) : null;
    const sku = (m && m[1]) || path.replace(/^\/+|\/+$/g, '').split('/').pop().replace(/\.html$/, '');
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    const title = clean(textContent(link) || link.attrs.title || '');
    if (title.length < 3) continue;
    const amount = (type) => {
      const n = findFirst(t, (x) => x.attrs['data-price-type'] === type && x.attrs['data-price-amount'] !== undefined);
      return n ? money(n.attrs['data-price-amount']) : null;
    };
    const priceText = findFirst(t, (n) => / price /.test(cls(n)) && money(textContent(n)) !== null);
    const price = amount('finalPrice') ?? (priceText ? money(textContent(priceText)) : null);
    const was = amount('oldPrice');
    const text = tileText(t);
    const tocart = findFirst(t, (n) => (n.tag === 'button' || n.tag === 'input') && (/ tocart /.test(cls(n)) || TILE_ADD_RE.test(textContent(n) || n.attrs.value || n.attrs.title || '')));
    const sold = findFirst(t, (n) => / (stock|unavailable) /.test(cls(n)) && / unavailable /.test(cls(n))) || /\b(out of stock|sold out|no longer available|currently unavailable)\b/i.test(text);
    const inStock = sold ? false : tocart ? true : null;
    const formSku = findFirst(t, (n) => n.attrs['data-product-sku'] !== undefined);
    const priceBox = findFirst(t, (n) => n.attrs['data-product-id'] !== undefined);
    const img = findFirst(t, (n) => n.tag === 'img' && (n.attrs.src || n.attrs['data-src']));
    products.push({
      sku, aliases: [formSku && formSku.attrs['data-product-sku'], priceBox && priceBox.attrs['data-product-id']].filter(Boolean).map(String), title, price,
      wasPrice: was && price && was > price ? was : null, inStock, preorder: PREORDER_RE.test(`${text} ${title}`),
      url, image: img ? httpsUrl(img.attrs.src || img.attrs['data-src'], base) : '', marketplace: false,
    });
  }
  return { products, total: null, problem: products.length ? null : 'empty' };
}

// The Gamesmen's tiles (its search and brand pages, from a copy of its real page, Oct 2026): a
// div[data-ga-type="product-list-item"] per product, its link round the whole tile; the name in
// .product-card-title; the price shown (GST in — the link's data-price leaves GST out), a struck-through
// old one; and its button's title, "Add to Cart" or "Pre-Order" (a "Pre-Order" line above it too). Its
// data-dimension10 isn't the stock (it says "Out of stock" on products that can be added), and the
// buttons' own data-name/data-price are another product's: neither is read.
function gamesmenTiles(doc, { base, skuFromPath }) {
  const cls = (n) => ` ${String((n.attrs && n.attrs.class) || '')} `;
  const PRICE_ONLY = /^\s*\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s*$/;
  const out = [];
  const seen = new Set();
  for (const t of findAll(doc, (n) => n.attrs && n.attrs['data-ga-type'] === 'product-list-item')) {
    const link = findFirst(t, (n) => n.tag === 'a' && !!n.attrs.href);
    const url = link ? httpsUrl(link.attrs.href, base) : null;
    if (!url) continue;
    const path = new URL(url).pathname;
    const m = skuFromPath ? path.match(skuFromPath) : null;
    const sku = (m && m[1]) || path.replace(/^\/+|\/+$/g, '').split('/').pop().replace(/\.html$/, '');
    if (!sku || seen.has(sku)) continue;
    const head = findFirst(t, (n) => / product-card-title /.test(cls(n)));
    const img = findFirst(t, (n) => n.tag === 'img' && (n.attrs.src || n.attrs['data-src']));
    const title = clean((head && textContent(head)) || decodeEntities(link.attrs['data-name'] || '') || (img && img.attrs.alt) || '');
    if (title.length < 3) continue;
    seen.add(sku);
    const prices = findAll(t, (n) => n.tag === 'span' && PRICE_ONLY.test(textContent(n)));
    const now = prices.find((n) => !/ line-through /.test(cls(n)));
    const old = prices.find((n) => / line-through /.test(cls(n)));
    const price = now ? money(textContent(now)) : null;
    const was = old ? money(textContent(old)) : null;
    const text = tileText(t);
    const add = findFirst(t, (n) => n.tag === 'button' && (/ product-list-addtocart /.test(cls(n)) || ADD_BUTTON_RE.test(n.attrs.title || textContent(n))));
    const words = add ? `${add.attrs.title || ''} ${textContent(add)}` : '';
    const sold = /\b(out of stock|sold out|no longer available|currently unavailable|notify me)\b/i.test(text);
    const inStock = add && add.attrs.disabled === undefined ? true : sold || (add && add.attrs.disabled !== undefined) ? false : null;
    const id = findFirst(t, (n) => n.tag === 'input' && n.attrs.name === 'product' && /^\d{1,12}$/.test(n.attrs.value || ''));
    out.push({
      sku, aliases: id ? [String(id.attrs.value)] : [], title, price, wasPrice: was && price && was > price ? was : null, inStock,
      preorder: PREORDER_RE.test(words) || /(^|\s)pre-?\s?order(\s|$)/i.test(text), url,
      image: img ? httpsUrl(img.attrs.src || img.attrs['data-src'], base) : '', marketplace: false,
    });
  }
  return out;
}
const ADD_BUTTON_RE = /^\s*(add to (cart|bag|basket|trolley)|pre-?\s?order)\s*$/i;

// ---------------------------------------------------------------------------
// Any store: data in the page's scripts, then product tiles
// ---------------------------------------------------------------------------
const URL_KEYS = ['url', 'href', 'link', 'productUrl', 'productURL', 'pdpUrl', 'canonicalUrl', 'baseProductUrl', 'seoUrl', 'urlPath', 'path', 'slugUrl'];
const IMAGE_KEYS = ['image', 'imageUrl', 'imageURL', 'thumbnail', 'thumbnailUrl', 'primaryImage', 'img', 'images', 'media'];

// From MugiWatch: the places stores keep a product's price…
function pickPrice(node) {
  const o = node.offers && typeof node.offers === 'object' ? (Array.isArray(node.offers) ? node.offers[0] || {} : node.offers) : {};
  const pr = node.prices && typeof node.prices === 'object' ? node.prices : {};
  const p = node.price && typeof node.price === 'object' ? node.price : {};
  for (const c of [typeof node.price === 'object' ? null : node.price, o.price, o.lowPrice, pr.sale, pr.single, pr.price, pr.amount, pr.current, p.offerPrice, p.salePrice,
    p.amount, p.value, p.current, p.price, p.now, node.sellingPrice, node.offerPrice, node.salePrice, node.currentPrice, node.listPrice]) {
    if (typeof c === 'number' || typeof c === 'string') {
      const n = money(c);
      if (n !== null) return n;
    }
  }
  return null;
}

// …whether it's in stock…
function readStock(node) {
  const o = node.offers && typeof node.offers === 'object' ? (Array.isArray(node.offers) ? node.offers[0] || {} : node.offers) : {};
  const clues = [node.inStock, node.in_stock, node.isInStock, node.available, node.isAvailable, node.availability, node.stock, node.stockStatus, node.stock_status,
    node.stockLevel, node.availableOnline, node.isAvailableOnline, node.purchasable, node.isPurchasable, node.soldOut === true ? 'sold out' : undefined, o.availability,
    node.item && node.item.inStock, node.item && node.item.available].filter((c) => c !== undefined && c !== null && typeof c !== 'object');
  for (const c of clues) {
    if (typeof c === 'boolean') return c;
    if (typeof c === 'number') return c > 0;
    const s = String(c).toLowerCase();
    if (/out ?of ?stock|outofstock|sold ?out|soldout|unavailable|no_?stock|discontinued/.test(s)) return false;
    if (/pre-?order|preorder|in ?stock|instock|available|limited/.test(s)) return true;
  }
  return null;
}

// …and whether it's sold by someone else (a marketplace seller).
function readMarketplace(node, storeName) {
  for (const k of ['isMarketplace', 'marketplace', 'is_marketplace', 'thirdPartySeller', 'isThirdParty', 'isPartner', 'byMarketplace', 'isMarketplaceProduct']) {
    if (node[k] === true) return true;
  }
  const first = String(storeName || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ')[0];
  for (const k of ['sellerName', 'soldBy', 'seller', 'vendorName', 'merchantName', 'seller_type', 'sellerType', 'listingType', 'fulfilledBy']) {
    const v = node[k];
    const s = typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.name === 'string' ? v.name : '';
    if (!s.trim()) continue;
    if (/market ?place|third ?party/i.test(s)) return true;
    if (first && !s.toLowerCase().replace(/[^a-z0-9 ]/g, '').includes(first)) return true;
  }
  for (const k of ['condition', 'productState', 'listingState', 'entryType']) {
    if (typeof node[k] === 'string' && /second ?hand|used|refurb|trade ?in|market ?place/i.test(node[k])) return true;
  }
  return false;
}

function pickUrl(node, base, productPath) {
  for (const k of URL_KEYS) {
    const v = node[k];
    if (typeof v !== 'string' || v.length < 2 || v.length > 1000) continue;
    const u = httpsUrl(v, base);
    if (u && (!productPath || productPath.test(new URL(u).pathname))) return u;
  }
  return '';
}

function pickImage(node, base) {
  for (const k of IMAGE_KEYS) {
    let v = node[k];
    if (Array.isArray(v)) v = v[0];
    if (v && typeof v === 'object') v = v.url || v.src || v.href || v.contentUrl;
    const u = httpsUrl(v, base);
    if (u) return u;
  }
  return '';
}

function walkJson(node, out, ctx, depth = 0) {
  if (depth > 40 || out.length > 2000) return;
  if (Array.isArray(node)) { for (const n of node) walkJson(n, out, ctx, depth + 1); return; }
  if (!node || typeof node !== 'object') return;
  const title = node.title || node.name || node.displayName || node.productName || (node.item && node.item.name);
  if (typeof title === 'string' && title.trim().length > 3) {
    const price = pickPrice(node);
    const url = pickUrl(node, ctx.base, ctx.productPath);
    const fromUrl = url && ctx.skuFrom(url);
    const code = node.sku || node.productId || node.productCode || node.code || node.keycode || node.itemNumber || node.id || (node.item && node.item.sku);
    const sku = fromUrl || (typeof code === 'string' || typeof code === 'number' ? String(code) : '');
    // A product: a name with a price, and either its own link or a product code.
    if (price !== null && sku && (url || ctx.codesOk)) {
      out.push({
        sku, aliases: code && String(code) !== sku ? [String(code)] : [], title: clean(title), price, wasPrice: null, inStock: readStock(node),
        preorder: /\bpre-?order\b/i.test(`${title} ${typeof node.availability === 'string' ? node.availability : ''}`),
        url, image: pickImage(node, ctx.base), marketplace: readMarketplace(node, ctx.storeName),
      });
    }
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') walkJson(v, out, ctx, depth + 1);
}

/** Every JSON blob a page carries: Next.js data, JSON-LD, JSON scripts and `window.__STATE__ = {…}` (or `PRELOAD_DATA = {…}`, Premium Bandai's). */
function jsonBlobs(doc) {
  const out = [];
  for (const s of findAll(doc, (n) => n.tag === 'script' && n.text)) {
    const type = String(s.attrs.type || '').toLowerCase();
    const text = s.text.trim();
    if (/json/.test(type) || s.attrs.id === '__NEXT_DATA__') {
      try { out.push(JSON.parse(text)); } catch { /* not JSON after all */ }
      continue;
    }
    if (type && !/javascript|module/.test(type)) continue;
    for (const m of text.matchAll(/(?:window\.)?(?:__[A-Z_]+__|PRELOAD_DATA)\s*=\s*\{/g)) {
      const start = m.index + m[0].length - 1;
      const blob = balanced(text, start);
      if (blob) { try { out.push(JSON.parse(blob)); } catch { /* not plain JSON */ } }
    }
  }
  return out;
}

function balanced(s, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length && i - start < 3_000_000; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

const TILE_RE = /\b(product|tile|card|item|result)\b|product[-_]|[-_](tile|card)/i;
const SKIP_TEXT = new Set(['script', 'style', 'noscript', 'template', 'svg']);

/** A tile's text, with a space between every element (so "$100" and "Add to bag" stay apart). */
function tileText(node) {
  const parts = [];
  const rec = (n) => {
    if (n.type === 3) { parts.push(n.text); return; }
    if (SKIP_TEXT.has(n.tag)) return;
    for (const c of n.children) rec(c);
    parts.push(' ');
  };
  rec(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** Product tiles in the HTML: a link to a product page, with its name, price and stock in the tile around it. */
function tiles(doc, ctx) {
  const out = [];
  const seen = new Set();
  // A link's product (its path), or null: not a product link at this store.
  const keyOf = (n) => {
    const url = n.tag === 'a' && n.attrs.href ? httpsUrl(n.attrs.href, ctx.base) : null;
    if (!url) return null;
    const u = new URL(url);
    if (ctx.host && u.hostname.replace(/^www\./, '') !== ctx.host) return null;
    if (!(ctx.productPath || /\/(p|product|products)\//i).test(u.pathname)) return null;
    return u.pathname.replace(/\/+$/, '').toLowerCase();
  };
  for (const a of findAll(doc, (n) => n.tag === 'a' && n.attrs.href)) {
    const key = keyOf(a);
    if (!key || seen.has(key)) continue;
    const u = new URL(httpsUrl(a.attrs.href, ctx.base));
    u.search = '';
    u.hash = '';
    // The tile: the nearest container that looks like one (or a few levels up) — never one holding
    // another product too (that's the list: its first price isn't this one's).
    let tile = a;
    for (let p = a.parent, i = 0; p && p.tag !== '#root' && p.tag !== 'body' && i < 6; p = p.parent, i++) {
      if (findFirst(p, (n) => { const k = n !== a ? keyOf(n) : null; return !!k && k !== key; })) break;
      tile = p;
      const id = `${p.attrs.class || ''} ${p.attrs['data-testid'] || ''} ${p.attrs.id || ''}`;
      if (p.tag === 'article' || p.tag === 'li' || TILE_RE.test(id)) break;
    }
    const text = tileText(tile);
    let title = clean(textContent(a) || a.attrs.title || a.attrs['aria-label'] || '');
    if (!title || /\$\s?\d/.test(title)) {
      const img = findFirst(tile, (n) => n.tag === 'img' && n.attrs.alt);
      if (img) title = clean(img.attrs.alt);
    }
    if (!title || title.length < 4) continue;
    seen.add(key);
    const pm = text.match(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/);
    const img = findFirst(tile, (n) => n.tag === 'img' && (n.attrs.src || n.attrs['data-src']));
    out.push({
      sku: ctx.skuFrom(u.href) || key, aliases: [], title, price: pm ? money(pm[1]) : null, wasPrice: null,
      inStock: /\b(out of stock|sold out|unavailable|no stock|currently unavailable)\b/i.test(text) ? false
        : TILE_ADD_RE.test(text) ? true : null,
      preorder: /\bpre-?order\b/i.test(text), url: u.href, image: img ? httpsUrl(img.attrs.src || img.attrs['data-src'], ctx.base) : '',
      marketplace: /\bmarket ?place\b|\bsold by\b|\bships from\b/i.test(text) && !(ctx.storeWord && new RegExp(`sold by ${ctx.storeWord}`, 'i').test(text)),
    });
  }
  return out;
}

/**
 * opts: { base (the search page's address), productPath (RegExp), skuFromPath (RegExp), storeName }
 */
export function parseGeneric(html, { base, productPath = null, skuFromPath = null, storeName = '' } = {}) {
  const problem = pageProblem(html);
  if (problem) return { products: [], problem };
  const doc = parseHTML(html);
  let host = '';
  try { host = new URL(base).hostname.replace(/^www\./, ''); } catch { /* no base */ }
  const skuFrom = (url) => {
    if (!skuFromPath) return '';
    try { const m = new URL(url).pathname.match(skuFromPath); return m ? m[1] : ''; } catch { return ''; }
  };
  const ctx = { base, productPath, skuFrom, storeName, host, codesOk: false, storeWord: String(storeName).split(/\s/)[0] };
  const found = [];
  const blobs = jsonBlobs(doc);
  for (const blob of blobs) walkJson(blob, found, ctx);
  found.push(...tiles(doc, ctx));
  if (!found.length) {
    // No product links anywhere: take named, priced entries with a product code (linked to a search for their name).
    ctx.codesOk = true;
    for (const blob of blobs) walkJson(blob, found, ctx);
  }
  // One entry per product: the first sighting, filled in from later ones.
  const map = new Map();
  for (const p of found) {
    const k = p.sku.toLowerCase();
    const prev = map.get(k);
    if (!prev) { map.set(k, { ...p }); continue; }
    for (const f of ['url', 'image', 'price']) if (!prev[f] && p[f]) prev[f] = p[f];
    if (prev.inStock === null && p.inStock !== null) prev.inStock = p.inStock;
    prev.marketplace = prev.marketplace || p.marketplace;
    prev.preorder = prev.preorder || p.preorder;
  }
  return { products: [...map.values()].slice(0, 300), problem: map.size ? null : 'empty' };
}

export const PARSERS = { woo: parseWoo, magento: parseMagento, citybeach: parseCityBeach, target: parseTarget, 'shopify-suggest': parseShopifySuggest, shopify: parseShopifyProducts, constructor: parseConstructor, amazon: parseAmazon, ebgames: parseEbGames, crystal: parseCrystal, pbandai: parsePBandai, generic: parseGeneric };

export function parseListing(parser, text, opts) {
  return (PARSERS[parser] || parseGeneric)(text, opts);
}

// ---------------------------------------------------------------------------
// Which products count (from MugiWatch): the keyword in the name, trading cards only, no marketplace sellers
// ---------------------------------------------------------------------------
export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Every word of the keyword appears in the name ("pokemon" matches "Pokémon"). */
export function mentions(title, keyword) {
  const t = ` ${norm(title).replace(/[^a-z0-9]+/g, ' ')} `;
  return norm(keyword).split(/[^a-z0-9]+/).filter(Boolean).every((w) => t.includes(` ${w}`));
}

export function termsRegex(terms) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const list = (terms || []).map((t) => norm(t).trim()).filter(Boolean);
  return list.length ? new RegExp(`\\b(${list.map(esc).join('|')})\\b`, 'i') : null;
}
