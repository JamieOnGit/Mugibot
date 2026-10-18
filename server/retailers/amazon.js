// Amazon AU — as Amazon's real checkout goes (a member's walk-through, Oct 2026), tested on the
// Amazon-style dummy store. Amazon only sells to signed-in customers (no guest checkout): stay
// signed in at Amazon in the browser with the extension — the panel and your dashboard say so
// when you're not, and Auto-checkout doesn't start while you're signed out.
//
// Product page: "Buy Now" (straight to checkout; "Add to Cart" only if there's no Buy Now) → if
//   Amazon offers "30 days free Prime" on the way: "No thanks" → checkout, with the address and
//   card saved in your Amazon account → STOP at "Place your order" (⚡ Buy). Auto-checkout presses
//   it once, after checking the order total against your limits (docs/AUTO-CHECKOUT.md). Amazon's
//   quick checkout (a window over the product page, sometimes shown instead) is filled in the same
//   way, in its frame (checkout.frames).

export default {
  id: 'amazon',
  name: 'Amazon AU',
  base: 'https://www.amazon.com.au',
  hosts: ['www.amazon.com.au'],
  // Where this retailer's copy lives in the dummy store (npm run mockstore): its search page, for the sweeps.
  devPath: '/amazon',
  // The dummy store's copy of Amazon's quick checkout frame.
  devFrames: [/\/amazon\/checkout\/turbo/],
  flowStatus: 'beta',
  flowNote: 'Buy Now → (no thanks to Prime) → your Amazon address and card → Place your order. You must be signed in to Amazon in this browser.',
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
    from: 'browser', parser: 'amazon', inPage: true, openPath: '', expect: 'html',
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
    // "Buy Now" first (straight to checkout); "Add to Cart" where there's none.
    product: { add: [/^add to cart$/i], buyNow: [/^buy now$/i], waitMs: 12000 },
    added: { checkout: [/\bproceed to (checkout|buy)\b/i], viewBag: [/^go to cart$/i] },
    // (url: the cart's own page, for when nothing on the product page leads there.)
    bag: { path: /\/(gp\/cart|cart)/i, url: '/gp/cart/view.html', checkout: [/\bproceed to (checkout|buy)\b/i] },
    checkout: {
      path: /\/(gp\/buy|checkout)\//i,
      // Amazon's "Try Prime free for 30 days" on the way (a page or a pop-up): "No thanks".
      choose: [/^no,? thanks\.?$/i, /^no thanks,? continue/i],
      steps: [/^use this address$/i, /^use this payment method$/i, /^continue$/i],
      final: [/\bplace your order\b/i, /\bbuy now\b/i],
      // Amazon's quick checkout, in a window over the product page (sometimes shown instead).
      frames: [/^https:\/\/www\.amazon\.com\.au\/checkout\/turbo/i],
      delivery: 'home',
      // Paid with the card saved in your Amazon account: nothing to type in.
      payment: 'account',
      done: /thankyou|thank-you/i,
    },
  },
};
