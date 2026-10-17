// City Beach (Australia) — DRAFT checkout, built from its real pages (Oct 2026): product page,
// "Add To Bag", the mini bag, the bag and its one-page checkout (Salesforce Commerce Cloud),
// walked up to — never past — the final button. Tested on the City Beach-style dummy store.
//
// Product page: "Add To Bag" (the store's cart answers "Product added to cart"; the bag link
//   reads "Cart 1 Items") → straight to /au/checkout (stage "customer"): your email →
//   "Continue as guest" → "Delivery" → "Delivery to my address", name, mobile, address →
//   "Submit shipping" → card (Salesforce Payments' card boxes, in a payment frame) →
//   STOP at "Confirm & pay".
// Pop-ups over the page: Global-e's "Change Your Shipping Country" (for visitors outside
// Australia) and the store's marketing pop-up — clicks go to the page's own buttons, so they
// don't get in the way; marketing pop-ups with an email box are closed.
//
// Live sweeps from Mugibot's server: its search page (server-made, a tile per product with its
// code, name and price; stock shows on the product page itself, which the monitor reads).
export default {
  id: 'citybeach',
  name: 'City Beach',
  base: 'https://www.citybeach.com/au',
  hosts: ['www.citybeach.com'],
  // Only the Australian store (the same address serves New Zealand's).
  pathPrefix: '/au',
  devPath: '/citybeach',
  flowStatus: 'draft',
  flowNote: 'Built from its real pages up to the final button; tested on the City Beach-style dummy store. Not run end to end on citybeach.com yet.',
  skuLabel: 'Product code',
  skuHint: 'The code at the end of the link, e.g. …/20424049-01.html',
  skuFromPath: /\/(\d{6,10}-\d{2})\.html/,
  productPath: /^(\/au|\/citybeach)\/[^/]+\/\d{6,10}-\d{2}\.html$/,
  searchPath: '/search?q={q}',
  sweep: { from: 'server', parser: 'citybeach', path: '/search?q={q}&srule=newest&sz=48', minSeconds: 10 },
  account: { signIn: '/login' },
  // (Its pages answer quickly: a VIP drop's pages can be read a couple of seconds apart.)
  monitor: { server: true, browser: true, hostGapSeconds: 2 },
  flow: {
    product: {
      add: [/^add to bag$/i, /^pre-?order\b/i],
      waitMs: 12000,
    },
    added: {
      checkout: [/^check ?out$/i],
      viewBag: [/^view (your )?bag$/i],
    },
    bag: {
      path: /\/cart(\/|$)/i,
      checkout: [/^check ?out$/i],
    },
    checkout: {
      // /au/checkout?stage=customer → shipping → payment, all one page.
      path: /\/checkout(\/|$)/i,
      // Straight there once it's in the bag (the bag page isn't needed).
      url: '/checkout',
      guest: [/^continue as guest$/i],
      choose: [/^delivery$/i],
      steps: [/^submit shipping$/i, /^continue( to (shipping|payment|delivery))?$/i, /^next$/i],
      final: [/^confirm (&|and) pay$/i, /\bplace (my |your )?order\b/i],
      // A "place order" stage after the final button (its PayPal path uses one): its own button, pressed once.
      review: { path: /stage=placeOrder/i },
      delivery: 'home',
      payment: 'card',
      done: /order-?confirm|confirmation|thank-?you|Order-Confirm/i,
    },
  },
};
