# Retailer flows

Every store has its own checkout flow in `server/retailers/<store>.js`. A flow
says which buttons to press, in what order, where the quantity goes, and which
button is the **final one**. The final button is never pressed.

| Store | File | Status | Notes |
|---|---|---|---|
| Kmart | `kmart.js` | ✅ **verified** | Tested end to end on kmart.com.au. Stops at "Checkout securely". |
| BIG W | `bigw.js` | 🟦 beta | Tested on the BIG W-style dummy store only. **Waiting for the real flow.** |
| EB Games | `ebgames.js` | 🟦 beta | Tested on the EB Games-style dummy store only. |
| JB Hi-Fi | `jbhifi.js` | 🟦 beta | Shopify. Tested on the Shopify-style dummy store only. |
| Target | `target.js` | 🟨 draft | Best guess, untested. |
| Zing | `zing.js` | 🟨 draft | Uses the EB Games flow (same platform). |
| Toys"R"Us | `toysrus.js` | 🟨 draft | Uses the Shopify flow. |
| Trainer Town | `trainertown.js` | 🟨 draft | Uses the Shopify flow; tested on the Shopify-style dummy store (`/trainertown`), not on trainertown.com.au yet. |
| Amazon AU | `amazon.js` | 🟨 draft | Adds to cart and opens checkout; Amazon fills your saved address and card. |

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
   - The quantity control: a box, a dropdown, or − / + buttons? Is there a maximum?
   - The exact label of the add button ("Add to cart", "Add to trolley", "Pre-order").
2. **After adding**
   - Does a popup, drawer or "added" message appear? What buttons does it have
     ("Checkout", "View cart", "Continue shopping")?
   - Or does it go straight to the cart page?
3. **Cart page** (if there is one)
   - Its address (e.g. `/cart`), and the checkout button's label ("Proceed to checkout").
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
  monitor: { server: true, browser: true },   // default for server / in-browser checks (admins can switch)
  flow: {
    product: {
      add: [/\badd to (cart|trolley)\b/i, /\bpre-?order\b/i],  // the add button's label(s)
      addSelector: null,            // optional CSS selector for the add button
      quantity: 'page',             // 'page' (set it on the product page, else in the cart) | 'bag' | 'none'
      quantitySelector: null,       // optional CSS selector for the quantity control
      waitMs: 12000,                // how long to wait for the add button on a fresh page
      settleMs: 800,                // after the page has loaded, wait this long before pressing Add
    },
    added: {                        // the popup / drawer after adding
      checkout: [/^(secure )?check ?out( now)?$/i],
      viewBag: [/\bview (cart|trolley)\b/i],
      confirm: [/added to (your )?trolley/i],   // optional: the store's "added" message
    },
    bag: {                          // the cart page
      path: /\/cart(\/|$)/i,
      checkout: [/^proceed to checkout$/i],
    },
    checkout: {
      path: /\/checkout(\/|$)/i,
      guest: [/^continue as (a )?guest$/i],         // pressed to check out as a guest
      choose: [/^home delivery$/i],                 // buttons to press once each (not radios)
      steps: [/^continue to payment$/i, /^continue$/i],   // "next step" buttons
      final: [/\bplace (my |your )?order\b/i],      // NEVER pressed — where it stops
      manual: [/enter address manually/i],          // optional: extra "type the address yourself" links
      fields: { 'input[name="mobile"]': 'phone' },  // optional: CSS selector → which detail goes there
      delivery: 'home',                             // pick home delivery (never click & collect)
      payment: 'card',                              // pick card payment
      done: /confirmation|thank-?you/i,             // the order-placed page
    },
  },
};
```

Labels are regular expressions, matched against a button's visible text.
Whatever a flow doesn't say is covered by general rules that work on most
stores. Some rules always apply, whatever a flow says:

- Final buttons ("Place order", "Pay now", "Checkout securely", "Buy now"…) are
  **never** pressed.
- Express payments (PayPal, Afterpay, Zip, Apple Pay…), click & collect,
  sign-in, newsletters and marketing boxes are never chosen.
- Fields that already have a value (e.g. from a store account) are left alone.
- The bag is only opened once the store shows the item went in: the "added"
  popup, an "Added to bag" message, or the number on the store's bag icon going
  up. If the page didn't react to the Add press at all (it wasn't ready yet), Add
  is pressed once more; if it still doesn't go in, Mugibot stops and says so
  instead of opening an empty bag.

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

1. Copy the closest flow file (`kmart.js` for big-box stores, `jbhifi.js` for
   Shopify stores) to `server/retailers/<newstore>.js` and fill it in.
2. Add it to `RETAILER_DEFS` in `server/retailers/index.js`.
3. If the store's card boxes are in a frame from a payment provider that isn't
   in `PAYMENT_HOSTS` (same file), add its address pattern. You'll know: at
   checkout the Mugibot panel says it "couldn't reach the card boxes" and names
   the frame's address (it's also in the member's Activity).
4. Bump `version` in `extension/manifest.json`, deploy, and tell members to
   update the extension (the dashboard tells them too).
5. Admin → Setup check → **Register slash commands**, so `/watch` lists the new store.
