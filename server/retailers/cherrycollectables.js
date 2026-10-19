// Cherry Collectables — an Australian trading-card and sports-card store on Shopify. ⚡ Buy and
// Auto-checkout use the Shopify flow — the same as Pokébox's (a member's walk-through, Oct 2026),
// tested on the Shopify-style dummy store (/cherrycollectables): Shopify's cart link → signed in
// with Shop: "Pay now"; as a guest: name, address (with Shopify's suggestions), suburb,
// state/territory, postcode, phone → the shipping method Shopify picked → card number, MM/YY,
// security code, name on card, "Use shipping address as billing address" ticked → STOP at "Pay now".
//
// Live sweeps from Mugibot's server: each keyword's search ("tcg" added: it lists thousands of
// singles and sports breaks) and the store's newest products as every keyword's second page.

import jbhifi from './jbhifi.js';
import pokebox from './pokebox.js';

export default {
  ...pokebox,
  gate: { ...jbhifi.gate, probe: null },
  id: 'cherrycollectables',
  name: 'Cherry Collectables',
  base: 'https://www.cherrycollectables.com.au',
  hosts: ['www.cherrycollectables.com.au', 'cherrycollectables.com.au'],
  devPath: '/cherrycollectables',
  productPath: /^(\/cherrycollectables)?\/products\/[^/?#.]+$/,
};
