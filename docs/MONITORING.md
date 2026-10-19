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

**Server first** is every store's default: Mugibot's server searches it, and
an admin's browser (the extension) only stands in while the server can't:

- **Hand-over.** The store refuses the server, or its search fails, **3 times
  in a row** — once, at a store known to turn servers away (BIG W, Amazon, EB
  Games, Pokémon Center, Premium Bandai, The Gamesmen). Or the server's read has **no
  products** where there are some: a page that only draws them once it's open
  (BIG W's, Pokémon Center's), or a search an admin's browser found products
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
store's monitors only while the server's being refused there.

An admin can still pin a store (**Monitor → Settings → Stores**): **Server
only** (never a browser), **Admin's browser** (never the server) or **Off**.
Settings saved before server first: a store set to the server or a browser is
server first now (only a store switched off stays off); choices made after it
stick.

| Store | Searched from | What's read |
|---|---|---|
| Target | Server first | Target's search page, newest first: every page with results (up to 4 pages of 48), with stock for every colour and size |
| JB Hi-Fi | Server first | JB Hi-Fi's search suggestions (Shopify): 10 products a search, with stock. "tcg" is added to each keyword ("pokemon tcg"), because "pokemon" alone finds plushies and games |
| Toys"R"Us | Server first | Same as JB Hi-Fi (also a Shopify store) |
| Trainer Town | Server first | Each game's whole collection (Shopify's product list for it): every product, sold-out ones too, with stock, price and the option to add to the cart, in one read. A keyword with no collection of its own is searched instead (search suggestions, like JB Hi-Fi). At most one read every 15 seconds: reading the whole collection every 5 seconds made Shopify answer **HTTP 429** (too many requests) |
| Kmart | Server first | Kmart's search provider, Constructor.io: each keyword within Kmart's **Trading Cards** category, sold by Kmart or Target (not marketplace sellers), newest first. Every product's code, price, picture, pre-order flag and the states it's out of stock in: out of stock in every state = sold out online. Its loop reads **every trading card it sells in one list** (its Trading Cards browse, newest first, 200 to a page — 177 products in October 2026): each product every few seconds, whatever the keywords. A VIP or drop watch's words are searched on their own, across the whole store |
| The Games Cube | Server first | Its search pages (CrystalCommerce, made on the server): a tile per product with each option's stock and price, up to 4 pages of 25–30. Pre-orders are the ones in its "… Pre-Orders" categories. The cards it buys from customers (its buylist) are left out |
| Gamerholic | Server first | Its **newest 100 products** (Shopify's product list, newest first, every option's stock), for every keyword: Gamerholic lists hundreds of products a day, so a new drop shows up there the moment it's listed. At most one read every 15 seconds |
| BIG W | Server first: **an admin's browser** (the extension) stands in, as the server can't draw its products | BIG W's search page, **opened** in a minimised window of the extension's own and read once the page has built its product list — or, if the page has downloaded its products but not drawn them (pages in a minimised window may not), the product data it downloaded |
| Amazon AU | Server first: **an admin's browser** (the extension, 1.11.0 or later) stands in at the first refusal | Amazon's search page, newest first (2 pages of 48), with "tcg" added to each keyword — asked for from inside an Amazon page in the extension's window. Amazon turns Mugibot's server away (**HTTP 503**, "An error occurred"), so nothing came through from the server. At most one search every 20 seconds |
| EB Games | Server first: **an admin's browser** (the extension) stands in at the first refusal | EB Games' own search data (the JSON its search page asks for: every product's code, price, picture, stock, pre-order and release date), newest first, 2 pages — asked for from inside an EB Games page in the extension's window |
| Zing | Not searched | zingpopculture.com.au now sends every visitor to EB Games, so EB Games' sweeps cover its range. It's no longer in the live sweeps at all (switched on, an admin's browser only ever got "couldn't reach the store") |
| City Beach | Server first | Its search page (Salesforce Commerce Cloud, made on the server): a tile per product with its code, name, brand and price (48 a search). Stock isn't in the tiles: it comes from the product page, which the monitor reads. At most one search every 10 seconds (every 4 in a VIP drop's window) |
| Pokémon Center (Australia) | Server first: **an admin's browser** (the extension, 1.8.1 or later) stands in at the first refusal | Its search page (`/en-au/search/<keyword>`, 32 a page), opened in the extension's window and read once it has built its product list, like BIG W's. Its bot check (Imperva) may reload the page first: the extension waits for it. At most one search every 30 seconds |
| Premium Bandai (Australia) | Server first: **an admin's browser** (the extension, 1.8.1 or later) stands in at the first refusal | The site's own search JSON (`/api/search?keyword=…`, newest arrivals first, up to 100), asked for from inside a Premium Bandai page in the extension's window with the region its own code sends (`x-g1-area-code: au`), like EB Games'. It answers Mugibot's server too now (Oct 2026), so the server reads it. A search that finds nothing ("pokemon" there) comes back with no products list at all, only its count: that's an empty search, not a changed page. At most one search every 30 seconds |
| Pokébox | Server first | Each keyword's search (Shopify's search suggestions, 10 a search with stock), "tcg" added ("pokemon tcg": its sealed products first — Pokébox names its hundreds of singles after the card), and as every keyword's **second page** the store's **newest 30 products** (Shopify's product list, most recently changed first, `sweep.feedPath`): a new drop shows up there the moment it's listed. At most one read every 10 seconds |
| Good Games, Collectible Madness, Cherry Collectables | Server first | The same as Pokébox (Shopify card shops) |
| The Gamesmen | Server first: **an admin's browser** (the extension, **1.19.1** or later) stands in at the first refusal | Its search page **newest first** ("Recently Listed": a new listing is on page 1 the moment it's up), opened in the extension's window and read once its results are drawn, 2 pages: its own tiles (its Hyvä theme, read from a copy of its real page — from 1.20: the name, the price shown with GST, a struck-through old price, "Add to Cart" or "Pre-Order", the product's id), or Magento's usual ones, or — drawn some other way — any product on the page with its link and a price. Its menu's links look like product links (its products are `/<name>`), so 1.19.1 doesn't count the site's menus as the results (1.19.0 read the page before they were drawn). Its Cloudflare turns servers away ("Sorry, you have been blocked") |
| Games World | Server first | WooCommerce's own product API (`/wp-json/wc/store/v1/products?search=…`, newest first, 30 a search): stock, price, pre-orders (backorders) and the product's id for its add-to-cart link — only the fields Mugibot reads (about 100 KB a search). At most one search every 15 seconds |

