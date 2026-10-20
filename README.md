# Mugibot

SKU restock monitor + Discord pings + one-button checkout, for a members-only
community. Built on TCGCopBot's working Kmart flow.

- **Watch SKUs.** Each member has their own watchlist. Add a product link, or a
  store and SKU, even before the product is listed. Mugibot checks every SKU
  about once a minute and notices when it goes from **sold out → in stock**,
  when **pre-orders open**, and when a new SKU is **first listed**.
- **Get pinged on Discord.** The Mugibot bot DMs the member with a **⚡ Buy**
  button. Admins can also announce restocks in a server channel with a role
  ping, or send a manual restock ping to everyone watching a SKU.
- **Press one button.** ⚡ Buy, from the dashboard or the Discord ping, takes
  the member **straight to the store's checkout with the product in their bag**
  (one of it): Shopify stores through the store's own cart link, others by
  pressing Add to bag the moment the store's page can take it and going straight
  to checkout once it's in. The browser extension then fills in delivery details
  and card, following **that store's own checkout flow**, and **stops at the
  store's final button** ("Checkout securely", "Place order") for the member to
  press. The panel on the store's page does the same for a product that isn't
  on the watchlist (a link from another Discord): open it, press **Add to bag →
  Checkout**.
- **Auto-checkout (optional, per member).** A member who switches it on and
  agrees can **arm** items (each with a max price). When one drops, their own
  browser checks out by itself: adds it, closes "add more" pop-ups (Target's
  "Often Bought Together"), fills checkout in and presses the final button.
  It works within their limits (per order, orders and spending a day) and buys
  **once per arming**. It stops at a bank's or a bot check, a declined card,
  another item in the bag or a total over the limit. Each armed item says
  whether it's ready (its bag, the store sign-in, the card, the address, the
  checkout browser), on the Drops page's 🤖 Armed list. Every attempt is logged
  on the Checkout page with each step, how long after the drop it came and why it
  ended, and DM'd. **Clear
  cart** empties a store's bag in the checkout browser (or **Clear all**, every
  store in turn), from anywhere, so nothing else in a bag stops a drop. See
  [docs/AUTO-CHECKOUT.md](docs/AUTO-CHECKOUT.md).
- **⚡ Buy from your phone.** Press ⚡ Buy on a Discord alert or DM anywhere,
  your phone included, with nothing signed in there: Discord says who pressed
  it, and their **checkout browser** (the computer with the extension) opens
  the store and checks out. With Auto-checkout on it places the order within
  their limits; otherwise it stops at the final button for them. Discord's
  reply, seen only by them, follows it to the end. Runs only ever go to one of a
  member's browsers (the one they pick, or the newest), never to all of them.
