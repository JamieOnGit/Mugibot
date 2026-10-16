// EB Games — BETA. Tested against the EB Games-style dummy store, not yet on
// ebgames.com.au.
//
// Product page: quantity box + "Add to Cart" / "Pre-order Now"
//   → mini-cart drawer → "Checkout"
//   → sign in or "Continue as Guest" → shipping details (address lookup or
//     "Enter address manually") → "Continue to delivery" → delivery option
//     → "Continue to payment" → card frame + terms → STOP at "Place Order".

export default {
  id: 'ebgames',
  name: 'EB Games',
  base: 'https://www.ebgames.com.au',
  hosts: ['www.ebgames.com.au'],
  devPath: '/ebgames',
  flowStatus: 'beta',
  flowNote: 'Tested on the EB Games-style dummy store only. Pre-orders may need you to be signed in to EB.',
  skuLabel: 'Product code',
  skuHint: 'The number in the link, e.g. …/product/toys-and-collectibles/312345-…',
  skuFromPath: /\/product\/[^/]+\/(\d+)/,
  productPath: /^(\/ebgames)?\/product\/[^/]+\/\d+/,
  searchPath: '/search?q={q}',
  // Live sweeps: EB Games refuses servers, so an admin's browser (the extension) reads its search page.
  sweep: { from: 'browser', parser: 'generic', path: '/search?q={q}' },
  monitor: { server: true, browser: true },
  flow: {
    product: {
      add: [/\badd to cart\b/i, /\bpre-?order( now)?\b/i],
      quantity: 'page',
      waitMs: 12000,
    },
    added: {
      checkout: [/^(secure )?check ?out( now)?$/i],
      viewBag: [/\bview cart\b/i],
    },
    bag: {
      path: /\/cart(\/|$)/i,
      checkout: [/^(secure )?check ?out( now)?$/i],
    },
    checkout: {
      path: /\/checkout(\/|$)/i,
      guest: [/^continue as (a )?guest$/i, /^check ?out as (a )?guest$/i],
      steps: [/^continue to delivery$/i, /^continue to payment$/i],
      final: [/\bplace (my |your )?order\b/i],
      delivery: 'home',
      payment: 'card',
      done: /confirmation|thank-?you|order-?(complete|success)/i,
    },
  },
};
