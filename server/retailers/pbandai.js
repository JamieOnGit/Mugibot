// Premium Bandai (Australia) — DRAFT. p-bandai.com/au, Bandai Namco's own store (One Piece
// Card Game, Digimon, Gundam…, mostly pre-orders with order windows). Its pages are behind a
// bot check that turns servers away, so its checkout couldn't be seen from here: the steps
// below are a best guess, not tested anywhere yet. Members' browsers pass the check like any
// visitor. Premium Bandai only sells to signed-in members (a Bandai Namco ID): stay signed in
// there — ⚡ Buy never signs in for you. Its checkout is run by Global-e (a payment company,
// in a frame on the page): Mugibot fills your delivery details and card in there too.
//
// Product page: "Add to Cart" → straight to the cart → "Proceed to checkout" → Global-e's
//   checkout (address, delivery, card) → STOP at "Place Order" / "Pay".
//
// Live sweeps from an admin's browser: its search page gets its products from the site's own
// search JSON (/api/search, newest first, up to 100 at a time), asked for with the region in a
// header (x-g1-area-code: au; without it the site answers with an error). The extension keeps a
// Premium Bandai page open in its own window and asks for that JSON from inside it, the way the
// page does (like EB Games'). (The search page itself answered "PAGE NOT AVAILABLE" when tried
// in Oct 2026, even from the site's own search box, while this JSON answered fine.)

export default {
  id: 'pbandai',
  name: 'Premium Bandai',
  base: 'https://p-bandai.com/au',
  hosts: ['p-bandai.com', 'www.p-bandai.com'],
  // Only the Australian store (the same address serves every region's).
  pathPrefix: '/au',
  devPath: '/pbandai',
  flowStatus: 'draft',
  flowNote: 'A best guess — Premium Bandai turns servers away, so its checkout hasn\'t been seen or tested. Stay signed in to your Bandai Namco ID there. Watch each step.',
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
  account: { signIn: '', check: { path: '', signedIn: /USER_DATA\s*=\s*\{[^\n]*"loggedInMember"\s*:\s*\{/, signedOut: /USER_DATA\s*=\s*\{/ } },
  monitor: { server: true, browser: true },
  flow: {
    product: {
      add: [/^add to cart$/i, /\bpre-?order\b/i, /^(buy|purchase) now$/i],
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
      // Global-e's checkout, in a frame on the page: your details and card are filled in there.
      inFrame: true,
      steps: [/^continue( to (shipping|delivery|payment))?$/i, /^next$/i],
      final: [/\bplace (my |your )?order\b/i, /\bpay now\b/i, /\bconfirm (my |your )?order\b/i],
      delivery: 'home',
      payment: 'card',
      done: /confirmation|thank-?you|order-?(complete|success)/i,
    },
  },
};
