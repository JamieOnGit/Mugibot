// The dummy store: fake shops for testing every retailer's flow end to end.
// Never touches a real store. Each shop copies the shape of that retailer's
// real site — its links, buttons and checkout steps — under its own path:
//
//   /kmart    Kmart-style: "Add to bag" → popup "Checkout" → one-page checkout
//             (details → delivery → payment) → "Checkout securely"
//   /bigw     BIG W-style: quantity dropdown → "Add to cart" → drawer "View cart"
//             → cart "Proceed to checkout" → guest → "Home delivery" → address
//             (lookup or manual) → card frame → "Place order"
//   /ebgames  EB Games-style: "Add to Cart" → mini-cart "Checkout" → "Continue
//             as Guest" → shipping → delivery → payment (+ terms) → "Place Order"
//   /jbhifi   Shopify-style (JB Hi-Fi): product JSON, cart page "Check out",
//             one-page checkout → "Pay now"; search suggestions
//   /trainertown  the same Shopify pages (Trainer Town), plus a collection per
//             game with its product list (what the live sweeps read there)
//   /gamerholic  the same Shopify pages (Gamerholic), with its newest-products list
//   /thegamescube  CrystalCommerce-style (The Games Cube): search tiles, an icon-only
//             cart button, the cart API, "Checkout as a guest" → address → shipping
//             and payment → "Place Order"
//   /pokemoncenter  Pokémon Center-style: a search page built once it's open (behind
//             an Imperva-style check that reloads it, when botCheck is on),
//             "Add to Cart" → "View Cart" → "Checkout" → guest → shipping → payment
//             (card frame) → "Place Order"
//   /pbandai  Premium Bandai-style: a Vue page (its Add button works once Vue has
//             wired it up), its search JSON (only with its region header),
//             "Go to Cart" → "Proceed to checkout" → the whole checkout in a
//             Global-e-style frame from another address
//   /pokebox, /goodgames, /collectiblemadness, /cherrycollectables  the same Shopify pages, with
//             Shopify's address suggestions at checkout, its newest-products list and search suggestions
//   /gameology  the same Shopify pages, drawn as Gameology's (FoxTheme's "Hyper"): its product form
//             adding in the background, then its cart drawer — "Checkout" (a submit button posting the
//             cart form) and "View cart"; its cart icon opens the drawer too (drawerShut: the drawer left
//             shut after an add). Its product links name a collection on the way. noPermalink: its cart
//             link (/cart/<variant>:1) not taken (the product page instead). Signed in to its own account
//             (state.signedIn.gameology 'account'): your saved details at checkout, the card still to type.
//   /fromthedeep  the same Shopify pages, drawn as From The Deep Games' (BinderPOS's "Standard" theme): its
//             quantity ("Units", a box between − and + that aren't buttons), "Add To Cart" (a plain button its
//             theme fills in and takes over: Shopify's /cart/add.js in the background, a toast and the header
//             cart's count after), and the header's cart (not a button: a drop-down with "Checkout" and "Your
//             Cart", shut until it's clicked — cartOpens: open after an add). Each game's collection (its
//             singles' too, never read) and its Preorders.
//   /gamesmen  Magento-style (The Gamesmen): "Add to Cart" by AJAX ("You added … to your shopping
//             cart"), the mini cart, its one-page checkout (shipping address, shipping methods table,
//             "Credit card" with Braintree-style card fields, the terms box) → "CONFIRM AND PAY"; its
//             search page (Cloudflare-style "Sorry, you have been blocked" for servers, when refuseServers;
//             drawn a moment after loading by a search provider, under a menu of look-alike links, when
//             searchProvider)
//   /gamesworld  WooCommerce-style (Games World): the product form, its add-to-cart link
//             (?add-to-cart=<id>), "× Remove" cart links, its checkout (selectWoo drop-downs, "Deliver to
//             a different address?" ticked, Stripe's card form or Link) → "Place order"; its product API
//   /target   Target-style: "Add to basket" → an "Often Bought Together" pop-up
//             offering clothes (closed with its ✕) → /checkout → its one-page
//             checkout at /spc/order: guest → home delivery → card → "Place order";
//             its search page's product data in __NEXT_DATA__ (the live sweeps)
//
//   /creations + /shopapp  a Shopify store that checks out with Shop (Mattel Creations-style: its
//             cart links /cart/<variant>:<qty>,… and /variants/<id>.js), and Shop's own checkout
//             (shop.app-style: /shopapp/checkout/<shop>/cn/<token>/en-us/shoppay) with your Shop
//             address, delivery and card in, the store's membership agreement box, "Pay now" and
//             "Check out as guest". Signed out of Shop (shopapp.signedIn false), Shop sends the
//             link back to the store's own guest checkout, as the real one does. Shop's account
//             page (/shopapp/account) says whether you're signed in.
//
// Placing an order: each shop's `decline` (the card is declined) and `threeDS` (the
// bank's "verify it's you" check, in a frame) options, for Auto-checkout's tests. threeDS
// as real checkouts show it, at every kind of checkout here (Kmart's, EB Games', the
// Shopify ones', Shop's, Magento's, WooCommerce's, Global-e's, Amazon's), nothing on the
// checkout saying what it is: 'posted' (the bank's page posted into a frame named for it,
// Adyen's way), 'popup' (into a frame with no name, in a pop-up over the checkout),
// 'nested' (into a frame inside the payment provider's own, with the card boxes), 'window'
// (a window of its own) or 'redirect' (the whole tab sent to the bank's own site — by the
// page, or by the store's server after a posted form). The bank's pages are on bank.test,
// an address the extension may not open. The order's placed once you approve it in your
// bank's app (store.approveBank()), then on to the store's confirmation.
//
// Checkpoints and virtual queues (each shop's `checkpoint` and `queue`, off unless switched on):
//   checkpoint (the Shopify shops: JB Hi-Fi's): Shopify's bot check — /checkpoint is an hCaptcha
//     page, and checkout goes through it until someone solves it. Only a real click (a person's)
//     solves it: a click from a script is counted (botClicks) and does nothing.
//   queue (EB Games, Pokémon Center): a virtual queue — every page is "You're in the queue!" for a
//     visitor not let in yet (Pokémon Center's at /?queue). The page refreshes itself and lets you in
//     admitAfterMs after you joined; ask again sooner than tooSoonMs after your last request and you
//     lose your place (kicks counts it). A visitor with no cookies is always new to the line.
//
// Open the root (/) for the control panel: restock, sell out, list or unlist
// products and watch Mugibot react. A second server on another port serves
// the card boxes so they're cross-origin, like real payment providers.

import http from 'node:http';
import { DUMMY_PRODUCTS, dummyProductPath, slugify } from '../server/presets.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SHOPS = {
  kmart: { name: 'Kmart (dummy)', color: '#e2001a' },
  bigw: { name: 'BIG W (dummy)', color: '#0046be' },
  ebgames: { name: 'EB Games (dummy)', color: '#d22' },
  jbhifi: { name: 'JB Hi-Fi (dummy Shopify)', color: '#222' },
  trainertown: { name: 'Trainer Town (dummy Shopify)', color: '#1d4e89' },
  gamerholic: { name: 'Gamerholic (dummy Shopify)', color: '#6b21a8' },
  toysrus: { name: 'Toys"R"Us (dummy Shopify)', color: '#0b5394' },
  thegamescube: { name: 'The Games Cube (dummy CrystalCommerce)', color: '#0f766e' },
  pokemoncenter: { name: 'Pokémon Center (dummy)', color: '#d32f2f' },
  pbandai: { name: 'Premium Bandai (dummy)', color: '#1f2937' },
  target: { name: 'Target (dummy)', color: '#cc0000' },
  amazon: { name: 'Amazon AU (dummy)', color: '#232f3e' },
  citybeach: { name: 'City Beach (dummy)', color: '#111111' },
  pokebox: { name: 'Pokébox (dummy Shopify)', color: '#d97706' },
  goodgames: { name: 'Good Games (dummy Shopify)', color: '#15803d' },
  collectiblemadness: { name: 'Collectible Madness (dummy Shopify)', color: '#7c3aed' },
  cherrycollectables: { name: 'Cherry Collectables (dummy Shopify)', color: '#be123c' },
  gamesmen: { name: 'The Gamesmen (dummy Magento)', color: '#0f4c81' },
  gamesworld: { name: 'Games World (dummy WooCommerce)', color: '#7f1d1d' },
  gameology: { name: 'Gameology (dummy Shopify)', color: '#0e7490' },
  fromthedeep: { name: 'From The Deep Games (dummy Shopify)', color: '#1e3a8a' },
};
// The Shopify-style shops: the same product, cart and checkout pages.
const SHOPIFY = new Set(['jbhifi', 'trainertown', 'gamerholic', 'toysrus', 'pokebox', 'goodgames', 'collectiblemadness', 'cherrycollectables', 'gameology', 'fromthedeep']);
// (The card shops added in Oct 2026: Shopify's address suggestions as you type, at their checkout.)
const SUGGESTS = new Set(['pokebox', 'goodgames', 'collectiblemadness', 'cherrycollectables', 'gameology', 'fromthedeep']);
const SHOP_RE = new RegExp(`^/(${Object.keys(SHOPS).join('|')})(/.*|$)`);
const LD_AVAIL = { in_stock: 'InStock', preorder: 'PreOrder', out_of_stock: 'OutOfStock' };
// City Beach's marketing pop-up (Emarsys), over the product page a moment after it opens.
const CITYBEACH_POPUP = `<div id="wps_popup" class="wps-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:900;align-items:center;justify-content:center">
  <div class="wps-popup" role="dialog" style="background:#fff;padding:24px;max-width:420px"><button type="button" class="wps-close" aria-label="Close" onclick="document.getElementById('wps_popup').remove()">×</button>
  <h2>Get 10% off your first order</h2><p>Sign up to our newsletter for new arrivals and offers.</p><input type="email" name="wps_email" placeholder="Email address"> <button type="button">Subscribe</button></div></div>
<script>setTimeout(() => { const w = document.getElementById('wps_popup'); if (w) w.style.display = 'flex'; }, 800);</script>`;
const STATES = '<option value="">Select state</option><option value="NSW">New South Wales</option><option value="VIC">Victoria</option><option value="QLD">Queensland</option><option value="WA">Western Australia</option><option value="SA">South Australia</option><option value="TAS">Tasmania</option><option value="ACT">Australian Capital Territory</option><option value="NT">Northern Territory</option>';

export function defaultShops() {
  const out = {};
  for (const [id, list] of Object.entries(DUMMY_PRODUCTS)) {
    out[id] = {
      // (A quantity drop-down at BIG W and Amazon, as theirs; a box elsewhere.)
      products: list.map((p, i) => ({ ...p, listed: p.listed !== false, maxQty: 0, qtyStyle: id === 'bigw' || id === 'amazon' ? 'select' : 'input', lateMs: 0, id: 4400000 + i })),
      cart: [], orders: [], steps: [], data: {},
      // Like a real store on a fresh page: "Add" does nothing until the page's code has
      // started (hydrateMs after load), and the add itself can be slow (addDelayMs).
      hydrateMs: 0, addDelayMs: 0, refuseAdds: false,
      // quiet: the page shows nothing Mugibot can read after an add (no count on the bag link, no
      // "added" message) — only a busy button. refuseAdds: true, or how many adds to refuse first
      // (each says "Something went wrong" for a moment, like a store under load).
      quiet: false,
      // stale: its bag link shows the count from when the page opened and doesn't change after an add (some
      // stores only update it on the next page), and no "added" message. hideBag: no bag link on the product
      // page, and no "added" pop-up — nothing to click after an add. bagButton: other words for the bag
      // page's Checkout button (its link still goes to checkout).
      stale: false, hideBag: false, bagButton: '',
      // A React-style page (like Kmart's): its code wires up "Add" reactMs after the page
      // opens, long before a slow picture lets the page finish loading (slowLoadMs).
      // vueMs: the same for a Vue page (Premium Bandai's).
      reactMs: 0, slowLoadMs: 0, vueMs: id === 'pbandai' ? 600 : 0,
      // searchDelayMs: its search pages and search API answer this much later (a slow store).
      searchDelayMs: 0,
      // A store under a hot drop's load: its product page answers with a short error page this many times
      // first (busyPages: HTTP 503 "Too many requests"), and its Add button is drawn greyed out, turned on
      // greyedMs after the page loads. (busyServed: how many error pages it sent.)
      busyPages: 0, busyServed: 0, greyedMs: 0,
      // decoys: an ordinary page that only looks busy — a picture's lazy-loader, a quantity "spinner", a
      // hidden widget left aria-busy, "Due to high demand" and a price like $502.99 (nothing to wait for).
      decoys: false,
      // cartPopup: its cart, empty, is a pop-up over its home page (/cart goes there), as EB Games' is:
      // "Oh no! currently your cart is empty." ('late': drawn by the page's code 1.5 s after it loads, in
      // plain boxes — no dialog or modal markup — small, under the header.)
      cartPopup: false,
      // Search pages that only fill in their products once open (like Pokémon Center's and Premium Bandai's).
      clientSearch: id === 'pokemoncenter' || id === 'pbandai',
      // A bot check's page first, which reloads the page after a moment (Pokémon Center's search; the delay in ms).
      botCheck: false,
      // When the product page was last sent, and when the last add arrived.
      servedAt: 0, addedAt: 0,
      // Placing an order: the card is declined; or the bank's "verify it's you" check comes up first.
      decline: false, threeDS: false,
      // A hot drop at the final button: the store answers "high demand — please try again" this many times
      // (placeBusy; placeTries counts every press that reached it), each answer placeSlowMs late (its
      // button left as it is meanwhile, like a store that shows nothing while it works). Kmart's final
      // button drawn greyed out, turned on finalGreyedMs after the payment step opens.
      // (placeKeepsError: its last error left up while it works on the next press, word for word.)
      // (placeBusyText: what it says instead — "There was a problem processing your payment", say.)
      placeBusy: 0, placeTries: 0, placeSlowMs: 0, finalGreyedMs: 0, placeKeepsError: false, placeBusyText: '',
      // denied: its bot protection (BIG W's Akamai) answers every page "Access Denied" (deniedServed counts them).
      denied: false, deniedServed: 0,
      // refuseBackground: its bot protection (EB Games' Cloudflare, as members saw it in Oct 2026) answers 403 to anything
      // but a page opened (a visit) or a request one of its own pages makes (same-origin) — the extension's background
      // requests and servers alike (refusedBackground counts them).
      refuseBackground: false, refusedBackground: 0,
      // refuseAsks: …and its own pages' requests too (refusedAsks counts them): only a page opened gets through.
      refuseAsks: false, refusedAsks: 0,
      // savedCard (EB Games signed in): how it shows the card it has for you — a member's showed "...2387 08/27".
      savedCard: '',
      // addNeedsLoad: the cart turns an add away (HTTP 403) until the product page has finished
      // loading and its own start-up is done, this many ms after (like Kmart for a signed-out visitor).
      addNeedsLoad: 0,
      // What the bag page showed each time it was opened (number of items in it).
      bagViews: [],
      // Clear cart: how many things were taken out of the bag (by its own Remove buttons, or Shopify's
      // /cart/clear.js: cleared), "Undo" pressed (Target), and Amazon's "Saved for later" list (saved —
      // moved there: savedMoves; deleted from it: savedDeletes). removeFails: its Remove does nothing;
      // noAjaxCart: a Shopify shop without its cart API (/cart.js, /cart/clear.js).
      // removeDelayMs: each Remove takes this long.
      removed: 0, cleared: 0, undos: 0, saved: [], savedMoves: 0, savedDeletes: 0, removeFails: false, noAjaxCart: false, removeDelayMs: 0,
      // Its checkpoint (Shopify's hCaptcha page) and its virtual queue: see the top of this file.
      checkpoint: { on: false, shown: 0, solved: 0, botClicks: 0, passes: [] },
      // A notice across the top of its product pages ("Big launches use a virtual queue…").
      banner: '',
      // Shopify: "Use shipping address as billing address" comes unticked. The Gamesmen: "I have a
      // different billing address" comes ticked (billingTicked), no "Standard" shipping (noStandard),
      // servers refused like its Cloudflare (refuseServers), its search results drawn by a search
      // provider after the page has loaded, under a menu of /<name> links (searchProvider). Games World:
      // "Deliver to a different address?" comes ticked (shipToDifferent), Stripe's Link connected (link:
      // the saved card, Confirm).
      billingUnticked: false, billingTicked: false, noStandard: false, refuseServers: false, searchProvider: false, shipToDifferent: id === 'gamesworld', link: false,
      // Gameology: its cart drawer left shut after an add (drawerShut: its cart icon opens it); its cart link
      // not taken (noPermalink: the product page instead).
      drawerShut: false, noPermalink: false,
      // From The Deep Games: its header cart's drop-down open after an add (cartOpens), as well as from the cart.
      cartOpens: false,
      // collectOnly: the order can't be delivered — a pre-order that's pick-up only — so its checkout's home
      // delivery is switched off ("Not available for this order") or not there (Shopify: "Your order cannot be
      // shipped"; WooCommerce and Magento: only their pick-up method), and Click & Collect works, with a store to
      // choose as each store has you choose one: Kmart's and BIG W's store finder (a postcode, Search, a store's
      // "Select"), EB Games' drop-down, Target's "Find stores" and "Select store", City Beach's list of stores,
      // Shopify's pick-up locations. (pickup: a Shopify shop's Ship / Pick up choice, Ship chosen — JB Hi-Fi's.)
      // (A product page whose only buy button adds it for Click & Collect: addLabel "Add to cart for Click & Collect".)
      collectOnly: false, pickup: id === 'jbhifi',
      // (log: every request while it's on — { id, at, path, what } — to show nothing asked again too soon.)
      queue: { on: false, admitAfterMs: 4000, refreshMs: 1500, tooSoonMs: 700, wait: 23, lateMs: 0, places: {}, admittedIds: [], kicks: 0, shown: 0, admitted: 0, cookieless: 0, log: [] },
    };
  }
  return out;
}

// Acme Collectibles (a website Mugibot doesn't know): a console and a figure; a limited edition drops later.
export function defaultAcme() {
  return {
    shopify: false, refuse: false,
    products: [
      { handle: 'xbox-series-x-console-1tb', name: 'Xbox Series X Console 1TB', price: 799, status: 'out_of_stock', listed: true },
      { handle: 'luffy-gear-5-figure', name: 'One Piece Luffy Gear 5 Figure', price: 89.95, status: 'in_stock', listed: true },
      { handle: 'xbox-series-x-25th-anniversary-edition', name: 'Xbox Series X 25th Anniversary Limited Edition Console', price: 999, status: 'in_stock', listed: false },
    ],
  };
}

// The Shop-style checkout (/shopapp) and the store that checks out with it (/creations).
export function defaultShopApp() {
  return {
    // Signed in to Shop in this browser (its cookie): the link opens Shop's checkout; otherwise the store's guest checkout.
    signedIn: false,
    // The store's options (what /creations/variants/<id>.js says), Mattel Creations' two from a member's link.
    variants: [
      { id: 48835830579405, name: 'Hot Wheels RLC Exclusive RWB Porsche 930', price: 38, available: true },
      { id: 40653613531341, name: 'Hot Wheels Red Line Club 1-Year Digital Membership', price: 9.99, available: true },
    ],
    // Its "By selecting, you indicate your acceptance of the Membership Agreement" box (required), and
    // the notice about it at the top (shown from the start, as in a member's screenshot, and staying up).
    agreement: true, agreeNotice: true,
    // hiddenBox: that box drawn by the page over a hidden one (the real box display:none, its label beside it);
    // busy: "Pay now" answered "Something went wrong — please try again" this many times first (payTries counts).
    hiddenBox: false, busy: 0, payTries: 0,
    // "This Product is not available for purchase": the store won't sell it now (unavailable: "Pay now"
    // refused, as before a drop's live) — or only the notice, shown before anything's pressed while
    // "Pay now" goes through (notice: as a member's real checkout showed it, with the membership one).
    unavailable: false, notice: false,
    // real: drawn as Mattel Creations' real checkout is (probed Oct 2026) — the box labelled only "By selecting,
    // you indicate your acceptance of the", its "Membership Agreement ↗" link outside the label, not required;
    // "Pay now $47.99" (the total in the button, aria-busy while it's at a press). liveAfter: on sale after this
    // many "not available" answers (0: only when a test says). sameNotice: the notice left up as it is when
    // "Pay now" is turned away again (not drawn anew). payAt: when each press reached the store.
    real: false, liveAfter: 0, sameNotice: false, payAt: [],
    // The store's checkout queue (Mattel's at a drop, on its own site — "Queue - … - Checkout"): queueMs, a cart
    // link waits in line this long first (the page moving on by itself, the ⚡ Buy code left behind); bounceMs, the
    // next "Pay now" is sent back to the queue for this long (the queue reset at the drop). queueViews: its loads.
    queueMs: 0, bounceMs: 0, queueViews: 0,
    // Its discount box, drawn as Mattel's real one (name "reductions", "Discount code", Apply off until something's
    // typed, "Apply Discount Code"): codes it takes (code → $ off), the codes tried, and those applied.
    discounts: { RLC10: 10 }, discountTries: [],
    // Shopify's "Too many checkout attempts" (a member's, Oct 2026): throttleNext, the next "Pay now" gets it and
    // so does every press and every checkout opened for throttleMs; throttled counts them.
    throttleNext: false, throttleMs: 0, throttleUntil: 0, throttled: 0,
    // Your bank's check after "Pay now" (bankJs: 'posted' or 'popup' over Shop's checkout), the order placed once
    // you approve it (store.approveBank()); challenged counts them.
    threeDS: false, challenged: 0,
    shipping: 32,
    checkouts: {}, orders: [], refused: [], shown: 0, guestViews: 0, accountViews: 0,
  };
}

function page(shop, title, body, { head = '', bagCount = null, noBag = false } = {}) {
  const s = SHOPS[shop] || { name: 'Dummy store', color: '#444' };
  const base = shop ? `/${shop}` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px system-ui;margin:0;background:#fafafa;color:#222}header,footer{background:${s.color};color:#fff;padding:10px 20px}header a{color:#fff}main{max-width:900px;margin:20px auto;padding:0 20px}
button,.btn{background:${s.color};color:#fff;border:0;padding:10px 16px;border-radius:6px;font-size:15px;cursor:pointer;text-decoration:none;display:inline-block}
button[disabled]{background:#999;cursor:default}label{display:block;margin:8px 0}input,select{padding:6px;font-size:15px;width:320px;max-width:100%}
.drawer{position:fixed;right:0;top:0;bottom:0;width:320px;background:#fff;box-shadow:-4px 0 12px rgba(0,0,0,.2);padding:20px;display:none}.drawer.open{display:block}
.tile{display:inline-block;border:1px solid #ddd;padding:10px;margin:6px;width:200px;vertical-align:top}.err{color:#c00;font-weight:600}
.drawer.modal{left:8%;right:8%;top:8%;bottom:auto;width:auto;border-radius:8px}.obt-item{display:inline-block;width:22%;vertical-align:top;margin:4px}
.choice[aria-pressed=true]{outline:3px solid #0a0}.dummy{background:#fff3cd;padding:6px 20px;font-size:13px}</style>${head}</head>
<body><div class="dummy">⚠ Dummy store for testing Mugibot — nothing here is real. <a href="/">Control panel</a></div>
<header><a href="${base}/">${esc(s.name)}</a> · ${noBag ? '' : bagLink(shop, bagCount)} · <!--mgb-account--></header><main>${body}</main>
<footer>${esc(s.name)} is a fake store for testing.</footer>${shop === 'gameology' ? GAMEOLOGY_DRAWER : ''}${shop === 'fromthedeep' ? FTD_CART : ''}</body></html>`;
}

// Gameology's cart drawer (FoxTheme's "Hyper", as its real page has it): shut until its theme slides it open —
// after an add, or from the cart icon — drawn from the cart (/cart.js) each time it opens: the lines, the
// subtotal, "Checkout" (a submit button named checkout, in a form posting to /cart) and "View cart".
// __gmCart(true) opens it, (false) shuts it, ('count') only brings the cart icon's count up to date.
const GAMEOLOGY_DRAWER = `<style>.hidden{display:none!important}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style>
<cart-drawer id="CartDrawer" class="drawer cart-drawer drawer--right" hidden style="color:#222;z-index:60">
  <div class="drawer__header"><h3 class="drawer__heading">Your cart</h3><button type="button" class="drawer__close-btn" aria-label="Close" aria-controls="CartDrawer-close" style="background:none;color:#222">✕</button></div>
  <div id="CartDrawerEmpty" class="cart-drawer__empty"><p>Your cart is empty</p></div>
  <cart-items><ul role="list" class="cart-product-body-list" id="CartDrawerItems" style="padding:0;list-style:none"></ul></cart-items>
  <div id="CartDrawerFooter" class="drawer__footer cart-drawer__footer hidden">
    <p>Subtotal <b id="CartDrawerTotal"></b></p>
    <form action="/gameology/cart" method="post" id="CartDrawer-Form" novalidate><button class="btn btn--secondary flex-grow" type="submit" name="checkout"><span class="btn__text">Checkout</span></button></form>
    <p><a href="/gameology/cart" class="view-cart-button" style="color:#0e7490">View cart</a></p>
  </div>
</cart-drawer>
<script>
  window.__gmCart = async (open) => {
    const d = document.getElementById('CartDrawer');
    if (open === false) { d.hidden = true; d.classList.remove('open'); return; }
    const c = await (await fetch('/gameology/cart.js')).json();
    document.getElementById('CartDrawerItems').innerHTML = c.items.map((x) => '<li class="cart-item"><span class="cart-item__name">' + x.title.replace(/</g, '&lt;') + '</span> × ' + x.quantity + ' — $' + (x.price / 100).toFixed(2) + '</li>').join('');
    document.getElementById('CartDrawerEmpty').hidden = c.item_count > 0;
    document.getElementById('CartDrawerFooter').classList.toggle('hidden', !c.item_count);
    document.getElementById('CartDrawerTotal').textContent = '$' + (c.total_price / 100).toFixed(2);
    const n = document.querySelector('#bag-link cart-count');
    if (n) { n.textContent = String(c.item_count); n.setAttribute('aria-label', c.item_count + ' items'); n.hidden = !c.item_count; }
    if (open === true) { d.hidden = false; d.classList.add('open'); }
  };
  document.addEventListener('click', (e) => {
    if (e.target.closest('[aria-controls="CartDrawer-close"]')) { window.__gmCart(false); return; }
    // The cart icon: the drawer, not the cart page.
    if (!e.target.closest('[aria-controls="CartDrawer"]')) return;
    e.preventDefault();
    window.__gmCart(true);
  });
</script>`;

// From The Deep Games' header cart (BinderPOS's "Standard"): not a button but a div that toggles its drop-down
// (aria-role, not role; "collapse" until it's clicked), the count beside it, and in the drop-down the lines,
// "Checkout" (/checkout) and "Your Cart" (/cart). __ftdCart(true) opens it, ('count') only updates it.
const FTD_CART = `<style>.cart-container{display:none}.cart-container.in{display:block}.toastify{position:fixed;left:15px;bottom:15px;background:#eb7c00;color:#fff;padding:12px 20px;border-radius:2px}</style>
<script>
  window.__ftdCart = async (open) => {
    const c = await (await fetch('/fromthedeep/cart.js')).json();
    document.querySelector('.cart-products-count').textContent = String(c.item_count);
    document.querySelector('.cart-container .cart-items').innerHTML = c.items.map((x) => '<li>' + x.title.replace(/</g, '&lt;') + ' × ' + x.quantity + '</li>').join('');
    document.querySelector('.cart-container .cart-links').hidden = !c.item_count;
    document.querySelector('.cart-container .cart__empty').hidden = !!c.item_count;
    if (open === true) { document.querySelector('.cart-container').classList.add('in'); document.querySelector('.cart-title').classList.remove('collapsed'); }
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cart-title')) return;
    document.querySelector('.cart-container').classList.toggle('in');
    document.querySelector('.cart-title').classList.toggle('collapsed');
  });
</script>`;

// Signed in at the shop or not (state.signedIn[shop]), the way each kind of store shows it: Shopify's
// customer number in __st, CrystalCommerce's "not-logged-in" header, Premium Bandai's USER_DATA,
// and otherwise the header's "Sign in" link or "Hi, Ash" / "Sign out" (the store login monitor reads these).
function accountBits(shop, on) {
  if (SHOPIFY.has(shop)) return `<script>var __st={"a":1,"offset":36000,"p":"home","u":"dummy"${on ? ',"cid":4242' : ''}};</script><a href="/${shop}/account">${on ? 'Account' : 'Sign in'}</a>`;
  if (shop === 'thegamescube') return `<a href="/thegamescube/user/${on ? 'logout' : 'login'}" class="account ${on ? 'logged-in' : 'not-logged-in'}">${on ? 'Logout' : 'Login'}</a>`;
  if (shop === 'pbandai') return `<script>USER_DATA = {"loadTime":"now","csrfToken":"dummy"${on ? ',"loggedInMember":{"memberNo":"1"}' : ''}}</script><a href="/pbandai/login">${on ? 'My page' : 'Sign In'}</a>`;
  // Amazon's header: "Hello, sign in" / "Hello, Ash" (what its sign-in check reads).
  if (shop === 'amazon') return `<a id="nav-link-accountList" href="/amazon/gp/css/homepage.html"><span id="nav-link-accountList-nav-line-1" class="nav-line-1">Hello, ${on ? 'Ash' : 'sign in'}</span></a>`;
  return on ? `<span class="hi">Hi, Ash</span> <a href="/${shop}/logout">Sign out</a>` : `<a href="/${shop}/login">Sign in</a>`;
}

// The header's bag link, with the item count like real stores show it.
function bagLink(shop, count) {
  const word = shop === 'kmart' ? 'Bag' : 'Cart';
  const label = count == null ? word : `${word}, ${count} item${count === 1 ? '' : 's'}`;
  // CrystalCommerce: the cart is at /checkout/cart, its count in .cart-count (0 included).
  if (shop === 'thegamescube') return `<a href="/thegamescube/checkout/cart" id="bag-link" class="cart-details">Cart <span class="cart-count">${count || 0}</span></a>`;
  // Magento's mini cart (The Gamesmen): "My Cart" with its count, and the block it opens after an add.
  if (shop === 'gamesmen') {
    return `<span class="minicart-wrapper"><style>.block-minicart{display:none;position:absolute;right:20px;top:44px;background:#fff;color:#222;padding:14px;box-shadow:0 2px 10px rgba(0,0,0,.3);z-index:50}.block-minicart.open{display:block}.counter.qty.empty{display:none}</style>
      <a class="action showcart" href="/gamesmen/checkout/cart/" id="bag-link" data-bind="scope: 'minicart_content'"><span class="text">My Cart</span> <span class="counter qty${count ? '' : ' empty'}"><span class="counter-number">${count || ''}</span></span></a>
      <div id="minicart" class="block block-minicart" role="dialog"><div class="block-content"><p class="items-total"><span class="count">${count || 0}</span> Item(s) in Cart</p>
        <button type="button" id="top-cart-btn-checkout" class="action primary checkout" onclick="location.href='/gamesmen/checkout/'">Proceed to Checkout</button>
        <a class="action viewcart" href="/gamesmen/checkout/cart/"><span>View and Edit Cart</span></a></div></div></span>`;
  }
  // Gameology's cart icon: an icon, the word "Cart" (visually hidden) and its count (shown once there's something
  // in it) — opening the cart drawer, not the cart page (see GAMEOLOGY_DRAWER).
  if (shop === 'gameology') {
    return `<a href="/gameology/cart" id="bag-link" class="cart-drawer-button cart-icon header-link-icons" aria-controls="CartDrawer"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5.2 4l.9 2H21l-3.6 7H8.1l-.9 2H19v2H4l2.2-4.3L3 4H1V2h3.2z"/></svg><span class="visually-hidden">Cart</span> <cart-count class="cart-count cart-count--absolute" aria-label="${count || 0} items"${count ? '' : ' hidden'}>${count || 0}</cart-count></a>`;
  }
  // From The Deep Games' header cart (see FTD_CART): no link to it — a div with its count, and a drop-down.
  if (shop === 'fromthedeep') {
    return `<span class="cart-display" style="position:relative"><span class="cart-title clearfix collapsed" data-target=".cart-container" data-toggle="collapse" aria-label="Cart" aria-role="button" tabindex="0" style="cursor:pointer">🛒 <span class="cart-products-count">${count || 0}</span></span>
      <span class="cart-container collapse" style="position:absolute;right:0;top:28px;background:#fff;color:#222;padding:14px;box-shadow:0 2px 10px rgba(0,0,0,.3);z-index:50;min-width:240px"><ul class="cart-items"></ul>
      <span class="cart-links"${count ? '' : ' hidden'}><a class="btn checkout-btn" href="/fromthedeep/checkout">Checkout</a> <a class="view-cart btn" href="/fromthedeep/cart">Your Cart</a></span>
      <span class="cart__empty"${count ? ' hidden' : ''}><span class="cart--empty-message">Your cart is currently empty.</span></span></span></span>`;
  }
  // (Target's bag is its basket; Amazon's at /gp/cart/view.html.)
  const at = shop === 'target' ? '/basket' : shop === 'amazon' ? '/gp/cart/view.html' : '/cart';
  return `<a href="${shop ? `/${shop}` : ''}${at}" id="bag-link" aria-label="${label}">${word}${count ? ` <span class="bag-count">${count}</span>` : ''}</a>`;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
      } else resolve(Object.fromEntries(new URLSearchParams(data)));
    });
  });
}

/**
 * @param {{port?: number, cardPort?: number, host?: string, blockNonBrowsers?: boolean}} opts
 */
