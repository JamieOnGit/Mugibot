# Retailer flows

Every store has its own checkout flow in `server/retailers/<store>.js`. A flow
says which buttons to press, in what order, where the store's checkout page is,
and which button is the **final one**. ⚡ Buy never presses the final button;
only Auto-checkout does, for members who switched it on and armed the item
([AUTO-CHECKOUT.md](AUTO-CHECKOUT.md)).

⚡ Buy buys **one** of each product (quantities are off for now) and gets to
checkout as fast as the store allows:

- **Shopify stores** (JB Hi-Fi, Trainer Town, Gamerholic, Toys"R"Us, Pokébox, Good Games,
  Collectible Madness, Cherry Collectables): the store's own cart
  link, `/cart/<variant>:1`, which opens checkout with the product in the cart.
  When the monitor has seen the product, the dashboard's ⚡ Buy opens that link
  straight away — no product page at all. Otherwise the product page opens, the
  extension looks up the product's option (`/products/<handle>.js`) and opens
  the cart link from there.
- **WooCommerce stores** (Games World): the same idea with WooCommerce's own
  add-to-cart link, `/checkout/?add-to-cart=<id>&quantity=1` — checkout, with the
  product in the cart. The id is a simple product's (read from its product page,
  or from the monitor's search); a product with options goes through its Add button.
  The link's `add-to-cart` is taken off the address once checkout's open, so a
  reload never adds it twice.
