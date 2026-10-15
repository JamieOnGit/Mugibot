# Discord setup

Discord is where members get pinged and hang out. Mugibot's bot:

- **adds members to your server** with the `Member` role when they connect
  Discord and have an active membership, and **takes the role away** when the
  membership ends (or removes them from the server, if you choose)
- **DMs each member** their own restock pings, with a **⚡ Buy ×N** button
- **posts restocks** of the SKUs admins announce in `#restocks`, pinging a role
- answers **slash commands**: `/watch`, `/watchlist`, `/buy`, `/unwatch`,
  `/status`, and `/restock` (admins only)

You need: a Discord server you own, and Mugibot's address (`BASE_URL`, e.g.
`https://app.yourdomain.com`). Below, `<BASE_URL>` means that address.

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
   - Optional: upload the icon (`web/img/icon-192.png`) and a description.
3. **OAuth2** page:
   - **Client Secret** → **Reset Secret** → copy. This is `DISCORD_CLIENT_SECRET`.
   - **Redirects** → **Add Redirect** → `<BASE_URL>/auth/discord/callback` → **Save Changes**.
     For testing on your computer, also add `http://localhost:8080/auth/discord/callback`.
4. **Bot** page:
   - **Reset Token** → copy. This is `DISCORD_BOT_TOKEN`. Discord shows it only once.
   - **Public Bot**: turn **off**, so only you can add it to servers.
   - **Privileged Gateway Intents**: leave all **off**. Mugibot doesn't need them.

---

## 3. Invite the bot to your server

1. **OAuth2** page → **OAuth2 URL Generator**:
   - Scopes: tick **bot** and **applications.commands**.
   - Bot permissions: tick **Manage Roles**, **View Channels**, **Send
     Messages**, **Embed Links**. Also tick **Kick Members** only if you'll
     set `DISCORD_KICK_ON_EXPIRE=1`.
2. Copy the generated URL at the bottom, open it, choose your server → **Authorize**.
3. **Role order (important):** Server Settings → Roles → drag the bot's role
   (named "Mugibot") **above** `Member` (and above `Restock Pings`). A bot can
   only give and take roles that sit below its own.

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

On Fly.io:

```bash
fly secrets set \
  DISCORD_CLIENT_ID=<Application ID> \
  DISCORD_CLIENT_SECRET=<Client Secret> \
  DISCORD_PUBLIC_KEY=<Public Key> \
  DISCORD_BOT_TOKEN=<Bot token> \
  DISCORD_GUILD_ID=<Server ID> \
  DISCORD_MEMBER_ROLE_ID=<Member role ID> \
  DISCORD_RESTOCK_CHANNEL_ID=<#restocks channel ID> \
  DISCORD_RESTOCK_ROLE_ID=<Restock Pings role ID>
```

(On your computer, put the same lines in `.env` and restart.)

---

## 6. Slash commands

1. Back in the Developer Portal → **General Information** → **Interactions
   Endpoint URL** → `<BASE_URL>/api/discord/interactions` → **Save Changes**.
   Discord checks the address straight away. If it says it couldn't verify,
   make sure `DISCORD_PUBLIC_KEY` is set and the app has redeployed.
2. Register the commands in your server:

```bash
fly ssh console -C "node /app/scripts/discord-commands.js"      # on Fly
npm run discord:commands                                          # on your computer
```

It prints `Registered 6 commands in your server: /watch, /unwatch, /watchlist, /buy, /status, /restock`.
Run it again whenever you add a store, because the store list is part of the
commands. `/restock` is only shown to people with **Manage Server**, and
Mugibot also checks that they're an admin in Mugibot.

---

## 7. Test it

1. Admin console → **Setup check** → **Check the Discord bot**. Every line
   should be ✓. "Member role … is above the bot's own role" means step 3.3
   still needs doing.
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
   > Seen by the Mugibot monitor. Quantity set to 2 — press ⚡ Buy to go straight to checkout.
   > [⚡ Buy ×2] [Open product] [Watchlist]

   **⚡ Buy ×2** opens the product in their browser. With the extension
   connected, it goes all the way to the final button. The link is signed for
   that member, that SKU and that quantity, and it works for 30 minutes.
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

**⚡ Buy with Mugibot** opens a page on your site where each member presses ⚡ Buy
once. It uses their own quantity and details, and adds the SKU to their
watchlist if it wasn't there. A SKU is posted at most once every 10 minutes.

Seen something in stock yourself? `/restock store:Kmart sku:43818648 note:online only`,
or Admin → **SKUs & restock pings**, DMs everyone watching that SKU and posts in
the channel.

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
