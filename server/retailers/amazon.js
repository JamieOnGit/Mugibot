// Amazon AU — DRAFT. Restock checks work from the ASIN; for checkout Amazon
// uses the address and card saved in your Amazon account (you must be signed in),
// so Mugibot adds to cart and opens checkout. ⚡ Buy never presses "Buy Now" or
// "Place your order"; Auto-checkout presses "Place your order" once, after checking
// the order total against your limits (docs/AUTO-CHECKOUT.md).

export default {
  id: 'amazon',
  name: 'Amazon AU',
  base: 'https://www.amazon.com.au',
  hosts: ['www.amazon.com.au'],
  // Where this retailer's copy lives in the dummy store (npm run mockstore): its search page, for the sweeps.
  devPath: '/amazon',
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
  // Live sweeps, from an admin's browser: Amazon's search, newest first (two pages of 48), with
  // "tcg" added to the keyword. At most one search every 20 seconds. Amazon's results don't
  // say who sells each product, so marketplace sellers can't be told apart here.
  // Amazon turns Mugibot's server away (HTTP 503, "An error occurred" — tried Oct 2026), so the
  // extension keeps an Amazon page open in its own window and asks for each search page from
  // inside it, like the site's own pages do (expect: 'html' — a page, not JSON).
  sweep: {
    from: 'browser', formerDefault: 'server', parser: 'amazon', inPage: true, openPath: '', expect: 'html',
    path: '/s?k={q}&s=date-desc-rank', pagePath: '&page={page}', pages: 2, addWord: 'tcg', minSeconds: 20,
    // Needs the extension that knows a search page isn't a bot check.
    extension: '1.11.0',
  },
  // Store login monitor: Your Account sends you to Amazon's sign-in (/ap/signin) when you're signed out.
  // required: Amazon only checks out signed in (Auto-checkout doesn't start while you're signed out).
  account: { signIn: '/gp/css/homepage.html', required: true, check: { path: '/gp/css/homepage.html', signedOutUrl: /\/ap\/signin/, signedIn: /nav-link-accountList-nav-line-1"[^>]*>\s*Hello, (?!sign in)/i } },
  monitor: { server: true, browser: true, hostGapSeconds: 10 },
  hints: { availabilityRe: /(^|[\s_-])(availability|outOfStock)([\s_-]|$)/i },
  flow: {
    product: { add: [/^add to cart$/i], waitMs: 12000 },
    added: { checkout: [/\bproceed to (checkout|buy)\b/i], viewBag: [/^go to cart$/i] },
    bag: { path: /\/(gp\/cart|cart)/i, checkout: [/\bproceed to (checkout|buy)\b/i] },
    checkout: {
      path: /\/(gp\/buy|checkout)\//i,
      steps: [/^use this address$/i, /^use this payment method$/i, /^continue$/i],
      final: [/\bplace your order\b/i, /\bbuy now\b/i],
      delivery: 'home',
      // Paid with the card saved in your Amazon account: nothing to type in.
      payment: 'account',
      done: /thankyou|thank-you/i,
    },
  },
};
