# Mugibot Monitor: live sweeps, restock feed, price tracking, Discord alerts

The Monitor is Mugibot's shared product feed. It's built on **MugiWatch**: every
few seconds it reads each store's search results for your keywords (e.g.
`pokemon`, `one piece`) in full, and compares them with what it saw before.

| Alert | When |
|---|---|
| 🆕 **New drop** | A product that wasn't in the results before |
| 🟢 **Restock** | Out of stock → in stock (or pre-order). At most once a day per product, like MugiWatch |
| 📉 **Price drop** | The price fell by at least the set percentage (10% to start with) |

Alerts go out the moment a sweep sees the change:

- the dashboard's **Monitor** tab (live, no refresh)
- the Discord channels whose rules match, with ⚡ Buy, Open product and price history buttons
- every member watching that SKU: their own watchlist, DM, webhook or email

Admins can also add **monitors** for single products (a link or a SKU), and
members' own watchlists keep working as before. Everything is one system: the
same products, the same alerts, the same ⚡ Buy.

---

## 1. Where each store is searched from

**Server first** is every store's default but BIG W's: Mugibot's server searches it, and
an admin's browser (the extension) only stands in while the server can't.
**BIG W** is searched from **an admin's browser** by default (October 2026), in a
private window of its own where Mugibot's allowed in Incognito: the server can never
draw its products, so its tries only ever handed BIG W over to the browser again — and
the console said **Waiting** each time it did (after every restart, too). The server
never searches BIG W now unless an admin sets it to **Server first** or **Server only**.

- **Hand-over.** The store refuses the server, or its search fails, **3 times
  in a row** — once, at a store known to turn servers away (Amazon, EB
  Games, Pokémon Center, Premium Bandai, The Gamesmen). Or the server's read has **no
  products** where there are some: a page that only draws them once it's open
  (Pokémon Center's), or a search an admin's browser found products
  for in the last hour. That empty read sets no scene, so the browser's first
  look doesn't turn everything into a "new drop". From then on the store's
  searches go to admins' browsers, at the browser pace (15 s, or the store's own
  slowest), and the console says **Waiting for an admin's browser** until one
  takes them.
- **The server tries again** after **5 minutes**, then 10, 20, and every 30
  minutes after that (one search, the first page of a keyword the browser found
  products for), never before a time the store asked for (Retry-After). A try
  doesn't count against the browser, and members don't see it. Until an
  admin's browser is actually searching the store (none open, say), the server
  keeps trying at its usual backoff instead, at most 15 minutes apart — the
  store's never left unsearched for longer than before.
- **Take-back.** The moment the store answers the server, the server takes
  back over, gently at first (a third of the pace for 10 minutes, as after a
  Reset), and the browser stops searching it. A search the browser was given
  just before still counts.
- **↻ Reset** puts the server first again straight away. **Sweep now** makes the
  server try now.

