// Trainer Town — DRAFT checkout. An Australian trading-card store on Shopify,
// so checkout uses the Shopify (JB Hi-Fi) flow: tested on the Shopify-style
// dummy store (/trainertown), not on trainertown.com.au yet.
//
// Live sweeps from Mugibot's server: Trainer Town keeps each game in a collection
// of its own (Pokémon, One Piece, Lorcana…), so a keyword's whole collection is
// read in one go from Shopify's product list for it — every product, sold-out ones
// too, with stock, price and the option to add to the cart. A keyword with no
// collection of its own is searched instead (Shopify's search suggestions).

import jbhifi from './jbhifi.js';

export default {
  ...jbhifi,
  id: 'trainertown',
  name: 'Trainer Town',
  base: 'https://trainertown.com.au',
  hosts: ['trainertown.com.au', 'www.trainertown.com.au'],
  devPath: '/trainertown',
  flowStatus: 'draft',
  flowNote: 'Uses the Shopify flow (tested on the Shopify-style dummy store). Not tested on trainertown.com.au yet.',
  productPath: /^(\/trainertown)?\/products\/[^/?#.]+$/,
  searchPath: '/search?q={q}&type=product',
  sweep: {
    from: 'server',
    parser: 'shopify',
    // Each game's collection, whole (Shopify lists up to 250 a read; Trainer Town's are well under).
    collectionsPath: '/collections.json?limit=250',
    collectionPath: '/collections/{collection}/products.json?limit=250',
    // A keyword without a collection: the search (it's a card shop, so no "tcg" added).
    path: '/search/suggest.json?q={q}&resources%5Btype%5D=product&resources%5Blimit%5D=10&resources%5Boptions%5D%5Bunavailable_products%5D=last',
  },
  monitor: { server: true, browser: true },
};
