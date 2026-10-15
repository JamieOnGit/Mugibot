// Amazon AU — DRAFT. Restock checks work from the ASIN; for checkout Amazon
// uses the address and card saved in your Amazon account, so Mugibot only
// adds to cart and opens checkout. Never presses "Buy Now" or "Place your order".

export default {
  id: 'amazon',
  name: 'Amazon AU',
  base: 'https://www.amazon.com.au',
  hosts: ['www.amazon.com.au'],
  flowStatus: 'draft',
  flowNote: 'Adds to cart and opens checkout; Amazon fills in your saved address and card. Not tested yet.',
  skuLabel: 'ASIN',
  skuHint: 'The 10-character code after /dp/ in the link',
  skuFromPath: /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/,
  productPath: /\/(dp|gp\/product)\/[A-Z0-9]{10}/,
  productPathFromSku: '/dp/{sku}',
  searchPath: '/s?k={q}',
  monitor: { server: true, browser: true, hostGapSeconds: 10 },
  hints: { availabilityRe: /(^|[\s_-])(availability|outOfStock)([\s_-]|$)/i },
  flow: {
    product: { add: [/^add to cart$/i], quantity: 'page', waitMs: 12000 },
    added: { checkout: [/\bproceed to (checkout|buy)\b/i], viewBag: [/^go to cart$/i] },
    bag: { path: /\/(gp\/cart|cart)/i, checkout: [/\bproceed to (checkout|buy)\b/i] },
    checkout: {
      path: /\/(gp\/buy|checkout)\//i,
      steps: [/^use this address$/i, /^use this payment method$/i, /^continue$/i],
      final: [/\bplace your order\b/i, /\bbuy now\b/i],
      delivery: 'home',
      payment: 'card',
      done: /thankyou|thank-you/i,
    },
  },
};
