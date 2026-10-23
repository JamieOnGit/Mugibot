# Auto-checkout

Auto-checkout buys an item by itself the moment it drops. The member's own
browser opens the store, adds the item to the bag, closes any "add more" pop-ups,
fills in checkout with their delivery details and the card saved in the
extension, and presses the final button ("Place order", "Checkout securely"),
all within limits the member sets.

It is **off for everyone** until a member switches it on, at the top of the
**⚡ Checkout** page of their dashboard, and ticks the agreement. Nothing
is bought for an item until they **arm** it, and each arming buys **once**.

## For members

1. **Switch it on.** Checkout page, then the switch. The first time, tick the
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
   - **Signed in or not, it goes.** Each store's checkout is followed either
     way: as a guest with your delivery details and card, or signed in with the
     details the store has saved (a little faster). Whether you're signed in
     never holds a run back — a reading can be old or wrong (a member signed in
     at BIG W was taken for signed out), and that would cost the drop. (The
     "Only at stores where this browser is signed in" setting is gone for that
     reason.)
4. **Arm items.** On the Drops page's **🤖 Armed** list (the tab next to My
   watchlist: 10 to a page; "Armed only" shows just those), or with "🤖
   Auto-checkout this item when it drops" when you add or edit an item on your
   watchlist. Each armed item needs a **max price**. Mugibot never starts if the
   price is over it. Every row is laid out the same way — the switch, the item,
   its max price and its buttons (**Trigger ACO**, **Clear bag**), each in its own
   column — with the item's **checks** under its name, always in the same order:
   - **Bag**: emptied (Clear cart) and nothing left in it since — a run that got
     to the store and ended without an order may have left its item there;
   - **Sign-in**: whether your checkout browser was last seen signed in at the
     store (only ever !, never ✗: it checks out either way; Amazon only sells
     signed in, and stops at its own sign-in page if you aren't);
   - **Card**: ready in your checkout browser (that browser says so, from
     extension 1.20, so you can see it from your phone too);
   - **Address**: the item's delivery details complete (its own address, else
     your default);
   - **Browser**: your checkout browser connected, up to date, open and listening.

   ✓ is ready, ✗ stops the run (or makes it stop for you), ! slows it, – is
   nothing to do (or can't be told from here). An armed item that isn't ready
   says **"To fix: …"** under it, and the line at the top counts how many armed
   items are ready. **🧹 Get ready** empties your bag at every store with
   something armed (in your checkout browser) and checks your sign-ins again;
   **↻ Check again** looks again now. The Checkout page is for your switch and
   limits, ⚡ Buy from your phone, your bags and the run history; your delivery
   details and card are on the Setup page.
   - **Not trading cards too:** a console, a collectible — any product at a
     store Mugibot checks out at is bought the same way. On the Monitor page's
     **🎯 Drop watches** tab, paste its link (or the words in its name and the
     store) and tick **🤖 Auto-checkout it when it drops, up to …**: what it
     finds goes on your watchlist, armed. A link is bought as soon as it's on
     sale; words buy only what drops after the watch has looked (never what was
     on sale already). At other websites drop watches only alert you
     (docs/MONITORING.md → Drop watches).
5. **Keep Chrome open** with the extension connected. The "Ready to check out?"
   list shows what's missing:
   - an active membership;
   - the newest extension in this browser (1.14.0 or newer: Shopify's, Target's
     and Global-e's checkouts, tile choices, address finders, Amazon's "Buy Now";
     1.15.0 for ⚡ Buy from your phone to start the moment you press it);
   - a card saved in the extension (after an update or a new install it comes
     back by itself once the extension's connected: "Your card through extension
     updates" below);
   - your delivery details;
   - Discord, for a DM on every attempt (optional);
   - which browser is your **checkout browser** (below), and whether this one is
     listening.

### A link from somewhere else: the panel checks it out too

A product someone else pinged you (another Discord, another bot that was
quicker), at a store Mugibot checks out at, doesn't have to be on your watchlist
first. Open its page and press the Mugibot panel's **Add to bag → Checkout**: the
panel reads the product off the page (its name and code, "not on your watchlist"
under it) and does exactly what it does for one of yours — adds one, goes
straight to checkout, fills in your delivery details and card and stops at the
final button for you. On a page that isn't a product (the store's home page, a
search) it says so. With Auto-checkout on and set to **Place the order for me**,
it places the order too, within your limits (next: ⚡ Buy you press yourself).

### ⚡ Buy you press yourself: placed too

From extension 1.27.0, with Auto-checkout **on** and set to **Place the order for
me**, a checkout you start yourself places the order the way an armed drop's does:
the dashboard's ⚡ Buy, a channel alert's ⚡ Buy link opened on this computer, and
the store panel's **Add to bag → Checkout**.

- **Within your limits**, as a drop's: the item's max price (one of it) plus up to
  $40 delivery, never over your "most an order may cost". A product not on your
  watchlist, or with no max price: up to your most an order. A ⚡ Buy that would go
  over the day's orders or spending fills checkout in and stops at the final
  button for you, as before.
- It's a run of its own in the Run history ("⚡ Buy"), with the same DMs, and
  counts towards the day's limits like any order.
- **Not** with Auto-checkout off or set to stop at the final button, not at The
  Games Cube (PayPal only), not while the same item is already checking out, and
  not in an extension older than 1.27.0. Then ⚡ Buy fills checkout in and stops at
  the final button, as ever.
- Armed drops, Trigger ACO and Discord's ⚡ Buy (pressed on your phone) place the
  order as they already did.

### Trigger ACO: try it now

Each row of the Armed list has a **Trigger ACO** button. It runs
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
  must be connected to a Mugibot account (Setup page → Discord & pings), with an active
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
- **A store that only sells signed in** (Amazon): it starts all the same — if
  you really are signed out there, Amazon's own sign-in page stops it, buying
  nothing.
- **Switch it off** under "⚡ Buy from your phone" on the Checkout page.
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

### Hot drops: a store slowed right down

In a hot drop a big store's site can slow to a crawl: its product page takes a
minute to draw its Add button, its cart minutes to answer. Before, the run gave
up after a fixed few seconds ("Add to bag isn't available", "Timed out"). Now
(extension 1.25.0) it waits as long as the store plainly needs — and **only**
then, so a drop that isn't busy goes exactly as fast as before:

- **The Add button** — the usual wait, then on (up to 2 minutes) while the page is
  still coming in: still loading, a spinner or "Loading…" where the buy box goes,
  hardly anything drawn yet; or (up to 45 seconds) while its Add button is there
  but still greyed out (not one greyed out until you choose a size or colour). A
  page that's loaded with no Add button, or that says "Sold out" / "Out of stock"
  anywhere on the product, ends at once, as ever. The panel says which it's
  waiting for. "Still coming in" is the page saying so — a spinner or skeleton in
  the page itself (not a picture's loader, a quantity stepper, the header or
  footer) — so an ordinary page never waits longer.
- **An error page** ("Error 503", "Too many requests", "Something went wrong",
  "high traffic"), up for a moment and a half and not a product's page (a price of
  $502.99 or "Due to high demand" isn't one): looked at again after a wait — 3, 5,
  8, 10, 15… seconds — as a person refreshing would, and the run picks up on the
  new page. A store that sent the tab to an error page of its own ("/sorry") goes
  back to the product's. Never a virtual queue's page (that would cost the place
  in line): it's looked at once more right before, and a queue's left alone.
- **The add itself** — while the store's still working on it (its button busy or
  saying "Adding…", a new spinner, its page still loading) it's never pressed
  again (that could put a second one in — nor after the store's cart turned it
  away, as it may be trying again itself) and the run doesn't move on to the bag:
  it waits for the store's answer, up to 2 minutes, then on to checkout, where the
  bag says whether it went in.
