// Pokémon Center (Australia) — DRAFT. pokemoncenter.com/en-au. Its pages are behind a bot
// check (Imperva) that turns servers away, so neither Mugibot's server nor anyone here could
// open them: the checkout steps below are a best guess from Pokémon Center's other regions,
// not tested anywhere yet. Members' browsers pass the check like any visitor. During big
// drops Pokémon Center may put everyone in a queue first: ⚡ Buy waits behind it like you do,
// and never tries to skip it.
//
// Product page: "Add to Cart" → straight to the cart → "Checkout" → guest → shipping
//   address → delivery → payment → STOP at "Place Order".
//
// Live sweeps from an admin's browser: its search page (/en-au/search/<keyword>, 32 products
// a page) builds its product list once it's open, so the extension opens it in its own
// window and reads it (like BIG W's).

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
  skuHint: 'The code after /product/ in the link, e.g. …/product/10-10447-108/…',
  skuFromPath: /\/product\/([0-9A-Za-z]+(?:-[0-9A-Za-z]+)+)\//,
  productPath: /^(\/pokemoncenter)?(\/en-au)?\/product\/[0-9A-Za-z]+(-[0-9A-Za-z]+)+\/[^/?#]+\/?$/,
  searchPath: '/search/{q}',
  sweep: { from: 'browser', parser: 'generic', render: true, path: '/search/{q}', minSeconds: 30 },
  monitor: { server: true, browser: true },
  flow: {
    product: {
      add: [/^add to (cart|bag)$/i, /\bpre-?order\b/i],
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
