# Mugibot

SKU restock monitor + Discord pings + one-button checkout, for a members-only
community. Built on TCGCopBot's working Kmart flow.

- **Watch SKUs.** Each member has their own watchlist. Add a product link, or a
  store and SKU, even before the product is listed. Mugibot checks every SKU
  about once a minute and notices when it goes from **sold out → in stock**,
  when **pre-orders open**, and when a new SKU is **first listed**.
- **Get pinged on Discord.** The Mugibot bot DMs the member with a **⚡ Buy ×2**
  button. Admins can also announce restocks in a server channel with a role
  ping, or send a manual restock ping to everyone watching a SKU.
- **Press one button.** ⚡ Buy, from the dashboard or the Discord ping, opens the
  product. The browser extension then follows **that store's own checkout
  flow**: quantity, add to bag, checkout, delivery details, card. It **stops at
  the store's final button** ("Checkout securely", "Place order") for the
  member to press.
- **Every store has its own flow.** Kmart is verified. BIG W, EB Games and
  JB Hi-Fi are beta (tested on dummy copies of those stores). Target, Zing,
  Toys"R"Us and Amazon are drafts. Flows live on the server, so fixing one
  reaches everyone without reinstalling the extension. See
  [docs/RETAILER-FLOWS.md](docs/RETAILER-FLOWS.md).
- **Memberships on Whop (A$19.99/month).** Members pay through Whop, and their
  account switches on automatically. Members who connect Discord are added to
  the private server with the members' role, and lose the role when their
  membership ends.
- **Accounts are a username and a password.** Each account has its own
  watchlist, delivery addresses (several if wanted), card (kept in that
  member's browser), alert settings and activity.
- **Monitor feed** ([docs/MONITORING.md](docs/MONITORING.md)). Admins pick the
  Pokémon and One Piece products to watch, and Mugibot posts their restocks, new
  listings and price changes to your Discord channels: the product image,
  store, price, stock and a ⚡ Buy button. Each channel gets what its rule asks
  for (by category, store, kind or keyword). The dashboard's **Monitor** tab
  shows the live feed, health, searchable products and each product's price
  history. Manage it from the dashboard or with `/monitor` in Discord.
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
| Run the community day to day (admin console) | [docs/ADMIN.md](docs/ADMIN.md) |
| Set up the Monitor feed: products, alert channels, schedules | [docs/MONITORING.md](docs/MONITORING.md) |

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
2. **Extension** tab → **Download the extension** → unzip it → open
   `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose
   the unzipped folder. Reload the dashboard and press **Connect this browser**.
3. **Checkout details** tab: fill in your name and address. Then press **Add your
   card** and save a test card, e.g. `4242 4242 4242 4242`, `12/30`, `123`. It
   stays ready for every ⚡ Buy, even after you restart the browser.
4. **Watchlist** tab → **Add dummy-store test items**.
5. Open the dummy store's control panel (http://localhost:5055), press
   **in_stock** on a sold-out product, and watch your watchlist ping. Press
   **⚡ Buy** on any dummy item and watch the extension go all the way to the
   final button, using that shop's own flow. (Nothing is real; no order is ever
   placed.)

Discord and Whop are optional for this. Add them later with the guides.

## How the monitor works (and staying unblocked)

- **Server checks.** Mugibot's server checks each product page once per
  interval, however many members watch it. Requests say who they are
  (`Mugibot/1.0`) and keep a gap between requests to the same store.
- **In-browser checks.** Some stores, Kmart included, refuse requests from
  servers. For those, each member's own browser, with the extension, re-checks
  **that member's own SKUs** about once a minute, just like refreshing the page.
  The results only ever update that member's own watchlist. Members can switch
  this off on the Extension tab.
- **Not listed yet.** A SKU without a product link is looked for on the store's
  search page. When the page goes up, members get a "Listed" ping.
- **Never evades bot protection.** If a store shows a bot check, Mugibot backs
  off and marks it "Blocked by site". It never solves CAPTCHAs, skips queues or
  disguises traffic. Admins can always send a manual restock ping.

## Fair play (same guardrails as TCGBot/TCGCopBot)

- The member always presses the final purchase button. Mugibot never places an order.
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
| **Payment card** | **Only in the member's browser extension**, encrypted with a key that only that browser's extension has | The member. It's never sent to the server. |
| Membership payments | Whop | The member; you, on Whop |

Card numbers are deliberately not stored on the server. Keeping them there would
make you responsible for PCI-DSS card security, and CVVs may never be stored
that way. Each member's card stays in their own browser, encrypted and tied to
their account, and is filled in at every store's checkout.

## Tests

`npm install` fetches Playwright (for the browser tests), then `npm test` runs
the 110 tests in about two minutes:

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
- **Monitor feed** (dummy stores, fake Discord): name, image, price and stock
  from the first check without an alert; restock, price drop and rise alerts
  once per cooldown; alert rules by category, store, kind and keyword; price
  history, check log and health; pause, resume and intervals; Shopify cart
  links; blocked stores keep their last status; admins' browsers for stores
  that refuse servers; `/monitor` and `/restocks`.
- **The real extension in Chromium:** Kmart (verified), BIG W, EB Games and
  JB Hi-Fi flows each stop at their final button with nothing pressed, plus the
  card saved without a passphrase and still ready after the browser restarts,
  a card from an older version moving over, the card in a payment frame, card
  boxes in separate frames that only take real typing or key presses (like
  Adyen's), and a clear message when the card can't go in, the Discord ⚡ Buy
  button, in-browser checks, and two accounts in one browser.
- **Website in a browser:** every dashboard and admin tab, including the
  Monitor tab (live alerts, product page with price chart, alert rules, light
  and dark themes), phone-sized screens, no JavaScript errors.

## Layout

```
server/
  app.js            routing and security checks      repo.js     all per-member data access
  db.js             SQLite schema                    crypto.js   passwords, tokens, encryption, signed links
  retailers/        one file per store, with its checkout flow (kmart.js, bigw.js, …)
  monitor/          SKU monitor (server checks, in-browser check results), feed.js (the Monitor feed's alerts)
  catalog.js        the Monitor's products, monitors, price history, check log, alert rules
  discord.js        Discord OAuth, server roles, DMs, channel posts
  whop.js           Whop checkout links, webhooks, membership sync
  notifier.js       a member's pings: activity feed, Discord DM, webhook, email
  routes/           auth, user, ext (extension API), membership, discord (+ slash commands), monitor, admin, web
web/                landing, sign-in, dashboard, ⚡ Buy page, admin console, terms, privacy
extension/          the browser extension (built per server by server/extension.js)
devtools/           the dummy stores (Kmart-, BIG W-, EB Games-, JB Hi-Fi-style)
scripts/            demo, mockstore, discord-commands, make-admin, reset-link, backup, build-extension
docs/               setup guides
test/               node:test + Playwright
```