- **Other stores**: Add to bag is pressed **the moment the store's page can take
  it**. Pages built with React or Vue (Kmart's) show the button before their code
  has wired it up, and a press then does nothing; the extension looks inside the
  page and presses as soon as the button is wired up, usually long before the
  page has finished loading. Pages it can't see into wait for the page to load
  plus `settleMs`. As soon as the store shows it went in, it goes **straight to
  the checkout page** (`checkout.url`, e.g. Kmart's `/checkout`), or presses the
  "added" popup's own Checkout button. Only stores with neither go through the
  bag page.

| Store | File | Status | Notes |
|---|---|---|---|
| Kmart | `kmart.js` | ✅ **verified** | Tested end to end on kmart.com.au signed in. Signed out, the same flow: Kmart's cart can turn the first add away while its page starts up — Mugibot sees it refused, waits for the page to load and presses Add once more. Card boxes: Adyen's, one frame per box. Stops at "Checkout securely". |
| BIG W | `bigw.js` | 🟦 beta | Tested on the BIG W-style dummy store only. **Waiting for the real flow.** |
| EB Games | `ebgames.js` | 🟦 beta | From a member's walk-through (Oct 2026): "Home Delivery" (EB picks Click & Collect for you) → Australia → the address from EB's suggestions → its shipping method → Pay Now: "Credit / Debit card" → card number, MM/YY, CVV, name on card → "Done" → "CONFIRM & PAY". Signed in: only "CONFIRM & PAY". |
| JB Hi-Fi | `jbhifi.js` | 🟦 beta | Shopify, its cart link (`/cart/<variant>:1`). The card goes into Shopify's card fields (a frame per box, from `checkout.pci.shopifyinc.com`). Stops at "Pay now". |
| Target | `target.js` | 🟦 beta | From a member's walk-through: "Home Delivery" (a tile) → your details → the address from Target's suggestions → "Credit Card" (a tile) → card in Paydock's form (`*.paydock.com`) → "Place order". |
| Zing | `zing.js` | 🟨 draft | Uses the EB Games flow (same platform). Off: zingpopculture.com.au sends you to EB Games. |
| Toys"R"Us | `toysrus.js` | 🟦 beta | Shopify, at **toysrus.com.au** (www. sends you there). Shop Pay (signed in to Shop) or your details and card; "Standard Shipping - AusPost"; Authority to leave and "use shipping address as billing" left ticked; "Pay now". |
| Trainer Town | `trainertown.js` | 🟨 draft | Uses the Shopify flow; tested on the Shopify-style dummy store (`/trainertown`), not on trainertown.com.au yet. |
| Gamerholic | `gamerholic.js` | 🟦 beta | Shopify. Shop Pay or your details; "Standard Shipping"; card number, expiry, security code (no name box); "Pay now". |
| The Games Cube | `thegamescube.js` | 🟦 beta | CrystalCommerce. Its icon-only cart button → straight to checkout → guest → shipping address → the first "Parcel Post" option → **"Checkout with PayPal" only**: ⚡ Buy and Auto-checkout stop there for you (`payment: 'paypal'`). |
| Pokémon Center | `pokemoncenter.js` | 🟨 draft | Australia only (`/en-au`). Its bot check turns servers away, so its checkout couldn't be seen: a best guess, tested on a dummy copy only. During big drops it may queue everyone first; ⚡ Buy waits like you do. |
| Premium Bandai | `pbandai.js` | 🟦 beta | Australia only (`/au`). "PLACE PRE-ORDER" → "View Cart" → "Proceed to Checkout" → Global-e's checkout in a frame (`checkout.frames`: filled in there, by `frame.js`) — area, state, phone after its +61, card with month/year drop-downs, the purchase agreement → "Pay and Place Order". Signed in: "Default (same as billing address)". Guests too. |
| Amazon AU | `amazon.js` | 🟦 beta | **Signed in only** (no guest checkout: the panel and dashboard say so). "Buy Now" → "No thanks" to Prime → your Amazon address and card → "Place your order". Its quick checkout (a window over the product page) is filled in its frame. |
| City Beach | `citybeach.js` | 🟨 draft | Australia only (`/au`). Salesforce Commerce Cloud. Built from its real pages up to the final button: "Add To Bag" → straight to `/au/checkout` → your email → "Continue as guest" → "Delivery" → delivery to your address → "Submit shipping" → card (in the payment provider's frame) → "Confirm & pay". If a last "place order" stage follows (`?stage=placeOrder`, `checkout.review`), Auto-checkout presses its button once. Its marketing pop-up doesn't get in the way. Tested on the City Beach-style dummy store (`/citybeach`), not end to end on citybeach.com yet. |
| Pokébox | `pokebox.js` | 🟦 beta | Shopify. Its cart link → signed in with Shop: "Pay now"; as a guest: name, address (Shopify's suggestions come up; suburb, state/territory and postcode are typed too), phone → the shipping method Shopify picked, left as it is → card number, MM/YY, security code, name on card, "Use shipping address as billing address" ticked (`tick`) → "Pay now". |
| Good Games | `goodgames.js` | 🟦 beta | The same as Pokébox (Shopify). |
| Collectible Madness | `collectiblemadness.js` | 🟦 beta | The same as Pokébox (Shopify), at **collectiblemadness.com.au** (www. sends you there). |
| Cherry Collectables | `cherrycollectables.js` | 🟦 beta | The same as Pokébox (Shopify). |
| The Gamesmen | `gamesmen.js` | 🟦 beta | Magento (its Hyvä theme: its search tiles are `div[data-ga-type="product-list-item"]`, read by `gamesmenTiles` in `listing.js` from a copy of its real page; searched newest first). From a member's walk-through (Oct 2026): "Add to Cart" / "Pre-order" → "You added … to your shopping cart" → straight to checkout → Shipping Address (email, first and last name, street address, suburb, state/territory, postcode, country Australia, mobile / phone) → "I have a different billing address" left unticked (`untick`) → Shipping Methods: "Standard", else the first one offered (`shippingFallback: 'first'`) → "Credit card" → card number, expiry, security code → the terms box ticked → "CONFIRM AND PAY". Signed in with your address saved: the same without the address. Its card form's provider wasn't visible from outside: the general card rules cover the usual ones. |
| Shop checkout links | `shoplink.js` | 🟦 beta | Not one store: **any store's own cart link** (`…/cart/<variant>:<qty>,<variant>:<qty>`, e.g. Mattel Creations') at a store that checks out with Shop. A cart link at a store Mugibot doesn't know is one of these (`cartLinks`); the link opens Shop's checkout (`shop.app/checkout/…/shoppay`, where the extension runs) with your Shop address, delivery and card in. Nothing of yours is typed (`ownDetails`); the store's boxes are ticked — its membership agreement (`tick`) and any box marked required (`tickRequired`), never newsletters — "Check out as guest" is never pressed (`notFinal`), its "You must accept membership agreement" notice isn't a reason to stop (`ignoreErrors`), and nor is "not available for purchase" before it's pressed: answered that when "Pay now" is pressed, the run waits on the checkout, looking again every 5 s, and presses again once the notice has gone (`unavailable` + `waitLive`, 30 minutes at most). → "Pay now". Shop then goes on to the store's own order page, another address (`leaves`): that's the order placed. **Signed in to Shop only**: signed out, the link goes to the store's guest checkout, where Mugibot doesn't run. Sign-in is read off Shop's checkout screen (`account.check.onScreen`: your email, "Check out as guest") — never fetched, never from a page's source — and a "signed out" reading never holds a run back (`startsSignedOut`). Checked every 5 s (`monitor.intervalSeconds`, `floorSeconds`). Extension 1.24.0 (`acoVersion`). Tested on a Shop-style dummy checkout (`/creations` + `/shopapp`). |
| Games World | `gamesworld.js` | 🟦 beta | WooCommerce. Its add-to-cart link (`/checkout/?add-to-cart=<id>&quantity=1`, a simple product's id) → checkout: email, first and last name, Country/Region, street address, suburb, state (selectWoo's drop-down over the real one), postcode, phone → "Deliver to a different address?" unticked (it can come ticked) → Standard Shipping → Stripe's card form (card number, MM/YY, security code), or with Stripe's Link connected its card and "Confirm" (`frameConfirm`) → "Place order". Signed in, your saved details are left as they are. |

- **verified**: tested on the real store.
- **beta**: tested on that store's dummy copy (`npm run demo`) in the automated tests.
- **draft**: not tested anywhere yet. The panel warns members to watch each step.

Flows are sent from the server to every member's extension, so **a fixed flow
reaches everyone without reinstalling**. Only a brand-new store needs a new
extension build, because its address goes into the extension's permissions.

---

## How to send me a store's flow (e.g. BIG W)

Do one real checkout, signed **out** of the store (guest), with a cheap
in-stock item, **stopping before the final button**. At each step write down
(or screenshot) the following:

1. **Product page**
   - The product link (e.g. `https://www.bigw.com.au/product/…/p/123456`).
   - The exact label of the add button ("Add to cart", "Add to trolley", "Pre-order").
2. **After adding**
   - Does a popup, drawer or "added" message appear? What buttons does it have
     ("Checkout", "View cart", "Continue shopping")?
   - Or does it go straight to the cart page?
3. **Cart page** (if there is one)
   - Its address (e.g. `/cart`), and the checkout button's label ("Proceed to checkout").
   - The checkout page's address you land on (e.g. `/checkout`): ⚡ Buy can go
     straight there once the item is in the bag.
4. **Checkout, step by step.** For each screen:
   - Its address (e.g. `/checkout`, `/checkout/delivery`).
   - Sign in or guest? The guest button's label ("Continue as guest").
   - Choices to make: delivery vs click & collect, as buttons or as round
     radio options? Their labels.
   - The fields asked for: email, name, phone, address. Is there an "address
     finder" box, and a link like "Enter address manually"?
   - The button to go on ("Continue to payment", "Next").
5. **Payment screen**
   - Card boxes on the page, or inside a box that looks like a separate frame?
   - Payment choices (card, PayPal, Afterpay) and their labels.
   - Terms checkbox? Marketing checkbox?
   - **The final button's exact label** ("Place order", "Pay now").
6. Anything odd: a queue page, a "verify you're human" check, a pop-up asking
   to sign in, a forced account.

Screenshots of each step are the most useful. Hide your personal details in them.

## What changes in the code

The flow file gets updated (labels, paths, choices, field fixes), the dummy
store's copy of that shop gets updated to match, and the end-to-end test
proves the flow stops at the final button. Then you do one real run to verify,
and the status becomes `verified`.

---

## The flow format

```js
// server/retailers/bigw.js
export default {
  id: 'bigw',                       // never change once members use it
  name: 'BIG W',
  base: 'https://www.bigw.com.au',
  hosts: ['www.bigw.com.au'],       // the extension runs here
  devPath: '/bigw',                 // this store's copy in the dummy store
  flowStatus: 'beta',               // 'verified' | 'beta' | 'draft'
  flowNote: 'Shown to members next to the store.',
  skuLabel: 'Product code',         // what the store calls its SKU
  skuHint: 'The number after /p/ in the link',
  skuFromPath: /\/p\/(\d+)/,        // reads the SKU out of a product link
  productPath: /^(\/bigw)?\/product\/[^/]+\/p\/\d+/,  // what a product link looks like (for search results)
  searchPath: '/search?text={q}',   // where a SKU is looked for before it has a link
  // productPathFromSku: '/products/{sku}',   // stores whose link is built from the SKU (Shopify, Amazon)
  // cartPath: '/cart/{variant}:{qty}',       // Shopify: the store's cart link (⚡ Buy goes straight to checkout with it)
  //   WooCommerce: '/checkout/?add-to-cart={variant}&quantity={qty}' (with platform: 'woocommerce')
  // platform: 'shopify',             // 'shopify' | 'woocommerce' | 'magento': the store's platform, where Mugibot
  //                                  //   uses something of its own (a cart link, the bag emptied at once)
  monitor: { server: true, browser: true },   // default for server / in-browser checks (admins can switch)
  flow: {
    product: {
      add: ADD_WORDS,               // the add button's label(s) — the shared words (server/monitor/words.js), below

      // buyNow: [/^buy now$/i],    // a button straight to checkout (Amazon): pressed instead of Add, when it's there
      addSelector: null,            // optional CSS selector for the add button
      waitMs: 12000,                // how long to wait for the add button on a fresh page
      readyMs: 8000,                // a React / Vue page: how long to wait for its code to wire up Add
      settleMs: 400,                // pages Mugibot can't see into: after the page has loaded, wait this long before pressing Add
    },
    added: {                        // the popup / drawer after adding
      checkout: [/^(secure )?check ?out( now)?$/i],
      viewBag: [/\bview (cart|trolley)\b/i],
      confirm: [/added to (your )?trolley/i],   // optional: the store's "added" message
      upsell: [/often bought together/i],       // optional: an "add more" pop-up's wording — closed with its ✕, never accepted
    },
    bag: {                          // the cart page
      path: /\/cart(\/|$)/i,
      checkout: [/^proceed to checkout$/i],
      // url: '/gp/cart/view.html',  // optional: its address, when it isn't /cart (opened when nothing on the page leads there,
      //                             //   and by Clear cart)
      // clear: {                    // optional, for Clear cart (extension/bag.js):
      //   scope: '#sc-active-cart', //   only what's in here is the bag (Amazon: not its "Saved for later" below)
      //   remove: [/^bin it$/i],    //   a line's Remove, when it's called something other than Remove / Delete / a bin / ×
      // },
    },
    checkout: {
      path: /\/checkout(\/|$)/i,
      url: '/checkout',                             // optional: go straight here once it's in the bag
      inFrame: false,                               // the whole checkout in a frame (Global-e): filled in there
      guest: [/^continue as (a )?guest$/i],         // pressed to check out as a guest
      choose: [/^home delivery$/i],                 // buttons to press once each (not radios)
      steps: [/^continue to payment$/i, /^continue$/i],   // "next step" buttons
      final: [/\bplace (my |your )?order\b/i],      // where ⚡ Buy stops (only Auto-checkout presses it)
      manual: [/enter address manually/i],          // optional: extra "type the address yourself" links
      fields: { 'input[name="mobile"]': 'phone' },  // optional: CSS selector → which detail goes there
      delivery: 'home',                             // pick home delivery (never click & collect) — even over the store's own default
      payment: 'card',                              // pick card payment ('account': the card saved in the store account, e.g. Amazon;
                                                    //   'paypal': the store only takes PayPal — stop there, Auto-checkout too)
      done: /confirmation|thank-?you/i,             // the order-placed page
      // Optional, for stores that need them:
      // choose: [/^home delivery$/i, /^credit card$/i],  // choices shown as tiles / tabs / radio labels, pressed once each
      //                                                  //   (matched on the words alone: brackets and the like left out)
      // addressLookup: true,          // the address is one line, picked from the store's suggestions as it's typed
      // afterCard: [/^done$/i],       // step buttons only pressed once every card box is in (EB's "Done")
      // notFinal: [/^pay now$/i],     // words that look final but aren't at this store (EB's "Pay Now" payment tab)
      // shipping: [/standard shipping/i],  // the shipping method to pick (by its label, or the heading it's under: "Parcel Post")
      // phoneLocal: true,             // the phone box comes after a +61 already shown: the number without its leading 0
      // frames: [/global-e\.com\//i], // the store's whole checkout runs in a frame from here: filled in (and, for
      //                               //   Auto-checkout, placed) in there — Premium Bandai's Global-e, Amazon's quick checkout
      // savedCard: /ending in \d{4}/i, // how the page shows a card the store already has for you (no card boxes)
      // shippingFallback: 'first',    // no shipping method matching `shipping`: the first one offered (never a pick-up)
      // tick: [/use shipping address as billing address/i],   // boxes to have ticked (ticked if they aren't)
      // untick: [/deliver to a different address/i],         // boxes to have unticked (unticked if they come ticked)
      // frameConfirm: [/^confirm$/i], // a payment frame showing a card it already has (Stripe's Link): its button,
      //                               //   pressed once instead of typing a card
      // tickRequired: true,           // also tick any box the checkout marks as required (never a newsletter's)
      // ownDetails: true,             // the checkout has your details and card already (Shop's): nothing typed, its choices left alone
      // unavailable: [/not available for purchase/i],  // the store won't sell it now: stop, nothing bought
      // ignoreErrors: [/must accept (the )?membership agreement/i],  // a notice that isn't a reason to stop (about a box Mugibot ticks)
      // leaves: true,                 // after the final button the checkout goes on to another address (Shop's, to the store's
      //                               //   order page): the order's seen placed when that address is `done`
    },
  },
};
```

Labels are regular expressions, matched against a button's visible text.
Whatever a flow doesn't say is covered by general rules that work on most
stores. Some rules always apply, whatever a flow says:

- **Every store's buy button reads the same**: "Add to cart", "Add to bag",
  "Add to basket", "Add to trolley", "Pre-order", "Pre Order", "Buy", "Buy now",
  "Order now"… are all the add button (`ADD_WORDS` in `server/monitor/words.js`,
  shared by the flows, the monitor's stock reading and the extension — a test
  keeps the extension's copy the same). With two on the page, the earlier one in
  that list wins: "Add to cart" over "Buy now". Never a wish list, "Notify me",
  click & collect, lay-by or an express payment's button (Afterpay, PayPal, Shop
  Pay…), and never on the checkout page itself.
- Final buttons ("Place order", "Pay now", "Checkout securely", "Confirm and pay",
  "Buy now and pay"…) are **never** pressed by ⚡ Buy. Auto-checkout presses one once per run, after
  its checks (docs/AUTO-CHECKOUT.md), and never in a checkout inside another
  site's frame (Premium Bandai's Global-e).
- "Add more" pop-ups after Add to bag ("Often Bought Together", "You may also
  like", a warranty offer) are closed with their ✕ or "No thanks", never
  accepted.
- Checkout opened, but the store showed its bag, empty (the add didn't go
  through, though the page looked busy — Kmart's shows nothing readable after
  Add): back to the product, Add pressed once more; still empty, it stops and
  says so, with what the page said.
- Express payments (PayPal, Afterpay, Zip, Apple Pay…), click & collect,
  sign-in, newsletters and marketing boxes are never chosen. A store that
  chooses click & collect or PayPal for you (EB Games) is switched to home
  delivery and the card.
- The store's cart turns the add away (an HTTP error, e.g. Kmart's while its
  page is still starting up): once the page has finished loading, Add is pressed
  once more; turned away again, Mugibot stops and says what the store answered.
- A one-line address box with suggestions (Target's, EB Games'): the address is
  typed and the store's suggestion with your postcode (then suburb) is picked —
  up to 3 tries, shorter each time. "Enter address manually" first, if there is one.
- Card boxes are typed into one at a time, each focused through the page, and
  checked afterwards: a box that didn't keep what was typed is typed again (the
  expiry as digits alone the second time). If the browser window isn't in front,
  the checkout's tab is brought forward once. A payment frame can be ready before
  the page above it is listening (Premium Bandai's Global-e checkout often is):
  it asks for the focus again every 100 ms until it's answered, so the card goes
  in at once — before 1.16.1 it waited out a 1.5 s fallback first, about half the
  time. Only with nobody above to answer does it type after that 1.5 s.
- Fields that already have a value (e.g. from a store account) are left alone.
- Checkout (or the bag) is only opened once the store shows the item went in:
  the "added" popup, an "Added to bag" message, the number on the store's bag
  icon going up, or — where no number shows — the store's cart answering the
  add. If the page didn't react to the Add press at all (it wasn't ready yet), Add
  is pressed once more; if it still doesn't go in, Mugibot stops and says so
  instead of opening an empty bag.
- Never stuck between the bag and checkout:
  - The bag icon's number doesn't move until the next page (some stores), but
    the store's cart answered the add (after 2.5 s): it's in. On to checkout;
    Add is never pressed a second time for that.
  - Added, with no "added" popup Checkout button and no bag link Mugibot knows
    (2.5 s on): the bag page by its address (`bag.url`, else `/cart` under the
    store's own address, e.g. Pokémon Center's `/en-au/cart`).
  - A bag drawer with no Checkout button it knows: the bag page itself, once.
  - The bag page, the item in it, and no Checkout button it knows (4 s on): the
    checkout page (`checkout.url`), else a link on the page that goes to
    checkout. With neither, it stops and says so (not 30 s later).
  - Shopify's cart link landing anywhere but the cart or checkout (the product
    page again): its Add button, like any store.

