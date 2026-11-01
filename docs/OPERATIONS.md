# Operations: releases, health, rollback and restore

Mugibot runs as one Node process on one Fly machine (`mugibot-live`, Sydney), with its SQLite database on one volume
(`mugibot_data`, mounted at `/data`). A merge to `main` is tested in CI (the whole suite, browser tests included) and then
released by the `deploy` job in `.github/workflows/ci.yml`.

## What a release does (Mugibot 2.0)

1. **Rollback point.** Before deploying, CI snapshots the database volume (`flyctl volumes snapshots create`). If the
   snapshot can't be made, nothing is released.
2. **Deploy.** `flyctl deploy --remote-only --ha=false`. The old process gets `SIGTERM` and up to 30 s (`kill_timeout`)
   to finish what's going out (members' alerts, Auto-checkout runs) before it stops.
3. **Ready check.** CI then asks `https://mugibot-live.fly.dev/readyz` (retrying for about two minutes). It must answer
   200: the database reads and writes, the monitor has ticked in the last 30 s, the live sweeps are running, the event
   loop isn't stalled. If it doesn't, the job goes red with the rollback commands.

Database changes are migrations (`server/db.js`, `MIGRATIONS`), applied in order at start-up. They only add (columns,
tables, indexes); none rewrites or drops existing data. An older release can run against a newer database: it ignores
columns and tables it doesn't know.

## Health

- `GET /healthz`: the process answers (what Fly's load balancer checks).
- `GET /readyz`: really working (above). 200 or 503, with each check — never anything about members, keys or tokens.
- Admins: **Drops → Check log → 📈 Reliability & delivery** (`GET /api/admin/health`): each store's reliability score
  over the last hour, its circuit breaker, page-read and alert P95s, members' DM and Discord request P50/P95/P99, what
  Discord turned away and what was tried again, and each store's drop windows (estimates from the last 90 days).
- Logs: `flyctl logs -a mugibot-live`. Structured lines worth searching: `monitor.breaker` (a store's breaker opening
  or closing), `monitor.check_failed`, `[access]` (BIG W's budget), `[signins]`, `[unhandled]`.

## Roll back

A release that misbehaves — go back to the previous one first, investigate after:

```sh
flyctl releases -a mugibot-live              # the releases, newest first, with their images
flyctl deploy -a mugibot-live --image registry.fly.io/mugibot-live:<previous-tag> --ha=false
curl -fsS https://mugibot-live.fly.dev/readyz
```

The database stays as it is (migrations only add), so the previous release runs on it. Only restore the database (below)
if data itself went wrong.

## Restore the database

From a volume snapshot (the one CI made before the release, or Fly's daily one):

```sh
flyctl volumes list -a mugibot-live                         # the volume's id
flyctl volumes snapshots list <volume-id> -a mugibot-live   # pick the snapshot
flyctl volumes create mugibot_data --snapshot-id <snapshot-id> --region syd -a mugibot-live
# Then point the machine at the new volume (stop it, detach the old volume, attach the new one), or clone the machine
# with the new volume: flyctl machine clone <machine-id> --attach-volume <new-volume-id>:/data -a mugibot-live
```

Or from a `npm run backup` file (`VACUUM INTO` a copy on the same volume): stop the app, copy the backup over
`/data/mugibot.db` (and remove `/data/mugibot.db-wal` and `-shm`), start it again.

## Environment variables added in Mugibot 2.0

| Variable | Default | What it does |
|---|---|---|
| `MONITOR_MAX_IN_FLIGHT` | `12` | Server page reads at once across every store (each store in its own lane, at most 4 of them its own). |

Everything else in 2.0 needs no configuration.
