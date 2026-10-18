// The dummy store: fake shops for testing every retailer's flow end to end.
// Never touches a real store. Each shop copies the shape of that retailer's
// real site — its links, buttons and checkout steps — under its own path:
//
//   /kmart    Kmart-style: "Add to bag" → popup "Checkout" → one-page checkout
//             (details → delivery → payment) → "Checkout securely"
//   /bigw     BIG W-style: quantity dropdown → "Add to cart" → drawer "View cart"
//             → cart "Proceed to checkout" → guest → "Home delivery" → address
//             (lookup or manual) → card frame → "Place order"
//   /ebgames  EB Games-style: "Add to Cart" → mini-cart "Checkout" → "Continue
//             as Guest" → shipping → delivery → payment (+ terms) → "Place Order"
//   /jbhifi   Shopify-style (JB Hi-Fi): product JSON, cart page "Check out",
//             one-page checkout → "Pay now"; search suggestions
//   /trainertown  the same Shopify pages (Trainer Town), plus a collection per
//             game with its product list (what the live sweeps read there)
//   /gamerholic  the same Shopify pages (Gamerholic), with its newest-products list
//   /thegamescube  CrystalCommerce-style (The Games Cube): search tiles, an icon-only
//             cart button, the cart API, "Checkout as a guest" → address → shipping
//             and payment → "Place Order"
//   /pokemoncenter  Pokémon Center-style: a search page built once it's open (behind
//             an Imperva-style check that reloads it, when botCheck is on),
//             "Add to Cart" → "View Cart" → "Checkout" → guest → shipping → payment
//             (card frame) → "Place Order"
//   /pbandai  Premium Bandai-style: a Vue page (its Add button works once Vue has
//             wired it up), its search JSON (only with its region header),
//             "Go to Cart" → "Proceed to checkout" → the whole checkout in a
//             Global-e-style frame from another address
//   /target   Target-style: "Add to basket" → an "Often Bought Together" pop-up
//             offering clothes (closed with its ✕) → /checkout → its one-page
//             checkout at /spc/order: guest → home delivery → card → "Place order";
//             its search page's product data in __NEXT_DATA__ (the live sweeps)
//
// Placing an order: each shop's `decline` (the card is declined) and `threeDS` (the
// bank's "verify it's you" check, in a frame) options, for Auto-checkout's tests.
//
// Checkpoints and virtual queues (each shop's `checkpoint` and `queue`, off unless switched on):
//   checkpoint (the Shopify shops: JB Hi-Fi's): Shopify's bot check — /checkpoint is an hCaptcha
//     page, and checkout goes through it until someone solves it. Only a real click (a person's)
//     solves it: a click from a script is counted (botClicks) and does nothing.
//   queue (EB Games, Pokémon Center): a virtual queue — every page is "You're in the queue!" for a
//     visitor not let in yet (Pokémon Center's at /?queue). The page refreshes itself and lets you in
//     admitAfterMs after you joined; ask again sooner than tooSoonMs after your last request and you
//     lose your place (kicks counts it). A visitor with no cookies is always new to the line.
//
// Open the root (/) for the control panel: restock, sell out, list or unlist
// products and watch Mugibot react. A second server on another port serves
// the card boxes so they're cross-origin, like real payment providers.

import http from 'node:http';
import { DUMMY_PRODUCTS, dummyProductPath, slugify } from '../server/presets.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SHOPS = {
  kmart: { name: 'Kmart (dummy)', color: '#e2001a' },
  bigw: { name: 'BIG W (dummy)', color: '#0046be' },
  ebgames: { name: 'EB Games (dummy)', color: '#d22' },
  jbhifi: { name: 'JB Hi-Fi (dummy Shopify)', color: '#222' },
  trainertown: { name: 'Trainer Town (dummy Shopify)', color: '#1d4e89' },
  gamerholic: { name: 'Gamerholic (dummy Shopify)', color: '#6b21a8' },
  toysrus: { name: 'Toys"R"Us (dummy Shopify)', color: '#0b5394' },
  thegamescube: { name: 'The Games Cube (dummy CrystalCommerce)', color: '#0f766e' },
  pokemoncenter: { name: 'Pokémon Center (dummy)', color: '#d32f2f' },
  pbandai: { name: 'Premium Bandai (dummy)', color: '#1f2937' },
  target: { name: 'Target (dummy)', color: '#cc0000' },
  amazon: { name: 'Amazon AU (dummy)', color: '#232f3e' },
  citybeach: { name: 'City Beach (dummy)', color: '#111111' },
};
// The Shopify-style shops: the same product, cart and checkout pages.
const SHOPIFY = new Set(['jbhifi', 'trainertown', 'gamerholic', 'toysrus']);
const SHOP_RE = /^\/(kmart|bigw|ebgames|jbhifi|trainertown|gamerholic|toysrus|thegamescube|pokemoncenter|pbandai|target|amazon|citybeach)(\/.*|$)/;
const LD_AVAIL = { in_stock: 'InStock', preorder: 'PreOrder', out_of_stock: 'OutOfStock' };
// City Beach's marketing pop-up (Emarsys), over the product page a moment after it opens.
const CITYBEACH_POPUP = `<div id="wps_popup" class="wps-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:900;align-items:center;justify-content:center">
  <div class="wps-popup" role="dialog" style="background:#fff;padding:24px;max-width:420px"><button type="button" class="wps-close" aria-label="Close" onclick="document.getElementById('wps_popup').remove()">×</button>
  <h2>Get 10% off your first order</h2><p>Sign up to our newsletter for new arrivals and offers.</p><input type="email" name="wps_email" placeholder="Email address"> <button type="button">Subscribe</button></div></div>
<script>setTimeout(() => { const w = document.getElementById('wps_popup'); if (w) w.style.display = 'flex'; }, 800);</script>`;
const STATES = '<option value="">Select state</option><option value="NSW">New South Wales</option><option value="VIC">Victoria</option><option value="QLD">Queensland</option><option value="WA">Western Australia</option><option value="SA">South Australia</option><option value="TAS">Tasmania</option><option value="ACT">Australian Capital Territory</option><option value="NT">Northern Territory</option>';

export function defaultShops() {
  const out = {};
  for (const [id, list] of Object.entries(DUMMY_PRODUCTS)) {
    out[id] = {
      products: list.map((p, i) => ({ ...p, listed: p.listed !== false, maxQty: 0, qtyStyle: id === 'bigw' ? 'select' : 'input', lateMs: 0, id: 4400000 + i })),
      cart: [], orders: [], steps: [], data: {},
      // Like a real store on a fresh page: "Add" does nothing until the page's code has
      // started (hydrateMs after load), and the add itself can be slow (addDelayMs).
      hydrateMs: 0, addDelayMs: 0, refuseAdds: false,
      // quiet: the page shows nothing Mugibot can read after an add (no count on the bag link, no
      // "added" message) — only a busy button. refuseAdds: true, or how many adds to refuse first
      // (each says "Something went wrong" for a moment, like a store under load).
      quiet: false,
      // A React-style page (like Kmart's): its code wires up "Add" reactMs after the page
      // opens, long before a slow picture lets the page finish loading (slowLoadMs).
      // vueMs: the same for a Vue page (Premium Bandai's).
      reactMs: 0, slowLoadMs: 0, vueMs: id === 'pbandai' ? 600 : 0,
      // Search pages that only fill in their products once open (like Pokémon Center's and Premium Bandai's).
      clientSearch: id === 'pokemoncenter' || id === 'pbandai',
      // A bot check's page first, which reloads the page after a moment (Pokémon Center's search; the delay in ms).
      botCheck: false,
      // When the product page was last sent, and when the last add arrived.
      servedAt: 0, addedAt: 0,
      // Placing an order: the card is declined; or the bank's "verify it's you" check comes up first.
      decline: false, threeDS: false,
      // addNeedsLoad: the cart turns an add away (HTTP 403) until the product page has finished
      // loading and its own start-up is done, this many ms after (like Kmart for a signed-out visitor).
      addNeedsLoad: 0,
      // What the bag page showed each time it was opened (number of items in it).
      bagViews: [],
      // Its checkpoint (Shopify's hCaptcha page) and its virtual queue: see the top of this file.
      checkpoint: { on: false, shown: 0, solved: 0, botClicks: 0, passes: [] },
      // A notice across the top of its product pages ("Big launches use a virtual queue…").
      banner: '',
      // (log: every request while it's on — { id, at, path, what } — to show nothing asked again too soon.)
      queue: { on: false, admitAfterMs: 4000, refreshMs: 1500, tooSoonMs: 700, wait: 23, lateMs: 0, places: {}, admittedIds: [], kicks: 0, shown: 0, admitted: 0, cookieless: 0, log: [] },
    };
  }
  return out;
}

