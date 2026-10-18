# Discord setup

Discord is where members get pinged and hang out. Mugibot's bot:

- **adds members to your server** with the `Member` role when they connect
  Discord and have an active membership, and **takes the role away** when the
  membership ends (or removes them from the server, if you choose)
- **DMs each member** their own restock pings, with a **⚡ Buy** button
- **posts restocks** of the SKUs admins announce in `#restocks`, pinging a role
- answers **slash commands**: `/watch`, `/watchlist`, `/buy`, `/unwatch`,
  `/status`, and `/restock` (admins only)

You need: a Discord server you own, and Mugibot's address (`BASE_URL`, e.g.
`https://mugibot.com`, or `https://mugibot-live.fly.dev` without a domain). Below, `<BASE_URL>` means that address.

---

## 1. Prepare your server

1. **Roles** (Server Settings → Roles → Create Role):
   - `Member`: the role members get. You don't need to give it any special permissions.
   - `Restock Pings` (optional): @mentioned in restock posts. Turn on **Allow
     anyone to @mention this role**, or the bot can't ping it.
2. **Channels:**
   - `#restocks`: where announced restocks are posted. In the channel's
     settings → Permissions: `@everyone` **View Channel ✕**, `Member` **View
     Channel ✓**, and the bot (added in step 3) **View Channel ✓, Send Messages
     ✓, Embed Links ✓**.
   - Make your other members-only channels the same way (`@everyone` ✕,
     `Member` ✓). Keep a public `#welcome` or `#how-to-join` channel if you
     like.
3. **Developer Mode** (so you can copy IDs): User Settings → Advanced → turn on
   **Developer Mode**.

---

## 2. Create the Discord application

1. Go to https://discord.com/developers/applications → **New Application** →
   name it "Mugibot" → Create.
2. **General Information** page:
   - **Application ID** → this is `DISCORD_CLIENT_ID`.
   - **Public Key** → this is `DISCORD_PUBLIC_KEY`.
   - **Interactions Endpoint URL**: leave it empty for now. You fill it in
     after the secrets are set (step 6).
   - Optional: upload the logo (`web/img/logo-512.png`) as the app's icon (it's also the bot's picture), and a description.
3. **OAuth2** page:
   - **Client Secret** → **Reset Secret** → copy. This is `DISCORD_CLIENT_SECRET`.
   - **Redirects** → **Add Redirect** → `<BASE_URL>/auth/discord/callback` → **Save Changes**.
     For testing on your computer, also add `http://localhost:8080/auth/discord/callback`.
4. **Bot** page:
   - **Reset Token** → copy. This is `DISCORD_BOT_TOKEN`. Discord shows it only once.
   - **Public Bot**: turn **off**, so only you can add it to servers. First go
     to the **Installation** page and set **Install Link** to **None** (Save
     Changes). Otherwise Discord refuses with "Private application cannot have
     a default authorization link".
   - **Privileged Gateway Intents**: leave all **off**. Mugibot doesn't need them.

---

## 3. Invite the bot to your server

1. **OAuth2** page → **OAuth2 URL Generator**:
   - Scopes: tick **bot** and **applications.commands**.
   - Bot permissions: tick **Create Instant Invite**, **Manage Roles**,
     **Manage Channels**, **View Channels**, **Send Messages** and **Embed
     Links**. Also tick **Kick Members** only if you'll set
     `DISCORD_KICK_ON_EXPIRE=1`. Don't tick Administrator; the bot doesn't need it.
   - Or skip the ticking: those six are the permissions integer **268454929**
     (**268454931** with Kick Members). Put it in this link, with your
     Application ID (General Information page):
     `https://discord.com/oauth2/authorize?client_id=<Application ID>&scope=bot%20applications.commands&permissions=268454929`
2. Copy the generated URL at the bottom (or the link above), open it, choose your
   server → **Authorize**. Opening it again later, with a new permissions
   integer, updates the bot's permissions the same way.
3. Discord gives the bot its own role, named after the app ("Mugibot"), with
   those permissions. Don't give the bot any other roles (not `Member`, not
   `Restock Pings`).
