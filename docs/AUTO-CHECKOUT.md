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
   drops" when you add or edit an item on your watchlist (Monitor → **My
   watchlist**). Each armed item needs a **max price**. Mugibot never starts if
   the price is over it. The live searches, the store switches and the watchlist
   all live on the Monitor page; this tab is only for what Auto-checkout does
   with your armed items.
5. **Keep Chrome open** with the extension connected. The "Ready to check out?"
   list shows what's missing:
   - an active membership;
   - the newest extension in this browser (1.14.0 or newer: Shopify's, Target's
     and Global-e's checkouts, tile choices, address finders, Amazon's "Buy Now";
     1.15.0 for ⚡ Buy from your phone to start the moment you press it);
   - a card saved in the extension (or backed up in your account: after a new
     install, restore it with your card passphrase, see "Card backup" below);
   - your delivery details;
   - Discord, for a DM on every attempt (optional);
   - which browser is your **checkout browser** (below), and whether this one is
     listening.

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
- It shows up in the Run history as a "test run (Trigger ACO)".

### ⚡ Buy from your phone (Discord)

The **⚡ Buy** button on a Monitor alert in a channel, or on a restock DM, works
from anywhere: a phone, with Discord open and nothing else. Press it and **your
checkout browser** (the computer you keep on) opens the store and checks out.
There's nothing to sign in to on the phone, and no browser needed there.

- **Discord says who pressed it.** The button isn't a link. Discord tells
  Mugibot it was pressed, and by which Discord account. The Discord account
  must be connected to a Mugibot account (Discord tab), with an active
  membership. Someone else pressing your DM's button gets "That SKU isn't on
  your watchlist".
- **What it does depends on your Auto-checkout settings:**
  - **Auto-checkout on, "Place the order for me"**: it places the order within
    your limits. The most it may cost is the item's max price, or else the
    price the alert showed (plus up to $40 delivery, and never over your per-order
    limit).
  - **Otherwise**: it fills checkout in and stops at the final button for you.
    That covers Auto-checkout off, set to stop at the final button, the price
    over your max or a limit, today's orders or spending used up, or no price
    to check against. The reply says which.
- **The reply** (only you see it) says where it went ("Sent to Chrome on Home
  PC") and is kept up to date for 15 minutes: adding to the bag, at checkout,
  order placed, checkout ready, or what went wrong. You also get the usual DM.
- **A channel alert for something you don't watch** adds it to your watchlist
  first (as its link always did). It isn't armed by it.
- **Your checkout browser isn't open?** The reply says so. The run waits 2
  minutes for it, then shows as "didn't start".
- **A store that only sells signed in** (Amazon): it doesn't start if your
  checkout browser was last seen signed out there, and says to sign in first.
- **Switch it off** under "⚡ Buy from your phone" on the Auto-checkout tab.
  The button then says it's off.
- In the Run history it's "⚡ Buy pressed in Discord". The day's limits count
  its orders like any other.
- Without Discord's interactions set up (docs/DISCORD.md, step 6), and in
  emails and personal webhooks, ⚡ Buy is still the old link: it opens the store
  in the browser you press it in.
- **On the website**, the ⚡ Buy page has **Send to my computer**: the same thing,
  for a phone signed in to Mugibot.

### Your checkout browser

Runs go to **one** browser: your checkout browser. Never to all of them, so two
of your browsers never race for the same order. That covers armed items' drops,
Trigger ACO and ⚡ Buy from your phone.

- It's the newest browser you connected, unless you pick another under
  "⚡ Buy from your phone" (or press **Use this browser** there).
- The list shows each connected browser, and whether it's open now (it asks
  for runs about every 20 seconds while open).
- Disconnect it, and the newest one left takes over.
- Your other browsers still do everything else: ⚡ Buy pressed in them,
  in-browser checks, the store login monitor.

### Checkpoints and virtual queues

