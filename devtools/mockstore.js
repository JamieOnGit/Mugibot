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
//             one-page checkout → "Pay now"
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
};
const LD_AVAIL = { in_stock: 'InStock', preorder: 'PreOrder', out_of_stock: 'OutOfStock' };
const STATES = '<option value="">Select state</option><option value="NSW">New South Wales</option><option value="VIC">Victoria</option><option value="QLD">Queensland</option><option value="WA">Western Australia</option><option value="SA">South Australia</option><option value="TAS">Tasmania</option><option value="ACT">Australian Capital Territory</option><option value="NT">Northern Territory</option>';

export function defaultShops() {
  const out = {};
  for (const [id, list] of Object.entries(DUMMY_PRODUCTS)) {
    out[id] = {
      products: list.map((p, i) => ({ ...p, listed: true, maxQty: 0, qtyStyle: id === 'bigw' ? 'select' : 'input', lateMs: 0, id: 4400000 + i })),
      cart: [], orders: [], steps: [], data: {},
      // Like a real store on a fresh page: "Add" does nothing until the page's code has
      // started (hydrateMs after load), and the add itself can be slow (addDelayMs).
      hydrateMs: 0, addDelayMs: 0, refuseAdds: false,
      // What the bag page showed each time it was opened (number of items in it).
      bagViews: [],
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
.choice[aria-pressed=true]{outline:3px solid #0a0}.dummy{background:#fff3cd;padding:6px 20px;font-size:13px}</style>${head}</head>
<body><div class="dummy">⚠ Dummy store for testing Mugibot — nothing here is real. <a href="/">Control panel</a></div>
<header><a href="${base}/">${esc(s.name)}</a> · ${bagLink(shop, bagCount)}</header><main>${body}</main>
<footer>${esc(s.name)} is a fake store for testing.</footer></body></html>`;
}

// The header's bag link, with the item count like real stores show it.
function bagLink(shop, count) {
  const word = shop === 'kmart' ? 'Bag' : 'Cart';
  const label = count == null ? word : `${word}, ${count} item${count === 1 ? '' : 's'}`;
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
    cardInIframe: false,
    requests: [],
  };
  let cardOrigin = '';

  const shopOf = (id) => state.shops[id];
  const find = (shop, sku) => shopOf(shop) && shopOf(shop).products.find((p) => p.sku === sku);
  const pathFor = (shop, p) => dummyProductPath(shop, p);
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

  const ldFor = (p) => `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: p.sku,
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
    const others = shopOf(shop).products.filter((x) => x.sku !== p.sku && x.listed);
    const other = others[0];
    const labels = {
      kmart: { in_stock: 'Add to bag', preorder: 'Pre-order', out_of_stock: 'Sold out online', coming_soon: 'Coming soon' },
      bigw: { in_stock: 'Add to cart', preorder: 'Pre-order', out_of_stock: 'Out of stock online', coming_soon: 'Coming soon' },
      ebgames: { in_stock: 'Add to Cart', preorder: 'Pre-order Now', out_of_stock: 'Sold Out', coming_soon: 'Coming Soon' },
      jbhifi: { in_stock: 'Add to cart', preorder: 'Pre-order', out_of_stock: 'Sold out', coming_soon: 'Coming soon' },
    }[shop];
    const orderable = p.status === 'in_stock' || p.status === 'preorder';
    if (shop === 'jbhifi') {
      return page(shop, `${p.name} | JB Hi-Fi (dummy)`, `<div class="product-detail"><h1>${esc(p.name)}</h1><div class="price">$${p.price.toFixed(2)}</div>
        <form action="/jbhifi/cart/add" method="get"><input type="hidden" name="id" value="${p.id}">${qtyControl(p)}
        <button type="submit" name="add" ${orderable ? '' : 'disabled'}>${labels[p.status]}</button></form></div>`, { head: ldFor(p) });
    }
    const button = orderable ? `<button type="button" id="atc" class="add-to-cart">${labels[p.status]}</button>` : `<button type="button" class="add-to-cart" disabled>${labels[p.status]}</button>`;
    const drawer = {
      kmart: '<div class="drawer" id="drawer" role="dialog" aria-label="Added to bag"><h3>Added to bag</h3><p id="drawer-msg"></p><a class="btn" href="/kmart/checkout">Checkout</a> <a href="/kmart/cart">View bag</a></div>',
      bigw: '<div class="drawer added-to-cart-drawer" id="drawer" role="dialog" aria-label="Added to cart"><h3>Added to your cart</h3><p id="drawer-msg"></p><a class="btn" href="/bigw/cart">View cart</a> <a href="/bigw/">Continue shopping</a></div>',
      ebgames: '<div class="drawer mini-cart" id="drawer"><h3>Added to cart</h3><p id="drawer-msg"></p><a class="btn" href="/ebgames/checkout">Checkout</a> <a href="/ebgames/cart">View cart</a></div>',
    }[shop];
    return page(shop, `${p.name} | ${SHOPS[shop].name}`, `
      <div class="product-detail">
        <h1>${esc(p.name)}</h1>
        <div class="price">$${p.price.toFixed(2)}</div>
        <p>${shop === 'kmart' ? 'Keycode' : 'Product code'} ${p.sku}</p>
        ${qtyControl(p)}
        <div id="buybox">${p.lateMs ? '<p>Loading…</p>' : button}</div>
      </div>
      <section class="recommendations"><h3>You may also like</h3>
        ${other ? `<div class="tile"><a href="${pathFor(shop, other)}">${esc(other.name)}</a><button type="button" class="add-to-cart">${labels.in_stock}</button></div>` : ''}
      </section>
      ${drawer}
      <script>
        ${p.lateMs ? `setTimeout(() => { document.getElementById('buybox').innerHTML = ${JSON.stringify(button)}; }, ${Number(p.lateMs)});` : ''}
        ${stepperJs(p)}
        // Until the page's code has started, pressing Add does nothing (like a store that's still loading).
        let started = ${shopOf(shop).hydrateMs ? 'false' : 'true'};
        ${shopOf(shop).hydrateMs ? `addEventListener('load', () => setTimeout(() => { started = true; }, ${Number(shopOf(shop).hydrateMs)}));` : ''}
        document.addEventListener('click', async (e) => {
          if (!e.target.closest('#atc') || !started) return;
          ${readQtyJs}
          const r = await fetch('/${shop}/api/cart/add', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({sku:'${p.sku}', qty})});
          const d = await r.json();
          if (!d.ok) return;
          const bag = document.getElementById('bag-link');
          bag.setAttribute('aria-label', '${shop === 'kmart' ? 'Bag' : 'Cart'}, ' + d.items + ' items');
          bag.innerHTML = '${shop === 'kmart' ? 'Bag' : 'Cart'} <span class="bag-count">' + d.items + '</span>';
          setTimeout(() => { document.getElementById('drawer-msg').textContent = d.count + ' item(s) in your ${shop === 'kmart' ? 'bag' : 'cart'}'; document.getElementById('drawer').classList.add('open'); }, 150);
        });
      </script>`, { head: ldFor(p), bagCount: bagCount(shop) });
  }

  function searchPage(shop, q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hits = shopOf(shop).products.filter((x) => x.listed && words.some((w) => slugify(x.name).includes(slugify(w)) || x.sku === w));
    return page(shop, `Search: ${q}`, `<h1>Results for "${esc(q)}"</h1>${hits.map((x) => `<div class="tile product-tile"><a href="${pathFor(shop, x)}">${esc(x.name)}</a><div>$${x.price.toFixed(2)}</div></div>`).join('') || '<p>No results</p>'}`);
  }

  function cartPage(shop) {
    const cart = shopOf(shop).cart;
    const rows = cart.map((c) => {
      const p = find(shop, c.sku);
      const max = Number(p && p.maxQty) || 10;
      const opts = Array.from({ length: max }, (_, i) => `<option value="${i + 1}" ${i + 1 === c.qty ? 'selected' : ''}>${i + 1}</option>`).join('');
      const qty = shop === 'jbhifi' ? `<input type="number" name="updates[]" aria-label="Quantity" data-sku="${c.sku}" value="${c.qty}" min="1" style="width:60px">` : `<select aria-label="Quantity" data-sku="${c.sku}">${opts}</select>`;
      return `<li class="line-item"><div class="line-name"><a href="${p ? pathFor(shop, p) : '#'}">${esc(c.name)}</a></div><div class="line-qty">Qty ${qty}</div></li>`;
    }).join('');
    const go = { kmart: '<a class="btn" href="/kmart/checkout">Checkout</a>', bigw: '<button type="button" id="to-checkout">Proceed to checkout</button>', ebgames: '<a class="btn" href="/ebgames/checkout">Secure Checkout</a>', jbhifi: '<button type="button" id="to-checkout" name="checkout">Check out</button>' }[shop];
    return page(shop, shop === 'kmart' ? 'Your bag' : 'Your cart', `<h1>${shop === 'kmart' ? 'Your bag' : 'Your cart'}</h1><ul class="lines">${rows || '<li>Empty</li>'}</ul><a href="/${shop}/" class="continue">Continue shopping</a> ${cart.length ? go : ''}
      <script>
        for (const s of document.querySelectorAll('[data-sku]')) s.addEventListener('change', () => fetch('/${shop}/api/cart/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: s.dataset.sku, qty: Number(s.value) }) }));
        document.getElementById('to-checkout')?.addEventListener('click', () => { location.href = '${shop === 'jbhifi' ? '/jbhifi/checkouts/c/abc123' : `/${shop}/checkout`}'; });
      </script>`);
  }

  // -------------------------------------------------------------------- checkouts
  function cardBoxes(style) {
    return `<iframe id="card" src="${cardOrigin}/card-frame?style=${style}" width="360" height="190" style="border:1px solid #ccc"></iframe>`;
  }

  function kmartCheckout() {
    const acc = state.account || {};
    const v = (x) => esc(x || '');
    const cardFields = state.cardInIframe ? cardBoxes('kmart')
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
        $('k-place').addEventListener('click', async () => {
          await fetch('/kmart/checkout/place', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data($('k-payment'))) });
          location.href = '/kmart/checkout/confirmation';
        });
        for (const el of document.querySelectorAll('input[name=cardNumber]')) el.addEventListener('input', () => { el.value = el.value.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 '); });
        for (const el of document.querySelectorAll('input[name=cardExpiry]')) el.addEventListener('input', () => { const d = el.value.replace(/\\D/g, '').slice(0, 4); el.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; });
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
  const cardServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/card-frame') {
      const style = u.searchParams.get('style') || 'stripe';
      const fields = style === 'kmart'
        ? '<label>Card number <input name="encryptedCardNumber" aria-label="Card number" inputmode="numeric"></label><label>Expiry <input name="encryptedExpiryDate" aria-label="Expiry date" placeholder="MM/YY"></label><label>CVV <input name="encryptedSecurityCode" aria-label="CVV" inputmode="numeric"></label>'
        : style === 'shopify'
          ? '<input name="number" placeholder="Card number" inputmode="numeric"><input name="name" placeholder="Name on card"><input name="expiry" placeholder="Expiration date (MM / YY)"><input name="verification_value" placeholder="Security code" inputmode="numeric">'
          : '<input name="cardnumber" autocomplete="cc-number" placeholder="Card number" inputmode="numeric"><input name="exp-date" autocomplete="cc-exp" placeholder="MM / YY"><input name="cvc" autocomplete="cc-csc" placeholder="CVC" inputmode="numeric"><input name="ccname" placeholder="Name on card">';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui">${fields}
<style>input{display:block;margin:4px 0;padding:6px;width:260px}</style>
<script>
// Format like real payment widgets do.
for (const el of document.querySelectorAll('input')) {
  el.addEventListener('input', () => {
    if (/number|cardnumber/i.test(el.name)) el.value = el.value.replace(/\\D/g,'').slice(0,16).replace(/(\\d{4})(?=\\d)/g,'$1 ');
    if (/exp/i.test(el.name)) { const d = el.value.replace(/\\D/g,'').slice(0,4); el.value = d.length > 2 ? d.slice(0,2) + ' / ' + d.slice(2) : d; }
  });
}
</script></body></html>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // -------------------------------------------------------------------- store server
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    state.requests.push({ method: req.method, path: p, ua: req.headers['user-agent'] || '' });
    if (state.requests.length > 4000) state.requests.splice(0, 2000);
    const html = (status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); };

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
        <p>Orders placed (should stay 0 — Mugibot never presses the final button): <b>${orders}</b></p>`));
    }

    const m = p.match(/^\/(kmart|bigw|ebgames|jbhifi)(\/.*|$)/);
    if (!m) return html(404, page(null, 'Page not found', '<h1>Page not found</h1>'));
    const shop = m[1];
    const sub = m[2] || '/';
    const S = shopOf(shop);

    if (sub === '/' || sub === '') {
      return html(200, page(shop, SHOPS[shop].name, `<h1>${esc(SHOPS[shop].name)}</h1>${S.products.filter((x) => x.listed).map((x) => `<div class="tile product-tile"><a href="${pathFor(shop, x)}">${esc(x.name)}</a><div>$${x.price.toFixed(2)} · ${x.status.replace(/_/g, ' ')}</div></div>`).join('')}`));
    }

    // Product pages, each in its retailer's link shape.
    let sku = null;
    if (shop === 'kmart') sku = (sub.match(/^\/product\/[^/]*-(\d{6,10})\/?$/) || [])[1];
    if (shop === 'bigw') sku = (sub.match(/^\/product\/[^/]+\/p\/(\d+)$/) || [])[1];
    if (shop === 'ebgames') sku = (sub.match(/^\/product\/[^/]+\/(\d+)-/) || [])[1];
    if (shop === 'jbhifi') {
      const js = sub.match(/^\/products\/([^/]+)\.js$/);
      if (js) {
        const prod = find(shop, js[1]);
        if (!prod || !prod.listed) return json(404, { error: 'not found' });
        return json(200, { id: prod.id, handle: prod.sku, title: prod.name, available: prod.status === 'in_stock' || prod.status === 'preorder', variants: [{ id: prod.id, price: Math.round(prod.price * 100), available: prod.status === 'in_stock' || prod.status === 'preorder' }] });
      }
      sku = (sub.match(/^\/products\/([^/.]+)$/) || [])[1];
    }
    if (sku) {
      const prod = find(shop, sku);
      if (!prod || !prod.listed) return html(404, page(shop, 'Page not found', '<h1>Sorry, we can\'t find that page</h1>'));
      return html(200, productPage(shop, prod));
    }

    if (sub === '/search' || sub === '/search/') return html(200, searchPage(shop, u.searchParams.get('searchTerm') || u.searchParams.get('text') || u.searchParams.get('q') || u.searchParams.get('query') || ''));

    if (sub === '/api/cart/add' && req.method === 'POST') {
      const b = await parseBody(req);
      if (S.addDelayMs) await new Promise((r) => setTimeout(r, S.addDelayMs));
      const r = S.refuseAdds ? { ok: false } : addToCart(shop, b.sku, b.qty);
      return json(r.ok ? 200 : 409, r);
    }
    if (sub === '/cart/add' && shop === 'jbhifi') {
      const prod = S.products.find((x) => String(x.id) === u.searchParams.get('id'));
      if (prod) addToCart(shop, prod.sku, Number(u.searchParams.get('quantity') || 1));
      return redirect('/jbhifi/cart');
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
      S.orders.push({ cart: S.cart.slice(), data: { ...S.data }, form: b, ts: Date.now() });
      S.cart = [];
      return shop === 'ebgames' ? redirect('/ebgames/checkout/confirmation') : json(200, { ok: true });
    }
    if (sub === '/checkout/confirmation') return html(200, page(shop, 'Order confirmed', `<h1>Thank you for your order!</h1><p>Order number: DUMMY-${1000 + S.orders.length}</p>`));

    // ---------------- Kmart-style one-page checkout
    if (shop === 'kmart' && sub === '/checkout') return html(200, page(shop, 'Checkout', kmartCheckout()));
    // ---------------- BIG W-style checkout
    if (shop === 'bigw' && sub === '/checkout') return html(200, page(shop, 'Checkout', bigwCheckout()));

    // ---------------- EB Games-style multi-page checkout
    if (shop === 'ebgames') {
      if (sub === '/checkout') return redirect('/ebgames/checkout/login');
      if (sub === '/checkout/login') {
        return html(200, page(shop, 'Checkout', `<h1>Checkout</h1>
          <div style="display:flex;gap:40px"><form><h3>Sign in</h3><label>Email<input name="login_email" type="email"></label><label>Password<input name="pw" type="password"></label><button type="button">Sign In</button></form>
          <div><h3>New customer?</h3><a class="btn" href="/ebgames/checkout/shipping">Continue as Guest</a></div></div>`));
      }
      if (sub === '/checkout/shipping') {
        if (req.method === 'POST') {
          const b = await parseBody(req);
          const missing = ['email', 'firstName', 'lastName', 'phone', 'street', 'suburb', 'state', 'postcode'].filter((k) => !b[k]);
          if (missing.length) return html(200, page(shop, 'Shipping', `<p class="err">Missing: ${missing.join(', ')}</p><a href="/ebgames/checkout/shipping">Back</a>`));
          S.data.shipping = b;
          return redirect('/ebgames/checkout/delivery');
        }
        return html(200, page(shop, 'Shipping details', `<h1>Shipping details</h1>
          <form method="post" id="ship">
            <label>Email address <input name="email" type="email" required></label>
            <label>First name <input name="firstName" required></label>
            <label>Last name <input name="lastName" required></label>
            <label>Mobile number <input name="phone" type="tel" required></label>
            <label for="lookup">Start typing your address</label><input id="lookup" name="addressLookup" placeholder="Start typing your address">
            <p><a href="#" id="manual">Enter address manually</a></p>
            <div id="manual-fields" style="display:none">
              <label>Street address <input name="street"></label>
              <label>Unit / apartment <input name="unit"></label>
              <label>Suburb <input name="suburb"></label>
              <label>State <select name="state">${STATES}</select></label>
              <label>Postcode <input name="postcode" maxlength="4"></label>
            </div>
            <label><input type="checkbox" name="news"> Send me news and offers</label>
            <button type="submit">Continue to delivery</button>
          </form>
          <script>document.getElementById('manual').addEventListener('click', e => { e.preventDefault(); document.getElementById('manual-fields').style.display='block'; for (const n of ['street','suburb','state','postcode']) document.querySelector('[name='+n+']').required = true; });</script>`));
      }
      if (sub === '/checkout/delivery') {
        if (req.method === 'POST') {
          const b = await parseBody(req);
          if (!b.delivery) return html(200, page(shop, 'Delivery', '<p class="err">Choose a delivery option</p><a href="/ebgames/checkout/delivery">Back</a>'));
          S.data.delivery = b.delivery;
          return redirect('/ebgames/checkout/payment');
        }
        return html(200, page(shop, 'Delivery', `<h1>Delivery</h1><form method="post">
          <label><input type="radio" name="delivery" value="collect"> Click &amp; Collect (free)</label>
          <label><input type="radio" name="delivery" value="standard"> Standard Delivery $9.95</label>
          <label><input type="radio" name="delivery" value="express"> Express Delivery $14.95</label>
          <button type="submit">Continue to payment</button></form>`));
      }
      if (sub === '/checkout/payment') {
        return html(200, page(shop, 'Payment', `<h1>Payment</h1><form method="post" action="/ebgames/checkout/place">
          <label><input type="radio" name="method" value="card"> Credit / debit card</label>
          <label><input type="radio" name="method" value="paypal"> PayPal</label>
          <label><input type="radio" name="method" value="afterpay"> Afterpay</label>
          ${cardBoxes('stripe')}
          <label class="terms"><input type="checkbox" name="terms" required> I agree to the Terms &amp; Conditions</label>
          <label><input type="checkbox" name="marketing"> Subscribe to our newsletter</label>
          <p>Total: $${(total('ebgames') + 9.95).toFixed(2)}</p>
          <button type="submit" id="place">Place Order</button></form>`));
      }
    }

    // ---------------- Shopify-style one-page checkout (JB Hi-Fi)
    if (shop === 'jbhifi' && sub.startsWith('/checkouts/c/abc123')) {
      if (sub.endsWith('/thank-you')) return html(200, page(shop, 'Thank you', '<h1>Thank you for your purchase!</h1><p>Your order is confirmed.</p>'));
      if (req.method === 'POST') {
        const b = await parseBody(req);
        S.orders.push({ form: b, cart: S.cart.slice() });
        S.cart = [];
        return redirect('/jbhifi/checkouts/c/abc123/thank-you');
      }
      S.data.checkoutOpened = Date.now();
      return html(200, page(shop, 'Checkout - JB Hi-Fi (dummy)', `<h1>Checkout</h1><form method="post">
        <h3>Contact</h3><input name="email" type="email" autocomplete="email" placeholder="Email" required>
        <h3>Delivery</h3>
        <select name="countryCode" autocomplete="shipping country"><option value="AU" selected>Australia</option><option value="NZ">New Zealand</option></select>
        <input name="firstName" autocomplete="shipping given-name" placeholder="First name" required>
        <input name="lastName" autocomplete="shipping family-name" placeholder="Last name" required>
        <input name="address1" autocomplete="shipping address-line1" placeholder="Address" required>
        <input name="address2" autocomplete="shipping address-line2" placeholder="Apartment, suite, etc. (optional)">
        <input name="city" autocomplete="shipping address-level2" placeholder="Suburb" required>
        <select name="zone" autocomplete="shipping address-level1" required><option value="" disabled selected>State/territory</option><option value="ACT">Australian Capital Territory</option><option value="NSW">New South Wales</option><option value="VIC">Victoria</option><option value="QLD">Queensland</option></select>
        <input name="postalCode" autocomplete="shipping postal-code" placeholder="Postcode" required>
        <input name="phone" autocomplete="shipping tel" placeholder="Phone" type="tel">
        <h3>Shipping method</h3><label><input type="radio" name="shipping" value="standard" checked> Standard $10.00</label>
        <h3>Payment</h3>${cardBoxes('shopify')}
        <p>Total: $${(total('jbhifi') + 10).toFixed(2)}</p>
        <button type="submit" id="pay">Pay now</button></form>`));
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
    },
    close: () => Promise.all([
      new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
      new Promise((r) => { cardServer.close(() => r()); cardServer.closeAllConnections?.(); }),
    ]),
  };
}