BIG W, EB Games, Pokémon Center, Premium Bandai and The Gamesmen have refused
requests from servers (403 / Cloudflare's, Imperva's or their own bot checks), so
while they do, the extension in an **admin's** browser searches them instead, every 15
seconds per store (BIG W every 20, Pokémon Center and Premium Bandai every 30).
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
  other search). VIP and drop watches' words still get their own searches,
  across the whole store. If that list ever stops coming back as a list, each
  keyword is searched instead for 15 minutes (the live log says so), then the
  list again. A refusal is Kmart's, as for any search: it slows down.
- Target: page 1 of each keyword every ~15 s, every page every ~1–2 minutes.
  Target's own CDN keeps a copy of a search page for a short while, so a
  change can take a minute or two to show up there. Mugibot doesn't try to
  get around their cache.
- JB Hi-Fi and Toys"R"Us: each keyword every ~10 s.
- Trainer Town: each keyword's whole collection every ~30 s (one read every 15 s).
- Amazon AU: each keyword every ~60 s (page 1), page 2 now and then.
- The Games Cube: each keyword every ~10 s (page 1), the later pages now and then.
- Gamerholic: its newest products every ~15 s.
- BIG W (admin's browser): each keyword every ~40 s; EB Games: every ~30 s;
  Pokémon Center and Premium Bandai: every ~60 s.
- Pokébox, Good Games, Collectible Madness, Cherry Collectables: each keyword
  every ~20–30 s, and their newest products as often.
- Games World: each keyword every ~30 s.
- The Gamesmen (admin's browser): each keyword every ~40 s.

More keywords means each one comes round a little less often. Each store has
its own loop, so a slow store never holds up the others.

**What goes first, the moment a search sees a drop:**

1. Every armed member's **Auto-checkout run** is made, and their browsers are
   told at once.
2. The **channel alerts** go to Discord. Every channel whose rule wants the alert
   gets it at once, ahead of any members' DMs still going out (Mugibot's line to
   Discord puts a drop's channel post first). It never waits for the rest of the
   search or for another product's alerts.
3. The watching members' own **DMs**, webhooks and emails, five at a time.

The dashboards' live feed has it before Discord does. **Alert speed** on the
live monitor shows the latest alerts' time from the store's answer to your
screen, and to Discord. Discord's limits are kept: a channel that has had its
5 messages in 5 seconds waits for its reset (Discord says when), and a "slow
down" on one request holds nothing else up.

Kmart's figures give its stock state by state. When only some states have a
product, its alert says which: "In stock in NSW, VIC only." When most of them
have it, it names the ones that don't: "In stock everywhere except NT."

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
     - Those words are searched at that store, every other search.
     - Anything with **every** word in its name counts (`skate` also matches
       "Skateboard"; accents don't matter). "Trading cards only" doesn't apply.
     - A product that's new since the watch's first search is a 🆕 new drop.
     - The store's own keyword searches count a match too.
   - **A product page**: any shop's link (a "misc" site too). A monitor reads it.
3. **Drops at** (optional, your time). From 15 minutes before to 3 hours after:
   - The store is searched for those words only, every **4 seconds**.
   - What the watch found has its page read every **5 seconds**.
   - Otherwise its pages are read every 15 seconds.
4. **🤖 Auto-checkout it for me, up to $…** (optional). What **drops** goes on
   your watchlist, armed for Auto-checkout up to that max price, and your browser
   checks out the moment its page says it's in stock. What drops:
   - a new listing: anything found after the watch's first search;
   - something already listed whose page says it isn't on sale yet (coming
     soon, sold out).

   What was **already on sale** when you added the watch is never armed. A broad
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
  own name. The extension's in-browser checks don't cover other websites (it
  only runs on the stores Mugibot knows): a site that turns Mugibot's server
  away (Microsoft's, say) shows **Check failed**, and is asked again later.
- **The words in its name**, and where to look:
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
    each time.

  Anything whose name has **every** word counts, trading cards or not. A short
  word (three letters or fewer) or a number has to be a whole word in the name —
  "xbox series x" isn't the Series S, "playstation 5 pro" isn't a PlayStation 5
  "Promo Bundle", "switch 2" isn't a 2024 edition (a plural's fine: "box" →
  "Boxes"); a longer one counts at the start of a word ("skate" → "Skateboard").
  At **Kmart**, whose card searches are kept to its Trading Cards, a watch's
  words (and a VIP watch's) are searched across the whole store.
  Mugibot's first look is the "before" picture: what's there already isn't a
  drop. What shows up after it is.

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

### 🚦 Checkpoints and virtual queues

Before a big drop some stores put up a gate. Mugibot watches for each one going
up and coming down, and tells everyone so they can get ready:

| Store | Its gate | How Mugibot sees it |
|---|---|---|
| **JB Hi-Fi** | Shopify's **checkpoint**: an hCaptcha page at `https://www.jbhifi.com.au/checkpoint` that checkout goes through | The **server** looks at `/checkpoint` once a minute, as `Mugibot/1.0` (JB answers servers; it's swept from there too). Up: the page with its hCaptcha. Down: gone (404), sent on to the store, or no check there. A change is looked at again 10 seconds later and counts once it's seen twice. |
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
| **Stores** | One line per store: its colour, name and state (searching / slowed / retrying / off; admins also see waiting for an admin's browser), and underneath what it's doing ("Answered in 412 ms · next in 3 s") or what's wrong ("The store refused the search (HTTP 429)"). Click a store for the details: searches, last answer, next search, how long the store asked to wait (admins: where it's searched from). Each line has an **on/off switch** (below). Admins: **↻** on each line resets that store. |
| **The four numbers** | Drops today (new drops and restocks in 24 h), available now, alert speed (from a store's answer to your screen, and to Discord), searches per hour (and failures). |
| **Live feed** | New drops and restocks as they're found, with the picture, price (and old price), **⚡ Buy** and a link to the store. **Show** switches to everything (each search, fault, setting change and product that drops out of the results), new drops, restocks, price changes, searches or problems. |
| **Tracked products · My watchlist · My activity** | One card with three tabs (the dashboard remembers the last one you opened; members without a membership see My watchlist and My activity). **Tracked products**: every product the sweeps track, 25 to a page: picture, name, store, price (and old price), stock, **⚡ Buy**, and **☆** to add it to your watchlist (**★** when it's on it, **★ 🤖** when it's armed for Auto-checkout). 🆕 marks products found in the last 24 hours. Click a name for its price history. **My watchlist**: your own SKUs, 10 to a page, with **+ Add SKU**, the alerts for each and the 🤖 arming. **My activity**: your restocks, alerts and sign-ins, 20 to a page. All three page with buttons underneath (no endless scrolling); new activity appears at the top of page 1 as it happens. |

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
  first (like a visitor arriving), then the search;
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
| **No products on the page** for a store and keyword | The store has nothing for that keyword, or its page builds the list later with JavaScript (that's why Kmart and BIG W showed 0 before 1.6.0). Check **Every search**: if it stays 0 for a keyword the store does sell, send a copy of the page. |
| A product keeps pinging that you don't want | Open it (the **Price history** button in the Discord post) and press **🚫 Blacklist**, or add it in **Admin → Blacklist** (by SKU or product link, or a whole store). |
| "In stock" pings for something that never sold out | Fixed in 1.6.0: when a store refused the checks for a while and then answered again, that counted as a restock. Now it's compared with the last check that could read the page. |
| A Target product shows **Out of stock** but it's on the site | It was missing from Target's results for 6 minutes. The next sweep that finds it puts it back (and alerts a restock). If it keeps happening, the keyword has more results than Mugibot reads: use a more specific keyword. |
| A product you expect isn't tracked | Its name needs every word of the keyword and a trading-card word, no "not trading cards" word (unless it says TCG, trading card or card game), and it must be sold by the store itself. Adjust the word lists in Monitor → Settings. |
| A JB Hi-Fi **Marketplace** product still pinged | Its first alert is held until its seller is known; if JB Hi-Fi didn't answer that question, the alert goes out as before. Blacklist it (🚫), or tell me the product link. |
| Clothes or toys in the list | MugiWatch's card words include "pack" and "sleeve", so "3 Pack Socks" looks like cards. Add the word (e.g. "onesie") to **Not trading cards**; products that no longer count leave the list when you save. |
| A store shows **In queue** on the live monitor | Its virtual queue is up, so the admin's browser isn't searching it until it's through the queue or the queue's down. That's on purpose: a search could cost the admin their place in line. Nothing to do. |
| `#virtual-queue-detection` got nothing | Press **Set up store channels** again (it makes the channel), and check the bot can post there. EB Games' and Pokémon Center's queues need an admin's browser with the extension (1.16.0 or later) open, or members' browsers landing in the queue. |
| A drop watch at another website says **refused Mugibot (HTTP 403)** or **a bot check** | That site turns servers away. It's asked again later on its own (waiting longer each time); if it keeps refusing, watch the product's link at a store Mugibot knows instead, if it sells there. |
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
| 🎯 Drop watches | `server/monitor/drops.js` (watches, their searches' turn, other websites' reads, what they find — `hasWords`, `room` — where they post, and your own finds' price drops: `priceDropped`); `drop_watches` (with `channel_id`, `role_id`: migration 12), `items.drop_watch`, `monitors.drop_watch` (`server/db.js`, migration 11), `items.price_alert_at`/`price_alert_price` (migration 13); `GET/POST /api/drops`, `PUT /api/drops/:id` (its name; admins: its channel and role), `GET /api/drops/discord` (admins: the server's channels and roles), `POST /api/drops/:id/check`, `DELETE /api/drops/:id`, `POST /api/drops/channel`; routing in `Feed.routesFor` (`server/monitor/feed.js`); `web/js/drops.js`; Acme Collectibles (another website) in `devtools/mockstore.js`; `test/drops.test.js` and the 🎯 tests in `test/extension.e2e.test.js` and `test/ui.test.js` |
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