Before a big drop, JB Hi-Fi can switch on its **checkpoint** (an hCaptcha
check before checkout). EB Games and Pokémon Center can put up a **virtual
queue**. Mugibot posts each one in `#virtual-queue-detection` when it goes up
and comes down (docs/MONITORING.md). Auto-checkout and ⚡ Buy go through them
like you would.

- **At JB Hi-Fi's checkpoint** the run stops there and waits for **you** to
  solve the check. Mugibot never touches it. The run says "Waiting for you at
  the checkpoint" and DMs you. The tab comes forward with the panel moved out of
  the way. Once you've solved it, the store sends you on to checkout and the
  run carries on: details, card, the total checked, the final button. It waits
  up to 20 minutes.
- **In a virtual queue** the run waits its turn. The queue page refreshes
  itself; Mugibot **never refreshes it**, because refreshing it yourself can
  lose your place. Your ⚡ Buy, checkout pass and Auto-checkout limits are kept
  the whole time. The run shows "Waiting in line" (about how long, when the
  page says) and DMs you once. When you're through, it carries on. If the
  store let you in at its front page, it opens the product first. It waits up
  to 2 hours, as long as your browser keeps saying it's still in line (every
  few minutes).
- **While your browser is in a store's queue**, nothing else of Mugibot's asks
  that store for anything: no in-browser checks of your SKUs there, no sign-in
  checks, no second tab. A drop at that store while you're in line **waits for
  the tab in line** to get through, then opens the store from there with a
  fresh link.
- **Getting in line before the drop:**
  - **By itself**: when a store's queue goes up and you have Auto-checkout on
    with something armed there, your checkout browser opens the store in a tab
    of its own, in the background, and waits in line. It does this once a
    queue, unless it's in line or through already. Your DM says so.
  - **From Discord**: **📥 Join the queue on my computer** on the
    `#virtual-queue-detection` post does the same for anyone, armed or not.
    Your checkout browser must be open, with "⚡ Buy from your phone" on.
