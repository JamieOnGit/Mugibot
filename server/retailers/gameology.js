// Gameology — an Australian games store (trading cards, Warhammer, board games, figures) on Shopify
// (FoxTheme's "Hyper" theme) that checks out with Shop, so ⚡ Buy and Auto-checkout use the Shopify
// flow — as Gameology's real store goes (probed Oct 2026: its product page, product JSON, search and
// cart drawer; nothing added or bought there), tested on the Gameology-style dummy store (/gameology):
//
// ⚡ Buy: Shopify's own cart link (/cart/<variant>:1) — what "Add to cart" → the cart drawer → "Checkout"
//   does, in one go, without the product page (1.6 MB) to load first. From the product page (the cart
//   link not taken, or its option not known): "Add to cart" — the theme adds it in the background and
//   slides its cart drawer open — then the drawer's "Checkout"; the drawer left shut, the cart icon opens
//   it. At checkout, signed in with Shop (Shop Pay): your details and card already in — STOP at "Pay
//   now". Signed in to your Gameology account: its saved details left as they are, the card typed in. As a
//   guest: email, first and last name, address (Shopify's suggestions come up as it's typed), suburb,
//   state/territory, postcode, phone → the shipping method Shopify picked → card number, MM/YY, security
//   code and name on card, "Use shipping address as billing address" ticked → STOP at "Pay now".
//
// Its product links can name a collection on the way (/collections/one-piece-booster-boxs/products/<handle>,
// as its collection pages link them): the same product, by the handle at the end.
//
// Live sweeps from Mugibot's server: Gameology sells Warhammer, board games and figures under the same
// names as the cards, and thousands of singles, so each keyword is searched with "tcg" added (Shopify's
// search suggestions: its sealed products first), and every third search is the store's newest products —
// a new drop shows up there the moment it's listed.

import jbhifi from './jbhifi.js';
import pokebox from './pokebox.js';

export default {
  ...pokebox,
  // (Shopify's checkpoint page, as at JB Hi-Fi: seen on a page here too — only JB's is checked by the server.)
  gate: { ...jbhifi.gate, probe: null },
  id: 'gameology',
  name: 'Gameology',
  base: 'https://www.gameology.com.au',
  hosts: ['www.gameology.com.au', 'gameology.com.au'],
  devPath: '/gameology',
  // (Its pages are new to the extension in 1.28.0: an older copy can't open them.)
  acoVersion: '1.28.0',
  flowNote: 'Shopify checkout: its cart link (or "Add to cart" → its cart drawer → "Checkout"), Shop Pay or your details and card, the shipping method Shopify picks, stops at "Pay now". Tested on the Gameology-style dummy store.',
  productPath: /^(\/gameology)?(\/collections\/[^/?#]+)?\/products\/[^/?#.]+$/,
};