Clear cart (the Checkout page's 🧹 Bags card; docs/AUTO-CHECKOUT.md) empties a
store's bag with the same flow: its bag page (`bag.url`, else `/cart`; a page not
found there: the store's own bag link, from its header), then each line's own
Remove, one at a time — by its words ("Remove", "Delete", "Remove item"), what
it's called for a screen reader ("Remove <name> from cart"), or an icon the store
marks as remove (a bin, ×) — and the store's "Are you sure?" answered yes (its
pop-up's Yes / OK / Remove, or the browser's own `confirm()` box). Never "Save for
later", "Undo", a promo code's or gift card's remove, nor anything in a saved
or wish list. A quantity drop-down with a 0 in it ("0 (Delete)") is the last
resort. Shopify stores (`platform: 'shopify'`): the store's own `/cart/clear.js`
first. Then the bag's opened once more, to check it's empty.

Field names for `fields`: `email`, `phone`, `firstName`, `lastName`,
`fullName`, `address1`, `address2`, `suburb`, `state`, `postcode`, `country`,
`addressLookup`, `cardNumber`, `cardName`, `cardExpiry`, `cardExpMonth`,
`cardExpYear`, `cardCvc` (or `null` to leave a field alone).

## Testing a flow on the dummy store

`devtools/mockstore.js` has a copy of each beta store, shaped like the real
site. `test/extension.e2e.test.js` runs the real extension through each one:

Run every store's flow in a real Chrome (about 30 seconds):

```bash
node --test test/extension.e2e.test.js
```

Or try it by hand with `npm run demo` (dummy stores at http://localhost:5055).

When a real store's flow arrives, update **both** `server/retailers/<store>.js`
and that store's dummy copy, so the test keeps proving the flow.

## Adding a new store

1. Copy the closest flow file (`kmart.js` for big-box stores, `pokebox.js` for
   Shopify card shops — Good Games and the others are a few lines on top of it —
   `gamesworld.js` for WooCommerce, `gamesmen.js` for Magento) to
   `server/retailers/<newstore>.js` and fill it in.
2. Add it to `RETAILER_DEFS` in `server/retailers/index.js`.
3. If the store's card boxes are in a frame from a payment provider that isn't
   in `PAYMENT_HOSTS` (same file), add its address pattern. You'll know: at
   checkout the Mugibot panel says it "couldn't reach the card boxes" and names
   the frame's address (it's also in the member's Activity).
4. Bump `version` in `extension/manifest.json`, deploy, and tell members to
   update the extension (the dashboard tells them too).
5. Admin → Setup check → **Register slash commands**, so `/watch` lists the new store.
