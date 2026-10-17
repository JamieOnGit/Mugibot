# Auto-checkout

Auto-checkout buys an item by itself the moment it drops. The member's own
browser opens the store, adds the item to the bag, closes any "add more" pop-ups,
fills in checkout with their delivery details and the card saved in the
extension, and presses the final button ("Place order", "Checkout securely"),
all within limits the member sets.

It is **off for everyone** until a member switches it on, on the
**🤖 Auto-checkout** tab of their dashboard, and ticks the agreement. Nothing
is bought for an item until they **arm** it, and each arming buys **once**.

## For members

1. **Switch it on.** Auto-checkout tab, then the switch. The first time, tick the
   box agreeing that Mugibot may check out by itself in your browser with your
   saved card, within your limits. You're responsible for those orders. Stores
   can cancel orders, or close accounts, that use automated checkout.
2. **Choose what happens when an armed item drops:**
   - **Place the order for me.** Fills checkout in and presses the final button.
   - **Fill in checkout and stop at the final button.** Like ⚡ Buy, but it
     starts by itself. You press the button.
3. **Set your limits:**
   - **Most an order may cost.** Delivery included. Default $400.
   - **Orders a day.** Over 24 hours. Default 2.
   - **Spending a day.** Default $600.
   - **Only at stores where this browser is signed in** (optional). Signed in,
     checkout is faster because the store fills in your saved details.
     The sign-in status comes from the store login monitor.
4. **Arm items.** In the "Armed items" table on the same tab (10 to a page;
   "Armed only" shows just those), or with "🤖 Auto-checkout this item when it
   drops" when you add or edit an item on the watchlist. Each armed item needs a
   **max price**. Mugibot never starts if the price is over it.
5. **Keep Chrome open** with the extension connected. The "Ready to check out?"
   list shows what's missing:
   - an active membership;
   - the newest extension in this browser (1.11.0 or newer);
   - a card saved in the extension;
   - your delivery details;
   - Discord, for a DM on every attempt (optional);
   - whether this browser is listening.

### Trigger ACO: try it now

Each row of the Armed items table has a **Trigger ACO** button. It runs
Auto-checkout for that item **now**, as if it had just dropped. Use it to see it
work before a real drop.

- The item doesn't have to be armed, but it needs a max price. Auto-checkout
  must be switched on.
- It asks first, and says what will happen. In "Place the order for me" mode it
  **places a real order** if everything checks out. To try it without buying,
  switch to "Fill in checkout and stop at the final button" first.
- The limits and checks are the same as for a real drop. A test run's failures
  don't count towards the 3 a day.
- It shows up in the Activity log as a "test run (Trigger ACO)".

### One purchase per arming

Once the final button is pressed, the item is **disarmed**, whether the order was
confirmed or not. When it's filled in and left for you (the "stop at the final
button" mode), it's disarmed too. To buy it again, arm it again. A store that
keeps restocking the same item never buys it over and over.

If a run fails **before** the final button (sold out by the time the browser got
there, the store wouldn't add it…), the item stays armed for the next drop.

**When the store doesn't add it.** Some stores (Kmart's, for one) don't show
anything Mugibot can read after "Add to bag": no number on the bag icon, no
"Added" message. Mugibot then goes to checkout, and a store with an empty bag
opens the bag instead. When that happens, Mugibot goes back to the product and
presses Add once more. If the bag is still empty, it stops and says so, with
what the store's page said ("Something went wrong…"). It never checks out an
empty bag, and never adds twice.
After **3 failures in a day** it stops trying and disarms until you arm it again.

### What it checks before pressing the final button

- **The bag holds only this item, one of it.** Anything else already in the bag
  and it stops, so it never buys what you didn't arm.
- **The order total.** Delivery included, read from the checkout page. It must
  be within the item's max price + $40 (for delivery) and your "most an order may
  cost". If it can't read the total, it stops.
- **The card went in.** It checks the store's card boxes, including boxes from
  a payment provider.
- **The store didn't ask for something it couldn't fill in.** For example, a
  required field or an error message.

It presses the final button **once** per run, then watches the page:

| The page shows | The run ends as |
|---|---|
| An order confirmation ("Thank you for your order", an order number) | ✅ **Order placed** |
| "Your card was declined" | ❌ **Failed:** the store declined the payment |
| Your bank's check (3-D Secure, a code, "confirm in your banking app") | ⚠️ **Needs you:** finish it in the tab that's open |
| A "check you're human" box (CAPTCHA) | ⚠️ **Needs you** |
| Nothing either way | ⚠️ **Needs you:** check your email from the store before buying again |

It **never** gets past your bank's check or a store's bot check. It stops and
tells you.

### The Activity log

Every time an armed item drops, the Auto-checkout tab logs it, even when
Auto-checkout didn't start. Each entry shows:

- what triggered it;
- each step, with the time;
- how it ended, and **why**.