4. **Role order (important):** Server Settings → Roles → drag the bot's role
   (named "Mugibot") **above** `Member` (and above `Restock Pings`). A bot can
   only give and take roles that sit below its own.

Already invited the bot without some of these? Server Settings → Roles →
**Mugibot** → **Permissions**, and turn on **Create Invite**, **Manage Roles**,
**Manage Channels**, **View Channels**, **Send Messages** and **Embed Links**
(or open the link above again).

What each permission is for:

| Permission | Why |
|---|---|
| Create Invite | Discord requires it for a bot to add people to the server |
| Manage Roles | Give members the `Member` role, and take it away when their membership ends |
| Manage Channels | **Set up store channels** (Monitor → Settings) makes `kmart-pokemon`, `misc-retailers`… for you. Without it, make those channels yourself and press the button: it finds them by name |
| View Channels, Send Messages, Embed Links | Post restocks in `#restocks` and the alert channels |
| Kick Members (optional) | Only with `DISCORD_KICK_ON_EXPIRE=1`: remove people from the server when their membership ends |

---

## 4. Copy the IDs

With Developer Mode on:

| Right-click… | → **Copy … ID** | Setting |
|---|---|---|
| your server's icon | Copy Server ID | `DISCORD_GUILD_ID` |
| Server Settings → Roles → `Member` → `…` | Copy Role ID | `DISCORD_MEMBER_ROLE_ID` |
| Server Settings → Roles → `Restock Pings` → `…` | Copy Role ID | `DISCORD_RESTOCK_ROLE_ID` (optional) |
| the `#restocks` channel | Copy Channel ID | `DISCORD_RESTOCK_CHANNEL_ID` (optional) |

Optional: make a permanent invite link (`#welcome` → Invite People → Edit
invite link → Expire: Never) for `DISCORD_INVITE_URL`. Members see it on their
Discord tab. The bot adds members by itself, so this is just a convenience.

---

## 5. Set the secrets

Where each value comes from:

| Setting | Where |
|---|---|
| `DISCORD_CLIENT_ID` | Developer Portal → General Information → **Application ID** |
| `DISCORD_PUBLIC_KEY` | Developer Portal → General Information → **Public Key** |
| `DISCORD_CLIENT_SECRET` | Developer Portal → OAuth2 → **Reset Secret** (shown once) |
| `DISCORD_BOT_TOKEN` | Developer Portal → Bot → **Reset Token** (shown once) |
| `DISCORD_GUILD_ID` | Right-click your server's icon → **Copy Server ID** |
| `DISCORD_MEMBER_ROLE_ID` | Server Settings → Roles → right-click `Member` → **Copy Role ID** |
| `DISCORD_RESTOCK_ROLE_ID` | Server Settings → Roles → right-click `Restock Pings` → **Copy Role ID** |
| `DISCORD_RESTOCK_CHANNEL_ID` | Right-click `#restocks` → **Copy Channel ID** |

The client secret and bot token are passwords: never paste them into a chat,
Discord or GitHub. If one gets out, reset it and set the new one.

On Fly, each command is **one line**. Swap the CAPITALS for your values (in
Notes first, then paste the finished line into Terminal):

```bash
fly secrets set DISCORD_CLIENT_ID=APPLICATION_ID DISCORD_PUBLIC_KEY=PUBLIC_KEY DISCORD_GUILD_ID=SERVER_ID DISCORD_MEMBER_ROLE_ID=MEMBER_ROLE_ID DISCORD_RESTOCK_ROLE_ID=RESTOCK_ROLE_ID DISCORD_RESTOCK_CHANNEL_ID=RESTOCKS_CHANNEL_ID
```

```bash
fly secrets set DISCORD_CLIENT_SECRET=CLIENT_SECRET DISCORD_BOT_TOKEN=BOT_TOKEN
```

Each one restarts Mugibot, which takes about a minute.

(On your computer, put the same lines in `.env` and restart.)

---

## 6. Slash commands (and ⚡ Buy from a phone)