export async function startMockStore({ port = 0, cardPort = 0, host = '127.0.0.1', blockNonBrowsers = false } = {}) {
  const state = {
    shops: defaultShops(),
    // Simulate a store that refuses servers (like Kmart does): any request that isn't from a browser gets "Access Denied".
    blockNonBrowsers,
    // Kmart: a signed-in store account pre-fills the details step.
    account: null,
    // Kmart: card boxes in a payment-provider frame (Adyen-style) instead of on the page.
    // 'mystery': a frame whose boxes Mugibot can't recognise.
    // 'strict': one frame per box (like Adyen), ignoring anything that isn't real typing.
    // 'keys': one frame per box, taking key presses only.
    // 'never': one frame per box, taking nothing.
    // 'slow': like 'strict', each box taking a moment with what's typed (the boxes queue for the focus).
    cardInIframe: false,
    // Signed in at each shop (the store login monitor): shop → true.
    signedIn: {},
    // Shops answering 429 with Retry-After: shop → seconds.
    tooMany: {},
    // Kmart's Constructor.io browse of its Trading Cards (the whole range in one list): null (it works),
    // 'missing' (HTTP 404) or 'odd' (an answer that isn't a product list).
    cioBrowse: null,
    requests: [],
    // Acme Collectibles: another website (see acme() below).
    acme: defaultAcme(),
    // Shop's checkout and the store that checks out with it (see shopApp() below).
    shopapp: defaultShopApp(),
    // The bank's checks waiting on you (a shop's threeDS mode: bankStart): id → { shop, mode, approved, next, place }.
    bank: {},
  };
  let cardOrigin = '';

  const shopOf = (id) => state.shops[id];
  const find = (shop, sku) => shopOf(shop) && shopOf(shop).products.find((p) => p.sku === sku);
  const pathFor = (shop, p) => dummyProductPath(shop, p);
  // The token the product page last served sets once it has started up (addNeedsLoad).
  const S_TOKEN = (shop) => shopOf(shop).startToken || '';
  const total = (shop) => shopOf(shop).cart.reduce((s, c) => s + c.price * c.qty, 0);

  function addToCart(shop, sku, qty) {
    const p = find(shop, sku);
    if (!p || !p.listed || !(p.status === 'in_stock' || p.status === 'preorder')) return { ok: false };
    const max = Number(p.maxQty) || 10;
    const cart = shopOf(shop).cart;
    const line = cart.find((c) => c.sku === sku);
    if (line) line.qty = Math.min(max, line.qty + (Number(qty) || 1));
    else cart.push({ sku, qty: Math.min(max, Number(qty) || 1), price: p.price, name: p.name });
    return { ok: true, count: cart.length, items: cart.reduce((n, c) => n + c.qty, 0) };
  }
  const bagCount = (shop) => shopOf(shop).cart.reduce((n, c) => n + c.qty, 0);

  const imagePath = (shop, p) => `/img/${shop}/${encodeURIComponent(p.sku)}.svg`;
  const ldFor = (p, shop) => `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: p.sku, image: imagePath(shop, p),
    ...(LD_AVAIL[p.status] ? { offers: { '@type': 'Offer', price: p.price.toFixed(2), priceCurrency: 'AUD', availability: `https://schema.org/${LD_AVAIL[p.status]}` } } : {}),
  })}</script>`;

  function qtyControl(p) {
    if (p.qtyStyle === 'stepper') return '<div class="qty-stepper">Qty <button type="button" aria-label="Decrease quantity" id="qminus">−</button> <span id="qval">1</span> <button type="button" aria-label="Increase quantity" id="qplus">+</button></div>';
    if (p.qtyStyle === 'none') return '';
    const max = Number(p.maxQty) || 10;
    if (p.qtyStyle === 'select') return `<label>Quantity <select name="quantity" aria-label="Quantity" style="width:80px">${Array.from({ length: max }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select></label>`;
    return `<label>Qty <input name="quantity" type="number" value="1" min="1" ${p.maxQty ? `max="${p.maxQty}"` : ''} style="width:60px"></label>`;
  }

  const readQtyJs = `const inp = document.querySelector('[name=quantity]'); const qv = document.getElementById('qval'); const qty = inp ? Number(inp.value || 1) : Number(qv ? qv.textContent : 1);`;
  const stepperJs = (p) => `const qval = document.getElementById('qval');
    document.getElementById('qplus')?.addEventListener('click', () => { qval.textContent = String(Math.min(${Number(p.maxQty) || 5}, Number(qval.textContent) + 1)); });
    document.getElementById('qminus')?.addEventListener('click', () => { qval.textContent = String(Math.max(1, Number(qval.textContent) - 1)); });`;

  // -------------------------------------------------------------------- product pages
  function productPage(shop, p) {
    const others = shopOf(shop).products.filter((x) => x.sku !== p.sku && x.listed && !x.upsell);
    const upsellItems = shopOf(shop).products.filter((x) => x.upsell && x.sku !== p.sku);
    const other = others[0];
    const labels = {
      kmart: { in_stock: 'Add to bag', preorder: 'Pre-order', out_of_stock: 'Sold out online', coming_soon: 'Coming soon' },
      bigw: { in_stock: 'Add to cart', preorder: 'Pre-order', out_of_stock: 'Out of stock online', coming_soon: 'Coming soon' },
      ebgames: { in_stock: 'Add to Cart', preorder: 'Pre-order Now', out_of_stock: 'Sold Out', coming_soon: 'Coming Soon' },
      jbhifi: { in_stock: 'Add to cart', preorder: 'Pre-order', out_of_stock: 'Sold out', coming_soon: 'Coming soon' },
      pokemoncenter: { in_stock: 'Add to Cart', preorder: 'Pre-order', out_of_stock: 'Sold Out', coming_soon: 'Coming Soon' },
      pbandai: { in_stock: 'Add to Cart', preorder: 'PLACE PRE-ORDER', out_of_stock: 'Sold Out', coming_soon: 'Coming Soon' },
      target: { in_stock: 'Add to basket', preorder: 'Pre-order', out_of_stock: 'Out of stock online', coming_soon: 'Coming soon' },
      amazon: { in_stock: 'Add to Cart', preorder: 'Pre-order now', out_of_stock: 'Currently unavailable', coming_soon: 'Currently unavailable' },
      citybeach: { in_stock: 'Add To Bag', preorder: 'Pre-order', out_of_stock: 'Out of stock', coming_soon: 'Coming soon' },
      thegamescube: {},
    }[SHOPIFY.has(shop) ? 'jbhifi' : shop];
    const orderable = p.status === 'in_stock' || p.status === 'preorder';
    if (shop === 'gameology') return gameologyProductPage(p);
    if (shop === 'fromthedeep') return fromthedeepProductPage(p);
    if (SHOPIFY.has(shop)) {
      return page(shop, `${p.name} | ${SHOPS[shop].name}`, `${shopOf(shop).banner ? `<div class="site-banner" role="note">${esc(shopOf(shop).banner)}</div>` : ''}<div class="product-detail"><h1>${esc(p.name)}</h1><div class="price">$${p.price.toFixed(2)}</div>
        <form action="/${shop}/cart/add" method="get"><input type="hidden" name="id" value="${p.id}">${qtyControl(p)}
        <button type="submit" name="add" ${orderable ? '' : 'disabled'}>${esc((orderable && shopOf(shop).addLabel) || labels[p.status])}</button></form></div>`, { head: ldFor(p, shop) });
    }
    if (shop === 'thegamescube') return crystalProductPage(p);
    if (shop === 'gamesmen') return magentoProductPage(p);
    if (shop === 'gamesworld') return wooProductPage(p);
    // (addLabel: its buy button in other words — "Buy Now", "Add to Basket"…; buyNowToo: a "Buy Now" beside it, counted when pressed.)
    const words = (orderable && shopOf(shop).addLabel) || labels[p.status];
    const button = orderable ? `<button type="button" id="atc" class="add-to-cart"${shopOf(shop).greyedMs ? ' disabled' : ''}>${esc(words)}</button>${shopOf(shop).buyNowToo ? ' <button type="button" id="buy-now" class="buy-now" onclick="fetch(\'/__admin/buynow?shop=' + shop + '\', { method: \'POST\' })">Buy Now</button>' : ''}` : `<button type="button" class="add-to-cart" disabled>${labels[p.status]}</button>`;
    const drawer = {
      kmart: '<div class="drawer" id="drawer" role="dialog" aria-label="Added to bag"><h3>Added to bag</h3><p id="drawer-msg"></p><a class="btn" href="/kmart/checkout">Checkout</a> <a href="/kmart/cart">View bag</a></div>',
      bigw: '<div class="drawer added-to-cart-drawer" id="drawer" role="dialog" aria-label="Added to cart"><h3>Added to your cart</h3><p id="drawer-msg"></p><a class="btn" href="/bigw/cart">View cart</a> <a href="/bigw/">Continue shopping</a></div>',
      ebgames: '<div class="drawer mini-cart" id="drawer"><h3>Added to cart</h3><p id="drawer-msg"></p><a class="btn" href="/ebgames/checkout">Checkout</a> <a href="/ebgames/cart">View cart</a></div>',
      pokemoncenter: '<div class="drawer mini-cart" id="drawer" role="dialog" aria-label="Added to cart"><h3>Added to cart</h3><p id="drawer-msg"></p><a class="btn" href="/pokemoncenter/cart">View Cart</a> <a href="/pokemoncenter/">Continue Shopping</a></div>',
      pbandai: '<div class="drawer" id="drawer" role="dialog" aria-label="Added to cart"><h3>Item added to your cart</h3><p id="drawer-msg"></p><a class="btn" href="/pbandai/cart">View Cart</a> <a href="/pbandai/">Continue Shopping</a></div>',
      amazon: '<div class="drawer" id="drawer" role="dialog" aria-label="Added to Cart"><h3>Added to Cart</h3><p id="drawer-msg"></p><a href="/amazon/cart">Go to Cart</a></div>',
      // City Beach: the mini bag that opens after "Add To Bag" (its words: "Close", "View Your Bag").
      citybeach: '<div class="drawer minicart-flyout" id="drawer"><button type="button" aria-label="Close" onclick="this.parentNode.classList.remove(\'open\')">Close</button><p id="drawer-msg"></p><a class="btn" href="/citybeach/cart">View Your Bag</a></div>',
      // Target: "Often Bought Together" — four more things to add, and a ✕ to close it.
      target: `<div class="drawer modal upsell-modal" id="drawer" role="dialog" aria-modal="true" aria-labelledby="obt-title">
        <button type="button" class="modal-close" aria-label="Close" id="obt-close" style="float:right;background:none;color:#000;font-size:22px">✕</button>
        <h2 id="obt-title">Often Bought Together</h2><p id="drawer-msg" hidden></p>
        <div class="obt-items">${upsellItems.map((x) => `<div class="obt-item"><img src="${imagePath(shop, x)}" alt="" width="120"><div>${esc(x.name)}</div><b>$${x.price}</b>
          <select aria-label="Colour"><option>Black</option></select> <select aria-label="Size"><option value="">Select Size</option><option>10</option></select></div>`).join('')}</div>
        <p>Total Price: $${upsellItems.reduce((t, x) => t + x.price, 0)}</p>
        <button type="button" id="obt-add">Add ${upsellItems.length} Items To Basket</button>
      </div>`,
    }[shop];
    return page(shop, `${p.name} | ${SHOPS[shop].name}`, `${shopOf(shop).banner ? `<div class="site-banner" role="note">${esc(shopOf(shop).banner)}</div>` : ''}
      <div class="product-detail">
        <h1>${esc(p.name)}</h1>
        <div class="price">$${p.price.toFixed(2)}</div>
        <p>${shop === 'kmart' ? 'Keycode' : 'Product code'} ${p.sku}</p>
        ${qtyControl(p)}
        ${shopOf(shop).decoys ? `<div class="image-loader" style="width:80px;height:80px"><img src="/slow.gif?ms=1" alt="" width="80" height="80"></div>
        <div class="qty-spinner" style="width:60px;height:20px">−1+</div><div aria-busy="true" hidden>reviews</div>
        <p class="note">Due to high demand, limit 1 per customer. Was $502.99 — 500 sold this week.</p>` : ''}
        <div id="buybox">${p.lateMs ? '<p>Loading…</p>' : button}</div>
        ${shop === 'amazon' && orderable ? `<form id="buy-now-form" method="post" action="/amazon/checkout/entry/buynow"><input type="hidden" name="asin" value="${esc(p.sku)}"><input type="hidden" name="quantity" id="buy-now-qty" value="1">
          <span class="a-button a-button-oneclick"><input id="buy-now-button" name="submit.buy-now" type="submit" class="a-button-input" aria-labelledby="submit.buy-now-announce" style="width:120px;height:30px"><span id="submit.buy-now-announce" class="a-button-text" aria-hidden="true">Buy Now</span></span></form>
          ${shopOf(shop).turbo ? `<div id="turbo-checkout-panel-container" class="a-popover" role="dialog" hidden><iframe id="turbo-checkout-iframe" width="420" height="320" title="Buy now" style="border:1px solid #ccc"></iframe></div>
          <script>document.getElementById('buy-now-form').addEventListener('submit', (e) => {
            e.preventDefault(); // Amazon's quick checkout: a window over the page instead of a new page
            const box = document.getElementById('turbo-checkout-panel-container');
            const q = document.querySelector('select[name=quantity], input[name=quantity]:not([type=hidden])');
            box.querySelector('iframe').src = '/amazon/checkout/turbo?asin=${encodeURIComponent(p.sku)}&quantity=' + encodeURIComponent(q ? q.value : 1);
            box.hidden = false;
          });</script>` : ''}
          <script>document.getElementById('buy-now-form').addEventListener('submit', () => { const q = document.querySelector('select[name=quantity], input[name=quantity]:not([type=hidden])'); document.getElementById('buy-now-qty').value = q ? q.value : 1; }, true);</script>` : ''}
        ${shopOf(shop).slowLoadMs ? `<img src="/slow.gif?ms=${Number(shopOf(shop).slowLoadMs)}" alt="" width="1" height="1">` : ''}
      </div>
      <section class="recommendations"><h3>You may also like</h3>
        ${other ? `<div class="tile"><a href="${pathFor(shop, other)}">${esc(other.name)}</a><button type="button" class="add-to-cart">${labels.in_stock}</button></div>` : ''}
      </section>
      ${drawer}
      ${shop === 'citybeach' && !shopOf(shop).noPopup ? CITYBEACH_POPUP : ''}
      <script>
        ${p.lateMs ? `setTimeout(() => { document.getElementById('buybox').innerHTML = ${JSON.stringify(button)}; }, ${Number(p.lateMs)});` : ''}
        ${shopOf(shop).greyedMs ? `addEventListener('load', () => setTimeout(() => { const b = document.getElementById('atc'); if (b) b.disabled = false; }, ${Number(shopOf(shop).greyedMs)}));` : ''}
        ${shopOf(shop).addNeedsLoad ? `addEventListener('load', () => setTimeout(() => { document.cookie = 'mgb_started=${S_TOKEN(shop)}; path=/'; }, ${Number(shopOf(shop).addNeedsLoad)}));` : ''}
        ${stepperJs(p)}
        // Until the page's code has started, pressing Add does nothing (like a store that's still loading).
        let started = ${shopOf(shop).hydrateMs || shopOf(shop).reactMs || shopOf(shop).vueMs ? 'false' : 'true'};
        ${shopOf(shop).hydrateMs ? `addEventListener('load', () => setTimeout(() => { started = true; }, ${Number(shopOf(shop).hydrateMs)}));` : ''}
        ${shopOf(shop).reactMs ? `window.__NEXT_DATA__ = {};
        setTimeout(() => {
          started = true;
          const atc = document.getElementById('atc'); // what React leaves on a button it has taken over
          if (atc) { atc.__reactFiber$mock = {}; atc.__reactProps$mock = { onClick() {} }; }
        }, ${Number(shopOf(shop).reactMs)});` : ''}
        ${shopOf(shop).vueMs ? `document.body.setAttribute('data-v-app', '');
        setTimeout(() => {
          started = true;
          const atc = document.getElementById('atc'); // what Vue leaves on an element it has wired up
          if (atc) atc._vei = { onClick() {} };
        }, ${Number(shopOf(shop).vueMs)});` : ''}
        // Target's pop-up: ✕ closes it; "Add 4 Items To Basket" adds them all (what ⚡ Buy must never press).
        document.getElementById('obt-close')?.addEventListener('click', () => { document.getElementById('drawer').classList.remove('open'); window.__afterUpsell?.(); });
        document.getElementById('obt-add')?.addEventListener('click', async () => {
          for (const sku of ${JSON.stringify(upsellItems.map((x) => x.sku))}) await fetch('/${shop}/api/cart/add', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({sku, qty: 1})});
          document.getElementById('drawer').classList.remove('open');
          window.__afterUpsell?.();
        });
        document.addEventListener('click', async (e) => {
          if (!e.target.closest('#atc') || !started) return;
          ${readQtyJs}
          const btn = document.getElementById('atc');
          btn.classList.add('busy');
          const r = await fetch('/${shop}/api/cart/add', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({sku:'${p.sku}', qty})});
          const d = await r.json();
          btn.classList.remove('busy');
          if (!d.ok) {
            if (d.said) {
              const t = document.createElement('div');
              t.className = 'toast'; t.setAttribute('role', 'alert'); t.textContent = d.said;
              document.querySelector('main').append(t);
              setTimeout(() => t.remove(), 2500);
            }
            return;
          }
          if (${shopOf(shop).quiet || shopOf(shop).stale || shopOf(shop).hideBag ? 'true' : 'false'}) return; // (a store whose page shows nothing Mugibot can read, or nothing new)
          const showBag = () => {
            const bag = document.getElementById('bag-link');
            bag.setAttribute('aria-label', '${shop === 'kmart' ? 'Bag' : 'Cart'}, ' + d.items + ' items');
            bag.innerHTML = '${shop === 'kmart' ? 'Bag' : 'Cart'} <span class="bag-count">' + d.items + '</span>';
          };
          ${shop === 'target'
    // Target: the "Often Bought Together" pop-up straight away, over the page; the basket shows the item once it's closed.
    ? "window.__afterUpsell = showBag; document.getElementById('drawer').classList.add('open');"
    : "showBag(); setTimeout(() => { document.getElementById('drawer-msg').textContent = d.count + ' item(s) in your " + (shop === 'kmart' ? 'bag' : 'cart') + "'; document.getElementById('drawer').classList.add('open'); }, 150);"}
        });
      </script>`, { head: ldFor(p, shop), bagCount: shopOf(shop).quiet ? null : bagCount(shop), noBag: shopOf(shop).hideBag });
  }

  // From The Deep Games' product page, as its theme (BinderPOS's "Standard") draws one: its quantity ("Units": a
  // box between − and + that are divs, not buttons), the product's one option, and "Add To Cart" — a plain button
  // whose words the theme fills in a moment after the page, and whose press it takes over: Shopify's /cart/add.js
  // in the background with that many, a toast (Toastify's: no role), the header cart's count up (its drop-down
  // opened too, with cartOpens). Shopify turning the add away: the toast says so. Sold out: "SOLD OUT", off.
  function fromthedeepProductPage(p) {
    const orderable = p.status === 'in_stock' || p.status === 'preorder';
    const words = orderable ? (p.status === 'preorder' ? 'Pre-Order' : 'Add To Cart') : 'SOLD OUT';
    return page('fromthedeep', `${p.name} – From The Deep Games`, `<div class="product-single"><h1 class="product-single__title">${esc(p.name)}</h1>
      <div class="product-price"><span class="product-price__price">$${p.price.toFixed(2)}</span></div>
      <form method="post" action="/fromthedeep/cart/add" id="product_form_${p.id}" accept-charset="UTF-8" class="product-form cart-product-page product-form-product-template" enctype="multipart/form-data" novalidate data-product-form="">
        <input type="hidden" name="form_type" value="product">
        <div class="quantity-cart">
          <div class="product-form__item product-form__item--quantity selector-wrapper"><label>Units</label>
            <div class="dec button qtyminus" style="display:inline-block;padding:4px 10px;background:#ddd;color:#222;cursor:pointer">-</div><input name="quantity" value="1" class="quantity" style="width:50px"><div class="inc button qtyplus" style="display:inline-block;padding:4px 10px;background:#ddd;color:#222;cursor:pointer">+</div></div>
          <select name="id" class="product-form__variants no-js" style="display:none"><option selected="selected" value="${p.id}" data-stock="${orderable ? 14 : 0}">Default Title</option></select>
          <div class="product-info"><div class="item_info"><div class="product-form__item product-form__item--submit">
            <button type="button" id="AddToCart-template" class="product-addToCart addToCart${orderable ? ' enable' : ''} btn"${orderable ? '' : ' disabled'}><span id="AddToCartText-template"></span></button></div>
            <div id="inventory" class="available-stock">${orderable ? '<span class="instock">In Stock</span>' : '<span class="outstock">SOLD OUT</span>'}</div></div></div>
        </div>
        <input type="hidden" name="return_to" value="back">
      </form>
      <div class="shopify-payment-button"><button type="button" class="shopify-payment-button__button" disabled>Buy with Shop Pay</button></div></div>
      <script>
        // (Its words come from the theme's code, a moment after the page.)
        setTimeout(() => { document.getElementById('AddToCartText-template').textContent = ${JSON.stringify(words)}; }, 150);
        const toast = (t) => { const d = document.createElement('div'); d.className = 'toastify on toastify-left toastify-bottom'; d.textContent = t; document.body.append(d); setTimeout(() => d.remove(), 3000); };
        document.addEventListener('click', (e) => {
          const step = e.target.closest('.qtyplus, .qtyminus');
          if (!step) return;
          const q = step.parentNode.querySelector('input.quantity');
          q.value = String(Math.max(1, Number(q.value || 1) + (step.classList.contains('qtyplus') ? 1 : -1)));
        });
        document.getElementById('AddToCart-template').addEventListener('click', async (e) => {
          const b = e.currentTarget;
          if (b.disabled || !b.classList.contains('enable')) return;
          b.classList.add('adding');
          const r = await fetch('/fromthedeep/cart/add.js', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(document.getElementById('product_form_${p.id}'))) });
          const d = await r.json();
          b.classList.remove('adding');
          if (d.status) { toast(d.description); return; }
          await window.__ftdCart(${shopOf('fromthedeep').cartOpens ? 'true' : "'count'"});
          toast('Added to cart');
        });
      </script>`, { head: ldFor(p, 'fromthedeep'), bagCount: bagCount('fromthedeep') });
  }

  // Gameology's product page, as its theme (FoxTheme's "Hyper") draws one: the product form (is="product-form")
  // with its quantity and "Add to cart" (a submit button named add) — the theme takes the press over, adds it
  // in the background (Shopify's /cart/add.js) and slides the cart drawer open (drawerShut: it doesn't — only the
  // cart icon's count goes up). Shopify turning the add away: its words under the button. Sold out: "Out of
  // stock", the button off.
  function gameologyProductPage(p) {
    const orderable = p.status === 'in_stock' || p.status === 'preorder';
    return page('gameology', `${p.name} – Gameology`, `<div class="product-detail"><h1 class="product__title">${esc(p.name)}</h1><div class="price">$${p.price.toFixed(2)}</div>
      <form method="post" action="/gameology/cart/add" id="product-form-template--main" accept-charset="UTF-8" class="main-product-form grid gap-4" enctype="multipart/form-data" data-type="add-to-cart-form" is="product-form">
        <input type="hidden" name="form_type" value="product"><input type="hidden" name="id" value="${p.id}" class="product-variant-id">
        <label>Quantity <input class="quantity__input" type="number" name="quantity" value="1" min="1" data-cart-quantity="0" style="width:60px"></label>
        <button id="ProductSubmitButton-template--main" type="submit" name="add" class="product-form__submit btn btn--primary"${orderable ? '' : ' disabled'}><span class="btn__text">${orderable ? (p.status === 'preorder' ? 'Pre-order' : 'Add to cart') : 'Out of stock'}</span></button>
        <p class="product-form__error-message err" role="alert" hidden></p>
      </form>
      <div class="bnpl-options"><span class="bnpl-tooltip__installments">4 payments of $${(p.price / 4).toFixed(2)}</span> with Afterpay, Zip or PayPal</div></div>
      <script>
        document.getElementById('product-form-template--main').addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = e.currentTarget;
          const b = f.querySelector('[name=add]');
          if (b.getAttribute('aria-disabled') === 'true') return;
          b.setAttribute('aria-disabled', 'true');
          b.classList.add('btn--loading');
          try {
            const r = await fetch('/gameology/cart/add.js', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(f)) });
            const d = await r.json();
            const err = f.querySelector('.product-form__error-message');
            if (d.status) { err.textContent = d.description; err.hidden = false; return; }
            err.hidden = true;
            await window.__gmCart(${shopOf('gameology').drawerShut ? "'count'" : 'true'});
          } finally {
            b.classList.remove('btn--loading');
            b.removeAttribute('aria-disabled');
          }
        });
      </script>`, { head: ldFor(p, 'gameology'), bagCount: bagCount('gameology') });
  }

  // CrystalCommerce (The Games Cube): each option in stock has its own small cart button — an icon, no words.
  function crystalForm(p) {
    return `<form class="add-to-cart-form" data-vid="${p.id}" data-name="${esc(p.name)}" data-id="${p.sku}" data-price="AUD$ ${p.price.toFixed(2)}" data-category="Cards" data-variant="Sealed">
      <div class="product-price-qty"><span class="regular price">AUD$ ${p.price.toFixed(2)}</span></div>
      <div class="qty-submit"><input class="qty" max="3" name="qty" size="1" type="number" value="1"><input class="utility-button add-to-cart" name="commit" type="submit" value="&#xf217;" style="width:44px;font-family:monospace"></div></form>`;
  }
  function crystalProductPage(p) {
    const orderable = p.status === 'in_stock' || p.status === 'preorder';
    return page('thegamescube', `${p.name} | The Games Cube`, `<article class="product-container single">
      <h1 class="title" itemprop="name">${esc(p.name)}</h1>
      <h4 class="stock-indicator ${orderable ? 'in-stock' : 'no-stock'}">${orderable ? 'In Stock' : 'Out of Stock'}</h4>
      <div class="info-box"><h4 class="heading">Buy This Product</h4><div class="variant-row row">
        <span class="variant-short-info">Sealed, <em>${orderable ? '3 in-stock' : 'Out of stock.'}</em></span>
        ${orderable ? crystalForm(p) : `<span class="regular price">AUD$ ${p.price.toFixed(2)}</span> <a href="#" class="utility-button add-to-wishlist">Wishlist</a>`}
      </div></div></article>
      <div class="alert-box" id="cart-alert" role="alert" style="display:none"></div>
      <script>
        document.addEventListener('submit', async (e) => {
          const f = e.target.closest('.add-to-cart-form');
          if (!f) return;
          e.preventDefault();
          const r = await fetch('/thegamescube/api/v1/cart/line_items', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ line_items: [{ variant_id: Number(f.dataset.vid), qty: Number(f.querySelector('[name=qty]').value) }] }) });
          const d = await r.json();
          if (!d.line_items || !d.line_items.length) return;
          document.querySelector('.cart-count').textContent = String(d.count);
          const a = document.getElementById('cart-alert');
          a.textContent = d.line_items[0].name + ' has been added to your cart';
          a.style.display = 'block';
        });
      </script>`, { bagCount: bagCount('thegamescube') });
  }
  function crystalSearchPage(q) {
    const hits = searchHits('thegamescube', q);
    return page('thegamescube', 'Search results', `<div class="products-container browse"><ul class="products">${hits.map((x) => {
      const orderable = x.status === 'in_stock' || x.status === 'preorder';
      return `<li class="product" itemscope itemtype="http://schema.org/Product"><div class="inner"><div class="image"><a href="${pathFor('thegamescube', x)}" itemprop="url" title="${esc(x.name)}"><img src="${imagePath('thegamescube', x)}" alt="${esc(x.name)}" itemprop="image"></a></div>
        <div class="meta"><a href="${pathFor('thegamescube', x)}" itemprop="url"><h4 class="name" itemprop="name" title="${esc(x.name)}">${esc(x.name)}</h4></a>
        <div class="variant-row ${orderable ? 'in-stock' : 'no-stock'}"><span class="variant-short-info variant-qty">${orderable ? '3 In Stock' : 'Out of stock.'}</span>
        ${orderable ? crystalForm(x) : `<span class="price no-stock hide" itemprop="price">AUD$ ${x.price.toFixed(2)}</span>`}</div></div></div></li>`;
    }).join('')}</ul></div>`);
  }

  const searchHits = (shop, q) => {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    // (noResultsFor: a search with those words in it finds nothing — a store with nothing for them.)
    const none = shopOf(shop).noResultsFor;
    if (none && String(q || '').toLowerCase().includes(none)) return [];
    return shopOf(shop).products.filter((x) => x.listed && words.some((w) => slugify(x.name).includes(slugify(w)) || x.sku === w));
  };
  // EB Games' search with its filters: words (q, optional), category ('trading-cards': trading-card products — by the
  // product's own category, else its name) and condition ('preorder', or 'new' for what's out already).
  const EB_CARDS = /\b(tcg|card game|trading cards?|booster|magic:? the gathering|elite trainer)\b/i;
  function ebHits(params) {
    const q = params.get('q');
    let hits = q ? searchHits('ebgames', q) : shopOf('ebgames').products.filter((x) => x.listed);
    const cat = params.get('category');
    if (cat) hits = hits.filter((x) => (x.category ? x.category === cat : cat === 'trading-cards' && EB_CARDS.test(x.name)));
    const cond = params.get('condition');
    if (cond === 'preorder') hits = hits.filter((x) => x.status === 'preorder');
    else if (cond === 'new') hits = hits.filter((x) => x.status !== 'preorder');
    return hits;
  }
  function ebSearchPage(u) {
    const title = u.searchParams.get('q') ? `Search results for "${esc(u.searchParams.get('q'))}"` : 'Trading Cards';
    return page('ebgames', `${title} | EB Games`, `<h1>${title}</h1><p class="filters">${u.searchParams.get('condition') === 'preorder' ? 'Condition: Pre-order' : ''}</p><div id="results"><p>Loading…</p></div>
      <script>
        setTimeout(async () => {
          const d = await (await fetch('/ebgames/search/query' + location.search)).json();
          document.getElementById('results').innerHTML = d.results.length ? '<p class="result-count">' + d.totalResults + ' results</p>' + d.results.map((x) => '<div class="product-tile"><a href="/ebgames' + x.productUrl + '"><img src="' + x.imageUrl + '" alt="">' + x.title.replace(/</g, '&lt;') + '</a>'
            + '<div class="price">$' + Number(x.promotionPrice || x.price).toFixed(2) + '</div>' + (x.isOutOfStock || x.isComingSoon ? '<button type="button" disabled>Sold Out</button>' : '<button type="button" class="add-to-cart">' + (new Date(x.releaseDate) > new Date() ? 'Pre-order' : 'Add to Cart') + '</button>') + '</div>').join('')
            : '<p>Sorry, no results found.</p>';
        }, 300);
      </script>`);
  }

  // Search results the way stores show them: a tile per product, with its price and an add / sold out button.
  function searchPage(shop, q, pageNo = 1) {
    const { hits, next } = paged(shop, q, pageNo);
    const button = (x) => (x.status === 'in_stock' ? '<button type="button" class="add-to-cart">Add to cart</button>'
      : x.status === 'preorder' ? '<button type="button" class="add-to-cart">Pre-order</button>'
        : `<button type="button" disabled>${x.status === 'coming_soon' ? 'Coming soon' : 'Out of stock'}</button>`);
    return page(shop, `Search: ${q}`, `<h1>Results for "${esc(q)}"</h1>${hits.map((x) => `<div class="tile product-tile"><a href="${pathFor(shop, x)}"><img src="${imagePath(shop, x)}" alt="">${esc(x.name)}</a><div class="price">$${x.price.toFixed(2)}</div>${button(x)}</div>`).join('') || '<p>No results</p>'}${next}`);
  }
  // A shop with pageSize set (BIG W's 48 a page): its results a page at a time, with a "Next" link to the next one.
  function paged(shop, q, pageNo) {
    const all = searchHits(shop, q);
    const size = shopOf(shop).pageSize || 0;
    if (!size) return { hits: all, next: '' };
    const n = Math.max(1, Number(pageNo) || 1);
    const more = all.length > n * size;
    const href = `/${shop}/search?text=${encodeURIComponent(q)}&page=${n + 1}`;
    return { hits: all.slice((n - 1) * size, n * size), next: more ? `<nav class="pagination" aria-label="Pagination"><a href="${href}" rel="next">Next</a></nav>` : '' };
  }

  // Target's search page: its product data in __NEXT_DATA__, newest first; sold-out products left out (like the real one).
  function targetSearchPage(q) {
    const hits = searchHits('target', q).filter((x) => !x.upsell && (x.status === 'in_stock' || x.status === 'preorder'));
    const data = { props: { pageProps: { metadata: { productList: { totalNumProducts: hits.length, products: hits.map((x) => ({
      id: `P${x.sku}`, title: x.name, baseProductUrl: pathFor('target', x), imageUrl: imagePath('target', x), price: { offerPrice: x.price },
      variations: [{ colourVariantCode: x.sku, url: pathFor('target', x), inStock: true, productDisplayType: x.status === 'preorder' ? 'PRE_ORDER' : 'IN_STOCK' }],
    })) } } } } };
    return page('target', `Search: ${q}`, `<h1>Results for "${esc(q)}"</h1><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`);
  }

  // City Beach's search page (Salesforce Commerce Cloud): a tile per product with its code
  // (data-pid) and its name, brand and price in data-gtmdata — the brand left out of the name, like
  // the real one ("Ninja Spinner Booster Pack Trading Cards", brand "Pokémon"). No stock in the tiles.
  function citybeachSearchPage(q) {
    const hits = searchHits('citybeach', q);
    const tile = (x) => {
      const brand = /^Pokémon /.test(x.name) ? 'Pokémon' : '';
      const gtm = { name: brand ? x.name.slice(brand.length + 1) : x.name, id: x.sku, brand, price: x.price.toFixed(2), category: 'Skate' };
      return `<div class="col-6 col-sm-4"><div class="product" data-pid="${x.sku}" data-gtmdata="${esc(JSON.stringify(gtm))}"><div class="product-tile">
        <div class="image-container"><a href="${pathFor('citybeach', x)}"><img class="tile-image lazyload" data-src="${imagePath('citybeach', x)}" alt="${esc(x.name)}"></a></div>
        <div class="tile-body"><div class="pdp-link"><a class="link" href="${pathFor('citybeach', x)}">${esc(gtm.name)}</a></div>
        <div class="price"><span class="sales"><span class="value" content="${x.price.toFixed(2)}">$${x.price.toFixed(2)}</span></span></div></div></div></div></div>`;
    };
    return page('citybeach', `Search: ${q}`, hits.length
      ? `<h1>Search results for "${esc(q)}"</h1><div class="row product-grid">${hits.map(tile).join('')}</div>`
      : `<div class="no-results"><p>Sorry, your search "${esc(q)}" did not return any results.</p></div>`);
  }

  // A search page whose products are only filled in by its own code once it's open (BIG W's real one), with how many
  // there are above them ("57 results", as BIG W's says) — or "No results". clientSearch 'data': downloaded, not drawn;
  // 'count': its count drawn, its products never (a page in a hidden window that never draws its grid).
  function clientSearchPage(shop, q, pageNo = 1) {
    const { next } = paged(shop, q, pageNo);
    const how = shopOf(shop).clientSearch;
    const count = searchHits(shop, q).length;
    if (how === 'count') {
      return page(shop, `Search: ${q}`, `<h1>Results for "${esc(q)}"</h1><div id="results"><p>Loading…</p></div>${next}
        <script>setTimeout(() => { document.getElementById('results').innerHTML = ${JSON.stringify(`<p class="result-count">${count} results</p><div class="product-grid"></div>`)}; }, 400);</script>`);
    }
    return page(shop, `Search: ${q}`, `<h1>Results for "${esc(q)}"</h1><div id="results"><p>Loading…</p></div>${next}
      <script>
        setTimeout(async () => {
          const d = await (await fetch('/${shop}/api/search?q=' + encodeURIComponent(${JSON.stringify(q)}) + '&page=${Math.max(1, Number(pageNo) || 1)}')).json();
          if (${JSON.stringify(how === 'data')}) return; // downloaded, not drawn yet (like a page in a hidden window)
          document.getElementById('results').innerHTML = (d.products.length ? '<p class="result-count">${count} results</p>' : '') + (d.products.map((x) => '<article class="product-card"><a href="' + x.url + '"><img src="' + x.image + '" alt="">' + x.name.replace(/</g, '&lt;') + '</a>'
            + '<div class="price">$' + x.price.toFixed(2) + '</div>' + (x.status === 'in_stock' ? '<button type="button">Add to cart</button>' : '<button type="button" disabled>Out of stock</button>') + '</article>').join('') || '<p>No results</p>');
        }, 400);
      </script>`);
  }

  // Each shop's bag, emptied the way its real one is (Clear cart's tests — each a different layout):
  //   kmart          a "Remove" button per line; its page's code draws the list again (no new page)
  //   bigw           "Remove" → "Remove … from your cart?" → Remove
  //   ebgames        a bin icon with no words ("Remove item" for screen readers) posting a form: a new page
  //   jbhifi, gamerholic, pokebox, goodgames, collectiblemadness, cherrycollectables, gameology  Shopify's "Remove" link
  //                  (/cart/change?line=1&quantity=0) — and its cart API (/cart.js, /cart/clear.js)
  //   gamesmen       Magento's "Remove item" (a data-post link: a form posted, a new page) — see magentoCart
  //   gamesworld     WooCommerce's × "Remove … from cart" (a link: a new page, "removed. Undo?") — see wooCart
  //   toysrus        Shopify (Dawn): an icon link, "Remove <name>" for screen readers
  //   trainertown    an ✕ button "Remove <name>"; the page's code asks /cart/change.js
  //   thegamescube   a "Remove" link with the browser's own "Are you sure?" box (confirm())
  //   pokemoncenter  "Remove" → "Removing…" (the button greyed out a moment) → gone, "Item removed"
  //   pbandai        "Delete" → "Are you sure you want to delete this item from your cart?" → OK
  //   target         "Remove" → the line says it's been removed, with "Undo" (never pressed)
  //   amazon         "Delete" (and "Save for later", never pressed), with its "Saved for later" list below (left alone)
  //   citybeach      an × "Remove product <name>" → "Remove Product? Are you sure…" → Yes
  // A shop's removeFails: its Remove does nothing (Clear cart says so).
  function bagLine(shop, c, i, qty) {
    const p = find(shop, c.sku);
    const name = esc(c.name);
    const sku = esc(c.sku);
    const link = `<a href="${p ? pathFor(shop, p) : '#'}">${name}</a>`;
    const vid = p ? p.id : 0;
    // (A line on special: some stores mark the whole line as having a discount.)
    const li = (extra) => `<li class="line-item${c.discount ? ' cart-item--has-discount' : ''}" data-sku="${sku}"><div class="line-name">${link}</div>${c.discount ? '<span class="discount-badge">Save $5</span>' : ''}<div class="line-qty">Qty ${qty}</div>${extra}</li>`;
    switch (shop) {
      case 'kmart': return li(`<button type="button" class="remove-line" data-remove="${sku}" aria-label="Remove ${name} from bag">Remove</button>`);
      case 'bigw': return li(`<button type="button" class="link-btn" data-remove="${sku}" data-name="${name}">Remove</button>`);
      case 'ebgames': return li(`<form method="post" action="/ebgames/cart/remove" class="remove-form"><input type="hidden" name="sku" value="${sku}"><button type="submit" class="remove-item" aria-label="Remove item" title="Remove item" style="background:none;color:#d22;padding:4px"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 5h12M7 5V3h4v2M5 5l1 11h6l1-11" stroke="currentColor" fill="none"/></svg></button></form>`);
      case 'jbhifi': case 'gamerholic': case 'pokebox': case 'goodgames': case 'collectiblemadness': case 'cherrycollectables': case 'gameology': return li(`<a href="/${shop}/cart/change?line=${i + 1}&amp;quantity=0" class="cart__remove">Remove</a>`);
      case 'toysrus': return li(`<cart-remove-button id="Remove-${i + 1}" data-index="${i + 1}"><a href="/toysrus/cart/change?id=${vid}&amp;quantity=0" class="button button--tertiary" aria-label="Remove ${name}" style="display:inline-block;padding:4px"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 4h12M6 4V2h4v2M4 4l1 10h6l1-10" stroke="currentColor" fill="none"/></svg></a></cart-remove-button>`);
      case 'trainertown': return li(`<button type="button" class="cart-item__remove" data-variant="${vid}" aria-label="Remove ${name}">✕</button>`);
      case 'thegamescube': return `<tr class="line-item" data-sku="${sku}"><td>${link}</td><td>Qty ${qty}</td><td><a href="/thegamescube/checkout/cart/remove/${vid}" class="remove" data-confirm="Are you sure you want to remove this item from your cart?">Remove</a></td></tr>`;
      case 'pokemoncenter': return li(`<button type="button" class="remove-button" data-remove="${sku}">Remove</button>`);
      case 'pbandai': return li(`<button type="button" class="cart-item__delete" data-remove="${sku}">Delete</button>`);
      case 'target': return li(`<a href="#" role="button" class="basket-item__remove" data-remove="${sku}" data-name="${name}">Remove</a>`);
      case 'citybeach': return li(`<button type="button" class="remove-btn remove-product btn btn-light" data-toggle="modal" data-target="#removeProductModal" data-remove="${sku}" data-name="${name}" aria-label="Remove product ${name}" title="Remove"><span aria-hidden="true">×</span></button>`);
      default: return li('');
    }
  }

  // The bag's own code (each shop's way of taking a thing out), and the confirm boxes some ask first.
  function bagScript(shop) {
    const word = shop === 'kmart' ? 'Bag' : 'Cart';
    const common = `
      const word = ${JSON.stringify(word)};
      // The header's bag link shows how many are in it.
      function setCount(n) {
        const b = document.getElementById('bag-link');
        if (!b) return;
        b.setAttribute('aria-label', word + ', ' + n + ' item' + (n === 1 ? '' : 's'));
        b.innerHTML = word + (n ? ' <span class="bag-count">' + n + '</span>' : '');
      }
      async function removeLine(sku) {
        const r = await fetch('/${shop}/api/cart/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku }) });
        return r.json();
      }
      // The line gone; nothing left: the bag says it's empty.
      function gone(sku, d, emptyText) {
        document.querySelector('.line-item[data-sku="' + CSS.escape(sku) + '"]')?.remove();
        setCount(d.items);
        if (!document.querySelector('.line-item')) {
          document.querySelector('ul.lines').innerHTML = '<li class="empty-msg">' + emptyText + '</li>';
          document.querySelectorAll('.bag-checkout').forEach((x) => x.remove());
        }
      }`;
    const per = {
      // React-style: the whole list drawn again from what the cart says (every line a new element).
      kmart: `
        document.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-remove]');
          if (!b) return;
          await new Promise((r) => setTimeout(r, 300));
          const d = await removeLine(b.dataset.remove);
          if (!d.ok) return;
          setCount(d.items);
          const ul = document.querySelector('ul.lines');
          ul.innerHTML = d.cart.length ? d.cart.map((c) => '<li class="line-item" data-sku="' + c.sku + '"><div class="line-name"><a href="#">' + c.name.replace(/</g, '&lt;') + '</a></div><div class="line-qty">Qty ' + c.qty + '</div><button type="button" class="remove-line" data-remove="' + c.sku + '" aria-label="Remove ' + c.name.replace(/"/g, '&quot;') + ' from bag">Remove</button></li>').join('') : '<li class="empty-msg">Your bag is empty</li>';
          if (!d.cart.length) document.querySelectorAll('.bag-checkout').forEach((x) => x.remove());
        });`,
      bigw: `
        let pending = null;
        const modal = document.getElementById('confirm-remove');
        document.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-remove]');
          if (b) { pending = b.dataset.remove; modal.querySelector('.what').textContent = 'Remove ' + b.dataset.name + ' from your cart?'; modal.style.display = 'block'; return; }
          if (e.target.closest('#cr-cancel')) { modal.style.display = 'none'; pending = null; return; }
          if (e.target.closest('#cr-yes') && pending) {
            const sku = pending; pending = null;
            modal.style.display = 'none';
            const d = await removeLine(sku);
            if (d.ok) gone(sku, d, 'Your cart is empty');
          }
        });`,
      trainertown: `
        document.addEventListener('click', async (e) => {
          const b = e.target.closest('.cart-item__remove');
          if (!b) return;
          const r = await fetch('/trainertown/cart/change.js', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: Number(b.dataset.variant), quantity: 0 }) });
          const d = await r.json();
          if (d.item_count === undefined) return;
          gone(b.closest('.line-item').dataset.sku, { items: d.item_count }, 'Your cart is empty');
        });`,
      // Rails-style: a link with data-confirm asks the browser's own confirm() box first.
      thegamescube: `
        document.addEventListener('click', (e) => {
          const a = e.target.closest('a[data-confirm]');
          if (a && !window.confirm(a.dataset.confirm)) { e.preventDefault(); window.__declined = (window.__declined || 0) + 1; }
        });`,
      pokemoncenter: `
        document.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-remove]');
          if (!b || b.disabled) return;
          b.disabled = true; b.textContent = 'Removing…';
          await new Promise((r) => setTimeout(r, 700));
          const d = await removeLine(b.dataset.remove);
          if (!d.ok) { b.disabled = false; b.textContent = 'Remove'; return; }
          gone(b.dataset.remove, d, 'Your cart is empty');
          const t = document.createElement('div'); t.setAttribute('role', 'status'); t.textContent = 'Item removed from your cart'; document.querySelector('main').append(t);
        });`,
      pbandai: `
        let pending = null;
        const modal = document.getElementById('pb-confirm');
        document.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-remove]');
          if (b) { pending = b.dataset.remove; modal.style.display = 'flex'; return; }
          if (e.target.closest('#pb-cancel')) { modal.style.display = 'none'; pending = null; return; }
          if (e.target.closest('#pb-ok') && pending) {
            const sku = pending; pending = null;
            modal.style.display = 'none';
            await new Promise((r) => setTimeout(r, 250));
            const d = await removeLine(sku);
            if (d.ok) gone(sku, d, 'There are no items in your cart.');
          }
        });`,
      // The line stays, saying it's been removed — with "Undo" (the basket says it's empty on its next page).
      target: `
        document.addEventListener('click', async (e) => {
          const u = e.target.closest('[data-undo]');
          if (u) {
            const r = await fetch('/target/api/cart/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: u.dataset.undo }) });
            const d = await r.json();
            setCount(d.items);
            return;
          }
          const b = e.target.closest('[data-remove]');
          if (!b) return;
          e.preventDefault();
          const d = await removeLine(b.dataset.remove);
          if (!d.ok) return;
          const line = b.closest('.line-item');
          line.className = 'line-removed';
          line.innerHTML = '<span>' + b.dataset.name + ' has been removed from your basket.</span> <button type="button" data-undo="' + b.dataset.remove + '">Undo</button>';
          setCount(d.items);
        });`,
      citybeach: `
        let pending = null;
        const modal = document.getElementById('removeProductModal');
        document.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-remove]');
          if (b) { pending = b.dataset.remove; modal.querySelector('.product-to-remove').textContent = b.dataset.name; modal.style.display = 'block'; return; }
          if (e.target.closest('[data-dismiss="modal"]')) { modal.style.display = 'none'; pending = null; return; }
          if (e.target.closest('.cart-delete-confirmation-btn') && pending) {
            const sku = pending; pending = null;
            modal.style.display = 'none';
            const d = await removeLine(sku);
            if (d.ok) gone(sku, d, 'Your Shopping Bag is Empty');
          }
        });`,
    };
    return common + (per[shop] || '');
  }

  // The confirm boxes (hidden until a Remove asks).
  const BAG_MODALS = {
    bigw: '<div class="drawer modal" id="confirm-remove" role="dialog" aria-modal="true" aria-labelledby="cr-title" style="display:none"><h3 id="cr-title">Remove item</h3><p class="what"></p><button type="button" id="cr-cancel">Cancel</button> <button type="button" id="cr-yes">Remove</button></div>',
    pbandai: '<div class="modal-overlay" id="pb-confirm" role="dialog" aria-modal="true" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);align-items:center;justify-content:center"><div class="modal" style="background:#fff;padding:20px"><p>Are you sure you want to delete this item from your cart?</p><button type="button" id="pb-cancel">Cancel</button> <button type="button" id="pb-ok">OK</button></div></div>',
    citybeach: '<div class="modal fade" id="removeProductModal" role="dialog" style="display:none;position:fixed;top:20%;left:20%;right:20%;background:#fff;padding:20px;box-shadow:0 4px 20px rgba(0,0,0,.3)"><div class="modal-content"><h2 class="modal-title">Remove Product?</h2><p>Are you sure you want to remove the following product from the cart?</p><p class="product-to-remove"></p><button type="button" class="btn btn-outline-primary" data-dismiss="modal">Cancel</button> <button type="button" class="btn btn-primary cart-delete-confirmation-btn">Yes</button></div></div>',
  };
  const EMPTY_BAG = {
    kmart: 'Your bag is empty', ebgames: 'Your cart is currently empty.', pbandai: 'There are no items in your cart.', target: 'Your basket is empty',
    citybeach: 'Your Shopping Bag is Empty',
  };

  function cartPage(shop) {
    if (shop === 'amazon') return amazonCart();
    const S = shopOf(shop);
    const cart = S.cart;
    const rows = cart.map((c, i) => {
      const p = find(shop, c.sku);
      const max = Number(p && p.maxQty) || 10;
      const opts = Array.from({ length: max }, (_, j) => `<option value="${j + 1}" ${j + 1 === c.qty ? 'selected' : ''}>${j + 1}</option>`).join('');
      const qty = SHOPIFY.has(shop) ? `<input type="number" name="updates[]" aria-label="Quantity" data-qty="${c.sku}" value="${c.qty}" min="1" style="width:60px">` : `<select aria-label="Quantity" data-qty="${c.sku}">${opts}</select>`;
      return bagLine(shop, c, i, qty);
    }).join('');
    let go = {
      kmart: '<a class="btn" href="/kmart/checkout">Checkout</a>', bigw: '<button type="button" id="to-checkout">Proceed to checkout</button>', ebgames: '<a class="btn" href="/ebgames/checkout">Secure Checkout</a>', jbhifi: '<button type="button" id="to-checkout" name="checkout">Check out</button>',
      thegamescube: '<a class="utility-button checkout" href="/thegamescube/checkout/proceed_to_checkout">Checkout &rarr;</a>', pokemoncenter: '<a class="btn" href="/pokemoncenter/checkout">Checkout</a>', pbandai: '<a class="btn" href="/pbandai/checkout">Proceed to Checkout</a>',
      target: '<a class="btn" href="/target/checkout">Checkout</a>', citybeach: '<a class="btn checkout-btn" href="/citybeach/checkout">Checkout</a>',
    }[SHOPIFY.has(shop) ? 'jbhifi' : shop];
    // (Its Checkout button in other words: bagButton.)
    if (go && S.bagButton) go = go.replace(/>([^<]*)<\/(a|button)>$/, `>${esc(S.bagButton)}</$2>`);
    const title = shop === 'kmart' ? 'Your bag' : shop === 'target' ? 'Your basket' : 'Your cart';
    const emptyText = EMPTY_BAG[shop] || 'Your cart is empty';
    const list = shop === 'thegamescube'
      ? (cart.length ? `<table class="cart-table"><tbody>${rows}</tbody></table>` : `<ul class="lines"><li class="empty-msg">${emptyText}</li></ul>`)
      : `<ul class="lines">${rows || `<li class="empty-msg">${emptyText}</li>`}</ul>`;
    return page(shop, title, `<h1>${title}</h1>${list}<a href="/${shop}/" class="continue">Continue shopping</a> ${cart.length && go ? `<span class="bag-checkout">${go}</span>` : ''}
      ${BAG_MODALS[shop] || ''}
      <script>
        for (const s of document.querySelectorAll('[data-qty]')) s.addEventListener('change', () => fetch('/${shop}/api/cart/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: s.dataset.qty, qty: Number(s.value) }) }));
        document.getElementById('to-checkout')?.addEventListener('click', () => { location.href = '${SHOPIFY.has(shop) ? `/${shop}/checkouts/c/abc123` : `/${shop}/checkout`}'; });
        ${bagScript(shop)}
      </script>`, { bagCount: bagCount(shop) });
  }

  // Amazon's cart (/gp/cart/view.html): what's in it, each with "Delete" and "Save for later" — and the
  // "Saved for later" list under it (Clear cart leaves that alone).
  function amazonCart() {
    const S = shopOf('amazon');
    const qtySel = (c) => `<select name="quantity" aria-label="Quantity" data-asin="${esc(c.sku)}"><option value="0">0 (Delete)</option>${Array.from({ length: 10 }, (_, j) => `<option value="${j + 1}" ${j + 1 === c.qty ? 'selected' : ''}>${j + 1}</option>`).join('')}</select>`;
    const line = (c) => `<div class="sc-list-item" data-asin="${esc(c.sku)}" data-itemtype="active"><a class="sc-product-link" href="/amazon/dp/${esc(c.sku)}">${esc(c.name)}</a> <span class="sc-price">$${c.price.toFixed(2)}</span>
      ${qtySel(c)} <span class="a-declarative"><input type="submit" value="Delete" data-action="delete" aria-label="Delete ${esc(c.name)}" class="a-color-link" data-asin="${esc(c.sku)}"></span>
      <span class="a-declarative"><input type="submit" value="Save for later" data-action="save-for-later" aria-label="Save for later ${esc(c.name)}" data-asin="${esc(c.sku)}"></span></div>`;
    const saved = (x) => `<div class="sc-list-item" data-asin="${esc(x.sku)}" data-itemtype="saved"><a class="sc-product-link" href="/amazon/dp/${esc(x.sku)}">${esc(x.name)}</a>
      <span class="a-declarative"><input type="submit" value="Delete" data-action="delete-saved" aria-label="Delete ${esc(x.name)}" data-asin="${esc(x.sku)}"></span>
      <span class="a-declarative"><input type="submit" value="Move to cart" data-action="move-to-cart" data-asin="${esc(x.sku)}"></span></div>`;
    return page('amazon', 'Amazon.com.au Shopping Cart', `<div id="sc-active-cart" data-name="Active Items" class="sc-cart"><h1>Shopping Cart</h1>
      <div id="sc-lines">${S.cart.map(line).join('') || '<h2 class="sc-empty">Your Amazon Cart is empty.</h2>'}</div>
      <div class="sc-subtotal" id="sc-subtotal">Subtotal (${bagCount('amazon')} items): $${total('amazon').toFixed(2)}</div>
      ${S.cart.length ? '<a class="a-button" id="sc-buy-box-ptc-button" href="/amazon/checkout/p/p-123/spc">Proceed to checkout</a>' : ''}</div>
      <div id="sc-saved-cart" data-name="Saved Items"><h2>Saved for later (${S.saved.length} item${S.saved.length === 1 ? '' : 's'})</h2>${S.saved.map(saved).join('')}</div>
      <script>
        async function post(path, sku) { const r = await fetch('/amazon/gp/cart/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku }) }); return r.json(); }
        function after(d) {
          const b = document.getElementById('bag-link');
          if (b) { b.setAttribute('aria-label', 'Cart, ' + d.items + ' items'); b.innerHTML = 'Cart' + (d.items ? ' <span class="bag-count">' + d.items + '</span>' : ''); }
          document.getElementById('sc-subtotal').textContent = 'Subtotal (' + d.items + ' items): $' + d.total.toFixed(2);
          if (!document.querySelector('#sc-lines [data-itemtype="active"]')) { document.getElementById('sc-lines').insertAdjacentHTML('beforeend', '<h2 class="sc-empty">Your Amazon Cart is empty.</h2>'); document.getElementById('sc-buy-box-ptc-button')?.remove(); }
        }
        async function del(sku) {
          const line = document.querySelector('#sc-lines [data-asin="' + CSS.escape(sku) + '"]');
          const name = line.querySelector('.sc-product-link').textContent;
          const d = await post('ajax-delete', sku);
          if (!d.ok) return;
          line.outerHTML = '<div class="sc-list-item-removed-msg" role="status">' + name.replace(/</g, '&lt;') + ' was removed from Shopping Cart.</div>';
          after(d);
        }
        document.addEventListener('click', async (e) => {
          const b = e.target.closest('input[data-action]');
          if (!b) return;
          e.preventDefault();
          if (b.dataset.action === 'delete') return del(b.dataset.asin);
          if (b.dataset.action === 'save-for-later') { await post('save-for-later', b.dataset.asin); location.reload(); return; }
          if (b.dataset.action === 'delete-saved') { await post('delete-saved', b.dataset.asin); b.closest('.sc-list-item').remove(); return; }
          if (b.dataset.action === 'move-to-cart') { await post('move-to-cart', b.dataset.asin); location.reload(); }
        });
        for (const s of document.querySelectorAll('#sc-lines select[name=quantity]')) s.addEventListener('change', () => { if (s.value === '0') del(s.dataset.asin); });
      </script>`, { bagCount: bagCount('amazon') });
  }

  // -------------------------------------------------------------------- checkouts
  function cardBoxes(style) {
    return `<iframe id="card" src="${cardOrigin}/card-frame?style=${style}" width="360" height="190" style="border:1px solid #ccc"></iframe>`;
  }

  // Like Adyen's secured fields: one frame per box, each ignoring anything that isn't real typing.
  // mode 'keys': boxes that build their value from key presses only (like masked-input widgets).
  function strictCardBoxes(mode) {
    const box = (field, label) => `<label>${label}<br><iframe class="sf" data-field="${field}" src="${cardOrigin}/card-frame?style=strict&mode=${mode}&field=${field}" width="300" height="44" style="border:1px solid #ccc"></iframe></label>`;
    return `<p><b>Pay with credit or debit card</b></p>${box('number', 'Card number')}${box('expiry', 'Expiry (MM/YY)')}${box('cvc', 'CVV')}
      <script>addEventListener('message', (e) => { if (e.data && e.data.adyenNext) document.querySelector('iframe.sf[data-field=' + e.data.adyenNext + ']')?.focus(); });</script>`;
  }


  // After the final button: the order confirmed — or the card declined, or the bank's "verify it's you" check (in a frame).
  const placeJs = (shop, errId) => `async (body) => {
    ${state.shops[shop] && state.shops[shop].placeKeepsError ? '' : `document.getElementById('${errId}').textContent = '';`}
    const r = await fetch('/${shop}/checkout/place', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (d.error) { const e = document.getElementById('${errId}'); e.textContent = d.error; e.setAttribute('role', 'alert'); return; }
    if (d.challenge) { document.querySelector('main').insertAdjacentHTML('beforeend', '<section id="threeds"><h2>Verify it\\'s you</h2><p>Your bank needs to confirm this payment.</p><iframe src="' + d.challenge + '" width="400" height="300"></iframe></section>'); return; }
    if (d.bank) { ${bankJs()}; return; }
    location.href = '/${shop}/checkout/confirmation';
  }`;

  // The bank's check as real checkouts put it up — whichever store, whichever bank (threeDS 'posted', 'popup',
  // 'nested', 'window' or 'redirect'): the bank's page posted into a frame with no address — named for it, as
  // Adyen's is ('posted'), or not at all, in a pop-up over the checkout ('popup'), or inside the payment provider's
  // own frame with the card boxes ('nested') — or in a window of its own ('window'), or the whole tab sent to the
  // bank's own site ('redirect'): bank.test, an address the extension may not open. Nothing on the checkout says
  // what it is. The page waits for the bank to say it's approved (store.approveBank(): you, in your bank's app),
  // then goes on to the store's confirmation. (d.bank: bankStart's.)
  const bankJs = () => `{
      const b = d.bank;
      if (b.mode === 'redirect') { location.href = b.acs; return; }
      if (b.mode === 'window') window.open(b.acs, 'bank3ds', 'popup,width=440,height=560');
      else if (b.mode === 'nested') {
        const pf = document.querySelector('iframe#card, iframe[src*="card-frame"]');
        pf.width = 440; pf.height = 480;
        pf.contentWindow.postMessage({ mgbBank: b }, '*');
      } else {
        const frame = b.mode === 'posted'
          ? '<div class="adyen-checkout__threeds2__challenge"><iframe name="threeDSIframe" class="adyen-checkout__iframe adyen-checkout__iframe--threeDSIframe" width="390" height="400" frameborder="0"></iframe></div>'
          : '<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:50"><div style="background:#fff;padding:8px;border-radius:8px"><iframe name="f' + b.id + '" width="400" height="420" frameborder="0"></iframe></div></div>';
        document.body.insertAdjacentHTML('beforeend', frame + '<form id="creq" method="POST" action="' + b.acs + '" target="' + (b.mode === 'posted' ? 'threeDSIframe' : 'f' + b.id) + '" style="display:none"><input name="creq" value="' + b.id + '"></form>');
        document.getElementById('creq').submit();
      }
      const poll = setInterval(async () => {
        const s = await (await fetch(b.status)).json().catch(() => ({}));
        if (s.approved) { clearInterval(poll); location.href = s.next; }
      }, 500);
    }`;

  /**
   * The bank's check after a checkout's final button (a shop's threeDS mode): waiting for you to approve it, then
   * the order placed (place) and the page on to the store's confirmation (next). What the page's code needs
   * (bankJs): { mode, id, acs, status }. host: the store's, for the bank's way back ('redirect').
   */
  function bankStart(shop, mode, place, next, host) {
    const id = String(Object.keys(state.bank).length + 1);
    state.bank[id] = { shop, mode, approved: false, next, place };
    // (The bank's own site, bank.test: one the extension may not open or read, as a real bank's isn't.)
    const bankSite = `http://bank.test:${new URL(cardOrigin).port}`;
    const acs = mode === 'redirect' ? `${bankSite}/acs/redirect?id=${id}&back=${encodeURIComponent(`http://${host}${next}`)}` : `${bankSite}/acs/approve?id=${id}`;
    return { mode, id, acs, status: `/bank-status?id=${id}` };
  }
  /** A checkout that posts its final form (a new page): the bank's check on the page that comes back — or, 'redirect', the store sending the tab on to the bank (its own redirect). */
  const bankAnswer = (res, shop, b) => {
    if (b.mode === 'redirect') { res.writeHead(302, { location: b.acs }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page(shop, 'Processing your payment', `<h1>Processing your payment…</h1><script>(() => { const d = ${JSON.stringify({ bank: b })}; ${bankJs()} })();</script>`));
  };

  // The stores near you, nearest first (collectOnly's Click & Collect).
  const PICKUP_STORES = {
    kmart: ['Kmart Cheltenham', 'Kmart Southland'], bigw: ['BIG W Chadstone', 'BIG W Malvern'], target: ['Target Highpoint', 'Target Sunshine'],
    ebgames: ['EB Games Sydney CBD', 'EB Games Broadway'], citybeach: ['City Beach Chadstone', 'City Beach Southland'],
  };
  /**
   * A store finder, as Kmart's, BIG W's and Target's are: (opener) a button that opens it in a dialog, else on the
   * page; a box for a postcode or suburb (box: its placeholder) and its search button (go); the stores near it,
   * nearest first, each with its own button (pick). Choosing one posts it (step 'store': the store, and what was
   * searched) and shows "Collecting from …"; window.__store has it, and 'store-chosen' is said on the page.
   */
  const storeFinder = (shop, { opener = '', box = 'Enter postcode', go = 'Search', pick = 'Select' } = {}) => `
    <p id="sf-chosen" class="store-chosen"></p>
    ${opener ? `<button type="button" id="sf-open">${opener}</button>` : ''}
    <div id="sf-finder" class="store-finder"${opener ? ' role="dialog" aria-modal="true" aria-label="Find a store" hidden style="position:fixed;top:80px;left:30px;width:460px;background:#fff;border:1px solid #888;padding:16px;z-index:20"' : ''}>
      <h3>Find a store near you</h3>
      <input id="sf-q" type="text" placeholder="${box}" autocomplete="off"> <button type="button" id="sf-go">${go}</button>
      <ul id="sf-list" class="store-list"></ul>
    </div>
    <script>
      (() => {
        const $ = (id) => document.getElementById(id);
        const STORES = ${JSON.stringify(PICKUP_STORES[shop] || [])};
        if ($('sf-open')) $('sf-open').addEventListener('click', () => { $('sf-finder').hidden = false; $('sf-q').focus(); });
        const find = () => {
          const q = $('sf-q').value.trim();
          if (q.length < 3) { $('sf-list').innerHTML = '<li class="err">Enter a postcode or suburb</li>'; return; }
          setTimeout(() => { $('sf-list').innerHTML = STORES.map((s, i) => '<li class="store-result"><b>' + s + '</b> · ' + (2.1 + i * 3).toFixed(1) + ' km · Open until 9pm <button type="button" class="sf-pick" data-store="' + s + '">${pick}</button></li>').join(''); }, 250);
        };
        $('sf-go').addEventListener('click', find);
        $('sf-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
        $('sf-list').addEventListener('click', (e) => {
          const b = e.target.closest('.sf-pick');
          if (!b) return;
          window.__store = b.dataset.store;
          $('sf-chosen').textContent = 'Collecting from ' + b.dataset.store;
          if ($('sf-open')) { $('sf-finder').hidden = true; $('sf-open').textContent = 'Change store'; }
          fetch('/${shop}/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'store', data: { store: b.dataset.store, near: $('sf-q').value } }) });
          document.dispatchEvent(new CustomEvent('store-chosen'));
        });
      })();
    </script>`;

  function kmartCheckout() {
    const co = !!shopOf('kmart').collectOnly;
    const acc = state.account || {};
    const v = (x) => esc(x || '');
    const cardFields = ['strict', 'keys', 'never', 'slow'].includes(state.cardInIframe) ? strictCardBoxes(state.cardInIframe) : state.cardInIframe ? cardBoxes(state.cardInIframe === 'mystery' ? 'mystery' : 'kmart')
      : `<p><b>Pay with credit or debit card</b></p>
         <label>Card number <input name="cardNumber" inputmode="numeric"></label>
         <label>Expiry <input name="cardExpiry" placeholder="MM/YY"></label>
         <label>CVV <input name="cardCvv" inputmode="numeric"></label>`;
    return `<h1>Checkout</h1>
      <section id="k-summary"><h2>Order Summary</h2><p>Products $${total('kmart').toFixed(2)}</p><p>Total Delivery to Cheltenham 3192 $10.00</p>
        <div class="carousel"><div class="tile">Bubble Round Platter <button type="button">+ Add</button></div></div>
        <button type="button" id="k-to-details">Continue to details</button></section>
      <section id="k-details" hidden><h2>② Details</h2>
        <p>Welcome. Your saved details (if available) will be put into the checkout.</p>
        <label>Email* <input name="email" type="email" required value="${v(acc.email)}"></label>
        <label>First Name* <input name="firstName" required value="${v(acc.firstName)}"></label>
        <label>Last Name* <input name="lastName" required value="${v(acc.lastName)}"></label>
        <label>Mobile number* <input name="mobile" type="tel" required value="${v(acc.phone)}"></label>
        <label><input type="checkbox" name="kmail"> Signup to Kmail</label>
        <label><input type="checkbox" name="review"> Review purchased products</label>
        <button type="button" id="k-to-delivery">Continue to delivery</button></section>
      <section id="k-delivery" hidden><h2>③ Delivery</h2>
        <label><input type="radio" name="method" value="cc"> Click &amp; Collect</label>
        <label${co ? ' class="is-disabled"' : ''}><input type="radio" name="method" value="home"${co ? ' disabled' : ''}> Home delivery${co ? ' <small>Not available for this order</small>' : ''}</label>
        <div id="k-cc" hidden>${storeFinder('kmart', { opener: 'Select a store', box: 'Enter postcode' })}</div>
        <div id="k-home">
        <label>Street address* <input name="address1" required></label>
        <label>Apartment, unit, etc. (optional) <input name="address2"></label>
        <label>Suburb* <input name="suburb" required></label>
        <label>State* <select name="state" required>${STATES}</select></label>
        <label>Postcode* <input name="postcode" required maxlength="4"></label></div>
        <button type="button" id="k-to-payment">Continue to payment</button></section>
      <section id="k-payment" hidden><h2>④ Payment</h2><p>Select a payment method</p>
        <p class="order-total"><b>Total $${(total('kmart') + 10).toFixed(2)}</b></p>
        <label><input type="radio" name="pay" value="card" checked> Credit or debit card</label>
        <label><input type="radio" name="pay" value="paypal"> PayPal</label>
        <label><input type="radio" name="pay" value="afterpay"> afterpay</label>
        <label><input type="radio" name="pay" value="zip"> zip</label>
        ${cardFields}
        <p><button type="button" id="k-place"${state.shops.kmart.finalGreyedMs ? ' disabled' : ''}>Checkout securely</button></p></section>
      <p id="k-error" class="err"></p>
      <script>
        const data = (sec) => Object.fromEntries([...sec.querySelectorAll('input,select')].filter((i) => i.name && !i.closest('[hidden]')).map((i) => [i.name, i.type === 'checkbox' || i.type === 'radio' ? (i.checked ? (i.value || true) : undefined) : i.value]).filter(([, x]) => x !== undefined));
        for (const r of document.querySelectorAll('input[name=method]')) r.addEventListener('change', () => { const cc = r.value === 'cc' && r.checked; document.getElementById('k-cc').hidden = !cc; document.getElementById('k-home').hidden = cc; });
        const step = (name, sec, next) => {
          const missing = [...sec.querySelectorAll('[required]')].filter((i) => !i.value && !i.closest('[hidden]'));
          if (name === 'delivery' && !sec.querySelector('input[name=method]:checked')) missing.push({ name: 'method' });
          if (name === 'delivery' && sec.querySelector('input[name=method][value=cc]:checked') && !window.__store) missing.push({ name: 'store' });
          if (missing.length) { document.getElementById('k-error').textContent = 'Please complete: ' + missing.map((m) => m.name).join(', '); return; }
          document.getElementById('k-error').textContent = '';
          fetch('/kmart/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: name, data: data(sec) }) });
          sec.querySelector('button[id^=k-to]').remove();
          setTimeout(() => { next.hidden = false; }, 300);
        };
        const $ = (id) => document.getElementById(id);
        $('k-to-details').addEventListener('click', () => step('summary', $('k-summary'), $('k-details')));
        $('k-to-delivery').addEventListener('click', () => step('details', $('k-details'), $('k-delivery')));
        $('k-to-payment').addEventListener('click', () => {
          step('delivery', $('k-delivery'), $('k-payment'));
          ${state.shops.kmart.finalGreyedMs ? `setTimeout(() => { $('k-place').disabled = false; }, ${Number(state.shops.kmart.finalGreyedMs)});` : ''}
        });
        const place = ${placeJs('kmart', 'k-error')};
        $('k-place').addEventListener('click', () => place(data($('k-payment'))));
        for (const el of document.querySelectorAll('input[name=cardNumber]')) el.addEventListener('input', () => { el.value = el.value.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 '); });
        for (const el of document.querySelectorAll('input[name=cardExpiry]')) el.addEventListener('input', () => { const d = el.value.replace(/\\D/g, '').slice(0, 4); el.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; });
      </script>`;
  }

  // City Beach's one-page checkout (Salesforce Commerce Cloud), in stages like the real one:
  // ?stage=customer (email → "Continue as guest") → shipping ("Delivery" tab, "Delivery to my
  // address", name, mobile, address → "Submit shipping") → payment (card boxes in a payment
  // provider's frame, the total) → "Confirm & pay".
  function citybeachCheckout() {
    const sum = total('citybeach');
    // (collectOnly: its Delivery tab greyed out, "Unavailable for this order"; Click & Collect: its stores near you as a
    //  list to choose one from — nothing chosen — and your name and mobile.)
    const co = !!shopOf('citybeach').collectOnly;
    const ship = co ? 0 : 9.95;
    const f = (n) => `dwfrm_shipping_shippingAddress_addressFields_${n}`;
    return `<h1>Checkout</h1>
      <section id="cb-customer" class="customer-section"><h2>Customer</h2>
        <label for="email-guest">Email</label> <input id="email-guest" name="dwfrm_coCustomer_email" type="email" autocomplete="email" required>
        <p><button type="button" class="btn submit-customer" id="cb-guest">Continue as guest</button> <a href="/citybeach/login">Login</a></p></section>
      <section id="cb-shipping" class="shipping-section" hidden><h2>Shipping</h2>
        <div class="nav nav-tabs" role="tablist"><a class="nav-link${co ? ' disabled' : ''}" role="tab" href="#home-delivery" id="cb-tab-home"${co ? ' aria-disabled="true"' : ''}>Delivery${co ? ' <small>Unavailable for this order</small>' : ''}</a> <a class="nav-link" role="tab" href="#click-collect" id="cb-tab-cc">Click &amp; Collect</a></div>
        <div id="cb-cc" hidden><h3>Collect from</h3>
          ${PICKUP_STORES.citybeach.map((s, i) => `<label class="store-option"><input type="radio" name="dwfrm_shipping_storeId" value="cb${i + 1}"> ${s} · ${(1.8 + i * 4).toFixed(1)} km · Ready in 2 hours</label>`).join('')}
          <label>First name <input name="ccFirstName" autocomplete="given-name"></label>
          <label>Last name <input name="ccLastName" autocomplete="family-name"></label>
          <label>Mobile <input name="ccPhone" type="tel" autocomplete="tel"></label></div>
        <div id="cb-home" hidden>
          <label><input type="radio" name="deliveryType" value="home"> Delivery to my address</label>
          <label><input type="radio" name="deliveryType" value="po"> Delivery to a PO box</label>
          <label>First name <input name="${f('firstName')}" autocomplete="given-name" required></label>
          <label>Last name <input name="${f('lastName')}" autocomplete="family-name" required></label>
          <label>Mobile <input name="${f('phone')}" type="tel" autocomplete="tel" required></label>
          <label>Address line 1 <input name="${f('address1')}" autocomplete="address-line1" required></label>
          <label>Address line 2 (optional) <input name="${f('address2')}" autocomplete="address-line2"></label>
          <label>Suburb <input name="${f('city')}" autocomplete="address-level2" required></label>
          <label>State <select name="${f('states_stateCode')}" autocomplete="address-level1" required>${STATES}</select></label>
          <label>Postcode <input name="${f('postalCode')}" autocomplete="postal-code" required maxlength="4"></label>
        </div>
        <button type="button" class="btn submit-shipping" id="cb-ship" name="submit-shipping" value="submit-shipping">Submit shipping</button></section>
      <section id="cb-payment" class="payment-section" hidden><h2>Payment</h2>
        <p><b>Credit / debit card</b></p>${cardBoxes('stripe')}
        <div class="order-totals"><p>Subtotal A$${sum.toFixed(2)}</p><p>Shipping A$${ship.toFixed(2)}</p>
          <p class="order-total">Total <span class="grand-total-sum">A$${(sum + ship).toFixed(2)}</span></p></div>
        <button type="button" class="btn submit-payment" id="cb-pay" name="submit-payment" value="submit-payment">Confirm &amp; pay</button></section>
      <section id="cb-review" hidden><h2>Review your order</h2><p>Total A$${(sum + ship).toFixed(2)}</p>
        <button type="button" class="btn place-order" id="cb-place" name="submit" value="place-order">Confirm &amp; pay</button></section>
      <p id="cb-error" class="err"></p>
      <script>
        const $ = (id) => document.getElementById(id);
        const data = (sec) => Object.fromEntries([...sec.querySelectorAll('input,select')].map((i) => [i.name, i.type === 'radio' ? (i.checked ? i.value : undefined) : i.value]).filter(([, x]) => x !== undefined));
        const stage = (name, show) => { history.replaceState(null, '', '/citybeach/checkout?stage=' + name + '#' + name); show.hidden = false; };
        const missing = (sec) => [...sec.querySelectorAll('[required]')].filter((i) => !i.hidden && i.offsetParent !== null && !i.value).map((i) => i.name);
        const err = (t) => { $('cb-error').textContent = t; };
        $('cb-guest').addEventListener('click', () => {
          if (!/@/.test($('email-guest').value)) return err('Please enter a valid email address');
          err('');
          fetch('/citybeach/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'customer', data: data($('cb-customer')) }) });
          $('cb-guest').remove();
          setTimeout(() => stage('shipping', $('cb-shipping')), 300);
        });
        $('cb-tab-home').addEventListener('click', (e) => { e.preventDefault(); if ($('cb-tab-home').getAttribute('aria-disabled') === 'true') return; $('cb-tab-home').classList.add('active'); $('cb-tab-home').setAttribute('aria-selected', 'true'); $('cb-home').hidden = false; $('cb-cc').hidden = true; });
        $('cb-tab-cc').addEventListener('click', (e) => { e.preventDefault(); $('cb-tab-cc').classList.add('active'); $('cb-tab-cc').setAttribute('aria-selected', 'true'); $('cb-home').hidden = true; $('cb-cc').hidden = false; });
        $('cb-ship').addEventListener('click', () => {
          if (!$('cb-cc').hidden) {
            // Click & Collect: a store, and your name and mobile.
            const store = document.querySelector('input[name=dwfrm_shipping_storeId]:checked');
            const d = data($('cb-cc'));
            const m = (store ? [] : ['store']).concat(['ccFirstName', 'ccLastName', 'ccPhone'].filter((k) => !d[k]));
            if (m.length) return err('Please complete: ' + m.join(', '));
            err('');
            fetch('/citybeach/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'shipping', data: { ...d, collect: true, store: store.closest('label').textContent.trim().split(' · ')[0] } }) });
            $('cb-ship').remove();
            return setTimeout(() => stage('payment', $('cb-payment')), 400);
          }
          if ($('cb-home').hidden) return err('Choose Delivery or Click & Collect');
          if (!document.querySelector('input[name=deliveryType]:checked')) return err('Please select a delivery option');
          const m = missing($('cb-shipping'));
          if (m.length) return err('Please complete: ' + m.join(', '));
          err('');
          fetch('/citybeach/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'shipping', data: data($('cb-shipping')) }) });
          $('cb-ship').remove();
          setTimeout(() => stage('payment', $('cb-payment')), 400);
        });
        const place = ${placeJs('citybeach', 'cb-error')};
        // reviewStage: like Salesforce's own checkout, the payment button opens a last "place order" stage with its own button.
        $('cb-pay').addEventListener('click', () => {
          if (!${shopOf('citybeach').reviewStage ? 'true' : 'false'}) return place(data($('cb-payment')));
          fetch('/citybeach/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'payment', data: {} }) });
          $('cb-payment').hidden = true;
          setTimeout(() => stage('placeOrder', $('cb-review')), 500);
        });
        $('cb-place').addEventListener('click', () => place({}));
      </script>`;
  }

  // EB Games' checkout, as the real one goes: your details → Delivery, with Click & Collect chosen for
  // you → "Home Delivery" → Country (Australia) → the address, one line, picked from EB's suggestions →
  // the shipping method EB picked → "How would you like to pay?": Pay Now, then "Credit / Debit card" →
  // card number, MM/YY, CVV and name on card (in a payment frame), billing address the same as the
  // delivery one (ticked) → "Done" → "CONFIRM & PAY". Signed in (state.signedIn.ebgames): it's all in —
  // home delivery, your address, your saved card — and only "CONFIRM & PAY" is left.
  function ebgamesCheckout() {
    const sum = total('ebgames');
    // (collectOnly: Home Delivery switched off — Click & Collect, its store chosen from the drop-down, then payment.)
    const co = !!shopOf('ebgames').collectOnly;
    const signed = !!state.signedIn.ebgames && !co;
    const acc = signed ? { email: 'ash.eb@example.com', firstName: 'Ash', lastName: 'Ketchum', phone: '0412345678' } : {};
    const v = (k) => (acc[k] ? ` value="${esc(acc[k])}"` : '');
    return `<h1>Checkout</h1>
      <form method="post" action="/ebgames/checkout/place" id="eb-form">
      <section id="eb-contact"><h2>Contact details</h2>
        <label>Email address <input name="email" type="email" required${v('email')}></label>
        <label>First name <input name="firstName" required${v('firstName')}></label>
        <label>Last name <input name="lastName" required${v('lastName')}></label>
        <label>Mobile number <input name="phone" type="tel" required${v('phone')}></label>
        <label><input type="checkbox" name="news"> Send me news and offers</label></section>
      <section id="eb-delivery"><h2>Delivery</h2>
        <label><input type="radio" name="fulfilment" value="cnc" ${signed ? '' : 'checked'}> Click &amp; Collect</label>
        <label${co ? ' class="disabled"' : ''}><input type="radio" name="fulfilment" value="home" ${signed ? 'checked' : ''}${co ? ' disabled' : ''}> Home Delivery${co ? ' <small>(not available for this item)</small>' : ''}</label>
        <div id="eb-cnc" ${signed ? 'hidden' : ''}><label>Choose a store <select name="cncStore"><option value="">Select a store</option>${PICKUP_STORES.ebgames.map((s) => `<option>${s}</option>`).join('')}</select></label></div>
        <div id="eb-home" ${signed ? '' : 'hidden'}>
          <label>Country <select name="country"><option value="">Select country</option><option value="NZ">New Zealand</option><option value="AU" ${signed ? 'selected' : ''}>Australia</option></select></label>
          <label for="eb-addr">Address</label>
          <input id="eb-addr" name="addressSearch" role="combobox" aria-autocomplete="list" autocomplete="off" placeholder="Start typing your address" ${signed ? 'value="1 Pallet Town Rd, Sydney NSW 2000"' : 'disabled'}>
          <ul id="eb-addr-list" role="listbox" class="address-suggestions" hidden></ul>
          <input type="hidden" name="address" value="${signed ? '1 Pallet Town Rd, Sydney NSW 2000' : ''}">
          <div id="eb-ship" ${signed ? '' : 'hidden'}><h3>Shipping method</h3>
            <label><input type="radio" name="shipping" value="standard" checked> Standard Delivery $9.95</label>
            <label><input type="radio" name="shipping" value="express"> Express Delivery $14.95</label></div>
        </div></section>
      <section id="eb-pay" ${signed ? '' : 'hidden'}><h2>How would you like to pay?</h2>
        <div role="tablist"><button type="button" role="tab" aria-selected="true" class="pay-tab is-active">Pay Now</button> <button type="button" role="tab" aria-selected="false" class="pay-tab">Pay Later</button></div>
        ${signed ? (state.shops.ebgames.savedCard ? `<div class="saved-card"><span class="brand" aria-hidden="true">💳</span> <span>${esc(state.shops.ebgames.savedCard)}</span></div>` : '<p class="saved-card">Visa ending in 4242 <small>Expires 07/29</small></p>') : `<div class="pay-options">
          <button type="button" class="pay-option" data-m="card">Credit / Debit card</button>
          <button type="button" class="pay-option" data-m="paypal">PayPal</button>
          <button type="button" class="pay-option" data-m="applepay">Apple Pay</button></div>
        <div id="eb-card" hidden><iframe id="eb-card-frame" title="Card details" src="${cardOrigin}/card-frame?style=eb" width="360" height="230" style="border:1px solid #ccc"></iframe>
          <label><input type="checkbox" name="billingSame" checked> Billing address same as delivery address</label>
          <p><button type="button" id="eb-done">Done</button></p></div>
        <p id="eb-card-saved" hidden></p>`}</section>
      <p class="order-total">Total: $${(sum + 9.95).toFixed(2)}</p>
      <label class="terms"><input type="checkbox" name="marketing"> Subscribe to our newsletter</label>
      <p><button type="submit" id="eb-confirm" ${signed ? '' : 'disabled'}>CONFIRM &amp; PAY</button></p>
      <input type="hidden" name="cardDone" value="${signed ? 'saved' : ''}">
      </form>
      <p id="eb-error" class="err"></p>
      <script>
        const $ = (id) => document.getElementById(id);
        const post = (step, data) => fetch('/ebgames/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step, data }) });
        const form = $('eb-form');
        for (const r of form.querySelectorAll('input[name=fulfilment]')) r.addEventListener('change', () => {
          const home = r.value === 'home' && r.checked;
          $('eb-home').hidden = !home; $('eb-cnc').hidden = home;
          post('fulfilment', { fulfilment: r.value });
        });
        form.querySelector('select[name=country]').addEventListener('change', (e) => { $('eb-addr').disabled = e.target.value !== 'AU'; post('country', { country: e.target.value }); });
        // Click & Collect: its store chosen, then how you'd like to pay.
        form.querySelector('select[name=cncStore]').addEventListener('change', (e) => {
          post('store', { store: e.target.value, fulfilment: 'cnc' });
          if (e.target.value) setTimeout(() => { $('eb-pay').hidden = false; }, 300);
        });
        const ADDRESSES = ['1 Pallet Town Rd, SYDNEY NSW 2000', '1 Pallet Town Rd, PALLET QLD 4999'];
        const list = $('eb-addr-list');
        $('eb-addr').addEventListener('input', () => {
          form.querySelector('[name=address]').value = '';
          const q = $('eb-addr').value.toLowerCase();
          clearTimeout(window.__t);
          window.__t = setTimeout(() => {
            const hits = q.length >= 4 ? ADDRESSES.filter((a) => q.split(/[\\s,]+/).filter((w) => w.length > 2).slice(0, 2).every((w) => a.toLowerCase().includes(w))) : [];
            list.innerHTML = hits.map((a) => '<li role="option">' + a + '</li>').join('');
            list.hidden = !hits.length;
          }, 250);
        });
        $('eb-addr').addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 200));
        list.addEventListener('mousedown', (e) => {
          const li = e.target.closest('li'); if (!li) return;
          e.preventDefault();
          $('eb-addr').value = li.textContent; form.querySelector('[name=address]').value = li.textContent; list.hidden = true;
          const d = Object.fromEntries(['email', 'firstName', 'lastName', 'phone', 'country'].map((n) => [n, form.querySelector('[name=' + n + ']').value]));
          post('address', { ...d, address: li.textContent });
          setTimeout(() => { $('eb-ship').hidden = false; $('eb-pay').hidden = false; }, 400);
        });
        for (const b of document.querySelectorAll('.pay-option')) b.addEventListener('click', () => {
          for (const x of document.querySelectorAll('.pay-option')) x.classList.remove('is-selected');
          b.classList.add('is-selected');
          $('eb-card').hidden = b.dataset.m !== 'card';
          post('payment', { method: b.dataset.m });
        });
        // The card frame says what's in it; "Done" takes it (only once it's all in).
        const card = {};
        addEventListener('message', (e) => { if (e.data && e.data.ebCard) card[e.data.ebCard] = e.data.value; });
        $('eb-done')?.addEventListener('click', () => {
          if (!(card.cardNumber && card.expiry && card.cvv && card.nameOnCard)) { $('eb-error').textContent = 'Please complete your card details'; return; }
          $('eb-error').textContent = '';
          form.querySelector('[name=cardDone]').value = card.cardNumber.slice(-4);
          post('card', { last4: card.cardNumber.replace(/\\D/g, '').slice(-4), expiry: card.expiry, name: card.nameOnCard });
          $('eb-card').hidden = true; $('eb-card-saved').hidden = false; $('eb-card-saved').textContent = 'Card ending in ' + card.cardNumber.replace(/\\D/g, '').slice(-4);
          $('eb-confirm').disabled = false;
        });
      </script>`;
  }

  // Target's one-page checkout (/spc/order), as the real one goes: Delivery Options as tiles (nothing
  // chosen) → "Home Delivery" → your details (first and last name, contact number, email) and the
  // delivery address, one line, picked from Target's suggestions as you type → Payment Method tiles →
  // "Credit Card" → Paydock's card form (a frame from another address: card holder's name, card
  // number, expiry MM/YY, CVV). "Place order" shows from the start, greyed out until it's all done.
  // Signed in (state.signedIn.target): your details are already in; the rest is the same.
  function targetCheckout() {
    const sum = total('target');
    // (collectOnly: Home Delivery greyed out, "Not available for this order"; Click & Collect: its store finder on the
    //  page — a postcode, "Find stores", a store's "Select store" — then your details, without an address.)
    const co = !!shopOf('target').collectOnly;
    const acc = state.signedIn.target ? { firstName: 'Ash', lastName: 'Ketchum', phone: '0412345678', email: 'ash.target@example.com' } : {};
    const v = (k) => (acc[k] ? ` value="${esc(acc[k])}"` : '');
    const tile = (cls, attr, title, sub) => `<div class="${cls}" role="radio" aria-checked="false" tabindex="0" ${attr}><span class="${cls}-title">${title}</span>${sub ? `<small> ${sub}</small>` : ''}</div>`;
    return `<h1>Checkout</h1>
      <section id="t-options"><h2>Delivery Options</h2>
        ${co ? tile('DeliveryOption is-disabled', 'data-mode="home" aria-disabled="true"', 'Home Delivery', 'Not available for this order') : tile('DeliveryOption', 'data-mode="home"', 'Home Delivery', 'Delivered to your door')}
        ${tile('DeliveryOption', 'data-mode="cnc"', 'Click &amp; Collect', 'Free, at a store near you')}</section>
      <section id="t-store" hidden><h2>Choose your store</h2>${storeFinder('target', { box: 'Enter postcode or suburb', go: 'Find stores', pick: 'Select store' })}</section>
      <section id="t-details" hidden><h2>Your details</h2>
        <label>First Name <input name="firstName" autocomplete="given-name" required${v('firstName')}></label>
        <label>Last Name <input name="lastName" autocomplete="family-name" required${v('lastName')}></label>
        <label>Contact Number <input name="contactNumber" type="tel" required${v('phone')}></label>
        <label>Email <input name="email" type="email" required${v('email')}></label>
        <div id="t-addr-wrap"><label for="t-addr">Delivery Address</label>
        <input id="t-addr" name="deliveryAddress" role="combobox" aria-autocomplete="list" aria-controls="t-addr-list" aria-expanded="false" autocomplete="off" placeholder="Start typing your address">
        <ul id="t-addr-list" role="listbox" class="AddressSuggestions" hidden></ul></div>
        <p id="t-cc-wrap" hidden><button type="button" id="t-cc-next">Continue to payment</button></p></section>
      <section id="t-payment" hidden><h2>Payment Method</h2>
        ${tile('PaymentTile', 'data-pay="card"', 'Credit Card')}${tile('PaymentTile', 'data-pay="paypal"', 'PayPal')}${tile('PaymentTile', 'data-pay="afterpay"', 'Afterpay')}${tile('PaymentTile', 'data-pay="zip"', 'Zip')}
        <div id="t-card" hidden><iframe id="paydock" title="Credit card" src="${cardOrigin}/paydock-widget" width="380" height="260" style="border:1px solid #ccc"></iframe></div></section>
      <div class="OrderSummary"><p>Subtotal $${sum.toFixed(2)} · Home Delivery $9.00</p><p class="order-total"><b>Order total $${(sum + 9).toFixed(2)}</b></p>
        <button type="button" id="t-place" disabled>Place order</button></div>
      <input type="hidden" id="t-cardNumber"><input type="hidden" id="t-cardName"><input type="hidden" id="t-cardExpiry"><input type="hidden" id="t-cardCvv">
      <p id="t-error" class="err"></p>
      <script>
        const $ = (id) => document.getElementById(id);
        const post = (step, data) => fetch('/target/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step, data }) });
        const ADDRESSES = ['1 Pallet Town Rd, SYDNEY NSW 2000', '1 Pallet Town Rd, PALLET VIC 3999', '10 Pallet Town Ave, SYDNEY NSW 2000'];
        let mode = '', address = '', pay = '';
        const pick = (el, group) => { for (const t of document.querySelectorAll(group)) { t.setAttribute('aria-checked', 'false'); t.classList.remove('is-selected'); } el.setAttribute('aria-checked', 'true'); el.classList.add('is-selected'); };
        const ready = () => {
          const d = Object.fromEntries([...$('t-details').querySelectorAll('input')].filter((i) => i.name && i.name !== 'deliveryAddress').map((i) => [i.name, i.value]));
          const card = $('t-cardNumber').value && $('t-cardExpiry').value && $('t-cardCvv').value && $('t-cardName').value;
          const where = (mode === 'home' && address) || (mode === 'cnc' && window.__store);
          $('t-place').disabled = !(where && Object.values(d).every(Boolean) && pay === 'card' && card);
          return d;
        };
        for (const t of document.querySelectorAll('.DeliveryOption')) t.addEventListener('click', () => {
          if (t.getAttribute('aria-disabled') === 'true') return;
          pick(t, '.DeliveryOption'); mode = t.dataset.mode;
          if (mode === 'cnc') { $('t-error').textContent = 'Choose a store to collect from'; $('t-details').hidden = true; $('t-store').hidden = false; return; }
          $('t-store').hidden = true; $('t-addr-wrap').hidden = false; $('t-cc-wrap').hidden = true;
          $('t-error').textContent = ''; setTimeout(() => { $('t-details').hidden = false; }, 250);
        });
        // Click & Collect: the store chosen, your details (no address), then payment.
        document.addEventListener('store-chosen', () => {
          $('t-error').textContent = '';
          $('t-addr-wrap').hidden = true; $('t-cc-wrap').hidden = false;
          setTimeout(() => { $('t-details').hidden = false; }, 250);
        });
        $('t-cc-next').addEventListener('click', () => {
          const d = ready();
          if (!Object.values(d).every(Boolean)) { $('t-error').textContent = 'Please complete your details'; return; }
          post('delivery', { mode, ...d, store: window.__store });
          $('t-cc-next').remove();
          setTimeout(() => { $('t-payment').hidden = false; ready(); }, 400);
        });
        // The address finder: suggestions once a few letters are in; only a picked one counts.
        const list = $('t-addr-list');
        $('t-addr').addEventListener('input', () => {
          address = '';
          const q = $('t-addr').value.toLowerCase();
          clearTimeout(window.__t);
          window.__t = setTimeout(() => {
            const hits = q.length >= 3 ? ADDRESSES.filter((a) => q.split(/[\\s,]+/).filter((w) => w.length > 2).slice(0, 3).every((w) => a.toLowerCase().includes(w))) : [];
            list.innerHTML = hits.map((a) => '<li role="option" class="AddressSuggestions-item">' + a + '</li>').join('');
            list.hidden = !hits.length; $('t-addr').setAttribute('aria-expanded', String(!!hits.length));
          }, 300);
        });
        list.addEventListener('mousedown', (e) => {
          const li = e.target.closest('li'); if (!li) return;
          e.preventDefault();
          address = li.textContent; $('t-addr').value = address; list.hidden = true; $('t-error').textContent = '';
          post('delivery', { mode, ...ready(), address });
          setTimeout(() => { $('t-payment').hidden = false; ready(); }, 600);
        });
        $('t-addr').addEventListener('blur', () => { setTimeout(() => { if (!address && $('t-addr').value) $('t-error').textContent = 'Please select an address from the list'; list.hidden = true; }, 200); });
        for (const t of document.querySelectorAll('.PaymentTile')) t.addEventListener('click', () => {
          pick(t, '.PaymentTile'); pay = t.dataset.pay; $('t-card').hidden = pay !== 'card'; ready();
        });
        // Paydock's card form says what's in it.
        addEventListener('message', (e) => { const d = e.data; if (d && d.paydock) { $('t-' + d.paydock).value = d.value; ready(); } });
        for (const i of $('t-details').querySelectorAll('input')) i.addEventListener('input', ready);
        const place = ${placeJs('target', 't-error')};
        $('t-place').addEventListener('click', () => { if (!$('t-place').disabled) place({ cardNumber: $('t-cardNumber').value, cardName: $('t-cardName').value, cardExpiry: $('t-cardExpiry').value, cardCvv: $('t-cardCvv').value }); });
      </script>`;
  }

  // Shopify's one-page checkout, the way it is now: contact, delivery (with Australia chosen), the
  // shipping methods, and the card in Shopify's card fields — one frame per box, from another address
  // (checkout.pci.shopifyinc.com on the real ones), each box only keeping real typing. Toys"R"Us adds
  // "Authority to leave" (ticked), and "Use shipping address as billing address" comes ticked.
  // Signed in with Shop (state.signedIn[shop] === 'shop'): everything's in, Shop Pay's card shown. Signed in to
  // the store's own account ('account'): the details it saved for you in (another address than Mugibot's), the
  // card still to type.
  function shopifyCheckout(shop) {
    const shopPay = state.signedIn[shop] === 'shop';
    const P = shopPay ? { email: 'ash.shop@example.com', firstName: 'Ash', lastName: 'Ketchum', address1: '1 Pallet Town Rd', city: 'Sydney', zone: 'NSW', postalCode: '2000', phone: '0412345678' }
      : state.signedIn[shop] === 'account' ? { email: `ash.${shop}@example.com`, firstName: 'Ash', lastName: 'Ketchum', address1: '7 Viridian St', city: 'Melbourne', zone: 'VIC', postalCode: '3000', phone: '0498765432' } : {};
    const v = (k) => (P[k] ? ` value="${esc(P[k])}"` : '');
    // Its Ship / Pick up choice (pickup, or collectOnly), Ship chosen: Pick up shows its pick-up locations (none
    // chosen) instead of the address and shipping methods. collectOnly: "Shipping not available" and no methods.
    const co = !!shopOf(shop).collectOnly;
    const methods = shopOf(shop).pickup || co;
    const locs = ['Chadstone', 'Southland'].map((s, i) => `<label class="pickup-location"><input type="radio" name="pickupLocation" value="loc${i + 1}"> ${esc(SHOPS[shop].name)} ${s} · ${i ? '1239 Nepean Hwy, Cheltenham VIC 3192' : '1341 Dandenong Rd, Chadstone VIC 3148'} · Usually ready in 2 hours · Free</label>`).join('');
    const ship = shopOf(shop).shippingRates || (shop === 'jbhifi' ? 'standard' : 'none');
    const rates = [['standard', shop === 'toysrus' ? 'Standard Shipping - AusPost' : 'Standard Shipping', 10], ['express', shop === 'toysrus' ? 'Express Shipping - AusPost' : 'Express Shipping', 15]];
    const field = (f, label) => `<div class="card-field"><iframe class="card-fields-iframe" name="card-fields-${f}-abc" title="Field container for: ${label}" src="${cardOrigin}/shopify-card?field=${f}" width="300" height="44" style="border:1px solid #ccc"></iframe></div>`;
    const card = shopPay
      ? '<div class="shop-pay"><b>Shop Pay</b> <span>Visa •••• 4242</span> <span class="muted">Expires 07/29</span></div>'
      : `<label><input type="radio" name="payment" value="card" checked> Credit card</label>${field('number', 'Card number')}${field('expiry', 'Expiration date')}${field('verification_value', 'Security code')}${shop === 'gamerholic' ? '' : field('name', 'Name on card')}
         <label><input type="checkbox" name="billingSame"${shopOf(shop).billingUnticked ? '' : ' checked'}> Use shipping address as billing address</label>
         <div id="billing-address"${shopOf(shop).billingUnticked ? '' : ' hidden'}><h4>Billing address</h4><input name="billingAddress1" placeholder="Billing address"></div>`;
    return `<h1>Checkout</h1><form method="post" id="sf">
        <h3>Contact</h3><input name="email" type="email" autocomplete="email" placeholder="Email" required${v('email')}>
        <h3>Delivery</h3>
        ${methods ? '<div class="delivery-methods" role="radiogroup" aria-label="Choose a delivery method"><label><input type="radio" name="deliveryMethod" value="ship" checked> Ship</label> <label><input type="radio" name="deliveryMethod" value="pickup"> Pick up</label></div>' : ''}
        <div id="pickup-locs" hidden><h3>Pickup locations</h3><p>There are 2 stores with stock close to you</p>${locs}</div>
        <select name="countryCode" autocomplete="shipping country"><option value="AU" selected>Australia</option><option value="NZ">New Zealand</option></select>
        <input name="firstName" autocomplete="shipping given-name" placeholder="First name" required${v('firstName')}>
        <input name="lastName" autocomplete="shipping family-name" placeholder="Last name" required${v('lastName')}>
        <div id="ship-address">
        <input name="address1" autocomplete="shipping address-line1" placeholder="Address" required role="combobox" aria-autocomplete="list" aria-controls="address1-options"${v('address1')}>
        ${SUGGESTS.has(shop) ? '<ul id="address1-options" role="listbox" class="address-suggestions" hidden style="position:absolute;background:#fff;border:1px solid #ccc;margin:0;padding:0;list-style:none;z-index:5;width:320px"></ul>' : ''}
        <input name="address2" autocomplete="shipping address-line2" placeholder="Apartment, suite, etc. (optional)">
        <input name="city" autocomplete="shipping address-level2" placeholder="Suburb" required${v('city')}>
        <select name="zone" autocomplete="shipping address-level1" required><option value="" disabled ${P.zone ? '' : 'selected'}>State/territory</option><option value="ACT">Australian Capital Territory</option><option value="NSW" ${P.zone === 'NSW' ? 'selected' : ''}>New South Wales</option><option value="VIC" ${P.zone === 'VIC' ? 'selected' : ''}>Victoria</option><option value="QLD">Queensland</option></select>
        <input name="postalCode" autocomplete="shipping postal-code" placeholder="Postcode" required${v('postalCode')}></div>
        <input name="phone" autocomplete="shipping tel" placeholder="Phone${shop === 'gamerholic' ? ' (optional)' : ''}" type="tel"${v('phone')}>
        ${shop === 'toysrus' ? '<label><input type="checkbox" name="atl" checked> Authority to leave</label>' : ''}
        <div id="ship-rates"><h3>Shipping method</h3>${co ? '<div class="notice" role="alert"><p><b>Shipping not available</b></p><p>Your order cannot be shipped to the selected address. Review your address to ensure it\'s correct and try again, or select a different address.</p></div>' : rates.map(([id, label, price]) => `<label><input type="radio" name="shipping" value="${id}" ${ship === id ? 'checked' : ''}> ${label} $${price.toFixed(2)}</label>`).join('')}</div>
        <h3>Payment</h3><p>All transactions are secure and encrypted.</p>${card}
        <input type="hidden" name="card_number"><input type="hidden" name="card_expiry"><input type="hidden" name="card_cvv"><input type="hidden" name="card_name">
        <p class="order-total">Total: $<span id="tot">${(total(shop) + 10).toFixed(2)}</span></p>
        <button type="submit" id="pay">Pay now</button></form>
      <script>
        // The card fields' frames say what's in them (Shopify keeps it in its vault; here, in the form).
        const map = { number: 'card_number', expiry: 'card_expiry', verification_value: 'card_cvv', name: 'card_name' };
        addEventListener('message', (e) => { if (e.data && e.data.cardField && map[e.data.cardField]) document.querySelector('[name=' + map[e.data.cardField] + ']').value = e.data.value; });
        for (const r of document.querySelectorAll('input[name=shipping]')) r.addEventListener('change', () => { document.getElementById('tot').textContent = (${total(shop)} + (r.value === 'express' ? 15 : 10)).toFixed(2); });
        // Ship or Pick up: picking up, its locations instead of the address (left out of the form) and the shipping methods.
        for (const r of document.querySelectorAll('input[name=deliveryMethod]')) r.addEventListener('change', () => {
          const pickup = r.value === 'pickup' && r.checked;
          document.getElementById('pickup-locs').hidden = !pickup;
          document.getElementById('ship-address').hidden = pickup;
          document.getElementById('ship-rates').hidden = pickup;
          for (const i of document.querySelectorAll('#ship-address input, #ship-address select')) i.disabled = pickup;
          document.getElementById('tot').textContent = (${total(shop)} + (pickup ? 0 : 10)).toFixed(2);
        });
        document.querySelector('[name=billingSame]')?.addEventListener('change', (e) => { document.getElementById('billing-address').hidden = e.target.checked; });
        // Shopify's address suggestions (as you type the address): picking one fills in the suburb, state/territory and postcode.
        const list = document.getElementById('address1-options');
        if (list) {
          const a1 = document.querySelector('[name=address1]');
          a1.addEventListener('input', () => {
            const q = a1.value.trim();
            if (q.length < 3) { list.hidden = true; return; }
            list.innerHTML = [['Sydney', 'NSW', '2000'], ['Melbourne', 'VIC', '3000']].map(([c, z, pc]) => '<li role="option" data-city="' + c + '" data-zone="' + z + '" data-pc="' + pc + '" style="padding:6px;cursor:pointer">' + q.replace(/</g, '&lt;') + ', ' + c + ' ' + z + ', Australia</li>').join('');
            list.hidden = false;
          });
          list.addEventListener('mousedown', (e) => {
            const o = e.target.closest('[role=option]');
            if (!o) return;
            e.preventDefault();
            document.querySelector('[name=city]').value = o.dataset.city; document.querySelector('[name=zone]').value = o.dataset.zone; document.querySelector('[name=postalCode]').value = o.dataset.pc;
            window.__picked = (window.__picked || 0) + 1;
            list.hidden = true;
          });
          a1.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
        }
      </script>`;
  }

  function bigwCheckout() {
    // (collectOnly: "Home delivery" greyed out; Click & Collect: "Choose a store" opens its store finder — a postcode,
    //  Search, a store's "Select" — then your name and phone, "Continue to payment".)
    const co = !!shopOf('bigw').collectOnly;
    return `<h1>Secure checkout</h1>
      <section id="b-contact"><h2>1. Contact details</h2>
        <label>Email address <input name="email" type="email" required></label>
        <p><button type="button" id="b-guest">Continue as guest</button> or <a href="#" id="b-signin">Sign in</a></p></section>
      <section id="b-delivery" hidden><h2>2. Delivery</h2><p>How would you like to get your order?</p>
        <button type="button" class="choice" id="b-home" aria-pressed="false"${co ? ' disabled' : ''}>Home delivery${co ? ' — Not available for this order' : ''}</button>
        <button type="button" class="choice" id="b-cc" aria-pressed="false">Click &amp; Collect</button>
        <div id="b-cc-sec" hidden>${storeFinder('bigw', { opener: 'Choose a store', box: 'Postcode or suburb', go: 'Search', pick: 'Select' })}
          <label>First name <input name="ccFirstName" autocomplete="given-name"></label>
          <label>Last name <input name="ccLastName" autocomplete="family-name"></label>
          <label>Phone number <input name="ccPhone" type="tel" autocomplete="tel"></label>
          <p><button type="button" id="b-cc-next">Continue to payment</button></p></div>
        <div id="b-address" hidden>
          <label>First name <input name="firstName" required></label>
          <label>Last name <input name="lastName" required></label>
          <label>Phone number <input name="phone" type="tel" required></label>
          <label for="b-lookup">Start typing your address</label><input id="b-lookup" name="addressSearch" placeholder="Start typing your address">
          <p><a href="#" id="b-manual">Enter address manually</a></p>
          <div id="b-manual-fields" hidden>
            <label>Street address <input name="street"></label>
            <label>Unit / apartment (optional) <input name="unit"></label>
            <label>Suburb <input name="suburb"></label>
            <label>State <select name="state">${STATES}</select></label>
            <label>Postcode <input name="postcode" maxlength="4"></label>
          </div>
          <p><button type="button" id="b-to-payment">Continue to payment</button></p>
        </div></section>
      <section id="b-payment" hidden><h2>3. Payment</h2><p>Credit or debit card</p>${cardBoxes('stripe')}
        <p>Total: $${(total('bigw') + 9).toFixed(2)}</p><p><button type="button" id="b-place">Place order</button></p></section>
      <p id="b-error" class="err"></p>
      <script>
        const $ = (id) => document.getElementById(id);
        const post = (step, data) => fetch('/bigw/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step, data }) });
        const vals = (sec) => Object.fromEntries([...sec.querySelectorAll('input,select')].filter((i) => i.name).map((i) => [i.name, i.value]));
        $('b-guest').addEventListener('click', () => {
          const email = document.querySelector('[name=email]').value;
          if (!email) { $('b-error').textContent = 'Enter your email address'; return; }
          $('b-error').textContent = '';
          post('contact', { email });
          $('b-contact').querySelector('p').remove();
          setTimeout(() => { $('b-delivery').hidden = false; }, 300);
        });
        $('b-home').addEventListener('click', () => { $('b-home').setAttribute('aria-pressed', 'true'); $('b-cc').setAttribute('aria-pressed', 'false'); post('method', { method: 'home' }); setTimeout(() => { $('b-address').hidden = false; }, 200); });
        $('b-cc').addEventListener('click', () => { $('b-cc').setAttribute('aria-pressed', 'true'); $('b-home').setAttribute('aria-pressed', 'false'); post('method', { method: 'collect' }); $('b-address').hidden = true; $('b-cc-sec').hidden = false; });
        $('b-cc-next').addEventListener('click', () => {
          const d = vals($('b-cc-sec'));
          const missing = (window.__store ? [] : ['store']).concat(['ccFirstName', 'ccLastName', 'ccPhone'].filter((k) => !d[k]));
          if (missing.length) { $('b-error').textContent = 'Please complete: ' + missing.join(', '); return; }
          $('b-error').textContent = '';
          post('collect', { ...d, store: window.__store });
          $('b-cc-next').remove();
          setTimeout(() => { $('b-payment').hidden = false; }, 300);
        });
        $('b-manual').addEventListener('click', (e) => { e.preventDefault(); $('b-manual-fields').hidden = false; $('b-lookup').closest('label')?.remove(); $('b-lookup').remove(); });
        $('b-to-payment').addEventListener('click', () => {
          const d = vals($('b-address'));
          const missing = ['firstName', 'lastName', 'phone', 'street', 'suburb', 'state', 'postcode'].filter((k) => !d[k]);
          if (missing.length) { $('b-error').textContent = 'Please complete: ' + missing.join(', '); return; }
          $('b-error').textContent = '';
          post('address', d);
          $('b-to-payment').remove();
          setTimeout(() => { $('b-payment').hidden = false; }, 300);
        });
        $('b-place').addEventListener('click', async () => {
          const d = await (await fetch('/bigw/checkout/place', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json().catch(() => ({}));
          if (d.bank) { ${bankJs()}; return; }
          location.href = '/bigw/checkout/confirmation';
        });
      </script>`;
  }

  // -------------------------------------------------------------------- The Gamesmen (Magento)
  // Its product page, as Magento's Luma theme draws one: the price box, its item code, "Add to Cart"
  // (or "Pre-order") posting to the cart by AJAX — then "You added … to your shopping cart.", the mini
  // cart's count up and its block open with "Proceed to Checkout". Sold out: "Out of stock", no button.
  function magentoProductPage(p) {
    const orderable = p.status === 'in_stock' || p.status === 'preorder';
    const label = p.status === 'preorder' ? 'Pre-order' : 'Add to Cart';
    const other = shopOf('gamesmen').products.find((x) => x.sku !== p.sku && x.listed);
    return page('gamesmen', `${p.name} | The Gamesmen`, `<div class="page messages"><div id="mg-messages" role="alert" class="messages"></div></div>
      <div class="product-info-main"><h1 class="page-title"><span class="base" data-ui-id="page-title-wrapper">${esc(p.name)}</span></h1>
        <div class="price-box price-final_price" data-role="priceBox" data-product-id="${p.id}"><span class="price-container"><span data-price-amount="${p.price}" data-price-type="finalPrice" class="price-wrapper"><span class="price">$${p.price.toFixed(2)}</span></span></span></div>
        <div class="product attribute sku"><strong class="type">Item Code:</strong> <div class="value" itemprop="sku">${esc(p.code || p.id)}</div></div>
        <div class="stock ${orderable ? 'available' : 'unavailable'}" title="Availability"><span>${orderable ? (p.status === 'preorder' ? 'Pre-order' : 'In stock') : 'Out of stock'}</span></div>
        ${orderable ? `<form data-product-sku="${esc(p.code || '')}" action="/gamesmen/checkout/cart/add/" method="post" id="product_addtocart_form"><input type="hidden" name="product" value="${p.id}">
          <div class="field qty"><label class="label" for="qty"><span>Qty</span></label> <input type="number" name="qty" id="qty" min="0" value="1" title="Qty" class="input-text qty" style="width:60px"></div>
          <div class="actions"><button type="submit" title="${label}" class="action primary tocart" id="product-addtocart-button"><span>${label}</span></button></div></form>` : ''}
      </div>
      <div class="block related"><strong class="block-title">Related Products</strong>${other ? `<ol class="products list items product-items"><li class="item product product-item"><a class="product-item-link" href="${pathFor('gamesmen', other)}">${esc(other.name)}</a> <button type="button" class="action tocart primary"><span>Add to Cart</span></button></li></ol>` : ''}</div>
      <script>
        document.getElementById('product_addtocart_form')?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const b = document.getElementById('product-addtocart-button');
          const label = b.querySelector('span');
          b.disabled = true; label.textContent = 'Adding...';
          const r = await fetch('/gamesmen/checkout/cart/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: ${JSON.stringify(p.sku)}, qty: Number(document.getElementById('qty').value || 1) }) });
          const d = await r.json();
          b.disabled = false; label.textContent = ${JSON.stringify(label)};
          const msg = document.getElementById('mg-messages');
          if (!d.ok) { msg.innerHTML = '<div class="message-error error message"><div>The requested qty is not available</div></div>'; return; }
          const c = document.querySelector('.minicart-wrapper .counter.qty');
          c.classList.remove('empty'); c.querySelector('.counter-number').textContent = String(d.items);
          document.querySelector('#minicart .count').textContent = String(d.items);
          msg.innerHTML = '<div class="message-success success message"><div>You added ' + ${JSON.stringify(esc(p.name))} + ' to your <a href="/gamesmen/checkout/cart/">shopping cart</a>.</div></div>';
          document.getElementById('minicart').classList.add('open');
        });
      </script>`, { head: ldFor(p, 'gamesmen'), bagCount: bagCount('gamesmen') });
  }

  // Its search page (/catalogsearch/result/?q=…): The Gamesmen's own tiles (its Hyvä theme, copied from
  // its real page, Oct 2026) — a div[data-ga-type="product-list-item"] each, the link round the whole
  // tile, the name in .product-card-title, the price shown (its data-price leaves GST out), an old one
  // struck through, "Add to Cart" or "Pre-Order". Like the real one, its data-dimension10 says "Out of
  // stock" whatever the stock, and every button's data-name/data-price are another product's.
  function magentoSearchPage(q) {
    const hits = searchHits('gamesmen', q);
    const tile = (x, i) => {
      const orderable = x.status === 'in_stock' || x.status === 'preorder';
      const pre = x.status === 'preorder';
      const href = `${url}${pathFor('gamesmen', x)}`;
      return `<div data-ga-type="product-list-item"><a href="${href}" data-id="POS-${x.id}" data-name="${esc(x.name)}" data-price="${(x.price / 1.1).toFixed(2)}" data-currency="AUD" data-dimension10="Out of stock" data-event="select_item" data-position="${i + 1}">
        <div class="flex flex-row justify-between w-full h-full p-2 bg-white rounded-lg"><div class="flex flex-col w-2/5 xl:w-1/2 p-2"><div class="relative aspect-1-1">
          <img class="absolute w-full h-full object-contain" alt="${esc(x.name)} (Image 1)" title="${esc(x.name)}" src="${imagePath('gamesmen', x)}" width="360" height="360" loading="lazy"></div></div>
        <div class="relative flex flex-col w-3/5 xl:w-1/2 m-2"><h3 class="text-sm font-medium product-card-title max-h-18 md:text-base">${esc(x.name)}</h3>
          <div class="text-sm mb-2 lg:mb-4"><div>${pre ? '<span class="text-blue-500 font-medium">Pre-Order</span><p class="text-blue-500 text-xs md:text-sm">Due November 2026</p>'
    : orderable ? '<span class="text-green-500"><span class="font-medium">Delivery</span></span> <span class="text-green-500"><span class="font-medium">In-Store</span></span>'
      : '<span class="text-neutral-300"><span class="font-medium line-through">Delivery</span></span>'}</div></div>
          <div><span class="text-base font-medium text-black md:text-xl mr-2">$${x.price.toFixed(2)}</span>${x.was ? `<span class="text-xs md:text-sm line-through text-gray-400 mr-2">$${x.was.toFixed(2)}</span>` : ''}</div>
          <div class="flex flex-col flex-grow justify-end items-end py-1"><div class="flex flex-wrap justify-end items-center gap-2">${orderable
    ? `<form method="post" class="product_addtocart_form" action="${url}/gamesmen/checkout/cart/add/uenc/aHR0cHM6Ly93d3cuZ2FtZXNtZW4uY29tLmF1/product/${x.id}/"><input name="form_key" type="hidden" value="wGWd9185HyMzbsTZ"><input type="hidden" name="product" value="${x.id}">
              <button type="submit" title="${pre ? 'Pre-Order' : 'Add to Cart'}" class="button w-auto h-full shadow-md product-list-addtocart " data-id="POS-256394" data-name="Bandai Pokemon Meowth Quick!! Model Kit" data-price="13.59" data-dimension10="Out of stock" data-event="add_to_cart"><span>${pre ? 'Pre-Order' : 'Add to Cart'}</span></button></form>`
    : '<span class="text-sm text-neutral-500 font-medium">Out of Stock</span>'}
            <button type="button" data-add-label="Add to Wish List ${esc(x.name)}" title="Add to Wish List ${esc(x.name)}" class="p-0"><span class="sr-only">Add to Wish List</span></button></div></div></div></div></a></div>`;
    };
    // (searchProvider: its menu's links look like product links — /<name>, like its products — and the
    // results are drawn a moment after the page has loaded, by a search provider's own code, in its
    // own tiles: no Magento product-item at all.)
    if (shopOf('gamesmen').searchProvider) {
      const card = (x) => `<div class="kuProd"><a class="kuName" href="${pathFor('gamesmen', x)}">${esc(x.name)}</a>
        <img src="${imagePath('gamesmen', x)}" alt="${esc(x.name)}" width="200"><div class="kuSalePrice">$${x.price.toFixed(2)}</div>
        ${x.status === 'in_stock' || x.status === 'preorder' ? `<button type="button" class="kuAddtocart">${x.status === 'preorder' ? 'Pre-order' : 'Add to cart'}</button>` : '<span class="kuOutOfStock">Out of stock</span>'}</div>`;
      return page('gamesmen', `Search results for: '${q}'`, `<nav class="navigation" role="navigation"><ul>
          <li><a href="/gamesmen/pokemon-trading-card-game">Pokemon Trading Card Game</a></li><li><a href="/gamesmen/one-piece-card-game">One Piece Card Game</a></li>
          <li><a href="/gamesmen/trading-card-accessories">Trading Card Accessories</a></li></ul></nav>
        <h1 class="page-title"><span class="base">Search results for: '${esc(q)}'</span></h1><div id="ku-search-results"></div>
        <script>setTimeout(() => { document.getElementById('ku-search-results').innerHTML = ${JSON.stringify(hits.length ? `<div class="kuResults">${hits.map(card).join('')}</div>` : '<div class="kuNoResults">No results</div>')}; }, 2500);</script>`, { bagCount: bagCount('gamesmen') });
    }
    return page('gamesmen', `Search results for: '${q}'`, `<h1 class="page-title"><span class="base">Search results for: '${esc(q)}'</span></h1>${hits.length
      ? `<div class="products wrapper mode-grid products-grid"><div class="mx-auto pt-4 pb-12 grid gap-2 grid-cols-1 xl:grid-cols-2">${hits.map(tile).join('')}</div></div>`
      : '<div class="message notice"><div>Your search returned no results.</div></div>'}`, { bagCount: bagCount('gamesmen') });
  }

  // Its cart (/checkout/cart/): a row per thing with "Remove item" (Magento's data-post link: a form
  // posted, a new page), and "CHECKOUT".
  function magentoCart() {
    const S = shopOf('gamesmen');
    S.bagViews.push(bagCount('gamesmen'));
    const rows = S.cart.map((c) => {
      const p = find('gamesmen', c.sku);
      return `<tbody class="cart item"><tr class="item-info"><td class="col item"><strong class="product-item-name"><a href="${p ? pathFor('gamesmen', p) : '#'}">${esc(c.name)}</a></strong></td>
        <td class="col price"><span class="price">$${c.price.toFixed(2)}</span></td><td class="col qty"><input class="input-text qty" title="Qty" value="${c.qty}" style="width:60px"></td>
        <td class="col subtotal"><span class="price">$${(c.price * c.qty).toFixed(2)}</span></td></tr>
        <tr class="item-actions"><td colspan="4"><div class="actions-toolbar"><a class="action action-edit" href="${p ? pathFor('gamesmen', p) : '#'}" title="Edit item parameters"><span>Edit</span></a>
          <a href="#" title="Remove item" class="action action-delete" data-post='${JSON.stringify({ action: '/gamesmen/checkout/cart/delete/', data: { sku: c.sku } })}'><span>Remove item</span></a></div></td></tr></tbody>`;
    }).join('');
    return page('gamesmen', 'Shopping Cart', `<h1 class="page-title"><span class="base">Shopping Cart</span></h1>${S.cart.length
      ? `<form id="form-validate" class="form form-cart"><table id="shopping-cart-table" class="cart items data table">${rows}</table></form>
        <div class="cart-summary"><strong class="summary title">Summary</strong><p>Order Total <span class="price">$${total('gamesmen').toFixed(2)}</span></p>
        <ul class="checkout methods items checkout-methods-items"><li class="item"><button type="button" data-role="proceed-to-checkout" title="Proceed to Checkout" class="action primary checkout" onclick="location.href='/gamesmen/checkout/'"><span>CHECKOUT</span></button></li></ul></div>`
      : '<div class="cart-empty"><p>You have no items in your shopping cart.</p><p>Click <a href="/gamesmen/">here</a> to continue shopping.</p></div>'}
      <script>
        // Magento's data-post: a form posted to the address it names.
        document.addEventListener('click', (e) => {
          const a = e.target.closest('[data-post]');
          if (!a) return;
          e.preventDefault();
          const d = JSON.parse(a.getAttribute('data-post'));
          const f = document.createElement('form'); f.method = 'post'; f.action = d.action;
          for (const [k, v] of Object.entries(d.data)) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.append(i); }
          document.body.append(f); f.submit();
        });
      </script>`, { bagCount: bagCount('gamesmen') });
  }

  // Its one-page checkout, as the real one goes: Shipping Address (signed in: the address saved in your
  // account, no boxes), "I have a different billing address" (unticked), Shipping Methods (a table:
  // Standard, Express — or, noStandard, couriers only), Payment Method (Credit card: Braintree-style card
  // fields, a frame per box, from another address; PayPal; Afterpay), the terms box, "CONFIRM AND PAY".
  function magentoCheckout() {
    const S = shopOf('gamesmen');
    const signed = !!state.signedIn.gamesmen;
    const regions = [['569', 'Australian Capital Territory'], ['570', 'New South Wales'], ['571', 'Northern Territory'], ['572', 'Queensland'], ['573', 'South Australia'], ['574', 'Tasmania'], ['575', 'Victoria'], ['576', 'Western Australia']];
    const field = (name, label, attrs = '') => `<div class="field _required"><label class="label" for="sa-${name}"><span>${label}</span></label><div class="control"><input class="input-text" type="text" name="${name}" id="sa-${name}" aria-required="true"${attrs}></div></div>`;
    const address = signed
      ? '<div class="shipping-address-items"><div class="shipping-address-item selected-item">Ash Ketchum<br>1 Pallet Town Rd<br>Sydney, New South Wales 2000<br>Australia<br><a href="tel:0412345678">0412345678</a></div></div>'
      : `<form class="form form-shipping-address" id="co-shipping-form">
          <div class="field required"><label class="label" for="customer-email"><span>Email Address</span></label><div class="control"><input class="input-text" type="email" name="username" id="customer-email" autocomplete="email" aria-required="true"></div></div>
          ${field('firstname', 'First Name')}${field('lastname', 'Last Name')}${field('street[0]', 'Street Address')}${field('city', 'Suburb')}
          <div class="field _required"><label class="label" for="sa-region_id"><span>State/Territory</span></label><div class="control"><select class="select" name="region_id" id="sa-region_id" aria-required="true"><option value="">Please select a region, state or province.</option>${regions.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div></div>
          ${field('postcode', 'Postcode')}
          <div class="field _required"><label class="label" for="sa-country_id"><span>Country</span></label><div class="control"><select class="select" name="country_id" id="sa-country_id" aria-required="true"><option value="AU" selected>Australia</option><option value="NZ">New Zealand</option></select></div></div>
          ${field('telephone', 'Mobile / Phone Number', ' autocomplete="tel"')}
        </form>`;
    // (collectOnly: only its store pick-up, nothing chosen.)
    const methods = S.collectOnly ? [['pickup', 'Store Pickup', 'Click & Collect — The Gamesmen Melbourne', 0]]
      : S.noStandard ? [['courier', 'Courier', 'Couriers Please', 12.95], ['express', 'Express', 'StarTrack', 18.95]] : [['standard', 'Standard', 'Australia Post', 9.95], ['express', 'Express', 'Australia Post', 14.95]];
    const box = (f, label) => `<div class="field"><label class="label" for="braintree-${f}"><span>${label}</span></label><div class="control hosted-control" id="braintree-${f}"><iframe src="${cardOrigin}/hosted-field?field=${f}" name="braintree-hosted-field-${f}" title="Secure Credit Card Frame - ${label}" width="300" height="40" style="border:1px solid #ccc"></iframe></div></div>`;
    return `<h1 class="page-title"><span class="base">Checkout</span></h1><div class="opc-wrapper one-step-checkout">
      <div class="checkout-shipping-address"><div class="step-title" data-role="title">Shipping Address</div>${address}
        <div class="field choice"><input type="checkbox" name="billing_different" id="billing-different" class="checkbox"${S.billingTicked ? ' checked' : ''}><label class="label" for="billing-different"><span>I have a different billing address</span></label></div>
        <div id="billing-fields"${S.billingTicked ? '' : ' hidden'}><div class="step-title">Billing Address</div><div class="field"><label class="label" for="ba-street"><span>Billing Street Address</span></label><input class="input-text" name="billing_street" id="ba-street"></div></div></div>
      <div class="checkout-shipping-method"><div class="step-title" data-role="title">Shipping Methods</div>
        <table class="table-checkout-shipping-method"><tbody>${methods.map(([id, m, carrier, price]) => `<tr class="row"><td class="col col-method"><input type="radio" class="radio" name="shipping_method" value="${id}" id="s_method_${id}" aria-labelledby="label_method_${id} label_carrier_${id}" data-price="${price}"></td>
          <td class="col col-price"><span class="price">$${price.toFixed(2)}</span></td><td class="col col-method" id="label_method_${id}">${m}</td><td class="col col-carrier" id="label_carrier_${id}">${carrier}</td></tr>`).join('')}</tbody></table></div>
      <div class="checkout-payment-method"><div class="step-title" data-role="title">Payment Method</div>
        <div class="payment-method"><div class="payment-method-title field choice"><input type="radio" name="payment[method]" class="radio" id="braintree" value="braintree"><label class="label" for="braintree"><span>Credit card</span></label></div>
          <div class="payment-method-content" id="cc-fields" hidden>${box('number', 'Card number')}${box('expirationDate', 'Expiry Date')}${box('cvv', 'Security code')}</div></div>
        <div class="payment-method"><div class="payment-method-title field choice"><input type="radio" name="payment[method]" class="radio" id="paypal_express" value="paypal_express"><label class="label" for="paypal_express"><span>PayPal</span></label></div></div>
        <div class="payment-method"><div class="payment-method-title field choice"><input type="radio" name="payment[method]" class="radio" id="afterpay" value="afterpay"><label class="label" for="afterpay"><span>Afterpay</span></label></div></div></div>
      <div class="opc-block-summary"><span class="title">Order Summary</span><p>Cart Subtotal <span class="price">$${total('gamesmen').toFixed(2)}</span></p><p>Shipping <span class="price" id="mg-ship">—</span></p><p class="grand totals">Order Total <strong><span class="price" id="mg-total">$${total('gamesmen').toFixed(2)}</span></strong></p></div>
      <div class="checkout-agreements"><div class="checkout-agreement field choice required"><input type="checkbox" id="agreement_1" name="agreement[1]" value="1" required class="required-entry"><label class="label" for="agreement_1"><span>I agree to the Terms and Conditions and the Refund and Cancellation policy.</span></label></div></div>
      <input type="hidden" id="cc-number"><input type="hidden" id="cc-exp"><input type="hidden" id="cc-cvv">
      <div class="actions-toolbar"><button type="button" id="mg-place" class="action primary checkout" title="CONFIRM AND PAY"><span>CONFIRM AND PAY</span></button></div>
      <div id="mg-error" class="message message-error error" style="display:none"></div></div>
      <script>
        const $ = (id) => document.getElementById(id);
        const sub = ${total('gamesmen')};
        addEventListener('message', (e) => { const m = { number: 'cc-number', expirationDate: 'cc-exp', cvv: 'cc-cvv' }[e.data && e.data.hostedField]; if (m) $(m).value = e.data.value; });
        for (const r of document.querySelectorAll('input[name=shipping_method]')) r.addEventListener('change', () => { const p = Number(r.dataset.price); $('mg-ship').textContent = '$' + p.toFixed(2); $('mg-total').textContent = '$' + (sub + p).toFixed(2); });
        for (const r of document.querySelectorAll('input[name="payment[method]"]')) r.addEventListener('change', () => { $('cc-fields').hidden = r.value !== 'braintree'; });
        $('billing-different').addEventListener('change', (e) => { $('billing-fields').hidden = !e.target.checked; });
        $('mg-place').addEventListener('click', async () => {
          const err = (t) => { $('mg-error').textContent = t; $('mg-error').style.display = 'block'; $('mg-error').setAttribute('role', 'alert'); };
          const v = (n) => (document.querySelector('[name="' + n + '"]') || {}).value || '';
          const ship = document.querySelector('input[name=shipping_method]:checked');
          const pay = document.querySelector('input[name="payment[method]"]:checked');
          const address = ${signed ? 'null' : "{ email: v('username'), firstname: v('firstname'), lastname: v('lastname'), street: v('street[0]'), city: v('city'), region: (document.getElementById('sa-region_id').selectedOptions[0] || {}).textContent, postcode: v('postcode'), country: v('country_id'), telephone: v('telephone') }"};
          if (address && Object.values(address).some((x) => !x || /^Please select/.test(x))) return err('This is a required field.');
          if (!ship) return err('The shipping method is missing. Select the shipping method and try again.');
          if (!pay) return err('Please specify a payment method.');
          if (pay.value === 'braintree' && !($('cc-number').value && $('cc-exp').value && $('cc-cvv').value)) return err('Please enter your card details.');
          if (!$('agreement_1').checked) return err('This is a required field.');
          const r = await fetch('/gamesmen/checkout/place', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            address, signed: ${signed}, shipping: ship.value, payment: pay.value, billingDifferent: $('billing-different').checked, agreed: $('agreement_1').checked,
            card: { number: $('cc-number').value, expiry: $('cc-exp').value, cvv: $('cc-cvv').value } }) });
          const d = await r.json();
          if (d.bank) { ${bankJs()}; return; }
          if (!d.ok) return err(d.error || 'Something went wrong.');
          location.href = '/gamesmen/checkout/onepage/success/';
        });
      </script>`;
  }

  // -------------------------------------------------------------------- Games World (WooCommerce)
  const wooId = (p) => p.id;
  // Its product page: the add-to-cart form (posted: the page again, "“…” has been added to your cart."
  // with "View cart"), or "Out of stock". Pre-orders say "Pre-order now".
  function wooProductPage(p, notice = '') {
    const orderable = p.status === 'in_stock' || p.status === 'preorder';
    const label = p.status === 'preorder' ? 'Pre-order now' : 'Add to cart';
    return page('gamesworld', `${p.name} – Games World`, `<div class="woocommerce-notices-wrapper">${notice}</div>
      <div class="product type-product ${orderable ? 'instock' : 'outofstock'}"><div class="summary entry-summary"><h1 class="product_title entry-title">${esc(p.name)}</h1>
        <p class="price"><span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol">$</span>${p.price.toFixed(2)}</bdi></span></p>
        ${orderable ? `<p class="stock in-stock">${p.status === 'preorder' ? 'Available on backorder' : '3 in stock'}</p>
          <form class="cart" action="${pathFor('gamesworld', p)}" method="post" enctype="multipart/form-data"><div class="quantity"><label class="screen-reader-text" for="quantity_1">Quantity</label><input type="number" id="quantity_1" class="input-text qty text" name="quantity" value="1" min="1" style="width:60px"></div>
          <button type="submit" name="add-to-cart" value="${wooId(p)}" class="single_add_to_cart_button button alt">${label}</button></form>`
    : '<p class="stock out-of-stock">Out of stock</p>'}
      </div></div>`, { head: ldFor(p, 'gamesworld'), bagCount: bagCount('gamesworld') });
  }

  // Its cart (/cart/): a row per thing, its "×" a link (/cart/?remove_item=…: a new page, "“…” removed.
  // Undo?" — Undo never pressed), and "Proceed to checkout".
  function wooCart(notice = '') {
    const S = shopOf('gamesworld');
    S.bagViews.push(bagCount('gamesworld'));
    const rows = S.cart.map((c) => {
      const p = find('gamesworld', c.sku);
      return `<tr class="woocommerce-cart-form__cart-item cart_item"><td class="product-remove"><a href="/gamesworld/cart/?remove_item=${encodeURIComponent(c.sku)}&amp;_wpnonce=d1a2b3" class="remove" aria-label="Remove ${esc(c.name)} from cart" data-product_id="${p ? p.id : 0}">&times;</a></td>
        <td class="product-name"><a href="${p ? pathFor('gamesworld', p) : '#'}">${esc(c.name)}</a></td><td class="product-price"><span class="amount">$${c.price.toFixed(2)}</span></td>
        <td class="product-quantity"><input type="number" class="input-text qty text" value="${c.qty}" aria-label="Product quantity" style="width:60px"></td><td class="product-subtotal"><span class="amount">$${(c.price * c.qty).toFixed(2)}</span></td></tr>`;
    }).join('');
    return page('gamesworld', 'Cart – Games World', `<div class="woocommerce-notices-wrapper">${notice}</div><h1>Cart</h1>${S.cart.length
      ? `<form class="woocommerce-cart-form"><table class="shop_table shop_table_responsive cart woocommerce-cart-form__contents"><tbody>${rows}</tbody></table></form>
        <div class="cart-collaterals"><div class="cart_totals"><h2>Cart totals</h2><p>Total <span class="amount">$${total('gamesworld').toFixed(2)}</span></p>
        <div class="wc-proceed-to-checkout"><a href="/gamesworld/checkout/" class="checkout-button button alt wc-forward">Proceed to checkout</a></div></div></div>`
      : '<div class="wc-empty-cart-message"><div class="cart-empty woocommerce-info" role="status">Your cart is currently empty.</div></div><p class="return-to-shop"><a class="button wc-backward" href="/gamesworld/">Return to shop</a></p>'}`, { bagCount: bagCount('gamesworld') });
  }

  // Its checkout, as the real one goes: Billing details (country and state drawn over by selectWoo's
  // own drop-downs — the real ones hidden), "Deliver to a different address?" (ticked: shipToDifferent),
  // its shipping methods (Standard chosen), Stripe's card form (one frame from another address: card
  // number, expiration date, security code — or, link, Link's saved card and its Confirm), PayPal,
  // Afterpay, Zip, "Place order". Signed in (state.signedIn.gamesworld): your saved details already in.
  function wooCheckout() {
    const S = shopOf('gamesworld');
    const signed = !!state.signedIn.gamesworld;
    const A = signed ? { email: 'ash.gw@example.com', first_name: 'Ash', last_name: 'Ketchum', address_1: '1 Pallet Town Rd', city: 'Sydney', state: 'NSW', postcode: '2000', phone: '0412345678' } : {};
    const states = [['ACT', 'Australian Capital Territory'], ['NSW', 'New South Wales'], ['NT', 'Northern Territory'], ['QLD', 'Queensland'], ['SA', 'South Australia'], ['TAS', 'Tasmania'], ['VIC', 'Victoria'], ['WA', 'Western Australia']];
    const input = (sec, key, label, ac, type = 'text') => `<p class="form-row validate-required" id="${sec}_${key}_field"><label for="${sec}_${key}" class="required_field">${label}&nbsp;<span class="required">*</span></label>
      <span class="woocommerce-input-wrapper"><input type="${type}" class="input-text" name="${sec}_${key}" id="${sec}_${key}" value="${sec === 'billing' && A[key] ? esc(A[key]) : ''}" aria-required="true" autocomplete="section-${sec} ${sec} ${ac}"></span></p>`;
    const select = (sec, key, label, ac, opts, chosen) => `<p class="form-row validate-required" id="${sec}_${key}_field"><label for="${sec}_${key}" class="required_field">${label}&nbsp;<span class="required">*</span></label>
      <span class="woocommerce-input-wrapper"><select name="${sec}_${key}" id="${sec}_${key}" class="${key === 'country' ? 'country_to_state country_select' : 'state_select'} select2-hidden-accessible" aria-required="true" autocomplete="section-${sec} ${sec} ${ac}" tabindex="-1" aria-hidden="true">${opts.map(([v, t]) => `<option value="${v}"${v === chosen ? ' selected' : ''}>${t}</option>`).join('')}</select><span class="select2 select2-container select2-container--default" dir="ltr" style="width:320px"><span class="selection"><span class="select2-selection select2-selection--single" role="combobox" aria-labelledby="select2-${sec}_${key}-container"><span class="select2-selection__rendered" id="select2-${sec}_${key}-container">${(opts.find(([v]) => v === chosen) || opts[0])[1]}</span><span class="select2-selection__arrow" role="presentation">▾</span></span></span></span></span></p>`;
    const section = (sec) => `${sec === 'billing' ? input(sec, 'email', 'Email address', 'email', 'email') : ''}${input(sec, 'first_name', 'First name', 'given-name')}${input(sec, 'last_name', 'Last name', 'family-name')}
      <p class="form-row" id="${sec}_company_field"><label for="${sec}_company">Company name&nbsp;<span class="optional">(optional)</span></label><span class="woocommerce-input-wrapper"><input type="text" class="input-text" name="${sec}_company" id="${sec}_company" autocomplete="section-${sec} ${sec} organization"></span></p>
      ${select(sec, 'country', 'Country/Region', 'country', [['', 'Select a country / region…'], ['AU', 'Australia'], ['NZ', 'New Zealand']], 'AU')}
      ${input(sec, 'address_1', 'Street address', 'address-line1')}
      <p class="form-row" id="${sec}_address_2_field"><label for="${sec}_address_2" class="screen-reader-text">Flat, suite, unit, etc.&nbsp;<span class="optional">(optional)</span></label><span class="woocommerce-input-wrapper"><input type="text" class="input-text" name="${sec}_address_2" id="${sec}_address_2" placeholder="Apartment, suite, unit, etc. (optional)" autocomplete="section-${sec} ${sec} address-line2"></span></p>
      ${input(sec, 'city', 'Suburb', 'address-level2')}${select(sec, 'state', 'State', 'address-level1', [['', 'Select an option…'], ...states], sec === 'billing' ? A.state || '' : '')}${input(sec, 'postcode', 'Postcode', 'postal-code')}${input(sec, 'phone', 'Phone', 'tel', 'tel')}`;
    return `<style>.select2-hidden-accessible{border:0!important;clip:rect(0 0 0 0)!important;height:1px!important;margin:-1px!important;overflow:hidden!important;padding:0!important;position:absolute!important;width:1px!important}.select2-selection{display:inline-block;border:1px solid #aaa;padding:6px;min-width:300px;background:#fff}</style>
      <div class="woocommerce-notices-wrapper"></div><h1>Checkout</h1>
      <form name="checkout" method="post" class="checkout woocommerce-checkout" id="wc-checkout" novalidate>
        <div class="col2-set" id="customer_details"><div class="col-1"><div class="woocommerce-billing-fields"><h3>Billing details</h3><div class="woocommerce-billing-fields__field-wrapper">${section('billing')}</div></div>
          <p class="form-row" id="kl_newsletter_checkbox_field"><label class="checkbox"><input type="checkbox" name="kl_newsletter_checkbox" id="kl_newsletter_checkbox" value="1" class="input-checkbox"> Sign me up to receive email updates and news&nbsp;<span class="optional">(optional)</span></label></p></div>
          <div class="col-2"><div class="woocommerce-shipping-fields"><h3 id="ship-to-different-address"><label class="woocommerce-form__label woocommerce-form__label-for-checkbox checkbox"><input id="ship-to-different-address-checkbox" class="woocommerce-form__input woocommerce-form__input-checkbox input-checkbox"${S.shipToDifferent ? ' checked' : ''} type="checkbox" name="ship_to_different_address" value="1"> <span>Deliver to a different address?</span></label></h3>
            <div class="shipping_address"${S.shipToDifferent ? '' : ' style="display:none"'}>${section('shipping')}</div></div>
            <div class="woocommerce-additional-fields"><h3>Additional information</h3><p class="form-row notes"><label for="order_comments">Order notes&nbsp;<span class="optional">(optional)</span></label><textarea name="order_comments" id="order_comments" class="input-text" placeholder="Notes about your order, e.g. special notes for delivery." rows="2"></textarea></p></div></div></div>
        <h3 id="order_review_heading">Your order</h3>
        <div id="order_review" class="woocommerce-checkout-review-order"><table class="shop_table woocommerce-checkout-review-order-table"><tbody>${shopOf('gamesworld').cart.map((c) => `<tr class="cart_item"><td class="product-name">${esc(c.name)}&nbsp;<strong class="product-quantity">×&nbsp;${c.qty}</strong></td><td class="product-total"><span class="amount">$${(c.price * c.qty).toFixed(2)}</span></td></tr>`).join('')}</tbody>
          <tfoot><tr class="woocommerce-shipping-totals shipping"><th>Shipping</th><td data-title="Shipping"><ul id="shipping_method" class="woocommerce-shipping-methods">
            ${S.collectOnly
    // (collectOnly: only its pick-up method, nothing chosen.)
    ? '<li><input type="radio" name="shipping_method[0]" data-index="0" id="shipping_method_0_local_pickup3" value="local_pickup:3" class="shipping_method" data-price="0"><label for="shipping_method_0_local_pickup3">Local pickup: Games World Melbourne</label></li>'
    : `<li><input type="radio" name="shipping_method[0]" data-index="0" id="shipping_method_0_table_rate821" value="table_rate:8:21" class="shipping_method" checked data-price="10"><label for="shipping_method_0_table_rate821">Standard Shipping (5-7 business days): <span class="woocommerce-Price-amount amount">$10.00</span></label></li>
            <li><input type="radio" name="shipping_method[0]" data-index="0" id="shipping_method_0_table_rate824" value="table_rate:8:24" class="shipping_method" data-price="15"><label for="shipping_method_0_table_rate824">Express Shipping (3-5 business days): <span class="woocommerce-Price-amount amount">$15.00</span></label></li>`}</ul></td></tr>
            <tr class="order-total"><th>Total</th><td><strong><span class="woocommerce-Price-amount amount" id="gw-total">$${(total('gamesworld') + (S.collectOnly ? 0 : 10)).toFixed(2)}</span></strong></td></tr></tfoot></table>
          <div id="payment" class="woocommerce-checkout-payment"><ul class="wc_payment_methods payment_methods methods">
            <li class="wc_payment_method payment_method_stripe"><input id="payment_method_stripe" type="radio" class="input-radio" name="payment_method" value="stripe" checked><label for="payment_method_stripe">Credit / Debit Card</label>
              <div class="payment_box payment_method_stripe"><fieldset id="wc-stripe-upe-form" class="wc-upe-form wc-payment-form"><div class="wc-stripe-upe-element"><iframe name="__privateStripeFrame1" title="Secure payment input frame" src="${cardOrigin}/stripe-element${S.link ? '?link=1' : ''}" width="380" height="${S.link ? 70 : 170}" style="border:0"></iframe></div></fieldset></div></li>
            <li class="wc_payment_method payment_method_ppcp-gateway"><input id="payment_method_ppcp-gateway" type="radio" class="input-radio" name="payment_method" value="ppcp-gateway"><label for="payment_method_ppcp-gateway">PayPal</label></li>
            <li class="wc_payment_method payment_method_afterpay"><input id="payment_method_afterpay" type="radio" class="input-radio" name="payment_method" value="afterpay"><label for="payment_method_afterpay">Afterpay</label></li>
            <li class="wc_payment_method payment_method_zipmoney"><input id="payment_method_zipmoney" type="radio" class="input-radio" name="payment_method" value="zipmoney"><label for="payment_method_zipmoney">Zip now, pay later</label></li></ul>
            <div class="form-row place-order"><div class="woocommerce-terms-and-conditions-wrapper"><div class="woocommerce-privacy-policy-text"><p>Your personal data will be used to process your order, as described in our privacy policy.</p></div></div>
            <input type="hidden" id="stripe-number"><input type="hidden" id="stripe-expiry"><input type="hidden" id="stripe-cvc"><input type="hidden" id="stripe-link">
            <button type="submit" class="button alt" name="woocommerce_checkout_place_order" id="place_order" value="Place order" data-value="Place order">Place order</button></div></div></div>
      </form>
      <script>
        const $ = (id) => document.getElementById(id);
        const sub = ${total('gamesworld')};
        // selectWoo: its own drop-down shows what the real (hidden) one has.
        for (const sel of document.querySelectorAll('select.select2-hidden-accessible')) sel.addEventListener('change', () => { const r = document.getElementById('select2-' + sel.id + '-container'); if (r) r.textContent = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : ''; });
        $('ship-to-different-address-checkbox').addEventListener('change', (e) => { document.querySelector('.shipping_address').style.display = e.target.checked ? '' : 'none'; });
        for (const r of document.querySelectorAll('input.shipping_method')) r.addEventListener('change', () => { $('gw-total').textContent = '$' + (sub + Number(r.dataset.price)).toFixed(2); });
        addEventListener('message', (e) => {
          const d = e.data || {};
          if (d.stripeField) $({ number: 'stripe-number', expiry: 'stripe-expiry', cvc: 'stripe-cvc' }[d.stripeField]).value = d.value;
          if (d.stripeLink) $('stripe-link').value = '1';
        });
        $('wc-checkout').addEventListener('submit', async (e) => {
          e.preventDefault();
          const notices = document.querySelector('.woocommerce-notices-wrapper');
          const err = (list) => { notices.innerHTML = '<ul class="woocommerce-error" role="alert">' + list.map((t) => '<li>' + t + '</li>').join('') + '</ul>'; };
          const v = (n) => (document.querySelector('[name="' + n + '"]') || {}).value || '';
          const different = $('ship-to-different-address-checkbox').checked;
          const need = [['billing_first_name', 'Billing First name'], ['billing_last_name', 'Billing Last name'], ['billing_country', 'Billing Country / Region'], ['billing_address_1', 'Billing Street address'], ['billing_city', 'Billing Suburb'], ['billing_state', 'Billing State'], ['billing_postcode', 'Billing Postcode'], ['billing_phone', 'Billing Phone'], ['billing_email', 'Billing Email address']]
            .concat(different ? [['shipping_first_name', 'Shipping First name'], ['shipping_address_1', 'Shipping Street address'], ['shipping_city', 'Shipping Suburb'], ['shipping_state', 'Shipping State'], ['shipping_postcode', 'Shipping Postcode']] : []);
          const missing = need.filter(([n]) => !v(n)).map(([, l]) => l + ' is a required field.');
          if (missing.length) return err(missing);
          const pay = document.querySelector('input[name=payment_method]:checked');
          if (!document.querySelector('input.shipping_method:checked')) return err(['No shipping method has been selected. Please double check your address, or contact us if you need any help.']);
          if (pay.value === 'stripe' && !$('stripe-link').value && !($('stripe-number').value && $('stripe-expiry').value && $('stripe-cvc').value)) return err(['Your card number is incomplete.']);
          const r = await fetch('/gamesworld/checkout/place', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            billing: Object.fromEntries(need.filter(([n]) => n.startsWith('billing_')).map(([n]) => [n.slice(8), v(n)])), shipToDifferent: different, newsletter: $('kl_newsletter_checkbox').checked,
            shipping: (document.querySelector('input.shipping_method:checked') || {}).value, payment: pay.value, link: !!$('stripe-link').value,
            card: { number: $('stripe-number').value, expiry: $('stripe-expiry').value, cvc: $('stripe-cvc').value }, signed: ${signed} }) });
          const d = await r.json();
          if (d.bank) { ${bankJs()}; return; }
          if (!d.ok) return err([d.error || 'Something went wrong.']);
          location.href = '/gamesworld/checkout/order-received/' + d.order + '/?key=wc_order_dummy';
        });
      </script>`;
  }

  // Its product API (/wp-json/wc/store/v1/products?search=…): what Mugibot's sweeps read — names with
  // HTML entities in them, like the real one.
  function wooStoreApi(u, host) {
    const hits = searchHits('gamesworld', u.searchParams.get('search') || '').slice().reverse();
    return hits.slice(0, Number(u.searchParams.get('per_page')) || 10).map((x) => {
      const orderable = x.status === 'in_stock' || x.status === 'preorder';
      return {
        id: x.id, name: esc(x.name).replace(/&#39;/g, '&#8217;'), slug: x.sku, permalink: `http://${host}${pathFor('gamesworld', x)}`, sku: String(x.id), type: 'simple',
        prices: { price: String(Math.round(x.price * 100)), regular_price: String(Math.round((x.was || x.price) * 100)), sale_price: String(Math.round(x.price * 100)), currency_code: 'AUD', currency_minor_unit: 2 },
        images: [{ id: 1, src: `http://${host}${imagePath('gamesworld', x)}`, thumbnail: `http://${host}${imagePath('gamesworld', x)}` }],
        is_in_stock: orderable, is_purchasable: true, is_on_backorder: x.status === 'preorder',
        stock_availability: orderable ? { text: x.status === 'preorder' ? 'Available on backorder' : '3 in stock', class: x.status === 'preorder' ? 'available-on-backorder' : 'in-stock' } : { text: 'Out of stock', class: 'out-of-stock' },
        add_to_cart: { text: orderable ? (x.status === 'preorder' ? 'Pre-order now' : 'Add to cart') : 'Read more', description: '' },
      };
    });
  }

  // -------------------------------------------------------------------- card iframe server
  const cardServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    // A whole checkout in a frame (like Global-e's, which runs Premium Bandai's): details and card.
    if (u.pathname === '/ge-checkout') {
      // Global-e's checkout (Premium Bandai's), as the real one goes: your billing details (signed in:
      // already there, and the delivery address is "Default (same as billing address)" — to pick),
      // area Australia, state drop-down, the phone after its +61, the shipping method it picked,
      // CREDIT CARD (chosen): card number, expiry month and year (drop-downs) and CVV in a frame of its
      // own, the purchase agreement box (required) → "Pay and Place Order".
      const PB = state.shops.pbandai;
      const signed = !!state.signedIn.pbandai;
      const acc = signed ? { firstName: 'Ash', lastName: 'Ketchum', email: 'ash.bandai@example.com', address1: '1 Pallet Town Rd', city: 'Sydney', zip: '2000', state: 'NSW', phone: '412345678' } : {};
      const v = (k) => (acc[k] ? ` value="${esc(acc[k])}"` : '');
      const sum = PB.cart.reduce((t, c) => t + c.price * c.qty, 0);
      const st = (sel) => `<option value="">Select</option>${['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'].map((x) => `<option value="${x}" ${sel === x ? 'selected' : ''}>${{ ACT: 'Australian Capital Territory', NSW: 'New South Wales', NT: 'Northern Territory', QLD: 'Queensland', SA: 'South Australia', TAS: 'Tasmania', VIC: 'Victoria', WA: 'Western Australia' }[x]}</option>`).join('')}`;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui;padding:8px"><h2>Secure checkout</h2>
<style>label{display:block;margin:6px 0}input:not([type=radio]):not([type=checkbox]),select{display:block;padding:6px;width:300px}.err{color:#c00}</style>
<form id="ge">
<h3>Billing Address</h3>
<label>FIRST NAME <input name="FirstName" required${v('firstName')}></label>
<label>LAST NAME <input name="LastName" required${v('lastName')}></label>
<label>E-MAIL ADDRESS <input name="Email" type="email" required${v('email')}></label>
<label>AREA <select name="CountryID"><option value="">Select</option><option value="12" selected>Australia</option><option value="153">New Zealand</option></select></label>
<label>ADDRESS LINE 1 <input name="Address1" required${v('address1')}></label>
<label>ADDRESS LINE 2 <input name="Address2"></label>
<label>CITY / SUBURB <input name="City" required${v('city')}></label>
<label>ZIP / POSTCODE <input name="Zip" required${v('zip')}></label>
<label>STATE OR PROVINCE <select name="StateOrProvinceID" required>${st(acc.state)}</select></label>
<div class="phone"><label for="ge-phone">PHONE NUMBER</label><select name="PhoneCountry" aria-label="Country code" style="width:90px;display:inline-block"><option selected>+61</option><option>+64</option></select>
  <input id="ge-phone" name="Phone1" type="tel" required style="display:inline-block;width:200px"${v('phone')}></div>
${signed ? `<h3>Delivery Address</h3>
<label><input type="radio" name="DeliveryAddress" value="default"> Default (same as billing address)</label>
<label><input type="radio" name="DeliveryAddress" value="new"> Use a different address</label>` : ''}
<h3>Shipping Method</h3>
<label><input type="radio" name="Shipping" value="std" checked> Standard Shipping AUD $15.00</label>
<label><input type="radio" name="Shipping" value="exp"> Express Shipping AUD $30.00</label>
<h3>Payment</h3>
<label><input type="radio" name="PaymentMethod" value="cc" checked> CREDIT CARD</label>
<label><input type="radio" name="PaymentMethod" value="paypal"> PayPal</label>
<iframe id="ge-card" title="Card details" src="/ge-card" width="360" height="180" style="border:1px solid #ccc"></iframe>
<p class="total">Total AUD $${(sum + 15).toFixed(2)}</p>
<label><input type="checkbox" name="Terms" required> I confirm no returns or refunds are accepted for personal circumstances. I have read and agree to <a href="#">the Purchase Agreement</a> and understand that whenever there may be an inconsistency, Premium Bandai's policy prevails over Global-e's Terms of Sale.<small>Required</small></label>
<label><input type="checkbox" name="Newsletter"> Send me news and offers by email</label>
<button type="button" id="ge-place">Pay and Place Order</button>
<p id="ge-err" class="err"></p>
</form>
<script>
const form = document.getElementById('ge');
const card = {};
addEventListener('message', (e) => { if (e.data && e.data.geCard) card[e.data.geCard] = e.data.value; });
document.getElementById('ge-place').addEventListener('click', async () => {
  const d = Object.fromEntries([...form.querySelectorAll('input,select')].filter((i) => i.name && (!/radio|checkbox/.test(i.type) || i.checked)).map((i) => [i.name, i.type === 'checkbox' ? true : i.value]));
  const missing = [...form.querySelectorAll('[required]')].filter((i) => (i.type === 'checkbox' ? !i.checked : !i.value)).map((i) => i.name);
  if (${signed ? 'true' : 'false'} && !d.DeliveryAddress) missing.push('DeliveryAddress');
  if (!(card.cardNumber && card.expMonth && card.expYear && card.cvv)) missing.push('card');
  if (missing.length) { document.getElementById('ge-err').textContent = 'Please complete: ' + missing.join(', '); return; }
  const r = await fetch('/ge-place', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...d, card }) });
  const out = await r.json();
  if (out.bank) { const d = out; ${bankJs()}; return; }
  if (out.error) { const el = document.getElementById('ge-err'); el.textContent = out.error; el.setAttribute('role', 'alert'); return; }
  document.body.insertAdjacentHTML('beforeend', '<p>Thank you for your order! Order number: GE-' + out.order + '</p>');
  parent.postMessage({ gePlaced: out.order }, '*');
});
</script></body></html>`);
      return;
    }
    // Global-e's card form: a frame of its own inside its checkout (expiry month and year are drop-downs).
    if (u.pathname === '/ge-card') {
      const years = Array.from({ length: 11 }, (_, i) => 2026 + i);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui;padding:6px">
<style>label{display:block;margin:4px 0}input,select{padding:5px}</style>
<label>CARD NUMBER <input name="cardNumber" inputmode="numeric" style="width:260px"></label>
<label for="m">EXPIRY DATE</label><select id="m" name="expMonth" aria-label="Expiry date month"><option value="">Month</option>${Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, '0')}">${String(i + 1).padStart(2, '0')}</option>`).join('')}</select>
<select name="expYear" aria-label="Expiry date year"><option value="">Year</option>${years.map((y) => `<option value="${y}">${y}</option>`).join('')}</select>
<label>CVV <input name="cvv" inputmode="numeric" style="width:80px"></label>
<script>
for (const el of document.querySelectorAll('input, select')) {
  const tell = () => parent.postMessage({ geCard: el.name, value: el.value }, '*');
  el.addEventListener('input', () => { if (el.name === 'cardNumber') el.value = el.value.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 '); tell(); });
  el.addEventListener('change', tell);
}
</script></body></html>`);
      return;
    }
    if (u.pathname === '/ge-place' && req.method === 'POST') {
      const b = await parseBody(req);
      const PB = state.shops.pbandai;
      if (PB.decline) { PB.declined = (PB.declined || 0) + 1; return json(200, { error: 'Your card was declined. Please try another card.' }); }
      const place = () => { PB.orders.push({ cart: PB.cart.slice(), form: b, ts: Date.now() }); PB.cart = []; };
      if (PB.threeDS) { PB.challenged = (PB.challenged || 0) + 1; return json(200, { bank: bankStart('pbandai', PB.threeDS, place, `/ge-done?order=${1000 + PB.orders.length + 1}`, req.headers.host) }); }
      place();
      return json(200, { order: 1000 + PB.orders.length });
    }
    if (u.pathname === '/ge-done') {
      // (Global-e's thank-you, after the bank's check: in its frame, and said to the page above.)
      const order = Number(u.searchParams.get('order')) || 0;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="font:14px system-ui"><p>Thank you for your order! Order number: GE-${order}</p><script>parent.postMessage({ gePlaced: ${order} }, '*');</script></body></html>`);
      return;
    }
    if (u.pathname === '/bank-status') {
      const x = state.bank[u.searchParams.get('id') || ''];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ approved: !!(x && x.approved), next: x ? x.next : '' }));
      return;
    }
    // Paydock's card form (Target's): card holder's name, card number, expiry (MM/YY), CVV — real typing only.
    if (u.pathname === '/paydock-widget') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui;padding:8px">
