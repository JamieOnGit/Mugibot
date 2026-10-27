// EB Games — the checkout as EB Games' real one goes (from a member's walk-through, Oct 2026),
// tested on the EB Games-style dummy store; not run end to end on ebgames.com.au yet.
//
// Product page: "Add to Cart" / "Pre-order Now" → mini-cart → "Checkout" (fast)
//   → your email (or signed in: everything's already in) → Delivery: EB picks Click & Collect for
//   you, so "Home Delivery" is chosen → country Australia → your address, one line, picked from EB's
//   suggestions as it's typed → the shipping method EB picked (left as it is) → "How would you like
//   to pay?": "Pay Now", then "Credit / Debit card" → card number, MM/YY, CVV and name on card (the
//   billing address left as the delivery one) → "Done" (once the card is in) → STOP at
//   "CONFIRM & PAY". Signed in: only "CONFIRM & PAY" (the card EB has for you, if it shows one).

import { ADD_WORDS } from '../monitor/words.js';

export default {
  id: 'ebgames',
  name: 'EB Games',
  base: 'https://www.ebgames.com.au',
  hosts: ['www.ebgames.com.au'],
  devPath: '/ebgames',
  flowStatus: 'beta',
  flowNote: 'Built from a walk-through of EB Games\' real checkout; tested on the EB Games-style dummy store. Home Delivery (not Click & Collect), your address from EB\'s suggestions, Credit / Debit card, then CONFIRM & PAY.',
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
    // Drop mode: a new listing alerted here → its keyword's first page every other search for a while.
    hot: true,
  },
  // Store login monitor: whether you're signed in here is read from the store's own page when you
  // open it (its header: a "Sign in" link, or "Hi, <name>" / "Sign out"). signIn: where to sign in.
  account: { signIn: '' },
  // In-browser checks of its items: its Cloudflare refuses what the extension asks for in the background too ("HTTP
  // 403" on every watchlist item, Oct 2026) while your own visits, ⚡ Buy and Auto-checkout go through — so each item's
  // page is asked for from inside a tab of the store kept in the extension's window, the way its own pages ask it for
  // things (the page opened there, as you'd open it, when that's refused too). The server never asks: its Cloudflare
  // refuses every server, every time (the admin console's page checks showed EB Games at 0%, Oct 2026) — members'
  // browsers check their own items, admins' the shared monitors, and its searches come from an admin's browser.
  monitor: { server: 'never', browser: true, inPage: true },
  // Its virtual queue before big drops ("You're in the queue!", an estimated wait, a page that
  // refreshes itself — refresh it yourself and you lose your place). Seen by any browser that lands
  // on it; its going down, by an admin's browser asking for the front page as a new visitor (no
  // cookies: its own place in line is never touched) every 3 minutes. Nothing ever refreshes it.
  gate: {
    kind: 'queue', title: 'Queue Monitor', label: 'Virtual queue', module: 'EB Games', url: '/',
    page: {
      text: [/you'?re in the queue/i, /you are (now )?in (the )?(line|queue)/i, /using a virtual queue/i],
      wait: /estimated wait time is\s+(?:about\s+)?(\d+)\s*min/i,
    },
    check: { path: '/', everySeconds: 180 },
  },
  flow: {
    product: {
      add: ADD_WORDS,
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
      // EB chooses Click & Collect for you: "Home Delivery". Then "Credit / Debit card" under Pay Now.
      choose: [/^home delivery$/i, /^credit ?\/ ?debit card$/i],
      steps: [/^continue to delivery$/i, /^continue to payment$/i, /^continue$/i, /^done$/i],
      // "Done" under the card boxes: only once the card is in them.
      afterCard: [/^done$/i],
      // The delivery address is one line, picked from EB's suggestions as you type.
      addressLookup: true,
      final: [/^confirm (&|and) pay$/i, /\bplace (my |your )?order\b/i],
      // "Pay Now" is EB's kind of payment (vs Pay Later), not its final button.
      notFinal: [/^pay now$/i, /^pay later$/i],
      delivery: 'home',
      payment: 'card',
      done: /confirmation|thank-?you|order-?(complete|success)/i,
    },
  },
};