The same goes for monitored products' page checks: admins' browsers check a
store's monitors while the server's being refused there — and any one monitor
whose own page refuses the server (a drop watch's find at BIG W, say), while the
rest of the store answers.

**BIG W's product pages: browsers only** (extension 1.27.0). BIG W's bot
protection (Akamai) resets every server's connection, so its watchlist items all
said **Error**. Now the server never asks BIG W for a product page (its
`monitor.server` is `'never'`: the admin switch can't put it back), and the
"Error" its old tries left is forgotten when the server starts. Members' browsers
read their own BIG W items instead, and admins' browsers the shared monitors:

- **Opened, not fetched.** Each product's page is opened in the extension's
  minimised window, the way you'd open it, and read once its buy box is drawn
  (up to 10 s), then the tab's left blank. Requests from the extension's
  background are what got browsers turned away.
- **At the usual pace in a private window** (extension **1.36.0**). In a
  browser that opens BIG W in a private window of its own (Mugibot allowed in
  Incognito), each product's page is read every minute, as the other stores'
  are, as many a round as the round has room for. The live searches there go
  at the admin's-browser pace set, like EB Games' and The Gamesmen's. Search
  pages watched there go down to every 3 s.
- **Gently in an ordinary window.** Without that private window: one BIG W page a
  round (every 30 s) per browser, each product at most every **3 minutes**
  (`browserSeconds: 180`; 15 before October 2026, though a slip read members'
  items every minute), one live search every 20 s (`sharedWindowSeconds`; was
  10), and search pages watched every 20 s at the fastest. Until an admin's
  browser has said it's in its private window, the ordinary-window pace applies.
- One product a live search saw in the last few minutes isn't opened at all.
- **"Access Denied".** When BIG W turns a browser away — a check, a live search,
  or a page you open yourself — that browser leaves BIG W alone for 30 minutes (no
  checks, no searches), the item says why, and the store panel on the page says
  so too, with what to do: clear BIG W's cookies in that browser, or try another
  network. Asking more only makes it last.
- **Older extensions** (before 1.27.0) aren't given BIG W pages: they'd fetch them
  in the background.

**EB Games: never from the server.** EB's Cloudflare turns away every server,
every time (the admin console's page checks showed EB Games at 0% in October
2026), so the server never asks it (`monitor.server: 'never'`, as at BIG W),
whatever an admin saved. Members' browsers check their own EB items, admins'
browsers the shared monitors, and its searches come from an admin's browser.
The console's **Server checks** column says **Off** for it.

**Kmart: its search provider, by keycode.** Kmart's product pages turn servers
away too (the same console showed Kmart at 0%). Its search provider doesn't:
the server reads each Kmart product from Constructor.io's item lookup by its
keycode (`monitor.lookup`: `/browse/items?ids=P_<keycode>`) — its stock (in
stock somewhere, or out in every state), price, picture, pre-order and "In
store only", as Kmart's own pages show them — and never asks for the page. A
keycode it doesn't know is **not listed yet**; once it is, its link comes from
the lookup too. Refused there, the item says so and the next check backs off, as
for any store.

**EB Games' product pages: from inside an EB tab** (extension **1.35.0**). In
October 2026 every EB Games item on a watchlist said **Blocked by site**: EB's
Cloudflare refuses the server ("The store refused the server check (HTTP 403)")
and, since then, the extension's background checks too ("The store refused your
browser's check (HTTP 403) — backing off"), while your own visits, ⚡ Buy and
Auto-checkout go through. Its restocks were only seen when a live search
happened to list the product. Now (`monitor.inPage`):

- **Asked from inside EB's page.** Each item's page is asked for from inside a
  tab of EB Games' kept in the extension's minimised window (`check:<store>`,
  apart from the live searches' tab), the way EB's own pages ask it for things,
  never from this browser's cache. The first check opens the item's page there,
  as you'd open it.
- **Refused there too:** the page is opened in that tab instead and read once
  it's drawn. A bot check's page is waited on for a few seconds, in case it lets
  the page through by itself, and never answered. The tab then stops asking from
  inside the page for 30 minutes and opens each page instead.
- **A product code with no link yet** is looked up in EB's own search data
  (`/search/query?q=<code>`, what its search page asks for). Its link is kept
  once found.
- **Same pace as before:** each item about once a minute, up to 5 checks a
  round, 4 s apart per store. A tab showing EB's queue is never touched.
- **Older extensions** (before 1.35.0) ask in the background as before, and are
  still refused. Press **Update** in the extension.

**BIG W's drops** (October 2026, extension **1.28.0**). A member's Pokémon TCG
30th Celebration Ultra-Premium Collection went on sale at BIG W at 7 am without
an alert. BIG W can only be read from browsers, so:

- **On sale after being listed with no buy button.** BIG W lists a drop ahead of
  time with no buy button in its search tile. Mugibot keeps that as "stock not
  known" (not sold out), and buyable after that didn't count as a restock. Now a
  product listed that way for **10 minutes** or more alerts the moment it's
  buyable: "On sale now at BIG W — listed before without a buy button". A button
  drawn within minutes of the listing isn't a drop.
- **The pages of what the searches found.** Admins' browsers also open the page
  of each BIG W product the live searches found in the last 3 days that nobody
  monitors: its tile may not say when it's on sale, its page does. The ones that
  can't be bought yet come first. Each is read at most every 3 minutes (every
  minute in a private window), and every 30 minutes once it's buyable (to see it sell out, so its next restock alerts).
  On sale there after sold out, coming soon, or 10 minutes with no buy button on
  that page: a restock alert (once a day), and everyone watching it is updated,
  armed Auto-checkouts first. In stock the first time its page is read, when its
  tile never said either way, has nothing to compare with, so it doesn't alert
  (after an update, every product in stock would). A product with a monitor
  alerts by its monitor instead.
- **Pages 2 and 3.** BIG W's search shows 48 products a page, by relevance, so a
  new listing can be further down. After each round of keywords one later page
  is read, opened by the page's own **Next** link (nothing is guessed about BIG
  W's addresses), and only where it has one. A product first seen on page 3 may
  only have moved up from page 4, so it's tracked without a new-drop alert; it
  still alerts the moment it goes on sale.
- **Back after a long gap.** A search that hasn't come back for 6 hours sets the
  scene again, so its return isn't a flood of "new" products. Now the first
  **3** products nobody had seen still alert: what was listed while the browser
  was turned away.
- **"BIG W isn't being watched".** When no BIG W search has found a product for
  **20 minutes**, every admin gets a DM (and an email, where they have one). That
  happens when no admin's browser is searching (Chrome closed, the computer
  asleep, the extension signed out) or BIG W is turning it away. The DM says why
  and what to do, and another follows when it's back. The same goes for any store
  searched only from admins' browsers.
- **Riftbound and Gundam** (`riftbound`, `gundam card game`) are searched for by
  default with Pokémon and One Piece, and are added to a keyword list saved
  before them. Take them off in the settings, and they stay off.
- **The extension says its version** with its checks, so an updated copy gets
  BIG W's pages straight away. Before, a copy updated since it last opened its
  menu was taken for the old one.

**BIG W all day** (extension **1.29.0**). BIG W is searched only from admins'
browsers, so the extension keeps it going for as long as the browser is open:

- **Its tab is never thrown out.** Chrome's Memory Saver discards tabs that
  haven't been looked at for a while. The sweep window's tabs are marked as ones
  Chrome must keep, so BIG W's search page is never discarded overnight.
- **A search that never ends is given up.** One store's search that takes over
  **90 seconds** (a page that never answered) is said as a failed one. Its tab is
  closed and opened afresh for the next search, never in a store's queue. Before,
  one hung page could stop that store being searched from that browser until
  Chrome was restarted.
- **A loop gone quiet is started again.** Chrome's alarm looks at the sweep loop
  every 30 seconds. Not running: it's started. Running, but nothing has happened
  in it for **3 minutes**: it's started again, and the old one stops at its next
  step.
- **A private window of its own** (extension **1.30.0**). Allow Mugibot in
  Incognito (chrome://extensions → Mugibot → **Details** → **Allow in
  Incognito**) and BIG W's searches and page reads happen in a minimised private
  window of their own, with their own cookies. That keeps them apart from your
  own BIG W visits and checkouts in that browser: if BIG W's bot protection
  takes Mugibot's reading for a bot, it's the private window it turns away, not
  you. Not allowed, they use the ordinary sweep window as before, and the live
  monitor (and the extension's menu) says how to allow it. Checkouts never open
  in a private window: they need your own sign-ins.
- **"Access Denied"** still means BIG W is left alone from that browser for 30
  minutes, then searched again by itself. In the private window too: it's kept
  as it is, with its cookies — Mugibot never opens a fresh private window to get
  round a refusal. After 20 minutes with no BIG W finds,
  every admin gets the "BIG W isn't being watched" DM, as above.

**BIG W from an admin's browser by default, and what an empty page said**
(October 2026, extension **1.32.0**). BIG W's line on the live monitor kept saying
**Waiting · No products on the page** while its searches were finding plenty:

- **Admin's browser by default.** BIG W was server first, but the server can never
  draw its products, so each of its tries (and every restart) handed BIG W back to
  the browser and showed **Waiting** until the browser's next search. Now it's
  searched from an admin's browser (its private window, where allowed) from the
  start. An admin can still pick **Server first** in Monitor → Settings → Stores;
  BIG W left as it was gets the new default.
- **One search's empty answer isn't the store's state.** A search that found nothing
  (a key phrase BIG W doesn't sell) is a note on that search — its details' **last
  search**, and **Every search** — and the store's line says **Searching**, or why
  it's **Waiting** ("Waiting for an admin's browser"), never "No products on the page".
- **What the page said.** With nothing to read, the extension says what BIG W's page
  said: **No results** (BIG W's answer — and it stops waiting there at once, not after
  15 s) or **57 results** that hadn't been drawn yet (said as that, read again next
  round at the usual pace, nothing taken for new).

BIG W is watched only while an admin's computer is on with Chrome open and the
extension connected. Two admins' browsers in different places read its product
pages twice as often, and keep it watched if one is turned away.

Your checkout opens BIG W in your own browser, as you would. There's no proxy or
gateway in between, and Mugibot never disguises traffic. If BIG W turns your
checkout browser away, use a different computer or network for an admin's
sweeping than for checking out.

An admin can still pin a store (**Monitor → Settings → Stores**): **Server
only** (never a browser), **Admin's browser** (never the server) or **Off**.
Settings saved before server first: a store set to the server or a browser is
server first now (only a store switched off stays off); choices made after it
stick.

| Store | Searched from | What's read |
|---|---|---|
| Target | Server first | Target's search page, newest first: every page with results (up to 4 pages of 48), with stock for every colour and size |
| JB Hi-Fi | Server first | JB Hi-Fi's search suggestions (Shopify): 10 products a search, with stock. "tcg" is added to each keyword ("pokemon tcg"), because "pokemon" alone finds plushies and games. **Every other search, its newest products** (`sweep.newestPath`: `/products.json?limit=30`, its whole range by when each was published, newest first — the top 30 are the last 20 minutes or so of what it put on sale): a drop is in it the moment JB publishes it, however far down the 10 a search returns it'd sit. Each product in it counts for the keyword in its name; one JB made more than 14 days before (JB republishes older products all day) and new to the catalogue is only noted, never alerted as a drop; and the list says who sells each one (a "Seller" option for marketplace sellers), so nothing more is asked of JB before a drop's alert. Its collections' own lists are empty: its pages draw them with their own code |
| Toys"R"Us | Server first | Same as JB Hi-Fi (also a Shopify store) |
| Trainer Town | Server first | Each game's whole collection (Shopify's product list for it): every product, sold-out ones too, with stock, price and the option to add to the cart, in one read. A keyword with no collection of its own is searched instead (search suggestions, like JB Hi-Fi). At most one read every 15 seconds: reading the whole collection every 5 seconds made Shopify answer **HTTP 429** (too many requests) |
| Kmart | Server first | Kmart's search provider, Constructor.io: each keyword within Kmart's **Trading Cards** category, sold by Kmart or Target (not marketplace sellers), newest first. Every product's code, price, picture, pre-order flag and the states it's out of stock in: out of stock in every state = sold out online. Its loop reads **every trading card it sells in one list** (its Trading Cards browse, newest first, 200 to a page — 177 products in October 2026): each product every few seconds, whatever the keywords. A VIP or drop watch's words are searched on their own, across the whole store |
| The Games Cube | Server first | Its search pages (CrystalCommerce, made on the server): a tile per product with each option's stock and price, up to 4 pages of 25–30. Pre-orders are the ones in its "… Pre-Orders" categories. The cards it buys from customers (its buylist) are left out |
| Gamerholic | Server first | Its **newest 100 products** (Shopify's product list, newest first, every option's stock), read as **one list for every keyword** (`sweep.allPath`, like Kmart's): each read counts every keyword's products, so each product is looked at every read, not one keyword's a read. Gamerholic lists hundreds of products a day, so a new drop shows up there the moment it's listed. At most one read every 15 seconds (every 10 in a VIP drop's window: its words are read from the same list). A read that fails is one request, backed off as any search: there's no other list to ask instead |
| BIG W | **An admin's browser** (the extension), in a private window of its own where Mugibot's allowed in Incognito — its default; the server never, as it can't draw BIG W's products | BIG W's search page, **opened** in a minimised window of the extension's own and read once the page has built its product list — or, if the page has downloaded its products but not drawn them (pages in a minimised window may not), the product data it downloaded. A page with no products to read says what BIG W's page said (1.32.0): **No results**, or **57 results** not drawn yet (see below) |
| Amazon AU | Server first: **an admin's browser** (the extension, 1.11.0 or later) stands in at the first refusal | Amazon's search page, newest first (2 pages of 48), with "tcg" added to each keyword — asked for from inside an Amazon page in the extension's window. Amazon turns Mugibot's server away (**HTTP 503**, "An error occurred"), so nothing came through from the server. At most one search every 20 seconds |
| EB Games | Server first: **an admin's browser** (the extension) stands in at the first refusal | EB Games' own search data (the JSON its search page asks for: every product's code, price, picture, stock, pre-order and release date), newest first, 2 pages — asked for from inside an EB Games page in the extension's window |
| Zing | Not searched | zingpopculture.com.au now sends every visitor to EB Games, so EB Games' sweeps cover its range. It's no longer in the live sweeps at all (switched on, an admin's browser only ever got "couldn't reach the store") |
| City Beach | Server first | Its search page (Salesforce Commerce Cloud, made on the server): a tile per product with its code, name, brand and price (48 a search). Stock isn't in the tiles: it comes from the product page, which the monitor reads. At most one search every 10 seconds (every 4 in a VIP drop's window) |
| Pokémon Center (Australia) | Server first: **an admin's browser** (the extension, 1.8.1 or later) stands in at the first refusal | Its search page (`/en-au/search/<keyword>`, 32 a page), opened in the extension's window and read once it has built its product list, like BIG W's. Its bot check (Imperva) may reload the page first: the extension waits for it. At most one search every 30 seconds |
| Premium Bandai (Australia) | Server first: **an admin's browser** (the extension, 1.8.1 or later) stands in at the first refusal | The site's own search JSON (`/api/search?keyword=…`, newest arrivals first, up to 100), asked for from inside a Premium Bandai page in the extension's window with the region its own code sends (`x-g1-area-code: au`), like EB Games'. It answers Mugibot's server too now (Oct 2026), so the server reads it. A search that finds nothing ("pokemon" there) comes back with no products list at all, only its count: that's an empty search, not a changed page. At most one search every 30 seconds |
| Pokébox | Server first | Each keyword's search (Shopify's search suggestions, 10 a search with stock), "tcg" added ("pokemon tcg": its sealed products first — Pokébox names its hundreds of singles after the card), and **every third search the store's newest 30 products** (Shopify's product list, newest published first: about a week of its listings, Oct 2026; `sweep.newestPath`): a new drop shows up there the moment it's listed, each product in it counted for the keyword in its name, in one read (until Oct 2026 it was each keyword's second page, so a keyword saw it only every 200 s or so). One the shop drafted weeks before and has just put up is still a drop (`newestFresh: false`: it doesn't republish old products as JB does); an admin's browser standing in for the server reads the list too (`newestBrowser`). At most one read every 10 seconds |
| Good Games, Collectible Madness, Cherry Collectables | Server first | The same as Pokébox (Shopify card shops) |
| Gameology | Server first | The same as Pokébox (Shopify): "tcg" added to each keyword, since it sells Warhammer, board games and figures under the same names, and thousands of singles (its sealed products come first). Its own collections are too big to read whole (its "Pokemon Trading Card" one is over 600 products), so they aren't swept |
| From The Deep Games | Server first | Each game's **whole sealed collection**, read in one go (Shopify's product list for it: every product, its stock and its option): "Pokemon TCG Sealed", "One Piece Card Game", "Riftbound", "Gundam Card Game". Where a game has more than one, the sealed one comes first (`collectionPrefer`), and its singles' collections are never read (`collectionSkip`: "Pokemon Singles (All)" alone is 30,000 products). **Every third search** is its **Preorders** collection (every game's pre-orders, where a drop is listed first — "Pokemon TCG Sealed" leaves them out), each pre-order counted for its keyword in one read. Its newest-products list isn't read: it's hundreds of Magic singles a day. At most one read every 10 seconds |
| The Gamesmen | Server first: **an admin's browser** (the extension, **1.19.1** or later) stands in at the first refusal | Its search page **newest first** ("Recently Listed": a new listing is on page 1 the moment it's up), opened in the extension's window and read once its results are drawn, 2 pages: its own tiles (its Hyvä theme, read from a copy of its real page — from 1.20: the name, the price shown with GST, a struck-through old price, "Add to Cart" or "Pre-Order", the product's id), or Magento's usual ones, or — drawn some other way — any product on the page with its link and a price. Its menu's links look like product links (its products are `/<name>`), so 1.19.1 doesn't count the site's menus as the results (1.19.0 read the page before they were drawn). Its Cloudflare turns servers away ("Sorry, you have been blocked") |
| Games World | Server first | WooCommerce's own product API (`/wp-json/wc/store/v1/products?search=…`, newest first, 30 a search): stock, price, pre-orders (backorders) and the product's id for its add-to-cart link — only the fields Mugibot reads (about 100 KB a search). At most one search every 15 seconds |