- Needs **extension 1.16.0** or later (the Auto-checkout tab says when yours
  is older). Older ones get no checks or searches at a store while its queue
  is up, and their runs there don't wait in line.

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
- **The card went in — every box of it.** It checks the store's card boxes,
  including boxes from a payment provider (one frame per box at Kmart, Shopify
  stores and Target). A card the store or Shop Pay already has for you ("Visa
  •••• 4242", no card boxes) counts.
- **The store didn't ask for something it couldn't fill in.** An error message,
  a box marked wrong, or a required box (or tick box) still empty: it stops and
  names it.
- **The store doesn't only take PayPal.** At The Games Cube (PayPal only) it fills
  everything in and stops at "Checkout with PayPal" for you.

It presses the final button **once** per run, then watches the page:

| The page shows | The run ends as |
|---|---|
| An order confirmation ("Thank you for your order", an order number) | ✅ **Order placed** |
| "Your card was declined" | ❌ **Failed:** the store declined the payment |
| Your bank's check (3-D Secure, a code, "confirm in your banking app") | ⚠️ **Needs you:** finish it in the tab that's open |
| A "check you're human" box (CAPTCHA) | ⚠️ **Needs you** |
| The store refused the press (still saying what's wrong a few seconds on) | ⚠️ **Needs you:** what it said |
| Nothing either way | ⚠️ **Needs you:** check your email from the store before buying again |

It **never** gets past your bank's check or a store's bot check. It stops and
tells you.

### Run history

Every time an armed item drops, the Auto-checkout tab logs it in the **Run
history**, even when Auto-checkout didn't start. It's 10 runs to a page, with
page buttons underneath (no endless scrolling). Each entry shows:

- what triggered it;
- each step, with the time;
- how it ended, and **why**.

The filter shows orders placed, needed you, failed or didn't start, and goes
back to the first page. Your general activity (restocks, alerts, sign-ins) is on
the Monitor page, under **My activity**. The tiles on
top count the last 30 days. You also get a Discord DM for every start and every
ending, and an email if "Email me when checkout is waiting for me" is on (Discord tab).

| Ended as | Why it can happen |
|---|---|
| ✅ Order placed | The store confirmed the order |
| 🛒 Filled in, waiting for you | "Stop at the final button" mode |
| ⚠️ Needs you | Your bank's check, a bot check, the total over your limit, no confirmation after pressing |
| ❌ Failed | Sold out by the time your browser got there, not added to the bag, couldn't reach checkout, card declined, the card didn't go in, another item in the bag, it took too long |
| ⏭️ Didn't start | Over the item's max price, over your order or daily limits, 3 failures today, signed out (if you chose that, or at a store that only sells signed in: Amazon), no browser with the extension open, membership not active |

### Card backup: no typing the card again after a new install

The card is saved in the extension, so a fresh install (or another browser) starts
without it. From extension 1.13.0 you can back it up to your Mugibot account:

1. **Back it up.** In the extension's Card settings, tick **Also back it up to my
   account** when you save the card, or use **Back up my card** under a card
   that's already saved. Pick a **card passphrase** (10 characters or more, a few
   words is easiest) and type it twice.
2. **Restore it.** After a new install, connect the extension to your account
   and open Card settings (the popup and the dashboard's Checkout details say
   "Restore your card"). Type the card passphrase once: the card is ready for
   every ⚡ Buy and Auto-checkout in that browser, with nothing to unlock again.

How it's kept safe:

- The extension locks the card **in your browser** before sending it: a key made
  from your passphrase (PBKDF2-SHA256, 600,000 rounds, a new random salt each
  time) and AES-256-GCM, tied to your account. Mugibot keeps that locked copy,
  plus the brand, last 4 digits and expiry so it can show which card it is.
- The passphrase never leaves your browser. **Mugibot can't open the backup or
  tell you the passphrase.** Forget it, and save the card again (and back it up
  with a new passphrase).
- Delete the backup any time: **Delete the backup** on Checkout details or in
  the extension's Card settings. It's deleted with your account too. Removing the
  card from one browser leaves the backup alone.
- **Download my data** lists the backup's brand, last 4 and expiry, not the
  locked copy.

## Stores

Auto-checkout uses the same per-store flows as ⚡ Buy (see
[RETAILER-FLOWS.md](RETAILER-FLOWS.md)), at every store that has one.

At **Premium Bandai** the whole checkout is in Global-e's frame. Mugibot runs it
in there: your details, the card, the purchase agreement box, and — after the same
checks (card in, nothing wrong, the total within your limit) — "Pay and Place
Order", once. Signed in or as a guest.

At **Amazon** you must be signed in (no guest checkout). It presses "Buy Now",
says "No thanks" to the Prime offer if Amazon shows it, and Amazon pays with the
address and card saved in your Amazon account, so the extension's card isn't
needed there. The order total is still checked against your limits before "Place
your order" (in Amazon's quick-checkout window too, when it shows one). While the
store login monitor sees you signed out at Amazon, a drop doesn't start; ⚡ Buy
says to sign in first, and so does your watchlist.

At **The Games Cube** (PayPal only) it fills everything in and stops at
"Checkout with PayPal": you pay with PayPal yourself.

At **EB Games**, **Target**, **JB Hi-Fi**, **Toys"R"Us** and **Gamerholic** it
follows their real checkouts, as members walked them through (Oct 2026): see each
store in [RETAILER-FLOWS.md](RETAILER-FLOWS.md).

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
- Kmart signed out: its cart turning the first add away (Add pressed again once
  the page had loaded), and Adyen-style card boxes slow to take typing.
- Target: the "Often Bought Together" pop-up closed with its ✕, "Home Delivery",
  your address from its suggestions, "Credit Card" and Paydock's card form, then
  the order placed.
- EB Games: as a guest (Home Delivery over Click & Collect, the address from its
  suggestions, Credit / Debit card, "Done", "CONFIRM & PAY") and signed in.
- JB Hi-Fi: the card in Shopify's card fields, the order placed.
- Toys"R"Us signed in with Shop: Shop Pay's card, "Standard Shipping - AusPost",
  the order placed.
- Amazon: "Buy Now", "No thanks" to Prime, "Place your order"; and its quick
  checkout window.
- Premium Bandai signed in: "Default (same as billing address)", the card with
  its month and year drop-downs, the agreement, "Pay and Place Order" in
  Global-e's frame.
- The Games Cube: everything filled in, stopped at "Checkout with PayPal".
- City Beach:
  - an order placed;
  - a last "place order" stage, whose own "Confirm & pay" is pressed once.

**VIP drops** (Monitor → Settings, admins) can arm Auto-checkout for you: what a
VIP watch finds goes on your watchlist, armed up to the max price you gave it (see
[MONITORING.md](MONITORING.md#-vip-drops)).

**Before relying on it at a real store, do one real run in "Fill in checkout and
stop at the final button" mode** and check every field. Then switch to "Place the
order for me". Beta flows were built from members' walk-throughs of the real
stores and tested on their dummy copies; draft flows (Pokémon Center…) haven't
been seen on the real stores at all.

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

- **The card is only readable in the browser.** Mugibot's server decides when to
  start. It never sees the card and never talks to the store's checkout itself.
  A card backup (below) is locked in the browser before it's sent.
- **Limits come from the server**, with the run, not from anything the store's
  page could change. The server also counts the day's orders and spending.
- **Runs that stall are closed.**
  - Not picked up by a browser within 2 minutes: "didn't start".
  - Opened but not finished in 10 minutes: "failed".
  - Final button pressed with no outcome in 5 minutes: "needs you".
- **Another member's browser** can't see, start or report your runs. A run's
  code only works for your account.
- **The extension listens** with one long-poll at a time: in your checkout
  browser all the time (for ⚡ Buy from your phone, unless that's switched off),
  and in any browser while something is armed or a test run is waiting. The
  server answers as soon as a run starts, or after 20 seconds. Only the checkout
  browser is given runs. An alarm every 30 seconds starts it again if Chrome has
  put the extension to sleep.
- **⚡ Buy from Discord**: `/api/discord/interactions` (Ed25519-signed by
  Discord) → `routes/discord.js` `press()` → `aco.remote()` makes the run
  (trigger `remote`) → the same as above. The button's reply is changed with
  the interaction's token as the run goes (`PATCH /webhooks/<app>/<token>/messages/@original`).

Files:

- `server/aco.js`: runs, limits, reasons and notifications.
- `server/routes/user.js`: `/api/aco` (settings, your browsers), `/api/aco/test/:id`
  (Trigger ACO) and `/api/aco/remote/:id` (Send to my computer).
- `server/routes/discord.js`: the ⚡ Buy button, pressed.
- `server/routes/ext.js`: `/api/ext/aco/*` and the claim.
- `extension/background.js`: listening and opening the tab.
- `extension/content.js`: the checks, the final button and the outcome.
- `extension/core.js`: pop-ups.
- `web/js/app.js` and `web/app.html`: the Auto-checkout tab.

Tests:

- `test/aco.test.js`: server.
- `test/remote.test.js`: ⚡ Buy from your phone and the checkout browser.
- `test/extension.e2e.test.js`: the real extension on the dummy stores.
- `test/ui.test.js`: the tab.

## Fair play

- It runs only for members who switched it on and agreed, and only for items
  they armed, each with a max price and buying once.
- It uses the member's own browser, signed in as them, at a person's pace. There
  are no proxies, no extra accounts and no hidden identity.
- It never solves CAPTCHAs, skips queues or gets past bot protection or a bank's
  check. At a store's checkpoint it waits for you to solve it. In a virtual
  queue it waits its turn and never refreshes the queue page.
- Store purchase limits are respected. It buys one of each item.
