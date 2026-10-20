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

import { ADD_WORDS } from '../monitor/words.js';

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
  // At most one search every 20 s (Oct 2026: every 10 s — and with watchlist checks fetched in the background
  // besides, BIG W's bot protection took a member's browser for a bot and turned it away, "Access Denied", on
  // their own visits too). The page takes ~5 s to build.
  sweep: { from: 'browser', parser: 'generic', render: true, path: '/search?text={q}', addWord: 'tcg', minSeconds: 20 },
  // Store login monitor: whether you're signed in here is read from the store's own page when you
  // open it (its header: a "Sign in" link, or "Hi, <name>" / "Sign out"). signIn: where to sign in.
  account: { signIn: '' },
  // Its product pages: BIG W's bot protection (Akamai) resets every server's connection, so the server never
  // asks (server: 'never'). Members' browsers do, each product every 15 minutes at most (browserSeconds) — the
  // live searches see drops sooner — by opening its page in the extension's window the way you'd open it
  // (render): background requests are what got a member's browser turned away.
  monitor: { server: 'never', browser: true, render: true, browserSeconds: 900 },
  flow: {
    product: {
      add: ADD_WORDS,
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
