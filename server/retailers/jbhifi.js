// JB Hi-Fi — BETA. A Shopify store: restock checks use Shopify's product JSON
// (fast and light), and checkout is Shopify's one-page checkout. Its address part
// works on jbhifi.com.au (a member's walk-through, Oct 2026), signed in or not; the
// card goes into Shopify's card fields — card number, expiration date (MM/YY),
// security code and name on card, each in a frame of its own from
// checkout.pci.shopifyinc.com (PAYMENT_HOSTS) — tested on the Shopify-style dummy store.
//
// ⚡ Buy: Shopify's own cart link (/cart/<variant>:1, one of it) — straight into the
//   one-page checkout with the product in the cart (contact, delivery address,
//   shipping method, card frames) → STOP at "Pay now". (From the product page by
//   hand: "Add to cart" → cart → "Check out".)

import { ADD_WORDS } from '../monitor/words.js';

export default {
  id: 'jbhifi',
  name: 'JB Hi-Fi',
  base: 'https://www.jbhifi.com.au',
  hosts: ['www.jbhifi.com.au'],
  devPath: '/jbhifi',
  platform: 'shopify',
  flowStatus: 'beta',
  flowNote: 'Shopify checkout: straight in with its cart link, your details and card in, stops at "Pay now". Card boxes tested on the Shopify-style dummy store.',
  skuLabel: 'Product handle',
  skuHint: 'The part after /products/ in the link',
  skuFromPath: /\/products\/([^/?#.]+)/,
  productPath: /^(\/jbhifi)?\/products\/[^/?#.]+$/,
  // On Shopify the handle is the code, so the product link can be built from it.
  productPathFromSku: '/products/{sku}',
  // Shopify cart link: the product straight into the cart (Shopify's own feature).
  cartPath: '/cart/{variant}:{qty}',
  searchPath: '/search?query={q}',
  // Live sweeps: Shopify's search suggestions (10 products a search, with stock). "pokemon" alone
  // finds plushies and games, so "tcg" is added unless the keyword already says cards.
  // And every other search, its whole range by when each product was published, newest first
  // (/products.json: the top 30 are the last 20 minutes or so of what it put on sale, Oct 2026) —
  // a drop is in it the moment JB publishes it, however far down the 10 a search returns it'd
  // sit (the Unova Heavy Hitters drop, Oct 2026, was in none of them). Its collections' own lists
  // are empty (its pages draw them with their own code).
  sweep: {
    from: 'server', parser: 'shopify', path: '/search/suggest.json?q={q}&resources%5Btype%5D=product&resources%5Blimit%5D=10&resources%5Boptions%5D%5Bunavailable_products%5D=last', addWord: 'tcg',
    newestPath: '/products.json?limit=30', newestEvery: 2,
    // JB Hi-Fi Marketplace: other sellers' products are listed alongside JB's own, and the search
    // doesn't say which is which. The product's own data does: a "Seller" option naming the
    // marketplace seller(s) ("Gameology"), where JB's own products have none. Asked once per
    // product, never as part of a search: just before its first alert, and slowly for the rest.
    sellers: { path: '/products/{sku}.js', own: /^jb ?hi-?fi$/i },
  },
  // Store login monitor: Shopify puts the signed-in customer's number in every page ("cid" in __st),
  // so the extension checks the store's front page with your cookies (every 10 minutes, and when you
  // open the store). /account goes to the store's sign-in when you're signed out.
  account: { signIn: '/account', check: { path: '/', signedIn: /var __st=\{[^}]*"cid":\s*\d+|"customerId":\s*\d+/, signedOut: /var __st=\{/ } },
  monitor: { server: true, browser: true },
  // Its checkpoint (Shopify's bot check: an hCaptcha page at /checkpoint), switched on before big
  // drops, then off again (docs/MONITORING.md, "Checkpoints and virtual queues"). The server looks
  // at /checkpoint every 5 seconds (off, it's a tiny "not found"): up = the page with its hCaptcha;
  // down = gone, or sent elsewhere. Seen up, it's looked at again 2 seconds later to be sure, so it's
  // posted within seconds of JB switching it on (other groups' monitors had it 4 minutes before
  // Mugibot's once-a-minute look, Oct 2026).
  // ⚡ Buy and Auto-checkout never touch the check: they wait for you to solve it, then carry on.
  gate: {
    kind: 'checkpoint', title: 'Checkpoint Monitor', label: 'hcaptcha Checkpoint', module: 'Shopify', url: '/checkpoint',
    page: { path: /\/checkpoint\/?$/i, markers: [/h-captcha|hcaptcha/i] },
    probe: { path: '/checkpoint', intervalSeconds: 5 },
  },
  flow: {
    product: {
      add: ADD_WORDS,
      waitMs: 12000,
    },
    added: {
      checkout: [/^check ?out$/i],
      viewBag: [/\bview cart\b/i],
    },
    bag: {
      path: /\/cart(\/|$)/i,
      checkout: [/^check ?out$/i],
    },
    checkout: {
      path: /\/checkouts?\//i,
      steps: [/^continue to shipping$/i, /^continue to payment$/i],
      final: [/\bpay now\b/i, /\bcomplete order\b/i],
      // "Use shipping address as billing address": ticked (it comes ticked; ticked again if it isn't).
      tick: [/use (my |the )?shipping address as (my |the )?billing address/i],
      delivery: 'home',
      payment: 'card',
      done: /thank[-_]?you|orders?\/\w+$/i,
    },
  },
};
