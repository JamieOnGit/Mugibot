# Running Mugibot: the admin console

Open `/admin` (or **Admin** at the top of the dashboard). Admins are the
usernames in `ADMIN_USERNAMES`, plus anyone you make admin.

Admins see accounts, memberships, Discord connections and totals. They never
see members' addresses, cards, watchlists or activity. Every change is written
to the audit log.

## Tabs

**Overview.** Accounts, paying members, failed payments, free access, sign-ups
this week, Discord connections, SKUs watched, and memberships nobody has linked
yet. Also lists anything still to set up.

**Members.** Search by username, email, Discord name or `mem_…`, and filter by plan. On each row:

| Action | What it does |
|---|---|
| Plan dropdown | `active` / `past_due` / `canceled` follow Whop by themselves. `comped` = free access (a lapsed Whop membership doesn't remove it). `none` = no access. |
| + Trial | Gives (or extends) a free trial by N days. |
| Suspend | Blocks login, signs them out everywhere, removes the Discord role. |
| Make admin / Remove admin | |
| Reset link | Makes a one-time password-reset link (1 hour) for you to send them. It's also sent to their email / Discord if they have one. |
| Sync Discord | Re-applies their server access now, and shows Discord's exact error if it fails. |
| Link Whop | Links a Whop membership (`mem_…` or license key) to this account. |
| Refresh Whop | Re-reads their membership from Whop. |
| Sign out | Ends their sessions and disconnects their extensions. |
| Delete | Deletes the account and all its data, cancels their Whop membership and removes their Discord role. You type their username to confirm. |

**SKUs & restock pings.**
- **What members are watching:** every SKU, how many members watch it, their
  statuses, and what the server check last saw. Totals only, not who.
- **Send a restock ping:** pick the store, type the SKU and an optional note
  ("online only, limit 2"). Everyone with an active membership watching that
  SKU gets a DM with their own ⚡ Buy button, and it's posted in `#restocks`.
  Use this when you see stock with your own eyes, or for stores that block checks.
- **📣 Announce (on your own watchlist):** restocks of that SKU are posted in
  `#restocks` automatically, with the restock role pinged.

**Blacklist.** Products that should never ping: a store and a SKU (or a
product link) for one product, only a store for everything there, or only a
SKU for that SKU at every store. Anything on it never alerts (dashboard or
Discord), isn't tracked by the live sweeps, stays off the Monitor lists, and
any monitor on it is removed. **Remove** takes it off again. Admins also have
**🚫 Blacklist** on each product's page on the Monitor tab. See
[MONITORING.md](MONITORING.md#the-blacklist).

**Stores & flows.** Each store, its flow status (verified / beta / draft) and three switches:
- **On**: off hides the store from members and stops its checks and flows.
- **Server checks**: switch off for stores that block servers. Members'
  browsers check instead.
- **Browser checks**: members' own browsers checking their SKUs at that store.

**View flow** shows the flow the extension follows. To change a flow, see
[RETAILER-FLOWS.md](RETAILER-FLOWS.md).

**Setup check.** Every setting with ✓ / ✕, the exact URLs for Discord and
Whop, the last Whop webhook received, **Check the Discord bot** (token, server,
role order, channel), **Post a test message** and **Register slash commands**
(press it again after adding a store).

**Whop memberships.** Every membership Whop has reported, and which account
it belongs to. Tick "only ones nobody has linked yet" to find people who paid
but haven't connected their account.

**Audit log.** Who changed what, including monitors added, paused, resumed and removed, and blacklist entries added and removed.

## The Monitor feed

The live sweeps (keywords, how often, where each store is searched from,
filters, each store's health, **Sweep now**), monitors, Discord alert
channels, page-check health and the check log are on the dashboard's
**Monitor** tab. Admins see the controls there, and members see the feed. In
Discord: `/monitor add · list · pause · resume · remove · status`.

BIG W, EB Games, Pokémon Center and Premium Bandai refuse Mugibot's server, so
they're searched from an admin's browser: keep Chrome open with the extension
(1.8.0 or later for Pokémon Center and Premium Bandai) connected to an admin
account. (Zing's website now sends everyone to EB Games, so Zing's sweeps are
off.) Kmart, Target, JB Hi-Fi, Toys"R"Us, Trainer Town, Amazon AU, The Games
Cube and Gamerholic are searched from the server. See [MONITORING.md](MONITORING.md).

## Command line (on the server)

On Fly.io, run each through `fly ssh console -C "…"`, e.g.
`fly ssh console -C "node /app/scripts/make-admin.js theirname"`.

| Command | What it does |
|---|---|
| `node /app/scripts/make-admin.js theirname` | Make someone admin |
| `node /app/scripts/reset-link.js theirname` | Print a password-reset link |
| `node /app/scripts/discord-commands.js` | (Re)register slash commands |
| `node /app/scripts/backup.js /data/mugibot.db` | Make a backup copy of the database |

## Backups

Fly snapshots the volume daily. For your own copy:

```bash
fly ssh console -C "node /app/scripts/backup.js /data/mugibot.db"
fly ssh sftp get /data/backups/<the file it printed>
```

Keep backups together with `DATA_ENCRYPTION_KEY`. Without the key, the
encrypted delivery details in a backup can't be read.

## Limits and scaling

- Per member: 50 SKUs, 5 addresses, 5 browsers (`MAX_ITEMS`, `MAX_PROFILES`, `MAX_DEVICES`).
- The server checks each page once per `MONITOR_URL_INTERVAL` (60 s) however
  many members watch it, with `MONITOR_HOST_GAP` (5 s) between requests to the
  same store. With many SKUs at one store, a full round takes longer (60 SKUs ×
  5 s = 5 minutes). That's on purpose, to be gentle on the store. Members'
  browsers check their own SKUs every `BROWSER_CHECK_INTERVAL` (60 s).
- One small Fly machine handles thousands of members. Before running several
  machines, the database would move to Postgres and the rate limits and live
  updates to Redis.
- Logs: `fly logs`.
