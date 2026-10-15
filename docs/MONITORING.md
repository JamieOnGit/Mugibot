# Mugibot Monitor: restock feed, price tracking, Discord alerts

The Monitor is Mugibot's shared product feed. It is in the style of a Discord
monitor service such as Zephyr Monitors. Admins pick the Pokémon and One Piece
products to watch. Mugibot checks them on a schedule and keeps their stock,
price, image and history. It posts rich alerts to your Discord channels when
something changes, and every alert has a ⚡ Buy button that runs Mugibot's
existing checkout.

It is built into Mugibot, not beside it. It uses the same server, database,
monitor loop, Discord bot, extension, checkout flows, login and dashboard.

---

## 1. Audit: what Mugibot already had

| Area | Where | What it does |
|---|---|---|
| Server | `server/app.js`, `server/http.js` | One Node 22 process: plain `node:http`, no framework, no runtime dependencies. Runs on Fly.io (one machine, SQLite on a volume). |
| Database | `server/db.js` (`MIGRATIONS` array), `server/repo.js` | `node:sqlite`. `items` is each member's own watchlist. `page_checks` is one shared row per store page. Also `events` (each member's feed) and `settings`. |
| Monitor loop | `server/monitor/index.js` | 1 s tick. Each page is checked once per interval however many people watch it. 5 s gap between requests to one store, at most 4 checks at once, exponential backoff, private-address protection, an honest `Mugibot/1.0` User-Agent. Shopify product JSON is read first where available. |
| Page reader | `server/monitor/extract.js` | Reads stock status, title, price and image from a page (JSON-LD, meta tags, microdata, buttons, text). Shared with the extension. |
| In-browser checks | `server/monitor/index.js` `browserDue/browserResults`, `extension/background.js` | Stores that refuse servers (Kmart) are checked by members' own browsers, for their own SKUs only. |
| Alerts | `server/notifier.js` | A member's feed, Discord DM, webhook and email. Plus `announce()`: a post in one restock channel for SKUs an admin marks 📣. |
| Discord | `server/discord.js`, `server/routes/discord.js` | One bot: OAuth, server roles, DMs, channel posts, signed slash commands `/watch /unwatch /watchlist /buy /status /restock`. |
| Checkout | `extension/*`, `server/retailers/*.js` | ⚡ Buy codes, signed per member, item and quantity. Each store has its own checkout flow, and the extension stops at the final button. The `/buy?store&sku` page turns a channel post into a ⚡ Buy for whoever presses it. |
| Stores | `server/retailers/*.js` | One file per store: Kmart (verified), BIG W, EB Games, JB Hi-Fi (beta), Target, Zing, Toys"R"Us, Amazon AU (draft). |
| Dashboard | `web/app.html`, `web/js/app.js`, `web/css/site.css` | Vanilla JS, a tab per section, live updates over Server-Sent Events, light and dark themes. Admin console at `/admin`. |

What was missing:
- a shared product catalogue with images
- price change detection and price history
- a check log
- monitoring health
- alert routing to several channels by category, store or kind
- slash commands to manage monitors
- a monitor dashboard

## 2. How the brief maps onto Mugibot

