// The Games Cube — DRAFT checkout. An Australian card and games store on
// CrystalCommerce (a shop platform for card stores). Built from its real pages
// (search results, product page, cart and the start of checkout) and tested on
// the CrystalCommerce-style dummy store (/thegamescube); not run end to end on
// thegamescube.com yet.
//
// Product page: each option ("Sealed"…) in stock has its own small cart button
//   (an icon, no words) → the store's cart takes it (the header's cart count goes up)
//   → straight to checkout (/checkout/proceed_to_checkout, which opens /checkout/index)
//   → "Checkout as a guest" (name + email) → 1. Shipping Address → 2. Shipping Method
//   → 3. Payment Options → STOP at "Place Order".
//
// Live sweeps from Mugibot's server: its search pages are made on the server, a tile per
// product with each option's stock and price (the "crystal" reader).

export default {
  id: 'thegamescube',
  name: 'The Games Cube',
  base: 'https://www.thegamescube.com',
  hosts: ['www.thegamescube.com', 'thegamescube.com'],
  devPath: '/thegamescube',
  flowStatus: 'draft',
  flowNote: 'Built from its real pages; tested on the CrystalCommerce-style dummy store. Not run end to end on thegamescube.com yet.',
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
      final: [/\bplace order\b/i],
      fields: { 'input[name="customer[fullname]"]': 'fullName', 'input[name="customer[email]"]': 'email' },
      delivery: 'home',
      payment: 'card',
      done: /\/checkout\/(complete|success|thank|receipt|confirmation)|thank-?you/i,
    },
  },
};