The same address handles slash commands and the **⚡ Buy** buttons on alerts and
DMs. With it set, ⚡ Buy works from a phone: Discord tells Mugibot who pressed
it, and their checkout browser (on their computer) checks out
(docs/AUTO-CHECKOUT.md, "⚡ Buy from your phone"). Without it, ⚡ Buy is a link
that opens the store in the browser it's pressed in.

1. Back in the Developer Portal → **General Information** → **Interactions
   Endpoint URL** → `<BASE_URL>/api/discord/interactions` → **Save Changes**.
   Discord checks the address straight away. If it says it couldn't verify,
   make sure `DISCORD_PUBLIC_KEY` is set and the app has redeployed.
2. Register the commands in your server: on your site, **Admin** → **Setup
   check** → **Register slash commands**. It says
   `Registered /watch, /unwatch, /watchlist, /buy, /status, /restock, /monitor, /restocks`.

(Or from the command line. On Fly: `fly ssh console -C "node /app/scripts/discord-commands.js"`.
On your computer, with the Discord settings in `.env`: `npm run discord:commands`.)

Press it again whenever you add a store, because the store list is part of the
commands. `/restock` is only shown to people with **Manage Server**, and
Mugibot also checks that they're an admin in Mugibot.

---

## 7. Test it

1. Admin console → **Setup check** → **Check the Discord bot**. Every line
   should be ✓. "Member role … is above the bot's own role" means step 3.4
   still needs doing. "Bot permissions: Missing …" lists what to turn on.
2. **Post a test message in the restock channel.** It appears in `#restocks`.
3. Your dashboard → **Discord** tab → **Connect Discord** → Authorize. You come
   back connected and (as an admin, or with an active membership) are added
   to the server with the `Member` role.
4. **Send me a test DM.** It arrives in your Discord DMs.
5. In any channel, type `/watchlist`. Only you see the reply.

---

## How members use it

1. Join Mugibot and start the membership (Whop).
2. Dashboard → **Discord** → **Connect Discord**. The bot adds them to the
   server with `Member`.
3. They get DMs like:

   > 🟢 **In stock: Day UPC**
   > Kmart · SKU 43818648 · $360.00
   > Seen by the Mugibot monitor. Press ⚡ Buy to go straight to checkout.
   > [⚡ Buy] [Open product] [Watchlist]

   **⚡ Buy** works wherever they press it, their phone included: their
   **checkout browser** (the computer with the extension) opens the store and
   checks out. With Auto-checkout on, it places the order within their limits;
   otherwise it fills checkout in and stops at the final button. Only they see
   Discord's reply, which follows it to "Order placed" or "Checkout ready".
   Nothing to sign in to on the phone (docs/AUTO-CHECKOUT.md, "⚡ Buy from your
   phone"). The same goes for **⚡ Buy with Mugibot** on the channel alerts.

   Without the interactions endpoint (step 6), ⚡ Buy is a link instead. It
   opens the store in the browser it's pressed in, and with the extension there
   it goes straight to checkout. The link is signed for that member and that
   SKU (it only works signed in as them) and goes straight through for 7 days;
   after that it opens the ⚡ Buy page. Emails and personal webhooks always
   carry the link.
4. Slash commands work in the server and in DMs with the bot.

If someone's membership ends, the bot takes the `Member` role away (within 10
minutes for trials ending, immediately for Whop cancellations). With
`DISCORD_KICK_ON_EXPIRE=1` they're removed from the server instead.

---

## Announced restocks (server channel)

Admins choose which SKUs get posted in `#restocks`. These are usually the hot
ones everyone wants. On your own watchlist, press **📣 Announce** on the SKU.
When it restocks, the bot posts:

> @Restock Pings
> 🟢 **In stock: 30th Celebration UPC**
> Kmart · SKU 43818648 · $360.00
> [⚡ Buy with Mugibot] [Open product]

**⚡ Buy with Mugibot** is one click for whoever presses it: straight to the store
with their own checkout and details, adding the SKU to their watchlist if it
wasn't there. The link is signed by Mugibot and goes straight through for 7
days; an older one (or one someone changed) opens the ⚡ Buy page first, where
they press ⚡ Buy once. A SKU is posted at most once every 10 minutes.

