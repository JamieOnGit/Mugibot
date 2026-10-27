// Good Games — an Australian games chain (trading cards, board games, miniatures) on Shopify, so
// ⚡ Buy and Auto-checkout use the Shopify flow — the same as Pokébox's (a member's walk-through,
// Oct 2026), tested on the Shopify-style dummy store (/goodgames): Shopify's cart link → signed in
// with Shop: "Pay now"; as a guest: name, address (with Shopify's suggestions), suburb,
// state/territory, postcode, phone → the shipping method Shopify picked → card number, MM/YY,
// security code, name on card, "Use shipping address as billing address" ticked → STOP at "Pay now".
//
// Live sweeps from Mugibot's server: each keyword's search ("tcg" added — Good Games sells board
// games and toys under the same names) and, every third search, the store's newest products.

import jbhifi from './jbhifi.js';
import pokebox from './pokebox.js';

export default {
  ...pokebox,
  gate: { ...jbhifi.gate, probe: null },
  id: 'goodgames',
  name: 'Good Games',
  base: 'https://www.goodgames.com.au',
  hosts: ['www.goodgames.com.au', 'goodgames.com.au'],
  devPath: '/goodgames',
  productPath: /^(\/goodgames)?\/products\/[^/?#.]+$/,
};
