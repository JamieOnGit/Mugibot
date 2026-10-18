// Toys"R"Us — a Shopify store at toysrus.com.au (www.toysrus.com.au sends you there, so the
// extension runs on both). Uses the Shopify (JB Hi-Fi) flow, as Toys"R"Us' real checkout goes
// (a member's walk-through, Oct 2026), tested on the Shopify-style dummy store (/toysrus):
//
// ⚡ Buy: Shopify's cart link (/cart/<variant>:1) → checkout. Signed in with Shop (Shop Pay), your
//   details and card are already in: STOP at "Pay now". Otherwise: email, country/region,
//   first and last name, address, suburb, state/territory, postcode, phone → shipping method:
//   "Standard Shipping - AusPost" → Authority to Leave left ticked → card number, expiration
//   date (MM/YY), security code and name on card (Shopify's card fields), with "Use shipping
//   address as billing address" left ticked → STOP at "Pay now".

import jbhifi from './jbhifi.js';

export default {
  ...jbhifi,
  id: 'toysrus',
  name: 'Toys"R"Us',
  base: 'https://toysrus.com.au',
  hosts: ['toysrus.com.au', 'www.toysrus.com.au'],
  devPath: '/toysrus',
  flowStatus: 'beta',
  flowNote: 'Shopify checkout: Shop Pay (signed in to Shop) or your details and card, Standard Shipping - AusPost, stops at "Pay now". Tested on the Shopify-style dummy store.',
  productPath: /^(\/toysrus)?\/products\/[^/?#.]+$/,
  searchPath: '/search?q={q}',
  // (No marketplace sellers here: nothing to ask about.)
  sweep: { ...jbhifi.sweep, sellers: null },
  flow: {
    ...jbhifi.flow,
    checkout: {
      ...jbhifi.flow.checkout,
      // Standard Shipping - AusPost (Shopify may offer Express too).
      shipping: [/standard shipping/i, /auspost|australia post/i],
    },
  },
};
