// Toys"R"Us — DRAFT. A Shopify store, so it uses the Shopify (JB Hi-Fi) flow;
// not tested on toysrus.com.au yet.

import jbhifi from './jbhifi.js';

export default {
  ...jbhifi,
  id: 'toysrus',
  name: 'Toys"R"Us',
  base: 'https://www.toysrus.com.au',
  hosts: ['www.toysrus.com.au'],
  devPath: undefined,
  flowStatus: 'draft',
  flowNote: 'Uses the Shopify flow. Not tested yet.',
  productPath: /^\/products\/[^/?#.]+$/,
  searchPath: '/search?q={q}',
  // (No marketplace sellers here: nothing to ask about.)
  sweep: { ...jbhifi.sweep, sellers: null },
};