Seen something in stock yourself? `/restock store:Kmart sku:43818648 note:online only`,
or Admin → **SKUs & restock pings**, DMs everyone watching that SKU and posts in
the channel.

---

## Store channels

Monitor alerts (🆕 new drops, 🟢 restocks, 📉 price drops) can go to a channel
per store and game. Dashboard → **Monitor → Settings → Discord alert
channels** → **Set up store channels** makes them in one go:

| Channel | Gets |
|---|---|
| `kmart-pokemon`, `kmart-one-piece` | Kmart's Pokémon / One Piece alerts |
| `bigw-…`, `target-…`, `jbhifi-…`, `ebgames-…`, `zing-…`, `toysrus-…` | The same for BIG W, Target, JB Hi-Fi, EB Games, Zing and Toys"R"Us |
| `premium-bandai` | Everything from Premium Bandai |
| `pokemon-center` | Everything from Pokémon Center |
| `non-tcg-alerts` | What isn't trading cards, from every store and website: the admins' 🎯 drop watches (an Xbox at JB Hi-Fi, a figure at any shop — docs/MONITORING.md → Drop watches). Only there, not in the store's own channel |
| `misc-retailers` | Everything no other channel takes: other stores (Trainer Town, Amazon AU, The Games Cube, Gamerholic…) and other games (Gundam, Dragon Ball, Riftbound…) at the split stores |
| `virtual-queue-detection` | JB Hi-Fi's hCaptcha checkpoint and EB Games' and Pokémon Center's virtual queues going up and coming down (docs/MONITORING.md → Checkpoints and virtual queues), with **📥 Join the queue on my computer** on a queue's post |

- The bot uses channels with those names that are **already there** (it also
  finds `kmart-onepiece` and `misc-retailer`), and makes the rest in a
  **Mugibot alerts** category. To make channels it needs the **Manage
  Channels** permission (Server Settings → Roles → the bot's role); or make
  the channels yourself and press the button again.
- Each channel gets a rule (named after it, e.g. `#kmart-pokemon`) for new
  drops and restocks; tick 📉 price drops on a rule to add them. **Role to
  ping** (optional) pings that role in every channel. Pressing the button again
  is safe: it brings the same rules back in line and keeps the alert kinds
  you chose.
- **Remove my other rules** deletes the rules that aren't for these channels.
  Leave it unticked to keep them (an alert then also goes to those).
- `misc-retailers` is a **catch-all** rule: it only gets an alert no other rule
  took. Any rule can be a catch-all (tick **Catch-all** on it).
- `non-tcg-alerts` is made the same way, or on its own with **Make
  #non-tcg-alerts** on the Monitor page's 🎯 Drop watches tab. Made before it
  existed? Press either. Until there's one, drop watches' alerts go to
  `misc-retailers`. An admin can also pick, for each drop watch, the channel its
  drops and restocks go to and the role they ping (the drop watch's **Post in**
  and **Ping**, or **✎** on it): those go only there, instead of
  `non-tcg-alerts`. A member's own drop watch is never posted anywhere: they get
  a DM.
- `virtual-queue-detection` has no rule: no product alerts go there, only the
  checkpoints and queues. It pings the same role. Made before this channel
  existed? Press **Set up store channels** again. Until then, the bot finds a
  channel with that name, or makes one, the first time it has something to post.
- The bot needs **View Channel**, **Send Messages** and **Embed Links** in each
  channel (in the category's permissions, they apply to all of them).

---

## Alternative: Whop's own Discord app

Whop has a Discord app that can give roles to buyers by itself (Whop dashboard →
your product → add the Discord app/perk → connect your server → pick the
role). You can use it **instead of** Mugibot's role management. If you do,
leave `DISCORD_MEMBER_ROLE_ID` empty, so the two bots don't fight over the same
role. Members still need to **Connect Discord** in Mugibot to get DMs and use
slash commands.

The recommended setup is Mugibot managing the role. It knows about free access
and trials you give from the admin console, and it ties each Discord account to
exactly one Mugibot login.
