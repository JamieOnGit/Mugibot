// Gamerholic — an Australian games and cards store on Shopify, so ⚡ Buy uses the Shopify
// flow: Shopify's own cart link straight into its one-page checkout. As Gamerholic's real
// checkout goes (a member's walk-through, Oct 2026), tested on the Shopify-style dummy store
// (/gamerholic): signed in with Shop (Shop Pay), straight to "Pay now"; as a guest: email,
// delivery (country/region, first and last name, address, suburb, state/territory, postcode,
// phone — optional) → shipping method "Standard Shipping" → card number, expiration date
// (MM/YY) and security code (Shopify's card fields) → STOP at "Pay now".
//
// Live sweeps from Mugibot's server: Gamerholic lists hundreds of new products a
// day (pre-orders from its suppliers, cards, toys), so the sweeps read its newest
// products — Shopify's product list, newest first, with every option's stock —
// and keep the ones each keyword names. A new drop shows up there the moment
// it's listed.

import jbhifi from './jbhifi.js';

export default {
  ...jbhifi,
  // (Shopify's checkpoint page, as at JB Hi-Fi: seen on a page here too — only JB's is checked by the server.)
  gate: { ...jbhifi.gate, probe: null },
  id: 'gamerholic',
  name: 'Gamerholic',
  base: 'https://gamerholic.com.au',
  hosts: ['gamerholic.com.au', 'www.gamerholic.com.au'],
  devPath: '/gamerholic',
  flowStatus: 'beta',
  flowNote: 'Shopify checkout: Shop Pay or your details and card, Standard Shipping, stops at "Pay now". Tested on the Shopify-style dummy store.',
  productPath: /^(\/gamerholic)?\/products\/[^/?#.]+$/,
  searchPath: '/search?q={q}&type=product',
  sweep: {
    from: 'server',
    parser: 'shopify',
    // The newest 100 products (about half a day of Gamerholic's listings), every product in it counted for its
    // keyword on every read (allPath: until Oct 2026 each read counted one keyword's, so each was seen every minute).
    path: '/products.json?limit=100',
    allPath: '/products.json?limit=100',
    allLabel: 'newest products',
    // One list for every keyword, about 200 KB a read: no more than one read every 15 s — every 10 s in a VIP drop's
    // window (its words are read from the same list).
    minSeconds: 15,
    vipMinSeconds: 10,
  },
  monitor: { server: true, browser: true },
  flow: {
    ...jbhifi.flow,
    checkout: { ...jbhifi.flow.checkout, shipping: [/standard shipping/i, /^standard\b/i] },
  },
};
