// JB Hi-Fi — BETA. A Shopify store: restock checks use Shopify's product JSON
// (fast and light), and checkout is Shopify's one-page checkout. Tested
// against the Shopify-style dummy store, not yet on jbhifi.com.au.
//
// Product page: "Add to cart" → cart → "Check out" → one-page checkout
//   (contact, delivery address, shipping method, card frame) → STOP at "Pay now".

export default {
  id: 'jbhifi',
  name: 'JB Hi-Fi',
  base: 'https://www.jbhifi.com.au',
  hosts: ['www.jbhifi.com.au'],
  devPath: '/jbhifi',
  platform: 'shopify',
  flowStatus: 'beta',
  flowNote: 'Shopify checkout. Tested on the Shopify-style dummy store only.',
  skuLabel: 'Product handle',
  skuHint: 'The part after /products/ in the link',
  skuFromPath: /\/products\/([^/?#.]+)/,
  productPath: /^(\/jbhifi)?\/products\/[^/?#.]+$/,
  // On Shopify the handle is the code, so the product link can be built from it.
  productPathFromSku: '/products/{sku}',
  searchPath: '/search?query={q}',
  monitor: { server: true, browser: true },
  flow: {
    product: {
      add: [/\badd to cart\b/i, /\bpre-?order\b/i],
      quantity: 'page',
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
      delivery: 'home',
      payment: 'card',
      done: /thank[-_]?you|orders?\/\w+$/i,
    },
  },
};
