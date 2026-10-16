// Gamerholic — DRAFT checkout. An Australian games and cards store on Shopify,
// so ⚡ Buy uses the Shopify flow: Shopify's own cart link straight into its
// one-page checkout (tested on the Shopify-style dummy store, /gamerholic; not
// on gamerholic.com.au yet).
//
// Live sweeps from Mugibot's server: Gamerholic lists hundreds of new products a
// day (pre-orders from its suppliers, cards, toys), so the sweeps read its newest
// products — Shopify's product list, newest first, with every option's stock —
// and keep the ones each keyword names. A new drop shows up there the moment
// it's listed.

import jbhifi from './jbhifi.js';

export default {
  ...jbhifi,
  id: 'gamerholic',
  name: 'Gamerholic',
  base: 'https://gamerholic.com.au',
  hosts: ['gamerholic.com.au', 'www.gamerholic.com.au'],
  devPath: '/gamerholic',
  flowStatus: 'draft',
  flowNote: 'Uses the Shopify flow (tested on the Shopify-style dummy store). Not tested on gamerholic.com.au yet.',
  productPath: /^(\/gamerholic)?\/products\/[^/?#.]+$/,
  searchPath: '/search?q={q}&type=product',
  sweep: {
    from: 'server',
    parser: 'shopify',
    // The newest 100 products (about half a day of Gamerholic's listings).
    path: '/products.json?limit=100',
    // One list for every keyword, about 200 KB a read: no more than one read every 15 s.
    minSeconds: 15,
  },
  monitor: { server: true, browser: true },
};