- **At checkout** — the final button and the card boxes get up to 45 seconds / a
  minute while the page is still loading (5 / 15 seconds otherwise). A Shop
  checkout link's "Shop's checkout didn't open" waits while its tab is still
  loading (up to 3 minutes) rather than 25 seconds. Auto-checkout reads the
  total, the page's errors and its required boxes again just before pressing the
  final button, so a total that grew while the page came in is still checked
  against your limit.
- **The final button** (extension 1.27.0) is pressed the moment everything's in.
  There's no wait to "check the details": the checks below are instant reads of the
  page. A final button the store draws greyed out while it finishes the last boxes
  is waited for (up to 30 minutes) and pressed the moment it turns on.
- **Pressed again while the store says it's struggling** (1.27.0). When the store
  answers "high demand", "please try again", "something went wrong", "too many
  requests", a 503 or a time-out — or "sold out" just then (under a drop's load,
  stock comes back) — it's pressed again, a little later each time (3, 5, 8, 10, 15
  seconds… then every 20), for up to **30 minutes** from the first press. Your
  details are filled in again and the total read and checked again before each
  press, and every press is in your activity.
  - **Your account says yes first.** Before each press after the first, your browser
    asks your account whether the run's still going. A run it has ended (stopped,
    timed out) is never pressed again.
  - **Never on silence.** A store that says nothing after the press may be taking
    the order, so it's waited for, never pressed again. It's also waited for while
    it's still working ("Processing…", its button greyed out or busy, a spinner, the
    page loading). After 30 minutes with no answer: "check your email before buying
    it again".
  - **Never past the payment.** Never past a decline, your bank's check, a human
    check or an order confirmation. Anything about the payment, the card, your bank
    or a human check ("a problem processing your payment", "verify you're human")
    stops the run for you. So do words it doesn't know.
  - **Old messages don't count.** A message that was already up before the press
    isn't taken for the store's answer.
  - **Boxes, then you.** A box the store says is wrong (not the card) is filled in
    again, twice at most, then it's yours.
  - **Back at checkout after a press.** Only when the page says it's struggling is
    it pressed again. Anything else is only watched.
  - **After 30 minutes of "try again"**, it stops: "kept turning it away — nothing
    more pressed; check your email before buying it again" (most likely sold out).
    It counts towards the day's limits, in case a press went through.
  - **Everywhere the same.** Every store Mugibot checks out at, drop watches' finds
    there, Shop checkout links, and checkouts in a frame. Your account hears from
    the run every half a minute meanwhile, so a slow checkout is never closed as
    stale. A press it heard about late still counts as an order.
