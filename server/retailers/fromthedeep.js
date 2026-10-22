// From The Deep Games — an Australian games and trading-card store (Pokémon, One Piece, Riftbound, Gundam,
// Magic, Lorcana…) on Shopify (BinderPOS's "Standard" theme) that checks out with Shop, so ⚡ Buy and
// Auto-checkout use the Shopify flow — as its real store goes (probed Oct 2026: its product pages, collections,
// product JSON, search and empty cart; nothing added or bought there), tested on the dummy store
// (/fromthedeep):
//
// ⚡ Buy: Shopify's own cart link (/cart/<variant>:<qty>, which its pages advertise themselves) — "Add to cart" →
//   its cart → "Checkout", in one go, with as many as you asked for. From the product page (the cart link not
//   taken, or its option not known): its quantity ("Units": a box with − and + beside it) set first, then "Add To
//   Cart" (the theme adds it in the background, and the header's cart count goes up) → the header's cart, whose
//   drop-down has "Checkout" (/checkout) and "Your Cart" (/cart: the cart page's Checkout). At checkout, signed in
//   with Shop (Shop Pay): your details and card already in — STOP at "Pay now". As a guest: email, name, address
//   (Shopify's suggestions), suburb, state/territory, postcode, phone → the shipping method Shopify picked → card,
//   "Use shipping address as billing address" ticked → STOP at "Pay now".
//
// Live sweeps from Mugibot's server: each game's whole sealed collection, read in one go — "Pokemon TCG Sealed",
// "One Piece Card Game", "Riftbound", "Gundam Card Game" (Shopify's product list for it: every product, with stock
// and the option to add) — never its singles' collections ("Pokemon Singles (All)": 30,000 of them), and every
// keyword's second page is its Preorders collection (every game's pre-orders: where a drop is listed first). Its
// newest-products list isn't read: it's hundreds of Magic singles a day, a new one every few seconds.

import jbhifi from './jbhifi.js';
import pokebox from './pokebox.js';

export default {
  ...pokebox,
  // (Shopify's checkpoint page, as at JB Hi-Fi: seen on a page here too — only JB's is checked by the server.)
  gate: { ...jbhifi.gate, probe: null },
  id: 'fromthedeep',
  name: 'From The Deep Games',
  base: 'https://fromthedeepgames.com.au',
  hosts: ['fromthedeepgames.com.au', 'www.fromthedeepgames.com.au'],
  devPath: '/fromthedeep',
  // (Its pages are new to the extension in 1.29.0: an older copy can't open them.)
  acoVersion: '1.29.0',
  flowNote: 'Shopify checkout: its cart link (or its quantity, "Add To Cart" → its cart → "Checkout"), Shop Pay or your details and card, the shipping method Shopify picks, stops at "Pay now". Tested on the From The Deep Games-style dummy store.',
  // (Its collection pages link a product with the collection on the way, as Shopify's themes do.)
  productPath: /^(\/fromthedeep)?(\/collections\/[^/?#]+)?\/products\/[^/?#.]+$/,
  searchPath: '/search?q={q}&type=product',
  sweep: {
    ...pokebox.sweep,
    // Each game's collection, whole (its sealed ones are well under Shopify's 250 a read).
    collectionsPath: '/collections.json?limit=250',
    collectionPath: '/collections/{collection}/products.json?limit=250',
    collectionSkip: /singles/i,
    collectionPrefer: /sealed/i,
    // Page 2 of every keyword: its Preorders collection.
    feedPath: '/collections/preorders/products.json?limit=250',
  },
};