- **🚦 Checkpoints and virtual queues.** Mugibot watches for JB Hi-Fi's hCaptcha
  checkpoint (`/checkpoint`) and EB Games' and Pokémon Center's virtual queues
  going up before a drop and coming down after. Each is posted in
  `#virtual-queue-detection`, shown on every dashboard and DM'd to members
  watching that store. ⚡ Buy and Auto-checkout wait at the checkpoint for the
  member to solve it, then carry on. In a queue they wait their turn, never
  refreshing the page, and check out once through. A member armed at that store
  gets their checkout browser in line by itself, and anyone can from Discord
  (📥 Join the queue on my computer). See
  [docs/MONITORING.md](docs/MONITORING.md#-checkpoints-and-virtual-queues).
- **🛍️ Shop checkout links.** At stores that check out with Shop (Mattel
  Creations, say), watch and arm the store's checkout link itself
  (`…/cart/48835830579405:2,40653613531341:1`): every option checked every 5
  seconds, ⚡ Buy and Auto-checkout open Shop's checkout with your Shop details
  and card, tick the store's required boxes (its membership agreement — never
  newsletters) and press **Pay now**. A checkout that says it isn't on sale yet
  is waited on, looked at every 5 seconds, and bought the moment it is. Your
  Shop sign-in is read off Shop's checkout itself, and each link shows it. See
  [docs/AUTO-CHECKOUT.md](docs/AUTO-CHECKOUT.md#️-shop-checkout-links).
- **🎯 Drop watches: anything that isn't the card keywords.** A console at
  JB Hi-Fi, a figure at any shop: paste its link, or type the words in its name
  and where to look (a store Mugibot searches, or any other website). An admin's
  are for everyone: posted in `#non-tcg-alerts` and every dashboard, with ⚡ Buy,
  and members arm Auto-checkout on them as on anything else. A member's own are
  theirs alone: what they find goes on their watchlist, DM'd. ⚡ Buy and
  Auto-checkout work at every store Mugibot knows, the same way as for cards;
  other websites get the alert only. See
  [docs/MONITORING.md](docs/MONITORING.md#-drop-watches-anything-that-isnt-the-card-keywords).
- **Every store has its own flow.** Kmart is verified. BIG W, EB Games,
  JB Hi-Fi, Target, Toys"R"Us, Amazon, The Games Cube, Gamerholic, Premium
  Bandai (Australia), and the card shops Pokébox, Good Games, Collectible
  Madness, Cherry Collectables (Shopify), The Gamesmen (Magento) and Games World
  (WooCommerce) are beta (built from walk-throughs of their real checkouts
  and tested on dummy copies of those stores). Zing, Trainer Town, City Beach and Pokémon
  Center (Australia) are drafts. Amazon sells signed in only; The Games Cube
  takes PayPal only, so it always stops there for you. Every store's buy button
  reads the same, whatever its words: "Add to cart", "Add to basket",
  "Pre-order", "Buy", "Buy now"… Flows live on the server, so fixing one
  reaches everyone without reinstalling the extension. See
  [docs/RETAILER-FLOWS.md](docs/RETAILER-FLOWS.md).
- **Memberships on Whop (A$19.99/month).** Members pay through Whop, and their
  account switches on automatically. Members who connect Discord are added to
  the private server with the members' role, and lose the role when their
  membership ends.
- **Accounts are a username and a password.** Each account has its own
  watchlist, delivery addresses (several if wanted), card (kept in that
  member's browser), alert settings and activity.
- **Live monitor** ([docs/MONITORING.md](docs/MONITORING.md)), built on
  MugiWatch. Every few seconds it reads each store's search results for your
  keywords (`pokemon`, `one piece`…) and alerts the moment it sees a 🆕 **new
  drop**, a 🟢 **restock** or a 📉 **price drop**: in the dashboard, in your
  Discord channels (image, store, price, stock and a ⚡ Buy button) and to
  every member watching that SKU. Every store is searched **server first**:
  from Mugibot's server, with an admin's browser (the extension) standing in
  only while a store refuses the server or the server can't read it — BIG W,
  Pokémon Center, Premium Bandai and The Gamesmen (their pages opened and read once they have
  built their product lists), EB Games and Amazon AU (asked for from inside one
  of their pages) often do — and the server taking back over as soon as it's
  let in. Admins can also monitor single products. Each channel
  gets what its rule asks for (by category, store, kind or keyword), and one
  button sets up a channel per store and game (`kmart-pokemon`,
  `bigw-one-piece`…, `premium-bandai`, `pokemon-center`, and `misc-retailers`
  for everything else). The dashboard's **Drops** page: a live sonar, each
  store's state (with **↻ Reset** for a store that keeps failing), today's
  numbers, a feed of new drops and restocks (with the product's picture, price
  and ⚡ Buy), drop pop-ups with a sound and a desktop notification, and every
  tracked product with its price history; admins also get Settings and the
  Check log on pages of their own. JB Hi-Fi Marketplace sellers' products are
  left out.
- **Store sign-ins.** The extension notices whether you're signed in at each
  store (when you open it, and every 10 minutes for the stores whose pages
  show it), and the Setup page lists where you are and aren't, with a
  **Sign in** link for each: signed in, ⚡ Buy's checkout is faster because the
  store fills in your saved details. The watchlist reminds you about a store
  you watch where you're signed out. It only looks: nothing is clicked or typed.
- **The dashboard is four pages** (a sidebar on a computer, a tab bar at the
  bottom on a phone): **🔥 Drops** (the live monitor, your watchlist, your
  armed items and whether each is ready, drop watches and activity, with a strip
  at the top saying whether you're ready for the next drop: membership,
  Auto-checkout, the extension, your card), **⚡ Checkout** (Auto-checkout, ⚡ Buy
  from your phone, Clear cart, run history), **🧰 Setup** (the extension, store
  sign-ins, browsers, your delivery details and card, Discord and pings) and
  **👤 Account** (membership and your account). Pages with several parts have a
  row of shortcuts at the top. Old links (`#checkout`, `#extension`, `#discord`,
  `#membership`, `#update`, `#watch`) still open
  the right part. Light by default, bright and clean; dark is one press away (☾).
- **Admin console** at `/admin`: members, memberships, Discord status, SKU
  totals, restock pings, stores and flows, a setup check, Whop memberships and
  an audit log.

## Start here

| I want to… | Read |
|---|---|
| Try it on my computer in 5 minutes, with dummy stores | [Quick start](#quick-start-on-your-computer) below |
| Put it online for members, step by step | **[docs/SETUP.md](docs/SETUP.md)** |
| Put changes live without a computer (merge on GitHub → live) | [docs/SETUP.md, step 3d](docs/SETUP.md#3d-automatic-deploys-from-github-no-more-terminal) |
| Set up the Discord server, bot, roles and slash commands | [docs/DISCORD.md](docs/DISCORD.md) |
| Set up the Whop product, A$19.99 plan, API key and webhook | [docs/WHOP.md](docs/WHOP.md) |
| Send a retailer's checkout flow (BIG W, Target…) or change one | [docs/RETAILER-FLOWS.md](docs/RETAILER-FLOWS.md) |
| Understand Auto-checkout: arming, limits, what it checks, the run history, card backup | [docs/AUTO-CHECKOUT.md](docs/AUTO-CHECKOUT.md) |
| Run the community day to day (admin console) | [docs/ADMIN.md](docs/ADMIN.md) |
| Set up the Monitor feed: products, alert channels, schedules | [docs/MONITORING.md](docs/MONITORING.md) |
| Put the extension on the Chrome Web Store, so it updates itself | [docs/CHROME-WEB-STORE.md](docs/CHROME-WEB-STORE.md) |

## Quick start (on your computer)

You need **Node.js 22.13 or newer** ([nodejs.org](https://nodejs.org), the LTS
download) and **Chrome** (or Edge or Brave). Check Node in Terminal with
`node -v`.

**On a Mac, the easy way:** after cloning, open the `Mugibot` folder in Finder
and double-click **`start-demo-mac.command`**. On Windows, double-click
**`start-demo-windows.bat`**. Either one checks Node, creates `.env`, starts
everything and opens the dashboard.

**Or in Terminal**, paste these lines (one command per line):

```bash
git clone https://github.com/JamieOnGit/Mugibot.git
cd Mugibot
cp .env.example .env
npm run demo
```

Do the `git clone` line only once. Run again from inside the Mugibot folder, it
puts a second copy inside the first. To get updates later, run `cd ~/Mugibot`,
then `git pull`.

`npm run demo` starts Mugibot on http://localhost:8080 and the dummy stores on
http://localhost:5055, and opens the dashboard in your browser. Leave that
Terminal window open while you use it (press Ctrl+C to stop). The admin
username is set in `.env` (`ADMIN_USERNAMES=jamie`): either sign up as `jamie`,
or change it first with `open -e .env` (Mac) / `notepad .env` (Windows).

1. In the dashboard that opens (http://localhost:8080), **sign up** with the
   username in `ADMIN_USERNAMES`. Admins always have access, so you don't need Whop to try it.
2. **Setup** → **Extension** → **Download the extension** → unzip it → open
   `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose
   the unzipped folder. Reload the dashboard and press **Connect this browser**.
3. **Setup** → **📦 Delivery & card**: fill in your name and address. Then press
   **Add your card** and save a test card, e.g. `4242 4242 4242 4242`, `12/30`,
   `123`. It stays ready for every ⚡ Buy, even after you restart the browser.
4. **Drops** → **My watchlist** → **Add dummy-store test items**.
5. Open the dummy store's control panel (http://localhost:5055), press
   **in_stock** on a sold-out product, and watch your watchlist ping. Press
   **⚡ Buy** on any dummy item and watch the extension go all the way to the
   final button, using that shop's own flow. (Nothing is real; no order is ever
   placed.)

Discord and Whop are optional for this. Add them later with the guides.

## How the monitor works (and staying unblocked)

- **Live sweeps.** Each store's search for each keyword, read in full every few
  seconds, each store on its own loop (docs/MONITORING.md). Stores that refuse
  servers are searched from an admin's browser instead. A member's SKU that a
  sweep comes across is updated straight away.
- **Server checks.** Mugibot's server checks each product page once per
  interval, however many members watch it. Requests say who they are
  (`Mugibot/1.0`) and keep a gap between requests to the same store.
- **In-browser checks.** Some stores, Kmart included, refuse requests from
  servers. For those, each member's own browser, with the extension, re-checks
  **that member's own SKUs** about once a minute, just like refreshing the page.
  The results only ever update that member's own watchlist. Members can switch
  this off on the Setup page. BIG W, which resets every server's connection, is
  only ever read by browsers: each product's page opened in the extension's
  window, at most every 15 minutes, and left alone for 30 minutes after an
  "Access Denied" (docs/MONITORING.md).
- **Not listed yet.** A SKU without a product link is looked for on the store's
  search page. When the page goes up, members get a "Listed" ping.
- **Never evades bot protection.** If a store shows a bot check, Mugibot backs
  off and marks it "Blocked by site". It never solves CAPTCHAs, skips queues or
  disguises traffic. Admins can always send a manual restock ping.
- **Checkpoints and queues.** JB Hi-Fi's checkpoint is looked at by the server
  (honestly `Mugibot/1.0`). EB Games' and Pokémon Center's queues are looked at
  from an admin's browser as a new visitor, with no cookies, so nobody's place
  in line is touched. While a queue is up, a browser that isn't through it asks
  that store for nothing.

## Fair play (same guardrails as TCGBot/TCGCopBot)

- ⚡ Buy always stops at the final purchase button for the member to press.
  Only **Auto-checkout** presses it, and only for a member who switched it on and
  agreed, for items they armed, within their limits, once per arming
  (docs/AUTO-CHECKOUT.md). It runs in the member's own browser, and the card
  is only ever readable there.
- No CAPTCHA, queue or bot-protection bypassing, and no proxies.
- Store purchase limits are respected: if a store allows 2, it adds 2 and says so.

## Whose data is where

| Data | Stored | Who can see it |
|---|---|---|
| Username, email (optional), membership | Server database | The member; admins (for support) |
| Password | scrypt hash only | Nobody |
| Delivery addresses | Server, **encrypted with a key unique to that member** | The member and their connected extension |
| Alert settings, Discord tokens | Server, encrypted per member | The member |
| Watchlist, activity, connected browsers | Server, tied to the member | The member (admins see totals only) |
| **Payment card** | **In the member's browser extension**, encrypted with a key that only that browser's extension has | The member. It's never sent to the server in readable form. |
| Card copy for extension updates (on unless the member switches it off) | Server: only a copy **locked in the browser** (AES-256-GCM) with a random key the member's dashboard keeps in that browser, plus brand, last 4 and expiry | The member's extension, once connected from their dashboard in that browser: the key never leaves the browser, so the server can't open it by itself |
| Card backup (optional, the member turns it on) | Server: only a copy **locked in the browser** with the member's card passphrase (PBKDF2-SHA256 600,000 rounds → AES-256-GCM), plus brand, last 4 and expiry | Nobody but the member: the passphrase never leaves their browser, so the server can't open it |
| Membership payments | Whop | The member; you, on Whop |

Card numbers are deliberately not stored on the server in readable form.
Keeping them there would make you responsible for PCI-DSS card security, and
CVVs may never be stored that way. Each member's card stays in their own
browser, encrypted and tied to their account, and is filled in at every store's
checkout. The copy kept for extension updates and the optional backup work
like a password manager's vault: each is locked in the member's browser before
it's sent and Mugibot never has the key, so the server holds nothing it can read
by itself (have your own adviser confirm how that sits with PCI-DSS where you
trade). The copy for updates is opened with a key kept by the dashboard in the
member's own browser — code served on the dashboard's address could reach it,
so it's a convenience members can switch off (Setup → Delivery & card), unlike
the passphrase backup.

## Tests

`npm install` fetches Playwright (for the browser tests), then `npm test` runs
the 411 tests in about twenty minutes:

```bash
npm install
npm test
```

- **Accounts:** usernames, sessions, rate limits, resets by email, Discord DM or admin link.
- **Isolation between members:** watchlists, addresses, alerts, activity, devices,
  ⚡ Buy codes, in-browser results, admin views.
- **Whop** (fake API): checkout links with the account ID, signed, forged, stale and
  repeated webhooks, payment failure, cancellation, buying on Whop first, other
  products, free access, missed webhooks, cancelling on account deletion.
- **Discord** (fake API): connect, server and role following the membership,
  DM pings with signed ⚡ Buy buttons, closed DMs, rate limits, slash commands
  (Ed25519-signed), restock posts with role pings, the setup check.
- **Monitor** (dummy stores): one request per page, the honest User-Agent, price
  limits, not listed → listed → restock, Shopify JSON, blocked stores handed to
  browsers, store switches, announcements, private-address protection.
- **Live sweeps** (dummy stores, fake Discord): reading Target's, Shopify's and
  any store's search results; the first sweep sets the scene; new drops,
  restocks (once a day) and price drops alert at once in the feed, Discord and
  to members watching the SKU; the filters; refused searches back off; new
  keywords set the scene again; admins' browsers sweep the stores that refuse
  servers (members' never do); the per-store loops; the store client.
- **Speed** (dummy stores, a fake Discord as slow as from Sydney): a restock ten
  members watch, one of them armed — the armed member's Auto-checkout run made
  first, the channel ping next (in Discord within a second of the store's
  answer, before any DM), the DMs a few at a time; Discord's line (a drop's
  channel post ahead of queued DMs, a "slow down" holding no place in line, a
  route with nothing left waiting for its reset); Kmart's whole range in one
  request (both keywords' products, a restock in some states only saying which,
  a list that fails falling back to each keyword at once, a refusal still the
  store's); searches on the pace from the start of the last one; members' alerts
  still sent when a search or page check fails partway through.
- **Kmart's "In store only"**: its own status — the alert says it can't be
  ordered online, with no ⚡ Buy, and nobody's Auto-checkout starts; online
  later that day, it alerts as a restock all the same.
- **Target's greyed-out "Add To Basket"** (`test/unit.test.js`, as Target's real
  pages are): a product with neither home delivery nor click & collect in
  Target's own page data is out of stock, though its JSON-LD says InStock; one
  with either is in stock.
- **Hot drops: a store slowed right down** (end to end, a dummy Kmart under load):
  its buy box 18 s in coming ("Loading…") and its cart 20 s in answering — waited
  through, added once, never to the bag early, on to checkout; its Add button
  greyed out 20 s — waited for, then pressed; its product page answering "Too
  many requests" twice — looked at again each time, then added; and a sold-out
  product still said so in seconds (nothing waited for).
- **EB Games' cart as a pop-up** (end to end): already empty, it's "already empty",
  not "couldn't find your bag".
- **A product that isn't on your watchlist** (end to end, a real Chrome with the
  extension): the panel reads it off the page and checks it out — Kmart's
  checkout with one in the cart and the card in, JB Hi-Fi's Shopify checkout —
  nothing placed; a page that isn't a product says so.
- **An admin's browser, each store on its own** (`test/serverfirst.test.js`, and
  end to end): a store whose search is slow (BIG W's, held 6 s) doesn't hold up
  the others — Kmart is searched again and again meanwhile — and isn't searched
  twice at once; the server hands out no store that browser's still searching
  and keeps its keyword's turn; the admin's-browser seconds from 2, BIG W at most every
  10 s.
- **Shop checkout links** (`test/shoplink.test.js`, and the 🛍️ end-to-end tests on
  a Shop-style dummy checkout): any store's cart link is one, a known store's stays
  its own, a Shop page isn't one; watched option by option (honestly as Mugibot,
  the link never opened by the server), in stock once every one is, its price the
  link's, checked every 5 s; armed, the browser opens the link itself; with an
  extension before 1.27.1 it doesn't start; an older extension's reading of
  Shop's account page is left out, and a "signed out" reading never holds a run
  back; a tab that never reaches Shop says so (the link: signed out), but not
  once it got going (the link: signed in); not on sale at the checkout, "Pay now"
  pressed again every 6 s on the same checkout — said once, the run waiting for
  the sale, its presses counted — placed the moment it's on sale; Mattel's real
  checkout as probed ("Pay now $X", the membership box's words beside its label,
  the notice left up) the same. In Chromium, as a member's real checkout looked (signed in, "Sign in to
  your account" in the page's code, the membership notice and "not available for
  purchase" up from the start): the agreement ticked, the newsletter box and
  "Check out as guest" left alone, the total checked, "Pay now" — placed as Shop
  goes on to the store's order page, seen signed in from the screen, Shop's
  account page never read; refused "not available" to "Pay now", it waits on the
  checkout without pressing again and is placed within seconds of going on sale;
  signed out, the run says so in seconds, and signed in again the next drop
  starts and is placed.
- **A checkpoint from the phone** (`test/phone.test.js`, and the 📱 end-to-end
  test): ⚡ Buy while JB Hi-Fi's checkpoint is up says so, with 🖥️ Solve it on
  my computer and 📱 Finish on this phone; the reply and DM at the checkpoint
  carry both; opening the phone's link changes nothing, pressing it stops the
  computer and opens the store's cart link; never once the computer is
  checking out, has pressed the final button or placed it, nor with an older
  extension at the check; the computer's tab stops even if the check is then
  solved there, nothing pressed; an armed item finished on the phone is
  disarmed.
- **Server first** (dummy stores): every store searched from the server; an
  admin's browser stands in after 3 refusals (1 at stores known to refuse
  servers, or a page the server can't read, with no flood of "new"), the
  server's tries after 5, 10, 20, 30 minutes (its usual backoff while no browser
  is searching), Retry-After, Reset, Sweep now, its take-back, and members never
  seeing any of it; with the real extension standing in and stopping again.
- **Monitor feed** (dummy stores, fake Discord): name, image, price and stock
  from the first check without an alert; restock, price drop and rise alerts
  once per cooldown; alert rules by category, store, kind and keyword; price
  history, check log and health; pause, resume and intervals; Shopify cart
  links; blocked stores keep their last status; admins' browsers for stores
  that refuse servers; `/monitor` and `/restocks`.
- **Card boxes in payment frames** (Chromium): a frame asking for the focus
  before the page above is listening asks again and is focused at once (not
  after the 1.5 s fallback), once, also two frames down and queued behind
  another frame.
- **The real extension in Chromium:** Kmart (verified; signed in and as a
  guest, whose cart turns an early add away), BIG W, EB Games (Click & Collect
  switched to Home Delivery, the address from its suggestions, "Credit / Debit
  card", "Done"; and signed in), JB Hi-Fi, Trainer Town, Toys"R"Us and
  Gamerholic (the card in Shopify's per-box card frames), The Games Cube
  (stops at PayPal), Target (its "Often Bought Together" pop-up closed, Home
  Delivery and Credit Card tiles, the address from its suggestions, Paydock's
  card form; and signed in), Amazon (Buy Now, "No thanks" to Prime; and
  signed out), Pokémon Center and Premium Bandai (its checkout in a
  Global-e-style frame: +61 phone, state and card-expiry drop-downs, the
  purchase agreement), Pokébox, Good Games, Collectible Madness and Cherry
  Collectables (Shop Pay, and as a guest with Shopify's address suggestions and
  "use shipping address as billing" ticked), The Gamesmen (as a guest and signed
  in with a saved address; "Standard" shipping or the first one offered; the
  billing box left unticked; "Credit card"; the terms box) and Games World (its
  add-to-cart link, selectWoo's state drop-down, "Deliver to a different
  address?" unticked, Stripe's card form or a Link card and its Confirm) flows
  each stop at their final button with nothing pressed — every store's buy
  button by its words ("Buy Now", "Add to Basket", "Buy", "Pre Order"; "Add to
  bag" over a "Buy Now" beside it) — plus the
  card saved without a passphrase and still ready after the browser restarts,
  a card from an older version moving over, the card in a payment frame, card
  boxes in separate frames that only take real typing or key presses (like
  Adyen's), and a clear message when the card can't go in, the Chrome Web Store
  copy taking over from a downloaded one (never both acting at once), the
  Discord ⚡ Buy button, in-browser checks, an admin's browser sweeping a store
  that refuses the server, and two accounts in one browser.
- **Chrome Web Store:** the package, the admin's listing link, and the GitHub
  job that publishes each new version (against a fake Chrome Web Store API).
- **Auto-checkout** (server, plus the real extension on the dummy stores):
  - the agreement and limits; arming needs a max price;
  - a drop starting a run, picked up at once by a waiting browser;
  - an order placed once, then disarmed;
  - failures staying armed, and 3 a day stopping it;
  - the day's limits, and the "stop at the final button" mode;
  - runs that stall, and other members' browsers kept out;
  - at the dummy Kmart and Target: Target's upsell pop-up closed, the total
    over the limit, another item in the bag, a declined card and a bank's check;
  - orders placed at the dummy EB Games (guest and signed in), JB Hi-Fi,
    Toys"R"Us (Shop Pay), Amazon (its checkout page and its quick checkout),
    Premium Bandai (inside Global-e's frame), Pokébox (Shop Pay), Collectible
    Madness (as a guest), The Gamesmen (as a guest and signed in) and Games
    World (as a guest, and with Stripe's Link), and The Games Cube stopping
    at PayPal for you;
  - an add the store didn't take (the empty bag noticed, Add pressed once more,
    then it says why);
  - several at once: drops at two stores checked out side by side (the tabs
    taking turns to type their cards), two at the same store one after the
    other (the second next in line, then its own order), ⚡ Buy pressed in
    Discord or on the dashboard while a run is going, and a run next in line
    giving up after 20 minutes;
  - a checkout in a tab behind another at full speed (Chromium on its own, the
    way Chrome slows a background tab's timers);
  - never stuck between the bag and checkout: a bag count that doesn't move
    (added once, never twice), no bag link or "added" pop-up, and a bag page
    whose Checkout button Mugibot doesn't know;
  - Trigger ACO (a test run now, from the dashboard), and stores that only sell
    signed in (Amazon);
  - a drop for several members: every armed member's run made before anyone's
    alerts go out; a brand-new listing's only option straight to the store's
    add-to-cart link; the final button's outcome counted even when its
    "placing" report comes second;
  - ⚡ Buy from your phone: a Discord button pressed (signed by Discord, for
    whoever pressed it) makes the checkout browser check out, the real
    extension included, with nothing armed. It places the order with
    Auto-checkout on and stops at the final button otherwise, or when a limit
    or the max price is in the way. The reply follows the run. Runs go to the
    checkout browser alone, a picked one or the newest. Also covered: someone
    else's button, an unconnected Discord, no membership and "Send to my
    computer" on the buy page.
  - Clear cart: every dummy store's bag emptied its own way — Remove buttons,
    a bin icon posting a form, Shopify's `/cart/clear.js` and its Remove links,
    Magento's "Remove item" forms, WooCommerce's × links,
    "Are you sure?" pop-ups and the browser's own confirm box, a "Removing…"
    button, Target's "Undo" and Amazon's "Save for later" never pressed (its
    saved list left alone) — then checked empty; Clear all in one tab; a store
    with a checkout going left alone; a drop while a bag's being emptied going
    next in line; a bag with something else in it stopping Auto-checkout, emptied,
    and the next drop bought; a Remove that does nothing, a queue where the bag
    should be, a page that won't load, and a bag address that's a page not found.
- **Checkpoints and virtual queues** (dummy JB Hi-Fi checkpoint that only a
  person's click solves; dummy EB Games and Pokémon Center queues that refresh
  themselves and lose your place if anything asks again too soon):
  - the server seeing JB's checkpoint go up and be disabled (twice to count),
    honestly itself;
  - members' and admins' browsers seeing a queue, and only a look as a new
    visitor taking it down;
  - the posts in `#virtual-queue-detection` (the monitor's embed), DMs and the
    dashboard banner;
  - checks and searches held while a queue is up, unless the browser is through;
  - with the real extension: ⚡ Buy and Auto-checkout waiting at JB's
    checkpoint (never touching it) and carrying on once a person solves it;
  - Auto-checkout through EB's queue and ⚡ Buy through Pokémon Center's, never
    refreshing them (no place lost, only the page's own refreshes);
  - a queue going up putting an armed member's browser in line, a drop
    meanwhile waiting for that tab, then placing the order;
  - an admin's sweep tab left alone in the queue, the queue seen up and down
    as a new visitor;
  - 📥 Join the queue from Discord, and runs not waiting forever.
- **🎯 Drop watches** (dummy stores, a dummy "other website", fake Discord):
  - `#non-tcg-alerts` made with the store channels (or on its own), and what
    isn't trading cards going only there;
  - an admin's link (an Xbox at JB Hi-Fi): monitored for everyone, posted with
    ⚡ Buy, a member arming it and their Auto-checkout starting;
  - an admin's words at a store: searched as typed in the sweeps' turn (one
    search in three at most), the first look the scene, a new drop posted and
    bought for the admin;
  - a member's own words: on their watchlist only, DM'd and bought when it
    drops, never posted, its words hidden from others;
  - a link and words at another website: read as Mugibot, alerts with no
    ⚡ Buy, a site that refuses backing off;
  - a product at another website (a Garmin watch, say): DM'd when its page goes
    up, when it gets cheaper (📉 at least 1% and $1; again only lower still or
    half a day later), back in stock and open for pre-order; `#non-tcg-alerts`
    given price drops once; stricter words ("xbox series x" isn't the Series S);
    Kmart's whole store for a watch's words; a broad watch keeping room for what
    drops; one purchase per watch;
  - with the real extension: ⚡ Buy for a product that isn't a trading card at
    every one of the 13 stores, to its final button; a drop watch on a console
    at JB Hi-Fi bought by Auto-checkout; the 🎯 tab's ⚡ Buy;
  - the dashboard's 🎯 tab: link or words, where to look, Auto-checkout only
    where Mugibot checks out, for everyone or just for you.
- **Amazon sweeps from an admin's browser:** its search page asked for from inside
  an Amazon page (the dummy Amazon gives servers HTTP 503, like the real one).
- **Dashboard round:** the card backup (only a locked copy reaches the server,
  which can't open it; restored in a fresh install with the passphrase; a wrong
  passphrase refused; kept per account), the card's copy for extension updates
  (a fresh copy of the extension gets the card back on Connect this browser, no
  passphrase; only a locked copy reaches the server, never its key), the 🤖
  Armed list (its checks lined up row to row, To fix, Get ready), Tracked
  products past 600, activity, watchlist, products and run history paged,
  members' own store switches, and members never told where a store is
  searched from (API and live stream).
- **Website in a browser:** the dashboard's four pages (each page's parts and
  shortcuts, the ready-for-the-next-drop strip, old links landing on the right
  part, the tab bar on a phone) and every admin tab, including the
  Drops page (live alerts, live sweeps' health and settings, the Tracked
  products / My watchlist / My activity tabs, store switches, product page with
  price chart, alert rules, light and dark themes), phone-sized screens, no
  JavaScript errors.

## Layout

```
server/
  app.js            routing and security checks      repo.js     all per-member data access
  db.js             SQLite schema                    crypto.js   passwords, tokens, encryption, signed links
  retailers/        one file per store, with its checkout flow (kmart.js, bigw.js, …)
  monitor/          sweep.js (live sweeps), listing.js (search results), http.js (store requests),
                    SKU page checks and in-browser check results, feed.js (alerts),
                    public.js (what members see of the sweeps), gates.js and gate.js
                    (checkpoints and virtual queues: up, down, #virtual-queue-detection),
                    drops.js (drop watches: anything outside the card keywords, #non-tcg-alerts)
  catalog.js        the Monitor's products, monitors, price history, check log, alert rules
  discord.js        Discord OAuth, server roles, DMs, channel posts
  whop.js           Whop checkout links, webhooks, membership sync
  notifier.js       a member's pings: activity feed, Discord DM, webhook, email
  aco.js            Auto-checkout: runs, limits, why each one ended (docs/AUTO-CHECKOUT.md)
  routes/           auth, user, ext (extension API), membership, discord (+ slash commands), monitor, admin, web
web/                landing, sign-in, dashboard, ⚡ Buy page, admin console, terms, privacy
extension/          the browser extension (built per server by server/extension.js)
devtools/           the dummy stores (Kmart-, BIG W-, EB Games-, Shopify- (JB Hi-Fi, Trainer Town, Gamerholic,
                    Toys"R"Us), CrystalCommerce- (The Games Cube), Target- (with its upsell pop-up), Amazon-,
                    Pokémon Center- and Premium Bandai-style)
scripts/            demo, mockstore, discord-commands, make-admin, reset-link, backup, build-extension, publish-extension,
                    make-icons.py (the site's and the extension's icons, from the logo)
brand/              the logo (the straw-hat robot); after changing it: python3 scripts/make-icons.py
docs/               setup guides
test/               node:test + Playwright
```