- **Your account** waits up to 5 minutes (was 2: as long as the run's code lasts)
  for a store's slow page to take a run up once your browser's opened it — and
  your browser never opens a second tab for a run whose first one is still
  loading. (One that loaded and couldn't take it up gets a new tab, as before.)

### Several at once

Several drops at once — armed items, Trigger ACO, ⚡ Buy pressed in Discord
while a run is going — each get a checkout of their own, all in your checkout
browser:

- **At different stores they go side by side**, each in a tab of its own. A run
  never waits for one at another store.
- **At the same store they take turns.** A store keeps **one bag** for your
  browser, whichever tab adds to it, so two checkouts there at once would put
  both items in one order (or stop for each other's). The second is **next in
  line**: it waits (no tab yet), and opens the store the moment the one before
  it is done — its order placed, it stopped, or you closed its tab. Each order
  then has just its own item. The Run history and Discord's reply say "Next in
  line", and name the checkout it's waiting for.
- **A checkout that's waiting for you** (stopped at the final button, or for
  your bank's check) holds the store's turn for 3 minutes more, so you can
  finish it. Then the next one goes. One that stopped before anything went into
  the bag (sold out, signed out…) hands over straight away.
- **⚡ Buy pressed yourself** (on the dashboard, or a link) at a store where
  another of your checkouts is going waits on its page and says so. Then it
  reloads the page and goes.
- **The tab in front, and the ones behind.** Chrome slows a background tab's
  own timers to about once a second. A checkout's waits are timed by the
  extension instead, so a checkout behind another tab runs at full speed. Card
  boxes in payment frames take turns: each tab is brought forward to type its
  card, one at a time, so two cards are never typed at once.
- One run at a time for the **same item**: pressing ⚡ Buy again while it's
  checking out says so.
- **The day's limits hold** with runs at once. The runs still checking out
  count towards the day's orders and spending, so several starting together
  never go over them ("2 of 2 today (2 checking out now)"). One that stops
  short frees its place again.

### Clear cart: your bags, emptied before a drop

(EB Games' cart opens as a pop-up over its home page — "Oh no! currently your cart
is empty." — rather than a page of its own: that pop-up, a panel over the page
(not the cart icon in its header), counts as its bag, and its "empty" as empty.
That's for Clear cart only: ⚡ Buy never takes a pop-up's "empty" as a reason to
add again. Until extension 1.25.0 an EB Games bag already empty was said as
"couldn't find your bag". From 1.27.0 the store saying your bag is empty anywhere
on the page — a pop-up, or plain words drawn a moment after the page loads — or
its bag count at 0, is read as empty.)

A bag with something else in it doesn't stop Auto-checkout (from extension
1.27.0): it carries on, and those things are bought too. It says so on the run and
in your activity ("your bag already had 1 item in it — Auto-checkout carries
on…"), and checks the total against your most an order instead of the item's max.
To buy only the one thing, empty your bags first. The Checkout page's **🧹 Your
bags at each store** card empties a store's bag in your checkout browser — from
anywhere, your phone too:

- **Clear cart** (one store) or **Clear all** (every store, one at a time). Both
  ask first.
- Your checkout browser opens the store's bag in a tab, presses each thing's
  own **Remove** (or Delete, or its bin or ×) one at a time, answers the store's
  "Are you sure?" with yes, opens the bag once more to check it's empty, then
  closes the tab. Shopify stores (JB Hi-Fi, Toys"R"Us, Gamerholic, Trainer
  Town, Pokébox, Good Games, Collectible Madness, Cherry Collectables, Gameology): the
  store's own "empty the cart" (`/cart/clear.js`), checked the same way. The
  Gamesmen's "Remove item" (a new page each time) and Games World's × links
  (its "Undo" never pressed) go one at a time like any store's. Each store takes a second or two; Clear all goes through them in one tab.
- **Nothing else is pressed**: not "Save for later", not "Undo", not a promo
  code's or gift card's remove, and nothing in a "Saved for later" or wish list
  (Amazon's is right under its cart: it's left alone).
- **A store where a checkout of yours is going is left alone** — its bag is that
  checkout's (the card says so: "Left alone"). Empty it once that's done. A drop
  that comes in while a bag is being emptied waits a moment ("next in line: your
  bag there is being emptied"), then goes, its own item alone in the order. So is
  a store whose virtual queue you're in (asking it for a page could lose your
  place).
- **Each store says how it went**: "Emptied — 2 items removed", "Already empty",
  "Left alone: …" or "Couldn't empty it: …" with why. A bag it couldn't empty
  (a Remove that did nothing, a layout it doesn't know) stays open in its tab,
  for you to finish. A store whose page doesn't load says so in seconds.
- It needs the extension **1.18.0** or newer in your checkout browser (the card
  says so if it's older). Not open right now? It empties them when it next is
  (within a few minutes), or says it didn't start.

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
- **A checkpoint while you're on your phone** (Discord's ⚡ Buy, or an armed
  item's drop): the check is for the browser that's buying, so solving it on
  your phone can't let your computer through, and Mugibot never moves a pass
  from one browser to another. Discord's ⚡ Buy reply and your DM give you two
  buttons instead (from the moment you press ⚡ Buy when the checkpoint is
  already up):
  - **🖥️ Solve it on my computer** opens
    [Chrome Remote Desktop](https://remotedesktop.google.com/access). The
    checkout's tab is in front, waiting; solve the check there and the run
    carries on by itself. Set it up once: install it on your computer from that
    page, then sign in to the Chrome Remote Desktop app on your phone with the
    same Google account.
  - **📱 Finish on this phone** opens a page that says what it does. Pressing
    its button stops your computer's checkout and opens the store on your
    phone with the product in the cart (JB Hi-Fi's cart link), for you to pass
    the check and pay there (Shop Pay or your card). The item is disarmed:
    one purchase per arming. It works before your computer has started, or
    while it waits at the checkpoint; never once it's past the check and
    checking out, or has pressed the final button (the page says so, so you
    don't buy it twice). The link is only in your own reply and DM, and lasts
    30 minutes.
  - Your computer's tab stops for good: even if the check is solved there
    afterwards, it doesn't carry on (extension **1.21.0** or later; with an
    older one, only 🖥️ is offered once it's waiting at the check).
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
- **Only the wait is at a person's pace.** Everything else is as fast as
  ever: before the queue or checkpoint, and from the moment you're through
  (add, checkout, your details and card, the final button). A store page that
  only mentions its queue (a launch banner) is the store, not the queue:
  ⚡ Buy goes straight through it.
- Needs **extension 1.16.0** or later (the Checkout page says when yours
  is older). Older ones get no checks or searches at a store while its queue
  is up, and their runs there don't wait in line.

### One purchase per arming

Once the final button is pressed, the item is **disarmed**, whether the order was
confirmed or not. When it's filled in and left for you (the "stop at the final
button" mode), it's disarmed too. To buy it again, arm it again. A store that
keeps restocking the same item never buys it over and over.

If a run fails **before** the final button (sold out by the time the browser got
there, the store wouldn't add it…), the item stays armed for the next drop.

**One purchase per drop watch, too.** A drop watch with Auto-checkout on
(docs/MONITORING.md → Drop watches) is one arming: once one of its finds is
bought (or its final button was pressed and no confirmation showed), its other
finds are disarmed and what it finds from then on isn't armed. A broad watch
("xbox series x") never buys two consoles. Arm it again for another.

**When the store doesn't add it.** Some stores (Kmart's, for one) don't show
anything Mugibot can read after "Add to bag": no number on the bag icon, no
"Added" message. Mugibot then goes to checkout, and a store with an empty bag
opens the bag instead. When that happens, Mugibot goes back to the product and
presses Add once more. If the bag is still empty, it stops and says so, with
what the store's page said ("Something went wrong…"). It never checks out an
empty bag, and never adds twice.

**Never stuck between the bag and checkout.**

- A bag icon whose number doesn't change until the next page: when the store's
  cart answered the add, it goes on to checkout. It doesn't press Add again,
  which would put a second one in.
- Added, with no "added" pop-up and no bag link it knows: it opens the store's
  bag page by its address (`bag.url` in the flow, else the store's `/cart`).
- A bag page whose Checkout button it doesn't know by its words: the store's
  checkout page (`checkout.url`), or a link on the page that goes to checkout.
  With neither, it says so within a few seconds, with your item in the bag.
- Shopify's cart link landing back on the product page: it presses Add there.
After **3 failures in a day** it stops trying and disarms until you arm it again.

### What it checks before pressing the final button

- **Other things already in the bag** are bought too (said on the run and in your
  activity), and the total is checked against your most an order instead of the
  item's max. (Shop checkout links and Shopify cart links open a checkout of their
  own: never mixed.) Empty your bags before a drop to buy only the one thing.
- **The order total.** Delivery included, read from the checkout page. It must
  be within the item's max price + $40 (for delivery), your "most an order may
  cost", and what's left of the day's spending. If it can't read the total, it stops.
- **Agreement boxes ticked.** A box accepting the store's terms or a membership
  agreement (Shop's "By selecting, you indicate your acceptance of the Membership
  Agreement") is ticked before pressing, even one the page draws over a hidden box.
  Some boxes are never ticked: newsletter or marketing boxes, and anything that adds
  something you'd pay for (a protection plan, a warranty, a subscription, a price in
  its words), however it says "I agree".
- **The card went in — every box of it.** It checks the store's card boxes,
  including boxes from a payment provider (one frame per box at Kmart, Shopify
  stores and Target). A card the store or Shop Pay already has for you ("Visa
  •••• 4242", EB Games' "...2387 08/27", no card boxes) counts, and so does a card Stripe's **Link** shows
  in its frame (Games World), once its "Confirm" is pressed.
- **The store didn't ask for something it couldn't fill in.** An error message,
  a box marked wrong, or a required box (or tick box) still empty: it stops and
  names it.
- **The store doesn't only take PayPal.** At The Games Cube (PayPal only) it fills
  everything in and stops at "Checkout with PayPal" for you.

It presses the final button, then watches the page (and presses it again while
the store's struggling, for up to 30 minutes: Hot drops, above):

| The page shows | The run ends as |
|---|---|
| An order confirmation ("Thank you for your order", an order number) | ✅ **Order placed** |
| "Your card was declined" | ❌ **Failed:** the store declined the payment |
| Your bank's check (3-D Secure, a code, "approve it in your banking app") | 🏦 **Needs you, at once:** approve it in your bank's app — then ✅ **Order placed** by itself once the store confirms it |
| A "check you're human" box (CAPTCHA) | ⚠️ **Needs you** |
| A box the store says is wrong, still wrong after it's filled in again twice | ⚠️ **Needs you:** what it said |
| Anything about the payment, the card, your bank or a human check, or words it doesn't know | ⚠️ **Needs you:** what it said (nothing more pressed) |
| The store busy, "try again" or sold out, for 30 minutes of presses | ⚠️ **Needs you:** it kept turning it away — check your email before buying again |
| No answer, or still working on a press, 30 minutes on | ⚠️ **Needs you:** check your email from the store before buying again |

It **never** gets past your bank's check or a store's bot check. It stops and
tells you.

**Your bank's check, as it really comes up** (extension 1.30.0). After "Pay",
most cards are sent to the bank's check (3-D Secure): asking you to approve the
payment in your bank's app, or to type in a code it texts you. Until you do, the
store waits, and nothing's bought. It's the same for **every store and every
bank**: Mugibot never goes by a store's or a bank's name. The bank's page is
usually posted into a frame with no address to know it by, and Mugibot can't
read inside it, so Mugibot goes by where it appears and how:

- **A frame on the checkout**, named, titled or boxed for it (the names payment
  providers give it: Adyen's "threeDSIframe", Cardinal's, Stripe's,
  "challenge", "step-up"), or any frame the press brought up in front of the
  checkout, big enough to answer in (not chat, ads, video, PayPal or Afterpay).
- **Inside the payment provider's own frame** (the one with your card boxes,
  or a whole checkout in a frame like Premium Bandai's Global-e): a frame of a
  size to answer in that the press brought up there. Every frame on the page
  is looked at, every 2 seconds, while the store hasn't answered.
- **A page of the store's own** after "Pay" ("Processing your payment…") with
  the bank's frame on it.
- **A window of its own** the checkout opens.
- **The whole tab sent to the bank's site**, by the page or by the store's
  server. That's a site Mugibot can't open; if the tab's still there 5 seconds
  later, it's the bank's check (one that passes by itself comes straight back).
- **Words the press brought up**, in any bank's terms: "Approve this payment in
  your banking app", "We've sent a code to your phone", "Enter the
  verification code", "Verify your purchase", "Confirm it's you". A line saying
  it went wrong ("Payment authentication failed") isn't counted: what the store
  said reaches you as it is.

It's looked for until the half hour after "Pay" is up, also on a page the store
moves on to that's only "processing" for a while. If your account has already
said "no confirmation" by then, the bank's check still reaches you.

Then, within seconds: **🏦 Approve the payment in your bank's app** as a Discord
DM (and email, if you get them), with **🖥️ Open my computer** (Chrome Remote
Desktop) for a code you have to type into the checkout tab. The run says
**Needs you**. Approve it on your phone and the store goes on to its
confirmation; Mugibot is still watching (for the half hour) and the run turns
**✅ Order placed** by itself. "Pay" is never pressed again meanwhile.

**Allow pop-ups for the stores you buy from** in the browser that checks out.
Chrome blocks a window a page opens without a person's click, and a store that
opens your bank's check in a window of its own would wait for it in vain. In
Chrome, go to Settings → Privacy and security → Site settings → Pop-ups and
redirects → Allowed to send pop-ups → Add, then add each store
(`www.ebgames.com.au`, `checkout.shopify.com`, `shop.app`…). Most stores show
the bank's check on the page or send the tab to the bank, so this only matters
for a few.

Before 1.30.0 Mugibot only knew the bank's check by its frame's address (…/3ds,
…/acs) or its words on the checkout itself. Real ones often show neither, and
such a run waited out the half hour as "no answer" (Oct 2026: two members' runs,
at EB Games and Good Games). While a store hasn't answered a press, the run's
history now also says what's on the page ("on the page: a new frame from …", a
pop-up's words, numbers left out), so a run that's waiting shows why.

### Run history

Every time an armed item drops, the Checkout page logs it in the **Run
history**, even when Auto-checkout didn't start. It's 10 runs to a page, with
page buttons underneath (no endless scrolling). Each entry shows:

- what triggered it;
- each step, with the time — and how long after the drop it came (**+2.1 s**);
- how it ended, and **why**; an order placed says how long it took from the drop
  to the order (**⏱ 11.0 s drop to order**), and the **Orders placed** tile says
  the typical time (and the fastest) over the last 30 days.

The filter shows orders placed, needed you, failed or didn't start, and goes
back to the first page. Your general activity (restocks, alerts, sign-ins) is on
the Monitor page, under **My activity**. The tiles on
top count the last 30 days. You also get a Discord DM for every start and every
ending, and an email if "Email me when checkout is waiting for me" is on (Setup page → Discord & pings).

| Ended as | Why it can happen |
|---|---|
| ✅ Order placed | The store confirmed the order |
| 🛒 Filled in, waiting for you | "Stop at the final button" mode |
| ⚠️ Needs you | Your bank's check (🏦: approve it in your bank's app — it turns ✅ Order placed once the store confirms), a bot check, the total over your limit, no confirmation after pressing |
| ❌ Failed | Sold out by the time your browser got there, not added to the bag, couldn't reach checkout, card declined, the card didn't go in, another item in the bag, it took too long |
| ⏭️ Didn't start | Over the item's max price, over your order or daily limits, 3 failures today, no browser with the extension open, membership not active |

### Your card through extension updates: no passphrase, nothing to type

From extension 1.20 (on unless you switch it off: Setup → Delivery & card), your
card survives an update of the extension — even removing it and loading a new
copy from another folder, which starts with empty storage:

1. With the card saved, the dashboard hands the extension a **restore key** it
   keeps in this browser (the dashboard's own storage, which outlives the
   extension). The extension locks the card with it and sends your account
   **only that locked copy** (AES-256-GCM, tied to your account and that key),
   plus the brand, last 4 digits and expiry so it can show which card it is.
2. After an update (or a fresh copy), press **Connect this browser** (Setup →
   Extension). The dashboard hands the new copy the same key: it fetches the
   locked copy, opens it, and keeps the card encrypted with its own key, ready
   for every ⚡ Buy and Auto-checkout. "Your card is back" says so. Your delivery
   details were never in the extension: they come from your account as always.

The first update to 1.20 (from 1.19 or older) is the exception: the older copy
never made a locked copy, so update it in place (copy the new files over the old
folder, then Reload) and the card stays; a fresh copy needs it added once. From
then on it comes back by itself.

How it's kept safe:

- Mugibot's server has the locked copy but **never the key**, so it can't open it
  by itself; the key never leaves this browser. Someone with your Mugibot
  password can't open it either: the copy only ever goes to a connected
  extension, and the key that opens it is in your browser.
- One copy per browser (and per address of the site): each keeps its own key.
  Clearing this site's data in your browser loses the key; the extension, which
  still has the card, makes a new copy.
- **Removing the card** in the extension's Card settings deletes the copies too,
  so it never comes back by itself. **Delete the copies** on Setup → Delivery &
  card does the same; switching it **off** deletes them and the key.
- For **another browser or computer**, use the card backup below (locked with a
  passphrase you choose).

### Card backup: for another browser or computer

The card is saved in the extension, so a fresh install (or another browser) starts
without it. From extension 1.13.0 you can back it up to your Mugibot account:

1. **Back it up.** In the extension's Card settings, tick **Also back it up to my
   account** when you save the card, or use **Back up my card** under a card
   that's already saved. Pick a **card passphrase** (10 characters or more, a few
   words is easiest) and type it twice.
2. **Restore it.** In the other browser, connect the extension to your account
   and open Card settings (the popup and Setup → Delivery & card say "Restore
   your card"). Type the card passphrase once: the card is ready for every ⚡ Buy
   and Auto-checkout in that browser, with nothing to unlock again. (After an
   update in the same browser, the card comes back by itself: above.)

How it's kept safe:

- The extension locks the card **in your browser** before sending it: a key made
  from your passphrase (PBKDF2-SHA256, 600,000 rounds, a new random salt each
  time) and AES-256-GCM, tied to your account. Mugibot keeps that locked copy,
  plus the brand, last 4 digits and expiry so it can show which card it is.
- The passphrase never leaves your browser. **Mugibot can't open the backup or
  tell you the passphrase.** Forget it, and save the card again (and back it up
  with a new passphrase).
- Delete the backup any time: **Delete the backup** on Setup → Delivery & card or in
  the extension's Card settings. It's deleted with your account too. Removing the
  card from one browser leaves the backup alone.
- **Download my data** lists the backup's brand, last 4 and expiry, not the
  locked copy.

## Stores

Auto-checkout uses the same per-store flows as ⚡ Buy (see
[RETAILER-FLOWS.md](RETAILER-FLOWS.md)), at every store that has one. It needs
the extension **1.19.0** or newer: the six card shops added with it (Pokébox, Good
Games, Collectible Madness, Cherry Collectables, The Gamesmen, Games World) are
new addresses Chrome only lets a newer copy open. The Checkout page's "Ready to
check out?" says when yours is older.

At **Gameology** (Shopify, which checks out with Shop) it's the same, and it needs
extension **1.28.0**: its pages are new to the extension, so an older copy is
never sent there (the Checkout page says to update). Its cart link is the quick
way in; from its product page (the cart link not taken), it presses "Add to
cart" — Gameology's theme adds it without a new page and slides its cart drawer
open — then the drawer's "Checkout" (the drawer left shut, the cart icon opens
it). Signed in with Shop, Shop Pay's card is there and only "Pay now" is pressed.
Signed in to your Gameology account, the details it saved for you are left as
they are and the card is typed. As a guest, all of it is filled in as at Pokébox.

At **From The Deep Games** (Shopify, which checks out with Shop) it's the same as
at Pokébox, and it needs extension **1.29.0** (its pages are new to the
extension). Its cart link is the quick way in; from its product page, its quantity
("Units") is set, "Add To Cart" pressed (its theme adds it in the background),
then its cart's "Checkout". Signed in with Shop, only "Pay now"; as a guest, all
of it filled in as at Pokébox.

**How many** (extension **1.29.0**). An item's **Quantity** (1 unless set, up to
10) is how many a run puts in the bag. Its **max price is for one**: a drop over it
is skipped. The run's own limit is for them all: 3 at $90 each may cost up to
$270 (plus delivery), never over your limit an order or your spending for the day
— checked against the price times how many when it drops, and against the total
at checkout. A run of more than one is never sent to an extension older than
1.29.0 (it would buy one): it's skipped, and says to update. A Shop checkout
link's price and max are already the whole link's (its quantities are in it).

At **Pokébox, Good Games, Collectible Madness and Cherry Collectables** (Shopify)
it goes in by the store's cart link. Signed in with Shop, Shop Pay's card is there
and only "Pay now" is pressed; as a guest, your details, the address from
Shopify's suggestions, the card and "Use shipping address as billing address"
ticked, then "Pay now". At **The Gamesmen** it picks "Standard" shipping (else the
first one offered), "Credit card", types the card, ticks "I agree to the Terms and
Conditions…", leaves "I have a different billing address" unticked, then "CONFIRM
AND PAY". At **Games World** it leaves "Deliver to a different address?" unticked
and types the card into Stripe's form — or, with Stripe's **Link** connected,
presses Link's "Confirm" — then "Place order".

### 🛍️ Shop checkout links

At a store that checks out with **Shop** (Shop Pay), you can watch and arm the
store's **checkout link** itself — Monitor → **My watchlist** → **+ Add checkout
link** (next to + Add SKU; the links are listed under **🛍️ Shop checkout links**), e.g.
`https://creations.mattel.com/cart/48835830579405:2,40653613531341:1` (each option,
and how many). The link is the order, its quantities included, so its **max price
is for the whole link** (delivery on top, up to $40 more, within your limit an
order).

- **Watching.** Mugibot's server asks the store about each option in the link
  every **5 seconds**, the way its own pages do (`/variants/<id>.js`, a tiny
  answer), honestly as Mugibot, a second apart at a store. It's in stock once
  **every** option is; its price is the link's. The link itself is never opened
  by the server (it would start a checkout).
- **⚡ Buy and Auto-checkout** open the link as it is, which goes straight to
  Shop's checkout with your Shop address, delivery and card already in — nothing
  of yours is typed there, and Shop's choices are left as they are. Any box the
  store needs ticked to check out is ticked: Mattel Creations' **"By selecting,
  you indicate your acceptance of the Membership Agreement"**, and any box the
  checkout marks as required — never a newsletter or marketing box. (Mattel's
  real checkout labels its box only "By selecting, you indicate your acceptance
  of the", with the "Membership Agreement ↗" link beside the label, and doesn't
  mark it required: from extension 1.27.1 the words around the box are read too,
  so it's ticked.) **"Check out as guest"** is never pressed. ⚡ Buy stops at
  **Pay now** for you; Auto-checkout checks the total against your limits and
  presses it. (Mattel's real button reads **"Pay now $47.99"**, the total in it:
  found as the final button from 1.27.1 — before, the run said "Couldn't find the
  next step".) Shop then goes on to the store's own order page, and that's the
  order seen placed.
- **"This Product is not available for purchase"** (and "You must accept
  membership agreement") can be up on the checkout before anything's pressed —
  a member's Mattel checkout showed both, while the store's own data already
  said in stock. Neither stops it: the agreement is ticked and **Pay now** is
  pressed. If the store answers "not available for purchase" (not on sale yet,
  or members only), nothing's bought, and the run **stays on the checkout
  pressing Pay now** with everything filled in: again every **6 seconds**, until
  the store takes the order (extension 1.27.1; before, it only reloaded the page
  every 5 s, for 30 minutes). It's never pressed while the store's still at a
  press (its button busy, the page loading), and each press is asked of your
  account first, so Stop on the dashboard is heard at the next press. The
  checkout's reloaded every 10 minutes (or after half a minute of presses the
  page doesn't answer at all), as a person would. The run says **Not on sale yet
  — pressing "Pay now"**, with the presses counted; you get one DM when it starts.
  It keeps at it for up to **8 hours**, so a run started the evening before a
  3AM drop is still pressing at 3AM — keep that computer on, awake, and its tab
  open. Still not on sale after that, it stops — nothing bought — and the item is
  **armed again**. If your browser goes quiet after a press, the run ends as
  needs-you (check your email), never armed again.
- **The store's checkout queue** (Mattel's at a drop: "You're in line to check out
  … Don't refresh this page", on the store's own site, where Mugibot doesn't run).
  A link that goes there — on its way to Shop's checkout, or sent back from it at the
  drop — is waited for there, never refreshed: the run says it's in the queue, keeps
  going (it isn't taken for "signed out of Shop" while this browser was seen signed
  in to Shop in the last 12 hours), and once the tab's back on Shop's checkout it
  carries on — the ⚡ Buy code it opened with, left behind in the queue, replaced by a
  fresh one — pressing **Pay now** again. (Extension 1.27.1.)
- **■ Stop** (on a run that's still going, in the Run history — its tab closed by mistake,
  say, or not wanted any more; extension 1.27.2). The run ends on your account at once,
  with no DM. Your checkout browser hears within seconds and its tab presses nothing
  more, even before its first press. Any press it was about to make asks your account
  first and is refused. "Pay now" pressed already: it ends as needs-you, so check your
  email. Not pressed yet: nothing was bought, and it never counts as a failed drop.
- **🚦 Wait for queue, then ACO** (a button on each Shop checkout link). It opens the
  link now and, while the checkout says it isn't on sale yet, **opens it again every
  90 seconds** — like refreshing — until the store's queue is up. The next opening
  lands in the queue and stays there (never refreshed). Through it, it presses **Pay
  now** every 6 seconds until the store takes the order, and never opens the link
  again in that run. It places a real order within your limits, so Auto-checkout must
  be on and set to **Place the order for me**. Press it when you'd join the queue
  yourself (the queue may let early arrivals through before the drop; you can watch
  its wait time in that tab).
- **⏰ Schedule** (next to 🚦 on each Shop checkout link). Pick a time in your time
  zone (AEDT, say "2:45 am"), and 🚦 Wait for queue, then ACO starts by itself then,
  in your checkout browser, as if you'd pressed it. That way it isn't going for hours
  before a drop. The button shows the time it's set for; press it again to change it,
  or leave the time empty to cancel. It's checked when you set it and again when it
  starts. If it can't start then (Auto-checkout switched off, say), you're told and
  nothing starts. Keep the browser open and the computer awake. (Extension 1.27.2
  listens for it; 1.27.1 starts it within a minute of the time.)
- **"Too many checkout attempts"** (Shopify's, after a checkout's been pressed or
  opened too often). "Pay now" goes every 6 seconds, and 🚦 opens the link again
  every 90 seconds, since presses every 2 s and openings every 15 s got a member
  this. If the store says it all the same, nothing more is pressed. The run waits
  3 minutes, as it asks, then opens the link again: its cart's checkout, the same as
  "Return to cart" then "Checkout", through the queue if it's up. Then it carries on
  as before.
- **A discount code** (Edit on the link → **Discount code**): typed into the
  checkout's "Discount code" box and **Apply** pressed before **Pay now**. Taken,
  it's on the order. Not taken ("Enter a valid discount code", or no answer in 8
  seconds): the box is cleared and **Pay now** pressed without it. Left empty, the
  discount box is never touched.
- **Never ticked** at Mattel: "I agree to sign-up for Mattel Rewards" (no box that
  signs you up to anything), nor the news-and-offers box (left as the store has it).
- **A link that already says In stock** (the store's own data says the options
  can be bought, while its checkout still says "not available for purchase" —
  Mattel's before a drop): the drop won't change that "In stock", so an armed
  link wouldn't start by itself. Start the run yourself — **⚡ Buy** (with
  Auto-checkout on and set to place the order) or **Trigger ACO** — any time
  before the drop: it opens the checkout and presses **Pay now** every 6 seconds
  until the store takes the order.
- **Signed in to Shop only.** Signed out, Shop sends the link on to the store's
  own checkout as a guest, where Mugibot doesn't run. Whether you're signed in is
  read **on Shop's checkout itself**, from what's on the screen: your email by
  Shop's logo, or "Check out as guest" (Shop only offers that to someone it
  knows). Shop's own account page isn't a sign: Shop Pay can know you on a
  checkout while shop.app shows you signed out, and Shop's pages carry the words
  "Sign in to your account" in their code either way (until extension 1.24.0
  Mugibot read those, and took a member who was signed in for signed out).
  - **Each link** shows how its checkout last opened: **✅ Signed in to Shop on
    this link** (its ⚡ Buy or Auto-checkout got to Shop's checkout), **⚠️ Signed
    out** (it went on to the store's guest checkout), or **Not opened yet** —
    press ⚡ Buy once to check: it opens Shop's checkout, ticks the boxes and
    stops at Pay now, buying nothing.
  - A reading of "signed out" never holds a run back: signed in since (and not
    seen), it would cost the drop, while a run that's really signed out finds
    out within 25 seconds — "Shop's checkout didn't open" — buying nothing, and
    is left in its tab for you.
- **No bag**: each link is its own order, so Shop links never wait for each other
  or for another checkout, and Clear cart has nothing to empty for them.
- Needs the extension **1.24.0** (it runs on `shop.app`): with an older one in
  your checkout browser, Auto-checkout doesn't start and says to update.

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
- Pokébox signed in with Shop: Shop Pay's card, "Pay now" pressed, the order placed.
- Collectible Madness as a guest: your details, the address from Shopify's
  suggestions, the card in Shopify's card fields, "Use shipping address as
  billing address" ticked, "Pay now".
- The Gamesmen as a guest (your details, "Standard" shipping, "Credit card",
  the card, the terms box ticked, "CONFIRM AND PAY") and signed in with a saved
  address (only the shipping, card and terms).
- Games World as a guest (its add-to-cart link, your details, the state
  drop-down, "Deliver to a different address?" unticked, Stripe's card form,
  "Place order") and signed in with Stripe's Link (its card and "Confirm").

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
- **Several at once** (`extension/background.js`, "one at a time at each
  store"): the extension keeps a line per store, first come first served. A run
  whose store is busy reports `waiting` with reason `turn` and is opened later
  with a fresh link (`POST /api/ext/aco/:id/link`). Waits are timed by the
  extension's worker (`MGBFlows.wait`), and card boxes take turns across tabs.
- **Runs that stall are closed.**
  - Not picked up by a browser within 2 minutes: "didn't start".
  - Next in line for 20 minutes: "failed".
  - Opened but not finished in 10 minutes: "failed".
  - Final button pressed with no outcome in 5 minutes: "needs you".
- **Another member's browser** can't see, start or report your runs. A run's
  code only works for your account.
- **Clear cart** (`server/bags.js`): `POST /api/bags/clear` (a store, or
  `stores: 'all'`) makes a request per store for your checkout browser, handed
  over with `GET /api/ext/aco/next` (it answers at once with them). The
  extension (`extension/background.js`, "Clear cart") takes the store's turn
  like a checkout (`c:<id>` in the line), opens the bag, and `extension/bag.js`
  on the page empties it; how it went comes back with `POST /api/ext/bags/:id`
  and shows on the dashboard as it happens. Not picked up in 4 minutes: "didn't
  start"; quiet for 3 minutes: "lost touch". The page's own `confirm()` boxes
  answer yes in that tab only.
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
- `server/bags.js`: Clear cart (`/api/bags`, `/api/bags/clear`, `/api/ext/bags/:id`).
- `extension/bag.js`: emptying a store's bag, on its bag page.
- `server/routes/user.js`: `/api/aco` (settings, your browsers), `/api/aco/test/:id`
  (Trigger ACO) and `/api/aco/remote/:id` (Send to my computer).
- `server/routes/discord.js`: the ⚡ Buy button, pressed.
- `server/routes/ext.js`: `/api/ext/aco/*` and the claim.
- `extension/background.js`: listening and opening the tab.
- `extension/content.js`: the checks, the final button and the outcome.
- `extension/core.js`: pop-ups.
- `web/js/app.js` and `web/app.html`: the Checkout page.

Tests:

- `test/aco.test.js`: server.
- `test/bags.test.js`: Clear cart on the server; `test/extension.e2e.test.js` has
  it emptying every dummy store's bag, each its own way.
- `test/remote.test.js`: ⚡ Buy from your phone and the checkout browser.
- `test/extension.e2e.test.js`: the real extension on the dummy stores
  (several at once included).
- `test/background.test.js`: a checkout in a background tab, at full speed.
- `test/ui.test.js`: the tab.

## Fair play

- It runs only for members who switched it on and agreed, and only for items
  they armed, each with a max price and buying once.
- It uses the member's own browser, signed in as them, at a person's pace. There
  are no proxies, no extra accounts and no hidden identity.
- It never solves CAPTCHAs, skips queues or gets past bot protection or a bank's
  check. At a store's checkpoint it waits for you to solve it. In a virtual
  queue it waits its turn and never refreshes the queue page.
- Store purchase limits are respected. It buys as many as the item says (1 unless
  you set it, up to 10) — fewer if the store's own most is lower, and it says so.
