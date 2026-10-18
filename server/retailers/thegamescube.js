// The Games Cube — an Australian card and games store on CrystalCommerce (a shop platform for
// card stores). As its real checkout goes (a member's walk-through, Oct 2026), tested on the
// CrystalCommerce-style dummy store (/thegamescube); signed in or not, it's the same.
//
// Product page: each option ("Sealed"…) in stock has its own small cart button
//   (an icon, no words) → the store's cart takes it (the header's cart count goes up)
//   → straight to checkout (/checkout/proceed_to_checkout, which opens /checkout/index)
//   → "Checkout as a guest" (name + email), if it asks → 1. Shipping Address: first and last
//   name, address lines 1 and 2, city, state (abbreviated), zip, country, phone → 2. Shipping
//   Method: the first option under "Parcel Post" → 3. Payment Method: only "Checkout with PayPal"
//   — STOP there. (Auto-checkout can't pay with PayPal: it fills everything in and leaves PayPal to you.)
//
// Live sweeps from Mugibot's server: its search pages are made on the server, a tile per
// product with each option's stock and price (the "crystal" reader).

export default {
  id: 'thegamescube',
  name: 'The Games Cube',
  base: 'https://www.thegamescube.com',
  hosts: ['www.thegamescube.com', 'thegamescube.com'],
  devPath: '/thegamescube',
  flowStatus: 'beta',
  flowNote: 'Built from a walk-through of its real checkout; tested on the CrystalCommerce-style dummy store. Parcel Post; it only takes PayPal, so it stops there for you.',
  skuLabel: 'Product number',
  skuHint: 'The number at the end of the link, e.g. …/one_piece_two_legends_booster_box_op08/695722',
  skuFromPath: /\/catalog\/[^/]+\/[^/]+\/(\d+)\/?$/,
  productPath: /^(\/thegamescube)?\/catalog\/[^/]+\/[^/]+\/\d+\/?$/,
  searchPath: '/products/search?q={q}',
  // Search results by relevance, 25–30 a page: page 1 of each keyword in turn, the later pages now and then.
  sweep: { from: 'server', parser: 'crystal', path: '/products/search?q={q}', pagePath: '&page={page}', pages: 4 },
  // Store login monitor: CrystalCommerce marks its header "not-logged-in" until you sign in.
  account: { signIn: '/user/login', check: { path: '/', signedIn: /\/user\/logout|class="(?:[^"]*\s)?logged-in[\s"]/, signedOut: /\bnot-logged-in\b/ } },
  monitor: { server: true, browser: true },
  flow: {
    product: {
      add: [/\badd to cart\b/i, /\bpre-?order\b/i],
      // The cart button is an icon with no words: the first option in stock.
      addSelector: 'form.add-to-cart-form [type="submit"].add-to-cart, form.add-to-cart-form button.add-to-cart',
      waitMs: 12000,
    },
    added: {
      checkout: [/^check ?out\b/i],
      viewBag: [/\b(view|edit) (shopping )?cart\b/i],
    },
    bag: {
      path: /\/checkout\/cart(\/|$)/i,
      checkout: [/^check ?out\b/i, /^proceed to checkout$/i],
    },
    checkout: {
      // Everything under /checkout but the cart.
      path: /\/checkout(\/|$)/i,
      // The store's own Checkout link (its cart says so): it opens /checkout/index.
      url: '/checkout/proceed_to_checkout',
      guest: [/^check ?out as (a )?guest$/i, /^continue as (a )?guest$/i],
      steps: [/^continue( to (shipping|payment))?$/i, /^save( and continue)?$/i, /^next$/i, /^use this address$/i],
      final: [/checkout with paypal/i, /\bplace order\b/i],
      fields: { 'input[name="customer[fullname]"]': 'fullName', 'input[name="customer[email]"]': 'email' },
      delivery: 'home',
      // 2. Shipping Method: the first option under "Parcel Post".
      shipping: [/parcel post/i],
      // 3. Payment Method: PayPal only. ⚡ Buy and Auto-checkout stop there for you.
      payment: 'paypal',
      done: /\/checkout\/(complete|success|thank|receipt|confirmation)|thank-?you/i,
    },
  },
};