| Brief | Built as | Reused |
|---|---|---|
| Product monitoring, restock / sold out / price / availability | `products` (catalogue) + `monitors` tables. `server/monitor/feed.js` turns each check into status and price changes. | The monitor loop, shared `page_checks`, `extract.js`, backoff, store gaps, admin store switches |
| Pokémon and One Piece | `category` on each product (`pokemon`, `onepiece`, `other`), guessed from the name, editable | — |
| Images, prices, status, URLs | Saved on each product. Images come from the page (JSON-LD or `og:image`) or Shopify JSON. | `extract.js` (it already read the image; it's now kept) |
| Configurable intervals | Per monitor (`interval_seconds`), never below `MONITOR_MIN_INTERVAL` | Store gap and backoff still apply |
| No duplicate alerts | A per-product, per-kind cooldown kept in the database (survives restarts). Alerts only fire on confirmed changes. | Replaces the old in-memory 10-minute announce rule |
| Price history, logs, status | `price_history`, `check_log`, `feed_alerts` | — |
| Rich Discord embeds | Product image, store, price (and the old price), status, SKU, category, time; buttons ⚡ Buy, Open product, Add to cart (where the store supports a cart link) | `notifier.message()`, `discord.post()` |
| Alert channels and rules | `alert_routes`: a channel, optional role ping, categories, stores, kinds, keywords | `DISCORD_RESTOCK_CHANNEL_ID` / `_ROLE_ID` stay the default route |
| Slash commands | `/monitor add · list · pause · resume · remove · status` (admins), `/restocks` (members) | The same bot, the same signed interactions endpoint, the same single registration (Admin → Register slash commands) |
| Checkout from alerts | ⚡ Buy → `/buy?store&sku` → the member's own ⚡ Buy code → the extension's store flow | All existing checkout code; nothing about checkout changed |
| Store add-to-cart shortcuts | Shopify cart links (`/cart/<variant>:1`) and Amazon's add-to-cart link, where the store supports them | Retailer files gain an optional `cartUrl` |
| Dashboard | A new **Monitor** tab: live restock feed, health cards, searchable and filterable products, product page with price chart and history; admin controls inline. Dark theme by default, with a ☀/☾ switch. | Login, permissions, tabs, live updates, styles |
| Modular stores | Unchanged: one file per store. Monitors work on any store Mugibot knows. | `server/retailers/` |
| Confirmed vs unknown | A product shows **confirmed** only when its last check succeeded. Blocked, error and unknown are shown as such and never alert. | Status rules in `monitor/status.js` |
| Health, logs | Admin health per store (checks, success rate, blocked, errors, response time, last success), the monitor loop's heartbeat, a searchable check log | — |

## 3. Design

```
                       ┌───────────── page_checks (one row per store page) ─────────────┐
 members' watchlists ──┤                                                                 ├── Monitor.tick (1 s)
 (items)               │                                                                 │    store gap · backoff · ≤4 at once
 admin monitors ───────┘                                                                 │
 (monitors → products)                                                                   ▼
                                                                         read page / Shopify JSON
                                                                                 │
                    ┌────────────────────────────────────────────────────────────┴──────────┐
                    ▼                                                                       ▼
        items: each member's own status                                  products: catalogue status/price/image
        → DM / webhook / email (unchanged)                               → check_log, price_history
                                                                         → Feed.alert (cooldown, rules)
                                                                             → feed_alerts (history)
                                                                             → Discord channels (alert_routes)
                                                                             → open dashboards (live)
```

- **One check, many uses.** A product that is both a monitor and on members'
  watchlists is still checked once per interval.
- **Stores that refuse servers** (Kmart): admins' own browsers (with the
  extension) check the monitors at those stores. Members' browsers only ever
  check their own SKUs. So only Mugibot's server and admins can change the
  shared feed: a member can't post a fake restock to everyone.
- **Checkout is separate from monitoring.** Checkout runs in each member's
  browser. The server only hands out ⚡ Buy codes and delivery details, which
  are quick database reads. Monitoring is limited to 4 checks at a time with
  timeouts, so it can't hold those up.
- **Alerts fire only on confirmed changes:**
  - not orderable → in stock or pre-order: `restock`
  - not listed → listed: `listed`
  - orderable → sold out: `sold_out`
  - the price moved by at least `MONITOR_PRICE_CHANGE_PERCENT`: `price_drop` or `price_rise`

  Blocked or failed checks keep the last known status and never alert. Each
  product and kind has a cooldown (`MONITOR_ALERT_COOLDOWN`), and an admin's
  manual `/restock` bypasses it.

## 4. Risks and limitations

- **Kmart and other stores that refuse servers** can only be checked from
  admins' browsers. If no admin browser is open, those monitors show *Blocked*
  or *Waiting* and don't alert. Admins can still send a manual `/restock`.
