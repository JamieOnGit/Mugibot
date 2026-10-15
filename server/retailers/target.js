// Target — DRAFT. Product links and restock checks are set up; the checkout
// steps below are a first guess and have NOT been tested anywhere yet. Send
// the real flow (docs/RETAILER-FLOWS.md).

export default {
  id: 'target',
  name: 'Target',
  base: 'https://www.target.com.au',
  hosts: ['www.target.com.au'],
  flowStatus: 'draft',
  flowNote: 'Not tested yet — the checkout fill is a best guess. Waiting for the real flow.',
  skuLabel: 'Product code',
  skuHint: 'The code at the end of the link, e.g. …/p/…/71234567',
  skuFromPath: /^\/p\/[^/]+\/([A-Za-z0-9_-]+)/,
  productPath: /^\/p\/[^/]+\/[A-Za-z0-9_-]+\/?$/,
  searchPath: '/search?text={q}',
  monitor: { server: true, browser: true },
  flow: {
    product: { add: [/\badd to (cart|basket|bag)\b/i, /\bpre-?order\b/i], quantity: 'page', waitMs: 12000 },
    added: { checkout: [/^(secure )?check ?out( now)?$/i], viewBag: [/\bview (basket|cart|bag)\b/i] },
    bag: { path: /\/(basket|cart)(\/|$)/i, checkout: [/^(secure )?check ?out( now)?$/i, /^proceed to checkout$/i] },
    checkout: {
      path: /\/checkout(\/|$)/i,
      guest: [/^continue as (a )?guest$/i, /^guest checkout$/i],
      steps: [/^continue( to (delivery|payment))?$/i, /^next$/i],
      final: [/\bplace (my |your )?order\b/i, /\bpay now\b/i],
      delivery: 'home',
      payment: 'card',
      done: /confirmation|thank-?you|order-?(complete|success)/i,
    },
  },
};