BIG W, EB Games, Pokémon Center, Premium Bandai and The Gamesmen have refused
requests from servers (403 / Cloudflare's, Imperva's or their own bot checks), so
while they do, the extension in an **admin's** browser searches them instead, every 15
seconds per store by default (the sweep settings' **…from an admin's browser**, from 2 seconds), each store at its
own pace — at most BIG W every 20 (was 10: see BIG W's product pages, above), Amazon every 20, Pokémon Center and Premium
Bandai every 30: those stores turn away pages asked for faster (Amazon's 503,
Pokémon Center's Imperva), and a browser that's turned away finds nothing at all.

**Each store on its own, side by side** (extension 1.23.0): the admin's browser
searches every store it's given at once, each in its own tab, and asks for that
store's next search the moment its last one is in. Before 1.23.0 it searched them
one after another and waited for the whole round, so a slow page (BIG W's, which
takes a few seconds to build) held up every other store: each store's real pace was
the round's, often 20–40 seconds whatever the setting said. Now a store's pace
is what's set. The browser tells the server which stores it's still searching, so
a store is never searched twice at once and no keyword loses its turn; its tabs
are opened one at a time, so the window never gets two tabs for one store.
Members' browsers never do this: only Mugibot's server and admins can change
what everyone sees.

**Why BIG W and EB Games showed nothing:** EB Games' search page has no
products in it either (its page asks for them once it's open, and Cloudflare
turns servers away); BIG W's page in a minimised window downloaded its products
but sometimes never drew them. From extension **1.7.0**:
- **EB Games**: the extension keeps an EB Games page open in its own window and
  asks for EB Games' search data from inside that page, the way the page itself
  does, so it passes Cloudflare like any visitor. If Cloudflare checks the page,
  it opens the page again (a real visit passes the check) and asks once more. It
  never tries to get past a check it doesn't pass.
- **BIG W**: if the products aren't on the page within a couple of seconds of it
  downloading them, the extension reads the product data the page downloaded
  instead (asked for again from inside the page).
- Both need an **admin's browser with extension 1.7.0** connected and open:
  until then the Live sweeps console says **Waiting for an admin's browser**.

**Why Kmart and BIG W showed 0 products:** neither has its products in the
search page itself. The page fetches them with JavaScript once it's open, and
the extension read the page as it arrived, so it found nothing there (not a
block). Now:
- **Kmart** is read where its own page gets its products: Kmart's search
  provider, Constructor.io, with the public search key in Kmart's pages,
  honestly identified as Mugibot. That answers Mugibot's server, so Kmart no
  longer needs an admin's browser. (If Kmart changes its search key, the
  searches fail with an error in the event log: update `key=` in
  `server/retailers/kmart.js`.)
- **BIG W** refuses servers, its search API too, so an admin's browser
  **opens** its search page in a minimised window of the extension's own (one
  tab, reused for every search; closing it is fine, the next search opens it
  again), waits until the products are on the page, and reads them. The
  Mugibot panel doesn't appear in that window.
- **Amazon AU** is searched from an admin's browser (since extension 1.11.0):
  Amazon answers Mugibot's server with **HTTP 503** ("An error occurred"), so
  searching it from the server found nothing. Amazon's search results don't say
  who sells each product, so marketplace sellers (often at high prices) are
  included there: put any you don't want on the **blacklist** (below).

You can change where each store is searched from (server first, server only,
admin's browser or off) in **Monitor → Settings → Stores**.

**Why the server can read Target and JB Hi-Fi now:** their CDNs refuse Node's
built-in `fetch()` (403 and 429) but answer Node's own `https` client normally,
with the same honest `Mugibot/1.0` headers. All store requests (sweeps and the
older page checks) now go through `server/monitor/http.js`, which uses that
client. Nothing is disguised: no fake browser, no stealth, no CAPTCHA solving.

## 2. How a sweep works

```
 every store has its own loop                         (server/monitor/sweep.js)
   ┌──────────────────────────────────────────────────────────────────────┐
   │ next search: page 1 of each keyword in turn, then one later page      │
   │   (Kmart: every trading card it sells, in one list, each time)        │
   │ fetch it (honest Mugibot headers)                                     │
   │ read every product: code, name, price, stock, link, picture          │──┐
   │ next one ~5 s (±20%) after this one began, or back off after a        │  │
   │   failure (×2 each time, ≤15 min)                                     │  │
   └──────────────────────────────────────────────────────────────────────┘  │
 admins' browsers (extension) do the same for BIG W and EB Games ────────────┤
                                                                              ▼
          members' SKUs (any product):   watchlist status → their own DM / webhook / email
          products that count:           catalogue (products) → price history
            · every word of the keyword in the name ("pokemon" matches "Pokémon")
            · a trading-card word in the name (card, booster, ETB, tin, …)
            · no "not cards" word (socks, T-shirt, plush, puzzle, …) unless it says TCG
            · not sold by a marketplace seller
                                         → 🆕 / 🟢 / 📉 alerts → feed, Discord, dashboards
```

- **The first sweep of each search only sets the scene.** What's there is
  already there: it's added to the catalogue without alerting. So does the
  first sweep after a search hasn't run for 6 hours, and the first sweep after
  you change the keywords or filters (otherwise every product the new setting
  lets in would look new).
- **Restocks** need a confirmed out-of-stock first. "Unknown" stock never
  alerts.
- **Target leaves sold-out products out of its results** (every product in
  its results is in stock and deliverable). So at Target, a product that's
  been missing from every page of its search for 6 minutes, while each page
  was read fine, counts as sold out, and when it comes back that's a 🟢
  restock. This only happens when the pages Mugibot reads hold all of the
  results (up to 192 per keyword), and never in the first minutes after a
  restart.
- **Trainer Town keeps each game in a collection of its own** (Pokémon
  Cards, One Piece Trading Card Game, Lorcana…). Mugibot looks up the store's
  collections (every 6 hours) and, for each keyword, reads the biggest
  collection named after it, whole: every product in it, sold-out ones too.
  So a new drop can't be hidden below the first 10 search results, and a sold
  out product is seen as sold out (not just missing). Its alerts come with
  Shopify's **Add to cart** link (the option to buy is in the list). When a
  keyword moves between its collection and the search, the first read of the
  new one only sets the scene.
- **A refused or failed search never alerts** and keeps every product's last
  stock. The store waits twice as long after each failure (up to 15 minutes),
  then tries again. When a store says how long to wait (**HTTP 429** or 503
  with a `Retry-After`, like Shopify's), Mugibot waits at least that long (at
  most 15 minutes): "The store refused the search (HTTP 429) — it asked to
  wait 60 s". **Reset** (below) starts a failing store again.
- **Marketplace sellers** are left out (with **Skip marketplace sellers** on,
  the default), store by store:
  - **JB Hi-Fi**: its search results don't say who sells a product, but each
    product's own data does (the "Seller" option: *JB Hi-Fi*, or a marketplace
    seller like *Gameology*). Mugibot asks **once per product**, never as part
    of a search, so sweeps aren't any slower: right before a product's first
    alert, and slowly in between (at most one product every 20 seconds). A
    marketplace seller's product never alerts and leaves the lists; the answer
    is remembered, so it's never asked again.
  - **Kmart**: the search provider's own seller field (sold by Kmart or Target
    only).
  - **EB Games** (and Zing) and **BIG W**: only when the store's data says so
    (a marketplace or third-party flag, or a seller that isn't the store).
    Nothing is guessed from a product's name, so no Pokémon, One Piece,
    Gundam, Dragon Ball or Riftbound product is dropped by mistake.
  - **Target** has no marketplace in its results. **Amazon AU**'s results don't
    say who sells each product: use the blacklist there.
- **Members' SKUs**: when a sweep comes across a SKU a member watches (any
  product, not only cards), it updates their watchlist straight away. A SKU
  waiting to be listed gets its product page as soon as it shows up. While a
  sweep has seen a SKU in the last 3 minutes, the slower once-a-minute page
  checks leave it alone, so two sources can't flip it back and forth.
- **Monitors**: a monitored product that a sweep sees is updated by the sweep
  too, and still gets the alerts its monitor asks for (sold out, price up…).
- **No duplicates**: the same product and kind can't alert twice within
  `MONITOR_ALERT_COOLDOWN` (10 minutes), on top of "restock once a day".

### Speed

With the defaults (2 keywords, a search every 5 seconds per store), each search
starts 5 s after the one before it *started*, so a store that's slow to answer
isn't searched any less often (at least half a second between two searches):