- **Fair use.** Mugibot never disguises its requests, never solves CAPTCHAs or
  skips queues, and never presses the final buy button. That is the same as
  the rest of Mugibot. Some Discord monitor services are tied to auto-checkout
  bots; Mugibot deliberately isn't.
- **Add-to-cart links** exist only where the store officially supports them
  (Shopify cart links, Amazon's add-to-cart link). Everywhere else, ⚡ Buy uses
  the extension's store flow.
- **One machine.** SQLite on one Fly machine handles thousands of products.
  Very large catalogues would move to Postgres and a separate monitor worker.
  The monitor is already its own module (`server/monitor/`), so that's a
  contained change.
- **ZephyMonitor itself** wasn't available to inspect (its site refuses
  automated visits). The feed, embeds and dashboard follow the usual pattern
  for Discord monitor services instead: an image thumbnail, store, price,
  stock, time, quick links, and channels per category.

## 5. Setting it up

1. Deploy as usual. Merging into `main` deploys it, and the database upgrades
   itself.
2. Discord: make channels like `#pokemon-restocks` and `#onepiece-restocks`.
   Give the bot **View Channel, Send Messages, Embed Links** in each (as for
   `#restocks`, see [DISCORD.md](DISCORD.md)).
3. Admin → Setup check → **Register slash commands**. This adds `/monitor` and
   `/restocks`.
4. Dashboard → **Monitor** → **Alert channels**: add a rule per channel. Paste
   the channel ID, and optionally a role to ping, the categories, the stores,
   and which kinds (restock, listed, sold out, price drop, price rise). With
   no rules, alerts go to `DISCORD_RESTOCK_CHANNEL_ID` as before (restocks and
   listings).
5. Add monitors: Dashboard → **Monitor** → **Add monitor** (a product link, or
   a store and SKU), or in Discord: `/monitor add link:<product link> category:Pokémon`.

### Settings (environment variables, all optional)

| Setting | Default | What it does |
|---|---|---|
| `MONITOR_URL_INTERVAL` | 60 | Default seconds between checks of a page |
| `MONITOR_MIN_INTERVAL` | 20 | The shortest interval a monitor may ask for |
| `MONITOR_HOST_GAP` | 5 | Seconds between requests to the same store |
| `MONITOR_ALERT_COOLDOWN` | 600 | Seconds before the same product can alert the same kind again |
| `MONITOR_PRICE_CHANGE_PERCENT` | 1 | The smallest price change that counts |
| `MONITOR_LOG_DAYS` | 7 | How long the check log is kept |

## 6. Running it day to day

- **Monitor tab:**
  - the live restock feed
  - health cards: active monitors, restocks and price changes in 24 h, checks OK in the last hour
  - all products, searchable and filterable by category, store and status
  - click a product for its price chart, alert history and (admins) check log
- **Admins:** add, edit (category, interval, which alerts), pause, resume,
  check now, and remove; alert channels; health per store.
- **Discord:**
  - `/monitor list category:One Piece`
  - `/monitor pause target:<SKU or link>`
  - `/monitor status`
  - `/restocks` (members: the latest alerts)

## 7. Troubleshooting

| You see | Do this |
|---|---|
| A store shows **Blocked** in Health | The store is refusing the server. Admin → Stores & flows → switch **Server checks** off for it, and keep an admin browser with the extension open. Don't shorten the interval: that makes it worse. |
| Alerts in the dashboard but not in Discord | Admin → Setup check → **Check the Discord bot**, then **Post a test message**. Check the rule's channel ID and that the bot can post there. |
| The same product alerted twice | Different kinds (e.g. a restock, then a price drop) each alert once. The same kind repeats only after the cooldown. |
| A product stays **Waiting** | Its first check hasn't happened yet: there's a queue per store, one request every `MONITOR_HOST_GAP` seconds. Press **Check now**. |
| No image | The store page has no product image data. The alert still works. |
