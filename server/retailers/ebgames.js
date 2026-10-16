// EB Games — BETA. Tested against the EB Games-style dummy store, not yet on
// ebgames.com.au.
//
// Product page: "Add to Cart" / "Pre-order Now"
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
  // Live sweeps, from an admin's browser: EB Games refuses servers (Cloudflare), and its search page
  // has no products in it anyway: the page's own script asks /search/query for them, as JSON. So the
  // extension keeps an EB Games page open (in a minimised window of its own) and asks /search/query
  // from inside it, the way that page does: newest releases first.
  sweep: {
    from: 'browser', parser: 'ebgames', inPage: true, openPath: '/search?q={q}',
    path: '/search/query?q={q}&sort=releasedate&order=desc', pagePath: '&page={page}', pages: 2,
  },
  // Store login monitor: whether you're signed in here is read from the store's own page when you
  // open it (its header: a "Sign in" link, or "Hi, <name>" / "Sign out"). signIn: where to sign in.
  account: { signIn: '' },
  monitor: { server: true, browser: true },
  flow: {
    product: {
      add: [/\badd to cart\b/i, /\bpre-?order( now)?\b/i],
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
