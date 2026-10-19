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
// Mugibot doesn't run. The extension checks shop.app/account every 10 minutes (the store login monitor),
// Auto-checkout doesn't start while you're seen signed out, and a run that never reaches Shop's
// checkout says so (the tab is left on the store's checkout for you).

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
  // ⚡ Buy and Auto-checkout need the extension that runs on Shop's checkout (it says so before starting).
  acoVersion: '1.22.0',
  flowStatus: 'beta',
  flowNote: "A store's Shop checkout link: Shop's checkout with your Shop details and card, the store's required boxes ticked, \"Pay now\". Signed in to Shop only. Tested on a Shop-style dummy checkout.",
  skuLabel: 'Checkout link',
  skuHint: "Paste the store's whole checkout link (…/cart/<number>:<quantity>)",
  account: {
    // No guest checkout here: signed out, the link goes to the store's own checkout instead.
    required: true,
    signIn: '/account',
    // Shop's account page: "Sign in to your account" signed out (seen Oct 2026); the page itself, signed in.
    check: { path: '/account', signedOut: /Sign in to your account/i, signedInPage: /<title>[^<]*Manage account[^<]*<\/title>/i },
  },
  // (The server asks the store about each option; it's not a page a browser needs to read.)
  monitor: { server: true, browser: false, intervalSeconds: 20 },
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
      // What the store says when it won't sell it to you now: nothing's bought.
      unavailable: [/not available for purchase/i, /\b(is|are) (sold out|out of stock|no longer available|unavailable)\b/i],
      // Said by the store until its box is ticked (Mugibot ticks it): not a reason to stop.
      ignoreErrors: [/must accept (the )?membership agreement/i],
      // After "Pay now", Shop goes on to the store's own order page (another address): that's the order placed.
      leaves: true,
      done: /thank[-_]?you|\/orders?\/\w+/i,
    },
  },
};