- Kmart: **every trading card it sells, in one request**: its Trading Cards
  range from its search provider (177 products in October 2026, newest first),
  every ~5 s, whatever the keywords. A restock of any card product there is
  seen within about 5 s (about 10 s with a VIP watch at Kmart, which takes every
  other search; in its drop window two in three, every 4 s, so the list still comes
  every ~12 s and counts the VIP words' finds too). VIP and drop watches' words still get their own searches,
  across the whole store. If that list ever stops coming back as a list, each
  keyword is searched instead for 15 minutes (the live log says so), then the
  list again. A refusal is Kmart's, as for any search: it slows down.
- Target: page 1 of each keyword every ~15 s, every page every ~1–2 minutes.
  A Target product page is read from Target's own page data first: a product
  with neither home delivery nor click & collect is out of stock (its "Add To
  Basket" greyed out), even while its JSON-LD for search engines says "InStock"
  — as a member's 30th Celebration pre-order did. (Target draws every Add To
  Basket greyed out and turns it on with its own code, so the button in the
  page itself says nothing.)
  Target's own CDN keeps a copy of a search page for a short while, so a
  change can take a minute or two to show up there. Mugibot doesn't try to
  get around their cache.
- JB Hi-Fi and Toys"R"Us: each keyword every ~10 s.
- Trainer Town: each keyword's whole collection every ~30 s (one read every 15 s).
- Amazon AU: each keyword every ~60 s (page 1), page 2 now and then.
- The Games Cube: each keyword every ~10 s (page 1), the later pages now and then.
- Gamerholic: its newest products every ~15 s, every keyword's products in each read.
- BIG W, EB Games and The Gamesmen (admin's browser): one search as often as the
  admin's-browser seconds set (from 2 s), each waiting for the last (a BIG W page
  takes ~5 s to build). BIG W only in its private window: in an ordinary window,
  one every 20 s at the quickest. Pokémon Center and Premium Bandai: one every 30 s.
- Pokébox, Good Games, Collectible Madness, Cherry Collectables, Gameology: their
  newest products every ~30 s (every keyword's in each read), each keyword's search
  every ~15 s × the number of keywords (~60 s with 4).
- From The Deep Games: its Preorders every ~30 s (every game's), each game's
  collection every ~15 s × the number of keywords.
- Games World: each keyword every ~30 s.
- The Gamesmen (admin's browser): as often as the admin's-browser seconds set.

More keywords means each one comes round a little less often. Each store has
its own loop, so a slow store never holds up the others.

**⚡ Drop mode.** Drops come in waves: a set's booster box, then its Elite
Trainer Box, its bundle… So when a search alerts a **new card listing** at a
store (in a read that isn't setting its scene, and not a VIP or drop watch's own
words), that store is searched for what comes next there more often, for 15
minutes, each further new listing making it 15 from then (30 at most, then not
again for 15):

- **JB Hi-Fi, Toys"R"Us, the Shopify card shops, From The Deep Games** (a
  newest-products list): their newest products **two searches in three** (one
  in two or three otherwise). The third keeps the keywords going round, so a
  product listed before that goes on sale is still seen.
- **Target and EB Games** (`sweep.hot`: their search is newest first): **that
  keyword's first page every other search**; the other one goes round as usual,
  later pages too (Target's sell-outs are still marked).
- Never Kmart (its whole range is every search already), BIG W (it lists drops
  ahead of time, without a buy button) or Amazon.

It never adds a request: the same searches at the same pace, in another order,
and never ahead of VIP drops or members' drop watches. The live log says when a
store goes into drop mode and when it's over, and the Stores panel shows
**⚡ Drop mode until …** beside it. **Monitor → Settings → ⚡ Drop mode** switches
it off (on by default).

**Page checks** (members' watchlists, monitors): a store that can't be asked
this second (inside `MONITOR_HOST_GAP` since its last check, or with a check of
it still going) is left out of each round, so one store's long list never keeps
another store's pages waiting. Within a store the oldest is first, and an armed
item's page (Auto-checkout) 15 seconds ahead of its turn. A store with a gap has
one check going at a time: one slow to answer holds one of the four at most.

**What goes first, the moment a search sees a drop:**

1. Every armed member's **Auto-checkout run** is made, and their browsers are
   told at once.
2. The **channel alerts** go to Discord. Every channel whose rule wants the alert
   gets it at once, ahead of any members' DMs still going out (Mugibot's line to
   Discord puts a drop's channel post first). It never waits for the rest of the
   search or for another product's alerts.
3. The watching members' own **DMs**, ten at a time. Each member's own webhook
   and email go out alongside, never holding up anyone's DM (a dead webhook
   used to take 8 seconds, an email up to 10). A member's own drop watch's find
   is DM'd here too, after the channel post, never before it.

The store's next search doesn't wait for the members' DMs: they go out while it's
on its way, so a store dropping a second product seconds after the first is
still seen at its usual pace. The same for page checks and admins' browsers.

Each store's DMs go out apart from the others', and a store whose alerts keep
coming faster than they go out (its stock flapping) has at most two lots going:
a third waits for the first.

**Mugibot's line to Discord**: twelve requests at once, two of them kept for
what can't wait (a drop's channel posts; a member's "🏦 Approve the payment in
your bank's app", "🛒 Checkout ready" and "🛡️ Solve the check now" DMs, which go
ahead of a drop's other DMs), and never more than 45 a second in all (48 for
what can't wait): Discord's own limit is 50 a second per bot, and over it every
request is turned away for a while. If Discord says the whole bot must slow
down, every request waits as long as it says. First-time DMs open their DM
channel two at a time; members' own webhooks go eight at a time.

The dashboards' live feed has it before Discord does. **Alert speed** on the
live monitor shows the latest alerts' time from the store's answer to your
screen, and to Discord. Discord's limits are kept: a channel that has had its
5 messages in 5 seconds waits for its reset (Discord says when), and a "slow
down" on one request holds nothing else up.

Kmart's figures give its stock state by state. When only some states have a
product, its alert says which: "In stock in NSW, VIC only." When most of them
have it, it names the ones that don't: "In stock everywhere except NT."

**🏬 In store only.** Kmart sells some products only in its shops: not for
delivery, not for ordering online, pre-orders included (its search data says
so: "FulfilmentChannel" 2; 3 is delivery and click & collect). They get a
status of their own, **In store only**. Back in stock in the shops, the
channel alert says "🏬 In store only", that it can't be ordered online, and
which states have it — with no ⚡ Buy or cart link, and nobody's
Auto-checkout starts. When it can be ordered online again, that's a restock
like any other (⚡ Buy, Auto-checkout), even on a day it already alerted in
stores.

## 3. Setting it up

1. Deploy as usual: merging into `main` deploys it, and the database upgrades
   itself. Sweeps start on their own, with the keywords `pokemon` and
   `one piece`.
2. **Admins' browsers** (for BIG W and EB Games): install the
   extension (version 1.7.0 or later: EB Games and BIG W need it), connect it to an **admin** account, and
   keep Chrome open. If a store refuses that browser too, open the store's
   website in it once, then wait for the next search. The extension's popup
   shows **Live sweeps from this browser** with each store's last result.
3. Discord: alerts go to the channels in **Monitor → Discord alert channels**.
   New drops are the 🆕 kind, restocks 🟢, price drops 📉; tick the kinds each
   channel should get. With no rules, restocks and new drops go to
   `DISCORD_RESTOCK_CHANNEL_ID`.
4. **Monitor → Settings** (admins):
   - **Stores**: where each store is searched from (**Server first**, the
     default; **Server only**; **Admin's browser**; **Off** — changes straight
     away), how it's doing ("Admin's browser standing in · server tries again
     3:40 pm" while the server's refused), and **↻ Reset** for each store (or
     **Reset all**).
   - **Keywords**: what to search for at every store (type + **Add**, × to remove).
   - **Seconds between searches at one store**: 5 to start with (3 at least).
   - **…from an admin's browser**: 15 to start with.
   - **Price drop alert from**: 10% to start with; 0 turns price drop alerts off.
   - **Alerts**: new drops, restocks, and "at most one restock alert a day per product".
   - **Which products count**: skip marketplace sellers, trading cards only, the trading-card words, and the "not trading cards" words.

### The blacklist

**Admin → Blacklist** (or **🚫 Blacklist** on a product's page on the Monitor
tab) keeps products from ever pinging:

- **A store and a SKU** (or a product link): that product.
- **Only a store**: everything at that store.
- **Only a SKU**: that SKU at every store.

What's on it never alerts (dashboard or Discord), isn't tracked by the live
sweeps, stays off the Monitor lists and its alert history, and any monitor on
it is removed (and can't be added again until it's taken off). Members' own
watchlists aren't affected. Take an entry off with **Remove**. The first
entry came with the update: Kmart's *Wave Book Storage - Oak* (SKU 43746880),
which kept pinging the restock channel.

### ⭐ VIP drops

**Monitor → Settings → ⭐ VIP drops** (admins) is for drops you pick out:
a limited release you know is coming, at any store, cards or not. They're
posted in **`#vip-drop`** the moment they drop, and not in the store channels.

1. **Make the #vip-drop channel** (once). The bot makes a **VIP** category with
   `#vip-drop` in it, or uses a `#vip-drop` that's already there, with a rule
   that takes VIP drops only. It can ping a role (e.g. @VIP). Until there's one,
   VIP drops go to the store channels like any other alert.
2. **Add a VIP watch**, either:
   - **A store and the words in its name**: City Beach, *pokemon skate*.
     - Those words are searched at that store, every other search (one in three
       once its drop window is over).
     - Anything with **every** word in its name counts (`skate` also matches
       "Skateboard"; accents don't matter). "Trading cards only" doesn't apply.
     - A product that's new since the watch's first search is a 🆕 new drop.
     - The store's own keyword searches count a match too.
   - **A product page**: any shop's link (a "misc" site too). A monitor reads it.
3. **Drops at** (optional, your time). From 15 minutes before to 3 hours after:
   - The store is searched for those words **two searches in three**, every
     **4 seconds** (every 10 at Gamerholic and Games World, whose search is one
     heavy list or page). The third is the store's own (its newest products, its
     keywords, members' drop watches), so nothing else there goes unsearched for
     3 hours, and its newest products and whole list count the watch's finds too.
   - What the watch found has its page read every **5 seconds**.
   - Otherwise its pages are read every 15 seconds.
4. **🤖 Auto-checkout it for me, up to $…** (optional). What **drops** goes on
   your watchlist, armed for Auto-checkout up to that max price, and your browser
   checks out the moment its page says it's in stock. What drops:
   - a new listing: anything found after the watch's first search;
   - something already listed whose page says it isn't on sale yet (coming
     soon, sold out).

   What was **already on sale** when you added the watch is never armed, whichever
   search finds it first (the watch's own, or the store's keywords or newest
   products: listed before, its page is read first). A broad
   watch like *pokemon* would otherwise buy everything that matches. The
   Activity log says so, and you can ⚡ Buy it yourself.

   Your Auto-checkout settings and limits still apply (switch it on, keep Chrome
   open with the extension). Each product is armed once: after a purchase it stays
   disarmed. Removing the watch disarms what it armed.

What a keyword watch finds gets a monitor of its own, so its page is read
straight away for its stock.
- 🆕 when it's found.
- 🟢 when it goes from not on sale to on sale. The first time its stock is read
  isn't an alert: that's how it was, not a change.

Removing a watch removes the monitors it made. The list shows what each watch
found, with its stock and whether it's armed.

**Add the watch before the drop.** Its first search is the "before" picture
(nothing alerts then); what shows up after that is the drop. A keyword watch
relies on the store's search showing the product. Some stores add new
products to their search a few minutes late. If you have the product's link
before the drop, add that as well: its page is read directly.

Settings (environment variables): `VIP_FAST_SECONDS` (5), `VIP_SLOW_SECONDS`
(15), `VIP_SWEEP_SECONDS` (4).

### 🛍️ Shop checkout links

A member's **checkout link** at a store that checks out with Shop
(`…/cart/<variant>:<qty>,…`, on **My watchlist → 🛍️ Shop checkout links**) is watched
by the server every 5 seconds, option by option: the store's own
`/variants/<id>.js` for each, read honestly as Mugibot, in stock once every one is,
its price the link's (each option's price times its quantity). The link itself is
never opened by the server, and never by members' browsers' checks (it would start
a checkout). The alert is the member's own DM with ⚡ Buy; armed, Auto-checkout buys
it on Shop's checkout ([AUTO-CHECKOUT.md](AUTO-CHECKOUT.md#️-shop-checkout-links)).

### 🎯 Drop watches: anything that isn't the card keywords

**Drops → 🎯 Drop watches** (a tab of the lists, for everyone with a
membership) watches anything outside the card keywords: a console, a
collectible, a product at any shop — Garmin's, a sneaker store's. You're told
when it **drops** (a new listing, or its page going up), comes **back in
stock**, opens for **pre-order**, or its **price drops**. One box takes either
(a link pasted without `https://` is a link too):

- **A product's link.** At a store Mugibot knows (JB Hi-Fi, Kmart, any of
  them) its page is checked like any monitored product, and ⚡ Buy and
  Auto-checkout work there exactly as they do for cards. At **another
  website** its page is read for its stock and price every minute (Shopify's
  product data where the site is a Shopify shop, else the page itself): you're
  told when its page goes up, when it's back in stock or open for pre-order, and
  when it gets cheaper — and buy it there yourself. There's no ⚡ Buy and no
  Auto-checkout at other websites. The whole link you gave is what's read; its
  SKU (the website and the link's last part, e.g. `microsoft.com/8wg5vqp0x4h3`)
  is only Mugibot's own code for it. Until its page answers, it's called by the
  words in its link ("Xbox Series X25 Limited Edition"), then by its page's
  own name. A site that turns Mugibot's server away (Microsoft's, David
  Jones', say) is checked from a browser instead, once its extension may read
  that site (see **Refused by the server** below). Until then it shows
  **Blocked by site** or **Check failed**, and is asked again later.
  Its page is read every minute. Its stock comes from the page's own data
  where there's any: structured data for search engines, or the store's own
  page data. The **Riot Games Store** (merch.riotgames.com, October 2026)
  streams its whole page hidden and draws its buy button with its own code, so
  its HTML says nothing either way, and its Riftbound drops showed
  **Checking…** for ever. Now its page data is read: a product with
  **Notify Me** and a "Coming Soon" label is **Coming soon**. The moment it's
  on sale ("Add to Cart") it's **In stock**, or a **Pre-order** when it's one,
  and that's the drop alert. With no "Coming Soon" label it's **Sold out**.
- **🔑 Key phrases: the words in its name**, and where to look. Paste
  several at once, one a line ("Heavy Hitters Premium", "Ascended Heroes ETB"),
  and each becomes a watch of its own. A phrase you have already, or one too
  short, is said beside it and the rest are added. Where to look:
  - **Every store Mugibot searches** (the default): the phrase is searched at
    each store in its turn, at the same pace as one store's below. It's also
    matched against **every product any of the store's searches read**, the
    card keywords' included. A new listing with the phrase in its name is a drop
    whichever search sees it first, once the card search has had its own first
    read there, so you're told within seconds. Each store's first look is that
    store's own "before". Auto-checkout works at whichever of them Mugibot checks
    out at. Each watch keeps twice as many finds as a one-store watch.
  - **A store Mugibot searches** (JB Hi-Fi, Kmart, Target, EB Games…): the
    words are searched at that store as typed (no "tcg" added), in the live
    sweeps' turn — **one search in three at most**, each watch's words about
    every **30 seconds** — so the card keywords keep most of each store's
    searches and nothing at the store is asked more often than before. A new
    watch's first search goes first.
  - **Another website** (its address, or a page of it): read from the server
    every **2 minutes**, as `Mugibot/1.0`, one website at a time. Mugibot tries
    the site's Shopify search suggestions, then its search page
    (`/search?q=…`), then the page itself; it remembers what worked. Give a
    listing page (a "new arrivals" or a search page) and only that page is
    read. A site that turns Mugibot away is asked again later, waiting longer
    each time, and is read from a browser meanwhile (below).

  Anything whose name has **every** word counts, trading cards or not. A short
  word (three letters or fewer) or a number has to be a whole word in the name —
  "xbox series x" isn't the Series S, "playstation 5 pro" isn't a PlayStation 5
  "Promo Bundle", "switch 2" isn't a 2024 edition (a plural's fine: "box" →
  "Boxes"); a longer one counts at the start of a word ("skate" → "Skateboard").
  At **Kmart**, whose card searches are kept to its Trading Cards, a watch's
  words (and a VIP watch's) are searched across the whole store.
  Mugibot's first look is the "before" picture: what's there already isn't a
  drop. What shows up after it is.

**Refused by the server: read from a browser instead** (extension 1.26.0). A
drop watch's page or website that turns Mugibot's server away (HTTP 403, 429 or
503, a bot check, or failing) is checked from a browser with the extension, as
a visitor would, about once a minute (a website's search every couple of
minutes). Mugibot never tries to get past a bot check: a browser turned away too
just backs off.
- **Whose browser:** an admin's for an admin's watch for everyone (only the
  server and admins change what everyone sees), and your own for your own watch.
  An admin's browser never reads a member's own watch.
- **At a store Mugibot knows** (BIG W, say): straight away,
  even while the rest of the store answers the server. Before, admins' browsers
  only stood in when the server was refused at the store as a whole.
- **At another website:** once the extension may read it. Its toolbar menu then
  shows **Websites refusing Mugibot's server** with the website's address:
  press **Allow checks from this browser** and Chrome asks you for that website
  only. Until then the drop watch says to (**allow … in the Mugibot extension**).
  You can take it back in the extension's details in Chrome.
- The drop watch says so: **🧭 checked from an admin's browser** on a find (admins),
  **read from an admin's browser** (or **your browser**) on a words watch. The
  server keeps asking too, less often, and takes over again once it's answered.

**An admin's drop watch is for everyone** (the 📣 box, on unless you untick it):
- What it finds is a monitored product in everyone's **Tracked products**, in
  category **Non-TCG**, posted in **`#non-tcg-alerts`** (🆕 a new listing, 🟢 in
  stock again, 🟣 pre-orders open, 📉 a price drop) with ⚡ Buy where Mugibot
  checks out, and in every dashboard's live feed. (`#non-tcg-alerts` posts price
  drops from this release: its rule got 📉 Price drops once, when the update
  started — take them off in its rule if you'd rather not.)
- Members ☆ Watch it from the drop watch (or Tracked products) for their own DM,
  and arm 🤖 Auto-checkout on it from their watchlist, as with any product.
- **`#non-tcg-alerts`**: **Set up store channels** makes it (or press **Make
  #non-tcg-alerts** on the drop watches tab). What isn't trading cards goes there,
  not to the store's own channels. Until there's one, it goes to `#misc-retailers`.
- Pick another category (Pokémon, One Piece) to send a watch's finds to the store
  channels instead.
- **Where it posts, and who it pings** (admins only): **Post its drops and
  restocks in** lists the Discord server's text channels (by category) — leave it
  on **The usual** for `#non-tcg-alerts` — and **Ping** its roles (or no one).
  Its 🆕 new listings, 🟢 restocks and 📉 price drops then go **only** to that
  channel, with that role pinged, instead of `#non-tcg-alerts`. A monitor an admin had already made on
  something the watch finds is taken on (its drops and restocks go there too),
  and is left as it was when the watch is removed. Change it any time with
  **✎** on the watch. A VIP drop still goes to `#vip-drop`. Members never see
  where a watch posts; their own watches are only ever a DM.

**Anyone's own drop watch is theirs alone** (members' always are):
- What it finds goes on **their watchlist** (marked 🎯): up to 10 of what was
  listed already at its first look, and up to 10 that drop after it — each its
  own room, so a broad watch whose first look found plenty still hears of what
  drops (taking a find off your watchlist makes room; when it's found its most,
  it says so in your activity, once a day). Only they're told: their DM,
  webhook or email, as they've set it.
- What was there at its first look goes on quietly; anything new is a DM the
  moment it's found, anything coming back in stock (or open for pre-order) is a
  DM as usual, and a find that gets **cheaper** is a 📉 DM: "Was $649.00 — now
  $549.00 (15% lower)", with ⚡ Buy where Mugibot checks out, else Open product.
  A price drop is at least 1% (and a dollar) below the read before; it's said
  again only when it goes lower still, or half a day later. (Its first read
  after it's found only notes the price: a listing's price and its page's can
  differ.)
- Nobody else sees it, nor its words in the live searches.
- Removing it removes what it put on the watchlist.

**🤖 Auto-checkout** (stores Mugibot checks out at), up to a max price (Auto-checkout
switched on, Chrome open with the extension, your limits apply):
- **A link** is armed like a watchlist item: bought as soon as it's on sale —
  now, if it already is.
- **Words** arm only what **drops** after the first look: a new listing (bought
  the moment it's found, if it's on sale), or something listed but not on sale yet
  (bought when it goes on sale). What was already on sale is never bought — a
  broad watch would otherwise buy everything that matches. (The same rule as VIP
  drops.)
- **One purchase per watch:** once one of its finds is bought, its other finds
  are disarmed and what it finds from then on isn't armed (docs/AUTO-CHECKOUT.md →
  One purchase per arming).

Each watch shows what it found, with its stock, price, ⚡ Buy (where there's
one) and whether it's armed; **↻** looks again now. Members can have 10 drop
watches, admins 30 (`MAX_DROP_WATCHES`).

Settings (environment variables): `DROP_SWEEP_SECONDS` (30), `DROP_SITE_SECONDS`
(120), `MAX_DROP_WATCHES` (10).

### 📃 Search pages: a store's page read every few seconds for your key phrases

Paste a store's **search, category or collection page** into the drop watches box
(EB Games' `…/search?category=trading-cards&condition=preorder`, a Shopify
collection, Kmart's search, any website's "new arrivals"). Mugibot tells it apart
from a product's own link (**📃 A search or category page** is picked for you;
switch it if it's wrong), and asks for:

- **Key phrases to look for on the page**, one a line ("Magic the Gathering",
  "One Piece OP-15"). A product counts when its name has every word of **one** of
  them (the same matching as key phrases above), whatever the card keywords are.
- **Read the page every … seconds**: **3 at the fastest**. At a store whose
  searches go slower, its own pace is the fastest: Pokémon Center and
  Premium Bandai 30 s, BIG W 20 s while it's read in an ordinary window (3 s in its
  private window), Amazon 20 s, Gamesworld, Gamerholic and Trainer Town 15 s,
  City Beach 10 s. Every store's pages together are read about once a second at
  most, so a store with many pages watched never sees a burst.
- **🤖 Auto-checkout** (stores Mugibot checks out at), up to a max price, and for
  admins, **📣 for everyone** with the **Discord channel to post in and the role to
  ping** (as for any drop watch). A member's own page watch tells them alone, by
  DM, and puts what it finds on their watchlist.

**What's a drop.** The watch's first look at the page is how things were: what's
on it then goes on the watchlist quietly (and is armed only if it isn't on sale
yet). After that, a product with a phrase is a **drop** (🆕 posted or DM'd, and
bought at once when armed) when it wasn't on the page before **and** Mugibot
didn't know it at that store, or knew it as not on sale and it's on sale now.
A product coming back onto the page isn't a drop. Its restock is, the usual way.
The first read after the page is read another way (the server, then an admin's
browser) or after 6 hours without an answer sets the scene again: nothing in it
is a drop. So does the first read after Mugibot restarts. (A product pushed onto
the page from a later page of results can look new; at stores that sort newest
first that's rare.) **One purchase per watch** (as every drop watch):
once it's bought one, it's disarmed. **✎** on the watch arms it again, changes its max
price, its key phrases and how often it's read.

**How each store's page is read** (`server/monitor/pages.js`):

| Store | Read from | What's read |
|---|---|---|
| EB Games, Zing | an admin's browser | The page opened in a tab of its own. The data it fetches (`/search/query`, with the page's own filters) is learned from it, then asked for from inside the page each time, never the browser's cached copy. |
| Premium Bandai | an admin's browser | The same: its `/api/search`, with the region its code sends. |
| BIG W, Pokémon Center, The Gamesmen | an admin's browser | The page opened and read once its products are drawn (BIG W's in its private window). |
| Amazon | an admin's browser | Its own HTML, asked for from inside an Amazon page. |
| Kmart | Mugibot's server | A search (`?searchTerm=`) through its search provider, the way its drop watches search it. Other Kmart pages are drawn in an admin's browser. |
| Target, City Beach, The Games Cube | Mugibot's server | The page itself, with each store's own reader. |
| JB Hi-Fi and the Shopify stores | Mugibot's server | A collection is its `products.json` (every product in it, with stock). A search uses its suggestions. Where those come back empty (JB Hi-Fi's collections), an admin's browser draws the page instead. |
| Gamesworld (WooCommerce) | Mugibot's server | A search (`?s=`) through its product API. A category page is read as it is. |
| Another website | Mugibot's server | The page as `Mugibot/1.0`. A website that refuses the server is read from a browser instead (an admin's for a watch for everyone, yours for your own), as other drop watches are. Alerts only. |

