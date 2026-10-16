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
  // Amazon's own add-to-cart link.
  cartPath: '/gp/aws/cart/add.html?ASIN.1={sku}&Quantity.1={qty}',
  searchPath: '/s?k={q}',
  // Live sweeps, from Mugibot's server: Amazon's search, newest first (two pages of 48), with
  // "tcg" added to the keyword. At most one search every 20 seconds. Amazon's results don't
  // say who sells each product, so marketplace sellers can't be told apart here.
  sweep: { from: 'server', parser: 'amazon', path: '/s?k={q}&s=date-desc-rank', pagePath: '&page={page}', pages: 2, addWord: 'tcg', minSeconds: 20 },
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
