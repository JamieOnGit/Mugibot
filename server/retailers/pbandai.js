// Premium Bandai (Australia) — p-bandai.com/au, Bandai Namco's own store (One Piece Card Game,
// Digimon, Gundam…, mostly pre-orders with order windows). As its real checkout goes (a member's
// walk-through, Oct 2026), tested on the Premium Bandai-style dummy store. Its pages are behind a
// bot check that turns servers away; members' browsers pass it like any visitor.
//
// Product page: "PLACE PRE-ORDER" (or "Add to Cart") → "View Cart" → "Proceed to Checkout" →
//   Global-e's checkout (a payment company), in a frame on the page (checkout.frames: frame.js fills
//   it in there): first and last name, email, area (Australia), address lines 1 and 2, city /
//   suburb, postcode, state (a drop-down), phone (after the +61 already shown) — signed in, your
//   billing address is already there and the delivery address is "Default (same as billing
//   address)" → the shipping method it picked → CREDIT CARD (already chosen): card number, expiry
//   month and year (drop-downs), CVV → the "I confirm no returns or refunds… I have read and agree
//   to the Purchase Agreement" box ticked → STOP at "Pay and Place Order" (⚡ Buy). Auto-checkout
//   presses it once, in the frame, after the same checks as on any checkout.
//
// Live sweeps from an admin's browser: its search page gets its products from the site's own
// search JSON (/api/search, newest first, up to 100 at a time), asked for with the region in a
// header (x-g1-area-code: au; without it the site answers with an error). The extension keeps a
// Premium Bandai page open in its own window and asks for that JSON from inside it, the way the
// page does (like EB Games'). (The search page itself answered "PAGE NOT AVAILABLE" when tried
// in Oct 2026, even from the site's own search box, while this JSON answered fine.)

import { ADD_WORDS } from '../monitor/words.js';

export default {
  id: 'pbandai',
  name: 'Premium Bandai',
  base: 'https://p-bandai.com/au',
  hosts: ['p-bandai.com', 'www.p-bandai.com'],
  // Only the Australian store (the same address serves every region's).
  pathPrefix: '/au',
  devPath: '/pbandai',
  // The dummy store's copy of Global-e's checkout frame.
  devFrames: [/\/ge-checkout\b/],
  flowStatus: 'beta',
  flowNote: 'Built from a walk-through of its real checkout (Global-e\'s, in a frame); tested on the Premium Bandai-style dummy store. Signed in or as a guest.',
  skuLabel: 'Item code',
  skuHint: 'The code after /item/ in the link, e.g. N2863373001',
  skuFromPath: /\/item\/([A-Z]\d{6,15})/,
  productPath: /^(\/pbandai)?(\/au)?\/item\/[A-Z]\d{6,15}\/?$/,
  productPathFromSku: '/item/{sku}',
  searchPath: '/search?keyword={q}',
  sweep: {
    from: 'browser', parser: 'pbandai', inPage: true, openPath: '', fromOrigin: true,
    path: '/api/search?keyword={q}&limit=100&offset=0&sortType=NewArrival',
    headers: { 'x-g1-area-code': 'au' },
    // Needs the extension that sends those headers.
    extension: '1.8.1',
    minSeconds: 30,
  },
  // Store login monitor: the page's USER_DATA has the member ("loggedInMember") once you're signed in.
  // (Guests can check out too — signed in, your billing address is already there.)
  account: { signIn: '', check: { path: '', signedIn: /USER_DATA\s*=\s*\{[^\n]*"loggedInMember"\s*:\s*\{/, signedOut: /USER_DATA\s*=\s*\{/ } },
  monitor: { server: true, browser: true },
  flow: {
    product: {
      // "PLACE PRE-ORDER" when it drops (a pre-order), or "Add to Cart".
      add: ADD_WORDS,
      waitMs: 15000,
    },
    added: {
      checkout: [/^(proceed to )?check ?out$/i],
      viewBag: [/\b(view|go to) cart\b/i],
    },
    bag: {
      path: /\/cart(\/|$)/i,
      checkout: [/^(proceed to |secure )?check ?out$/i, /^proceed to purchase$/i],
    },
    checkout: {
      path: /\/(checkout|order)(\/|$)/i,
      // Global-e's checkout, in a frame on the page: run in there (frame.js), the final button too.
      inFrame: true,
      frames: [/^https:\/\/([a-z0-9-]+\.)*global-e\.com\//i],
      // Signed in: the delivery address is "Default (same as billing address)". CREDIT CARD is chosen already.
      // (Matched against the words alone: brackets and the like are left out.)
      choose: [/^default \(?same as (the )?billing address\)?$/i, /^credit card$/i],
      steps: [/^continue( to (shipping|delivery|payment))?$/i, /^next$/i],
      final: [/^pay (and|&) place (my |your )?order$/i, /\bplace (my |your )?order\b/i, /\bpay now\b/i, /\bconfirm (my |your )?order\b/i],
      // The phone box comes after the +61 already shown: the number without its leading 0.
      phoneLocal: true,
      delivery: 'home',
      payment: 'card',
      done: /confirmation|thank-?you|order-?(complete|success)/i,
    },
  },
};
