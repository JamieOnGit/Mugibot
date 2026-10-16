// Kmart — the reference flow. Tested end to end on kmart.com.au.
//
// Product page: "Add to bag" (pressed as soon as Kmart's page has wired it up)
//   → as soon as it's in the bag: straight to /checkout
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
  // Live sweeps, from Mugibot's server. Kmart's search page has no products in it: once it's open,
  // the page asks Kmart's search provider, Constructor.io, for them (with the public search key in
  // Kmart's pages). Mugibot asks Constructor.io the same way, as Mugibot: each keyword within
  // Kmart's Trading Cards category, sold by Kmart or Target (not marketplace sellers), newest
  // first. (Until this, an admin's browser read the search page, and found nothing in it.)
  sweep: {
    from: 'server',
    formerDefault: 'browser',
    parser: 'constructor',
    apiBase: 'https://ac.cnstrc.com',
    path: '/search/{q}?key=key_GZTqlLr41FS2p7AY&c=mugibot-1.0&i=mugibot-monitor&s=1&section=Products&num_results_per_page=100'
      + '&sort_by=numberOfDaysSinceStartDate&sort_order=ascending&filters%5Bgroup_id%5D=65839471a7eefbf864519e8c4009fc29'
      + '&filters%5BSeller%5D=Kmart&filters%5BSeller%5D=Target',
    pagePath: '&page={page}',
    pages: 3,
  },
  monitor: { server: true, browser: true },
  flow: {
    product: {
      add: [/\badd to (bag|cart)\b/i, /\bpre-?order\b/i],
      waitMs: 12000,
      // kmart.com.au shows "Add to bag" before its own code has started; pressing it that
      // early does nothing. ⚡ Buy presses it the moment Kmart's code has wired it up (it
      // looks inside the page); only if it can't tell does it wait this long after the page
      // has finished loading.
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
      // Straight here once it's in the bag (no popup or bag page on the way).
      url: '/checkout',
      steps: [/^continue to details$/i, /^continue to delivery$/i, /^continue to payment$/i],
      final: [/\bcheck ?out securely\b/i],
      delivery: 'home',
      payment: 'card',
      done: /confirmation|thank-?you|order-?(complete|success)/i,
    },
  },
};
