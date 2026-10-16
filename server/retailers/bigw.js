// BIG W — BETA. Built from BIG W's public page layout and tested against the
// BIG W-style dummy store, NOT yet on bigw.com.au. Send the real flow
// (docs/RETAILER-FLOWS.md) and this file gets updated.
//
// Product page: "Add to cart"
//   → "added to cart" drawer → "View cart"
//   → cart: "Proceed to checkout"
//   → checkout: email + "Continue as guest" → "Home delivery" → address
//     ("Enter address manually") → "Continue to payment" → card frame
//     → STOP at "Place order".

export default {
  id: 'bigw',
  name: 'BIG W',
  base: 'https://www.bigw.com.au',
  hosts: ['www.bigw.com.au'],
  devPath: '/bigw',
  flowStatus: 'beta',
  flowNote: 'Tested on the BIG W-style dummy store only. Waiting for the real bigw.com.au flow.',
  skuLabel: 'Product code',
  skuHint: 'The number after /p/ in the link, e.g. …/p/6012345',
  skuFromPath: /\/p\/(\d+)/,
  productPath: /^(\/bigw)?\/product\/[^/]+\/p\/\d+/,
  searchPath: '/search?text={q}',
  // Live sweeps: BIG W refuses servers (its search API too), so an admin's browser (the
  // extension) reads its search page. The page builds its product list once it's open, so the
  // extension opens it (in a minimised window of its own), waits for the products, then reads them.
  sweep: { from: 'browser', parser: 'generic', render: true, path: '/search?text={q}', addWord: 'tcg', minSeconds: 20 },
  monitor: { server: true, browser: true },
  flow: {
    product: {
      add: [/\badd to (cart|trolley)\b/i, /\bpre-?order\b/i],
      waitMs: 12000,
    },
    added: {
      checkout: [/^(secure )?check ?out( now)?$/i],
      viewBag: [/\bview (cart|trolley)\b/i],
    },
    bag: {
      path: /\/cart(\/|$)/i,
      checkout: [/^proceed to checkout$/i, /^(secure )?check ?out( now)?$/i],
    },
    checkout: {
      path: /\/checkout(\/|$)/i,
      guest: [/^continue as (a )?guest$/i],
      choose: [/^home delivery$/i],
      steps: [/^continue to payment$/i, /^continue$/i],
      final: [/\bplace (my |your )?order\b/i, /\bpay now\b/i],
      delivery: 'home',
      payment: 'card',
      done: /confirmation|thank-?you|order-?(complete|success)/i,
    },
  },
};
