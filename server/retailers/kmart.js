// Kmart — the reference flow. Tested end to end on kmart.com.au.
//
// Product page: "Add to bag" (quantity box on the page)
//   → "added to bag" popup → "Checkout"
//   → one-page checkout: Order summary → "Continue to details" → Details →
//     "Continue to delivery" → Home delivery + address → "Continue to payment"
//     → card (Adyen frame) → STOP at "Checkout securely".

export default {
  id: 'kmart',
  name: 'Kmart',
  base: 'https://www.kmart.com.au',
  hosts: ['www.kmart.com.au'],
  // Where this retailer's copy lives in the dummy store (npm run mockstore).
  devPath: '/kmart',
  flowStatus: 'verified',
  flowNote: 'Tested end to end on kmart.com.au. Stops at "Checkout securely".',
  skuLabel: 'Keycode',
  skuHint: 'The number at the end of the link, e.g. …-43818648/',
  skuFromPath: /-(\d{6,10})\/?$/,
  productPath: /^(\/kmart)?\/product\/[^/]*-\d{6,10}\/?$/,
  searchPath: '/search/?searchTerm={q}',
  monitor: { server: true, browser: true },
  flow: {
    product: {
      add: [/\badd to (bag|cart)\b/i, /\bpre-?order\b/i],
      quantity: 'page',
      waitMs: 12000,
      // kmart.com.au shows "Add to bag" before its own code has started; pressing it
      // that early does nothing. Wait this long after the page has loaded.
      settleMs: 1500,
    },
    added: {
      checkout: [/^(secure )?check ?out( now)?$/i],
      viewBag: [/\bview (bag|cart)\b/i],
    },
    bag: {
      path: /\/(cart|bag)(\/|$)/i,
      checkout: [/^(secure )?check ?out( now)?$/i],
    },
    checkout: {
      path: /\/checkout(\/|$)/i,
      steps: [/^continue to details$/i, /^continue to delivery$/i, /^continue to payment$/i],
      final: [/\bcheck ?out securely\b/i],
      delivery: 'home',
      payment: 'card',
      done: /confirmation|thank-?you|order-?(complete|success)/i,
    },
  },
};