- **From an admin's browser** (extension **1.34.0**): pages are read in the
  sweep window, one tab for each store's pages, beside that store's searches.
  They're read one at a time there and never while the store's queue is up
  (unless that browser's through it). Nothing is read while the store is turning
  that browser away ("Access Denied": half an hour). An older extension isn't
  given any, and the watch says it's waiting for an admin's browser on 1.34.0.
  With no admin's browser open, a page only a browser can read waits, and says so.
- **Refused** (HTTP 401/403/429/503, a bot check): the read backs off from half a
  minute, doubling to 10 minutes. It waits as long as the store's `Retry-After`
  says. Where an admin's browser can read the page, it reads it meanwhile.
  Mugibot never tries to get past a bot check.
- **Only pages that list products.** A link that does something (a cart, a
  checkout, an account page, signing in or out, an add-to-cart link) is refused:
  an admin's browser opens a store's pages signed in as them. A store's own
  product page is a product link watch instead.
- **Add a monitor** (admins, top of the Drops page) is for one product. A search
  page pasted there says so, with **Watch this page for key phrases →**, which
  opens it in the drop watches form with the link filled in.
- Each page watch's card says how it's going: when it was last read, how often
  it's really read, how many products were on the page, and (admins) whether an
  admin's browser read it. **↻** reads it now.

### 🚦 Checkpoints and virtual queues

Before a big drop some stores put up a gate. Mugibot watches for each one going
up and coming down, and tells everyone so they can get ready:

| Store | Its gate | How Mugibot sees it |
|---|---|---|
| **JB Hi-Fi** | Shopify's **checkpoint**: an hCaptcha page at `https://www.jbhifi.com.au/checkpoint` that checkout goes through | The **server** looks at `/checkpoint` **every 5 seconds**, as `Mugibot/1.0` (JB answers servers; it's swept from there too; while it's off, the answer is a tiny "not found"). Up: the page with its hCaptcha. Down: gone (404), sent on to the store, or no check there. A change is looked at again **2 seconds** later and counts once it's seen twice, so it's posted within about 7 seconds of JB switching it on. A look JB doesn't answer within 8 seconds (its error page under a drop's load) counts for nothing, and the next one is seconds away. (It was once a minute, confirmed 10 seconds later: in October 2026 other groups had JB's checkpoint 4 minutes before Mugibot.) |
| **EB Games** | A **virtual queue**: "You're in the queue!", an estimated wait, a page that refreshes itself | **Browsers**. Any member's browser that lands in the queue says so (two members, or one admin, make it up). An **admin's browser** asks for the front page as a **new visitor**, with no cookies, every 3 minutes (every minute while it's up). Down: that new visitor gets the store, twice in a row, at least 45 seconds apart. |
| **Pokémon Center** | A **virtual queue** at `https://www.pokemoncenter.com/?queue` | The same as EB Games. |

Toys"R"Us, Trainer Town and Gamerholic are Shopify stores too. Their checkpoint
is recognised on any page a member opens, but only JB Hi-Fi's is checked by the
server. Zing's pages are read for EB's queue the same way.

**Why "as a new visitor":** a queue keeps your place in a cookie. Mugibot's own
looks never send cookies, so they can't touch anyone's place in line. A browser
that **got through** the queue sees the store as normal. That only means it was
let in, not that the queue came down, so it never counts as "down".

**A queue's page is told apart from the store's own**: it has a handful of
links at most, and no Add button, bag or checkout. A store page with a banner
about its queue (its menus, its products) is still the store.

**Not seen for 30 minutes** while something was looking for it (or for 3 hours
at all), a gate counts as down. A store nothing checks by itself, like Toys"R"Us,
is down 30 minutes after anyone last saw its checkpoint.

**What happens when one goes up or comes down:**

- **`#virtual-queue-detection`** in your Discord server gets a post styled like
  the monitors members know:
  - the store's address on top, then **Checkpoint Monitor** or **Queue Monitor**;
  - one line, e.g. `🟢 hcaptcha Checkpoint up for JB Hi-Fi | https://www.jbhifi.com.au/checkpoint`,
    then `🔴 Checkpoint disabled for JB Hi-Fi | …` when it's off again;
  - for a queue, `🟢 Virtual queue up for EB Games | https://www.ebgames.com.au/`
    with the estimated wait, then `🔴 Virtual queue down for EB Games | …`;
  - a white embed with the footer `Shopify | Mugibot Monitors [09:55:00 AEDT]`
    (Sydney time).
  - A queue's post has **📥 Join the queue on my computer**: the member's checkout
    browser gets in line by itself (docs/AUTO-CHECKOUT.md).
- **Set up store channels** (Monitor → Settings → Discord alert channels) makes
  the channel with the others, pinging the same role. If it isn't set up, the
  bot finds a channel called `virtual-queue-detection`, or makes one, the first
  time it has something to post.
- **Members watching something at that store** get a DM and an activity entry
  when it goes up, and again when it comes down. It goes by their restock DM
  setting.
- **All at once.** The post is first in line for Discord, ahead of anything else
  Mugibot is sending. The DMs go out 10 at a time, side by side, never one after
  another, and a pool's leaders (with members who check out with them) are first.
  Nobody's email holds up anyone's DM: it's sent alongside, and the next DM
  doesn't wait for it. (Before, they went one member at a time, each waiting
  for that member's email: a long list took minutes.) Members' own restock and
  listing DMs don't wait on their emails either.
- **Every dashboard** shows a banner while it's up: what to do, and a link to
  the store. The live monitor's event log says it too.

**While a store's queue is up**, nothing of Mugibot's asks that store for
anything from a browser that isn't through the queue: no in-browser checks, no
searches from admins' browsers, no sign-in checks. A request there could cost
someone their place in line. The live monitor shows the store as **In queue**.

- An admin's sweep tab showing the queue is never navigated or reloaded. It
  waits there like anyone in line, and its searches start again once it's
  through, or the queue's down.
- The server's own checks still run. The server is always a new visitor and
  holds nobody's place. They see the queue where the product should be, never
  read it as the product's stock, and count it as a sighting.

Settings (environment variables, for testing): `GATE_PROBE_SECONDS` (the store's
own: 60), `GATE_CONFIRM_SECONDS` (10), `GATE_CHECK_SECONDS` (180, or 60 while
up), `GATE_DOWN_GAP_SECONDS` (45).

## 4. Running it day to day: the live monitor

Dashboard → **Monitor** is the one page for everything the monitor does: the
live sweeps, the stores, the feed, the products it tracks, your own watchlist
and your activity. It has three pages. Members see **Live**; admins also get
**Settings** and the **Check log** (the switch under the title). Everything on
them is real: it comes from the sweeps as they happen. (Old `#watch` and
`#activity` links open the Monitor page at that list.)

**Live**

| Part | What it shows |
|---|---|
| **Title** | What's being searched for, where (e.g. "Searching 9 stores every few seconds for **pokemon** and **one piece**"). On the right: **🔔 Arm alerts**, **⚙** (this browser's alerts), and for admins **⟳ Sweep now** and **+ Add monitor**. |
| **Needs attention** | Only when a store keeps failing: which ones, and (admins) **↻ Reset all**. |
| **Live sonar** | A sweeping radar with a blip per store; a blip rings each time that store answers a search (red when a search fails). |
| **Stores** | One line per store: its colour, name and state (searching / slowed / retrying / off; admins also see waiting for an admin's browser), and underneath what it's doing ("Answered in 412 ms · next in 3 s") or what's wrong ("The store refused the search (HTTP 429)"). Click a store for the details: searches, last answer, next search, how long the store asked to wait (admins: where it's searched from). Each line has an **on/off switch** (below); a store switched off (for everyone, or **Off for you**) moves to the bottom of the list, so the stores being searched come first. Admins: **↻** on each line resets that store (and clears its cached files in this browser: ↻ Reset, below). |
| **The four numbers** | Drops today (new drops and restocks in 24 h), available now, alert speed (from a store's answer to your screen, and to Discord), searches per hour (and failures). |
| **Live feed** | New drops and restocks as they're found, with the picture, price (and old price), **⚡ Buy** and a link to the store. **Show** switches to everything (each search, fault, setting change and product that drops out of the results), new drops, restocks, price changes, searches or problems. |
| **Tracked products · My watchlist · My activity** | One card with three tabs (the dashboard remembers the last one you opened; members without a membership see My watchlist and My activity). **Tracked products**: every product the sweeps track, 25 to a page: picture, name, store, price (and old price), stock, **⚡ Buy**, and **☆** to add it to your watchlist (**★** when it's on it, **★ 🤖** when it's armed for Auto-checkout). 🆕 marks products found in the last 24 hours. Click a name for its price history. **My watchlist**: your own SKUs, 10 to a page, with **+ Add SKU**, the alerts for each and the 🤖 arming — and a bar above it to **search** (name, SKU, store), **filter** by store and by status (in stock or pre-order, sold out, coming soon, a problem, 🤖 armed, paused) and **sort** (your order, in stock first, recently changed, name, price either way, store). The 🤖 Armed tab and 🎯 Drop watches have the same bar (Armed: by store and ready or not; drop watches: links or key phrases, where, and what they've found). Each list remembers its search in this browser until you press **Clear**; ↑ ↓ (your own order) show only while the watchlist is in your order, unsearched. **My activity**: your restocks, alerts and sign-ins, 20 to a page. All three page with buttons underneath (no endless scrolling); new activity appears at the top of page 1 as it happens. |

**Switching a store off.** The switch on each store's line does different things
for members and admins:

- **Members** switch a store off **for themselves**: its drops, restocks and
  searches leave their live feed, its products leave their Tracked products
  (unless they pick that store in the store filter) and their dashboard stops
  popping up its alerts, with no sound or desktop notification. The line stays, dimmed, as **Off for you**; switch it
  back on any time. It's saved with their account (`PUT /api/monitor/prefs`),
  so it follows them to any browser. The monitor keeps searching that store for
  everyone else, the Discord channels keep posting it, and the member's own
  watchlist items at that store still ping them as before.
- **Admins** switch a store's searches **off for everyone** (it asks first). The
  store shows as **Switched off: not searched**, and switching it back on returns
  it to where it was searched from before, or server first (Settings → Stores
  has the same choice). Members don't see a store that's off.

**What members never see.** Where a store is searched from (Mugibot's server or
an admin's browser), the address read and whose browser is searching are for
admins only. Members get the same live view with that left out, in
`/api/monitor/live`, on the live stream and in the product details; a problem
that would say where a search comes from reads "Not searched at the moment —
Mugibot tries again shortly" instead, and notes about admins' browsers aren't
sent to them (`server/monitor/public.js`).

**⚙** holds this browser's **Sound**, **Desktop notifications** and **Pop-up
for drops and restocks**, and **⚡ Send a test alert** (runs the whole chain in
your browser only, to check the sound and pop-up).

**Settings** (admins): the **Stores** table (where each is searched from, its
status, last search, products, searches in the last hour, **↻ Reset**, and
**Every search** underneath), **Keywords**, **Alerts, speed and what counts**,
**Discord alert channels** (with **Set up store channels**, see
`docs/DISCORD.md`), and **Response times** (each store over the last 5
minutes; hover or use the arrow keys, or **Show as a table**).

**Check log** (admins): page checks per store in the last hour, and every page
check of a monitored product (**Problems only** to start with).

**Alerts:** a new drop or restock pops up on whatever dashboard tab you're on,
with the picture, price, SKU, how fast it was alerted, **⚡ Buy**, **Open
product** and **Dismiss** (it closes by itself after 10 seconds; more than one
queue up). Press **🔔 Arm alerts** once per visit so the browser lets the
monitor play a sound and show desktop notifications; the tab title also
flashes while you're on another tab.

**⚡ Buy** is one click: a new tab opens straight at the store (no page in
between), with the product added to your watchlist and your checkout started by
the extension. So is **⚡ Buy with Mugibot** in the Discord channels' alerts.

### ↻ Reset: when a store keeps failing

A store that keeps refusing (Trainer Town's **HTTP 429**, Amazon's **HTTP 503**)
backs off further after each failure, up to 15 minutes between tries. **Reset**
(a store's **↻** on the Live page, **↻ Reset** in Settings → Stores, or
**Reset all**) starts it again:

- its failures, error and backoff are cleared, and it's searched **now**;
- for the next **10 minutes** it's searched gently, at a third of the pace, so
  a store that was overwhelmed isn't hit straight back at full speed;
- a store searched from the server gets fresh connections; a store searched
  from an admin's browser gets a fresh tab, opened at the store's front page
  first (like a visitor arriving), then the search — and the store's **cached
  files** in that browser are cleared first (its pages, scripts, images and
  service workers, as clearing the site's cache in Chrome's settings does).
  Pressing ↻ in your own browser (with the extension) clears them there too, at
  once, and the toast says so. **Cookies and sign-ins are never cleared**;
- a server-first store an admin's browser was standing in for is searched from
  the server again (the browser stands in again only if it's still refused);
- a wait the store asked for (`Retry-After`) is still respected.

It's written to the event log ("boss reset Trainer Town: searching it again
now, gently for 10 minutes") and the audit log. If a store the server
searches is still refused after a reset (set to **Server only**), its details
offer **Server first: an admin's browser stands in**. Reset never gets around a
bot check: it only stops Mugibot waiting and starts politely again.

**Discord**: `/monitor list`, `/monitor status`, `/restocks` as before.

## 5. Settings (environment variables, all optional)

The sweep settings are in the dashboard. These are for the whole monitor:

| Setting | Default | What it does |
|---|---|---|
| `MONITOR_ENABLED` | 1 | `0` switches the sweeps and page checks off |
| `MONITOR_ALERT_COOLDOWN` | 600 | Seconds before the same product can alert the same kind again |
| `MONITOR_URL_INTERVAL` | 60 | Seconds between page checks of one product page (monitors and members' SKUs the sweeps don't cover) |
| `MONITOR_MIN_INTERVAL` | 20 | The shortest interval a monitor may ask for |
| `MONITOR_HOST_GAP` | 5 | Seconds between page checks at the same store |
| `MONITOR_PRICE_CHANGE_PERCENT` | 1 | The smallest price change a **monitor's** price alerts count (sweeps use the dashboard's price drop %) |
| `MONITOR_LOG_DAYS` | 7 | How long the page-check log is kept |
| `GATE_PROBE_SECONDS` | 0 (the store's own: 60) | How often the server looks at JB Hi-Fi's checkpoint |
| `GATE_CONFIRM_SECONDS` | 10 | How soon it looks again to be sure of a change |
| `GATE_CHECK_SECONDS` | 0 (180; 60 while up) | How often an admin's browser looks at EB Games' and Pokémon Center's queues as a new visitor |
| `GATE_DOWN_GAP_SECONDS` | 45 | A queue's down when a new visitor gets the store twice, at least this far apart |
| `DROP_SWEEP_SECONDS` | 30 | A drop watch's words searched at a store at most this often (in the sweeps' turn, one search in three at most) |
| `DROP_SITE_SECONDS` | 120 | How often another website is read for a drop watch's words |
| `MAX_DROP_WATCHES` | 10 | Drop watches each member can have (admins: three times as many) |

## 6. Troubleshooting

| You see | Do this |
|---|---|
| **The store refused the search (HTTP 429)** — "it asked to wait 60 s" | The store is asking Mugibot to slow down. It waits what the store asked, then tries again. Trainer Town now reads its collections at most every 15 s, which should stop it; if it keeps happening, press **↻ Reset** on the store (it restarts gently, at a third of the pace for 10 minutes). |
| **HTTP 503** at a store, again and again (Amazon AU does this to the server) | Server first hands the store to an admin's browser by itself and has the server try again every few minutes: keep an admin's browser with the extension open. A store set to **Server only**: **↻ Reset** it; if it's still refused, set it back to **Server first** (its details offer it). Don't make the searches more frequent: that makes it worse. |
| A store's status says **refused** (server), or **Admin's browser standing in** | The store is refusing Mugibot's server; an admin's browser searches it meanwhile, and the server takes back over as soon as it's let in. Nothing to do but keep an admin's browser open. **↻ Reset** has the server try again now. |
| **Waiting for an admin's browser** (BIG W, EB Games: nothing coming through) | No admin's browser is sweeping. Open Chrome with the extension (1.7.0 or later — Setup page → Download, or the Chrome Web Store copy) connected to an **admin** account, and leave it open. The popup should show **Live sweeps from this browser** within 30 seconds, and a small minimised window appears with a BIG W and an EB Games tab: leave it be. |
| **refused the admin's browser** | Open that store's website in the admin's browser once (so it gets the store's cookies), then wait. It tries again on its own, waiting longer each time. |
| **Needs Mugibot's extension 1.8.1 or newer** (Pokémon Center, Premium Bandai) | The admin's browser has an older copy of the extension: Chrome doesn't let it open stores added after it was made, and 1.8.0 couldn't read either store. Update it (Setup page → Download, or wait for the Chrome Web Store copy to update itself). The store is searched again within 30 seconds of the updated browser asking. |
| **This browser couldn't open the store's page (…)** | The reason in brackets is Chrome's. "Cannot access contents of the page": the extension is too old for that store (update it). Anything else: the store's page didn't load in the sweep window; it tries again on its own. |
| **The page didn't have the product list Mugibot reads** (it was “…”, … KB, … product links) | The store changed its search page, or sent something else: the brackets say what the page was (its title, size and — from an admin's browser, 1.19.1 or later — how many product links it had). Send that line and a copy of the page (open the search in Chrome, wait for the products, right-click → Save as → Webpage, HTML only) so the reader can be updated. |
| **The store showed its bot check in the admin's browser** (Pokémon Center's "Request unsuccessful" / its security check) | The store wants a person to pass its check in that browser. Open the store in the admin's Chrome (a normal window), pass the check yourself, then press **↻ Reset** on the store. Mugibot never answers a bot check; it backs off and tries again later. If it comes back every time, the store is turning that connection away: try again later, or from another admin's browser. |
| **BIG W has no results for "…"** (a store's details, **last search**, or **Every search**) | The store's own page said that search found nothing ("No results" — often a drop watch's or key phrase's words it doesn't sell yet). It's that one search's answer, not a problem with the store: the store's line still says **Searching**. Nothing to do. |
| **BIG W's page said 57 results for "…", but none were on it yet when Mugibot read it** (**Retrying**) | BIG W's page said it had results, but hadn't drawn them in the 15 s it gets (a page in a minimised window may not). It's read again next round at the usual pace — no backing off, and that search's scene isn't reset, so nothing is taken for "new". If it keeps happening, leave the sweep window minimised but not closed, or press **↻ Reset** on BIG W. If it never stops, send a copy of BIG W's search page. |
| **No products showed on BIG W's page for "…"** | The page said neither that it had results nor that it had none — from an extension older than **1.32.0**, which doesn't say. Update the extension in the admin's browser. |
| **No products on the page** for a store and keyword (before October 2026) | What the line above says now, for every store read this way. Check **Every search**: if it stays 0 for a keyword the store does sell, send a copy of the page. |
| A product keeps pinging that you don't want | Open it (the **Price history** button in the Discord post) and press **🚫 Blacklist**, or add it in **Admin → Blacklist** (by SKU or product link, or a whole store). |
| "In stock" pings for something that never sold out | Fixed in 1.6.0: when a store refused the checks for a while and then answered again, that counted as a restock. Now it's compared with the last check that could read the page. |
| A Target product shows **Out of stock** but it's on the site | It was missing from Target's results for 6 minutes. The next sweep that finds it puts it back (and alerts a restock). If it keeps happening, the keyword has more results than Mugibot reads: use a more specific keyword. |
| A product you expect isn't tracked | Its name needs every word of the keyword and a trading-card word, no "not trading cards" word (unless it says TCG, trading card or card game), and it must be sold by the store itself. Adjust the word lists in Monitor → Settings. |
| A JB Hi-Fi **Marketplace** product still pinged | Its first alert is held until its seller is known; if JB Hi-Fi didn't answer that question, the alert goes out as before. Blacklist it (🚫), or tell me the product link. |
| Clothes or toys in the list | MugiWatch's card words include "pack" and "sleeve", so "3 Pack Socks" looks like cards. Add the word (e.g. "onesie") to **Not trading cards**; products that no longer count leave the list when you save. |
| A store shows **In queue** on the live monitor | Its virtual queue is up, so the admin's browser isn't searching it until it's through the queue or the queue's down. That's on purpose: a search could cost the admin their place in line. Nothing to do. |
| `#virtual-queue-detection` got nothing | Press **Set up store channels** again (it makes the channel), and check the bot can post there. EB Games' and Pokémon Center's queues need an admin's browser with the extension (1.16.0 or later) open, or members' browsers landing in the queue. |
| BIG W items say **The store said "Access Denied" to your browser** | BIG W's bot protection turned that browser away. Mugibot leaves BIG W alone from it for 30 minutes, then reads the pages again. To get back in sooner, clear BIG W's cookies in that browser (the icon left of the address → Cookies and site data), or use another network. Keep sweeping and checking out on different computers or networks if it keeps happening. |
| A drop watch at another website says **refused Mugibot (HTTP 403)** or **a bot check**, or a find says **Blocked by site** | That site turns servers away. Open the extension's toolbar menu and press **Allow checks from this browser** under **Websites refusing Mugibot's server**: your browser checks it from then on (an admin's for a watch for everyone, yours for your own). At a store Mugibot knows (BIG W), an admin's browser does it with nothing to allow — keep Chrome open with the extension connected. The server keeps asking too, waiting longer each time. |
| A drop watch at another website finds **nothing** though the site has it | Mugibot reads product links (`/products/…`, `/product/…`, `/p/…`) and the product data in the page. Give the site's own search page for those words (search there, copy the address), or watch the product's link. |
| A drop watch's alerts went to `#misc-retailers` | There's no `#non-tcg-alerts` rule yet: press **Make #non-tcg-alerts** on the drop watches tab (or **Set up store channels**). Or pick a channel for the watch (**✎** on it). |
| **Post its drops and restocks in** is greyed out | The Discord bot isn't set up (Admin → Setup check), or Discord didn't answer: open the tab again in a minute. A channel made since shows up within a minute. |
| A drop watch's channel post failed | The bot can't post there: give its role **View Channel**, **Send Messages** and **Embed Links** in that channel (or pick another with **✎**). |
| A queue still shows **up** after it's gone | An admin's browser confirms it's down. Without one, it counts as down 30 minutes after anyone last saw it (3 hours at most). |
| No sound | Press **🔔 Arm alerts** (browsers only play sound after a click on the page), and check **Sound** is on under **⚙**. |
| No desktop notifications | Allow notifications for mugibot.com in the browser (the icon left of the address), then **Arm alerts** again. |
| Lots of new drops after changing settings | Shouldn't happen: a changed keyword or filter sets the scene again first. If it does, tell me which store and keyword. |
| Alerts in the dashboard but not in Discord | Admin → Setup check → **Check the Discord bot**, then **Post a test message**. Check the rule's channel ID, that it ticks 🆕 / 🟢 / 📉, and that the bot can post there. |

## 7. Where things are

| Part | File |
|---|---|
| The sweeps: loops, filters, alerts, admins' browsers | `server/monitor/sweep.js` |
| Reading search results (Target, Shopify, any store), shared with the extension | `server/monitor/listing.js` |
| Store requests on Node's own `https` client | `server/monitor/http.js` |
| Each store's search address and reader | `sweep:` in `server/retailers/<store>.js` |
| Alerts, Discord embeds, live dashboard updates | `server/monitor/feed.js` |
| Page checks of single products and members' SKUs | `server/monitor/index.js` |
| Catalogue, price history, alert history | `server/catalog.js`; `products`, `sweep_terms`, `price_history`, `feed_alerts` (`server/db.js`, migration 5) |
| Admin API | `GET/PUT /api/monitor/sweep`, `POST /api/monitor/sweep/now`, `POST /api/monitor/sweep/reset` (`{store}`, or nothing for every store), `POST /api/monitor/routes/setup` (store channels) (`server/routes/monitor.js`) |
| Extension API | `GET/POST /api/ext/sweeps` (`server/routes/ext.js`), `sweepLoop()` in `extension/background.js` |
| Dashboard | `web/app.html` (Live, Settings and Check log pages; the Tracked products / My watchlist / My activity card), `web/js/live.js` (the live page: sonar, stores and their switches, numbers, feed, alerts, response times), `web/js/monitor.js` (products, product page, Settings, Check log), `web/js/app.js` (the watchlist and activity lists), `renderPager` in `web/js/common.js` |
| What members see of the sweeps | `server/monitor/public.js` (used by `GET /api/monitor/live` and the live stream in `server/monitor/feed.js`); members' own store switches: `GET/PUT /api/monitor/prefs` |
| 🎯 Drop watches | `server/monitor/drops.js` (watches, their searches' turn, other websites' reads, what they find — `hasWords`, `room` — where they post, and your own finds' price drops: `priceDropped`); `drop_watches` (with `channel_id`, `role_id`: migration 12; `bases`, each store's first look for a key phrase at every store, `ALL_STORES`: migration 18), `items.drop_watch`, `monitors.drop_watch` (`server/db.js`, migration 11), `items.price_alert_at`/`price_alert_price` (migration 13); `GET/POST /api/drops` (`phrases`: several key phrases at once), `PUT /api/drops/:id` (its name; admins: its channel and role), `GET /api/drops/discord` (admins: the server's channels and roles), `POST /api/drops/:id/check`, `DELETE /api/drops/:id`, `POST /api/drops/channel`; routing in `Feed.routesFor` (`server/monitor/feed.js`); `web/js/drops.js`; Acme Collectibles (another website) in `devtools/mockstore.js`; `test/drops.test.js` and the 🎯 tests in `test/extension.e2e.test.js` and `test/ui.test.js` |
| ⭐ VIP drops | `server/monitor/vip.js`; `vip_watches`, `monitors.vip_watch`, `alert_routes.vip` (`server/db.js`, migration 9); `GET/POST /api/monitor/vip`, `DELETE /api/monitor/vip/:id`, `POST /api/monitor/vip/channel`; `test/vip.test.js` |
| 🚦 Checkpoints and virtual queues | `server/monitor/gates.js` (up and down, the posts, DMs), `server/monitor/gate.js` (reading a page; the extension has a copy); `gate:` in `server/retailers/<store>.js`; `gates` (`server/db.js`, migration 10); `GET /api/gates`, `POST /api/ext/gates`; `test/gates.test.js` and the 🛡️/🚦 tests in `test/extension.e2e.test.js` |
| JB Hi-Fi's marketplace sellers | `sweep.sellers` in `server/retailers/jbhifi.js`; `sellerOf()` and `checkSellers()` in `server/monitor/sweep.js` |
| The live event log | `emit()` and `live()` in `server/monitor/sweep.js`; `GET /api/monitor/live`; `monitor-sweep` events on the dashboard's stream |
| Tests | `test/sweep.test.js` and `test/serverfirst.test.js`, plus the Drops page in `test/ui.test.js` and the admin's-browser sweeps (server first's stand-in too) in `test/extension.e2e.test.js` |

### What changed from MugiWatch

- **Kept**: keyword sweeps per store, the first sweep as a silent baseline,
  NEW / RESTOCK (once a day) / PRICE drop (10%), the marketplace and
  trading-card filters and the trading-card words, per-store health, jittered
  waits and backoff, an instant dashboard and Discord webhook-style alerts.
- **Better stock reading**: MugiWatch never saw stock at Target or JB Hi-Fi
  (JB's search page has no stock, and Target leaves sold-out products out of
  its results), so it couldn't alert their restocks. Mugibot reads JB Hi-Fi's
  stock from its search suggestions (which also give links and pictures), and
  at Target treats a product that drops out of the results as sold out and
  its return as a restock.
- **Persistent**: products, stock, prices and baselines are in the database,
  so a restart doesn't re-baseline or lose history, and a drop that happens
  while the server restarts is still a new drop.
- **Not kept**: the disguised Chrome User-Agent and puppeteer "stealth"
  (they didn't help: the same requests with honest headers are answered the
  same), headless Chrome on the server (admins' real browsers sweep the stores
  that refuse servers instead), and the plain-text card profile (Mugibot keeps
  the card encrypted in each member's own browser).
