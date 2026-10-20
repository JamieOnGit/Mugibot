// Shop checkout links — BETA. A Shopify store's own cart link (/cart/<variant>:<qty>,<variant>:<qty>…,
// e.g. https://creations.mattel.com/cart/48835830579405:2,40653613531341:1) at any store that checks
// out with Shop (Shop Pay): the link is the order, its quantities included.
//
// Watching: each option in the link is asked about on its own, the way the store's own pages do
// (/variants/<id>.js: whether it can be bought, its name and price) — in stock when every one of
// them is. Its price is the link's: each option's price times its quantity.
//
// ⚡ Buy and Auto-checkout: the link opens Shop's checkout (shop.app/checkout/…/shoppay) with your
// Shop account's address, delivery and card already in. Any box the store needs ticked to check out
// (Mattel Creations' "By selecting, you indicate your acceptance of the Membership Agreement", any box
// the checkout marks as required) is ticked — never newsletters or marketing — then "Pay now": pressed
// by Auto-checkout after its checks (the total within your limits), or left for you (⚡ Buy). "Check
// out as guest" is never pressed.
//
// Signed in to Shop only: signed out, Shop sends the link on to the store's own guest checkout, where
// Mugibot doesn't run — a run that never reaches Shop's checkout says so (the tab is left on the store's
// checkout for you). Whether you're signed in is read on Shop's checkout itself, from what's on the
// screen (your email, "Check out as guest"): Shop Pay can know you on a checkout while shop.app's own
// pages show you signed out, and Shop's pages carry words like "Sign in to your account" in their code
// either way — so neither its account page nor any page's source is read for it (until Oct 2026 they
// were, and a member signed in at checkout was taken for signed out).

/** A cart link's path: /cart/<variant>:<qty>, up to 10 of them (after a dummy store's folder, in tests). */
export const CART_LINK = /^(.*?)\/cart\/(\d{1,20}:\d{1,3}(?:,\d{1,20}:\d{1,3}){0,9})\/?$/;

/** The options and quantities in a cart link's path: [{ id, qty }] — or null when it isn't one. */
export function cartLines(pathname) {
  const m = String(pathname || '').match(CART_LINK);
  if (!m) return null;
  return m[2].split(',').map((x) => { const [id, qty] = x.split(':'); return { id, qty: Math.max(1, Number(qty) || 1) }; });
}

export default {
  id: 'shoplink',
  name: 'Shop',
  base: 'https://shop.app',
  // Shop's checkout, where the extension runs (the store's own address only sends you on to it).
  hosts: ['shop.app'],
  devPath: '/shopapp',
  // Any store's cart link is one of these (retailers/index.js forUrl), unless the store is one Mugibot knows.
  cartLinks: true,
  // ⚡ Buy and Auto-checkout need the extension that runs on Shop's checkout (it says so before starting):
  // 1.24.0 reads your Shop sign-in off the checkout's screen and waits there while it isn't on sale yet.
  acoVersion: '1.24.0',
  flowStatus: 'beta',
  flowNote: "A store's Shop checkout link: Shop's checkout with your Shop details and card, the store's required boxes ticked, \"Pay now\". Signed in to Shop only. Tested on a Shop-style dummy checkout.",
  skuLabel: 'Checkout link',
  skuHint: "Paste the store's whole checkout link (…/cart/<number>:<quantity>)",
  account: {
    // No guest checkout here: signed out, the link goes to the store's own checkout instead.
    required: true,
    signIn: '/account',
    check: {
      // (Never fetched by the extension's 10-minute check.)
      fetch: false,
      // On Shop's checkout: signed in when it shows your email by its logo and offers "Check out as guest"
      // beside your saved details (both, as a member's signed-in checkout did). Never "signed out" from a
      // page: only a link that went on to the store's guest checkout says that.
      onScreen: { where: /\/checkout\//i, in: [/^check ?out as (a )?guest$/i], email: true },
    },
  },
  // (The server asks the store about each option every 5 seconds — quick and small, the store's own
  // pages ask the same; it's not a page a browser needs to read.)
  // (Below the usual 20 s floor, and a second apart at a store rather than five: each option's JSON is tiny.)
  monitor: { server: true, browser: false, intervalSeconds: 5, floorSeconds: 5, hostGapSeconds: 1 },
  flow: {
    checkout: {
      path: /\/checkout\//i,
      final: [/^pay now$/i],
      // Shop's way out to the store's guest checkout: never pressed.
      notFinal: [/^check ?out as (a )?guest$/i],
      // The store's own boxes: its membership agreement (Mattel Creations'), and terms to accept.
      tick: [/membership agreement/i, /\baccept(ance)?\b.{0,60}\b(agreement|terms|conditions)\b/i, /\bagree\b.{0,60}\b(agreement|terms|conditions)\b/i],
      // And any box the checkout itself marks as required (never marketing: fill.js).
      tickRequired: true,
      // Shop has your address, delivery and card: nothing of yours is typed in, and its choices are left as they are.
      ownDetails: true,
      payment: 'account',
      // What the store says when it's sold out: nothing's bought, and it stops there.
      unavailable: [/\b(is|are) (sold out|out of stock|no longer available|unavailable)\b/i],
      // "This Product is not available for purchase": which it may say until the drop's live (a member's
      // Mattel checkout, Oct 2026: shown with the membership notice before anything was pressed, while the
      // store's own data already said in stock). So it isn't a reason not to press "Pay now" once; the store
      // saying it anew to the press (a fresh notice, the page still here), nothing's bought and the run waits
      // on the checkout: looked at again every 5 seconds, "Pay now" pressed again only once the notice has
      // gone — for 30 minutes at most.
      waitLive: { notices: [/not available for purchase/i], everyMs: 5000, forMs: 30 * 60 * 1000 },
      // Said by the store until its box is ticked (Mugibot ticks it): not a reason to stop.
      ignoreErrors: [/must accept (the )?membership agreement/i],
      // After "Pay now", Shop goes on to the store's own order page (another address): that's the order placed.
      leaves: true,
      done: /thank[-_]?you|\/orders?\/\w+/i,
    },
  },
};
