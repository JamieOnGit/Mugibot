// Target — DRAFT. Product links and restock checks are set up; the checkout
// steps below are a first guess and have NOT been tested on target.com.au yet
// (they're tested on the Target-style dummy store). Send the real flow
// (docs/RETAILER-FLOWS.md).
//
// After "Add to basket", Target shows an "Often Bought Together" pop-up offering
// more things to add: ⚡ Buy and Auto-checkout close it with its ✕ and carry on.

export default {
  id: 'target',
  name: 'Target',
  base: 'https://www.target.com.au',
  hosts: ['www.target.com.au'],
  // Where this retailer's copy lives in the dummy store (npm run mockstore).
  devPath: '/target',
  flowStatus: 'draft',
  flowNote: 'Not tested yet — the checkout fill is a best guess. Waiting for the real flow.',
  skuLabel: 'Product code',
  skuHint: 'The code at the end of the link, e.g. …/p/…/71234567',
  skuFromPath: /^(?:\/target)?\/p\/[^/]+\/([A-Za-z0-9_-]+)/,
  productPath: /^(?:\/target)?\/p\/[^/]+\/[A-Za-z0-9_-]+\/?$/,
  searchPath: '/search?text={q}',
  // Live sweeps (docs/MONITORING.md): the newest listings first, up to four pages of 48. Target
  // leaves products that are sold out online out of its results, so one that's gone from every
  // page for a while is sold out (and its return is a restock).
  sweep: { from: 'server', parser: 'target', path: '/search?sEngine=c&text={q}&sortBy=onlinedate&sortOrder=descending', pagePath: '&page={page}', pages: 4, goneMeansSoldOut: true },
  // Store login monitor: whether you're signed in here is read from the store's own page when you
  // open it (its header: a "Sign in" link, or "Hi, <name>" / "Sign out"). signIn: where to sign in.
  account: { signIn: '' },
  monitor: { server: true, browser: true },
  flow: {
    product: { add: [/\badd to (cart|basket|bag)\b/i, /\bpre-?order\b/i], waitMs: 12000 },
    // upsell: the "Often Bought Together" pop-up after Add to basket — closed with its ✕, never accepted.
    added: { checkout: [/^(secure )?check ?out( now)?$/i], viewBag: [/\bview (basket|cart|bag)\b/i], upsell: [/often bought together/i] },
    bag: { path: /\/(basket|cart)(\/|$)/i, checkout: [/^(secure )?check ?out( now)?$/i, /^proceed to checkout$/i] },
    checkout: {
      // target.com.au/checkout opens its one-page checkout at /spc/order.
      path: /\/(checkout|spc\/order)(\/|$)/i,
      url: '/checkout',
      guest: [/^continue as (a )?guest$/i, /^guest checkout$/i],
      steps: [/^continue( to (delivery|payment))?$/i, /^next$/i],
      final: [/\bplace (my |your )?order\b/i, /\bpay now\b/i],
      delivery: 'home',
      payment: 'card',
      done: /confirmation|thank-?you|order-?(complete|success)/i,
    },
  },
};
