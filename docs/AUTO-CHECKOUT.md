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
   - **Only at stores where this browser is signed in** (optional). Signed in,
     checkout is faster because the store fills in your saved details.
     The sign-in status comes from the store login monitor.
4. **Arm items.** On the Drops page's **🤖 Armed** list (the tab next to My
   watchlist: 10 to a page; "Armed only" shows just those), or with "🤖
   Auto-checkout this item when it drops" when you add or edit an item on your
   watchlist. Each armed item needs a **max price**. Mugibot never starts if the
   price is over it. Every row is laid out the same way — the switch, the item,
   its max price and its buttons (**Trigger ACO**, **Clear bag**), each in its own
   column — with the item's **checks** under its name, always in the same order:
   - **Bag**: emptied (Clear cart) and nothing left in it since — a run that got
     to the store and ended without an order may have left its item there;
   - **Sign-in**: whether your checkout browser is signed in at the store (needed
     at Amazon, or with "Only at stores where this browser is signed in");
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
- **A store that only sells signed in** (Amazon): it doesn't start if your
  checkout browser was last seen signed out there, and says to sign in first.
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

Auto-checkout only ever buys the one item, so a bag with something else in it
stops it there ("your bag already had 1 item in it"). The Checkout page's
**🧹 Your bags at each store** card empties a store's bag in your checkout
browser — from anywhere, your phone too — so a drop goes through:

- **Clear cart** (one store) or **Clear all** (every store, one at a time). Both
  ask first.
- Your checkout browser opens the store's bag in a tab, presses each thing's
  own **Remove** (or Delete, or its bin or ×) one at a time, answers the store's
  "Are you sure?" with yes, opens the bag once more to check it's empty, then
  closes the tab. Shopify stores (JB Hi-Fi, Toys"R"Us, Gamerholic, Trainer
  Town, Pokébox, Good Games, Collectible Madness, Cherry Collectables): the
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

- **The bag holds only this item, one of it.** Anything else already in the bag
  and it stops, so it never buys what you didn't arm.
- **The order total.** Delivery included, read from the checkout page. It must
  be within the item's max price + $40 (for delivery) and your "most an order may
  cost". If it can't read the total, it stops.
- **The card went in — every box of it.** It checks the store's card boxes,
  including boxes from a payment provider (one frame per box at Kmart, Shopify
  stores and Target). A card the store or Shop Pay already has for you ("Visa
  •••• 4242", no card boxes) counts, and so does a card Stripe's **Link** shows
  in its frame (Games World), once its "Confirm" is pressed.
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
| ⚠️ Needs you | Your bank's check, a bot check, the total over your limit, no confirmation after pressing |
| ❌ Failed | Sold out by the time your browser got there, not added to the bag, couldn't reach checkout, card declined, the card didn't go in, another item in the bag, it took too long |
| ⏭️ Didn't start | Over the item's max price, over your order or daily limits, 3 failures today, signed out (if you chose that, or at a store that only sells signed in: Amazon), no browser with the extension open, membership not active |

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
store's **checkout link** itself — Monitor → **My watchlist** → **🛍️ Shop checkout
links** → **+ Add checkout link**, e.g.
`https://creations.mattel.com/cart/48835830579405:2,40653613531341:1` (each option,
and how many). The link is the order, its quantities included, so its **max price
is for the whole link** (delivery on top, up to $40 more, within your limit an
order).

- **Watching.** Mugibot's server asks the store about each option in the link
  every 20 seconds, the way its own pages do (`/variants/<id>.js`), honestly as
  Mugibot. It's in stock once **every** option is; its price is the link's. The
  link itself is never opened by the server (it would start a checkout).
- **⚡ Buy and Auto-checkout** open the link as it is, which goes straight to
  Shop's checkout with your Shop address, delivery and card already in — nothing
  of yours is typed there, and Shop's choices are left as they are. Any box the
  store needs ticked to check out is ticked: Mattel Creations' **"By selecting,
  you indicate your acceptance of the Membership Agreement"**, and any box the
  checkout marks as required — never a newsletter or marketing box. **"Check
  out as guest"** is never pressed. ⚡ Buy stops at **Pay now** for you;
  Auto-checkout checks the total against your limits and presses it once. Shop
  then goes on to the store's own order page, and that's the order seen placed.
- **The store won't sell it** ("This Product is not available for purchase", as
  Mattel says when you're not a member): it stops there, nothing pressed, and
  says so.
- **Signed in to Shop only.** Signed out, Shop sends the link on to the store's
  own checkout as a guest, where Mugibot doesn't run. So the extension checks
  `shop.app/account` every 10 minutes with your cookies (the store login monitor,
  read-only), the section shows whether you're signed in, and Auto-checkout
  doesn't start while you're seen signed out (Discord's ⚡ Buy says so). A run
  whose tab doesn't reach Shop's checkout within 25 seconds says so — "Shop's
  checkout didn't open" — and is left in its tab for you.
- **No bag**: each link is its own order, so Shop links never wait for each other
  or for another checkout, and Clear cart has nothing to empty for them.
- Needs the extension **1.22.0** (it runs on `shop.app`): with an older one in
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
- Store purchase limits are respected. It buys one of each item.
