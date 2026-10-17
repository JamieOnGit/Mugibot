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

| Store | Searched from | What's read |
|---|---|---|
| Target | Mugibot's server | Target's search page, newest first: every page with results (up to 4 pages of 48), with stock for every colour and size |
| JB Hi-Fi | Mugibot's server | JB Hi-Fi's search suggestions (Shopify): 10 products a search, with stock. "tcg" is added to each keyword ("pokemon tcg"), because "pokemon" alone finds plushies and games |
| Toys"R"Us | Mugibot's server | Same as JB Hi-Fi (also a Shopify store) |
| Trainer Town | Mugibot's server | Each game's whole collection (Shopify's product list for it): every product, sold-out ones too, with stock, price and the option to add to the cart, in one read. A keyword with no collection of its own is searched instead (search suggestions, like JB Hi-Fi). At most one read every 15 seconds: reading the whole collection every 5 seconds made Shopify answer **HTTP 429** (too many requests) |
| Kmart | Mugibot's server | Kmart's search provider, Constructor.io: each keyword within Kmart's **Trading Cards** category, sold by Kmart or Target (not marketplace sellers), newest first. Every product's code, price, picture, pre-order flag and the states it's out of stock in: out of stock in every state = sold out online |
| The Games Cube | Mugibot's server | Its search pages (CrystalCommerce, made on the server): a tile per product with each option's stock and price, up to 4 pages of 25–30. Pre-orders are the ones in its "… Pre-Orders" categories. The cards it buys from customers (its buylist) are left out |
| Gamerholic | Mugibot's server | Its **newest 100 products** (Shopify's product list, newest first, every option's stock), for every keyword: Gamerholic lists hundreds of products a day, so a new drop shows up there the moment it's listed. At most one read every 15 seconds |
| BIG W | **An admin's browser** (the extension) | BIG W's search page, **opened** in a minimised window of the extension's own and read once the page has built its product list — or, if the page has downloaded its products but not drawn them (pages in a minimised window may not), the product data it downloaded |
| Amazon AU | **An admin's browser** (the extension, 1.11.0 or later) | Amazon's search page, newest first (2 pages of 48), with "tcg" added to each keyword — asked for from inside an Amazon page in the extension's window. Amazon turns Mugibot's server away (**HTTP 503**, "An error occurred"), so nothing came through from the server. At most one search every 20 seconds |
| EB Games | **An admin's browser** (the extension) | EB Games' own search data (the JSON its search page asks for: every product's code, price, picture, stock, pre-order and release date), newest first, 2 pages — asked for from inside an EB Games page in the extension's window |
| Zing | Off | zingpopculture.com.au now sends every visitor to EB Games, so EB Games' sweeps cover it. An admin can switch it back on if Zing's own site returns |
| Pokémon Center (Australia) | **An admin's browser** (the extension, 1.8.1 or later) | Its search page (`/en-au/search/<keyword>`, 32 a page), opened in the extension's window and read once it has built its product list, like BIG W's. Its bot check (Imperva) may reload the page first: the extension waits for it. At most one search every 30 seconds |
| Premium Bandai (Australia) | **An admin's browser** (the extension, 1.8.1 or later) | The site's own search JSON (`/api/search?keyword=…`, newest arrivals first, up to 100), asked for from inside a Premium Bandai page in the extension's window with the region its own code sends (`x-g1-area-code: au`), like EB Games'. At most one search every 30 seconds |

BIG W, EB Games, Pokémon Center and Premium Bandai refuse requests from
servers (403 / Cloudflare's, Imperva's or their own bot checks), so the
extension in an **admin's** browser searches them instead, every 15 seconds per
store (BIG W every 20, Pokémon Center and Premium Bandai every 30). Members' browsers never do this: only
Mugibot's server and admins can change what everyone sees.

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

You can change where each store is searched from (server, admin's browser or
off) in **Monitor → Settings → Stores**.

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
   │ fetch it (honest Mugibot headers)                                     │
   │ read every product: code, name, price, stock, link, picture          │──┐
   │ wait ~5 s (±20%), or back off after a failure (×2 each time, ≤15 min) │  │
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

With the defaults (2 keywords, a search every 5 seconds per store):

- Target: page 1 of each keyword every ~15 s, every page every ~1–2 minutes.
  Target's own CDN keeps a copy of a search page for a short while, so a
  change can take a minute or two to show up there. Mugibot doesn't try to
  get around their cache.
- JB Hi-Fi and Toys"R"Us: each keyword every ~10 s.
- Trainer Town: each keyword's whole collection every ~30 s (one read every 15 s).
- Kmart: each keyword every ~10 s.
- Amazon AU: each keyword every ~60 s (page 1), page 2 now and then.
- The Games Cube: each keyword every ~10 s (page 1), the later pages now and then.
- Gamerholic: its newest products every ~15 s.
- BIG W (admin's browser): each keyword every ~40 s; EB Games: every ~30 s;
  Pokémon Center and Premium Bandai: every ~60 s.

More keywords means each one comes round a little less often. Each store has
its own loop, so a slow store never holds up the others.

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
   - **Stores**: where each store is searched from (changes straight away), how
     it's doing, and **↻ Reset** for each store (or **Reset all**).
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

## 4. Running it day to day: the live monitor

Dashboard → **Monitor** has three pages. Members see **Live**; admins also get
**Settings** and the **Check log** (the switch under the title). Everything on
them is real: it comes from the sweeps as they happen.

**Live**

| Part | What it shows |
|---|---|
| **Title** | What's being searched for, where (e.g. "Searching 9 stores every few seconds for **pokemon** and **one piece**"). On the right: **🔔 Arm alerts**, **⚙** (this browser's alerts), and for admins **⟳ Sweep now** and **+ Add monitor**. |
| **Needs attention** | Only when a store keeps failing: which ones, and (admins) **↻ Reset all**. |
| **Live sonar** | A sweeping radar with a blip per store; a blip rings each time that store answers a search (red when a search fails). |
| **Stores** | One line per store: its colour, name and state (searching / slowed / retrying / waiting for an admin's browser), and underneath what it's doing ("Answered in 412 ms · next in 3 s") or what's wrong ("The store refused the search (HTTP 429)"). Click a store for the details: searches, last answer, next search, where it's searched from, how long the store asked to wait. Admins: **↻** on each line resets that store. |
| **The four numbers** | Drops today (new drops and restocks in 24 h), available now, alert speed (from a store's answer to your screen), searches per hour (and failures). |
| **Live feed** | New drops and restocks as they're found, with the picture, price (and old price), **⚡ Buy** and a link to the store. **Show** switches to everything (each search, fault, setting change and product that drops out of the results), new drops, restocks, price changes, searches or problems. |
| **Tracked products** | Every product the sweeps track: picture, name, store, price (and old price), stock, **⚡ Buy**. 🆕 marks products found in the last 24 hours. Click a name for its price history. |

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
- a wait the store asked for (`Retry-After`) is still respected.

It's written to the event log ("boss reset Trainer Town: searching it again
now, gently for 10 minutes") and the audit log. If a store the server
searches is still refused after a reset, its details offer **Search it from an
admin's browser**. Reset never gets around a bot check: it only stops Mugibot
waiting and starts politely again.

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

## 6. Troubleshooting

| You see | Do this |
|---|---|
| **The store refused the search (HTTP 429)** — "it asked to wait 60 s" | The store is asking Mugibot to slow down. It waits what the store asked, then tries again. Trainer Town now reads its collections at most every 15 s, which should stop it; if it keeps happening, press **↻ Reset** on the store (it restarts gently, at a third of the pace for 10 minutes). |
| **HTTP 503** at a store, again and again (Amazon AU did this to the server, so it's now searched from an admin's browser) | **↻ Reset** the store. If it's still refused after that, open its details and press **Search it from an admin's browser** (or set it in Settings → Stores), and keep an admin's browser with the extension open. Don't make the searches more frequent: that makes it worse. |
| A store's status says **refused** (server) | The store is refusing Mugibot's server. Try **↻ Reset** first; if that doesn't help, set it to **Admin's browser** in Monitor → Settings → Stores, and keep an admin's browser with the extension open. |
| **Waiting for an admin's browser** (BIG W, EB Games: nothing coming through) | No admin's browser is sweeping. Open Chrome with the extension (1.7.0 or later — Extension tab → Download, or the Chrome Web Store copy) connected to an **admin** account, and leave it open. The popup should show **Live sweeps from this browser** within 30 seconds, and a small minimised window appears with a BIG W and an EB Games tab: leave it be. |
| **refused the admin's browser** | Open that store's website in the admin's browser once (so it gets the store's cookies), then wait. It tries again on its own, waiting longer each time. |
| **Needs Mugibot's extension 1.8.1 or newer** (Pokémon Center, Premium Bandai) | The admin's browser has an older copy of the extension: Chrome doesn't let it open stores added after it was made, and 1.8.0 couldn't read either store. Update it (Extension tab → Download, or wait for the Chrome Web Store copy to update itself). The store is searched again within 30 seconds of the updated browser asking. |
| **This browser couldn't open the store's page (…)** | The reason in brackets is Chrome's. "Cannot access contents of the page": the extension is too old for that store (update it). Anything else: the store's page didn't load in the sweep window; it tries again on its own. |
| **The page didn't have the product list Mugibot reads** | The store changed its search page. Send a copy of the page (right-click → Save as) so the reader can be updated. |
| **No products on the page** for a store and keyword | The store has nothing for that keyword, or its page builds the list later with JavaScript (that's why Kmart and BIG W showed 0 before 1.6.0). Check **Every search**: if it stays 0 for a keyword the store does sell, send a copy of the page. |
| A product keeps pinging that you don't want | Open it (the **Price history** button in the Discord post) and press **🚫 Blacklist**, or add it in **Admin → Blacklist** (by SKU or product link, or a whole store). |
| "In stock" pings for something that never sold out | Fixed in 1.6.0: when a store refused the checks for a while and then answered again, that counted as a restock. Now it's compared with the last check that could read the page. |
| A Target product shows **Out of stock** but it's on the site | It was missing from Target's results for 6 minutes. The next sweep that finds it puts it back (and alerts a restock). If it keeps happening, the keyword has more results than Mugibot reads: use a more specific keyword. |
| A product you expect isn't tracked | Its name needs every word of the keyword and a trading-card word, no "not trading cards" word (unless it says TCG, trading card or card game), and it must be sold by the store itself. Adjust the word lists in Monitor → Settings. |
| A JB Hi-Fi **Marketplace** product still pinged | Its first alert is held until its seller is known; if JB Hi-Fi didn't answer that question, the alert goes out as before. Blacklist it (🚫), or tell me the product link. |
| Clothes or toys in the list | MugiWatch's card words include "pack" and "sleeve", so "3 Pack Socks" looks like cards. Add the word (e.g. "onesie") to **Not trading cards**; products that no longer count leave the list when you save. |
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
| Dashboard | `web/app.html` (Live, Settings and Check log pages), `web/js/live.js` (the live page: sonar, stores, numbers, feed, alerts, response times), `web/js/monitor.js` (products, product page, Settings, Check log) |
| JB Hi-Fi's marketplace sellers | `sweep.sellers` in `server/retailers/jbhifi.js`; `sellerOf()` and `checkSellers()` in `server/monitor/sweep.js` |
| The live event log | `emit()` and `live()` in `server/monitor/sweep.js`; `GET /api/monitor/live`; `monitor-sweep` events on the dashboard's stream |
| Tests | `test/sweep.test.js`, plus the Monitor tab in `test/ui.test.js` and the admin's-browser sweep in `test/extension.e2e.test.js` |

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