The filter shows orders placed, needed you, failed or didn't start. The tiles on
top count the last 30 days. You also get a Discord DM for every start and every
ending, and an email if "Email me when checkout is waiting for me" is on (Discord tab).

| Ended as | Why it can happen |
|---|---|
| ✅ Order placed | The store confirmed the order |
| 🛒 Filled in, waiting for you | "Stop at the final button" mode |
| ⚠️ Needs you | Your bank's check, a bot check, the total over your limit, no confirmation after pressing |
| ❌ Failed | Sold out by the time your browser got there, not added to the bag, couldn't reach checkout, card declined, the card didn't go in, another item in the bag, it took too long |
| ⏭️ Didn't start | Over the item's max price, over your order or daily limits, 3 failures today, signed out (if you chose that, or at a store that only sells signed in: Amazon, Premium Bandai), no browser with the extension open, membership not active |

## Stores

Auto-checkout uses the same per-store flows as ⚡ Buy (see
[RETAILER-FLOWS.md](RETAILER-FLOWS.md)), at every store that has one.

At **Premium Bandai** the whole checkout is in Global-e's frame, so it fills it
in and stops there for you to press.

At **Amazon** you must be signed in. Amazon pays with the address and card saved
in your Amazon account, so the extension's card isn't needed there. The order
total is still checked against your limits before "Place your order". While the
store login monitor sees you signed out at Amazon (or Premium Bandai), a drop
doesn't start.

These flows are tested end to end on the **dummy stores** only:

- Kmart:
  - an order placed;
  - the total over the limit;
  - another item in the bag;
  - a declined card;
  - a bank check;
  - an add that didn't go through (Add pressed again, then it says so);
  - "stop at the final button";
  - Trigger ACO.
- Target: the "Often Bought Together" pop-up closed with its ✕, then the order
  placed.

**Before relying on it at a real store, do one real run in "Fill in checkout and
stop at the final button" mode** and check every field. Then switch to "Place the
order for me". Draft flows (Target, Pokémon Center…) haven't been checked on the
real stores yet.

### Upsell pop-ups

After Add to bag, some stores show a pop-up offering more items (Target's
"Often Bought Together", "You may also like", "Add a warranty"). Mugibot closes
it with its **✕** (or "No thanks" / "Continue without") and carries on. It
never accepts the offer. A pop-up that has the store's own Checkout button in
it isn't treated as an upsell.

A store's own wording can be added to its flow, under `added.upsell` (see
Target's in `server/retailers/target.js`). The general rules in
`extension/core.js` also catch the usual wordings and newsletter sign-ups.

## How it works

```
the monitor sees an armed item drop (live sweep, page check or a browser's check)
  → server/aco.js: checks the switch, limits, max price; makes a run (or logs why not)
  → the member's extension, waiting on GET /api/ext/aco/next, gets the run at once
  → it opens the store in a new tab with a one-time ⚡ Buy code tied to the run
  → /api/ext/claim says what this checkout may do (mode, max total) — never the page
  → the store's flow: add → close pop-ups → checkout → details and card → checks
  → final button (once) → watches the page → POST /api/ext/aco/:id with how it went
```

- **The card never leaves the browser.** Mugibot's server decides when to start.
  It never sees the card and never talks to the store's checkout itself.
- **Limits come from the server**, with the run, not from anything the store's
  page could change. The server also counts the day's orders and spending.
- **Runs that stall are closed.**
  - Not picked up by a browser within 2 minutes: "didn't start".
  - Opened but not finished in 10 minutes: "failed".
  - Final button pressed with no outcome in 5 minutes: "needs you".
- **Another member's browser** can't see, start or report your runs. A run's
  code only works for your account.
- **The extension listens** with one long-poll at a time, while something is
  armed or a test run is waiting. The server answers as soon as a run starts, or
  after 20 seconds. An alarm every 30 seconds starts it again if Chrome has put
  the extension to sleep.

Files:

- `server/aco.js`: runs, limits, reasons and notifications.
- `server/routes/user.js`: `/api/aco`, and `/api/aco/test/:id` (Trigger ACO).
- `server/routes/ext.js`: `/api/ext/aco/*` and the claim.
- `extension/background.js`: listening and opening the tab.
- `extension/content.js`: the checks, the final button and the outcome.
- `extension/core.js`: pop-ups.
- `web/js/app.js` and `web/app.html`: the Auto-checkout tab.

Tests:

- `test/aco.test.js`: server.
- `test/extension.e2e.test.js`: the real extension on the dummy stores.
- `test/ui.test.js`: the tab.

## Fair play

- It runs only for members who switched it on and agreed, and only for items
  they armed, each with a max price and buying once.
- It uses the member's own browser, signed in as them, at a person's pace. There
  are no proxies, no extra accounts and no hidden identity.
- It never solves CAPTCHAs, skips queues or gets past bot protection or a bank's
  check.
- Store purchase limits are respected. It buys one of each item.
