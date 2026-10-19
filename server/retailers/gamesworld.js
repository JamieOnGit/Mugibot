// Games World — an Australian games and toy store (board games, trading cards, models) on
// WooCommerce. As its real checkout goes (a member's walk-through, Oct 2026), tested on the
// WooCommerce-style dummy store (/gamesworld):
//
// ⚡ Buy: WooCommerce's own add-to-cart link (/checkout/?add-to-cart=<product>&quantity=1) — the
//   product page's "Add to cart" → cart → "Proceed to checkout", in one go (a product with options
//   to pick: its "Add to cart" pressed instead). At checkout: email, first and last name,
//   Country/Region (Australia already), street address, suburb, state (a drop-down, full names —
//   WooCommerce draws its own over the real one), postcode, phone; "Deliver to a different
//   address?" unticked (it can come ticked) → the shipping method it picked (Standard) → Stripe's
//   card form: card number, expiration date (MM/YY), security code — or, with Stripe's Link
//   connected, its "Confirm" → STOP at "Place order" (an armed Auto-checkout run presses it, after
//   its checks). Signed in with your details saved: the same, everything already there.
//
// Live sweeps from Mugibot's server (an admin's browser stands in only while it's refused):
// WooCommerce's own product API, a search per keyword, newest first, with stock, price and the
// product's id for the add-to-cart link — only the fields Mugibot reads (about 100 KB a search).

import { ADD_WORDS } from '../monitor/words.js';

export default {
  id: 'gamesworld',
  name: 'Games World',
  base: 'https://www.gamesworld.com.au',
  hosts: ['www.gamesworld.com.au', 'gamesworld.com.au'],
  devPath: '/gamesworld',
  platform: 'woocommerce',
  flowStatus: 'beta',
  flowNote: 'Built from a walk-through of its real checkout; tested on the WooCommerce-style dummy store. Straight to checkout with its add-to-cart link, your details (delivered to the same address), Stripe\'s card form or Link, stops at "Place order".',
  skuLabel: 'Product link name',
  skuHint: 'The part after /product/ in the link, e.g. one-piece-starter-deck-sabo-st35',
  skuFromPath: /\/product\/([^/?#]+)\/?$/,
  productPath: /^(\/gamesworld)?\/product\/[^/?#]+\/?$/,
  productPathFromSku: '/product/{sku}/',
  // WooCommerce's add-to-cart link: the product (a simple one, by its id) straight into the cart, on the checkout page.
  cartPath: '/checkout/?add-to-cart={variant}&quantity={qty}',
  searchPath: '/?s={q}&post_type=product',
  sweep: {
    from: 'server',
    parser: 'woo',
    path: '/wp-json/wc/store/v1/products?search={q}&per_page=30&orderby=date&order=desc&_fields=id,name,slug,permalink,sku,type,prices,images,is_in_stock,is_purchasable,is_on_backorder,stock_availability,add_to_cart',
    // (A WordPress page made fresh for each search: at most one every 15 s.)
    minSeconds: 15,
  },
  // Store login monitor: WordPress marks every page's body "logged-in" once you're signed in.
  account: { signIn: '/my-account/', check: { path: '/my-account/', signedIn: /<body[^>]*class="[^"]*\blogged-in\b/, signedOut: /<body[^>]*class=/ } },
  monitor: { server: true, browser: true },
  flow: {
    product: { add: ADD_WORDS, waitMs: 12000 },
    added: {
      checkout: [/^(proceed to )?check ?out$/i],
      viewBag: [/^view (cart|basket)$/i],
      confirm: [/has been added to your (cart|basket)/i],
    },
    bag: {
      path: /\/(cart|basket)(\/|$)/i,
      url: '/cart/',
      checkout: [/^proceed to checkout$/i, /^check ?out$/i],
    },
    checkout: {
      path: /\/checkout(\/|$)/i,
      url: '/checkout/',
      // Stripe's Link, when it's connected: its "Confirm" (on the page, or in Stripe's frame) instead of the card boxes.
      steps: [/^confirm$/i],
      frameConfirm: [/^confirm$/i],
      // "Deliver to a different address?": unticked — the order goes to your address (WooCommerce's
      // "Ship to a different address?" elsewhere).
      untick: [/(deliver|ship) to a different address/i],
      final: [/^place order$/i],
      delivery: 'home',
      payment: 'card',
      done: /\/order-received\//i,
    },
  },
};