function page(shop, title, body, { head = '', bagCount = null } = {}) {
  const s = SHOPS[shop] || { name: 'Dummy store', color: '#444' };
  const base = shop ? `/${shop}` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px system-ui;margin:0;background:#fafafa;color:#222}header,footer{background:${s.color};color:#fff;padding:10px 20px}header a{color:#fff}main{max-width:900px;margin:20px auto;padding:0 20px}
button,.btn{background:${s.color};color:#fff;border:0;padding:10px 16px;border-radius:6px;font-size:15px;cursor:pointer;text-decoration:none;display:inline-block}
button[disabled]{background:#999;cursor:default}label{display:block;margin:8px 0}input,select{padding:6px;font-size:15px;width:320px;max-width:100%}
.drawer{position:fixed;right:0;top:0;bottom:0;width:320px;background:#fff;box-shadow:-4px 0 12px rgba(0,0,0,.2);padding:20px;display:none}.drawer.open{display:block}
.tile{display:inline-block;border:1px solid #ddd;padding:10px;margin:6px;width:200px;vertical-align:top}.err{color:#c00;font-weight:600}
.drawer.modal{left:8%;right:8%;top:8%;bottom:auto;width:auto;border-radius:8px}.obt-item{display:inline-block;width:22%;vertical-align:top;margin:4px}
.choice[aria-pressed=true]{outline:3px solid #0a0}.dummy{background:#fff3cd;padding:6px 20px;font-size:13px}</style>${head}</head>
<body><div class="dummy">⚠ Dummy store for testing Mugibot — nothing here is real. <a href="/">Control panel</a></div>
<header><a href="${base}/">${esc(s.name)}</a> · ${bagLink(shop, bagCount)} · <!--mgb-account--></header><main>${body}</main>
<footer>${esc(s.name)} is a fake store for testing.</footer></body></html>`;
}

// Signed in at the shop or not (state.signedIn[shop]), the way each kind of store shows it: Shopify's
// customer number in __st, CrystalCommerce's "not-logged-in" header, Premium Bandai's USER_DATA,
// and otherwise the header's "Sign in" link or "Hi, Ash" / "Sign out" (the store login monitor reads these).
function accountBits(shop, on) {
  if (SHOPIFY.has(shop)) return `<script>var __st={"a":1,"offset":36000,"p":"home","u":"dummy"${on ? ',"cid":4242' : ''}};</script><a href="/${shop}/account">${on ? 'Account' : 'Sign in'}</a>`;
  if (shop === 'thegamescube') return `<a href="/thegamescube/user/${on ? 'logout' : 'login'}" class="account ${on ? 'logged-in' : 'not-logged-in'}">${on ? 'Logout' : 'Login'}</a>`;
  if (shop === 'pbandai') return `<script>USER_DATA = {"loadTime":"now","csrfToken":"dummy"${on ? ',"loggedInMember":{"memberNo":"1"}' : ''}}</script><a href="/pbandai/login">${on ? 'My page' : 'Sign In'}</a>`;
  // Amazon's header: "Hello, sign in" / "Hello, Ash" (what its sign-in check reads).
  if (shop === 'amazon') return `<a id="nav-link-accountList" href="/amazon/gp/css/homepage.html"><span id="nav-link-accountList-nav-line-1" class="nav-line-1">Hello, ${on ? 'Ash' : 'sign in'}</span></a>`;
  return on ? `<span class="hi">Hi, Ash</span> <a href="/${shop}/logout">Sign out</a>` : `<a href="/${shop}/login">Sign in</a>`;
}

// The header's bag link, with the item count like real stores show it.
function bagLink(shop, count) {
  const word = shop === 'kmart' ? 'Bag' : 'Cart';
  const label = count == null ? word : `${word}, ${count} item${count === 1 ? '' : 's'}`;
  // CrystalCommerce: the cart is at /checkout/cart, its count in .cart-count (0 included).
  if (shop === 'thegamescube') return `<a href="/thegamescube/checkout/cart" id="bag-link" class="cart-details">Cart <span class="cart-count">${count || 0}</span></a>`;
  return `<a href="${shop ? `/${shop}` : ''}/cart" id="bag-link" aria-label="${label}">${word}${count ? ` <span class="bag-count">${count}</span>` : ''}</a>`;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
      } else resolve(Object.fromEntries(new URLSearchParams(data)));
    });
  });
}

/**
 * @param {{port?: number, cardPort?: number, host?: string, blockNonBrowsers?: boolean}} opts
 */
export async function startMockStore({ port = 0, cardPort = 0, host = '127.0.0.1', blockNonBrowsers = false } = {}) {
  const state = {
    shops: defaultShops(),
    // Simulate a store that refuses servers (like Kmart does): any request that isn't from a browser gets "Access Denied".
    blockNonBrowsers,
    // Kmart: a signed-in store account pre-fills the details step.
    account: null,
    // Kmart: card boxes in a payment-provider frame (Adyen-style) instead of on the page.
    // 'mystery': a frame whose boxes Mugibot can't recognise.
    // 'strict': one frame per box (like Adyen), ignoring anything that isn't real typing.
    // 'keys': one frame per box, taking key presses only.
    // 'never': one frame per box, taking nothing.
    // 'slow': like 'strict', each box taking a moment with what's typed (the boxes queue for the focus).
    cardInIframe: false,
    // Signed in at each shop (the store login monitor): shop → true.
    signedIn: {},
    // Shops answering 429 with Retry-After: shop → seconds.
    tooMany: {},
    requests: [],
  };
  let cardOrigin = '';

  const shopOf = (id) => state.shops[id];
  const find = (shop, sku) => shopOf(shop) && shopOf(shop).products.find((p) => p.sku === sku);
  const pathFor = (shop, p) => dummyProductPath(shop, p);
  // The token the product page last served sets once it has started up (addNeedsLoad).
  const S_TOKEN = (shop) => shopOf(shop).startToken || '';
  const total = (shop) => shopOf(shop).cart.reduce((s, c) => s + c.price * c.qty, 0);

  function addToCart(shop, sku, qty) {
    const p = find(shop, sku);
    if (!p || !p.listed || !(p.status === 'in_stock' || p.status === 'preorder')) return { ok: false };
    const max = Number(p.maxQty) || 10;
    const cart = shopOf(shop).cart;
    const line = cart.find((c) => c.sku === sku);
    if (line) line.qty = Math.min(max, line.qty + (Number(qty) || 1));
    else cart.push({ sku, qty: Math.min(max, Number(qty) || 1), price: p.price, name: p.name });
    return { ok: true, count: cart.length, items: cart.reduce((n, c) => n + c.qty, 0) };
  }
  const bagCount = (shop) => shopOf(shop).cart.reduce((n, c) => n + c.qty, 0);

  const imagePath = (shop, p) => `/img/${shop}/${encodeURIComponent(p.sku)}.svg`;
  const ldFor = (p, shop) => `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: p.sku, image: imagePath(shop, p),
    ...(LD_AVAIL[p.status] ? { offers: { '@type': 'Offer', price: p.price.toFixed(2), priceCurrency: 'AUD', availability: `https://schema.org/${LD_AVAIL[p.status]}` } } : {}),
  })}</script>`;

  function qtyControl(p) {
    if (p.qtyStyle === 'stepper') return '<div class="qty-stepper">Qty <button type="button" aria-label="Decrease quantity" id="qminus">−</button> <span id="qval">1</span> <button type="button" aria-label="Increase quantity" id="qplus">+</button></div>';
    if (p.qtyStyle === 'none') return '';
    const max = Number(p.maxQty) || 10;
    if (p.qtyStyle === 'select') return `<label>Quantity <select name="quantity" aria-label="Quantity" style="width:80px">${Array.from({ length: max }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select></label>`;
    return `<label>Qty <input name="quantity" type="number" value="1" min="1" ${p.maxQty ? `max="${p.maxQty}"` : ''} style="width:60px"></label>`;
  }

  const readQtyJs = `const inp = document.querySelector('[name=quantity]'); const qv = document.getElementById('qval'); const qty = inp ? Number(inp.value || 1) : Number(qv ? qv.textContent : 1);`;
  const stepperJs = (p) => `const qval = document.getElementById('qval');
    document.getElementById('qplus')?.addEventListener('click', () => { qval.textContent = String(Math.min(${Number(p.maxQty) || 5}, Number(qval.textContent) + 1)); });
    document.getElementById('qminus')?.addEventListener('click', () => { qval.textContent = String(Math.max(1, Number(qval.textContent) - 1)); });`;

  // -------------------------------------------------------------------- product pages
  function productPage(shop, p) {
    const others = shopOf(shop).products.filter((x) => x.sku !== p.sku && x.listed && !x.upsell);
    const upsellItems = shopOf(shop).products.filter((x) => x.upsell && x.sku !== p.sku);
    const other = others[0];
    const labels = {
      kmart: { in_stock: 'Add to bag', preorder: 'Pre-order', out_of_stock: 'Sold out online', coming_soon: 'Coming soon' },
      bigw: { in_stock: 'Add to cart', preorder: 'Pre-order', out_of_stock: 'Out of stock online', coming_soon: 'Coming soon' },
      ebgames: { in_stock: 'Add to Cart', preorder: 'Pre-order Now', out_of_stock: 'Sold Out', coming_soon: 'Coming Soon' },
      jbhifi: { in_stock: 'Add to cart', preorder: 'Pre-order', out_of_stock: 'Sold out', coming_soon: 'Coming soon' },
      pokemoncenter: { in_stock: 'Add to Cart', preorder: 'Pre-order', out_of_stock: 'Sold Out', coming_soon: 'Coming Soon' },
      pbandai: { in_stock: 'Add to Cart', preorder: 'PLACE PRE-ORDER', out_of_stock: 'Sold Out', coming_soon: 'Coming Soon' },
      target: { in_stock: 'Add to basket', preorder: 'Pre-order', out_of_stock: 'Out of stock online', coming_soon: 'Coming soon' },
      amazon: { in_stock: 'Add to Cart', preorder: 'Pre-order now', out_of_stock: 'Currently unavailable', coming_soon: 'Currently unavailable' },
      citybeach: { in_stock: 'Add To Bag', preorder: 'Pre-order', out_of_stock: 'Out of stock', coming_soon: 'Coming soon' },
      thegamescube: {},
    }[SHOPIFY.has(shop) ? 'jbhifi' : shop];
    const orderable = p.status === 'in_stock' || p.status === 'preorder';
    if (SHOPIFY.has(shop)) {
      return page(shop, `${p.name} | ${SHOPS[shop].name}`, `${shopOf(shop).banner ? `<div class="site-banner" role="note">${esc(shopOf(shop).banner)}</div>` : ''}<div class="product-detail"><h1>${esc(p.name)}</h1><div class="price">$${p.price.toFixed(2)}</div>
        <form action="/${shop}/cart/add" method="get"><input type="hidden" name="id" value="${p.id}">${qtyControl(p)}
        <button type="submit" name="add" ${orderable ? '' : 'disabled'}>${labels[p.status]}</button></form></div>`, { head: ldFor(p, shop) });
    }
    if (shop === 'thegamescube') return crystalProductPage(p);
    const button = orderable ? `<button type="button" id="atc" class="add-to-cart">${labels[p.status]}</button>` : `<button type="button" class="add-to-cart" disabled>${labels[p.status]}</button>`;
    const drawer = {
      kmart: '<div class="drawer" id="drawer" role="dialog" aria-label="Added to bag"><h3>Added to bag</h3><p id="drawer-msg"></p><a class="btn" href="/kmart/checkout">Checkout</a> <a href="/kmart/cart">View bag</a></div>',
      bigw: '<div class="drawer added-to-cart-drawer" id="drawer" role="dialog" aria-label="Added to cart"><h3>Added to your cart</h3><p id="drawer-msg"></p><a class="btn" href="/bigw/cart">View cart</a> <a href="/bigw/">Continue shopping</a></div>',
      ebgames: '<div class="drawer mini-cart" id="drawer"><h3>Added to cart</h3><p id="drawer-msg"></p><a class="btn" href="/ebgames/checkout">Checkout</a> <a href="/ebgames/cart">View cart</a></div>',
      pokemoncenter: '<div class="drawer mini-cart" id="drawer" role="dialog" aria-label="Added to cart"><h3>Added to cart</h3><p id="drawer-msg"></p><a class="btn" href="/pokemoncenter/cart">View Cart</a> <a href="/pokemoncenter/">Continue Shopping</a></div>',
      pbandai: '<div class="drawer" id="drawer" role="dialog" aria-label="Added to cart"><h3>Item added to your cart</h3><p id="drawer-msg"></p><a class="btn" href="/pbandai/cart">View Cart</a> <a href="/pbandai/">Continue Shopping</a></div>',
      amazon: '<div class="drawer" id="drawer" role="dialog" aria-label="Added to Cart"><h3>Added to Cart</h3><p id="drawer-msg"></p><a href="/amazon/cart">Go to Cart</a></div>',
      // City Beach: the mini bag that opens after "Add To Bag" (its words: "Close", "View Your Bag").
      citybeach: '<div class="drawer minicart-flyout" id="drawer"><button type="button" aria-label="Close" onclick="this.parentNode.classList.remove(\'open\')">Close</button><p id="drawer-msg"></p><a class="btn" href="/citybeach/cart">View Your Bag</a></div>',
      // Target: "Often Bought Together" — four more things to add, and a ✕ to close it.
      target: `<div class="drawer modal upsell-modal" id="drawer" role="dialog" aria-modal="true" aria-labelledby="obt-title">
        <button type="button" class="modal-close" aria-label="Close" id="obt-close" style="float:right;background:none;color:#000;font-size:22px">✕</button>
        <h2 id="obt-title">Often Bought Together</h2><p id="drawer-msg" hidden></p>
        <div class="obt-items">${upsellItems.map((x) => `<div class="obt-item"><img src="${imagePath(shop, x)}" alt="" width="120"><div>${esc(x.name)}</div><b>$${x.price}</b>
          <select aria-label="Colour"><option>Black</option></select> <select aria-label="Size"><option value="">Select Size</option><option>10</option></select></div>`).join('')}</div>
        <p>Total Price: $${upsellItems.reduce((t, x) => t + x.price, 0)}</p>
        <button type="button" id="obt-add">Add ${upsellItems.length} Items To Basket</button>
      </div>`,
    }[shop];
    return page(shop, `${p.name} | ${SHOPS[shop].name}`, `${shopOf(shop).banner ? `<div class="site-banner" role="note">${esc(shopOf(shop).banner)}</div>` : ''}
      <div class="product-detail">
        <h1>${esc(p.name)}</h1>
        <div class="price">$${p.price.toFixed(2)}</div>
        <p>${shop === 'kmart' ? 'Keycode' : 'Product code'} ${p.sku}</p>
        ${qtyControl(p)}
        <div id="buybox">${p.lateMs ? '<p>Loading…</p>' : button}</div>
        ${shop === 'amazon' && orderable ? `<form id="buy-now-form" method="post" action="/amazon/checkout/entry/buynow"><input type="hidden" name="asin" value="${esc(p.sku)}">
          <span class="a-button a-button-oneclick"><input id="buy-now-button" name="submit.buy-now" type="submit" class="a-button-input" aria-labelledby="submit.buy-now-announce" style="width:120px;height:30px"><span id="submit.buy-now-announce" class="a-button-text" aria-hidden="true">Buy Now</span></span></form>
          ${shopOf(shop).turbo ? `<div id="turbo-checkout-panel-container" class="a-popover" role="dialog" hidden><iframe id="turbo-checkout-iframe" width="420" height="320" title="Buy now" style="border:1px solid #ccc"></iframe></div>
          <script>document.getElementById('buy-now-form').addEventListener('submit', (e) => {
            e.preventDefault(); // Amazon's quick checkout: a window over the page instead of a new page
            const box = document.getElementById('turbo-checkout-panel-container');
            box.querySelector('iframe').src = '/amazon/checkout/turbo?asin=${encodeURIComponent(p.sku)}';
            box.hidden = false;
          });</script>` : ''}` : ''}
        ${shopOf(shop).slowLoadMs ? `<img src="/slow.gif?ms=${Number(shopOf(shop).slowLoadMs)}" alt="" width="1" height="1">` : ''}
      </div>
      <section class="recommendations"><h3>You may also like</h3>
        ${other ? `<div class="tile"><a href="${pathFor(shop, other)}">${esc(other.name)}</a><button type="button" class="add-to-cart">${labels.in_stock}</button></div>` : ''}
      </section>
      ${drawer}
      ${shop === 'citybeach' && !shopOf(shop).noPopup ? CITYBEACH_POPUP : ''}
      <script>
        ${p.lateMs ? `setTimeout(() => { document.getElementById('buybox').innerHTML = ${JSON.stringify(button)}; }, ${Number(p.lateMs)});` : ''}
        ${shopOf(shop).addNeedsLoad ? `addEventListener('load', () => setTimeout(() => { document.cookie = 'mgb_started=${S_TOKEN(shop)}; path=/'; }, ${Number(shopOf(shop).addNeedsLoad)}));` : ''}
        ${stepperJs(p)}
        // Until the page's code has started, pressing Add does nothing (like a store that's still loading).
        let started = ${shopOf(shop).hydrateMs || shopOf(shop).reactMs || shopOf(shop).vueMs ? 'false' : 'true'};
        ${shopOf(shop).hydrateMs ? `addEventListener('load', () => setTimeout(() => { started = true; }, ${Number(shopOf(shop).hydrateMs)}));` : ''}
        ${shopOf(shop).reactMs ? `window.__NEXT_DATA__ = {};
        setTimeout(() => {
          started = true;
          const atc = document.getElementById('atc'); // what React leaves on a button it has taken over
          if (atc) { atc.__reactFiber$mock = {}; atc.__reactProps$mock = { onClick() {} }; }
        }, ${Number(shopOf(shop).reactMs)});` : ''}
        ${shopOf(shop).vueMs ? `document.body.setAttribute('data-v-app', '');
        setTimeout(() => {
          started = true;
          const atc = document.getElementById('atc'); // what Vue leaves on an element it has wired up
          if (atc) atc._vei = { onClick() {} };
        }, ${Number(shopOf(shop).vueMs)});` : ''}
        // Target's pop-up: ✕ closes it; "Add 4 Items To Basket" adds them all (what ⚡ Buy must never press).
        document.getElementById('obt-close')?.addEventListener('click', () => { document.getElementById('drawer').classList.remove('open'); window.__afterUpsell?.(); });
        document.getElementById('obt-add')?.addEventListener('click', async () => {
          for (const sku of ${JSON.stringify(upsellItems.map((x) => x.sku))}) await fetch('/${shop}/api/cart/add', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({sku, qty: 1})});
          document.getElementById('drawer').classList.remove('open');
          window.__afterUpsell?.();
        });
        document.addEventListener('click', async (e) => {
          if (!e.target.closest('#atc') || !started) return;
          ${readQtyJs}
          const btn = document.getElementById('atc');
          btn.classList.add('busy');
          const r = await fetch('/${shop}/api/cart/add', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({sku:'${p.sku}', qty})});
          const d = await r.json();
          btn.classList.remove('busy');
          if (!d.ok) {
            if (d.said) {
              const t = document.createElement('div');
              t.className = 'toast'; t.setAttribute('role', 'alert'); t.textContent = d.said;
              document.querySelector('main').append(t);
              setTimeout(() => t.remove(), 2500);
            }
            return;
          }
          if (${shopOf(shop).quiet ? 'true' : 'false'}) return; // (a store whose page shows nothing Mugibot can read)
          const showBag = () => {
            const bag = document.getElementById('bag-link');
            bag.setAttribute('aria-label', '${shop === 'kmart' ? 'Bag' : 'Cart'}, ' + d.items + ' items');
            bag.innerHTML = '${shop === 'kmart' ? 'Bag' : 'Cart'} <span class="bag-count">' + d.items + '</span>';
          };
          ${shop === 'target'
    // Target: the "Often Bought Together" pop-up straight away, over the page; the basket shows the item once it's closed.
    ? "window.__afterUpsell = showBag; document.getElementById('drawer').classList.add('open');"
    : "showBag(); setTimeout(() => { document.getElementById('drawer-msg').textContent = d.count + ' item(s) in your " + (shop === 'kmart' ? 'bag' : 'cart') + "'; document.getElementById('drawer').classList.add('open'); }, 150);"}
        });
      </script>`, { head: ldFor(p, shop), bagCount: shopOf(shop).quiet ? null : bagCount(shop) });
  }

  // CrystalCommerce (The Games Cube): each option in stock has its own small cart button — an icon, no words.
  function crystalForm(p) {
    return `<form class="add-to-cart-form" data-vid="${p.id}" data-name="${esc(p.name)}" data-id="${p.sku}" data-price="AUD$ ${p.price.toFixed(2)}" data-category="Cards" data-variant="Sealed">
      <div class="product-price-qty"><span class="regular price">AUD$ ${p.price.toFixed(2)}</span></div>
      <div class="qty-submit"><input class="qty" max="3" name="qty" size="1" type="number" value="1"><input class="utility-button add-to-cart" name="commit" type="submit" value="&#xf217;" style="width:44px;font-family:monospace"></div></form>`;
  }
  function crystalProductPage(p) {
    const orderable = p.status === 'in_stock' || p.status === 'preorder';
    return page('thegamescube', `${p.name} | The Games Cube`, `<article class="product-container single">
      <h1 class="title" itemprop="name">${esc(p.name)}</h1>
      <h4 class="stock-indicator ${orderable ? 'in-stock' : 'no-stock'}">${orderable ? 'In Stock' : 'Out of Stock'}</h4>
      <div class="info-box"><h4 class="heading">Buy This Product</h4><div class="variant-row row">
        <span class="variant-short-info">Sealed, <em>${orderable ? '3 in-stock' : 'Out of stock.'}</em></span>
        ${orderable ? crystalForm(p) : `<span class="regular price">AUD$ ${p.price.toFixed(2)}</span> <a href="#" class="utility-button add-to-wishlist">Wishlist</a>`}
      </div></div></article>
      <div class="alert-box" id="cart-alert" role="alert" style="display:none"></div>
      <script>
        document.addEventListener('submit', async (e) => {
          const f = e.target.closest('.add-to-cart-form');
          if (!f) return;
          e.preventDefault();
          const r = await fetch('/thegamescube/api/v1/cart/line_items', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ line_items: [{ variant_id: Number(f.dataset.vid), qty: Number(f.querySelector('[name=qty]').value) }] }) });
          const d = await r.json();
          if (!d.line_items || !d.line_items.length) return;
          document.querySelector('.cart-count').textContent = String(d.count);
          const a = document.getElementById('cart-alert');
          a.textContent = d.line_items[0].name + ' has been added to your cart';
          a.style.display = 'block';
        });
      </script>`, { bagCount: bagCount('thegamescube') });
  }
  function crystalSearchPage(q) {
    const hits = searchHits('thegamescube', q);
    return page('thegamescube', 'Search results', `<div class="products-container browse"><ul class="products">${hits.map((x) => {
      const orderable = x.status === 'in_stock' || x.status === 'preorder';
      return `<li class="product" itemscope itemtype="http://schema.org/Product"><div class="inner"><div class="image"><a href="${pathFor('thegamescube', x)}" itemprop="url" title="${esc(x.name)}"><img src="${imagePath('thegamescube', x)}" alt="${esc(x.name)}" itemprop="image"></a></div>
        <div class="meta"><a href="${pathFor('thegamescube', x)}" itemprop="url"><h4 class="name" itemprop="name" title="${esc(x.name)}">${esc(x.name)}</h4></a>
        <div class="variant-row ${orderable ? 'in-stock' : 'no-stock'}"><span class="variant-short-info variant-qty">${orderable ? '3 In Stock' : 'Out of stock.'}</span>
        ${orderable ? crystalForm(x) : `<span class="price no-stock hide" itemprop="price">AUD$ ${x.price.toFixed(2)}</span>`}</div></div></div></li>`;
    }).join('')}</ul></div>`);
  }

  const searchHits = (shop, q) => {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    return shopOf(shop).products.filter((x) => x.listed && words.some((w) => slugify(x.name).includes(slugify(w)) || x.sku === w));
  };
  // Search results the way stores show them: a tile per product, with its price and an add / sold out button.
  function searchPage(shop, q) {
    const hits = searchHits(shop, q);
    const button = (x) => (x.status === 'in_stock' ? '<button type="button" class="add-to-cart">Add to cart</button>'
      : x.status === 'preorder' ? '<button type="button" class="add-to-cart">Pre-order</button>'
        : `<button type="button" disabled>${x.status === 'coming_soon' ? 'Coming soon' : 'Out of stock'}</button>`);
    return page(shop, `Search: ${q}`, `<h1>Results for "${esc(q)}"</h1>${hits.map((x) => `<div class="tile product-tile"><a href="${pathFor(shop, x)}"><img src="${imagePath(shop, x)}" alt="">${esc(x.name)}</a><div class="price">$${x.price.toFixed(2)}</div>${button(x)}</div>`).join('') || '<p>No results</p>'}`);
  }

  // Target's search page: its product data in __NEXT_DATA__, newest first; sold-out products left out (like the real one).
  function targetSearchPage(q) {
    const hits = searchHits('target', q).filter((x) => !x.upsell && (x.status === 'in_stock' || x.status === 'preorder'));
    const data = { props: { pageProps: { metadata: { productList: { totalNumProducts: hits.length, products: hits.map((x) => ({
      id: `P${x.sku}`, title: x.name, baseProductUrl: pathFor('target', x), imageUrl: imagePath('target', x), price: { offerPrice: x.price },
      variations: [{ colourVariantCode: x.sku, url: pathFor('target', x), inStock: true, productDisplayType: x.status === 'preorder' ? 'PRE_ORDER' : 'IN_STOCK' }],
    })) } } } } };
    return page('target', `Search: ${q}`, `<h1>Results for "${esc(q)}"</h1><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`);
  }

  // City Beach's search page (Salesforce Commerce Cloud): a tile per product with its code
  // (data-pid) and its name, brand and price in data-gtmdata — the brand left out of the name, like
  // the real one ("Ninja Spinner Booster Pack Trading Cards", brand "Pokémon"). No stock in the tiles.
  function citybeachSearchPage(q) {
    const hits = searchHits('citybeach', q);
    const tile = (x) => {
      const brand = /^Pokémon /.test(x.name) ? 'Pokémon' : '';
      const gtm = { name: brand ? x.name.slice(brand.length + 1) : x.name, id: x.sku, brand, price: x.price.toFixed(2), category: 'Skate' };
      return `<div class="col-6 col-sm-4"><div class="product" data-pid="${x.sku}" data-gtmdata="${esc(JSON.stringify(gtm))}"><div class="product-tile">
        <div class="image-container"><a href="${pathFor('citybeach', x)}"><img class="tile-image lazyload" data-src="${imagePath('citybeach', x)}" alt="${esc(x.name)}"></a></div>
        <div class="tile-body"><div class="pdp-link"><a class="link" href="${pathFor('citybeach', x)}">${esc(gtm.name)}</a></div>
        <div class="price"><span class="sales"><span class="value" content="${x.price.toFixed(2)}">$${x.price.toFixed(2)}</span></span></div></div></div></div></div>`;
    };
    return page('citybeach', `Search: ${q}`, hits.length
      ? `<h1>Search results for "${esc(q)}"</h1><div class="row product-grid">${hits.map(tile).join('')}</div>`
      : `<div class="no-results"><p>Sorry, your search "${esc(q)}" did not return any results.</p></div>`);
  }

  // A search page whose products are only filled in by its own code once it's open (BIG W's real one).
  function clientSearchPage(shop, q) {
    return page(shop, `Search: ${q}`, `<h1>Results for "${esc(q)}"</h1><div id="results"><p>Loading…</p></div>
      <script>
        setTimeout(async () => {
          const d = await (await fetch('/${shop}/api/search?q=' + encodeURIComponent(${JSON.stringify(q)}))).json();
          if (${JSON.stringify(shopOf(shop).clientSearch === 'data')}) return; // downloaded, not drawn yet (like a page in a hidden window)
          document.getElementById('results').innerHTML = d.products.map((x) => '<article class="product-card"><a href="' + x.url + '"><img src="' + x.image + '" alt="">' + x.name.replace(/</g, '&lt;') + '</a>'
            + '<div class="price">$' + x.price.toFixed(2) + '</div>' + (x.status === 'in_stock' ? '<button type="button">Add to cart</button>' : '<button type="button" disabled>Out of stock</button>') + '</article>').join('') || '<p>No results</p>';
        }, 400);
      </script>`);
  }

  function cartPage(shop) {
    const cart = shopOf(shop).cart;
    const rows = cart.map((c) => {
      const p = find(shop, c.sku);
      const max = Number(p && p.maxQty) || 10;
      const opts = Array.from({ length: max }, (_, i) => `<option value="${i + 1}" ${i + 1 === c.qty ? 'selected' : ''}>${i + 1}</option>`).join('');
      const qty = SHOPIFY.has(shop) ? `<input type="number" name="updates[]" aria-label="Quantity" data-sku="${c.sku}" value="${c.qty}" min="1" style="width:60px">` : `<select aria-label="Quantity" data-sku="${c.sku}">${opts}</select>`;
      return `<li class="line-item"><div class="line-name"><a href="${p ? pathFor(shop, p) : '#'}">${esc(c.name)}</a></div><div class="line-qty">Qty ${qty}</div></li>`;
    }).join('');
    const go = {
      kmart: '<a class="btn" href="/kmart/checkout">Checkout</a>', bigw: '<button type="button" id="to-checkout">Proceed to checkout</button>', ebgames: '<a class="btn" href="/ebgames/checkout">Secure Checkout</a>', jbhifi: '<button type="button" id="to-checkout" name="checkout">Check out</button>',
      thegamescube: '<a class="utility-button checkout" href="/thegamescube/checkout/proceed_to_checkout">Checkout &rarr;</a>', pokemoncenter: '<a class="btn" href="/pokemoncenter/checkout">Checkout</a>', pbandai: '<a class="btn" href="/pbandai/checkout">Proceed to Checkout</a>',
      target: '<a class="btn" href="/target/checkout">Checkout</a>', citybeach: '<a class="btn checkout-btn" href="/citybeach/checkout">Checkout</a>',
    }[SHOPIFY.has(shop) ? 'jbhifi' : shop];
    return page(shop, shop === 'kmart' ? 'Your bag' : 'Your cart', `<h1>${shop === 'kmart' ? 'Your bag' : 'Your cart'}</h1><ul class="lines">${rows || `<li>Your ${shop === 'kmart' ? 'bag' : 'cart'} is empty</li>`}</ul><a href="/${shop}/" class="continue">Continue shopping</a> ${cart.length ? go : ''}
      <script>
        for (const s of document.querySelectorAll('[data-sku]')) s.addEventListener('change', () => fetch('/${shop}/api/cart/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: s.dataset.sku, qty: Number(s.value) }) }));
        document.getElementById('to-checkout')?.addEventListener('click', () => { location.href = '${SHOPIFY.has(shop) ? `/${shop}/checkouts/c/abc123` : `/${shop}/checkout`}'; });
      </script>`);
  }

  // -------------------------------------------------------------------- checkouts
  function cardBoxes(style) {
    return `<iframe id="card" src="${cardOrigin}/card-frame?style=${style}" width="360" height="190" style="border:1px solid #ccc"></iframe>`;
  }

  // Like Adyen's secured fields: one frame per box, each ignoring anything that isn't real typing.
  // mode 'keys': boxes that build their value from key presses only (like masked-input widgets).
  function strictCardBoxes(mode) {
    const box = (field, label) => `<label>${label}<br><iframe class="sf" data-field="${field}" src="${cardOrigin}/card-frame?style=strict&mode=${mode}&field=${field}" width="300" height="44" style="border:1px solid #ccc"></iframe></label>`;
    return `<p><b>Pay with credit or debit card</b></p>${box('number', 'Card number')}${box('expiry', 'Expiry (MM/YY)')}${box('cvc', 'CVV')}
      <script>addEventListener('message', (e) => { if (e.data && e.data.adyenNext) document.querySelector('iframe.sf[data-field=' + e.data.adyenNext + ']')?.focus(); });</script>`;
  }


  // After the final button: the order confirmed — or the card declined, or the bank's "verify it's you" check (in a frame).
  const placeJs = (shop, errId) => `async (body) => {
    const r = await fetch('/${shop}/checkout/place', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (d.error) { const e = document.getElementById('${errId}'); e.textContent = d.error; e.setAttribute('role', 'alert'); return; }
    if (d.challenge) { document.querySelector('main').insertAdjacentHTML('beforeend', '<section id="threeds"><h2>Verify it\\'s you</h2><p>Your bank needs to confirm this payment.</p><iframe src="' + d.challenge + '" width="400" height="300"></iframe></section>'); return; }
    location.href = '/${shop}/checkout/confirmation';
  }`;

  function kmartCheckout() {
    const acc = state.account || {};
    const v = (x) => esc(x || '');
    const cardFields = ['strict', 'keys', 'never', 'slow'].includes(state.cardInIframe) ? strictCardBoxes(state.cardInIframe) : state.cardInIframe ? cardBoxes(state.cardInIframe === 'mystery' ? 'mystery' : 'kmart')
      : `<p><b>Pay with credit or debit card</b></p>
         <label>Card number <input name="cardNumber" inputmode="numeric"></label>
         <label>Expiry <input name="cardExpiry" placeholder="MM/YY"></label>
         <label>CVV <input name="cardCvv" inputmode="numeric"></label>`;
    return `<h1>Checkout</h1>
      <section id="k-summary"><h2>Order Summary</h2><p>Products $${total('kmart').toFixed(2)}</p><p>Total Delivery to Cheltenham 3192 $10.00</p>
        <div class="carousel"><div class="tile">Bubble Round Platter <button type="button">+ Add</button></div></div>
        <button type="button" id="k-to-details">Continue to details</button></section>
      <section id="k-details" hidden><h2>② Details</h2>
        <p>Welcome. Your saved details (if available) will be put into the checkout.</p>
        <label>Email* <input name="email" type="email" required value="${v(acc.email)}"></label>
        <label>First Name* <input name="firstName" required value="${v(acc.firstName)}"></label>
        <label>Last Name* <input name="lastName" required value="${v(acc.lastName)}"></label>
        <label>Mobile number* <input name="mobile" type="tel" required value="${v(acc.phone)}"></label>
        <label><input type="checkbox" name="kmail"> Signup to Kmail</label>
        <label><input type="checkbox" name="review"> Review purchased products</label>
        <button type="button" id="k-to-delivery">Continue to delivery</button></section>
      <section id="k-delivery" hidden><h2>③ Delivery</h2>
        <label><input type="radio" name="method" value="cc"> Click &amp; Collect</label>
        <label><input type="radio" name="method" value="home"> Home delivery</label>
        <label>Street address* <input name="address1" required></label>
        <label>Apartment, unit, etc. (optional) <input name="address2"></label>
        <label>Suburb* <input name="suburb" required></label>
        <label>State* <select name="state" required>${STATES}</select></label>
        <label>Postcode* <input name="postcode" required maxlength="4"></label>
        <button type="button" id="k-to-payment">Continue to payment</button></section>
      <section id="k-payment" hidden><h2>④ Payment</h2><p>Select a payment method</p>
        <p class="order-total"><b>Total $${(total('kmart') + 10).toFixed(2)}</b></p>
        <label><input type="radio" name="pay" value="card" checked> Credit or debit card</label>
        <label><input type="radio" name="pay" value="paypal"> PayPal</label>
        <label><input type="radio" name="pay" value="afterpay"> afterpay</label>
        <label><input type="radio" name="pay" value="zip"> zip</label>
        ${cardFields}
        <p><button type="button" id="k-place">Checkout securely</button></p></section>
      <p id="k-error" class="err"></p>
      <script>
        const data = (sec) => Object.fromEntries([...sec.querySelectorAll('input,select')].map((i) => [i.name, i.type === 'checkbox' || i.type === 'radio' ? (i.checked ? (i.value || true) : undefined) : i.value]).filter(([, x]) => x !== undefined));
        const step = (name, sec, next) => {
          const missing = [...sec.querySelectorAll('[required]')].filter((i) => !i.value);
          if (name === 'delivery' && !sec.querySelector('input[name=method]:checked')) missing.push({ name: 'method' });
          if (missing.length) { document.getElementById('k-error').textContent = 'Please complete: ' + missing.map((m) => m.name).join(', '); return; }
          document.getElementById('k-error').textContent = '';
          fetch('/kmart/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: name, data: data(sec) }) });
          sec.querySelector('button[id^=k-to]').remove();
          setTimeout(() => { next.hidden = false; }, 300);
        };
        const $ = (id) => document.getElementById(id);
        $('k-to-details').addEventListener('click', () => step('summary', $('k-summary'), $('k-details')));
        $('k-to-delivery').addEventListener('click', () => step('details', $('k-details'), $('k-delivery')));
        $('k-to-payment').addEventListener('click', () => step('delivery', $('k-delivery'), $('k-payment')));
        const place = ${placeJs('kmart', 'k-error')};
        $('k-place').addEventListener('click', () => place(data($('k-payment'))));
        for (const el of document.querySelectorAll('input[name=cardNumber]')) el.addEventListener('input', () => { el.value = el.value.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 '); });
        for (const el of document.querySelectorAll('input[name=cardExpiry]')) el.addEventListener('input', () => { const d = el.value.replace(/\\D/g, '').slice(0, 4); el.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; });
      </script>`;
  }

  // City Beach's one-page checkout (Salesforce Commerce Cloud), in stages like the real one:
  // ?stage=customer (email → "Continue as guest") → shipping ("Delivery" tab, "Delivery to my
  // address", name, mobile, address → "Submit shipping") → payment (card boxes in a payment
  // provider's frame, the total) → "Confirm & pay".
  function citybeachCheckout() {
    const sum = total('citybeach');
    const ship = 9.95;
    const f = (n) => `dwfrm_shipping_shippingAddress_addressFields_${n}`;
    return `<h1>Checkout</h1>
      <section id="cb-customer" class="customer-section"><h2>Customer</h2>
        <label for="email-guest">Email</label> <input id="email-guest" name="dwfrm_coCustomer_email" type="email" autocomplete="email" required>
        <p><button type="button" class="btn submit-customer" id="cb-guest">Continue as guest</button> <a href="/citybeach/login">Login</a></p></section>
      <section id="cb-shipping" class="shipping-section" hidden><h2>Shipping</h2>
        <div class="nav nav-tabs" role="tablist"><a class="nav-link" role="tab" href="#home-delivery" id="cb-tab-home">Delivery</a> <a class="nav-link" role="tab" href="#click-collect" id="cb-tab-cc">Click &amp; Collect</a></div>
        <div id="cb-home" hidden>
          <label><input type="radio" name="deliveryType" value="home"> Delivery to my address</label>
          <label><input type="radio" name="deliveryType" value="po"> Delivery to a PO box</label>
          <label>First name <input name="${f('firstName')}" autocomplete="given-name" required></label>
          <label>Last name <input name="${f('lastName')}" autocomplete="family-name" required></label>
          <label>Mobile <input name="${f('phone')}" type="tel" autocomplete="tel" required></label>
          <label>Address line 1 <input name="${f('address1')}" autocomplete="address-line1" required></label>
          <label>Address line 2 (optional) <input name="${f('address2')}" autocomplete="address-line2"></label>
          <label>Suburb <input name="${f('city')}" autocomplete="address-level2" required></label>
          <label>State <select name="${f('states_stateCode')}" autocomplete="address-level1" required>${STATES}</select></label>
          <label>Postcode <input name="${f('postalCode')}" autocomplete="postal-code" required maxlength="4"></label>
        </div>
        <button type="button" class="btn submit-shipping" id="cb-ship" name="submit-shipping" value="submit-shipping">Submit shipping</button></section>
      <section id="cb-payment" class="payment-section" hidden><h2>Payment</h2>
        <p><b>Credit / debit card</b></p>${cardBoxes('stripe')}
        <div class="order-totals"><p>Subtotal A$${sum.toFixed(2)}</p><p>Shipping A$${ship.toFixed(2)}</p>
          <p class="order-total">Total <span class="grand-total-sum">A$${(sum + ship).toFixed(2)}</span></p></div>
        <button type="button" class="btn submit-payment" id="cb-pay" name="submit-payment" value="submit-payment">Confirm &amp; pay</button></section>
      <section id="cb-review" hidden><h2>Review your order</h2><p>Total A$${(sum + ship).toFixed(2)}</p>
        <button type="button" class="btn place-order" id="cb-place" name="submit" value="place-order">Confirm &amp; pay</button></section>
      <p id="cb-error" class="err"></p>
      <script>
        const $ = (id) => document.getElementById(id);
        const data = (sec) => Object.fromEntries([...sec.querySelectorAll('input,select')].map((i) => [i.name, i.type === 'radio' ? (i.checked ? i.value : undefined) : i.value]).filter(([, x]) => x !== undefined));
        const stage = (name, show) => { history.replaceState(null, '', '/citybeach/checkout?stage=' + name + '#' + name); show.hidden = false; };
        const missing = (sec) => [...sec.querySelectorAll('[required]')].filter((i) => !i.hidden && i.offsetParent !== null && !i.value).map((i) => i.name);
        const err = (t) => { $('cb-error').textContent = t; };
        $('cb-guest').addEventListener('click', () => {
          if (!/@/.test($('email-guest').value)) return err('Please enter a valid email address');
          err('');
          fetch('/citybeach/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'customer', data: data($('cb-customer')) }) });
          $('cb-guest').remove();
          setTimeout(() => stage('shipping', $('cb-shipping')), 300);
        });
        $('cb-tab-home').addEventListener('click', (e) => { e.preventDefault(); $('cb-tab-home').classList.add('active'); $('cb-tab-home').setAttribute('aria-selected', 'true'); $('cb-home').hidden = false; });
        $('cb-tab-cc').addEventListener('click', (e) => { e.preventDefault(); err('Choose a store to collect from'); });
        $('cb-ship').addEventListener('click', () => {
          if ($('cb-home').hidden) return err('Choose Delivery or Click & Collect');
          if (!document.querySelector('input[name=deliveryType]:checked')) return err('Please select a delivery option');
          const m = missing($('cb-shipping'));
          if (m.length) return err('Please complete: ' + m.join(', '));
          err('');
          fetch('/citybeach/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'shipping', data: data($('cb-shipping')) }) });
          $('cb-ship').remove();
          setTimeout(() => stage('payment', $('cb-payment')), 400);
        });
        const place = ${placeJs('citybeach', 'cb-error')};
        // reviewStage: like Salesforce's own checkout, the payment button opens a last "place order" stage with its own button.
        $('cb-pay').addEventListener('click', () => {
          if (!${shopOf('citybeach').reviewStage ? 'true' : 'false'}) return place(data($('cb-payment')));
          fetch('/citybeach/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'payment', data: {} }) });
          $('cb-payment').hidden = true;
          setTimeout(() => stage('placeOrder', $('cb-review')), 500);
        });
        $('cb-place').addEventListener('click', () => place({}));
      </script>`;
  }

  // EB Games' checkout, as the real one goes: your details → Delivery, with Click & Collect chosen for
  // you → "Home Delivery" → Country (Australia) → the address, one line, picked from EB's suggestions →
  // the shipping method EB picked → "How would you like to pay?": Pay Now, then "Credit / Debit card" →
  // card number, MM/YY, CVV and name on card (in a payment frame), billing address the same as the
  // delivery one (ticked) → "Done" → "CONFIRM & PAY". Signed in (state.signedIn.ebgames): it's all in —
  // home delivery, your address, your saved card — and only "CONFIRM & PAY" is left.
  function ebgamesCheckout() {
    const sum = total('ebgames');
    const signed = !!state.signedIn.ebgames;
    const acc = signed ? { email: 'ash.eb@example.com', firstName: 'Ash', lastName: 'Ketchum', phone: '0412345678' } : {};
    const v = (k) => (acc[k] ? ` value="${esc(acc[k])}"` : '');
    return `<h1>Checkout</h1>
      <form method="post" action="/ebgames/checkout/place" id="eb-form">
      <section id="eb-contact"><h2>Contact details</h2>
        <label>Email address <input name="email" type="email" required${v('email')}></label>
        <label>First name <input name="firstName" required${v('firstName')}></label>
        <label>Last name <input name="lastName" required${v('lastName')}></label>
        <label>Mobile number <input name="phone" type="tel" required${v('phone')}></label>
        <label><input type="checkbox" name="news"> Send me news and offers</label></section>
      <section id="eb-delivery"><h2>Delivery</h2>
        <label><input type="radio" name="fulfilment" value="cnc" ${signed ? '' : 'checked'}> Click &amp; Collect</label>
        <label><input type="radio" name="fulfilment" value="home" ${signed ? 'checked' : ''}> Home Delivery</label>
        <div id="eb-cnc" ${signed ? 'hidden' : ''}><label>Choose a store <select name="cncStore"><option value="">Select a store</option><option>EB Games Sydney CBD</option></select></label></div>
        <div id="eb-home" ${signed ? '' : 'hidden'}>
          <label>Country <select name="country"><option value="">Select country</option><option value="NZ">New Zealand</option><option value="AU" ${signed ? 'selected' : ''}>Australia</option></select></label>
          <label for="eb-addr">Address</label>
          <input id="eb-addr" name="addressSearch" role="combobox" aria-autocomplete="list" autocomplete="off" placeholder="Start typing your address" ${signed ? 'value="1 Pallet Town Rd, Sydney NSW 2000"' : 'disabled'}>
          <ul id="eb-addr-list" role="listbox" class="address-suggestions" hidden></ul>
          <input type="hidden" name="address" value="${signed ? '1 Pallet Town Rd, Sydney NSW 2000' : ''}">
          <div id="eb-ship" ${signed ? '' : 'hidden'}><h3>Shipping method</h3>
            <label><input type="radio" name="shipping" value="standard" checked> Standard Delivery $9.95</label>
            <label><input type="radio" name="shipping" value="express"> Express Delivery $14.95</label></div>
        </div></section>
      <section id="eb-pay" ${signed ? '' : 'hidden'}><h2>How would you like to pay?</h2>
        <div role="tablist"><button type="button" role="tab" aria-selected="true" class="pay-tab is-active">Pay Now</button> <button type="button" role="tab" aria-selected="false" class="pay-tab">Pay Later</button></div>
        ${signed ? '<p class="saved-card">Visa ending in 4242 <small>Expires 07/29</small></p>' : `<div class="pay-options">
          <button type="button" class="pay-option" data-m="card">Credit / Debit card</button>
          <button type="button" class="pay-option" data-m="paypal">PayPal</button>
          <button type="button" class="pay-option" data-m="applepay">Apple Pay</button></div>
        <div id="eb-card" hidden><iframe id="eb-card-frame" title="Card details" src="${cardOrigin}/card-frame?style=eb" width="360" height="230" style="border:1px solid #ccc"></iframe>
          <label><input type="checkbox" name="billingSame" checked> Billing address same as delivery address</label>
          <p><button type="button" id="eb-done">Done</button></p></div>
        <p id="eb-card-saved" hidden></p>`}</section>
      <p class="order-total">Total: $${(sum + 9.95).toFixed(2)}</p>
      <label class="terms"><input type="checkbox" name="marketing"> Subscribe to our newsletter</label>
      <p><button type="submit" id="eb-confirm" ${signed ? '' : 'disabled'}>CONFIRM &amp; PAY</button></p>
      <input type="hidden" name="cardDone" value="${signed ? 'saved' : ''}">
      </form>
      <p id="eb-error" class="err"></p>
      <script>
        const $ = (id) => document.getElementById(id);
        const post = (step, data) => fetch('/ebgames/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step, data }) });
        const form = $('eb-form');
        for (const r of form.querySelectorAll('input[name=fulfilment]')) r.addEventListener('change', () => {
          const home = r.value === 'home' && r.checked;
          $('eb-home').hidden = !home; $('eb-cnc').hidden = home;
          post('fulfilment', { fulfilment: r.value });
        });
        form.querySelector('select[name=country]').addEventListener('change', (e) => { $('eb-addr').disabled = e.target.value !== 'AU'; post('country', { country: e.target.value }); });
        const ADDRESSES = ['1 Pallet Town Rd, SYDNEY NSW 2000', '1 Pallet Town Rd, PALLET QLD 4999'];
        const list = $('eb-addr-list');
        $('eb-addr').addEventListener('input', () => {
          form.querySelector('[name=address]').value = '';
          const q = $('eb-addr').value.toLowerCase();
          clearTimeout(window.__t);
          window.__t = setTimeout(() => {
            const hits = q.length >= 4 ? ADDRESSES.filter((a) => q.split(/[\\s,]+/).filter((w) => w.length > 2).slice(0, 2).every((w) => a.toLowerCase().includes(w))) : [];
            list.innerHTML = hits.map((a) => '<li role="option">' + a + '</li>').join('');
            list.hidden = !hits.length;
          }, 250);
        });
        $('eb-addr').addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 200));
        list.addEventListener('mousedown', (e) => {
          const li = e.target.closest('li'); if (!li) return;
          e.preventDefault();
          $('eb-addr').value = li.textContent; form.querySelector('[name=address]').value = li.textContent; list.hidden = true;
          const d = Object.fromEntries(['email', 'firstName', 'lastName', 'phone', 'country'].map((n) => [n, form.querySelector('[name=' + n + ']').value]));
          post('address', { ...d, address: li.textContent });
          setTimeout(() => { $('eb-ship').hidden = false; $('eb-pay').hidden = false; }, 400);
        });
        for (const b of document.querySelectorAll('.pay-option')) b.addEventListener('click', () => {
          for (const x of document.querySelectorAll('.pay-option')) x.classList.remove('is-selected');
          b.classList.add('is-selected');
          $('eb-card').hidden = b.dataset.m !== 'card';
          post('payment', { method: b.dataset.m });
        });
        // The card frame says what's in it; "Done" takes it (only once it's all in).
        const card = {};
        addEventListener('message', (e) => { if (e.data && e.data.ebCard) card[e.data.ebCard] = e.data.value; });
        $('eb-done')?.addEventListener('click', () => {
          if (!(card.cardNumber && card.expiry && card.cvv && card.nameOnCard)) { $('eb-error').textContent = 'Please complete your card details'; return; }
          $('eb-error').textContent = '';
          form.querySelector('[name=cardDone]').value = card.cardNumber.slice(-4);
          post('card', { last4: card.cardNumber.replace(/\\D/g, '').slice(-4), expiry: card.expiry, name: card.nameOnCard });
          $('eb-card').hidden = true; $('eb-card-saved').hidden = false; $('eb-card-saved').textContent = 'Card ending in ' + card.cardNumber.replace(/\\D/g, '').slice(-4);
          $('eb-confirm').disabled = false;
        });
      </script>`;
  }

  // Target's one-page checkout (/spc/order), as the real one goes: Delivery Options as tiles (nothing
  // chosen) → "Home Delivery" → your details (first and last name, contact number, email) and the
  // delivery address, one line, picked from Target's suggestions as you type → Payment Method tiles →
  // "Credit Card" → Paydock's card form (a frame from another address: card holder's name, card
  // number, expiry MM/YY, CVV). "Place order" shows from the start, greyed out until it's all done.
  // Signed in (state.signedIn.target): your details are already in; the rest is the same.
  function targetCheckout() {
    const sum = total('target');
    const acc = state.signedIn.target ? { firstName: 'Ash', lastName: 'Ketchum', phone: '0412345678', email: 'ash.target@example.com' } : {};
    const v = (k) => (acc[k] ? ` value="${esc(acc[k])}"` : '');
    const tile = (cls, attr, title, sub) => `<div class="${cls}" role="radio" aria-checked="false" tabindex="0" ${attr}><span class="${cls}-title">${title}</span>${sub ? `<small> ${sub}</small>` : ''}</div>`;
    return `<h1>Checkout</h1>
      <section id="t-options"><h2>Delivery Options</h2>
        ${tile('DeliveryOption', 'data-mode="home"', 'Home Delivery', 'Delivered to your door')}
        ${tile('DeliveryOption', 'data-mode="cnc"', 'Click &amp; Collect', 'Free, at a store near you')}</section>
      <section id="t-details" hidden><h2>Your details</h2>
        <label>First Name <input name="firstName" autocomplete="given-name" required${v('firstName')}></label>
        <label>Last Name <input name="lastName" autocomplete="family-name" required${v('lastName')}></label>
        <label>Contact Number <input name="contactNumber" type="tel" required${v('phone')}></label>
        <label>Email <input name="email" type="email" required${v('email')}></label>
        <label for="t-addr">Delivery Address</label>
        <input id="t-addr" name="deliveryAddress" role="combobox" aria-autocomplete="list" aria-controls="t-addr-list" aria-expanded="false" autocomplete="off" placeholder="Start typing your address">
        <ul id="t-addr-list" role="listbox" class="AddressSuggestions" hidden></ul></section>
      <section id="t-payment" hidden><h2>Payment Method</h2>
        ${tile('PaymentTile', 'data-pay="card"', 'Credit Card')}${tile('PaymentTile', 'data-pay="paypal"', 'PayPal')}${tile('PaymentTile', 'data-pay="afterpay"', 'Afterpay')}${tile('PaymentTile', 'data-pay="zip"', 'Zip')}
        <div id="t-card" hidden><iframe id="paydock" title="Credit card" src="${cardOrigin}/paydock-widget" width="380" height="260" style="border:1px solid #ccc"></iframe></div></section>
      <div class="OrderSummary"><p>Subtotal $${sum.toFixed(2)} · Home Delivery $9.00</p><p class="order-total"><b>Order total $${(sum + 9).toFixed(2)}</b></p>
        <button type="button" id="t-place" disabled>Place order</button></div>
      <input type="hidden" id="t-cardNumber"><input type="hidden" id="t-cardName"><input type="hidden" id="t-cardExpiry"><input type="hidden" id="t-cardCvv">
      <p id="t-error" class="err"></p>
      <script>
        const $ = (id) => document.getElementById(id);
        const post = (step, data) => fetch('/target/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step, data }) });
        const ADDRESSES = ['1 Pallet Town Rd, SYDNEY NSW 2000', '1 Pallet Town Rd, PALLET VIC 3999', '10 Pallet Town Ave, SYDNEY NSW 2000'];
        let mode = '', address = '', pay = '';
        const pick = (el, group) => { for (const t of document.querySelectorAll(group)) { t.setAttribute('aria-checked', 'false'); t.classList.remove('is-selected'); } el.setAttribute('aria-checked', 'true'); el.classList.add('is-selected'); };
        const ready = () => {
          const d = Object.fromEntries([...$('t-details').querySelectorAll('input')].filter((i) => i.name !== 'deliveryAddress').map((i) => [i.name, i.value]));
          const card = $('t-cardNumber').value && $('t-cardExpiry').value && $('t-cardCvv').value && $('t-cardName').value;
          $('t-place').disabled = !(mode === 'home' && address && Object.values(d).every(Boolean) && pay === 'card' && card);
          return d;
        };
        for (const t of document.querySelectorAll('.DeliveryOption')) t.addEventListener('click', () => {
          pick(t, '.DeliveryOption'); mode = t.dataset.mode;
          if (mode === 'cnc') { $('t-error').textContent = 'Choose a store to collect from'; $('t-details').hidden = true; return; }
          $('t-error').textContent = ''; setTimeout(() => { $('t-details').hidden = false; }, 250);
        });
        // The address finder: suggestions once a few letters are in; only a picked one counts.
        const list = $('t-addr-list');
        $('t-addr').addEventListener('input', () => {
          address = '';
          const q = $('t-addr').value.toLowerCase();
          clearTimeout(window.__t);
          window.__t = setTimeout(() => {
            const hits = q.length >= 3 ? ADDRESSES.filter((a) => q.split(/[\\s,]+/).filter((w) => w.length > 2).slice(0, 3).every((w) => a.toLowerCase().includes(w))) : [];
            list.innerHTML = hits.map((a) => '<li role="option" class="AddressSuggestions-item">' + a + '</li>').join('');
            list.hidden = !hits.length; $('t-addr').setAttribute('aria-expanded', String(!!hits.length));
          }, 300);
        });
        list.addEventListener('mousedown', (e) => {
          const li = e.target.closest('li'); if (!li) return;
          e.preventDefault();
          address = li.textContent; $('t-addr').value = address; list.hidden = true; $('t-error').textContent = '';
          post('delivery', { mode, ...ready(), address });
          setTimeout(() => { $('t-payment').hidden = false; ready(); }, 600);
        });
        $('t-addr').addEventListener('blur', () => { setTimeout(() => { if (!address && $('t-addr').value) $('t-error').textContent = 'Please select an address from the list'; list.hidden = true; }, 200); });
        for (const t of document.querySelectorAll('.PaymentTile')) t.addEventListener('click', () => {
          pick(t, '.PaymentTile'); pay = t.dataset.pay; $('t-card').hidden = pay !== 'card'; ready();
        });
        // Paydock's card form says what's in it.
        addEventListener('message', (e) => { const d = e.data; if (d && d.paydock) { $('t-' + d.paydock).value = d.value; ready(); } });
        for (const i of $('t-details').querySelectorAll('input')) i.addEventListener('input', ready);
        const place = ${placeJs('target', 't-error')};
        $('t-place').addEventListener('click', () => { if (!$('t-place').disabled) place({ cardNumber: $('t-cardNumber').value, cardName: $('t-cardName').value, cardExpiry: $('t-cardExpiry').value, cardCvv: $('t-cardCvv').value }); });
      </script>`;
  }

  // Shopify's one-page checkout, the way it is now: contact, delivery (with Australia chosen), the
  // shipping methods, and the card in Shopify's card fields — one frame per box, from another address
  // (checkout.pci.shopifyinc.com on the real ones), each box only keeping real typing. Toys"R"Us adds
  // "Authority to leave" (ticked), and "Use shipping address as billing address" comes ticked.
  // Signed in with Shop (state.signedIn[shop] === 'shop'): everything's in, Shop Pay's card shown.
  function shopifyCheckout(shop) {
    const shopPay = state.signedIn[shop] === 'shop';
    const P = shopPay ? { email: 'ash.shop@example.com', firstName: 'Ash', lastName: 'Ketchum', address1: '1 Pallet Town Rd', city: 'Sydney', zone: 'NSW', postalCode: '2000', phone: '0412345678' } : {};
    const v = (k) => (P[k] ? ` value="${esc(P[k])}"` : '');
    const ship = shopOf(shop).shippingRates || (shop === 'jbhifi' ? 'standard' : 'none');
    const rates = [['standard', shop === 'toysrus' ? 'Standard Shipping - AusPost' : 'Standard Shipping', 10], ['express', shop === 'toysrus' ? 'Express Shipping - AusPost' : 'Express Shipping', 15]];
    const field = (f, label) => `<div class="card-field"><iframe class="card-fields-iframe" name="card-fields-${f}-abc" title="Field container for: ${label}" src="${cardOrigin}/shopify-card?field=${f}" width="300" height="44" style="border:1px solid #ccc"></iframe></div>`;
    const card = shopPay
      ? '<div class="shop-pay"><b>Shop Pay</b> <span>Visa •••• 4242</span> <span class="muted">Expires 07/29</span></div>'
      : `<label><input type="radio" name="payment" value="card" checked> Credit card</label>${field('number', 'Card number')}${field('expiry', 'Expiration date')}${field('verification_value', 'Security code')}${shop === 'gamerholic' ? '' : field('name', 'Name on card')}
         <label><input type="checkbox" name="billingSame" checked> Use shipping address as billing address</label>`;
    return `<h1>Checkout</h1><form method="post" id="sf">
        <h3>Contact</h3><input name="email" type="email" autocomplete="email" placeholder="Email" required${v('email')}>
        <h3>Delivery</h3>
        <select name="countryCode" autocomplete="shipping country"><option value="AU" selected>Australia</option><option value="NZ">New Zealand</option></select>
        <input name="firstName" autocomplete="shipping given-name" placeholder="First name" required${v('firstName')}>
        <input name="lastName" autocomplete="shipping family-name" placeholder="Last name" required${v('lastName')}>
        <input name="address1" autocomplete="shipping address-line1" placeholder="Address" required role="combobox" aria-autocomplete="list"${v('address1')}>
        <input name="address2" autocomplete="shipping address-line2" placeholder="Apartment, suite, etc. (optional)">
        <input name="city" autocomplete="shipping address-level2" placeholder="Suburb" required${v('city')}>
        <select name="zone" autocomplete="shipping address-level1" required><option value="" disabled ${P.zone ? '' : 'selected'}>State/territory</option><option value="ACT">Australian Capital Territory</option><option value="NSW" ${P.zone === 'NSW' ? 'selected' : ''}>New South Wales</option><option value="VIC">Victoria</option><option value="QLD">Queensland</option></select>
        <input name="postalCode" autocomplete="shipping postal-code" placeholder="Postcode" required${v('postalCode')}>
        <input name="phone" autocomplete="shipping tel" placeholder="Phone${shop === 'gamerholic' ? ' (optional)' : ''}" type="tel"${v('phone')}>
        ${shop === 'toysrus' ? '<label><input type="checkbox" name="atl" checked> Authority to leave</label>' : ''}
        <h3>Shipping method</h3>${rates.map(([id, label, price]) => `<label><input type="radio" name="shipping" value="${id}" ${ship === id ? 'checked' : ''}> ${label} $${price.toFixed(2)}</label>`).join('')}
        <h3>Payment</h3><p>All transactions are secure and encrypted.</p>${card}
        <input type="hidden" name="card_number"><input type="hidden" name="card_expiry"><input type="hidden" name="card_cvv"><input type="hidden" name="card_name">
        <p class="order-total">Total: $<span id="tot">${(total(shop) + 10).toFixed(2)}</span></p>
        <button type="submit" id="pay">Pay now</button></form>
      <script>
        // The card fields' frames say what's in them (Shopify keeps it in its vault; here, in the form).
        const map = { number: 'card_number', expiry: 'card_expiry', verification_value: 'card_cvv', name: 'card_name' };
        addEventListener('message', (e) => { if (e.data && e.data.cardField && map[e.data.cardField]) document.querySelector('[name=' + map[e.data.cardField] + ']').value = e.data.value; });
        for (const r of document.querySelectorAll('input[name=shipping]')) r.addEventListener('change', () => { document.getElementById('tot').textContent = (${total(shop)} + (r.value === 'express' ? 15 : 10)).toFixed(2); });
      </script>`;
  }

  function bigwCheckout() {
    return `<h1>Secure checkout</h1>
      <section id="b-contact"><h2>1. Contact details</h2>
        <label>Email address <input name="email" type="email" required></label>
        <p><button type="button" id="b-guest">Continue as guest</button> or <a href="#" id="b-signin">Sign in</a></p></section>
      <section id="b-delivery" hidden><h2>2. Delivery</h2><p>How would you like to get your order?</p>
        <button type="button" class="choice" id="b-home" aria-pressed="false">Home delivery</button>
        <button type="button" class="choice" id="b-cc" aria-pressed="false">Click &amp; Collect</button>
        <div id="b-address" hidden>
          <label>First name <input name="firstName" required></label>
          <label>Last name <input name="lastName" required></label>
          <label>Phone number <input name="phone" type="tel" required></label>
          <label for="b-lookup">Start typing your address</label><input id="b-lookup" name="addressSearch" placeholder="Start typing your address">
          <p><a href="#" id="b-manual">Enter address manually</a></p>
          <div id="b-manual-fields" hidden>
            <label>Street address <input name="street"></label>
            <label>Unit / apartment (optional) <input name="unit"></label>
            <label>Suburb <input name="suburb"></label>
            <label>State <select name="state">${STATES}</select></label>
            <label>Postcode <input name="postcode" maxlength="4"></label>
          </div>
          <p><button type="button" id="b-to-payment">Continue to payment</button></p>
        </div></section>
      <section id="b-payment" hidden><h2>3. Payment</h2><p>Credit or debit card</p>${cardBoxes('stripe')}
        <p>Total: $${(total('bigw') + 9).toFixed(2)}</p><p><button type="button" id="b-place">Place order</button></p></section>
      <p id="b-error" class="err"></p>
      <script>
        const $ = (id) => document.getElementById(id);
        const post = (step, data) => fetch('/bigw/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step, data }) });
        const vals = (sec) => Object.fromEntries([...sec.querySelectorAll('input,select')].filter((i) => i.name).map((i) => [i.name, i.value]));
        $('b-guest').addEventListener('click', () => {
          const email = document.querySelector('[name=email]').value;
          if (!email) { $('b-error').textContent = 'Enter your email address'; return; }
          $('b-error').textContent = '';
          post('contact', { email });
          $('b-contact').querySelector('p').remove();
          setTimeout(() => { $('b-delivery').hidden = false; }, 300);
        });
        $('b-home').addEventListener('click', () => { $('b-home').setAttribute('aria-pressed', 'true'); $('b-cc').setAttribute('aria-pressed', 'false'); post('method', { method: 'home' }); setTimeout(() => { $('b-address').hidden = false; }, 200); });
        $('b-cc').addEventListener('click', () => { $('b-cc').setAttribute('aria-pressed', 'true'); $('b-home').setAttribute('aria-pressed', 'false'); post('method', { method: 'collect' }); $('b-address').hidden = true; });
        $('b-manual').addEventListener('click', (e) => { e.preventDefault(); $('b-manual-fields').hidden = false; $('b-lookup').closest('label')?.remove(); $('b-lookup').remove(); });
        $('b-to-payment').addEventListener('click', () => {
          const d = vals($('b-address'));
          const missing = ['firstName', 'lastName', 'phone', 'street', 'suburb', 'state', 'postcode'].filter((k) => !d[k]);
          if (missing.length) { $('b-error').textContent = 'Please complete: ' + missing.join(', '); return; }
          $('b-error').textContent = '';
          post('address', d);
          $('b-to-payment').remove();
          setTimeout(() => { $('b-payment').hidden = false; }, 300);
        });
        $('b-place').addEventListener('click', async () => {
          await fetch('/bigw/checkout/place', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          location.href = '/bigw/checkout/confirmation';
        });
      </script>`;
  }

  // -------------------------------------------------------------------- card iframe server
  const cardServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    // A whole checkout in a frame (like Global-e's, which runs Premium Bandai's): details and card.
    if (u.pathname === '/ge-checkout') {
      // Global-e's checkout (Premium Bandai's), as the real one goes: your billing details (signed in:
      // already there, and the delivery address is "Default (same as billing address)" — to pick),
      // area Australia, state drop-down, the phone after its +61, the shipping method it picked,
      // CREDIT CARD (chosen): card number, expiry month and year (drop-downs) and CVV in a frame of its
      // own, the purchase agreement box (required) → "Pay and Place Order".
      const PB = state.shops.pbandai;
      const signed = !!state.signedIn.pbandai;
      const acc = signed ? { firstName: 'Ash', lastName: 'Ketchum', email: 'ash.bandai@example.com', address1: '1 Pallet Town Rd', city: 'Sydney', zip: '2000', state: 'NSW', phone: '412345678' } : {};
      const v = (k) => (acc[k] ? ` value="${esc(acc[k])}"` : '');
      const sum = PB.cart.reduce((t, c) => t + c.price * c.qty, 0);
      const st = (sel) => `<option value="">Select</option>${['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'].map((x) => `<option value="${x}" ${sel === x ? 'selected' : ''}>${{ ACT: 'Australian Capital Territory', NSW: 'New South Wales', NT: 'Northern Territory', QLD: 'Queensland', SA: 'South Australia', TAS: 'Tasmania', VIC: 'Victoria', WA: 'Western Australia' }[x]}</option>`).join('')}`;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui;padding:8px"><h2>Secure checkout</h2>
<style>label{display:block;margin:6px 0}input:not([type=radio]):not([type=checkbox]),select{display:block;padding:6px;width:300px}.err{color:#c00}</style>
<form id="ge">
<h3>Billing Address</h3>
<label>FIRST NAME <input name="FirstName" required${v('firstName')}></label>
<label>LAST NAME <input name="LastName" required${v('lastName')}></label>
<label>E-MAIL ADDRESS <input name="Email" type="email" required${v('email')}></label>
<label>AREA <select name="CountryID"><option value="">Select</option><option value="12" selected>Australia</option><option value="153">New Zealand</option></select></label>
<label>ADDRESS LINE 1 <input name="Address1" required${v('address1')}></label>
<label>ADDRESS LINE 2 <input name="Address2"></label>
<label>CITY / SUBURB <input name="City" required${v('city')}></label>
<label>ZIP / POSTCODE <input name="Zip" required${v('zip')}></label>
<label>STATE OR PROVINCE <select name="StateOrProvinceID" required>${st(acc.state)}</select></label>
<div class="phone"><label for="ge-phone">PHONE NUMBER</label><select name="PhoneCountry" aria-label="Country code" style="width:90px;display:inline-block"><option selected>+61</option><option>+64</option></select>
  <input id="ge-phone" name="Phone1" type="tel" required style="display:inline-block;width:200px"${v('phone')}></div>
${signed ? `<h3>Delivery Address</h3>
<label><input type="radio" name="DeliveryAddress" value="default"> Default (same as billing address)</label>
<label><input type="radio" name="DeliveryAddress" value="new"> Use a different address</label>` : ''}
<h3>Shipping Method</h3>
<label><input type="radio" name="Shipping" value="std" checked> Standard Shipping AUD $15.00</label>
<label><input type="radio" name="Shipping" value="exp"> Express Shipping AUD $30.00</label>
<h3>Payment</h3>
<label><input type="radio" name="PaymentMethod" value="cc" checked> CREDIT CARD</label>
<label><input type="radio" name="PaymentMethod" value="paypal"> PayPal</label>
<iframe id="ge-card" title="Card details" src="/ge-card" width="360" height="180" style="border:1px solid #ccc"></iframe>
<p class="total">Total AUD $${(sum + 15).toFixed(2)}</p>
<label><input type="checkbox" name="Terms" required> I confirm no returns or refunds are accepted for personal circumstances. I have read and agree to <a href="#">the Purchase Agreement</a> and understand that whenever there may be an inconsistency, Premium Bandai's policy prevails over Global-e's Terms of Sale.<small>Required</small></label>
<label><input type="checkbox" name="Newsletter"> Send me news and offers by email</label>
<button type="button" id="ge-place">Pay and Place Order</button>
<p id="ge-err" class="err"></p>
</form>
<script>
const form = document.getElementById('ge');
const card = {};
addEventListener('message', (e) => { if (e.data && e.data.geCard) card[e.data.geCard] = e.data.value; });
document.getElementById('ge-place').addEventListener('click', async () => {
  const d = Object.fromEntries([...form.querySelectorAll('input,select')].filter((i) => i.name && (!/radio|checkbox/.test(i.type) || i.checked)).map((i) => [i.name, i.type === 'checkbox' ? true : i.value]));
  const missing = [...form.querySelectorAll('[required]')].filter((i) => (i.type === 'checkbox' ? !i.checked : !i.value)).map((i) => i.name);
  if (${signed ? 'true' : 'false'} && !d.DeliveryAddress) missing.push('DeliveryAddress');
  if (!(card.cardNumber && card.expMonth && card.expYear && card.cvv)) missing.push('card');
  if (missing.length) { document.getElementById('ge-err').textContent = 'Please complete: ' + missing.join(', '); return; }
  const r = await fetch('/ge-place', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...d, card }) });
  const out = await r.json();
  if (out.error) { const el = document.getElementById('ge-err'); el.textContent = out.error; el.setAttribute('role', 'alert'); return; }
  document.body.insertAdjacentHTML('beforeend', '<p>Thank you for your order! Order number: GE-' + out.order + '</p>');
  parent.postMessage({ gePlaced: out.order }, '*');
});
</script></body></html>`);
      return;
    }
    // Global-e's card form: a frame of its own inside its checkout (expiry month and year are drop-downs).
    if (u.pathname === '/ge-card') {
      const years = Array.from({ length: 11 }, (_, i) => 2026 + i);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui;padding:6px">
<style>label{display:block;margin:4px 0}input,select{padding:5px}</style>
<label>CARD NUMBER <input name="cardNumber" inputmode="numeric" style="width:260px"></label>
<label for="m">EXPIRY DATE</label><select id="m" name="expMonth" aria-label="Expiry date month"><option value="">Month</option>${Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, '0')}">${String(i + 1).padStart(2, '0')}</option>`).join('')}</select>
<select name="expYear" aria-label="Expiry date year"><option value="">Year</option>${years.map((y) => `<option value="${y}">${y}</option>`).join('')}</select>
<label>CVV <input name="cvv" inputmode="numeric" style="width:80px"></label>
<script>
for (const el of document.querySelectorAll('input, select')) {
  const tell = () => parent.postMessage({ geCard: el.name, value: el.value }, '*');
  el.addEventListener('input', () => { if (el.name === 'cardNumber') el.value = el.value.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 '); tell(); });
  el.addEventListener('change', tell);
}
</script></body></html>`);
      return;
    }
    if (u.pathname === '/ge-place' && req.method === 'POST') {
      const b = await parseBody(req);
      const PB = state.shops.pbandai;
      if (PB.decline) { PB.declined = (PB.declined || 0) + 1; return json(200, { error: 'Your card was declined. Please try another card.' }); }
      PB.orders.push({ cart: PB.cart.slice(), form: b, ts: Date.now() });
      PB.cart = [];
      return json(200, { order: 1000 + PB.orders.length });
    }
    // Paydock's card form (Target's): card holder's name, card number, expiry (MM/YY), CVV — real typing only.
    if (u.pathname === '/paydock-widget') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui;padding:8px">
<style>label{display:block;margin:6px 0}input{display:block;padding:6px;width:300px}</style>
<label>Card holders name <input name="card_name" data-k="cardName"></label>
<label>Credit card number <input name="card_number" inputmode="numeric" data-k="cardNumber"></label>
<label>Expiry date <input name="expire" placeholder="MM/YY" data-k="cardExpiry"></label>
<label>CVV* <input name="card_ccv" inputmode="numeric" data-k="cardCvv"></label>
<script>
for (const el of document.querySelectorAll('input')) {
  let typed = '';
  el.addEventListener('input', (e) => {
    if (!e.isTrusted) { el.value = typed; return; }
    if (el.name === 'card_number') el.value = el.value.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 ');
    if (el.name === 'expire') { const d = el.value.replace(/\\D/g, '').slice(0, 4); el.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; }
    typed = el.value;
    parent.postMessage({ paydock: el.dataset.k, value: typed }, '*');
  });
}
</script></body></html>`);
      return;
    }
    // Shopify's card fields: one frame per box, keeping only real typing (like checkout.pci.shopifyinc.com's).
    if (u.pathname === '/shopify-card') {
      const f = { number: ['number', 'cc-number', 'Card number', 'numeric'], expiry: ['expiry', 'cc-exp', 'Expiration date (MM / YY)', 'numeric'], verification_value: ['verification_value', 'cc-csc', 'Security code', 'numeric'], name: ['name', 'cc-name', 'Name on card', 'text'] }[u.searchParams.get('field')] || [];
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui">
<input id="${f[0]}" name="${f[0]}" autocomplete="${f[1]}" placeholder="${f[2]}" inputmode="${f[3]}" aria-label="${f[2]}" style="display:block;padding:8px;width:260px;border:0">
<script>
const el = document.querySelector('input');
const format = (v) => {
  if (el.name === 'number') return v.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 ');
  if (el.name === 'expiry') { const d = v.replace(/\\D/g, '').slice(0, 4); return d.length > 2 ? d.slice(0, 2) + ' / ' + d.slice(2) : d; }
  if (el.name === 'verification_value') return v.replace(/\\D/g, '').slice(0, 4);
  return v;
};
let typed = '';
el.addEventListener('input', (e) => {
  if (!e.isTrusted) { el.value = typed; return; }
  el.value = format(el.value);
  typed = el.value;
  parent.postMessage({ cardField: el.name, value: typed }, '*');
});
</script></body></html>`);
      return;
    }
    if (u.pathname === '/acs/challenge') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body style="font:14px system-ui"><h3>Verify it\'s you</h3><p>Enter the code we sent to your phone.</p><input name="otp" inputmode="numeric"><button type="button">Submit</button></body></html>');
      return;
    }
    if (u.pathname === '/card-frame') {
      const style = u.searchParams.get('style') || 'stripe';
      if (style === 'strict') {
        const f = { number: ['encryptedCardNumber', 'cc-number', 'Card number field', '1234 5678 9012 3456'], expiry: ['encryptedExpiryDate', 'cc-exp', 'Expiry date field', 'MM/YY'], cvc: ['encryptedSecurityCode', 'cc-csc', 'Security code field', '3 digits'] }[u.searchParams.get('field')] || [];
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui">
<input id="${f[0]}" type="text" inputmode="numeric" data-fieldtype="${f[0]}" autocomplete="${f[1]}" aria-label="${f[2]}" placeholder="${f[3]}" style="display:block;padding:8px;width:260px;border:0">
<script>
// Keeps its own copy of what was typed; anything that isn't real typing is undone.
const el = document.querySelector('input');
const format = (v) => {
  if (el.dataset.fieldtype === 'encryptedCardNumber') return v.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 ');
  if (el.dataset.fieldtype === 'encryptedExpiryDate') { const d = v.replace(/\\D/g, '').slice(0, 4); return d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; }
  return v.replace(/\\D/g, '').slice(0, 4);
};
let typed = '';
let attempts = 0;
if (${JSON.stringify(u.searchParams.get('mode'))} === 'never') {
  // Takes nothing at all (counts how often something tried).
  el.addEventListener('focus', () => { attempts += 1; });
  el.addEventListener('keydown', (e) => e.preventDefault());
  el.addEventListener('beforeinput', (e) => e.preventDefault());
  el.addEventListener('input', () => { el.value = ''; });
} else if (${JSON.stringify(u.searchParams.get('mode'))} === 'keys') {
  // Only key presses count: the browser's own text insertion is blocked.
  el.addEventListener('beforeinput', (e) => e.preventDefault());
  el.addEventListener('keydown', (e) => { if (/^[0-9]$/.test(e.key)) { typed = format(typed + e.key); el.value = typed; e.preventDefault(); } });
  el.addEventListener('input', () => { el.value = typed; });
} else {
  el.addEventListener('input', (e) => {
    if (!e.isTrusted) { el.value = typed; return; }
    // 'slow': a box that takes a while with what's typed (heavy formatting), like a busy payment page.
    if (${JSON.stringify(u.searchParams.get('mode'))} === 'slow') { const t = Date.now() + 900; while (Date.now() < t) { /* busy */ } }
    el.value = format(el.value);
    typed = el.value;
    // Like Adyen: a complete card number moves you on to the next box.
    if (el.dataset.fieldtype === 'encryptedCardNumber' && typed.replace(/\\D/g, '').length === 16) parent.postMessage({ adyenNext: 'expiry' }, '*');
  });
}
</script></body></html>`);
        return;
      }
      const fields = style === 'mystery'
        // A payment widget Mugibot doesn't recognise (no names or labels it knows).
        ? '<input name="f1" inputmode="numeric"><input name="f2"><input name="f3" inputmode="numeric">'
        : style === 'kmart'
        ? '<label>Card number <input name="encryptedCardNumber" aria-label="Card number" inputmode="numeric"></label><label>Expiry <input name="encryptedExpiryDate" aria-label="Expiry date" placeholder="MM/YY"></label><label>CVV <input name="encryptedSecurityCode" aria-label="CVV" inputmode="numeric"></label>'
        : style === 'eb'
          ? '<label>Card Number <input name="cardNumber" inputmode="numeric" autocomplete="cc-number"></label><label>MM/YY <input name="expiry" placeholder="MM/YY" autocomplete="cc-exp"></label><label>CVV <input name="cvv" inputmode="numeric" autocomplete="cc-csc"></label><label>Name on Card <input name="nameOnCard" autocomplete="cc-name"></label>'
        : style === 'shopify'
          ? '<input name="number" placeholder="Card number" inputmode="numeric"><input name="name" placeholder="Name on card"><input name="expiry" placeholder="Expiration date (MM / YY)"><input name="verification_value" placeholder="Security code" inputmode="numeric">'
          : '<input name="cardnumber" autocomplete="cc-number" placeholder="Card number" inputmode="numeric"><input name="exp-date" autocomplete="cc-exp" placeholder="MM / YY"><input name="cvc" autocomplete="cc-csc" placeholder="CVC" inputmode="numeric"><input name="ccname" placeholder="Name on card">';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui">${fields}
<style>input{display:block;margin:4px 0;padding:6px;width:260px}</style>
<script>
// Format like real payment widgets do (and tell the page what's in each box, like EB's).
for (const el of document.querySelectorAll('input')) {
  el.addEventListener('input', () => {
    if (/number|cardnumber/i.test(el.name)) el.value = el.value.replace(/\\D/g,'').slice(0,16).replace(/(\\d{4})(?=\\d)/g,'$1 ');
    if (/exp/i.test(el.name)) { const d = el.value.replace(/\\D/g,'').slice(0,4); el.value = d.length > 2 ? d.slice(0,2) + ' / ' + d.slice(2) : d; }
    parent.postMessage({ ebCard: el.name, value: el.value }, '*');
  });
}
</script></body></html>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // -------------------------------------------------------------------- checkpoints and queues
  const cookieOf = (req, name) => {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  };

  // The queue page, like EB Games' (Cloudflare's waiting room): it refreshes itself. lateMs: its words
  // drawn by its own code a moment after it opens (like a queue page built in the browser).
  function queuePage(shop, q) {
    const s = SHOPS[shop];
    const words = `<h1>You're in the queue!</h1>
<p>Thanks for hanging in there. You'll head back into the queue after you complete your transaction.</p>
<p id="wait">Your estimated wait time is ${Number(q.wait)} minutes.</p>
<p>We are experiencing a high volume of traffic and using a virtual queue to limit the number of users on the site at the same time, so you can shop with confidence.</p>
<p>This page will automatically refresh, please do not close your browser.</p>`;
    const body = q.lateMs ? `<div id="queue"></div><script>setTimeout(() => { document.getElementById('queue').innerHTML = ${JSON.stringify(words)}; }, ${Number(q.lateMs)});</script>` : words;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.name)} — You're in the queue</title></head>
<body style="font:16px system-ui;text-align:center;padding:40px;background:#f4f4f4"><div class="dummy">⚠ Dummy store for testing Mugibot — nothing here is real.</div>
${body}
<script>setTimeout(() => location.reload(), ${Number(q.refreshMs) || 1500});</script></body></html>`;
  }

  /**
   * A shop's virtual queue (S.queue.on): null when this visitor may in (let in already, or let in
   * now), else the response sent (the queue page, or Pokémon Center's redirect to /?queue).
   */
  function inQueue(shop, S, req, res, u, html, redirect) {
    const q = S.queue;
    const name = `${shop}_queue`;
    const v = cookieOf(req, name) || '';
    if (v.startsWith('ok-') && q.admittedIds.includes(v.slice(3))) return null;
    const now = Date.now();
    let id = v.startsWith('in-') ? v.slice(3) : null;
    if (!v) q.cookieless += 1;
    let place = id ? q.places[id] : null;
    const note = (what) => { q.log.push({ id, at: now, path: u.pathname + u.search, what }); if (q.log.length > 3000) q.log.splice(0, 1000); };
    // Asked again too soon (refreshed by hand, a second tab, a script): the place in line is lost.
    if (place && now - place.lastAt < q.tooSoonMs) { note('kicked'); q.kicks += 1; delete q.places[id]; place = null; }
    if (!place) {
      id = Math.random().toString(36).slice(2, 10);
      place = q.places[id] = { joinedAt: now, lastAt: now - q.tooSoonMs };
    }
    // Pokémon Center's line is at /?queue.
    if (shop === 'pokemoncenter' && !u.searchParams.has('queue')) {
      note('redirect');
      res.setHeader('set-cookie', `${name}=in-${id}; Path=/`);
      redirect('/pokemoncenter/?queue');
      return true;
    }
    place.lastAt = now;
    if (now - place.joinedAt >= q.admitAfterMs) {
      note('admitted');
      delete q.places[id];
      q.admittedIds.push(id);
      q.admitted += 1;
      res.setHeader('set-cookie', `${name}=ok-${id}; Path=/`);
      // (Pokémon Center's line sends you on to the store's front page.)
      if (shop === 'pokemoncenter' && u.searchParams.has('queue')) { redirect('/pokemoncenter/'); return true; }
      return null;
    }
    note('queued');
    res.setHeader('set-cookie', `${name}=in-${id}; Path=/`);
    q.shown += 1;
    html(200, queuePage(shop, q));
    return true;
  }

  // Shopify's checkpoint: an hCaptcha page. Only a person's click (a trusted one) ticks the box.
  function checkpointPage(shop, back) {
    return page(shop, 'Checkpoint', `<h1>Before you continue…</h1><p>Confirm you're human to carry on to checkout.</p>
      <form method="post" action="/${shop}/checkpoint" id="checkpoint-form"><input type="hidden" name="return_to" value="${esc(back)}">
      <div class="h-captcha" data-sitekey="10000000-ffff-ffff-ffff-000000000001"><label><button type="button" id="hcaptcha-box" aria-label="I am human" style="background:#fff;color:#222;border:2px solid #999">☐</button> I am human</label></div>
      <input type="hidden" name="h-captcha-response" id="hcaptcha-response" value="">
      <p><button type="submit" id="checkpoint-submit">Submit</button></p></form>
      <script>
        document.getElementById('hcaptcha-box').addEventListener('click', (e) => {
          if (!e.isTrusted) { fetch('/${shop}/checkpoint/bot', { method: 'POST' }); return; }
          e.currentTarget.textContent = '☑';
          document.getElementById('hcaptcha-response').value = 'P1_human-' + Date.now();
        });
        document.getElementById('checkpoint-form').addEventListener('submit', (e) => { if (!e.isTrusted) { e.preventDefault(); fetch('/${shop}/checkpoint/bot', { method: 'POST' }); } });
      </script>`);
  }

  // -------------------------------------------------------------------- store server
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    state.requests.push({ method: req.method, path: p, ua: req.headers['user-agent'] || '' });
    if (state.requests.length > 4000) state.requests.splice(0, 2000);
    const html = (status, body) => {
      const sm = p.match(SHOP_RE);
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(sm ? String(body).replace('<!--mgb-account-->', accountBits(sm[1], !!state.signedIn[sm[1]])) : body);
    };
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); };

    // Product pictures (a coloured card with the product's name).
    const img = p.match(/^\/img\/(kmart|bigw|ebgames|jbhifi|trainertown|gamerholic|toysrus|thegamescube|pokemoncenter|pbandai|target|amazon|citybeach)\/([^/]+)\.svg$/);
    if (img) {
      const prod = find(img[1], decodeURIComponent(img[2]));
      if (!prod) return html(404, 'Not found');
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><rect width="300" height="300" rx="24" fill="${SHOPS[img[1]].color}"/><text x="150" y="140" font-family="system-ui,sans-serif" font-size="22" fill="#fff" text-anchor="middle">${esc(prod.name.slice(0, 22))}</text><text x="150" y="172" font-family="system-ui,sans-serif" font-size="16" fill="#fff" opacity=".8" text-anchor="middle">${esc(SHOPS[img[1]].name)}</text></svg>`);
    }

    // A picture that takes a while (a page that's slow to finish loading).
    if (p === '/slow.gif') {
      await new Promise((r) => setTimeout(r, Math.min(20000, Number(u.searchParams.get('ms')) || 0)));
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
      return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
    }

    // A store that refuses anything that isn't a browser (like Kmart's bot protection does for servers).
    if (state.blockNonBrowsers && !/Mozilla|Chrome/i.test(req.headers['user-agent'] || '') && !p.startsWith('/__admin')) {
      return html(403, '<html><head><title>Access Denied</title></head><body>Access Denied. Reference #18.abc123.1700000000</body></html>');
    }

    // ---------------- control panel
    if (p === '/__admin/state') return json(200, { ...state, requests: undefined });
    if (p === '/__admin/set' && req.method === 'POST') {
      const b = await parseBody(req);
      const prod = find(b.shop, b.sku);
      if (prod) {
        if (b.status) prod.status = b.status;
        if (b.price !== undefined && b.price !== '') prod.price = Number(b.price);
        if (b.listed !== undefined) prod.listed = b.listed === true || b.listed === 'true';
      }
      if (b.blockNonBrowsers !== undefined) state.blockNonBrowsers = b.blockNonBrowsers === true || b.blockNonBrowsers === 'true';
      // A shop's checkpoint (Shopify shops) or virtual queue (the others) on or off.
      if (b.gate && shopOf(b.gate)) shopOf(b.gate)[SHOPIFY.has(b.gate) ? 'checkpoint' : 'queue'].on = b.on === true || b.on === 'true';
      if (req.headers['content-type']?.includes('json')) return json(200, { ok: true });
      return redirect('/');
    }
    if (p === '/') {
      const btn = (shop, sku, fields, label) => `<form method="post" action="/__admin/set" style="display:inline"><input type="hidden" name="shop" value="${shop}"><input type="hidden" name="sku" value="${esc(sku)}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`).join('')}<button style="padding:4px 8px;font-size:12px;background:#444">${label}</button></form>`;
      const rows = Object.entries(state.shops).map(([shop, s]) => s.products.map((x) => `<tr><td>${esc(SHOPS[shop].name)}</td><td><a href="${pathFor(shop, x)}">${esc(x.name)}</a><br><small>SKU ${esc(x.sku)}</small></td>
        <td>${x.listed ? 'listed' : '<i>not listed</i>'}</td><td><b>${x.status}</b></td><td>$${x.price.toFixed(2)}</td>
        <td>${['in_stock', 'preorder', 'out_of_stock', 'coming_soon'].map((st) => btn(shop, x.sku, { status: st, listed: 'true' }, st)).join(' ')} ${btn(shop, x.sku, { listed: x.listed ? 'false' : 'true' }, x.listed ? 'unlist' : 'list')}</td></tr>`).join('')).join('');
      const orders = Object.values(state.shops).reduce((n, s) => n + s.orders.length, 0);
      return html(200, page(null, 'Dummy store control panel', `<h1>Dummy store — control panel</h1>
        <p>Fake shops for trying Mugibot end to end. Add these products to your Mugibot watchlist (the dashboard's <b>Add dummy-store test items</b> button does it for you), change their stock here, and watch the pings and ⚡ Buy work.</p>
        <table border="1" cellpadding="6" style="border-collapse:collapse;background:#fff;font-size:14px"><tr><th>Shop</th><th>Product</th><th>Listed</th><th>Stock</th><th>Price</th><th>Change</th></tr>${rows}</table>
        <p>${btn('', '', { blockNonBrowsers: state.blockNonBrowsers ? 'false' : 'true' }, state.blockNonBrowsers ? 'Stop refusing server checks' : 'Refuse server checks (like Kmart)')} Server checks are ${state.blockNonBrowsers ? '<b>refused</b> — only browsers get in' : 'allowed'}.</p>
        <p>Checkpoints and virtual queues: ${['jbhifi', 'ebgames', 'pokemoncenter'].map((id) => { const g = state.shops[id][SHOPIFY.has(id) ? 'checkpoint' : 'queue']; return `${btn('', '', { gate: id, on: g.on ? 'false' : 'true' }, `${SHOPS[id].name}: ${SHOPIFY.has(id) ? 'checkpoint' : 'queue'} ${g.on ? 'off' : 'on'}`)}`; }).join(' ')}</p>
        <p>Orders placed (stays 0 with ⚡ Buy — you press the final button; only an armed Auto-checkout places one): <b>${orders}</b></p>`));
    }

    const m = p.match(SHOP_RE);
    if (!m) return html(404, page(null, 'Page not found', '<h1>Page not found</h1>'));
    const shop = m[1];
    const sub = m[2] || '/';
    const S = shopOf(shop);
    // A shop answering "too many requests, wait N seconds" (state.tooMany[shop] = N), like Shopify's 429.
    if (state.tooMany && state.tooMany[shop] && !sub.startsWith('/img/')) {
      res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': String(state.tooMany[shop]) });
      return res.end('Too many requests');
    }
    // Its virtual queue, when it's on: every page (its search JSON too) for a visitor not let in yet.
    if (S.queue.on && !sub.startsWith('/img/') && inQueue(shop, S, req, res, u, html, redirect)) return undefined;
    // Shopify's checkpoint: the hCaptcha page, and checkout through it until it's solved.
    if (SHOPIFY.has(shop) && (sub === '/checkpoint' || sub === '/checkpoint/')) {
      if (req.method === 'POST') {
        const b = await parseBody(req);
        if (!S.checkpoint.on) return redirect(`/${shop}/`);
        if (!/^P1_human-/.test(b['h-captcha-response'] || '')) return html(200, checkpointPage(shop, b.return_to || `/${shop}/checkouts/c/abc123`));
        S.checkpoint.solved += 1;
        const pass = `ok-${Math.random().toString(36).slice(2, 10)}`;
        S.checkpoint.passes.push(pass);
        res.setHeader('set-cookie', `${shop}_checkpoint=${pass}; Path=/`);
        const back = String(b.return_to || '');
        return redirect(back.startsWith(`/${shop}/`) ? back : `/${shop}/checkouts/c/abc123`);
      }
      if (!S.checkpoint.on) return html(404, page(shop, 'Page not found', '<h1>Sorry, we can\'t find that page</h1>'));
      S.checkpoint.shown += 1;
      return html(200, checkpointPage(shop, u.searchParams.get('return_to') || `/${shop}/checkouts/c/abc123`));
    }
    if (SHOPIFY.has(shop) && sub === '/checkpoint/bot' && req.method === 'POST') {
      S.checkpoint.botClicks += 1;
      return json(200, { ok: false });
    }
    const pastCheckpoint = () => !S.checkpoint.on || S.checkpoint.passes.includes(cookieOf(req, `${shop}_checkpoint`) || '');

    if (sub === '/' || sub === '') {
      return html(200, page(shop, SHOPS[shop].name, `<h1>${esc(SHOPS[shop].name)}</h1>${S.products.filter((x) => x.listed).map((x) => `<div class="tile product-tile"><a href="${pathFor(shop, x)}">${esc(x.name)}</a><div>$${x.price.toFixed(2)} · ${x.status.replace(/_/g, ' ')}</div></div>`).join('')}`));
    }

    // Product pages, each in its retailer's link shape.
    let sku = null;
    if (shop === 'kmart') sku = (sub.match(/^\/product\/[^/]*-(\d{6,10})\/?$/) || [])[1];
    if (shop === 'bigw') sku = (sub.match(/^\/product\/[^/]+\/p\/(\d+)$/) || [])[1];
    if (shop === 'ebgames') sku = (sub.match(/^\/product\/[^/]+\/(\d+)-/) || [])[1];
    if (shop === 'thegamescube') sku = (sub.match(/^\/catalog\/[^/]+\/[^/]+\/(\d+)\/?$/) || [])[1];
    if (shop === 'pokemoncenter') sku = (sub.match(/^\/product\/([0-9A-Za-z-]+)\/[^/]+$/) || [])[1];
    if (shop === 'pbandai') sku = (sub.match(/^\/item\/([A-Z]\d+)$/) || [])[1];
    if (shop === 'target') sku = (sub.match(/^\/p\/[^/]+\/(\d+)$/) || [])[1];
    if (shop === 'amazon') sku = (sub.match(/^\/dp\/([A-Z0-9]{10})$/) || [])[1];
    if (shop === 'citybeach') sku = (sub.match(/^\/[^/]+\/(\d{6,10}-\d{2})\.html$/) || [])[1];
    if (SHOPIFY.has(shop)) {
      const js = sub.match(/^\/products\/([^/]+)\.js$/);
      if (js) {
        const prod = find(shop, js[1]);
        if (!prod || !prod.listed) return json(404, { error: 'not found' });
        // A marketplace seller's product (seller set): like JB Hi-Fi's, a "Seller" option naming them.
        const option = prod.seller ? { name: 'Seller', position: 1, values: [prod.seller] } : { name: 'Title', position: 1, values: ['Default Title'] };
        return json(200, {
          id: prod.id, handle: prod.sku, title: prod.name, available: prod.status === 'in_stock' || prod.status === 'preorder',
          featured_image: `http://${req.headers.host}${imagePath(shop, prod)}`, options: [option],
          variants: [{ id: prod.id, title: option.values[0], price: Math.round(prod.price * 100), available: prod.status === 'in_stock' || prod.status === 'preorder' }],
        });
      }
      sku = (sub.match(/^\/products\/([^/.]+)$/) || [])[1];
    }
    if (sku) {
      const prod = find(shop, sku);
      if (!prod || !prod.listed) return html(404, page(shop, 'Page not found', '<h1>Sorry, we can\'t find that page</h1>'));
      S.servedAt = Date.now();
      S.startToken = Math.random().toString(36).slice(2);
      return html(200, productPage(shop, prod));
    }

    if (shop === 'thegamescube' && sub === '/products/search') return html(200, crystalSearchPage(u.searchParams.get('q') || ''));
    const pathSearch = shop === 'pokemoncenter' && sub.match(/^\/search\/([^/]+)$/);
    // Like Imperva's check at Pokémon Center (botCheck on): a first visit gets its page (a frame, no
    // title), which reloads the page once the browser has passed — here, after a moment.
    if (pathSearch && S.botCheck && !/(^|;\s*)pc_check=1/.test(req.headers.cookie || '')) {
      return html(200, `<html style="height:100%"><head><meta name="ROBOTS" content="NOINDEX, NOFOLLOW"></head><body style="margin:0;height:100%">
        <iframe id="main-iframe" src="/pokemoncenter/_Incapsula_Resource?SWUDNSAI=31" frameborder="0" width="100%" height="100%">Request unsuccessful.</iframe>
        <script>setTimeout(() => { document.cookie = 'pc_check=1; path=/'; location.reload(); }, ${Number(S.botCheck) > 1 ? Number(S.botCheck) : 1500});</script></body></html>`);
    }
    if (shop === 'pokemoncenter' && sub === '/_Incapsula_Resource') return html(200, '<html><body>Checking your browser…</body></html>');
    if (pathSearch) return html(200, clientSearchPage(shop, decodeURIComponent(pathSearch[1])));
    // Premium Bandai's search JSON (what its search page reads, and Mugibot's sweeps): only with the
    // region its own code sends in x-g1-area-code — without it, an error, like the real site.
    if (shop === 'pbandai' && sub === '/api/search' && u.searchParams.has('keyword')) {
      if (String(req.headers['x-g1-area-code'] || '').toLowerCase() !== 'au') return json(500, { status: 500, error: 'Internal Server Error', path: '/api/search' });
      const all = searchHits(shop, u.searchParams.get('keyword'));
      return json(200, {
        text: u.searchParams.get('keyword'),
        productResults: {
          sortType: u.searchParams.get('sortType') || 'Recommended', limit: Number(u.searchParams.get('limit')) || 20, offset: 0, totalCount: all.length,
          products: all.map((x) => ({
            areaProductNo: `NAP${x.sku}AU`, productCode: x.sku, areaCode: 'AU', productName: { en: x.name },
            productType: x.status === 'preorder' ? 'PreOrder' : 'Normal', fixedListPrice: { amount: x.price, currency: 'AUD' },
            saleStatus: x.status === 'coming_soon' ? 'Waiting' : 'On', displayStatus: 'On',
            productImages: [{ fileUrl: imagePath(shop, x).slice(1), mediaType: 'Image' }],
            flags: [...(x.status === 'preorder' ? ['PRE_ORDER'] : []), ...(x.status === 'out_of_stock' ? ['OUT_OF_STOCK'] : [])],
          })),
        },
        aggs: {},
      });
    }
    if (shop === 'target' && sub === '/search') return html(200, targetSearchPage(u.searchParams.get('text') || ''));
    if (shop === 'citybeach' && sub === '/search') return html(200, citybeachSearchPage(u.searchParams.get('q') || ''));
    if (sub === '/search' || sub === '/search/') {
      const q = u.searchParams.get('searchTerm') || u.searchParams.get('text') || u.searchParams.get('q') || u.searchParams.get('query') || u.searchParams.get('keyword') || '';
      // Like BIG W's real site: the page has no products in it until its own code fetches them.
      if (S.clientSearch) return html(200, clientSearchPage(shop, q));
      return html(200, searchPage(shop, q));
    }
    if (sub === '/api/search') {
      const tiles = searchHits(shop, u.searchParams.get('q')).map((x) => ({ name: x.name, url: pathFor(shop, x), image: imagePath(shop, x), price: x.price, status: x.status, inStock: x.status === 'in_stock' || x.status === 'preorder' }));
      return json(200, { products: tiles });
    }
    // Amazon's search page: a tile per result with its ASIN (what Mugibot's sweeps read, from an admin's
    // browser). Like amazon.com.au, servers get "503 - An error occurred".
    if (shop === 'amazon' && sub === '/s') {
      if (!/Mozilla|Chrome/i.test(req.headers['user-agent'] || '')) return html(503, '<html><head><title>500 - An error occurred</title></head><body>Sorry! Something went wrong.</body></html>');
      const hits = searchHits(shop, (u.searchParams.get('k') || '').replace(/\s*\btcg\b/i, ''));
      return html(200, `<!doctype html><html><head><title>Amazon.com.au : ${esc(u.searchParams.get('k'))}</title></head><body><div class="s-main-slot s-search-results">${hits.map((x) => `<div data-asin="${x.sku}" data-component-type="s-search-result" class="s-result-item">
        <img class="s-image" src="${imagePath(shop, x)}"><h2 aria-label="${esc(x.name)}" class="a-size-base-plus"><span>${esc(x.name)}</span></h2>
        ${x.status === 'in_stock' || x.status === 'preorder' ? `<span class="a-price"><span class="a-offscreen">$${x.price.toFixed(2)}</span></span>` : '<span class="a-color-secondary">Currently unavailable.</span>'}
      </div>`).join('')}</div></body></html>`);
    }
    // EB Games' search JSON (what its search page's own script asks for, and Mugibot's sweeps read).
    if (shop === 'ebgames' && sub === '/search/query') {
      const all = searchHits(shop, u.searchParams.get('q'));
      const day = 86400000;
      return json(200, {
        totalResults: all.length,
        aggregation: {},
        results: all.map((x) => ({
          sku: x.sku, title: x.name, productUrl: pathFor(shop, x).replace(/^\/ebgames/, ''), imageUrl: `http://${req.headers.host}${imagePath(shop, x)}`,
          price: x.was || x.price, promotionPrice: x.was ? x.price : null, isOutOfStock: x.status === 'out_of_stock', isUnavailable: false,
          isComingSoon: x.status === 'coming_soon', isPreowned: false, releaseDate: new Date(Date.now() + (x.status === 'preorder' ? 30 : -30) * day).toISOString(),
        })),
      });
    }
    // Kmart's search provider (Constructor.io) — what Mugibot's live sweeps read for Kmart: each
    // product with its sellers and the states it's out of stock in (every state: sold out online).
    const cio = shop === 'kmart' && sub.match(/^\/cnstrc\/search\/([^/]+)$/);
    if (cio) {
      const all = searchHits(shop, decodeURIComponent(cio[1]));
      const per = Number(u.searchParams.get('num_results_per_page')) || 20;
      const pg = Number(u.searchParams.get('page')) || 1;
      const states = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
      return json(200, {
        response: {
          total_num_results: all.length,
          results: all.slice((pg - 1) * per, pg * per).map((x) => ({
            value: x.name,
            data: {
              id: `P_${x.sku}`, url: pathFor(shop, x).replace(/^\/kmart/, ''), image_url: `http://${req.headers.host}${imagePath(shop, x)}`, price: x.price,
              Seller: [x.marketplace ? 'Marketplace' : 'Kmart'], isPreOrderActive: x.status === 'preorder',
              ...(x.was ? { SavePrice: `WAS $${x.was}` } : {}),
              ...(x.status === 'in_stock' || x.status === 'preorder' ? {} : { stateOOS: Object.fromEntries(states.map((st) => [st, '6'])) }),
            },
          })),
        },
        request: { term: decodeURIComponent(cio[1]), page: pg },
      });
    }
    // Shopify's search suggestions (what Mugibot's live sweeps read at JB Hi-Fi).
    if (SHOPIFY.has(shop) && sub === '/search/suggest.json') {
      const hits = searchHits(shop, u.searchParams.get('q')).slice(0, 10);
      return json(200, {
        resources: {
          results: {
            products: hits.map((x, i) => ({
              id: x.id, handle: x.sku, title: x.name, price: x.price.toFixed(2), available: x.status === 'in_stock' || x.status === 'preorder',
              url: `${pathFor(shop, x)}?_pos=${i + 1}&_sid=dummy&_ss=r`, image: `http://${req.headers.host}${imagePath(shop, x)}`, vendor: 'Dummy', tags: [], type: 'TRADING CARDS',
            })),
          },
        },
      });
    }
    // Shopify's collections and each one's product list (what Mugibot's live sweeps read at Trainer Town):
    // a collection per game, of the products whose name says it.
    if (shop === 'trainertown' && (sub === '/collections.json' || /^\/collections\/[^/]+\/products\.json$/.test(sub))) {
      const listed = shopOf(shop).products.filter((x) => x.listed);
      const games = [['pokemon-cards', 'Pokémon Cards', 'pokemon'], ['one-piece-trading-card-game', 'One Piece Trading Card Game', 'one-piece']];
      const inGame = (word) => listed.filter((x) => slugify(x.name).includes(word));
      if (sub === '/collections.json') return json(200, { collections: games.map(([handle, title, word]) => ({ id: handle.length, handle, title, products_count: inGame(word).length })) });
      const game = games.find(([handle]) => sub === `/collections/${handle}/products.json`);
      if (!game) return json(404, { errors: 'Not Found' });
      return json(200, {
        products: inGame(game[2]).map((x) => ({
          id: x.id, title: x.name, handle: x.sku, body_html: '<p>Dummy</p>', product_type: 'Trading Cards', tags: x.status === 'preorder' ? ['Pre-Order'] : [],
          variants: [{ id: x.id, title: 'Default Title', price: x.price.toFixed(2), compare_at_price: x.was ? x.was.toFixed(2) : null, available: x.status === 'in_stock' || x.status === 'preorder' }],
          images: [{ src: `http://${req.headers.host}${imagePath(shop, x)}` }],
        })),
      });
    }

    // Shopify's whole product list, newest first (what Mugibot's live sweeps read at Gamerholic).
    if (SHOPIFY.has(shop) && sub === '/products.json') {
      const listed = shopOf(shop).products.filter((x) => x.listed).slice().reverse();
      return json(200, { products: listed.slice(0, Number(u.searchParams.get('limit')) || 30).map((x) => ({
          id: x.id, title: x.name, handle: x.sku, body_html: '<p>Dummy</p>', product_type: 'Trading Cards', tags: x.status === 'preorder' ? ['Pre-Order'] : [],
          variants: [{ id: x.id, title: 'Default Title', price: x.price.toFixed(2), compare_at_price: x.was ? x.was.toFixed(2) : null, available: x.status === 'in_stock' || x.status === 'preorder' }],
          images: [{ src: `http://${req.headers.host}${imagePath(shop, x)}` }],
        })) });
    }

    // ---------------- CrystalCommerce (The Games Cube): the cart API its pages use
    if (shop === 'thegamescube' && sub === '/api/v1/cart/line_items' && req.method === 'POST') {
      const b = await parseBody(req);
      S.addedAt = Date.now();
      const items = [];
      for (const li of (b.line_items || [])) {
        const prod = S.products.find((x) => x.id === Number(li.variant_id));
        if (prod && addToCart(shop, prod.sku, li.qty).ok) items.push({ id: prod.id, name: prod.name, qty: Number(li.qty) || 1, variant_id: prod.id, product_id: Number(prod.sku), price_cents: Math.round(prod.price * 100) });
      }
      return json(200, { line_items: items, count: bagCount(shop), errors: items.length ? undefined : { base: ['Out of stock'] } });
    }
    if (shop === 'thegamescube' && sub === '/api/v1/cart') {
      return json(200, { carts: [{ type: 'Order', currency: 'AUD', line_items_count: bagCount(shop), total_cents: Math.round(total(shop) * 100), links: { checkout: '/checkout/proceed_to_checkout', cart: '/checkout/cart' }, line_items: [] }] });
    }

    if (sub === '/api/cart/add' && req.method === 'POST') {
      const b = await parseBody(req);
      S.addedAt = Date.now();
      if (S.addNeedsLoad && !(req.headers.cookie || '').includes(`mgb_started=${S.startToken}`)) {
        S.refusedEarly = (S.refusedEarly || 0) + 1;
        return json(403, { ok: false, error: 'Forbidden' });
      }
      if (S.addDelayMs) await new Promise((r) => setTimeout(r, S.addDelayMs));
      const refuse = S.refuseAdds === true || (typeof S.refuseAdds === 'number' && S.refuseAdds > 0);
      if (typeof S.refuseAdds === 'number' && S.refuseAdds > 0) S.refuseAdds -= 1;
      const r = refuse ? { ok: false, said: S.quiet ? 'Something went wrong. Please try again.' : undefined } : addToCart(shop, b.sku, b.qty);
      return json(r.ok ? 200 : 409, r);
    }
    // Shopify cart links: /cart/<variant>:<quantity> puts the product in the cart and opens checkout.
    const permalink = SHOPIFY.has(shop) && sub.match(/^\/cart\/(\d+):(\d+)$/);
    if (permalink) {
      const prod = S.products.find((x) => String(x.id) === permalink[1]);
      if (prod) addToCart(shop, prod.sku, Number(permalink[2]) || 1);
      return redirect(pastCheckpoint() ? `/${shop}/checkouts/c/abc123` : `/${shop}/checkpoint?return_to=${encodeURIComponent(`/${shop}/checkouts/c/abc123`)}`);
    }
    if (sub === '/cart/add' && SHOPIFY.has(shop)) {
      const prod = S.products.find((x) => String(x.id) === u.searchParams.get('id'));
      if (prod) addToCart(shop, prod.sku, Number(u.searchParams.get('quantity') || 1));
      return redirect(`/${shop}/cart`);
    }
    if (sub === '/api/cart/update' && req.method === 'POST') {
      const b = await parseBody(req);
      const line = S.cart.find((c) => c.sku === b.sku);
      if (!line) return json(404, { ok: false });
      line.qty = Math.max(1, Math.min(Number(find(shop, b.sku)?.maxQty) || 10, Number(b.qty) || 1));
      return json(200, { ok: true, qty: line.qty });
    }
    if (sub === '/cart' || sub === '/cart/') {
      S.bagViews.push(bagCount(shop));
      return html(200, cartPage(shop));
    }
    if (sub === '/api/checkout/step' && req.method === 'POST') {
      const b = await parseBody(req);
      S.steps.push(b);
      S.data[b.step] = b.data;
      return json(200, { ok: true });
    }
    if (sub === '/checkout/place' && req.method === 'POST') {
      const b = await parseBody(req);
      if (S.decline) { S.declined = (S.declined || 0) + 1; return json(402, { ok: false, error: 'Your card was declined. Please try another card.' }); }
      if (S.threeDS) { S.challenged = (S.challenged || 0) + 1; return json(200, { ok: false, challenge: `${cardOrigin}/acs/challenge` }); }
      S.orders.push({ cart: S.cart.slice(), data: { ...S.data }, form: b, ts: Date.now() });
      S.cart = [];
      return shop === 'ebgames' ? redirect('/ebgames/checkout/confirmation') : json(200, { ok: true });
    }
    if (sub === '/checkout/confirmation') return html(200, page(shop, 'Order confirmed', `<h1>Thank you for your order!</h1><p>Order number: DUMMY-${1000 + S.orders.length}</p>`));

    // ---------------- Amazon-style checkout: "Buy Now" → (signed out: sign in) → maybe the Prime offer
    // → checkout with the address and card saved in your Amazon account → "Place your order"
    if (shop === 'amazon') {
      const a = (title, body) => html(200, page(shop, title, body));
      const signedIn = !!state.signedIn.amazon;
      const line = () => S.cart.map((c) => `<li>${esc(c.name)} x ${c.qty}</li>`).join('');
      const summary = (place) => `<div class="a-box"><p>Delivering to Ash Ketchum, 1 Pallet Town Rd, Sydney NSW 2000</p><p>Paying with Visa ending in 4242</p>
        <ul>${line()}</ul><p class="order-total">Order total: $${total(shop).toFixed(2)}</p>
        <form method="post" action="${place}"><span class="a-button"><input type="submit" id="placeYourOrder" class="a-button-input" aria-labelledby="pyo-text"><span id="pyo-text" class="a-button-text">Place your order</span></span></form></div>`;
      if (sub === '/checkout/entry/buynow' && req.method === 'POST') {
        const b = await parseBody(req);
        if (!signedIn) return redirect('/amazon/ap/signin?openid.return_to=checkout');
        const prod = find(shop, b.asin);
        S.cart = prod ? [{ sku: prod.sku, qty: 1, price: prod.price, name: prod.name }] : [];
        S.steps.push({ step: 'buynow' });
        return redirect(S.primeOffer && !S.primeDeclined ? '/amazon/gp/buy/primeinterstitial/handlers/display.html' : '/amazon/checkout/p/p-123/spc');
      }
      // Your Account: signed out, Amazon sends you to sign in.
      if (sub === '/gp/css/homepage.html') return signedIn ? a('Your Account', '<h1>Your Account</h1>') : redirect('/amazon/ap/signin?openid.return_to=homepage');
      if (sub === '/ap/signin') return a('Amazon Sign-In','<h1>Sign in</h1><label>Email or mobile phone number <input name="email" type="email"></label><button type="button">Continue</button>');
      if (sub === '/gp/buy/primeinterstitial/handlers/display.html') {
        return a('Try Prime', `<h1>Try Prime FREE for 30 days</h1><p>Get FREE fast delivery on this order and millions of items.</p>
          <form method="post" action="/amazon/gp/buy/primeinterstitial/join"><button type="submit" id="prime-join">Start your free trial</button></form>
          <p><a id="prime-decline" href="/amazon/gp/buy/primeinterstitial/decline">No thanks</a></p>`);
      }
      if (sub === '/gp/buy/primeinterstitial/join') { S.joinedPrime = true; return redirect('/amazon/checkout/p/p-123/spc'); }
      if (sub === '/gp/buy/primeinterstitial/decline') { S.primeDeclined = true; S.steps.push({ step: 'prime-declined' }); return redirect('/amazon/checkout/p/p-123/spc'); }
      if (sub === '/checkout/p/p-123/spc') return a('Checkout', `<h1>Review your order</h1>${summary('/amazon/checkout/spc/place-order')}`);
      if (sub === '/checkout/turbo') {
        const prod = find(shop, u.searchParams.get('asin'));
        S.cart = prod ? [{ sku: prod.sku, qty: 1, price: prod.price, name: prod.name }] : [];
        S.steps.push({ step: 'turbo' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html><body style="font:14px system-ui;margin:8px"><h3>Buy now</h3>${summary('/amazon/checkout/turbo/place')}</body></html>`);
      }
      if ((sub === '/checkout/spc/place-order' || sub === '/checkout/turbo/place') && req.method === 'POST') {
        if (S.decline) { S.declined = (S.declined || 0) + 1; return a('Checkout', '<p class="err" role="alert">Your payment was declined. Please choose another payment method.</p>'); }
        S.orders.push({ cart: S.cart.slice(), data: { ...S.data }, turbo: sub.includes('turbo'), ts: Date.now() });
        S.cart = [];
        if (sub.includes('turbo')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><html><body style="font:14px system-ui"><h3>Order placed, thanks!</h3><p>Your order has been placed.</p></body></html>'); }
        return redirect('/amazon/gp/buy/thankyou/handlers/display.html');
      }
      if (sub === '/gp/buy/thankyou/handlers/display.html') return a('Thank you', '<h1>Order placed, thanks!</h1><p>Your order has been placed. Confirmation will be sent to your email.</p>');
    }

    // ---------------- Kmart-style one-page checkout
    if (shop === 'kmart' && sub === '/checkout') {
      // (Like kmart.com.au: checkout with an empty bag opens the bag instead.)
      if (!S.cart.length) return redirect('/kmart/cart');
      return html(200, page(shop, 'Checkout', kmartCheckout()));
    }
    // ---------------- City Beach-style checkout (its stages in ?stage=; an empty bag opens the bag)
    if (shop === 'citybeach' && sub === '/checkout') {
      if (!S.cart.length) return redirect('/citybeach/cart');
      if (!u.searchParams.get('stage')) return redirect('/citybeach/checkout?stage=customer#customer');
      return html(200, page(shop, 'Checkout', citybeachCheckout()));
    }
    // ---------------- Target-style one-page checkout (/checkout opens it at /spc/order)
    if (shop === 'target' && sub === '/checkout') return redirect('/target/spc/order');
    if (shop === 'target' && sub === '/spc/order') return html(200, page(shop, 'Checkout', targetCheckout()));
    // ---------------- BIG W-style checkout
    if (shop === 'bigw' && sub === '/checkout') return html(200, page(shop, 'Checkout', bigwCheckout()));

    // ---------------- EB Games-style one-page checkout, as the real one goes
    if (shop === 'ebgames' && sub === '/checkout') {
      if (!S.cart.length) return redirect('/ebgames/cart');
      return html(200, page(shop, 'Checkout', ebgamesCheckout()));
    }

    // ---------------- CrystalCommerce checkout (The Games Cube): guest → address → shipping and payment
    if (shop === 'thegamescube' && sub.startsWith('/checkout')) {
      const gc = (title, body) => html(200, page(shop, title, body));
      if (sub === '/checkout/cart') {
        S.bagViews.push(bagCount(shop));
        return html(200, cartPage(shop));
      }
      if (sub === '/checkout/proceed_to_checkout') {
        return gc('Checkout', '<p>Proceeding to checkout... <a id="proceed-to-checkout-manually" href="/thegamescube/checkout/index">Click here if you are not redirected automatically.</a></p><script>setTimeout(() => { location.href = "/thegamescube/checkout/index"; }, 300);</script>');
      }
      if (sub === '/checkout/customers' && req.method === 'POST') {
        const b = await parseBody(req);
        S.steps.push({ step: 'guest' });
        S.data.contact = { name: b['customer[fullname]'], email: b['customer[email]'] };
        return redirect('/thegamescube/checkout/index');
      }
      if (sub === '/checkout/address' && req.method === 'POST') {
        const b = await parseBody(req);
        S.steps.push({ step: 'address' });
        S.data.address = b;
        return redirect('/thegamescube/checkout/index');
      }
      if (sub === '/checkout/create' && req.method === 'POST') {
        S.orders.push({ cart: S.cart.slice(), data: { ...S.data }, form: await parseBody(req), ts: Date.now() });
        S.cart = [];
        return gc('Order complete', '<h1>Thank you for your order!</h1>');
      }
      if (sub === '/checkout/index') {
        const lines = S.cart.map((c) => `<li>${esc(c.name)} x ${c.qty}</li>`).join('') || '<li>Your cart is empty</li>';
        if (!S.data.contact) {
          return gc('Checkout', `<h2>Checkout is fast, easy, and secure</h2>
            <form action="/thegamescube/checkout/session" method="post" id="existing_member_form"><h3>Sign in</h3>
              <label for="existing_customer_email">Email</label><input id="existing_customer_email" name="customer[email]" type="text">
              <label for="existing_customer_password">Password</label><input id="existing_customer_password" name="customer[password]" type="password">
              <input class="btn btn--login" name="commit" type="submit" value="Login"></form>
            <form action="/thegamescube/checkout/customers" method="post" id="new_member_form"><h3>Checkout as a guest</h3><p>Continue as a guest. You may create an account after checkout.</p>
              <label for="customer_fullname">Name</label><input id="customer_fullname" name="customer[fullname]" type="text">
              <label for="customer_email">Email</label><input id="customer_email" name="customer[email]" type="text">
              <input class="btn btn--neutral" id="customer_submit" name="commit" type="submit" value="Checkout as a guest"></form>
            <h3>Your Cart</h3><ul>${lines}</ul>`);
        }
        if (!S.data.address) {
          return gc('Checkout', `<h2>1. Shipping Address</h2><form action="/thegamescube/checkout/address" method="post">
            <label>First Name <input name="address[first_name]" autocomplete="shipping given-name" required></label>
            <label>Last Name <input name="address[last_name]" autocomplete="shipping family-name" required></label>
            <label>Address Line 1 <input name="address[street]" autocomplete="shipping address-line1" required></label>
            <label>Address line 2 (Optional) <input name="address[street2]" autocomplete="shipping address-line2"></label>
            <label>City <input name="address[city]" autocomplete="shipping address-level2" required></label>
            <label>State (Abbrev.) <input name="address[state]" required maxlength="3" style="width:80px"></label>
            <label>Zip <input name="address[postcode]" required></label>
            <label>Country <select name="address[country]" required><option value="">Select Country</option><option value="NZ">New Zealand</option><option value="AU">Australia</option></select></label>
            <label>Phone <input name="address[phone]" type="tel" autocomplete="tel" required></label>
            <button type="submit">Continue</button></form><h3>Your Cart</h3><ul>${lines}</ul>`);
        }
        return gc('Checkout', `<form action="/thegamescube/checkout/create" method="post" id="place_order_form">
          <h2>2. Shipping Method</h2>
          <h4>Pick Up</h4><label><input type="radio" name="shipping" value="pickup"> Pick up in store (free)</label>
          <h4>Parcel Post</h4>
          <label><input type="radio" name="shipping" value="parcel"> Australia Post (2-6 business days) — AUD$ 10.00</label>
          <label><input type="radio" name="shipping" value="parcel_tracked"> Australia Post Tracked — AUD$ 14.00</label>
          <h4>Express Post</h4><label><input type="radio" name="shipping" value="express"> Australia Post Express — AUD$ 18.00</label>
          <h2>3. Payment Method</h2>
          <p>Total: AUD$ ${(total(shop) + 10).toFixed(2)}</p>
          <button type="button" id="paypal-checkout" class="paypal-button" onclick="document.title='paypal'">Checkout with PayPal</button>
          <h3>Your Cart</h3><ul>${lines}</ul></form>
          <script>for (const r of document.querySelectorAll('input[name=shipping]')) r.addEventListener('change', () => fetch('/thegamescube/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'shipping', data: { shipping: r.value } }) }));</script>`);
      }
    }

    // ---------------- Pokémon Center-style checkout: guest → shipping → payment (card frame)
    if (shop === 'pokemoncenter' && sub.startsWith('/checkout')) {
      if (sub === '/checkout' && req.method === 'POST') {
        const b = await parseBody(req);
        S.data[b.step] = b;
        S.steps.push({ step: b.step });
        return redirect('/pokemoncenter/checkout');
      }
      const lines = S.cart.map((c) => `<li>${esc(c.name)} x ${c.qty}</li>`).join('');
      if (!S.data.guest) {
        return html(200, page(shop, 'Checkout', `<h1>Checkout</h1><form method="post"><input type="hidden" name="step" value="guest">
          <label>Email address <input name="email" type="email" autocomplete="email" required></label>
          <button type="submit">Continue as Guest</button></form><ul>${lines}</ul>`));
      }
      if (!S.data.shipping) {
        return html(200, page(shop, 'Checkout', `<h1>Shipping</h1><form method="post"><input type="hidden" name="step" value="shipping">
          <label>First name <input name="firstName" autocomplete="given-name" required></label>
          <label>Last name <input name="lastName" autocomplete="family-name" required></label>
          <label>Street address <input name="address1" autocomplete="address-line1" required></label>
          <label>Apartment, unit (optional) <input name="address2" autocomplete="address-line2"></label>
          <label>Suburb <input name="city" autocomplete="address-level2" required></label>
          <label>State <select name="state" autocomplete="address-level1" required>${STATES}</select></label>
          <label>Postcode <input name="postcode" autocomplete="postal-code" required></label>
          <label>Phone number <input name="phone" type="tel" autocomplete="tel" required></label>
          <button type="submit">Continue to Payment</button></form>`));
      }
      return html(200, page(shop, 'Checkout', `<h1>Payment</h1><p>Shipping to ${esc(S.data.shipping.address1)}</p>
        <p><b>Pay with card</b></p>${cardBoxes('generic')}<form action="/pokemoncenter/checkout/place" method="post"><button type="submit">Place Order</button></form>`));
    }

    // ---------------- Premium Bandai-style checkout: the whole checkout in a Global-e-style frame
    if (shop === 'pbandai' && sub === '/checkout') {
      S.data.checkoutOpened = Date.now();
      return html(200, page(shop, 'Checkout', `<h1>Checkout</h1><p>Your order is handled by our checkout partner.</p>
        <iframe id="ge-frame" src="${cardOrigin}/ge-checkout" width="600" height="1100" style="border:1px solid #ccc"></iframe>
        <script>addEventListener('message', (e) => { if (e.data && e.data.gePlaced) location.href = '/pbandai/checkout/confirmation'; });</script>`));
    }

    // ---------------- Shopify-style one-page checkout (JB Hi-Fi, Trainer Town, Gamerholic, Toys"R"Us)
    if (SHOPIFY.has(shop) && sub.startsWith('/checkouts/c/abc123')) {
      if (sub.endsWith('/thank-you')) return html(200, page(shop, 'Thank you', '<h1>Thank you for your purchase!</h1><p>Your order is confirmed.</p>'));
      if (!pastCheckpoint()) return redirect(`/${shop}/checkpoint?return_to=${encodeURIComponent(`/${shop}/checkouts/c/abc123`)}`);
      if (req.method === 'POST') {
        const b = await parseBody(req);
        const shopPay = state.signedIn[shop] === 'shop';
        // Like Shopify: no shipping method, or no card (unless Shop Pay has one), and it's not placed.
        if (!b.shipping) return html(200, page(shop, 'Checkout', '<p class="err" role="alert">Choose a shipping method</p>'));
        if (!shopPay && !b.card_number) return html(200, page(shop, 'Checkout', '<p class="err" role="alert">Enter a card number</p>'));
        if (S.decline) { S.declined = (S.declined || 0) + 1; return html(200, page(shop, 'Checkout', '<p class="err" role="alert">Your card was declined. Please try another card.</p>')); }
        S.orders.push({ form: b, cart: S.cart.slice(), shopPay });
        S.cart = [];
        return redirect(`/${shop}/checkouts/c/abc123/thank-you`);
      }
      S.data.checkoutOpened = Date.now();
      return html(200, page(shop, `Checkout - ${SHOPS[shop].name}`, shopifyCheckout(shop)));
    }

    return html(404, page(shop, 'Page not found', '<h1>Sorry, we can\'t find that page</h1>'));
  });

  const listen = (srv, p) => new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(p, host, () => { srv.off('error', reject); resolve(); });
  });
  // Listening on every interface (0.0.0.0) still means "this computer" in links.
  const linkHost = ['0.0.0.0', '::'].includes(host) ? 'localhost' : host;
  await listen(cardServer, cardPort);
  cardOrigin = `http://${linkHost}:${cardServer.address().port}`;
  try {
    await listen(server, port);
  } catch (e) {
    cardServer.close();
    throw e;
  }
  const url = `http://${linkHost}:${server.address().port}`;

  return {
    url,
    cardOrigin,
    state,
    shop: (id) => state.shops[id],
    productUrl: (shop, sku) => url + pathFor(shop, find(shop, sku)),
    set(shop, sku, fields) { Object.assign(find(shop, sku), fields); },
    reset() {
      const fresh = defaultShops();
      for (const id of Object.keys(fresh)) state.shops[id] = fresh[id];
      state.account = null;
      state.cardInIframe = false;
      state.blockNonBrowsers = false;
      state.signedIn = {};
    },
    close: () => Promise.all([
      new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
      new Promise((r) => { cardServer.close(() => r()); cardServer.closeAllConnections?.(); }),
    ]),
  };
}
