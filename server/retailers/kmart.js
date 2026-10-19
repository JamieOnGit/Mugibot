// Kmart — the reference flow. Tested end to end on kmart.com.au, signed in.
//
// Product page: "Add to bag" (pressed as soon as Kmart's page has wired it up)
//   → as soon as it's in the bag: straight to /checkout
//   → one-page checkout: Order summary → "Continue to details" → Details (signed in: already
//     there; as a guest: your email, name and mobile, or "Continue as guest" first if Kmart asks)
//     → "Continue to delivery" → Home delivery + address → "Continue to payment"
//     → "Credit or debit card" (already chosen): card number, expiry (MM/YY) and CVV, each in its
//     own Adyen frame → STOP at "Checkout securely".
//
// Signed out, Kmart can turn the first add away while its page is still starting up (a member saw
// nothing added, Oct 2026): Mugibot sees its cart refuse it, waits for the page to finish loading,
// and presses Add once more — the same flow as signed in from there.

import { ADD_WORDS } from '../monitor/words.js';

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
    parser: 'constructor',
    apiBase: 'https://ac.cnstrc.com',
    path: '/search/{q}?key=key_GZTqlLr41FS2p7AY&c=mugibot-1.0&i=mugibot-monitor&s=1&section=Products&num_results_per_page=100'
      + '&sort_by=numberOfDaysSinceStartDate&sort_order=ascending&filters%5Bgroup_id%5D=65839471a7eefbf864519e8c4009fc29'
      + '&filters%5BSeller%5D=Kmart&filters%5BSeller%5D=Target',
    pagePath: '&page={page}',
    pages: 3,
  },
  // Store login monitor: whether you're signed in here is read from the store's own page when you
  // open it (its header: a "Sign in" link, or "Hi, <name>" / "Sign out"). signIn: where to sign in.
  account: { signIn: '' },
  monitor: { server: true, browser: true },
  flow: {
    product: {
      add: ADD_WORDS,
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
      guest: [/^continue as (a )?guest$/i, /^guest checkout$/i, /^check ?out as (a )?guest$/i],
      steps: [/^continue to details$/i, /^continue to delivery$/i, /^continue to payment$/i],
      final: [/\bcheck ?out securely\b/i],
      delivery: 'home',
      payment: 'card',
      done: /confirmation|thank-?you|order-?(complete|success)/i,
    },
  },
};