<style>label{display:block;margin:6px 0}input{display:block;padding:6px;width:300px}</style>
<label>Card holders name <input name="card_name" data-k="cardName"></label>
<label>Credit card number <input name="card_number" inputmode="numeric" data-k="cardNumber"></label>
<label>Expiry date <input name="expire" placeholder="MM/YY" data-k="cardExpiry"></label>
<label>CVV* <input name="card_ccv" inputmode="numeric" data-k="cardCvv"></label>
<script>
for (const el of document.querySelectorAll('input')) {
  let typed = '';
  el.addEventListener('input', (e) => {
    if (!e.isTrusted) { el.value = typed; return; }
    if (el.name === 'card_number') el.value = el.value.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 ');
    if (el.name === 'expire') { const d = el.value.replace(/\\D/g, '').slice(0, 4); el.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; }
    typed = el.value;
    parent.postMessage({ paydock: el.dataset.k, value: typed }, '*');
  });
}
</script></body></html>`);
      return;
    }
    // Shopify's card fields: one frame per box, keeping only real typing (like checkout.pci.shopifyinc.com's).
    if (u.pathname === '/shopify-card') {
      const f = { number: ['number', 'cc-number', 'Card number', 'numeric'], expiry: ['expiry', 'cc-exp', 'Expiration date (MM / YY)', 'numeric'], verification_value: ['verification_value', 'cc-csc', 'Security code', 'numeric'], name: ['name', 'cc-name', 'Name on card', 'text'] }[u.searchParams.get('field')] || [];
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui">
<input id="${f[0]}" name="${f[0]}" autocomplete="${f[1]}" placeholder="${f[2]}" inputmode="${f[3]}" aria-label="${f[2]}" style="display:block;padding:8px;width:260px;border:0">
<script>
const el = document.querySelector('input');
const format = (v) => {
  if (el.name === 'number') return v.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 ');
  if (el.name === 'expiry') { const d = v.replace(/\\D/g, '').slice(0, 4); return d.length > 2 ? d.slice(0, 2) + ' / ' + d.slice(2) : d; }
  if (el.name === 'verification_value') return v.replace(/\\D/g, '').slice(0, 4);
  return v;
};
let typed = '';
el.addEventListener('input', (e) => {
  if (!e.isTrusted) { el.value = typed; return; }
  el.value = format(el.value);
  typed = el.value;
  parent.postMessage({ cardField: el.name, value: typed }, '*');
});
</script></body></html>`);
      return;
    }
    // Braintree's hosted fields (The Gamesmen's card form): a frame per box, keeping only real typing.
    if (u.pathname === '/hosted-field') {
      const f = { number: ['credit-card-number', 'cc-number', 'Credit Card Number', '•••• •••• •••• ••••'], expirationDate: ['expiration', 'cc-exp', 'Expiration Date', 'MM/YY'], cvv: ['cvv', 'cc-csc', 'CVV', '•••'] }[u.searchParams.get('field')] || [];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui">
<input id="${f[0]}" name="${f[0]}" autocomplete="${f[1]}" aria-label="${f[2]}" placeholder="${f[3]}" inputmode="numeric" data-braintree-name="${u.searchParams.get('field')}" style="display:block;padding:8px;width:260px;border:0">
<script>
const el = document.querySelector('input');
const field = el.dataset.braintreeName;
const format = (v) => {
  if (field === 'number') return v.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 ');
  if (field === 'expirationDate') { const d = v.replace(/\\D/g, '').slice(0, 4); return d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; }
  return v.replace(/\\D/g, '').slice(0, 4);
};
let typed = '';
el.addEventListener('input', (e) => {
  if (!e.isTrusted) { el.value = typed; return; }
  el.value = format(el.value);
  typed = el.value;
  parent.postMessage({ hostedField: field, value: typed }, '*');
});
</script></body></html>`);
      return;
    }
    // Stripe's Payment Element (Games World's card form): one frame — card number, expiration date,
    // security code (and the country) — keeping only real typing. link=1: Stripe's Link is connected —
    // the card it has for you, and its "Confirm".
    if (u.pathname === '/stripe-element') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (u.searchParams.get('link') === '1') {
        res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui"><div class="p-Link" style="padding:8px;border:1px solid #ddd;border-radius:6px">
<b>Link</b> <span class="p-LinkCard">Visa •••• 4242</span> <span style="color:#666">ash.orders@example.com</span>
<button type="button" id="link-confirm" style="margin-left:8px">Confirm</button></div>
<script>document.getElementById('link-confirm').addEventListener('click', () => { document.getElementById('link-confirm').textContent = 'Confirmed ✓'; document.getElementById('link-confirm').disabled = true; parent.postMessage({ stripeLink: true }, '*'); });</script></body></html>`);
        return;
      }
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui">
<style>label{display:block;margin:4px 0 0;color:#30313d}input,select{display:block;padding:8px;width:300px;border:1px solid #e6e6e6;border-radius:5px}</style>
<label for="Field-numberInput">Card number</label><input id="Field-numberInput" name="number" autocomplete="cc-number" inputmode="numeric" placeholder="1234 1234 1234 1234" aria-invalid="false">
<label for="Field-expiryInput">Expiration date</label><input id="Field-expiryInput" name="expiry" autocomplete="cc-exp" inputmode="numeric" placeholder="MM / YY">
<label for="Field-cvcInput">Security code</label><input id="Field-cvcInput" name="cvc" autocomplete="cc-csc" inputmode="numeric" placeholder="CVC">
<label for="Field-countryInput">Country</label><select id="Field-countryInput" name="country" autocomplete="billing country"><option value="AU" selected>Australia</option><option value="NZ">New Zealand</option></select>
<script>
const typed = {};
const format = (name, v) => {
  if (name === 'number') return v.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 ');
  if (name === 'expiry') { const d = v.replace(/\\D/g, '').slice(0, 4); return d.length > 2 ? d.slice(0, 2) + ' / ' + d.slice(2) : d; }
  return v.replace(/\\D/g, '').slice(0, 4);
};
for (const el of document.querySelectorAll('input')) {
  typed[el.name] = '';
  el.addEventListener('input', (e) => {
    if (!e.isTrusted) { el.value = typed[el.name]; return; }
    el.value = format(el.name, el.value);
    typed[el.name] = el.value;
    parent.postMessage({ stripeField: el.name, value: el.value }, '*');
  });
}
</script></body></html>`);
      return;
    }
    if (u.pathname === '/acs/challenge') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body style="font:14px system-ui"><h3>Verify it\'s you</h3><p>Enter the code we sent to your phone.</p><input name="otp" inputmode="numeric"><button type="button">Submit</button></body></html>');
      return;
    }
    // The bank's own pages (bankJs): posted into the checkout's frame ('approve'), or the whole tab sent here
    // ('redirect', as bank.test) — waiting for you to approve it in the bank's app (store.approveBank()), then (the
    // whole tab) back to the store's confirmation.
    if (u.pathname === '/acs/status') {
      const x = state.bank[u.searchParams.get('id') || ''];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ approved: !!(x && x.approved) }));
      return;
    }
    if (u.pathname === '/acs/approve' || u.pathname === '/acs/redirect') {
      const id = String(u.searchParams.get('id') || '');
      const back = String(u.searchParams.get('back') || '');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><head><title>Dummy Bank — approve this payment</title></head><body style="font:14px system-ui;padding:12px"><h3>Dummy Bank</h3><p>Approve this payment in your Dummy Bank app.</p><p>Waiting for approval…</p>
<script>const poll = setInterval(async () => { const s = await (await fetch('/acs/status?id=${encodeURIComponent(id)}')).json(); if (!s.approved) return; clearInterval(poll); ${back ? `location.href = ${JSON.stringify(back)};` : 'if (window.opener) window.close();'} }, 500);</script></body></html>`);
      return;
    }
    if (u.pathname === '/card-frame') {
      const style = u.searchParams.get('style') || 'stripe';
      if (style === 'strict') {
        const f = { number: ['encryptedCardNumber', 'cc-number', 'Card number field', '1234 5678 9012 3456'], expiry: ['encryptedExpiryDate', 'cc-exp', 'Expiry date field', 'MM/YY'], cvc: ['encryptedSecurityCode', 'cc-csc', 'Security code field', '3 digits'] }[u.searchParams.get('field')] || [];
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui">
<input id="${f[0]}" type="text" inputmode="numeric" data-fieldtype="${f[0]}" autocomplete="${f[1]}" aria-label="${f[2]}" placeholder="${f[3]}" style="display:block;padding:8px;width:260px;border:0">
<script>
// Keeps its own copy of what was typed; anything that isn't real typing is undone.
const el = document.querySelector('input');
const format = (v) => {
  if (el.dataset.fieldtype === 'encryptedCardNumber') return v.replace(/\\D/g, '').slice(0, 16).replace(/(\\d{4})(?=\\d)/g, '$1 ');
  if (el.dataset.fieldtype === 'encryptedExpiryDate') { const d = v.replace(/\\D/g, '').slice(0, 4); return d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; }
  return v.replace(/\\D/g, '').slice(0, 4);
};
let typed = '';
let attempts = 0;
if (${JSON.stringify(u.searchParams.get('mode'))} === 'never') {
  // Takes nothing at all (counts how often something tried).
  el.addEventListener('focus', () => { attempts += 1; });
  el.addEventListener('keydown', (e) => e.preventDefault());
  el.addEventListener('beforeinput', (e) => e.preventDefault());
  el.addEventListener('input', () => { el.value = ''; });
} else if (${JSON.stringify(u.searchParams.get('mode'))} === 'keys') {
  // Only key presses count: the browser's own text insertion is blocked.
  el.addEventListener('beforeinput', (e) => e.preventDefault());
  el.addEventListener('keydown', (e) => { if (/^[0-9]$/.test(e.key)) { typed = format(typed + e.key); el.value = typed; e.preventDefault(); } });
  el.addEventListener('input', () => { el.value = typed; });
} else {
  el.addEventListener('input', (e) => {
    if (!e.isTrusted) { el.value = typed; return; }
    // 'slow': a box that takes a while with what's typed (heavy formatting), like a busy payment page.
    if (${JSON.stringify(u.searchParams.get('mode'))} === 'slow') { const t = Date.now() + 900; while (Date.now() < t) { /* busy */ } }
    el.value = format(el.value);
    typed = el.value;
    // Like Adyen: a complete card number moves you on to the next box.
    if (el.dataset.fieldtype === 'encryptedCardNumber' && typed.replace(/\\D/g, '').length === 16) parent.postMessage({ adyenNext: 'expiry' }, '*');
  });
}
</script></body></html>`);
        return;
      }
      const fields = style === 'mystery'
        // A payment widget Mugibot doesn't recognise (no names or labels it knows).
        ? '<input name="f1" inputmode="numeric"><input name="f2"><input name="f3" inputmode="numeric">'
        : style === 'kmart'
        ? '<label>Card number <input name="encryptedCardNumber" aria-label="Card number" inputmode="numeric"></label><label>Expiry <input name="encryptedExpiryDate" aria-label="Expiry date" placeholder="MM/YY"></label><label>CVV <input name="encryptedSecurityCode" aria-label="CVV" inputmode="numeric"></label>'
        : style === 'eb'
          ? '<label>Card Number <input name="cardNumber" inputmode="numeric" autocomplete="cc-number"></label><label>MM/YY <input name="expiry" placeholder="MM/YY" autocomplete="cc-exp"></label><label>CVV <input name="cvv" inputmode="numeric" autocomplete="cc-csc"></label><label>Name on Card <input name="nameOnCard" autocomplete="cc-name"></label>'
        : style === 'shopify'
          ? '<input name="number" placeholder="Card number" inputmode="numeric"><input name="name" placeholder="Name on card"><input name="expiry" placeholder="Expiration date (MM / YY)"><input name="verification_value" placeholder="Security code" inputmode="numeric">'
          : '<input name="cardnumber" autocomplete="cc-number" placeholder="Card number" inputmode="numeric"><input name="exp-date" autocomplete="cc-exp" placeholder="MM / YY"><input name="cvc" autocomplete="cc-csc" placeholder="CVC" inputmode="numeric"><input name="ccname" placeholder="Name on card">';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body style="margin:0;font:14px system-ui">${fields}
<style>input{display:block;margin:4px 0;padding:6px;width:260px}</style>
<script>
// Format like real payment widgets do (and tell the page what's in each box, like EB's).
for (const el of document.querySelectorAll('input')) {
  el.addEventListener('input', () => {
    if (/number|cardnumber/i.test(el.name)) el.value = el.value.replace(/\\D/g,'').slice(0,16).replace(/(\\d{4})(?=\\d)/g,'$1 ');
    if (/exp/i.test(el.name)) { const d = el.value.replace(/\\D/g,'').slice(0,4); el.value = d.length > 2 ? d.slice(0,2) + ' / ' + d.slice(2) : d; }
    parent.postMessage({ ebCard: el.name, value: el.value }, '*');
  });
}
// Like a payment provider's own 3-D Secure (threeDS 'nested'): the bank's page posted into a frame inside this one,
// when the checkout above asks — nothing on the checkout itself says so.
addEventListener('message', (e) => {
  const b = e.data && e.data.mgbBank;
  if (!b) return;
  document.body.insertAdjacentHTML('beforeend', '<iframe name="c' + b.id + '" width="400" height="420" frameborder="0"></iframe><form id="cq" method="POST" action="' + b.acs + '" target="c' + b.id + '" style="display:none"></form>');
  document.getElementById('cq').submit();
});
</script></body></html>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // -------------------------------------------------------------------- checkpoints and queues
  const cookieOf = (req, name) => {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  };

  // The queue page, like EB Games' (Cloudflare's waiting room): it refreshes itself. lateMs: its words
  // drawn by its own code a moment after it opens (like a queue page built in the browser).
  function queuePage(shop, q) {
    const s = SHOPS[shop];
    const words = `<h1>You're in the queue!</h1>
<p>Thanks for hanging in there. You'll head back into the queue after you complete your transaction.</p>
<p id="wait">Your estimated wait time is ${Number(q.wait)} minutes.</p>
<p>We are experiencing a high volume of traffic and using a virtual queue to limit the number of users on the site at the same time, so you can shop with confidence.</p>
<p>This page will automatically refresh, please do not close your browser.</p>`;
    const body = q.lateMs ? `<div id="queue"></div><script>setTimeout(() => { document.getElementById('queue').innerHTML = ${JSON.stringify(words)}; }, ${Number(q.lateMs)});</script>` : words;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.name)} — You're in the queue</title></head>
<body style="font:16px system-ui;text-align:center;padding:40px;background:#f4f4f4"><div class="dummy">⚠ Dummy store for testing Mugibot — nothing here is real.</div>
${body}
<script>setTimeout(() => location.reload(), ${Number(q.refreshMs) || 1500});</script></body></html>`;
  }

  /**
   * A shop's virtual queue (S.queue.on): null when this visitor may in (let in already, or let in
   * now), else the response sent (the queue page, or Pokémon Center's redirect to /?queue).
   */
  function inQueue(shop, S, req, res, u, html, redirect) {
    const q = S.queue;
    const name = `${shop}_queue`;
    const v = cookieOf(req, name) || '';
    if (v.startsWith('ok-') && q.admittedIds.includes(v.slice(3))) return null;
    const now = Date.now();
    let id = v.startsWith('in-') ? v.slice(3) : null;
    if (!v) q.cookieless += 1;
    let place = id ? q.places[id] : null;
    // (how: a page load or a page's own request, from the browser's own headers — for a test's failure message.)
    const how = `${req.headers['sec-fetch-mode'] || '-'}/${req.headers['sec-fetch-dest'] || '-'}`;
    const note = (what) => { q.log.push({ id, at: now, path: u.pathname + u.search, what, how }); if (q.log.length > 3000) q.log.splice(0, 1000); };
    // Asked again too soon (refreshed by hand, a second tab, a script): the place in line is lost.
    if (place && now - place.lastAt < q.tooSoonMs) { note('kicked'); q.kicks += 1; delete q.places[id]; place = null; }
    if (!place) {
      id = Math.random().toString(36).slice(2, 10);
      place = q.places[id] = { joinedAt: now, lastAt: now - q.tooSoonMs };
    }
    // Pokémon Center's line is at /?queue.
    if (shop === 'pokemoncenter' && !u.searchParams.has('queue')) {
      note('redirect');
      res.setHeader('set-cookie', `${name}=in-${id}; Path=/`);
      redirect('/pokemoncenter/?queue');
      return true;
    }
    place.lastAt = now;
    if (now - place.joinedAt >= q.admitAfterMs) {
      note('admitted');
      delete q.places[id];
      q.admittedIds.push(id);
      q.admitted += 1;
      res.setHeader('set-cookie', `${name}=ok-${id}; Path=/`);
      // (Pokémon Center's line sends you on to the store's front page.)
      if (shop === 'pokemoncenter' && u.searchParams.has('queue')) { redirect('/pokemoncenter/'); return true; }
      return null;
    }
    note('queued');
    res.setHeader('set-cookie', `${name}=in-${id}; Path=/`);
    q.shown += 1;
    html(200, queuePage(shop, q));
    return true;
  }

  // Shopify's checkpoint: an hCaptcha page. Only a person's click (a trusted one) ticks the box.
  function checkpointPage(shop, back) {
    return page(shop, 'Checkpoint', `<h1>Before you continue…</h1><p>Confirm you're human to carry on to checkout.</p>
      <form method="post" action="/${shop}/checkpoint" id="checkpoint-form"><input type="hidden" name="return_to" value="${esc(back)}">
      <div class="h-captcha" data-sitekey="10000000-ffff-ffff-ffff-000000000001"><label><button type="button" id="hcaptcha-box" aria-label="I am human" style="background:#fff;color:#222;border:2px solid #999">☐</button> I am human</label></div>
      <input type="hidden" name="h-captcha-response" id="hcaptcha-response" value="">
      <p><button type="submit" id="checkpoint-submit">Submit</button></p></form>
      <script>
        document.getElementById('hcaptcha-box').addEventListener('click', (e) => {
          if (!e.isTrusted) { fetch('/${shop}/checkpoint/bot', { method: 'POST' }); return; }
          e.currentTarget.textContent = '☑';
          document.getElementById('hcaptcha-response').value = 'P1_human-' + Date.now();
        });
        document.getElementById('checkpoint-form').addEventListener('submit', (e) => { if (!e.isTrusted) { e.preventDefault(); fetch('/${shop}/checkpoint/bot', { method: 'POST' }); } });
      </script>`);
  }

  // -------------------------------------------------------------------- Acme Collectibles
  // A shop on no retailer's address (another website for Mugibot: alerts only, no checkout). Its
  // product pages (with Shopify's product JSON when acme.shopify is on), a search page of product
  // tiles, its "new arrivals" listing, and Shopify's search suggestions (only with acme.shopify).
  // acme.refuse: every page answers 403 (a website that turns servers away).
  function acmeTile(x) {
    const stock = x.status === 'in_stock' ? '<button>Add to cart</button>' : x.status === 'preorder' ? '<button>Pre-order</button>' : '<span class="sold">Sold out</span>';
    return `<li class="product-card"><a href="/acme/products/${esc(x.handle)}">${esc(x.name)}</a> <span class="price">$${x.price.toFixed(2)}</span> ${stock}</li>`;
  }
  function acme(sub, u, req, res, { html, json }) {
    const A = state.acme;
    if (A.refuse) return html(403, '<html><head><title>Forbidden</title></head><body>Forbidden</body></html>');
    const listed = A.products.filter((x) => x.listed);
    const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — Acme Collectibles</title></head><body><header><a href="/acme/">Acme Collectibles</a> · <a href="/acme/collections/new">New arrivals</a></header><main>${body}</main></body></html>`;
    if (sub === '/' || sub === '') return html(200, shell('Home', `<h1>Acme Collectibles</h1><p>Consoles, figures and more. <a href="/acme/collections/new">New arrivals</a></p>`));
    if (sub === '/collections/new') return html(200, shell('New arrivals', `<h1>New arrivals</h1><ul>${listed.map(acmeTile).join('')}</ul>`));
    if (sub === '/search') {
      const q = String(u.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
      const hits = listed.filter((x) => q.every((w) => x.name.toLowerCase().includes(w)));
      return html(200, shell('Search', `<h1>Search</h1>${hits.length ? `<ul>${hits.map(acmeTile).join('')}</ul>` : '<p>No results</p>'}`));
    }
    if (sub === '/search/suggest.json') {
      if (!A.shopify) return html(404, shell('Not found', '<h1>Page not found</h1>'));
      const q = String(u.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
      const hits = listed.filter((x) => q.every((w) => x.name.toLowerCase().includes(w)));
      return json(200, { resources: { results: { products: hits.map((x) => ({ handle: x.handle, title: x.name, url: `/acme/products/${x.handle}`, price: x.price.toFixed(2), available: x.status === 'in_stock' || x.status === 'preorder' })) } } });
    }
    // (Its pages under a Microsoft-style link too: /en-au/d/<name>/<code>.)
    const m = sub.match(/^\/products\/([a-z0-9-]+)(\.js)?$/) || sub.match(/^\/(?:[a-z]{2}-[a-z]{2}\/)?d\/([a-z0-9-]+)\/[a-z0-9]+()$/);
    // (And the Riot Games Store's way: /en-us/product/<slug>/ — see riotPage.)
    const riot = sub.match(/^\/[a-z]{2}-[a-z]{2}\/product\/([a-z0-9-]+)\/?$/);
    if (riot) {
      const y = A.products.find((z) => z.handle === riot[1] && z.riot);
      return y ? html(200, riotPage(y)) : html(404, shell('Not found', '<h1>Page not found</h1>'));
    }
    const x = m && A.products.find((y) => y.handle === m[1]);
    if (!x || !x.listed) return html(404, shell('Not found', '<h1>Page not found</h1>'));
    if (m[2]) {
      if (!A.shopify) return html(404, shell('Not found', '<h1>Page not found</h1>'));
      return json(200, { title: x.name, variants: [{ id: 9900 + A.products.indexOf(x), available: x.status === 'in_stock' || x.status === 'preorder', price: Math.round(x.price * 100) }] });
    }
    const ld = { '@context': 'https://schema.org', '@type': 'Product', name: x.name, offers: { '@type': 'Offer', price: x.price.toFixed(2), priceCurrency: 'AUD', availability: `https://schema.org/${LD_AVAIL[x.status] || 'OutOfStock'}` } };
    const buy = x.status === 'in_stock' ? '<button type="button" name="add">Add to cart</button>' : x.status === 'preorder' ? '<button type="button" name="add">Pre-order now</button>' : '<button type="button" disabled>Sold out</button>';
    return html(200, shell(x.name, `<script type="application/ld+json">${JSON.stringify(ld)}</script><div class="product"><h1>${esc(x.name)}</h1><p class="price">$${x.price.toFixed(2)}</p>${buy}</div>`));
  }

  /**
   * A product page the way the Riot Games Store's are (merch.riotgames.com, Next.js App Router, its products from
   * Shopify): the whole page streamed inside a hidden <div> its own code moves into view, a "Notify Me" button in an
   * overlay its code shows (aria-hidden) and no buy button at all in the HTML — its code draws "Add to Cart" — and
   * the page's data streamed in self.__next_f.push([1, "…"]): another product's ("you may also like", in stock)
   * first, then the page view's tracking (the page's product: its price and availability, "outOfStock" or
   * "inStock") and the product itself (isPreorder, its options' availableForSale, its "Coming Soon" label).
   * x.status: 'coming_soon' (Riftbound's drops, Oct 2026), 'in_stock', 'preorder' (on sale, isPreorder) or
   * 'out_of_stock' (its "Retired" label, shown only while it's unavailable).
   */
  function riotPage(x) {
    const onSale = x.status === 'in_stock' || x.status === 'preorder';
    const product = {
      size: '1x1', contentType: 'product', createdAt: '2026-10-23', dropAt: '$undefined', title: x.name, trackingTitle: x.name, sku: `RB${x.price}`, id: `RB${x.price}`, slug: x.handle,
      price: '$7:props:children:1:0:props:children:props:trackingEvent:product:price', productType: 'simple',
      productDisplayMessages: [
        x.status === 'out_of_stock' ? { label: 'Retired', color: 'black', displayType: 'above-title', showOnlyWhenUnavailable: true, showOnProductDetails: true }
          : { label: 'Coming Soon', color: 'blue', displayType: 'above-title', showOnlyWhenUnavailable: null, showOnProductDetails: true },
        { label: 'Limited Edition', color: 'gold', displayType: 'above-title', showOnlyWhenUnavailable: null, showOnProductDetails: true },
      ],
      isPreorder: x.status === 'preorder' || !!x.preorderLater,
      variants: x.shopify ? [{ availableForSale: onSale, id: 'gid://shopify/ProductVariant/1', sku: `RB${x.price}-00` }] : '$undefined',
    };
    const other = { product: { title: 'Riftbound: Origins Booster Display', slug: 'riftbound-origins-booster-display', isPreorder: false }, trackingEvent: { event: 'view_item', product: { availability: 'inStock' } } };
    const rows = [
      `5:["$","$L19",null,${JSON.stringify(other)}]\n`,
      `7:["$","$L1b",null,{"theme":"riftbound","children":[["$","$L1d",null,{"index":0,"id":"page-tracker","trackingEvent":{"event":"pageview","product":${JSON.stringify({ name: x.name, sku: product.sku, price: { amount: x.price, currencyCode: 'USD' }, availability: onSale ? 'inStock' : 'outOfStock', category: '' })}}}],`,
      `["$","$L1e",null,{"product":${JSON.stringify(product)}}]]}]\n`,
    ];
    const push = (row) => `<script>self.__next_f.push([1,${JSON.stringify(row).replace(/</g, '\\u003c')}])</script>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(x.name)} | Riot Games Store (dummy)</title></head><body>
      <div hidden id="S:0"><section class="product-hero"><h1>${esc(x.name)}</h1><p class="price">$${x.price.toFixed(2)}</p>
        <div class="add-to-cart-panel_panel" aria-hidden="false"><div class="add-to-cart-panel_overlay" aria-hidden="true"><div class="purchase-bar__actions">${onSale ? '' : '<button type="button" class="button_button--variant--primary">Notify Me</button>'}</div></div></div>
      </section></div>
      <script>self.__next_f = self.__next_f || []</script>${rows.map(push).join('')}</body></html>`;
  }

  // -------------------------------------------------------------------- Shop checkout links
  // A store that checks out with Shop (Mattel Creations-style, /creations): its options' JSON, and its
  // cart links — straight on to Shop's checkout (/shopapp), which sends a browser not signed in to Shop
  // back to the store's own guest checkout (its ur_back_url), as the real ones do.
  const SHOP_ID = '56811323597';
  const shopMoney = (n) => `$${n.toFixed(2)}`;
  function creations(sub, u, req, res, { html, json, redirect }) {
    const A = state.shopapp;
    const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — Creations (dummy)</title></head><body><div class="dummy">⚠ Dummy store for testing Mugibot — nothing here is real.</div><header><a href="/creations/">Creations (dummy)</a></header><main>${body}</main></body></html>`;
    const v = sub.match(/^\/variants\/(\d+)\.js$/);
    if (v) {
      const x = A.variants.find((y) => String(y.id) === v[1]);
      if (!x) return html(404, shell('Not found', '<h1>Page not found</h1>'));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(JSON.stringify({ id: x.id, title: 'Default Title', available: !!x.available, name: x.name, price: Math.round(x.price * 100), featured_image: null }));
    }
    const c = sub.match(/^\/cart\/(\d+:\d+(?:,\d+:\d+)*)$/);
    if (c) {
      const lines = c[1].split(',').map((x) => { const [id, qty] = x.split(':'); return { id, qty: Number(qty) || 1 }; });
      if (!lines.every((l) => A.variants.some((y) => String(y.id) === l.id))) return html(404, shell('Not found', '<h1>Page not found</h1>'));
      const token = `hWNI${Object.keys(A.checkouts).length + 1}x`;
      A.checkouts[token] = lines;
      const back = `/creations/checkouts/cn/${token}/en-us?skip_shop_pay=true`;
      const to = `/shopapp/checkout/${SHOP_ID}/cn/${token}/en-us/shoppay?redirect_source=checkout_universal_redirect&ur_back_url=${encodeURIComponent(back)}`;
      if (A.queueMs) return redirect(`/creations/queue?until=${Date.now() + A.queueMs}&to=${encodeURIComponent(to)}`);
      return redirect(to);
    }
    if (sub === '/queue') {
      // In line: the page moves on by itself when it's your turn (never refresh it) — to a new address, so the
      // code in the old one's left behind.
      A.queueViews += 1;
      const until = Number(u.searchParams.get('until')) || 0;
      const to = String(u.searchParams.get('to') || '');
      if (!to.startsWith('/shopapp/')) return html(400, shell('Queue', '<h1>Bad queue link</h1>'));
      return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Queue - Creations (dummy) - Checkout</title></head><body><div class="dummy">⚠ Dummy store queue for testing Mugibot — nothing here is real.</div><main><h1>Creations (dummy)</h1><p>You’re in line to check out</p><p>Estimated wait time: Less than a minute</p><p>Don’t refresh this page, it will update automatically.</p><p>Items in your cart are not reserved until you complete checkout.</p></main>
<script>setTimeout(() => location.replace(${JSON.stringify(to)}), Math.max(0, ${until} - Date.now()));</script></body></html>`);
    }
    const g = sub.match(/^\/checkouts\/cn\/(\w+)\/(en-us|thank-you)$/);
    if (g && g[2] === 'thank-you') return html(200, shell('Thank you', `<h1>Thank you for your purchase!</h1><p>Order #M${1000 + A.orders.length} is confirmed.</p>`));
    if (g) {
      A.guestViews += 1;
      return html(200, shell('Checkout', '<h1>Checkout</h1><h3>Contact</h3><input name="email" type="email" placeholder="Email"><button type="button">Continue to shipping</button>'));
    }
    return html(404, shell('Not found', '<h1>Page not found</h1>'));
  }

  function shopApp(sub, u, req, res, { html, json, redirect }) {
    const A = state.shopapp;
    // (Like the real Shop's pages, an app's: its code carries the words it might show — "Sign in to your
    //  account" among them — whether you're signed in or not.)
    const strings = '<script type="application/json" id="shop-i18n">{"signIn":"Sign in to your account","continue":"Continue with email"}</script>';
    if (sub === '/account') {
      A.accountViews += 1;
      return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Manage account - Shop</title>${strings}</head><body><div class="dummy">⚠ Dummy Shop — nothing here is real.</div>
        ${A.signedIn ? '<h1>Manage account</h1><p>ash.shop@example.com</p><button type="button">Sign out</button>' : '<h2>Sign in to your account</h2><button type="button">Continue with email</button>'}</body></html>`);
    }
    const m = sub.match(/^\/checkout\/(\d+)\/cn\/(\w+)\/en-us\/(shoppay|pay)$/);
    const lines = m && A.checkouts[m[2]];
    if (!lines) return html(404, '<!doctype html><title>Page not found - Shop</title><h1>Page not found</h1>');
    const priced = lines.map((l) => ({ ...l, v: A.variants.find((y) => String(y.id) === l.id) }));
    const subtotal = priced.reduce((n, l) => n + l.v.price * l.qty, 0);
    const total = Math.round((subtotal + A.shipping) * 100) / 100;
    if (m[3] === 'pay' && req.method === 'POST' && u.searchParams.get('discount') !== null) {
      // The discount box's Apply: taken (its amount off), or "Enter a valid discount code".
      const code = String(u.searchParams.get('discount') || '').trim().toUpperCase();
      A.discountTries.push(code);
      const off = A.discounts[code];
      return off ? json(200, { code, off }) : json(422, { error: 'Enter a valid discount code' });
    }
    if (m[3] === 'pay' && req.method === 'POST') {
      return parseBody(req).then((b) => {
        A.payTries += 1;
        A.payAt.push(Date.now());
        if (A.throttleNext) { A.throttleNext = false; A.throttleUntil = Date.now() + A.throttleMs; }
        if (Date.now() < A.throttleUntil) { A.throttled += 1; return json(429, { throttled: true }); }
        if (A.unavailable && A.liveAfter && A.refused.filter((x) => /not available/.test(x)).length >= A.liveAfter) A.unavailable = false;
        // (The queue reset at the drop: this press sent back to the store's queue, nothing bought.)
        if (A.bounceMs) {
          const ms = A.bounceMs;
          A.bounceMs = 0;
          A.refused.push('queue');
          return json(409, { queue: `/creations/queue?until=${Date.now() + ms}&to=${encodeURIComponent(String(b.back || ''))}` });
        }
        if (A.agreement && b.agreed && A.payTries <= A.busy) { A.refused.push('busy'); return json(503, { error: 'Something went wrong on our end. Please try again.' }); }
        const why = A.unavailable ? 'This Product is not available for purchase' : A.agreement && !b.agreed ? 'You must accept membership agreement before checking out' : '';
        if (why) { A.refused.push(why); return new Promise((r) => setTimeout(r, A.real ? 300 : 0)).then(() => json(422, { error: why })); }
        const off = (b.discount && A.discounts[String(b.discount).toUpperCase()]) || 0;
        const place = () => A.orders.push({ token: m[2], lines: lines.map((l) => [l.id, l.qty]), total: Math.round((total - off) * 100) / 100, discount: off ? String(b.discount).toUpperCase() : '', agreed: !!b.agreed, marketing: !!b.marketing, rewards: !!b.rewards, at: Date.now() });
        const next = `/creations/checkouts/cn/${m[2]}/thank-you`;
        if (A.threeDS) {
          // Your bank's check, in a pop-up over Shop's checkout (bankJs): the order's placed once you approve it.
          A.challenged += 1;
          return json(200, { ok: false, bank: bankStart('shopapp', A.threeDS, place, next, req.headers.host) });
        }
        place();
        return json(200, { ok: true, next });
      });
    }
    const back = String(u.searchParams.get('ur_back_url') || '');
    // Not signed in to Shop here: on to the store's own checkout, as a guest.
    if (!A.signedIn) return redirect(back.startsWith('/creations/') ? back : `/creations/checkouts/cn/${m[2]}/en-us`);
    A.shown += 1;
    const banner = (t, id = '', hidden = false) => `<div class="banner"${id ? ` id="${id}"` : ''} role="alert"${hidden ? ' hidden' : ''}>${t}</div>`;
    return html(200, `<!doctype html><html><head><meta charset="utf-8"><title>Checkout - Creations (dummy) - Shop</title>${strings}
<style>body{font:15px system-ui;margin:0;background:#f5f3ff;color:#111}header{background:#5a31f4;color:#fff;padding:10px 20px;display:flex;justify-content:space-between}main{max-width:560px;margin:20px auto;padding:0 20px}
section{background:#fff;border-radius:10px;padding:10px 14px;margin:10px 0}.banner{background:#fde8e8;color:#9b1c1c;border-radius:8px;padding:10px;margin:8px 0}.pay{background:#5a31f4;color:#fff;border:0;border-radius:8px;padding:14px;width:100%;font-size:16px}.dummy{background:#fff3cd;padding:6px 20px;font-size:13px}</style></head>
<body><div class="dummy">⚠ Dummy Shop checkout for testing Mugibot — nothing here is real.</div>
<header><b>shop</b><span class="acct">ash.shop@example.com</span></header><main>
${A.unavailable || A.notice ? banner('This Product is not available for purchase') : ''}
${A.agreement ? banner('You must accept membership agreement before checking out', 'agree-err', !A.agreeNotice) : ''}
<section><h3>Ship to</h3><p>Ash Ketchum, 1 Pallet Town Rd, Sydney NSW 2000, AU</p></section>
<section><h3>Shipping method</h3><p>Standard Courier · ${shopMoney(A.shipping)}</p></section>
<section><h3>Payment</h3><p>Commonwealth Bank •••• 2387</p></section>
<section class="lines">${priced.map((l) => `<p class="line">${esc(l.v.name)}${l.qty > 1 ? ` × ${l.qty}` : ''} <span>${shopMoney(l.v.price * l.qty)}</span></p>`).join('')}
  <form id="discount-form"><div><input name="reductions" id="ReductionsInputPS1-72" placeholder="Discount code" autocomplete="off"></div><button type="submit" id="apply-discount" aria-label="Apply Discount Code" disabled>Apply</button><p id="discount-error" role="alert" hidden></p></form>
  <p id="discount-line" hidden>Discount <span class="tag" id="discount-tag"></span> <span id="discount-off"></span></p>
  <p>Subtotal <span>${shopMoney(subtotal)}</span></p><p>Shipping <span>${shopMoney(A.shipping)}</span></p><p class="total"><b>Total</b> AUD <b id="total">${shopMoney(total)}</b></p></section>
${A.agreement && A.real ? '<div class="agree"><div class="row"><div class="cb"><input type="checkbox" id="CheckboxPS1-3" name="membership"><div class="mark"><span><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6l3 3 5-6" fill="none" stroke="currentColor"/></svg></span></div></div><label for="CheckboxPS1-3">By selecting, you indicate your acceptance of the</label></div><a href="/creations/pages/membership-agreement" target="_blank">Membership Agreement ↗</a></div>'
    : A.agreement && A.hiddenBox ? '<div class="agree"><input type="checkbox" id="membership" name="membership" required style="display:none"><label for="membership"><span class="tick" aria-hidden="true">☐</span> By selecting, you indicate your acceptance of the <a href="/creations/pages/membership-agreement" target="_blank">Membership Agreement ↗</a></label></div>'
    : A.agreement ? '<label class="agree"><input type="checkbox" id="membership" name="membership" required> By selecting, you indicate your acceptance of the <a href="/creations/pages/membership-agreement" target="_blank">Membership Agreement ↗</a></label>' : ''}
<label><input type="checkbox" id="marketing" name="marketing"> Email me with news and offers</label>
${A.real ? '<div class="rewards"><input type="checkbox" id="CheckboxPS1-7" name="rewards"><span>I agree to sign-up for Mattel Rewards and its <a href="/creations/pages/terms">Terms and Conditions</a>.</span></div>' : ''}
<p>${A.real ? `<button aria-busy="false" aria-label="Pay now\n${shopMoney(total)}" aria-live="polite" id="checkout-pay-button" class="pay" type="submit"><span><span>Pay now</span> <span>${shopMoney(total)}</span></span></button>` : '<button type="button" id="pay" class="pay">Pay now</button>'}</p>
<p><a href="${esc(back)}" id="guest">Check out as guest</a></p>
</main>
<div id="throttle" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.5);align-items:center;justify-content:center;display:${Date.now() < A.throttleUntil ? 'flex' : 'none'}"><div style="background:#fff;padding:20px;border-radius:8px"><p>Too many checkout attempts</p><p>Please wait a few minutes and try again from your cart.</p><a href="/creations/cart">Return to cart</a></div></div>
<script>
  const real = ${A.real ? 'true' : 'false'};
  const same = ${A.sameNotice ? 'true' : 'false'};
  // The discount box: Apply on only with something typed; taken — shown as a tag, the box emptied, the total
  // down — or "Enter a valid discount code" under it (the box marked wrong).
  let discount = '';
  const dbox = document.querySelector('input[name="reductions"]');
  const dbtn = document.getElementById('apply-discount');
  const derr = document.getElementById('discount-error');
  dbox.addEventListener('input', () => { dbtn.disabled = !dbox.value.trim(); derr.hidden = true; dbox.removeAttribute('aria-invalid'); });
  document.getElementById('discount-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await fetch(location.pathname.replace(/shoppay$/, 'pay') + '?discount=' + encodeURIComponent(dbox.value), { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { derr.textContent = d.error; derr.hidden = false; dbox.setAttribute('aria-invalid', 'true'); return; }
    discount = d.code;
    document.getElementById('discount-tag').textContent = d.code;
    document.getElementById('discount-off').textContent = '-$' + d.off.toFixed(2);
    document.getElementById('discount-line').hidden = false;
    const t = document.getElementById('total');
    t.textContent = '$' + (Number(t.textContent.replace(/[^0-9.]/g, '')) - d.off).toFixed(2);
    dbox.value = '';
    dbtn.disabled = true;
  });
  const pay = document.querySelector('.pay');
  pay.addEventListener('click', async () => {
    const box = document.querySelector('input[name="membership"]');
    if (!real && box && !box.checked) { document.getElementById('agree-err').hidden = false; return; }
    if (pay.getAttribute('aria-busy') === 'true') return;
    pay.setAttribute('aria-busy', 'true');
    const r = await fetch(location.pathname.replace(/shoppay$/, 'pay'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agreed: !!(box && box.checked), marketing: document.getElementById('marketing').checked, back: location.pathname + location.search, discount, rewards: !!(document.querySelector('input[name="rewards"]') || {}).checked }) });
    const d = await r.json();
    if (d.queue) { location.href = d.queue; return; }
    if (d.bank) { ${bankJs()}; return; }
    if (d.throttled) { pay.setAttribute('aria-busy', 'false'); document.getElementById('throttle').style.display = 'flex'; return; }
    if (!r.ok) {
      pay.setAttribute('aria-busy', 'false');
      // (The same words already up, on a checkout that leaves them as they are: not drawn again.)
      if (same && [...document.querySelectorAll('[role="alert"]')].some((x) => !x.hidden && x.textContent === d.error)) return;
      const b = document.createElement('div'); b.className = 'banner'; b.setAttribute('role', 'alert'); b.textContent = d.error; document.querySelector('main').prepend(b); return;
    }
    location.href = d.next;
  });
