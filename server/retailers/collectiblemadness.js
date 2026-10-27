// Collectible Madness — an Australian trading-card and collectibles store on Shopify, at
// collectiblemadness.com.au (www. sends you there). ⚡ Buy and Auto-checkout use the Shopify flow —
// the same as Pokébox's (a member's walk-through, Oct 2026), tested on the Shopify-style dummy store
// (/collectiblemadness): Shopify's cart link → signed in with Shop: "Pay now"; as a guest: name,
// address (with Shopify's suggestions), suburb, state/territory, postcode, phone → the shipping
// method Shopify picked → card number, MM/YY, security code, name on card, "Use shipping address
// as billing address" ticked → STOP at "Pay now".
//
// Live sweeps from Mugibot's server: each keyword's search ("Pokemon - TCG - …", its products are
// named) and, every third search, the store's newest products.

import jbhifi from './jbhifi.js';
import pokebox from './pokebox.js';

export default {
  ...pokebox,
  gate: { ...jbhifi.gate, probe: null },
  id: 'collectiblemadness',
  name: 'Collectible Madness',
  base: 'https://collectiblemadness.com.au',
  hosts: ['collectiblemadness.com.au', 'www.collectiblemadness.com.au'],
  devPath: '/collectiblemadness',
  productPath: /^(\/collectiblemadness)?\/products\/[^/?#.]+$/,
};
