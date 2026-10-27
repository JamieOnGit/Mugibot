// The Gamesmen — an Australian games and toy retailer (since 1982, its warehouse in Sydney), on
// Magento. As its real checkout goes (a member's walk-through, Oct 2026), tested on the
// Magento-style dummy store (/gamesmen):
//
// Product page: "Add to Cart" / "Pre-order" (any of the add words: words.js) → Magento's mini cart
//   says "You added … to your shopping cart" → straight to checkout (the cart's "CHECKOUT" opens
//   the same page) → as a guest, under Shipping Address: email, first and last name, street address
//   (free text), suburb, state/territory (a drop-down, full names), postcode, country (Australia
//   already), mobile / phone → "I have a different billing address" left unticked → Shipping
//   Methods: "Standard" (else the first one it offers) → Payment Method: "Credit card", then card
//   number, expiry date (MM/YY) and security code → "I agree to the Terms and Conditions and the
//   Refund and Cancellation policy." ticked → STOP at "CONFIRM AND PAY" (an armed Auto-checkout run
//   presses it, after its checks).
//   Signed in with your address saved: the same, the address already there — Standard, Credit
//   card, the card, the terms box, "CONFIRM AND PAY".
//
// Live sweeps: Mugibot's server tries first, but The Gamesmen's Cloudflare turns servers away
// ("Sorry, you have been blocked"), so after its first refusal an admin's browser stands in: it
// opens the store's search page (newest first) in a window of its own and reads the products off it:
// its own tiles (Hyvä, read from a copy of its real page: name, the price shown, a struck-through old
// one, "Add to Cart" or "Pre-Order") — or Magento's usual ones, or any priced product on the page.
// The server tries again every so often and takes back over if it's ever let in.

import { ADD_WORDS } from '../monitor/words.js';

export default {
  id: 'gamesmen',
  name: 'The Gamesmen',
  base: 'https://www.gamesmen.com.au',
  hosts: ['www.gamesmen.com.au', 'gamesmen.com.au'],
  devPath: '/gamesmen',
  platform: 'magento',
  flowStatus: 'beta',
  flowNote: 'Built from a walk-through of its real checkout; tested on the Magento-style dummy store. Your details (or your saved address), Standard shipping, Credit card, the terms box ticked, then CONFIRM AND PAY.',
  skuLabel: 'Product link name',
  skuHint: 'The part after gamesmen.com.au/ in the link, e.g. pokemon-tcg-mega-evolution-pitch-black-elite-trainer-box',
  // Magento's product links are the product's name, one level deep (no .html at The Gamesmen).
  skuFromPath: /^(?:\/gamesmen)?\/([a-z0-9]+(?:-[a-z0-9]+){2,})\/?$/,
  productPath: /^(\/gamesmen)?\/[a-z0-9]+(-[a-z0-9]+){2,}\/?$/,
  productPathFromSku: '/{sku}',
  searchPath: '/catalogsearch/result/?q={q}',
  sweep: {
    from: 'browser',
    parser: 'magento',
    // Newest first ("Recently Listed", one of its sort orders): a new listing is on the first page the
    // moment it's up, whatever else the keyword finds (its "pokemon" search runs to hundreds: plush,
    // figures, games…).
    path: '/catalogsearch/result/?q={q}&product_list_order=recently-listed',
    pagePath: '&p={page}',
    pages: 2,
    newestFirst: true,
    // The page is opened and read once it's drawn (a search provider may draw it in the browser).
    render: true,
    // 1.19.1: the page is read once its results are there — its menu's links (/<name> too, like its
    // products) no longer count as the product list, read before the results were drawn.
    extension: '1.19.1',
  },
  // Store login monitor: Magento's own "who's signed in" (what its pages ask for): your name, or nothing.
  account: { signIn: '/customer/account/login/', check: { path: '/customer/section/load/?sections=customer', signedIn: /"firstname"\s*:\s*"[^"]+"/, signedOut: /"customer"\s*:\s*(\{\s*\}|\[\s*\]|\{\s*"data_id")/ } },
  monitor: { server: true, browser: true },
  flow: {
    product: { add: ADD_WORDS, waitMs: 12000 },
    added: {
      checkout: [/^(proceed to )?check ?out$/i, /^go to checkout$/i],
      viewBag: [/\bview (and edit )?(shopping )?cart\b/i],
      confirm: [/you added .+ to your shopping cart/i],
    },
    bag: {
      path: /\/checkout\/cart(\/|$)/i,
      url: '/checkout/cart/',
      checkout: [/^(proceed to )?check ?out$/i],
    },
    checkout: {
      // The one-page checkout (/checkout/, or the module's /onestepcheckout/) — not the cart.
      path: /\/(checkout|onestepcheckout)(\/(?!cart)|$)/i,
      url: '/checkout/',
      // Payment Method: "Credit card" first — its card boxes only show once it's chosen.
      choose: [/^credit ?card$/i, /^credit ?\/ ?debit card$/i],
      steps: [/^next$/i, /^continue$/i],
      // Shipping Methods: "Standard", else the first one it offers.
      shipping: [/^standard\b/i, /\bstandard\b/i],
      shippingFallback: 'first',
      // "I have a different billing address": never ticked.
      untick: [/different billing address/i],
      final: [/^confirm (and|&) pay$/i, /^place order$/i],
      delivery: 'home',
      payment: 'card',
      done: /\/checkout\/onepage\/success|\/onestepcheckout\/.*success|\/success\/?$|thank-?you/i,
    },
  },
};
