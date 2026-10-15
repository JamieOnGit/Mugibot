# Mugibot — complete setup guide

This takes you from nothing to a live Mugibot that members can join for
A$19.99/month. Follow the steps in order. Each step says what you'll have when
it's done.

- [0. What you need](#0-what-you-need)
- [1. Run it on your computer](#1-run-it-on-your-computer)
- [2. Try every store's flow with dummy products](#2-try-every-stores-flow-with-dummy-products)
- [3. Put it online (Fly.io, Sydney)](#3-put-it-online-flyio-sydney)
- [4. Discord: server, bot, roles, slash commands](#4-discord)
- [5. Whop: the A$19.99 membership](#5-whop)
- [6. Email (optional)](#6-email-optional)
- [7. Check everything from the admin console](#7-check-everything-from-the-admin-console)
- [8. Give members the extension](#8-give-members-the-extension)
- [9. First real test on Kmart](#9-first-real-test-on-kmart)
- [10. Before you launch — checklist](#10-before-you-launch)
- [Every setting](#every-setting)
- [Troubleshooting](#troubleshooting)

---

## 0. What you need

| Thing | Why | Cost |
|---|---|---|
| A computer with **Node.js 22.13+** ([nodejs.org](https://nodejs.org), choose "LTS") and **Git** | To run and test Mugibot | Free |
| **Chrome** (or Edge or Brave) | The extension | Free |
| A **Fly.io** account ([fly.io](https://fly.io)) | Hosting in Sydney | About US$5/month (one small machine + 1 GB volume) |
| A **Discord** account and a server you own | Members' server and pings | Free |
| A **Whop** account ([whop.com](https://whop.com)) with payouts set up | Memberships | Whop's fees per sale |
| Optional: a domain (e.g. `mugibot.com.au`) | A nicer address | ~A$20/year |
| Optional: a **Resend** account ([resend.com](https://resend.com)) | Password-reset and alert emails | Free tier |

You'll copy several IDs and secrets along the way. Keep them in a password
manager as you go. **Never** paste them into Discord, a GitHub issue, or the code.

---

## 1. Run it on your computer

Open **Terminal** (Mac) or **PowerShell** (Windows) and check Node first:

```bash
node -v
```

It must say `v22.13.0` or higher (v23 and v24 are fine). If not, or if the
command isn't found, install the **LTS** version from https://nodejs.org and
open a new Terminal window.

> **Pasting commands:** paste the lines in the boxes exactly as they are, one
> command per line. Explanations are always outside the boxes. (On a Mac,
> Terminal doesn't ignore `# notes` typed after a command, so they'd break it.)

```bash
git clone https://github.com/JamieOnGit/Mugibot.git
cd Mugibot
cp .env.example .env
```

(You don't need `npm install` to run Mugibot. The server has no dependencies.
It's only for running the tests.)

Download it **only once**. Running `git clone` again from inside the Mugibot
folder puts a second copy inside the first. To get updates later, use these
two lines instead:

```bash
cd ~/Mugibot
git pull
```

Open `.env` in a text editor (Mac: `open -e .env`, Windows: `notepad .env`) and set your admin username:

```
ADMIN_USERNAMES=jamie
```

Start it:

```bash
npm start
```

Leave that window open (Ctrl+C stops it). Go to http://localhost:8080 → **Join** → sign up as `jamie`. You're an admin
(top right: **Admin**), and admins always have full access.

**Done when:** you can sign in and see the Watchlist with the Kmart starter list.

---

## 2. Try every store's flow with dummy products

The dummy store is a set of fake shops shaped like Kmart, BIG W, EB Games and
JB Hi-Fi. Nothing is real and no order can be placed.

Stop `npm start` first (Ctrl+C), then:

```bash
npm run demo
```

This starts Mugibot on http://localhost:8080 and the dummy stores on
http://localhost:5055, and opens the dashboard. On a Mac you can instead
double-click `start-demo-mac.command` in the Mugibot folder (Windows:
`start-demo-windows.bat`).

1. **Install the extension.** Dashboard → **Extension** tab → **Download the
   extension** → unzip it somewhere you'll keep it. Open `chrome://extensions`,
   turn on **Developer mode** (top right), click **Load unpacked**, and choose
   the unzipped `mugibot-extension` folder. Reload the dashboard.
2. Press **Connect this browser**. The notice turns green: "✓ Extension connected".
3. **Checkout details** tab: fill in your name, email, mobile and address, then
   **Save delivery details**. Press **Open card settings**, save a test card
   (`4242 4242 4242 4242`, expiry `12/30`, CVV `123`) with a passphrase, then
   **Unlock card**.
4. **Watchlist** tab → **Add dummy-store test items**. You get two products from
   each dummy shop, e.g. "30th Celebration Ultra-Premium Collection (dummy
   kmart)". The sold-out ones show **Sold out** within a minute.
5. Open http://localhost:5055 (the control panel). Next to a sold-out dummy
   product, press **in_stock**. Within about a minute your dashboard shows a
   🟢 **In stock** ping, and so does Discord once it's set up.
6. Press **⚡ Buy** on that item (try quantity 2). A tab opens, and the
   Mugibot panel (top left) works through that shop's flow. It stops with a
   green banner: **"Ready — review everything and press 'Checkout securely'
   yourself."** The control panel's "Orders placed" stays at **0**.
7. Do the same for the BIG W, EB Games and JB Hi-Fi dummy items. Each follows
   its own steps (BIG W: dropdown quantity → View cart → Proceed to checkout →
   guest → Home delivery → address → card → stops at "Place order").

Want to see in-browser checks? In the control panel press **Refuse server
checks (like Kmart)**. The server's checks get "Blocked by site", and your
browser takes over checking your dummy SKUs (Extension tab → **Check my SKUs
now** to do it immediately).

**Done when:** ⚡ Buy reaches the final button on all four dummy shops.

---

## 3. Put it online (Fly.io, Sydney)

### 3a. Install Fly's command-line tool and log in

- Mac: `brew install flyctl`
- Windows (PowerShell): `iwr https://fly.io/install.ps1 -useb | iex`
- Linux: `curl -L https://fly.io/install.sh | sh`

```bash
fly auth login
```

Then add a payment card to your Fly account: https://fly.io/dashboard → **Billing**.
Fly won't start any machine until you do (the deploy fails with "We require
your billing information"). Mugibot's one small machine and 1 GB volume cost
about US$5 a month.

### 3b. Create the app, its storage and its secrets

Every `fly` command from here on reads `fly.toml`, so run them **inside the
Mugibot folder**. Go there first:

```bash
cd ~/Mugibot
```

Create the app. This guide uses the name `mugibot-live`, which is already set
in `fly.toml`:

```bash
fly apps create mugibot-live
```

(Fly names are unique across everyone. If yours has to be different, use it
everywhere this guide says `mugibot-live`, including the `app = ` line in `fly.toml`.)

Create the storage for the database. If Fly warns that a single volume has no
copy and asks whether to go on, type `y`:

```bash
fly volumes create mugibot_data --region syd --size 1
```

Make your encryption key. The 64 characters it prints are your
`DATA_ENCRYPTION_KEY`. **Save them in your password manager now.**

```bash
openssl rand -hex 32
```

Set the secrets. Replace `PASTE-KEY-HERE` with those 64 characters, and
`you@example.com` with the email members should contact for help:

```bash
fly secrets set DATA_ENCRYPTION_KEY=PASTE-KEY-HERE BASE_URL=https://mugibot-live.fly.dev ADMIN_USERNAMES=jamie SUPPORT_EMAIL=you@example.com PRICE_DISPLAY='A$19.99 / month'
```

Deploy (one machine, since the database is a single file). The first deploy
takes a few minutes:

```bash
fly deploy --ha=false
```

(No `openssl`? In Node: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.)

Open `https://mugibot-live.fly.dev`, sign up as `jamie`, and you're the admin.

> **Keep `DATA_ENCRYPTION_KEY` safe.** Every member's saved addresses are
> encrypted with keys protected by it. If it's lost or changed, those details
> can't be read any more (members would need to re-enter them).

### 3c. Your own domain (recommended, do it before members install the extension)

```bash
fly certs add app.yourdomain.com
```

Add the DNS records it prints at your domain registrar, then:

```bash
fly secrets set BASE_URL=https://app.yourdomain.com EXTRA_ORIGINS=https://mugibot-live.fly.dev
```

The address is built into the extension members download, so settle on it
before you hand out the extension. If you change it later, members need to
download the extension again.

**Done when:** your live address shows the Mugibot landing page and you can log
in as admin.

> **Render instead of Fly:** `render.yaml` is a Blueprint. In Render choose
> **New → Blueprint**, pick your repo, and fill in the variables marked
> "sync: false". It needs a paid instance for the disk. Use Singapore, the
> closest region to Australia.

Run **one** machine only. The database is a single file on the volume. Fly
snapshots volumes daily. For an extra backup, see [ADMIN.md](ADMIN.md#backups).

---

## 4. Discord

Follow **[DISCORD.md](DISCORD.md)**. In short, you'll:

1. Create the server's roles (`Member`, optional `Restock Pings`) and a private `#restocks` channel.
2. Create a Discord application. Copy its Application ID, Public Key and Client
   Secret, and add the redirect `https://<your address>/auth/discord/callback`.
3. Create its bot, copy the token, and invite it with **Manage Roles**.
4. Drag the bot's role above `Member`.
5. Copy the server, role and channel IDs.
6. Set the `DISCORD_…` secrets, set the Interactions Endpoint URL, and run the
   command registration.

```bash
fly secrets set DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… DISCORD_PUBLIC_KEY=… DISCORD_BOT_TOKEN=… \
  DISCORD_GUILD_ID=… DISCORD_MEMBER_ROLE_ID=… DISCORD_RESTOCK_CHANNEL_ID=… DISCORD_RESTOCK_ROLE_ID=…
fly ssh console -C "node /app/scripts/discord-commands.js"
```

**Done when:** Admin → **Setup check** → **Check the Discord bot** is all ✓, and
your dashboard's **Discord** tab → **Connect Discord** puts you in the server.

---

## 5. Whop

Follow **[WHOP.md](WHOP.md)**. In short, you'll:

1. Create the product "Mugibot Membership" with a **recurring A$19.99 every month** pricing option.
2. Copy its plan ID (`plan_…`) and product ID (`prod_…`).
3. Create an API key.
4. Create a webhook to `https://<your address>/api/whop/webhook`, and copy its secret (`ws_…`).

```bash
fly secrets set WHOP_API_KEY=… WHOP_PLAN_ID=plan_… WHOP_PRODUCT_ID=prod_… WHOP_WEBHOOK_SECRET=ws_…
```

**Done when:** a test account → **Membership** → **Become a member** opens Whop's
checkout, and after paying (use a 100%-off promo code for the test) the account
shows **Member** and the Discord role appears.

---

## 6. Email (optional)

Members don't need email: accounts are username + password, and password resets
go by Discord DM. Admins can also make a reset link. To send emails too:

1. Sign up at [resend.com](https://resend.com) and verify your domain (it gives you DNS records to add).
2. Create an API key.
3. Run:

```bash
fly secrets set RESEND_API_KEY=re_… EMAIL_FROM="Mugibot <alerts@yourdomain.com>"
```

---

## 7. Check everything from the admin console

Open `https://<your address>/admin`:

- **Overview → Still to set up** lists anything missing.
- **Setup check** shows every setting with ✓ / ✕ and the exact URLs to paste
  into Discord and Whop. **Check the Discord bot** tests the token, the server,
  the role order and the channel. **Post a test message** posts in `#restocks`.

---

## 8. Give members the extension

- **To start:** members download it from their dashboard (**Extension** tab).
  It's already set up for your address. They load it with Developer mode, as in
  step 2. Write this up in a pinned message in your Discord.
- **Chrome Web Store (recommended once you have members):**
  `BASE_URL=https://app.yourdomain.com npm run build:extension` makes
  `dist/mugibot-extension.zip`. Upload it in the
  [Chrome Web Store developer console](https://chrome.google.com/webstore/devconsole)
  (one-time US$5 fee). In the listing:
  - **Single purpose:** "Checkout assist and restock checks for the user's own Mugibot account."
  - **Permissions:** `storage` (the connection and the encrypted card), `alarms`
    (in-browser restock checks once a minute), the store sites (filling in
    checkout and checking the member's own SKUs), your server (the member's
    account).
  - **Privacy:** declare personal info (address) and financial info (card,
    stored on the device only).
  - Once approved: `fly secrets set CHROME_STORE_URL=<the listing URL>` and the
    dashboard shows an **Add to Chrome** button.

  Bump `version` in `extension/manifest.json` with every update. The dashboard
  tells members when their copy is out of date.

---

## 9. First real test on Kmart

Use a cheap, in-stock Kmart item:

1. Add its product link to your watchlist, set quantity 1.
2. Make sure the extension is connected, and your details and card are saved and unlocked.
3. Press **⚡ Buy**. It should go Add to bag → Checkout → details → delivery → payment.
4. **Stop at "Checkout securely".** Don't press it unless you actually want the item.

Do the same for BIG W, EB Games and JB Hi-Fi before you advertise them. Their
flows are beta until tested on the real site. If a step goes wrong, send the
flow as described in [RETAILER-FLOWS.md](RETAILER-FLOWS.md) and the flow file
gets fixed. Members get the fix automatically.

---

## 10. Before you launch

- [ ] Have a lawyer review `web/terms.html` and `web/privacy.html` and fill in the
      [bracketed] parts (business name, ABN, state, hosting region).
- [ ] Register for GST if your turnover will reach A$75,000 (Whop can collect tax; check its settings).
- [ ] Understand the risk: retailers' terms may prohibit automated tools. They can change their
      sites, block checks, or cancel orders. Never promise anyone they'll get stock.
- [ ] Real test run on each store you advertise, stopping at the final button.
- [ ] Back up `DATA_ENCRYPTION_KEY` and set up database backups ([ADMIN.md](ADMIN.md#backups)).
- [ ] Discord: `#restocks` and member channels visible to `Member` only; the bot's role above `Member`.
- [ ] Whop: webhook shows successful deliveries; a test purchase gave the role.
- [ ] Pin a "How to install the extension" message in Discord.

---

## Every setting

Set these with `fly secrets set NAME=value` (or in `.env` on your computer).

| Setting | Required | What it is |
|---|---|---|
| `BASE_URL` | yes | Your public address, `https://…`. Used in links, Discord buttons, Whop's checkout and the extension. |
| `DATA_ENCRYPTION_KEY` | yes (production) | 64 hex characters (`openssl rand -hex 32`). Back it up. |
| `ADMIN_USERNAMES` | yes | Comma-separated usernames that are admins. |
| `SUPPORT_EMAIL` | recommended | Shown in the footer and legal pages. |
| `PRICE_DISPLAY` | | Default `A$19.99 / month`. The price itself is set on Whop. |
| `TRIAL_DAYS` | | Free trial days for new accounts. Default `0` (no trial). |
| `SIGNUPS_OPEN` | | `0` closes sign-ups. |
| `EXTRA_ORIGINS` | | Other addresses of the same app (e.g. your fly.dev address). |
| `CHROME_STORE_URL` | | The extension's Chrome Web Store page, once published. |
| `WHOP_API_KEY` | yes (for memberships) | Whop Account API key. |
| `WHOP_PLAN_ID` | yes (for memberships) | `plan_…` of the A$19.99/month pricing option. |
| `WHOP_PRODUCT_ID` | recommended | `prod_…`. Accepts every plan of the product. |
| `WHOP_WEBHOOK_SECRET` | yes (for memberships) | `ws_…` from the webhook. |
| `WHOP_CHECKOUT_URL` | | Your product's Whop page, used only if `WHOP_API_KEY` isn't set. |
| `DISCORD_CLIENT_ID` | yes (for Discord) | Application ID. |
| `DISCORD_CLIENT_SECRET` | yes (for Discord) | OAuth2 client secret. |
| `DISCORD_PUBLIC_KEY` | for slash commands | From General Information. |
| `DISCORD_BOT_TOKEN` | yes (for Discord) | The bot's token. |
| `DISCORD_GUILD_ID` | yes (for Discord) | Your server's ID. |
| `DISCORD_MEMBER_ROLE_ID` | recommended | Role given to members, taken away when their membership ends. |
| `DISCORD_RESTOCK_CHANNEL_ID` | optional | Channel for announced restocks. |
| `DISCORD_RESTOCK_ROLE_ID` | optional | Role @mentioned in restock posts. |
| `DISCORD_INVITE_URL` | optional | Shown on members' Discord tab. |
| `DISCORD_KICK_ON_EXPIRE` | | `1` = remove people from the server when their membership ends. |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional | Email. |
| `MONITOR_URL_INTERVAL` | | Seconds between server checks of a page (default 60). |
| `MONITOR_HOST_GAP` | | Seconds between server requests to the same store (default 5). |
| `BROWSER_CHECK_INTERVAL` | | Seconds between a member's browser re-checking one of their SKUs (default 60). |
| `MAX_ITEMS`, `MAX_PROFILES`, `MAX_DEVICES` | | Per-member limits (50 SKUs, 5 addresses, 5 browsers). |
| `DEMO_STORE_URL` | testing only | The dummy store's address (set by `npm run demo`). |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Request blocked (cross-site)" | You opened the site at a different address from `BASE_URL`. Use the address in the yellow banner. |
| Extension says "Not connected" | Dashboard → Extension → **Connect this browser**. If you changed `BASE_URL`, download the extension again. |
| ⚡ Buy opens the product but nothing happens | Is the extension connected in **this** browser? Is the membership active? Is the store switched on (Admin → Stores & flows)? |
| Checkout stops early: "Stuck at …" | Something on the page needs you (e.g. a store login, a CAPTCHA). Finish it yourself. If it's every time, send the flow ([RETAILER-FLOWS.md](RETAILER-FLOWS.md)). |
| Card not filled in | Unlock it (extension icon → Unlock). CVV not saved → type it in. |
| SKU shows "Blocked by site" | The store refuses server checks. Members' browsers take over (Extension tab → In-browser checks). Admins can send manual restock pings. |
| Member paid on Whop but isn't a member here | Admin → Whop memberships (look for "not linked") → Members → **Link Whop** on their row. Or they paste their membership ID / license key on their Membership tab. |
| Member isn't in the Discord server | Their Discord tab → **Join the server**. Admin → Members → **Sync Discord** shows the exact error. Usually the bot's role is below `Member`. |
| No DM pings | Discord → Privacy Settings → allow DMs from server members (for your server). Their Discord tab shows the error. |
| Forgot password, no email | Admin → Members → **Reset link**, then send it to them. Or on the server: `fly ssh console -C "node /app/scripts/reset-link.js theirname"`. |
| Logs | `fly logs` |