</script></body></html>`);
  }

  // -------------------------------------------------------------------- store server
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    // (mode: how the browser asked — 'navigate' for a page opened, 'cors' / 'no-cors' / 'same-origin' for a request from code.)
    // (cookie: what the browser sent — a private window's requests carry none of your own.)
    // (site: whose page asked — 'same-origin' for one of the store's own pages, 'none' for a page opened or the extension's background.)
    state.requests.push({ method: req.method, path: p, ua: req.headers['user-agent'] || '', mode: req.headers['sec-fetch-mode'] || '', site: req.headers['sec-fetch-site'] || '', cookie: req.headers.cookie || '' });
    if (state.requests.length > 4000) state.requests.splice(0, 2000);
    const html = (status, body) => {
      const sm = p.match(SHOP_RE);
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(sm ? String(body).replace('<!--mgb-account-->', accountBits(sm[1], !!state.signedIn[sm[1]])) : body);
    };
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); };

    // The bank's check, as the checkout's page asks after it (bankJs): approved yet, and where to then.
    if (p === '/bank-status') {
      const x = state.bank[u.searchParams.get('id') || ''];
      return json(200, { approved: !!(x && x.approved), next: x ? x.next : '' });
    }

    // Product pictures (a coloured card with the product's name).
    const img = p.match(new RegExp(`^/img/(${Object.keys(SHOPS).join('|')})/([^/]+)\\.svg$`));
    if (img) {
      const prod = find(img[1], decodeURIComponent(img[2]));
      if (!prod) return html(404, 'Not found');
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><rect width="300" height="300" rx="24" fill="${SHOPS[img[1]].color}"/><text x="150" y="140" font-family="system-ui,sans-serif" font-size="22" fill="#fff" text-anchor="middle">${esc(prod.name.slice(0, 22))}</text><text x="150" y="172" font-family="system-ui,sans-serif" font-size="16" fill="#fff" opacity=".8" text-anchor="middle">${esc(SHOPS[img[1]].name)}</text></svg>`);
    }

    // A picture that takes a while (a page that's slow to finish loading).
    if (p === '/slow.gif') {
      await new Promise((r) => setTimeout(r, Math.min(20000, Number(u.searchParams.get('ms')) || 0)));
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
      return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
    }

    // A store that refuses anything that isn't a browser (like Kmart's bot protection does for servers).
    if (state.blockNonBrowsers && !/Mozilla|Chrome/i.test(req.headers['user-agent'] || '') && !p.startsWith('/__admin')) {
      return html(403, '<html><head><title>Access Denied</title></head><body>Access Denied. Reference #18.abc123.1700000000</body></html>');
    }

    // ---------------- Acme: a website Mugibot doesn't know (drop watches: monitor/drops.js)
    if (p === '/acme' || p.startsWith('/acme/')) return acme(p.slice('/acme'.length) || '/', u, req, res, { html, json });
    // ---------------- Shop checkout links: a store that checks out with Shop, and Shop's checkout
    if (p === '/creations' || p.startsWith('/creations/')) return creations(p.slice('/creations'.length) || '/', u, req, res, { html, json, redirect });
    if (p === '/shopapp' || p.startsWith('/shopapp/')) return shopApp(p.slice('/shopapp'.length) || '/', u, req, res, { html, json, redirect });

    // ---------------- control panel
    if (p === '/__admin/state') return json(200, { ...state, requests: undefined });
    if (p === '/__admin/buynow' && req.method === 'POST') { const sh = shopOf(u.searchParams.get('shop')); if (sh) sh.buyNowPresses = (sh.buyNowPresses || 0) + 1; return json(200, { ok: true }); }
    if (p === '/__admin/set' && req.method === 'POST') {
      const b = await parseBody(req);
      const prod = find(b.shop, b.sku);
      if (prod) {
        if (b.status) prod.status = b.status;
        if (b.price !== undefined && b.price !== '') prod.price = Number(b.price);
        if (b.listed !== undefined) prod.listed = b.listed === true || b.listed === 'true';
      }
      if (b.blockNonBrowsers !== undefined) state.blockNonBrowsers = b.blockNonBrowsers === true || b.blockNonBrowsers === 'true';
      // A shop's checkpoint (Shopify shops) or virtual queue (the others) on or off.
      if (b.gate && shopOf(b.gate)) shopOf(b.gate)[SHOPIFY.has(b.gate) ? 'checkpoint' : 'queue'].on = b.on === true || b.on === 'true';
      if (req.headers['content-type']?.includes('json')) return json(200, { ok: true });
      return redirect('/');
    }
    if (p === '/') {
      const btn = (shop, sku, fields, label) => `<form method="post" action="/__admin/set" style="display:inline"><input type="hidden" name="shop" value="${shop}"><input type="hidden" name="sku" value="${esc(sku)}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`).join('')}<button style="padding:4px 8px;font-size:12px;background:#444">${label}</button></form>`;
      const rows = Object.entries(state.shops).map(([shop, s]) => s.products.map((x) => `<tr><td>${esc(SHOPS[shop].name)}</td><td><a href="${pathFor(shop, x)}">${esc(x.name)}</a><br><small>SKU ${esc(x.sku)}</small></td>
        <td>${x.listed ? 'listed' : '<i>not listed</i>'}</td><td><b>${x.status}</b></td><td>$${x.price.toFixed(2)}</td>
        <td>${['in_stock', 'preorder', 'out_of_stock', 'coming_soon'].map((st) => btn(shop, x.sku, { status: st, listed: 'true' }, st)).join(' ')} ${btn(shop, x.sku, { listed: x.listed ? 'false' : 'true' }, x.listed ? 'unlist' : 'list')}</td></tr>`).join('')).join('');
      const orders = Object.values(state.shops).reduce((n, s) => n + s.orders.length, 0);
      return html(200, page(null, 'Dummy store control panel', `<h1>Dummy store — control panel</h1>
        <p>Fake shops for trying Mugibot end to end. Add these products to your Mugibot watchlist (the dashboard's <b>Add dummy-store test items</b> button does it for you), change their stock here, and watch the pings and ⚡ Buy work.</p>
        <table border="1" cellpadding="6" style="border-collapse:collapse;background:#fff;font-size:14px"><tr><th>Shop</th><th>Product</th><th>Listed</th><th>Stock</th><th>Price</th><th>Change</th></tr>${rows}</table>
        <p>${btn('', '', { blockNonBrowsers: state.blockNonBrowsers ? 'false' : 'true' }, state.blockNonBrowsers ? 'Stop refusing server checks' : 'Refuse server checks (like Kmart)')} Server checks are ${state.blockNonBrowsers ? '<b>refused</b> — only browsers get in' : 'allowed'}.</p>
        <p>Checkpoints and virtual queues: ${['jbhifi', 'ebgames', 'pokemoncenter'].map((id) => { const g = state.shops[id][SHOPIFY.has(id) ? 'checkpoint' : 'queue']; return `${btn('', '', { gate: id, on: g.on ? 'false' : 'true' }, `${SHOPS[id].name}: ${SHOPIFY.has(id) ? 'checkpoint' : 'queue'} ${g.on ? 'off' : 'on'}`)}`; }).join(' ')}</p>
        <p>Orders placed (stays 0 with ⚡ Buy — you press the final button; only an armed Auto-checkout places one): <b>${orders}</b></p>`));
    }

    const m = p.match(SHOP_RE);
    if (!m) return html(404, page(null, 'Page not found', '<h1>Page not found</h1>'));
    const shop = m[1];
    const sub = m[2] || '/';
    const S = shopOf(shop);
    // A shop whose search is slow to answer (searchDelayMs): its search pages and search APIs.
    if (S.searchDelayMs && /search|cnstrc/i.test(sub)) await new Promise((r) => setTimeout(r, Math.min(30000, Number(S.searchDelayMs))));
    // A shop answering "too many requests, wait N seconds" (state.tooMany[shop] = N), like Shopify's 429.
    if (state.tooMany && state.tooMany[shop] && !sub.startsWith('/img/')) {
      res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': String(state.tooMany[shop]) });
      return res.end('Too many requests');
    }
    // Its bot protection turning this browser away (denied — BIG W's Akamai): "Access Denied" for every page.
    if (S.denied && !sub.startsWith('/img/')) {
      S.deniedServed += 1;
      return html(403, `<!DOCTYPE html><html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>You don't have permission to access "http&#58;&#47;&#47;www&#46;${shop}&#46;com&#46;au&#47;" on this server.<p>Reference&#32;&#35;18&#46;5e0d0217&#46;1760943212&#46;3c1f9a2</p><p>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;5e0d0217&#46;1760943212&#46;3c1f9a2</p></body></html>`);
    }
    // Its bot protection taking anything but a visit for a bot (refuseBackground, EB Games' Cloudflare): a page opened, or a
    // request one of its own pages makes, gets through; the extension's background requests, and servers, get its 403.
    const asked = !sub.startsWith('/img/') && req.headers['sec-fetch-mode'] !== 'navigate';
    if ((S.refuseBackground && asked && req.headers['sec-fetch-site'] !== 'same-origin') || (S.refuseAsks && asked)) {
      if (req.headers['sec-fetch-site'] === 'same-origin') S.refusedAsks += 1; else S.refusedBackground += 1;
      return html(403, `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><div id="cf-wrapper"><h1 data-translate="block_headline">Sorry, you have been blocked</h1><h2 class="cf-subheadline">You are unable to access ${shop}.com.au</h2></div></body></html>`);
    }
    // Its virtual queue, when it's on: every page (its search JSON too) for a visitor not let in yet.
    if (S.queue.on && !sub.startsWith('/img/') && inQueue(shop, S, req, res, u, html, redirect)) return undefined;
    // Shopify's checkpoint: the hCaptcha page, and checkout through it until it's solved.
    if (SHOPIFY.has(shop) && (sub === '/checkpoint' || sub === '/checkpoint/')) {
      if (req.method === 'POST') {
        const b = await parseBody(req);
        if (!S.checkpoint.on) return redirect(`/${shop}/`);
        if (!/^P1_human-/.test(b['h-captcha-response'] || '')) return html(200, checkpointPage(shop, b.return_to || `/${shop}/checkouts/c/abc123`));
        S.checkpoint.solved += 1;
        const pass = `ok-${Math.random().toString(36).slice(2, 10)}`;
        S.checkpoint.passes.push(pass);
        res.setHeader('set-cookie', `${shop}_checkpoint=${pass}; Path=/`);
        const back = String(b.return_to || '');
        return redirect(back.startsWith(`/${shop}/`) ? back : `/${shop}/checkouts/c/abc123`);
      }
      if (!S.checkpoint.on) return html(404, page(shop, 'Page not found', '<h1>Sorry, we can\'t find that page</h1>'));
      S.checkpoint.shown += 1;
      return html(200, checkpointPage(shop, u.searchParams.get('return_to') || `/${shop}/checkouts/c/abc123`));
    }
    if (SHOPIFY.has(shop) && sub === '/checkpoint/bot' && req.method === 'POST') {
      S.checkpoint.botClicks += 1;
      return json(200, { ok: false });
    }
    const pastCheckpoint = () => !S.checkpoint.on || S.checkpoint.passes.includes(cookieOf(req, `${shop}_checkpoint`) || '');
    // (A thing out of the bag by its own Remove — Clear cart's tests: removeFails, it does nothing.)
    const takeOutOf = (sku) => {
      const i = S.cart.findIndex((c) => c.sku === sku);
      if (i === -1 || S.removeFails) return false;
      S.cart.splice(i, 1);
      S.removed += 1;
      return true;
    };

    // ---------------- The Gamesmen (Magento): its Cloudflare (refuseServers), cart, checkout, search, account
    if (shop === 'gamesmen') {
      if (S.refuseServers && !/Mozilla|Chrome/i.test(req.headers['user-agent'] || '')) {
        return html(403, '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><div id="cf-wrapper"><h1 data-translate="block_headline">Sorry, you have been blocked</h1><h2 class="cf-subheadline">You are unable to access gamesmen.com.au</h2></div></body></html>');
      }
      if (sub === '/checkout/cart/add' && req.method === 'POST') {
        const b = await parseBody(req);
        S.addedAt = Date.now();
        const r = addToCart(shop, b.sku, b.qty);
        return json(r.ok ? 200 : 409, r);
      }
      if (sub === '/checkout/cart/delete/' && req.method === 'POST') {
        const b = await parseBody(req);
        if (S.removeDelayMs) await new Promise((r) => setTimeout(r, S.removeDelayMs));
        takeOutOf(String(b.sku || ''));
        return redirect('/gamesmen/checkout/cart/');
      }
      if (sub === '/checkout/cart' || sub === '/checkout/cart/') return html(200, magentoCart());
      if (sub === '/checkout' || sub === '/checkout/' || sub === '/checkout/index/') {
        if (!S.cart.length) return redirect('/gamesmen/checkout/cart/');
        S.data.checkoutOpened = Date.now();
        return html(200, page(shop, 'Checkout', magentoCheckout(), { bagCount: bagCount(shop) }));
      }
      if (sub === '/checkout/place' && req.method === 'POST') {
        const b = await parseBody(req);
        if (S.decline) { S.declined = (S.declined || 0) + 1; return json(200, { ok: false, error: 'Your card was declined. Please try another card.' }); }
        const place = () => { S.orders.push({ form: b, cart: S.cart.slice(), ts: Date.now() }); S.cart = []; };
        if (S.threeDS) { S.challenged = (S.challenged || 0) + 1; return json(200, { ok: false, bank: bankStart(shop, S.threeDS, place, '/gamesmen/checkout/onepage/success/', req.headers.host) }); }
        place();
        return json(200, { ok: true });
      }
      if (sub === '/checkout/onepage/success/' || sub === '/checkout/onepage/success') return html(200, page(shop, 'Success Page', `<h1 class="page-title">Thank you for your purchase!</h1><p>Your order # is: <span>0000${1000 + S.orders.length}</span>.</p>`));
      if (sub === '/catalogsearch/result/' || sub === '/catalogsearch/result') return html(200, magentoSearchPage(u.searchParams.get('q') || ''));
      // Magento's "who's signed in" (what its pages ask for, and the store login monitor reads).
      if (sub === '/customer/section/load/' || sub === '/customer/section/load') return json(200, { customer: state.signedIn.gamesmen ? { fullname: 'Ash Ketchum', firstname: 'Ash', websiteId: '1', data_id: 1700000000 } : { data_id: 1700000000 } });
    }

    // ---------------- Games World (WooCommerce): its add-to-cart link, product form, cart, checkout, product API, account
    if (shop === 'gamesworld') {
      let notice = '';
      const added = (prod) => `<div class="woocommerce-message" role="alert"><a href="/gamesworld/cart/" tabindex="1" class="button wc-forward">View cart</a> “${esc(prod.name)}” has been added to your cart.</div>`;
      // ?add-to-cart=<id> on any page (its add-to-cart link: /checkout/?add-to-cart=<id>&quantity=1).
      const linkId = u.searchParams.get('add-to-cart');
      if (linkId && req.method === 'GET') {
        const prod = S.products.find((x) => String(x.id) === linkId);
        S.addedAt = Date.now();
        S.cartLinks = (S.cartLinks || 0) + 1;
        if (prod && addToCart(shop, prod.sku, Number(u.searchParams.get('quantity')) || 1).ok) notice = added(prod);
        else notice = '<ul class="woocommerce-error" role="alert"><li>You cannot add that amount to the cart — we have 0 in stock.</li></ul>';
      }
      const pm = sub.match(/^\/product\/([^/]+)\/?$/);
      if (pm && req.method === 'POST') {
        const b = await parseBody(req);
        const prod = find(shop, pm[1]);
        S.addedAt = Date.now();
        if (prod && String(b['add-to-cart']) === String(prod.id) && addToCart(shop, prod.sku, Number(b.quantity) || 1).ok) notice = added(prod);
        return prod ? html(200, wooProductPage(prod, notice)) : html(404, page(shop, 'Page not found', '<h1>Oops! That page can’t be found.</h1>'));
      }
      if (pm && notice) { const prod = find(shop, pm[1]); if (prod) return html(200, wooProductPage(prod, notice)); }
      if (sub === '/cart' || sub === '/cart/') {
        const rm = u.searchParams.get('remove_item');
        if (rm) {
          const c = S.cart.find((x) => x.sku === rm);
          if (S.removeDelayMs) await new Promise((r) => setTimeout(r, S.removeDelayMs));
          if (c && takeOutOf(rm)) notice = `<div class="woocommerce-message" role="alert">“${esc(c.name)}” removed. <a href="/gamesworld/cart/?undo_item=${encodeURIComponent(rm)}" class="restore-item">Undo?</a></div>`;
        }
        return html(200, wooCart(notice));
      }
      if (sub === '/checkout' || sub === '/checkout/') {
        if (!S.cart.length) return redirect('/gamesworld/cart/');
        S.data.checkoutOpened = Date.now();
        return html(200, page(shop, 'Checkout – Games World', wooCheckout(), { bagCount: bagCount(shop) }).replace('<div class="woocommerce-notices-wrapper"></div>', `<div class="woocommerce-notices-wrapper">${notice}</div>`));
      }
      if (sub === '/checkout/place' && req.method === 'POST') {
        const b = await parseBody(req);
        if (S.decline) { S.declined = (S.declined || 0) + 1; return json(200, { ok: false, error: 'Your card was declined.' }); }
        const place = () => { S.orders.push({ form: b, cart: S.cart.slice(), ts: Date.now() }); S.cart = []; };
        if (S.threeDS) { S.challenged = (S.challenged || 0) + 1; return json(200, { ok: false, bank: bankStart(shop, S.threeDS, place, `/gamesworld/checkout/order-received/${70000 + S.orders.length + 1}/?key=wc_order_dummy`, req.headers.host) }); }
        place();
        return json(200, { ok: true, order: 70000 + S.orders.length });
      }
      if (/^\/checkout\/order-received\/\d+\/?$/.test(sub)) return html(200, page(shop, 'Checkout – Games World', '<h1>Order received</h1><p class="woocommerce-notice woocommerce-thankyou-order-received">Thank you. Your order has been received.</p>'));
      if (sub === '/wp-json/wc/store/v1/products') return json(200, wooStoreApi(u, req.headers.host));
      if (sub === '/my-account' || sub === '/my-account/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html><head><title>My account – Games World</title></head><body class="page woocommerce-account woocommerce-page${state.signedIn.gamesworld ? ' logged-in' : ''}"><h1>My account</h1>${state.signedIn.gamesworld ? '<p>Hello <strong>Ash</strong> (not Ash? <a href="/gamesworld/my-account/customer-logout/">Log out</a>)</p>' : '<h2>Login</h2><form class="woocommerce-form-login"><input name="username"><input type="password" name="password"><button type="submit">Log in</button></form>'}</body></html>`);
      }
    }

    if (sub === '/' || sub === '') {
      const popup = S.cartPopup === 'late' && u.searchParams.get('cart') === 'open' && !S.cart.length
        ? `<div id="mini-holder"></div><script>setTimeout(() => { document.getElementById('mini-holder').innerHTML = '<div class="mini"><div class="msg"><span>Oh no!</span> currently your cart is empty.</div><a href="/${shop}/">Continue shopping</a></div>'; }, 1500);</script>`
        : S.cartPopup && u.searchParams.get('cart') === 'open' && !S.cart.length
        ? '<div class="modal cart-popup" role="dialog" aria-modal="true" style="position:fixed;top:60px;right:40px;width:380px;min-height:220px;background:#fff;border:1px solid #ccc;padding:30px;z-index:5"><button type="button" aria-label="Close" onclick="this.parentNode.remove()">×</button><div><b>Oh no!</b> currently your cart is empty.</div></div>' : '';
      return html(200, page(shop, SHOPS[shop].name, `<h1>${esc(SHOPS[shop].name)}</h1>${S.products.filter((x) => x.listed).map((x) => `<div class="tile product-tile"><a href="${pathFor(shop, x)}">${esc(x.name)}</a><div>$${x.price.toFixed(2)} · ${x.status.replace(/_/g, ' ')}</div></div>`).join('')}${popup}`));
    }

    // Product pages, each in its retailer's link shape.
    let sku = null;
    if (shop === 'kmart') sku = (sub.match(/^\/product\/[^/]*-(\d{6,10})\/?$/) || [])[1];
    if (shop === 'bigw') sku = (sub.match(/^\/product\/[^/]+\/p\/(\d+)$/) || [])[1];
    if (shop === 'ebgames') sku = (sub.match(/^\/product\/[^/]+\/(\d+)-/) || [])[1];
    if (shop === 'thegamescube') sku = (sub.match(/^\/catalog\/[^/]+\/[^/]+\/(\d+)\/?$/) || [])[1];
    if (shop === 'pokemoncenter') sku = (sub.match(/^\/product\/([0-9A-Za-z-]+)\/[^/]+$/) || [])[1];
    if (shop === 'pbandai') sku = (sub.match(/^\/item\/([A-Z]\d+)$/) || [])[1];
    if (shop === 'target') sku = (sub.match(/^\/p\/[^/]+\/(\d+)$/) || [])[1];
    if (shop === 'amazon') sku = (sub.match(/^\/dp\/([A-Z0-9]{10})$/) || [])[1];
    if (shop === 'citybeach') sku = (sub.match(/^\/[^/]+\/(\d{6,10}-\d{2})\.html$/) || [])[1];
    if (shop === 'gamesmen') sku = (sub.match(/^\/([a-z0-9]+(?:-[a-z0-9]+){2,})\/?$/) || [])[1];
    if (shop === 'gamesworld') sku = (sub.match(/^\/product\/([^/]+)\/?$/) || [])[1];
    if (SHOPIFY.has(shop)) {
      const js = sub.match(/^\/products\/([^/]+)\.js$/);
      if (js) {
        const prod = find(shop, js[1]);
        if (!prod || !prod.listed) return json(404, { error: 'not found' });
        // A marketplace seller's product (seller set): like JB Hi-Fi's, a "Seller" option naming them.
        const option = prod.seller ? { name: 'Seller', position: 1, values: [prod.seller] } : { name: 'Title', position: 1, values: ['Default Title'] };
        return json(200, {
          id: prod.id, handle: prod.sku, title: prod.name, available: prod.status === 'in_stock' || prod.status === 'preorder',
          featured_image: `http://${req.headers.host}${imagePath(shop, prod)}`, options: [option],
          variants: [{ id: prod.id, title: option.values[0], price: Math.round(prod.price * 100), available: prod.status === 'in_stock' || prod.status === 'preorder' }],
        });
      }
      // (Gameology's links name a collection on the way: /collections/<collection>/products/<handle>.)
      sku = (sub.match(/^(?:\/collections\/[^/]+)?\/products\/([^/.]+)$/) || [])[1];
    }
    if (sku) {
      const prod = find(shop, sku);
      if (!prod || !prod.listed) return html(404, page(shop, 'Page not found', '<h1>Sorry, we can\'t find that page</h1>'));
      if (S.busyPages > 0) {
        S.busyPages -= 1;
        S.busyServed += 1;
        return html(503, '<!doctype html><html><head><meta charset="utf-8"><title>Too many requests</title></head><body><h1>Too many requests</h1><p>We\'re experiencing high traffic right now. Please try again shortly.</p></body></html>');
      }
      S.servedAt = Date.now();
      S.startToken = Math.random().toString(36).slice(2);
      return html(200, productPage(shop, prod));
    }

    if (shop === 'thegamescube' && sub === '/products/search') return html(200, crystalSearchPage(u.searchParams.get('q') || ''));
    const pathSearch = shop === 'pokemoncenter' && sub.match(/^\/search\/([^/]+)$/);
    // Like Imperva's check at Pokémon Center (botCheck on): a first visit gets its page (a frame, no
    // title), which reloads the page once the browser has passed — here, after a moment.
    if (pathSearch && S.botCheck && !/(^|;\s*)pc_check=1/.test(req.headers.cookie || '')) {
      return html(200, `<html style="height:100%"><head><meta name="ROBOTS" content="NOINDEX, NOFOLLOW"></head><body style="margin:0;height:100%">
        <iframe id="main-iframe" src="/pokemoncenter/_Incapsula_Resource?SWUDNSAI=31" frameborder="0" width="100%" height="100%">Request unsuccessful.</iframe>
        <script>setTimeout(() => { document.cookie = 'pc_check=1; path=/'; location.reload(); }, ${Number(S.botCheck) > 1 ? Number(S.botCheck) : 1500});</script></body></html>`);
    }
    if (shop === 'pokemoncenter' && sub === '/_Incapsula_Resource') return html(200, '<html><body>Checking your browser…</body></html>');
    if (pathSearch) return html(200, clientSearchPage(shop, decodeURIComponent(pathSearch[1])));
    // Premium Bandai's search JSON (what its search page reads, and Mugibot's sweeps): only with the
    // region its own code sends in x-g1-area-code — without it, an error, like the real site.
    if (shop === 'pbandai' && sub === '/api/search' && u.searchParams.has('keyword')) {
      if (String(req.headers['x-g1-area-code'] || '').toLowerCase() !== 'au') return json(500, { status: 500, error: 'Internal Server Error', path: '/api/search' });
      const all = searchHits(shop, u.searchParams.get('keyword'));
      return json(200, {
        text: u.searchParams.get('keyword'),
        productResults: {
          sortType: u.searchParams.get('sortType') || 'Recommended', limit: Number(u.searchParams.get('limit')) || 20, offset: 0, totalCount: all.length,
          // (Nothing found: no products list at all, only the count — like the real site.)
          products: all.length ? all.map((x) => ({
            areaProductNo: `NAP${x.sku}AU`, productCode: x.sku, areaCode: 'AU', productName: { en: x.name },
            productType: x.status === 'preorder' ? 'PreOrder' : 'Normal', fixedListPrice: { amount: x.price, currency: 'AUD' },
            saleStatus: x.status === 'coming_soon' ? 'Waiting' : 'On', displayStatus: 'On',
            productImages: [{ fileUrl: imagePath(shop, x).slice(1), mediaType: 'Image' }],
            flags: [...(x.status === 'preorder' ? ['PRE_ORDER'] : []), ...(x.status === 'out_of_stock' ? ['OUT_OF_STOCK'] : [])],
          })) : undefined,
        },
        aggs: {},
      });
    }
    if (shop === 'target' && sub === '/search') return html(200, targetSearchPage(u.searchParams.get('text') || ''));
    // EB Games' search page: no products in it — its own script asks /search/query for them (with the page's own
    // filters: ?category=trading-cards&condition=preorder) and draws them, like the real one.
    if (shop === 'ebgames' && (sub === '/search' || sub === '/search/')) return html(200, ebSearchPage(u));
    if (shop === 'citybeach' && sub === '/search') return html(200, citybeachSearchPage(u.searchParams.get('q') || ''));
    if (sub === '/search' || sub === '/search/') {
      const q = u.searchParams.get('searchTerm') || u.searchParams.get('text') || u.searchParams.get('q') || u.searchParams.get('query') || u.searchParams.get('keyword') || '';
      // Like BIG W's real site: the page has no products in it until its own code fetches them.
      if (S.clientSearch) return html(200, clientSearchPage(shop, q, u.searchParams.get('page')));
      return html(200, searchPage(shop, q, u.searchParams.get('page')));
    }
    if (sub === '/api/search') {
      const tiles = paged(shop, u.searchParams.get('q'), u.searchParams.get('page')).hits.map((x) => ({ name: x.name, url: pathFor(shop, x), image: imagePath(shop, x), price: x.price, status: x.status, inStock: x.status === 'in_stock' || x.status === 'preorder' }));
      return json(200, { products: tiles });
    }
    // Amazon's search page: a tile per result with its ASIN (what Mugibot's sweeps read, from an admin's
    // browser). Like amazon.com.au, servers get "503 - An error occurred".
    if (shop === 'amazon' && sub === '/s') {
      if (!/Mozilla|Chrome/i.test(req.headers['user-agent'] || '')) return html(503, '<html><head><title>500 - An error occurred</title></head><body>Sorry! Something went wrong.</body></html>');
      const hits = searchHits(shop, (u.searchParams.get('k') || '').replace(/\s*\btcg\b/i, ''));
      return html(200, `<!doctype html><html><head><title>Amazon.com.au : ${esc(u.searchParams.get('k'))}</title></head><body><div class="s-main-slot s-search-results">${hits.map((x) => `<div data-asin="${x.sku}" data-component-type="s-search-result" class="s-result-item">
        <img class="s-image" src="${imagePath(shop, x)}"><h2 aria-label="${esc(x.name)}" class="a-size-base-plus"><span>${esc(x.name)}</span></h2>
        ${x.status === 'in_stock' || x.status === 'preorder' ? `<span class="a-price"><span class="a-offscreen">$${x.price.toFixed(2)}</span></span>` : '<span class="a-color-secondary">Currently unavailable.</span>'}
      </div>`).join('')}</div></body></html>`);
    }
    // EB Games' search JSON (what its search page's own script asks for, and Mugibot's sweeps read) — with its
    // search page's filters too: category (trading-cards) and condition (preorder, new), with or without words.
    if (shop === 'ebgames' && sub === '/search/query') {
      const all = ebHits(u.searchParams);
      const day = 86400000;
      return json(200, {
        totalResults: all.length,
        aggregation: {},
        results: all.map((x) => ({
          sku: x.sku, title: x.name, productUrl: pathFor(shop, x).replace(/^\/ebgames/, ''), imageUrl: `http://${req.headers.host}${imagePath(shop, x)}`,
          price: x.was || x.price, promotionPrice: x.was ? x.price : null, isOutOfStock: x.status === 'out_of_stock', isUnavailable: false,
          isComingSoon: x.status === 'coming_soon', isPreowned: false, releaseDate: new Date(Date.now() + (x.status === 'preorder' ? 30 : -30) * day).toISOString(),
        })),
      });
    }
    // Kmart's search provider (Constructor.io) — what Mugibot's live sweeps read for Kmart: each
    // product with its sellers and the states it's out of stock in (every state: sold out online). Its
    // browse of the Trading Cards group is every listed product, with no keyword.
    // Its item lookup (/browse/items?ids=P_<keycode>): those products, by keycode — what Mugibot's server reads a Kmart
    // product's stock from (its pages turn servers away). (lookupDown: the provider refusing, HTTP 503.)
    const cio = shop === 'kmart' && (sub.match(/^\/cnstrc\/search\/([^/]+)$/) || sub.match(/^\/cnstrc\/browse\/group_id\/([^/]+)$/) || (sub === '/cnstrc/browse/items' && ['items']));
    if (cio) {
      const items = sub === '/cnstrc/browse/items';
      if (items) S.lookups = (S.lookups || 0) + 1;
      if (items && S.lookupDown) return json(503, { message: 'Service unavailable' });
      const browse = !items && sub.startsWith('/cnstrc/browse/');
      if (browse && state.cioBrowse === 'missing') return json(404, { message: 'Unknown group' });
      if (browse && state.cioBrowse === 'odd') return json(200, { nothing: 'here' });
      const ids = new Set(u.searchParams.getAll('ids'));
      const all = items ? shopOf(shop).products.filter((x) => x.listed && ids.has(`P_${x.sku}`))
        : browse ? shopOf(shop).products.filter((x) => x.listed) : searchHits(shop, decodeURIComponent(cio[1]));
      const per = Number(u.searchParams.get('num_results_per_page')) || 20;
      const pg = Number(u.searchParams.get('page')) || 1;
      const states = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
      return json(200, {
        response: {
          total_num_results: all.length,
          results: all.slice((pg - 1) * per, pg * per).map((x) => ({
            value: x.name,
            data: {
              id: `P_${x.sku}`, url: pathFor(shop, x).replace(/^\/kmart/, ''), image_url: `http://${req.headers.host}${imagePath(shop, x)}`, price: x.price,
              Seller: [x.marketplace ? 'Marketplace' : 'Kmart'], isPreOrderActive: x.status === 'preorder',
              ...(x.was ? { SavePrice: `WAS $${x.was}` } : {}),
              // (oosStates: in stock, but not in these states — e.g. only NSW and VIC have it.)
              ...(Array.isArray(x.oosStates) && (x.status === 'in_stock' || x.status === 'preorder') ? { stateOOS: Object.fromEntries(x.oosStates.map((st) => [st, '6'])) }
                : x.status === 'in_stock' || x.status === 'preorder' ? {} : { stateOOS: Object.fromEntries(states.map((st) => [st, '6'])) }),
              // (inStoreOnly: Kmart's "In store only" — FulfilmentChannel 2; 3 is delivery and click & collect.)
              FulfilmentChannel: x.inStoreOnly ? 2 : 3,
            },
          })),
        },
        request: { term: items ? '' : decodeURIComponent(cio[1]), page: pg },
      });
    }
    // JB Hi-Fi's collection pages: drawn by its own code once the page is open (none of its products in the page), and
    // its products.json shut — an empty list, like the real one's.
    const jbCol = shop === 'jbhifi' && sub.match(/^\/collections\/([^/]+)(\/products\.json)?$/);
    if (jbCol) return jbCol[2] ? json(200, { products: [] }) : html(200, clientSearchPage(shop, jbCol[1].replace(/-/g, ' ')));
    // Shopify's search suggestions (what Mugibot's live sweeps read at JB Hi-Fi).
    if (SHOPIFY.has(shop) && sub === '/search/suggest.json') {
      const hits = searchHits(shop, u.searchParams.get('q')).slice(0, 10);
      return json(200, {
        resources: {
          results: {
            products: hits.map((x, i) => ({
              id: x.id, handle: x.sku, title: x.name, price: x.price.toFixed(2), available: x.status === 'in_stock' || x.status === 'preorder',
              url: `${pathFor(shop, x)}?_pos=${i + 1}&_sid=dummy&_ss=r`, image: `http://${req.headers.host}${imagePath(shop, x)}`, vendor: 'Dummy', tags: [], type: 'TRADING CARDS',
            })),
          },
        },
      });
    }
    // From The Deep Games' collections (what Mugibot's live sweeps read there): each game's — its sealed products,
    // its pre-orders — its singles' (30,000 of them: never read, so none listed here), and every game's Preorders.
    if (shop === 'fromthedeep' && (sub === '/collections.json' || /^\/collections\/[^/]+\/products\.json$/.test(sub))) {
      const listed = shopOf(shop).products.filter((x) => x.listed);
      const has = (word) => (x) => slugify(x.name).includes(word);
      const pre = (x) => x.status === 'preorder';
      const cols = [
        ['pokemon-singles-all', 'Pokemon Singles (All)', () => false, 30328],
        ['pokemon-tcg', 'Pokemon TCG Sealed', (x) => has('pokemon')(x) && !pre(x)],
        ['pokemon-tcg-preorders', 'Pokemon TCG Preorders', (x) => has('pokemon')(x) && pre(x)],
        ['one-piece-card-game', 'One Piece Card Game', has('one-piece')],
        ['riftbound', 'Riftbound', has('riftbound')],
        ['gundam-card-game', 'Gundam Card Game', has('gundam')],
        ['preorders', 'Preorders', pre],
      ];
      if (sub === '/collections.json') return json(200, { collections: cols.map(([handle, title, f, n]) => ({ id: handle.length, handle, title, products_count: n ?? listed.filter(f).length })) });
      const col = cols.find(([handle]) => sub === `/collections/${handle}/products.json`);
      if (!col) return json(404, { errors: 'Not Found' });
      return json(200, {
        products: listed.filter(col[2]).map((x) => ({
          id: x.id, title: x.name, handle: x.sku, body_html: '<p>Dummy</p>', product_type: 'Pokemon Sealed', tags: pre(x) ? ['Preorder'] : [],
          variants: [{ id: x.id, title: 'Default Title', price: x.price.toFixed(2), compare_at_price: null, available: x.status === 'in_stock' || x.status === 'preorder' }],
          images: [{ src: `http://${req.headers.host}${imagePath(shop, x)}` }],
        })),
      });
    }
    // Shopify's collections and each one's product list (what Mugibot's live sweeps read at Trainer Town):
    // a collection per game, of the products whose name says it.
    if (shop === 'trainertown' && (sub === '/collections.json' || /^\/collections\/[^/]+\/products\.json$/.test(sub))) {
      const listed = shopOf(shop).products.filter((x) => x.listed);
      const games = [['pokemon-cards', 'Pokémon Cards', 'pokemon'], ['one-piece-trading-card-game', 'One Piece Trading Card Game', 'one-piece']];
      const inGame = (word) => listed.filter((x) => slugify(x.name).includes(word));
      if (sub === '/collections.json') return json(200, { collections: games.map(([handle, title, word]) => ({ id: handle.length, handle, title, products_count: inGame(word).length })) });
      const game = games.find(([handle]) => sub === `/collections/${handle}/products.json`);
      if (!game) return json(404, { errors: 'Not Found' });
      return json(200, {
        products: inGame(game[2]).map((x) => ({
          id: x.id, title: x.name, handle: x.sku, body_html: '<p>Dummy</p>', product_type: 'Trading Cards', tags: x.status === 'preorder' ? ['Pre-Order'] : [],
          variants: [{ id: x.id, title: 'Default Title', price: x.price.toFixed(2), compare_at_price: x.was ? x.was.toFixed(2) : null, available: x.status === 'in_stock' || x.status === 'preorder' }],
          images: [{ src: `http://${req.headers.host}${imagePath(shop, x)}` }],
        })),
      });
    }

    // Shopify's whole product list, newest first (what Mugibot's live sweeps read at Gamerholic, and JB Hi-Fi's newest
    // products): the last listed first, each with when it was made (createdAt: then, in ms; createdDaysAgo: one made long
    // ago and republished — JB does that all day) and, a marketplace seller's (JB's: seller), its "Seller" option.
    if (SHOPIFY.has(shop) && sub === '/products.json') {
      const listed = shopOf(shop).products.filter((x) => x.listed).slice().reverse();
      const day = 24 * 3600 * 1000;
      return json(200, { products: listed.slice(0, Number(u.searchParams.get('limit')) || 30).map((x) => ({
          id: x.id, title: x.name, handle: x.sku, body_html: '<p>Dummy</p>', product_type: 'Trading Cards', tags: x.status === 'preorder' ? ['Pre-Order'] : [],
          created_at: new Date(x.createdAt ?? Date.now() - (x.createdDaysAgo ?? 1) * day).toISOString(), published_at: new Date().toISOString(),
          options: [x.seller ? { name: 'Seller', position: 1, values: [x.seller] } : { name: 'Title', position: 1, values: ['Default Title'] }],
          variants: [{ id: x.id, title: 'Default Title', price: x.price.toFixed(2), compare_at_price: x.was ? x.was.toFixed(2) : null, available: x.status === 'in_stock' || x.status === 'preorder' }],
          images: [{ src: `http://${req.headers.host}${imagePath(shop, x)}` }],
        })) });
    }

    // ---------------- CrystalCommerce (The Games Cube): the cart API its pages use
    if (shop === 'thegamescube' && sub === '/api/v1/cart/line_items' && req.method === 'POST') {
      const b = await parseBody(req);
      S.addedAt = Date.now();
      const items = [];
      for (const li of (b.line_items || [])) {
        const prod = S.products.find((x) => x.id === Number(li.variant_id));
        if (prod && addToCart(shop, prod.sku, li.qty).ok) items.push({ id: prod.id, name: prod.name, qty: Number(li.qty) || 1, variant_id: prod.id, product_id: Number(prod.sku), price_cents: Math.round(prod.price * 100) });
      }
      return json(200, { line_items: items, count: bagCount(shop), errors: items.length ? undefined : { base: ['Out of stock'] } });
    }
    if (shop === 'thegamescube' && sub === '/api/v1/cart') {
      return json(200, { carts: [{ type: 'Order', currency: 'AUD', line_items_count: bagCount(shop), total_cents: Math.round(total(shop) * 100), links: { checkout: '/checkout/proceed_to_checkout', cart: '/checkout/cart' }, line_items: [] }] });
    }

    if (sub === '/api/cart/add' && req.method === 'POST') {
      const b = await parseBody(req);
      S.addedAt = Date.now();
      if (S.addNeedsLoad && !(req.headers.cookie || '').includes(`mgb_started=${S.startToken}`)) {
        S.refusedEarly = (S.refusedEarly || 0) + 1;
        return json(403, { ok: false, error: 'Forbidden' });
      }
      if (S.addDelayMs) await new Promise((r) => setTimeout(r, S.addDelayMs));
      const refuse = S.refuseAdds === true || (typeof S.refuseAdds === 'number' && S.refuseAdds > 0);
      if (typeof S.refuseAdds === 'number' && S.refuseAdds > 0) S.refuseAdds -= 1;
      const r = refuse ? { ok: false, said: S.quiet ? 'Something went wrong. Please try again.' : undefined } : addToCart(shop, b.sku, b.qty);
      return json(r.ok ? 200 : 409, r);
    }
    // ---------------- Clear cart: each shop's own way of taking a thing out of its bag (see cartPage)
    const takeOut = (sku) => {
      const i = S.cart.findIndex((c) => c.sku === sku);
      if (i === -1 || S.removeFails) return false;
      S.cart.splice(i, 1);
      S.removed += 1;
      return true;
    };
    const cartJson = () => ({ ok: true, items: bagCount(shop), total: total(shop), cart: S.cart.map((c) => ({ sku: c.sku, name: c.name, qty: c.qty })) });
    const variantOf = (c) => String((find(shop, c.sku) || {}).id);
    const shopifyCart = () => ({ token: 'dummy', item_count: bagCount(shop), total_price: Math.round(total(shop) * 100), items: S.cart.map((c) => ({ id: Number(variantOf(c)), quantity: c.qty, title: c.name, handle: c.sku, price: Math.round(c.price * 100) })) });
    if (sub === '/api/cart/remove' && req.method === 'POST') {
      const sku = String((await parseBody(req)).sku || '');
      if (S.removeDelayMs) await new Promise((r) => setTimeout(r, S.removeDelayMs));
      const ok = takeOut(sku);
      return json(ok ? 200 : 409, ok ? cartJson() : { ok: false });
    }
    if (shop === 'target' && sub === '/api/cart/undo' && req.method === 'POST') {
      const prod = find(shop, String((await parseBody(req)).sku || ''));
      S.undos += 1;
      if (prod) addToCart(shop, prod.sku, 1);
      return json(200, cartJson());
    }
    if (shop === 'ebgames' && sub === '/cart/remove' && req.method === 'POST') {
      takeOut(String((await parseBody(req)).sku || ''));
      return redirect('/ebgames/cart');
    }
    if (SHOPIFY.has(shop) && sub === '/cart/change') {
      const line = Number(u.searchParams.get('line'));
      const c = line ? S.cart[line - 1] : S.cart.find((x) => variantOf(x) === u.searchParams.get('id'));
      if (c && Number(u.searchParams.get('quantity')) === 0) takeOut(c.sku);
      return redirect(`/${shop}/cart`);
    }
    if (SHOPIFY.has(shop) && sub === '/cart/change.js' && req.method === 'POST') {
      const b = await parseBody(req);
      const c = S.cart.find((x) => variantOf(x) === String(b.id));
      if (c && Number(b.quantity) === 0) takeOut(c.sku);
      return json(200, shopifyCart());
    }
    if (SHOPIFY.has(shop) && (sub === '/cart.js' || sub === '/cart/clear.js')) {
      if (S.noAjaxCart) return json(404, { status: 404, message: 'Not Found' });
      if (sub === '/cart/clear.js' && req.method === 'POST') {
        S.cleared += 1;
        if (!S.removeFails) { S.removed += S.cart.length; S.cart = []; }
      }
      return json(200, shopifyCart());
    }
    if (shop === 'thegamescube' && sub.startsWith('/checkout/cart/remove/')) {
      const c = S.cart.find((x) => variantOf(x) === sub.split('/').pop());
      if (c) takeOut(c.sku);
      return redirect('/thegamescube/checkout/cart');
    }
    if (shop === 'amazon' && sub.startsWith('/gp/cart/') && req.method === 'POST') {
      const sku = String((await parseBody(req)).sku || '');
      if (sub === '/gp/cart/ajax-delete') { const ok = takeOut(sku); return json(ok ? 200 : 409, ok ? cartJson() : { ok: false }); }
      if (sub === '/gp/cart/save-for-later') {
        const c = S.cart.find((x) => x.sku === sku);
        if (c) { S.cart = S.cart.filter((x) => x !== c); S.saved.push({ sku: c.sku, name: c.name, price: c.price }); }
        S.savedMoves += 1;
        return json(200, cartJson());
      }
      if (sub === '/gp/cart/delete-saved') { S.saved = S.saved.filter((x) => x.sku !== sku); S.savedDeletes += 1; return json(200, cartJson()); }
      if (sub === '/gp/cart/move-to-cart') {
        const x = S.saved.find((y) => y.sku === sku);
        if (x) { S.saved = S.saved.filter((y) => y !== x); S.cart.push({ sku: x.sku, qty: 1, price: x.price, name: x.name }); }
        return json(200, cartJson());
      }
    }
    if ((shop === 'amazon' && sub === '/gp/cart/view.html') || (shop === 'target' && (sub === '/basket' || sub === '/basket/'))) {
      S.bagViews.push(bagCount(shop));
      return html(200, cartPage(shop));
    }
    // Shopify cart links: /cart/<variant>:<quantity> puts the product in the cart and opens checkout.
    const permalink = SHOPIFY.has(shop) && sub.match(/^\/cart\/(\d+):(\d+)$/);
    if (permalink) {
      const prod = S.products.find((x) => String(x.id) === permalink[1]);
      // (noPermalink: the link not taken — the product's page instead, nothing added.)
      if (prod && S.noPermalink) return redirect(`/${shop}/products/${prod.sku}`);
      if (prod) addToCart(shop, prod.sku, Number(permalink[2]) || 1);
      return redirect(pastCheckpoint() ? `/${shop}/checkouts/c/abc123` : `/${shop}/checkpoint?return_to=${encodeURIComponent(`/${shop}/checkouts/c/abc123`)}`);
    }
    // Shopify's /checkout (From The Deep Games' header cart links it): the cart's checkout — through the checkpoint
    // while it's up — or, with nothing in the cart, the cart page.
    if (SHOPIFY.has(shop) && (sub === '/checkout' || sub === '/checkout/') && req.method === 'GET') {
      if (!S.cart.length) return redirect(`/${shop}/cart`);
      S.checkoutLinks = (S.checkoutLinks || 0) + 1;
      return redirect(pastCheckpoint() ? `/${shop}/checkouts/c/abc123` : `/${shop}/checkpoint?return_to=${encodeURIComponent(`/${shop}/checkouts/c/abc123`)}`);
    }
    // Shopify's cart form posted with "Checkout" (Gameology's cart drawer, its button named checkout): on to the
    // cart's checkout (through the checkpoint while it's up); without it, the cart page.
    if (SHOPIFY.has(shop) && (sub === '/cart' || sub === '/cart/') && req.method === 'POST') {
      const b = await parseBody(req);
      if (!('checkout' in b) || !S.cart.length) return redirect(`/${shop}/cart`);
      S.drawerCheckouts = (S.drawerCheckouts || 0) + 1;
      return redirect(pastCheckpoint() ? `/${shop}/checkouts/c/abc123` : `/${shop}/checkpoint?return_to=${encodeURIComponent(`/${shop}/checkouts/c/abc123`)}`);
    }
    // Shopify's cart API add (what Gameology's theme sends its product form to): the line it added, or Shopify's 422.
    if (SHOPIFY.has(shop) && sub === '/cart/add.js' && req.method === 'POST') {
      const b = await parseBody(req);
      S.addedAt = Date.now();
      const prod = S.products.find((x) => String(x.id) === String(b.id));
      const r = prod ? addToCart(shop, prod.sku, Number(b.quantity) || 1) : { ok: false };
      if (!r.ok) return json(422, { status: 422, message: 'Cart Error', description: prod ? `${prod.name} is sold out.` : 'Cannot find variant' });
      S.ajaxAdds = (S.ajaxAdds || 0) + 1;
      return json(200, { id: prod.id, variant_id: prod.id, quantity: Number(b.quantity) || 1, title: prod.name, handle: prod.sku, price: Math.round(prod.price * 100) });
    }
    if (sub === '/cart/add' && SHOPIFY.has(shop)) {
      const prod = S.products.find((x) => String(x.id) === u.searchParams.get('id'));
      if (prod) addToCart(shop, prod.sku, Number(u.searchParams.get('quantity') || 1));
      return redirect(`/${shop}/cart`);
    }
    if (sub === '/api/cart/update' && req.method === 'POST') {
      const b = await parseBody(req);
      const line = S.cart.find((c) => c.sku === b.sku);
      if (!line) return json(404, { ok: false });
      line.qty = Math.max(1, Math.min(Number(find(shop, b.sku)?.maxQty) || 10, Number(b.qty) || 1));
      return json(200, { ok: true, qty: line.qty });
    }
    if (sub === '/cart' || sub === '/cart/') {
      S.bagViews.push(bagCount(shop));
      if (S.cartPopup && !S.cart.length) return redirect(`/${shop}/?cart=open`);
      return html(200, cartPage(shop));
    }
    if (sub === '/api/checkout/step' && req.method === 'POST') {
      const b = await parseBody(req);
      S.steps.push(b);
      S.data[b.step] = b.data;
      return json(200, { ok: true });
    }
    if (sub === '/checkout/place' && req.method === 'POST') {
      const b = await parseBody(req);
      S.placeTries += 1;
      if (S.placeSlowMs) await new Promise((r) => setTimeout(r, S.placeSlowMs));
      if (S.placeTries <= S.placeBusy) return json(503, { ok: false, error: S.placeBusyText || "We're experiencing high demand right now. Something went wrong — please try again." });
      if (S.decline) { S.declined = (S.declined || 0) + 1; return json(402, { ok: false, error: 'Your card was declined. Please try another card.' }); }
      if (S.threeDS === true) { S.challenged = (S.challenged || 0) + 1; return json(200, { ok: false, challenge: `${cardOrigin}/acs/challenge` }); }
      if (S.threeDS) {
        // The bank's check, as real checkouts put it up (bankJs): the order's placed once you approve it. (A form
        // posted — EB Games', Pokémon Center's: on the page that comes back, or the store sends the tab to the bank.)
        S.challenged = (S.challenged || 0) + 1;
        const bk = bankStart(shop, S.threeDS, () => { S.orders.push({ cart: S.cart.slice(), data: { ...S.data }, form: b, ts: Date.now(), bank: true }); S.cart = []; }, `/${shop}/checkout/confirmation`, req.headers.host);
        if (!/json/.test(req.headers['content-type'] || '')) return bankAnswer(res, shop, bk);
        return json(200, { ok: false, bank: bk });
      }
      S.orders.push({ cart: S.cart.slice(), data: { ...S.data }, form: b, ts: Date.now() });
      S.cart = [];
      return shop === 'ebgames' ? redirect('/ebgames/checkout/confirmation') : json(200, { ok: true });
    }
    if (sub === '/checkout/confirmation') return html(200, page(shop, 'Order confirmed', `<h1>Thank you for your order!</h1><p>Order number: DUMMY-${1000 + S.orders.length}</p>`));

    // ---------------- Amazon-style checkout: "Buy Now" → (signed out: sign in) → maybe the Prime offer
    // → checkout with the address and card saved in your Amazon account → "Place your order"
    if (shop === 'amazon') {
      const a = (title, body) => html(200, page(shop, title, body));
      const signedIn = !!state.signedIn.amazon;
      const line = () => S.cart.map((c) => `<li>${esc(c.name)} x ${c.qty}</li>`).join('');
      const summary = (place) => `<div class="a-box"><p>Delivering to Ash Ketchum, 1 Pallet Town Rd, Sydney NSW 2000</p><p>Paying with Visa ending in 4242</p>
        <ul>${line()}</ul><p class="order-total">Order total: $${total(shop).toFixed(2)}</p>
        <form method="post" action="${place}"><span class="a-button"><input type="submit" id="placeYourOrder" class="a-button-input" aria-labelledby="pyo-text"><span id="pyo-text" class="a-button-text">Place your order</span></span></form></div>`;
      if (sub === '/checkout/entry/buynow' && req.method === 'POST') {
        const b = await parseBody(req);
        if (!signedIn) return redirect('/amazon/ap/signin?openid.return_to=checkout');
        const prod = find(shop, b.asin);
        S.cart = prod ? [{ sku: prod.sku, qty: Math.max(1, Math.min(Number(prod.maxQty) || 10, Number(b.quantity) || 1)), price: prod.price, name: prod.name }] : [];
        S.steps.push({ step: 'buynow' });
        return redirect(S.primeOffer && !S.primeDeclined ? '/amazon/gp/buy/primeinterstitial/handlers/display.html' : '/amazon/checkout/p/p-123/spc');
      }
      // Your Account: signed out, Amazon sends you to sign in.
      if (sub === '/gp/css/homepage.html') return signedIn ? a('Your Account', '<h1>Your Account</h1>') : redirect('/amazon/ap/signin?openid.return_to=homepage');
      if (sub === '/ap/signin') return a('Amazon Sign-In','<h1>Sign in</h1><label>Email or mobile phone number <input name="email" type="email"></label><button type="button">Continue</button>');
      if (sub === '/gp/buy/primeinterstitial/handlers/display.html') {
        return a('Try Prime', `<h1>Try Prime FREE for 30 days</h1><p>Get FREE fast delivery on this order and millions of items.</p>
          <form method="post" action="/amazon/gp/buy/primeinterstitial/join"><button type="submit" id="prime-join">Start your free trial</button></form>
          <p><a id="prime-decline" href="/amazon/gp/buy/primeinterstitial/decline">No thanks</a></p>`);
      }
      if (sub === '/gp/buy/primeinterstitial/join') { S.joinedPrime = true; return redirect('/amazon/checkout/p/p-123/spc'); }
      if (sub === '/gp/buy/primeinterstitial/decline') { S.primeDeclined = true; S.steps.push({ step: 'prime-declined' }); return redirect('/amazon/checkout/p/p-123/spc'); }
      if (sub === '/checkout/p/p-123/spc') return a('Checkout', `<h1>Review your order</h1>${summary('/amazon/checkout/spc/place-order')}`);
      if (sub === '/checkout/turbo') {
        const prod = find(shop, u.searchParams.get('asin'));
        S.cart = prod ? [{ sku: prod.sku, qty: Math.max(1, Math.min(Number(prod.maxQty) || 10, Number(u.searchParams.get('quantity')) || 1)), price: prod.price, name: prod.name }] : [];
        S.steps.push({ step: 'turbo' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html><body style="font:14px system-ui;margin:8px"><h3>Buy now</h3>${summary('/amazon/checkout/turbo/place')}</body></html>`);
      }
      if ((sub === '/checkout/spc/place-order' || sub === '/checkout/turbo/place') && req.method === 'POST') {
        if (S.decline) { S.declined = (S.declined || 0) + 1; return a('Checkout', '<p class="err" role="alert">Your payment was declined. Please choose another payment method.</p>'); }
        if (S.threeDS && !sub.includes('turbo')) {
          S.challenged = (S.challenged || 0) + 1;
          return bankAnswer(res, shop, bankStart(shop, S.threeDS, () => { S.orders.push({ cart: S.cart.slice(), data: { ...S.data }, turbo: false, ts: Date.now() }); S.cart = []; }, '/amazon/gp/buy/thankyou/handlers/display.html', req.headers.host));
        }
        S.orders.push({ cart: S.cart.slice(), data: { ...S.data }, turbo: sub.includes('turbo'), ts: Date.now() });
        S.cart = [];
        if (sub.includes('turbo')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><html><body style="font:14px system-ui"><h3>Order placed, thanks!</h3><p>Your order has been placed.</p></body></html>'); }
        return redirect('/amazon/gp/buy/thankyou/handlers/display.html');
      }
      if (sub === '/gp/buy/thankyou/handlers/display.html') return a('Thank you', '<h1>Order placed, thanks!</h1><p>Your order has been placed. Confirmation will be sent to your email.</p>');
    }

    // ---------------- Kmart-style one-page checkout
    if (shop === 'kmart' && sub === '/checkout') {
      // (Like kmart.com.au: checkout with an empty bag opens the bag instead.)
      if (!S.cart.length) return redirect('/kmart/cart');
      return html(200, page(shop, 'Checkout', kmartCheckout()));
    }
    // ---------------- City Beach-style checkout (its stages in ?stage=; an empty bag opens the bag)
    if (shop === 'citybeach' && sub === '/checkout') {
      if (!S.cart.length) return redirect('/citybeach/cart');
      if (!u.searchParams.get('stage')) return redirect('/citybeach/checkout?stage=customer#customer');
      return html(200, page(shop, 'Checkout', citybeachCheckout()));
    }
    // ---------------- Target-style one-page checkout (/checkout opens it at /spc/order)
    if (shop === 'target' && sub === '/checkout') return redirect('/target/spc/order');
    if (shop === 'target' && sub === '/spc/order') return html(200, page(shop, 'Checkout', targetCheckout()));
    // ---------------- BIG W-style checkout
    if (shop === 'bigw' && sub === '/checkout') return html(200, page(shop, 'Checkout', bigwCheckout()));

    // ---------------- EB Games-style one-page checkout, as the real one goes
    if (shop === 'ebgames' && sub === '/checkout') {
      if (!S.cart.length) return redirect('/ebgames/cart');
      return html(200, page(shop, 'Checkout', ebgamesCheckout()));
    }

    // ---------------- CrystalCommerce checkout (The Games Cube): guest → address → shipping and payment
    if (shop === 'thegamescube' && sub.startsWith('/checkout')) {
      const gc = (title, body) => html(200, page(shop, title, body));
      if (sub === '/checkout/cart') {
        S.bagViews.push(bagCount(shop));
        return html(200, cartPage(shop));
      }
      if (sub === '/checkout/proceed_to_checkout') {
        return gc('Checkout', '<p>Proceeding to checkout... <a id="proceed-to-checkout-manually" href="/thegamescube/checkout/index">Click here if you are not redirected automatically.</a></p><script>setTimeout(() => { location.href = "/thegamescube/checkout/index"; }, 300);</script>');
      }
      if (sub === '/checkout/customers' && req.method === 'POST') {
        const b = await parseBody(req);
        S.steps.push({ step: 'guest' });
        S.data.contact = { name: b['customer[fullname]'], email: b['customer[email]'] };
        return redirect('/thegamescube/checkout/index');
      }
      if (sub === '/checkout/address' && req.method === 'POST') {
        const b = await parseBody(req);
        S.steps.push({ step: 'address' });
        S.data.address = b;
        return redirect('/thegamescube/checkout/index');
      }
      if (sub === '/checkout/create' && req.method === 'POST') {
        S.orders.push({ cart: S.cart.slice(), data: { ...S.data }, form: await parseBody(req), ts: Date.now() });
        S.cart = [];
        return gc('Order complete', '<h1>Thank you for your order!</h1>');
      }
      if (sub === '/checkout/index') {
        const lines = S.cart.map((c) => `<li>${esc(c.name)} x ${c.qty}</li>`).join('') || '<li>Your cart is empty</li>';
        if (!S.data.contact) {
          return gc('Checkout', `<h2>Checkout is fast, easy, and secure</h2>
            <form action="/thegamescube/checkout/session" method="post" id="existing_member_form"><h3>Sign in</h3>
              <label for="existing_customer_email">Email</label><input id="existing_customer_email" name="customer[email]" type="text">
              <label for="existing_customer_password">Password</label><input id="existing_customer_password" name="customer[password]" type="password">
              <input class="btn btn--login" name="commit" type="submit" value="Login"></form>
            <form action="/thegamescube/checkout/customers" method="post" id="new_member_form"><h3>Checkout as a guest</h3><p>Continue as a guest. You may create an account after checkout.</p>
              <label for="customer_fullname">Name</label><input id="customer_fullname" name="customer[fullname]" type="text">
              <label for="customer_email">Email</label><input id="customer_email" name="customer[email]" type="text">
              <input class="btn btn--neutral" id="customer_submit" name="commit" type="submit" value="Checkout as a guest"></form>
            <h3>Your Cart</h3><ul>${lines}</ul>`);
        }
        if (!S.data.address) {
          return gc('Checkout', `<h2>1. Shipping Address</h2><form action="/thegamescube/checkout/address" method="post">
            <label>First Name <input name="address[first_name]" autocomplete="shipping given-name" required></label>
            <label>Last Name <input name="address[last_name]" autocomplete="shipping family-name" required></label>
            <label>Address Line 1 <input name="address[street]" autocomplete="shipping address-line1" required></label>
            <label>Address line 2 (Optional) <input name="address[street2]" autocomplete="shipping address-line2"></label>
            <label>City <input name="address[city]" autocomplete="shipping address-level2" required></label>
            <label>State (Abbrev.) <input name="address[state]" required maxlength="3" style="width:80px"></label>
            <label>Zip <input name="address[postcode]" required></label>
            <label>Country <select name="address[country]" required><option value="">Select Country</option><option value="NZ">New Zealand</option><option value="AU">Australia</option></select></label>
            <label>Phone <input name="address[phone]" type="tel" autocomplete="tel" required></label>
            <button type="submit">Continue</button></form><h3>Your Cart</h3><ul>${lines}</ul>`);
        }
        return gc('Checkout', `<form action="/thegamescube/checkout/create" method="post" id="place_order_form">
          <h2>2. Shipping Method</h2>
          <h4>Pick Up</h4><label><input type="radio" name="shipping" value="pickup"> Pick up in store (free)</label>
          <h4>Parcel Post</h4>
          <label><input type="radio" name="shipping" value="parcel"> Australia Post (2-6 business days) — AUD$ 10.00</label>
          <label><input type="radio" name="shipping" value="parcel_tracked"> Australia Post Tracked — AUD$ 14.00</label>
          <h4>Express Post</h4><label><input type="radio" name="shipping" value="express"> Australia Post Express — AUD$ 18.00</label>
          <h2>3. Payment Method</h2>
          <p>Total: AUD$ ${(total(shop) + 10).toFixed(2)}</p>
          <button type="button" id="paypal-checkout" class="paypal-button" onclick="document.title='paypal'">Checkout with PayPal</button>
          <h3>Your Cart</h3><ul>${lines}</ul></form>
          <script>for (const r of document.querySelectorAll('input[name=shipping]')) r.addEventListener('change', () => fetch('/thegamescube/api/checkout/step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: 'shipping', data: { shipping: r.value } }) }));</script>`);
      }
    }

    // ---------------- Pokémon Center-style checkout: guest → shipping → payment (card frame)
    if (shop === 'pokemoncenter' && sub.startsWith('/checkout')) {
      if (sub === '/checkout' && req.method === 'POST') {
        const b = await parseBody(req);
        S.data[b.step] = b;
        S.steps.push({ step: b.step });
        return redirect('/pokemoncenter/checkout');
      }
      const lines = S.cart.map((c) => `<li>${esc(c.name)} x ${c.qty}</li>`).join('');
      if (!S.data.guest) {
        return html(200, page(shop, 'Checkout', `<h1>Checkout</h1><form method="post"><input type="hidden" name="step" value="guest">
          <label>Email address <input name="email" type="email" autocomplete="email" required></label>
          <button type="submit">Continue as Guest</button></form><ul>${lines}</ul>`));
      }
      if (!S.data.shipping) {
        return html(200, page(shop, 'Checkout', `<h1>Shipping</h1><form method="post"><input type="hidden" name="step" value="shipping">
          <label>First name <input name="firstName" autocomplete="given-name" required></label>
          <label>Last name <input name="lastName" autocomplete="family-name" required></label>
          <label>Street address <input name="address1" autocomplete="address-line1" required></label>
          <label>Apartment, unit (optional) <input name="address2" autocomplete="address-line2"></label>
          <label>Suburb <input name="city" autocomplete="address-level2" required></label>
          <label>State <select name="state" autocomplete="address-level1" required>${STATES}</select></label>
          <label>Postcode <input name="postcode" autocomplete="postal-code" required></label>
          <label>Phone number <input name="phone" type="tel" autocomplete="tel" required></label>
          <button type="submit">Continue to Payment</button></form>`));
      }
      return html(200, page(shop, 'Checkout', `<h1>Payment</h1><p>Shipping to ${esc(S.data.shipping.address1)}</p>
        <p><b>Pay with card</b></p>${cardBoxes('generic')}<form action="/pokemoncenter/checkout/place" method="post"><button type="submit">Place Order</button></form>`));
    }

    // ---------------- Premium Bandai-style checkout: the whole checkout in a Global-e-style frame
    if (shop === 'pbandai' && sub === '/checkout') {
      S.data.checkoutOpened = Date.now();
      return html(200, page(shop, 'Checkout', `<h1>Checkout</h1><p>Your order is handled by our checkout partner.</p>
        <iframe id="ge-frame" src="${cardOrigin}/ge-checkout" width="600" height="1100" style="border:1px solid #ccc"></iframe>
        <script>addEventListener('message', (e) => { if (e.data && e.data.gePlaced) location.href = '/pbandai/checkout/confirmation'; });</script>`));
    }

    // ---------------- Shopify-style one-page checkout (JB Hi-Fi, Trainer Town, Gamerholic, Toys"R"Us)
    if (SHOPIFY.has(shop) && sub.startsWith('/checkouts/c/abc123')) {
      if (sub.endsWith('/thank-you')) return html(200, page(shop, 'Thank you', '<h1>Thank you for your purchase!</h1><p>Your order is confirmed.</p>'));
      if (!pastCheckpoint()) return redirect(`/${shop}/checkpoint?return_to=${encodeURIComponent(`/${shop}/checkouts/c/abc123`)}`);
      if (req.method === 'POST') {
        const b = await parseBody(req);
        const shopPay = state.signedIn[shop] === 'shop';
        // Like Shopify: no shipping method, or no card (unless Shop Pay has one), and it's not placed.
        if (b.deliveryMethod === 'pickup' && !b.pickupLocation) return html(200, page(shop, 'Checkout', '<p class="err" role="alert">Choose a pickup location</p>'));
        if (!b.shipping && b.deliveryMethod !== 'pickup') return html(200, page(shop, 'Checkout', '<p class="err" role="alert">Choose a shipping method</p>'));
        if (!shopPay && !b.card_number) return html(200, page(shop, 'Checkout', '<p class="err" role="alert">Enter a card number</p>'));
        if (S.decline) { S.declined = (S.declined || 0) + 1; return html(200, page(shop, 'Checkout', '<p class="err" role="alert">Your card was declined. Please try another card.</p>')); }
        if (S.threeDS) {
          S.challenged = (S.challenged || 0) + 1;
          return bankAnswer(res, shop, bankStart(shop, S.threeDS, () => { S.orders.push({ form: b, cart: S.cart.slice(), shopPay }); S.cart = []; }, `/${shop}/checkouts/c/abc123/thank-you`, req.headers.host));
        }
        S.orders.push({ form: b, cart: S.cart.slice(), shopPay });
        S.cart = [];
        return redirect(`/${shop}/checkouts/c/abc123/thank-you`);
      }
      S.data.checkoutOpened = Date.now();
      return html(200, page(shop, `Checkout - ${SHOPS[shop].name}`, shopifyCheckout(shop)));
    }

    return html(404, page(shop, 'Page not found', '<h1>Sorry, we can\'t find that page</h1>'));
  });

  const listen = (srv, p) => new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(p, host, () => { srv.off('error', reject); resolve(); });
  });
  // Listening on every interface (0.0.0.0) still means "this computer" in links.
  const linkHost = ['0.0.0.0', '::'].includes(host) ? 'localhost' : host;
  await listen(cardServer, cardPort);
  cardOrigin = `http://${linkHost}:${cardServer.address().port}`;
  try {
    await listen(server, port);
  } catch (e) {
    cardServer.close();
    throw e;
  }
  const url = `http://${linkHost}:${server.address().port}`;

  return {
    url,
    cardOrigin,
    state,
    shop: (id) => state.shops[id],
    productUrl: (shop, sku) => url + pathFor(shop, find(shop, sku)),
    set(shop, sku, fields) { Object.assign(find(shop, sku), fields); },
    /** Another product at a shop (gone again at reset): { sku, name, price, status, listed }. */
    addProduct(shop, p) {
      const list = shopOf(shop).products;
      const prod = { listed: true, maxQty: 0, qtyStyle: shop === 'bigw' ? 'select' : 'input', lateMs: 0, id: 4400000 + list.length + 50, ...p };
      list.push(prod);
      return url + pathFor(shop, prod);
    },
    /** Acme Collectibles (another website): its address, and a product's page. */
    acmeUrl: (handle = '') => `${url}/acme${handle ? `/products/${handle}` : ''}`,
    setAcme(handle, fields) { Object.assign(state.acme.products.find((x) => x.handle === handle), fields); },
    /** The store that checks out with Shop: a cart link for its options ([[variantId, qty], …]), and an option's stock. */
    cartLink: (lines) => `${url}/creations/cart/${lines.map(([id, qty]) => `${id}:${qty}`).join(',')}`,
    setVariant(id, fields) { Object.assign(state.shopapp.variants.find((x) => String(x.id) === String(id)), fields); },
    reset() {
      const fresh = defaultShops();
      for (const id of Object.keys(fresh)) state.shops[id] = fresh[id];
      state.acme = defaultAcme();
      state.shopapp = defaultShopApp();
      state.account = null;
      state.cardInIframe = false;
      state.blockNonBrowsers = false;
      state.signedIn = {};
      state.bank = {};
    },
    /** You approve the payment in your bank's app: every bank check waiting is passed, its order placed. */
    approveBank() {
      for (const x of Object.values(state.bank)) {
        if (x.approved) continue;
        x.approved = true;
        x.place();
      }
    },
    close: () => Promise.all([
      new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
      new Promise((r) => { cardServer.close(() => r()); cardServer.closeAllConnections?.(); }),
    ]),
  };
}
