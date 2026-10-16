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
| Trainer Town | Mugibot's server | Each game's whole collection (Shopify's product list for it): every product, sold-out ones too, with stock, price and the option to add to the cart, in one read. A keyword with no collection of its own is searched instead (search suggestions, like JB Hi-Fi) |
| Kmart, BIG W, EB Games, Zing | **An admin's browser** (the extension) | Their search pages: product tiles, and product data in the page's scripts |

Kmart, BIG W, EB Games and Zing refuse requests from servers (403 / bot
check), so the extension in an **admin's** browser searches them instead,
every 15 seconds per store. Members' browsers never do this: only Mugibot's
server and admins can change what everyone sees.

You can change where each store is searched from (server, admin's browser or
off) in **Monitor → Live sweeps → Settings**.

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
 admins' browsers (extension) do the same for Kmart, BIG W, EB Games, Zing ──┤
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
  then tries again.
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
- Trainer Town: each keyword's whole collection every ~10 s.
- Kmart, BIG W, EB Games, Zing (admin's browser): each keyword every ~30 s.

More keywords means each one comes round a little less often. Each store has
its own loop, so a slow store never holds up the others.

## 3. Setting it up

1. Deploy as usual: merging into `main` deploys it, and the database upgrades
   itself. Sweeps start on their own, with the keywords `pokemon` and
   `one piece`.
2. **Admins' browsers** (for Kmart, BIG W, EB Games, Zing): install the
   extension (version 1.5.0 or later; 1.5.1 for ⚡ Buy at Trainer Town), connect it to an **admin** account, and
   keep Chrome open. If a store refuses that browser too, open the store's
   website in it once, then wait for the next search. The extension's popup
   shows **Live sweeps from this browser** with each store's last result.
3. Discord: alerts go to the channels in **Monitor → Discord alert channels**.
   New drops are the 🆕 kind, restocks 🟢, price drops 📉; tick the kinds each
   channel should get. With no rules, restocks and new drops go to
   `DISCORD_RESTOCK_CHANNEL_ID`.
4. **Monitor → Live sweeps → Settings**:
   - **Keywords**: what to search for at every store.
   - **Seconds between searches at one store**: 5 to start with (3 at least).
   - **…from an admin's browser**: 15 to start with.
   - **Price drop alert from**: 10% to start with; 0 turns price drop alerts off.
   - **Where each store is searched from**.
   - **Alerts**: new drops, restocks, and "at most one restock alert a day per product".
   - **Which products count**: skip marketplace sellers, trading cards only, the trading-card words, and the "not trading cards" words.

## 4. Running it day to day: the live monitor

Dashboard → **Monitor** is a live console, laid out like DropSonar and
styled like the rest of Mugibot. Everything on it is real: it comes from the
sweeps as they happen.

| Part | What it shows |
|---|---|
| **01 Live sonar** | A sweeping radar with a blip per store; a blip rings each time that store answers a search (red when a search fails). |
| **02 Stores** | Each store: searching / slowed / retrying / waiting (for an admin's browser), searches so far, how long its last answer took, when its next search is, and where it's searched from. |
| **03 Keywords** | What every store is searched for. Admins add (type + **Add**) and remove (×) keywords right here. |
| **04 Tuning** | Admins: how often stores are searched (server stores 3–15 s, browser stores 5–60 s) and which alerts go out (new drops, restocks, price drops). Everyone: this browser's **Sound**, **Desktop notifications** and **Pop-up**. |
| **Numbers** | Uptime, searches (and per hour), drops caught in 24 h, mean alert time (from a store's answer to your screen), errors / OK-in-a-row, available now. |
| **05 Response times** | How long each store took to answer over the last 5 minutes, one line per store (hover or use the arrow keys for the exact times; **Show as a table** for the numbers). |
| **06 Event log** | Every search ("Target · "pokemon" — 48 products · 412 ms"), fault, setting change and product that drops out of the results, plus every alert with the product's picture, price (and old price), **⚡ Buy** and a link to the store. Filter: everything, alerts only, new drops, restocks, price changes, searches, problems. |
| **07 Tracked products** | Every product the sweeps track: picture, name, store, price (and old price), stock, the last price change, **⚡ Buy**. 🆕 marks products found in the last 24 hours. Click a name for its price history. |

**Alerts:** a new drop or restock pops up on whatever dashboard tab you're on,
with the picture, price, SKU, how fast it was alerted, **⚡ Buy**, **Open
product** and **Dismiss** (it closes by itself after 10 seconds; more than one
queue up). Press **🔔 Arm alerts** once per visit so the browser lets the
monitor play a sound and show desktop notifications; the tab title also
flashes while you're on another tab. **⚡ Test alert** runs the whole chain in
your browser only, to check the sound and pop-up.

**⚡ Buy** opens a new tab that adds the product to your watchlist and starts
your checkout with the extension, as before.

**Admins** also get **Sweep now** (search everything again straight away),
**+ Add monitor**, and below the console: the full sweep settings and **Every
search**, Discord alert channels, page-check health and the check log.

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
| A store's status says **refused** (server) | The store is refusing Mugibot's server. Set it to **Admin's browser** in Live sweeps → Settings, and keep an admin's browser with the extension open. Don't make the searches more frequent: that makes it worse. |
| **Waiting for an admin's browser** | No admin's browser is sweeping. Open Chrome with the extension connected to an admin account. The popup should show **Live sweeps from this browser** within 30 seconds. |
| **refused the admin's browser** | Open that store's website in the admin's browser once (so it gets the store's cookies), then wait. It tries again on its own, waiting longer each time. |
| **The page didn't have the product list Mugibot reads** | The store changed its search page. Send a copy of the page (right-click → Save as) so the reader can be updated. |
| **No products on the page** for a store and keyword | The store has nothing for that keyword, or (Kmart, BIG W, EB Games, Zing) its page builds the list later with JavaScript. Check **Every search**: if it stays 0 for a keyword the store does sell, send a copy of the page. |
| A Target product shows **Out of stock** but it's on the site | It was missing from Target's results for 6 minutes. The next sweep that finds it puts it back (and alerts a restock). If it keeps happening, the keyword has more results than Mugibot reads: use a more specific keyword. |
| A product you expect isn't tracked | Its name needs every word of the keyword and a trading-card word, no "not trading cards" word (unless it says TCG, trading card or card game), and it must be sold by the store itself. Adjust the word lists in the sweep settings. |
| Clothes or toys in the list | MugiWatch's card words include "pack" and "sleeve", so "3 Pack Socks" looks like cards. Add the word (e.g. "onesie") to **Not trading cards**; products that no longer count leave the list when you save. |
| No sound | Press **🔔 Arm alerts** (browsers only play sound after a click on the page), and check **Sound** is on under Tuning. |
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
| Admin API | `GET/PUT /api/monitor/sweep`, `POST /api/monitor/sweep/now` (`server/routes/monitor.js`) |
| Extension API | `GET/POST /api/ext/sweeps` (`server/routes/ext.js`), `sweepLoop()` in `extension/background.js` |
| Dashboard | `web/app.html`, `web/js/live.js` (the live console: sonar, stores, chart, event log, alerts), `web/js/monitor.js` (products, product page, admin tools) |
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
