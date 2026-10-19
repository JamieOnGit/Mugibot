// Pokémon Center (Australia) — DRAFT. pokemoncenter.com/en-au only: every search, product
// link, ⚡ Buy and checkout is on the Australian store; other regions' pages (/en-gb, the US
// store) are left alone. Its pages are behind a bot check (Imperva) that turns servers away,
// so neither Mugibot's server nor anyone here could open them: the checkout steps below are a
// best guess, not tested anywhere yet. Members' browsers pass the check like any visitor.
// During big drops Pokémon Center may put everyone in a queue first: ⚡ Buy waits behind it
// like you do, and never tries to skip it.
//
// Product page: "Add to Cart" → straight to the cart → "Checkout" → guest → shipping
//   address → delivery → payment → STOP at "Place Order".
//
// Live sweeps from an admin's browser: its search page (/en-au/search/<keyword>, 32 products
// a page) builds its product list once it's open, so the extension opens it in its own
// window and reads it (like BIG W's). Imperva's check may reload the page first: the extension
// keeps looking until the products are there (from 1.8.1; 1.8.0 gave up at the reload).

import { ADD_WORDS } from '../monitor/words.js';

export default {
  id: 'pokemoncenter',
  name: 'Pokémon Center',
  base: 'https://www.pokemoncenter.com/en-au',
  hosts: ['www.pokemoncenter.com'],
  // Only the Australian store (the same address serves every region's).
  pathPrefix: '/en-au',
  devPath: '/pokemoncenter',
  flowStatus: 'draft',
  flowNote: 'A best guess — Pokémon Center turns servers away, so its checkout hasn\'t been seen or tested. Watch each step.',
  skuLabel: 'Product code',
  skuHint: 'The code after /product/ in an Australian store link, e.g. pokemoncenter.com/en-au/product/10-10447-108/…',
  skuFromPath: /\/product\/([0-9A-Za-z]+(?:-[0-9A-Za-z]+)+)\//,
  // Australian product pages only (the dummy store's copy lives under /pokemoncenter).
  productPath: /^(\/en-au|\/pokemoncenter)\/product\/[0-9A-Za-z]+(-[0-9A-Za-z]+)+\/[^/?#]+\/?$/,
  searchPath: '/search/{q}',
  sweep: { from: 'browser', parser: 'generic', render: true, path: '/search/{q}', minSeconds: 30, extension: '1.8.1' },
  // Store login monitor: whether you're signed in here is read from the store's own page when you
  // open it (its header: a "Sign in" link, or "Hi, <name>" / "Sign out"). signIn: where to sign in.
  account: { signIn: '' },
  monitor: { server: true, browser: true },
  // Its virtual queue before big drops (www.pokemoncenter.com/?queue: you wait in line, the page
  // moving you on by itself). Seen by any browser sent there; its going down, by an admin's browser
  // asking for the front page as a new visitor every 3 minutes. Nothing ever refreshes the line.
  gate: {
    kind: 'queue', title: 'Queue Monitor', label: 'Virtual queue', module: 'Pokémon Center', url: '/?queue',
    page: {
      url: /[?&]queue\b/i,
      text: [/you are (now )?in (the )?(line|queue)/i, /you'?re in the queue/i, /virtual (waiting )?(room|queue)/i],
      wait: /wait(?:ing)? time[^0-9]{0,40}(\d+)\s*min/i,
    },
    check: { path: '/', everySeconds: 180 },
  },
  flow: {
    product: {
      add: ADD_WORDS,
      waitMs: 15000,
    },
    added: {
      checkout: [/^(secure )?check ?out( now)?$/i],
      viewBag: [/\bview (cart|bag)\b/i],
    },
    bag: {
      path: /\/cart(\/|$)/i,
      checkout: [/^(proceed to |secure )?check ?out$/i, /^continue to checkout$/i],
    },
    checkout: {
      path: /\/checkout(\/|$)/i,
      guest: [/^(continue|check ?out) as (a )?guest$/i, /^guest checkout$/i],
      steps: [/^continue( to (shipping|delivery|payment|review))?$/i, /^save (and|&) continue$/i, /^next$/i, /^use this address$/i],
      final: [/\bplace (my |your )?order\b/i, /\bsubmit (my )?order\b/i],
      delivery: 'home',
      payment: 'card',
      done: /confirmation|thank-?you|order-?(complete|success)/i,
    },
  },
};
