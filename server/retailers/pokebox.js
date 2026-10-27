// Pokébox — an Australian trading-card store (Pokémon, One Piece, Lorcana, Dragon Ball, Magic…) on
// Shopify, so ⚡ Buy and Auto-checkout use the Shopify flow, as Pokébox's real checkout goes (a
// member's walk-through, Oct 2026), tested on the Shopify-style dummy store (/pokebox):
//
// ⚡ Buy: Shopify's own cart link (/cart/<variant>:1) — the product page's "Add to cart" → cart →
//   checkout, in one go. Signed in with Shop (Shop Pay): your details and card are already in —
//   STOP at "Pay now". As a guest: first and last name, address (Shopify's suggestions come up as
//   it's typed; suburb, state/territory and postcode are typed in too), phone → the shipping method
//   Shopify picked (left as it is) → card number, expiration date (MM/YY), security code and name on
//   card (Shopify's card fields) with "Use shipping address as billing address" ticked → STOP at
//   "Pay now".
//
// Live sweeps from Mugibot's server (an admin's browser stands in only while it's refused): Pokébox
// lists hundreds of singles a week, named after the card ("Tarragon (116/088)"), so each keyword is
// searched with "tcg" added (Shopify's search suggestions: its sealed products first), and every
// third search is the store's newest products (Shopify's product list, newest published first: a
// week or so of its listings in 30, Oct 2026) — a new drop shows up there the moment it's listed,
// counted for every keyword in one read (each keyword's second page, until then: one keyword's at a
// time, so a keyword saw it every 200 s or so). One it drafted weeks before and has just put up is
// still a drop here (newestFresh: it doesn't republish old products, as JB Hi-Fi does).

import jbhifi from './jbhifi.js';

export default {
  ...jbhifi,
  // (Shopify's checkpoint page, as at JB Hi-Fi: seen on a page here too — only JB's is checked by the server.)
  gate: { ...jbhifi.gate, probe: null },
  id: 'pokebox',
  name: 'Pokébox',
  base: 'https://www.pokebox.com.au',
  hosts: ['www.pokebox.com.au', 'pokebox.com.au'],
  devPath: '/pokebox',
  flowStatus: 'beta',
  flowNote: 'Shopify checkout: Shop Pay (signed in to Shop) or your details and card, the shipping method Shopify picks, billing address the same as shipping, stops at "Pay now". Tested on the Shopify-style dummy store.',
  productPath: /^(\/pokebox)?\/products\/[^/?#.]+$/,
  searchPath: '/search?q={q}&type=product',
  sweep: {
    from: 'server',
    parser: 'shopify',
    // Each keyword's search ("pokemon tcg": its sealed products first, not singles), 10 a search, with stock.
    path: '/search/suggest.json?q={q}&resources%5Btype%5D=product&resources%5Blimit%5D=10&resources%5Boptions%5D%5Bunavailable_products%5D=last',
    addWord: 'tcg',
    // Every third search: the store's newest products (about 200 KB a read: 30 products) — from an admin's
    // browser too, while it stands in for the server.
    newestPath: '/products.json?limit=30',
    newestEvery: 3,
    newestBrowser: true,
    newestFresh: false,
    minSeconds: 10,
  },
  monitor: { server: true, browser: true },
};
