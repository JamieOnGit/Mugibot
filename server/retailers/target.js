// Target — the checkout as Target's real one goes (from a member's walk-through, Oct 2026),
// tested on the Target-style dummy store; not run end to end on target.com.au yet.
//
// Product page: "Add to basket" → an "Often Bought Together" pop-up offering more things to add:
//   ⚡ Buy and Auto-checkout close it with its ✕ and carry on → straight to /checkout (its one-page
//   checkout at /spc/order) → Delivery Options: "Home Delivery" (a tile, nothing chosen until you
//   pick it) → your details (first and last name, contact number, email) and your delivery address,
//   one line, picked from Target's suggestions as it's typed → Payment Method: "Credit Card" (a
//   tile) → card holder's name, card number, expiry (MM/YY) and CVV, in Paydock's card form (a
//   frame from paydock.com, PAYMENT_HOSTS) → STOP at "Place order". Signed in: the same, with your
//   details already in.

import { ADD_WORDS } from '../monitor/words.js';

export default {
  id: 'target',
  name: 'Target',
  base: 'https://www.target.com.au',
  hosts: ['www.target.com.au'],
  // Where this retailer's copy lives in the dummy store (npm run mockstore).
  devPath: '/target',
  flowStatus: 'beta',
  flowNote: 'Built from a walk-through of Target\'s real checkout; tested on the Target-style dummy store. Home Delivery, your address from Target\'s suggestions, Credit Card.',
  skuLabel: 'Product code',
  skuHint: 'The code at the end of the link, e.g. …/p/…/71234567',
  skuFromPath: /^(?:\/target)?\/p\/[^/]+\/([A-Za-z0-9_-]+)/,
  productPath: /^(?:\/target)?\/p\/[^/]+\/[A-Za-z0-9_-]+\/?$/,
  searchPath: '/search?text={q}',
  // Live sweeps (docs/MONITORING.md): the newest listings first, up to four pages of 48. Target
  // leaves products that are sold out online out of its results, so one that's gone from every
  // page for a while is sold out (and its return is a restock). Drop mode (hot): a new listing alerted here → that
  // keyword's first page every other search for a while (a new listing at Target is on sale now: it hides sold-outs).
  sweep: { from: 'server', parser: 'target', path: '/search?sEngine=c&text={q}&sortBy=onlinedate&sortOrder=descending', pagePath: '&page={page}', pages: 4, goneMeansSoldOut: true, hot: true },
  // Store login monitor: whether you're signed in here is read from the store's own page when you
  // open it (its header: a "Sign in" link, or "Hi, <name>" / "Sign out"). signIn: where to sign in.
  account: { signIn: '' },
  monitor: { server: true, browser: true },
  flow: {
    product: { add: ADD_WORDS, waitMs: 12000 },
    // upsell: the "Often Bought Together" pop-up after Add to basket — closed with its ✕, never accepted.
    added: { checkout: [/^(secure )?check ?out( now)?$/i], viewBag: [/\bview (basket|cart|bag)\b/i], upsell: [/often bought together/i] },
    // (Its bag is the basket: /basket.)
    bag: { path: /\/(basket|cart)(\/|$)/i, url: '/basket', checkout: [/^(secure )?check ?out( now)?$/i, /^proceed to checkout$/i] },
    checkout: {
      // target.com.au/checkout opens its one-page checkout at /spc/order.
      path: /\/(checkout|spc\/order)(\/|$)/i,
      url: '/checkout',
      guest: [/^continue as (a )?guest$/i, /^guest checkout$/i],
      // Delivery Options and Payment Method are tiles: "Home Delivery", then "Credit Card".
      choose: [/^home delivery$/i, /^credit card$/i],
      steps: [/^continue( to (delivery|payment|review))?$/i, /^next$/i],
      // The delivery address is one line, picked from Target's suggestions as you type.
      addressLookup: true,
      final: [/\bplace (my |your )?order\b/i, /\bpay now\b/i],
      delivery: 'home',
      payment: 'card',
      done: /confirmation|thank-?you|order-?(complete|success)/i,
    },
  },
};
