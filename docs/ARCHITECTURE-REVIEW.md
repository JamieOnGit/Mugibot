# Mugibot 2.0 — technical assessment (November 2026)

This is the Phase One review behind the Mugibot 2.0 work: what the platform does today, what's slow or fragile, with
evidence, and what was changed and why. Findings are marked **confirmed** (the code path was read end to end, and
where noted reproduced by a test or simulation) or **suspected**. File references are to the code as it was reviewed
(`main` at `bd6a0a0` plus the BIG W budget, JamieOnGit/Mugibot#55).

## 1. What Mugibot is today, and what to keep

Mugibot is one Node 22 process (no framework, `node:sqlite` in WAL mode, ~37k lines), deployed to a single Fly machine
in Sydney with one volume. It already does a great deal right, and most of it is kept as it is:

| Area | What works, and stays |
|---|---|
| Shared monitoring | One request per product page however many people watch it (`page_checks`, one row per URL); one search per store and keyword for everyone (`sweep_terms`). Popularity never multiplies store traffic. |
| Discovery | Per-store keyword sweeps every few seconds, each store on its own loop; Shopify stores' newest-products list and whole collections; later result pages via the page's own "Next"; drop watches (any page, any key phrase); VIP watches; Kmart through its search provider. |
| Stock taxonomy | `in_stock`, `preorder`, `coming_soon`, `in_store` (Kmart's "In store only"), `out_of_stock`, `not_listed`, `not_found`, `blocked`, `error`, `unknown` — and a failed or refused read never counts as a stock change. |
| Accuracy rules | A sweep's fresh reading outranks a slower page check (no flip-flopping); first sweep of a search only sets the scene; once-a-day restocks with "waves"; per (product, kind) cooldown kept in the database; sightings: what each watch saw itself decides Auto-checkout. |
| Retailer access | Honest User-Agent, per-host gaps, backoff on refusal, Retry-After honoured, virtual queues and checkpoints waited in and never refreshed, bot checks never answered, stores that refuse servers read from members' own browsers at a gentle pace (BIG W within one budget per browser since #55). |
| Checkout | Auto-checkout runs created before anyone's DM; the run reaches the browser by long-poll in ~0.1–0.4 s; one-time codes in the URL fragment; card vault in the extension. |
| Discord | Channel posts on a priority lane ahead of DMs; Discord's 50/s limit and 429s respected; member DMs in ten lanes, sent while monitoring carries on (`deliver`). |

So this is not a rewrite. The gains are in the places below.

## 2. Findings

### 2.1 Monitoring engine (server page checks) — the biggest latency risk

1. **One store can starve every other store's page checks.** *Confirmed and reproduced.* `Monitor.tick`
   (`server/monitor/index.js:167-189`) takes the 50 oldest due pages; a page skipped for its host's gap or for the global
   cap of 4 checks keeps its old `next_check_at`, so it stays at the head of the queue. With more than 50 overdue pages at
   one store, no other store's pages are ever selected. In a fake-clock simulation of the real `tick`: 80 pages on one
   host left a second host with 15 of 50 expected checks in 10 minutes; 300 pages left it with **zero**.
2. **One global pool of 4 checks for every store.** *Confirmed.* A slow store (15 s timeouts) holds up to 3 of the 4
   slots (one start per 5 s gap), leaving one slot for the rest of the platform. The task "do not allow one problematic
   retailer to affect the performance of the entire monitoring infrastructure" is not met today.
3. **A page check holds its slot while Discord posts go out.** *Confirmed.* `checkPage` → `feed.applyCheck` →
   `transitions` → `alert()` with the default `wait: true` (`feed.js:93,115-125,165`). A Discord 429 during a drop
   stalls server checks.
4. **No per-retailer circuit breaker.** *Confirmed.* Backoff is per page: when a store goes down, every one of its pages
   fails (and times out) once before backing off, each holding a slot for up to 15 s.
5. **Static intervals.** *Confirmed.* Every page is due at `urlIntervalSeconds` (60 s) or its monitor's interval; the
   only boost is an armed (Auto-checkout) page sorted 15 s ahead. Nothing uses demand, recent changes or history.
6. **Stuck rows re-read every tick.** *Confirmed and measured.* Pages watched only by lapsed members, `monitor=0` items or
   paused monitors are never selected, so never rescheduled; 20k such rows cost ~26 ms of synchronous work per tick.

### 2.2 Notification delivery

7. **Members' DMs wait for the slowest channel post of the search.** *Confirmed.* `ingest` awaits
   `Promise.allSettled(posting)` before `monitor.deliver(later)` (`sweep.js:1047-1048`); same in `checkPage`
   (`index.js:384→391`). With 429 retries this is seconds to tens of seconds.
8. **Inline awaited Discord posts in the sweep's product loop.** *Confirmed.* `await this.feed.transitions(...)`
   (`sweep.js:1302`) posts with `wait: true`, so the next product on the page waits for Discord.
9. **Failed sends are lost.** *Confirmed.* Network errors, timeouts and 5xx from Discord return immediately with no retry
   (`discord.js:126-132`); member webhooks and email too (`notifier.js:98-111,164-169`). Nothing records the loss.
10. **First-time DMs are slow.** *Confirmed by benchmark.* Opening a DM channel runs two at a time (`discord.js:29`).
    The channel id is kept in the database (`users.discord_dm_channel`) once opened, so this only hits a member's very
    first DM — but in a drop where many members are new, 200 DMs took 15.8 s with no channel known vs 4.6 s with all
    known (bench, 150 ms Discord latency).
11. **Duplicates.** *Confirmed.* Two alert rules with the same channel post twice (`feed.js:228-230`); a monitored
    product going from not listed to in stock through a sweep posts both "🆕 New drop" and "🟢 In stock… Just listed".
    *Suspected:* a sweep and a page/browser read can both see an item's old status across awaits and both DM the
    member (no conditional update).
12. **Fixed DM order.** *Confirmed.* The same members are always last in a drop.
13. **Little delivery visibility.** *Confirmed.* Only the median of the last 50 sweep alerts' "to Discord" time is kept,
    in memory; no P95/P99, no DM latency, no failure or retry counts, nothing for page-check alerts.

### 2.3 Checkout isolation

14. **`broadcastRestock`, `browserResults` and the scheduled-start job await DMs in series.** *Confirmed.* The Nth
    armed member's run waits behind ~2(N−1) Discord sends (`index.js:643-650`, `index.js:1034`, `aco.js:269-283`).
15. **A pool member's error drops runs for everyone after them** (`pools.js:591-610`, no per-member try/catch). *Confirmed.*
16. **The extension's checkout listener can die** after three failed polls and wait 30–60 s for Chrome's alarm
    (`background.js:1661-1686`). *Confirmed.*

### 2.4 Database and runtime

17. Dashboard queries scan the whole `products` table (`catalog.js:471`, 33 ms at 100k rows, every 20 s per open
    dashboard); `serverStruggles` filters `check_log` by store without an index; the scheduled-checkout job scans `items`
    every 5 s. *Confirmed plans.*
18. Everything runs on one event loop; parsing a 1.7 MB page takes ~100 ms synchronously. *Suspected impact* (real store
    pages are usually far smaller).

### 2.5 Operations

19. **No staging, no pre-deploy backup, no rollback runbook.** *Confirmed.* A merge to `main` deploys straight to the one
    production machine after CI; backups are manual `VACUUM INTO` on the same volume.
20. **`/healthz` is static** — a stuck monitor or a broken database still reports "ok". *Confirmed.*
21. **Privacy:** with no email provider configured, the mailer logs member emails and message bodies (`mailer.js:22`,
    reached from `notifier.js:104-111`). *Confirmed.*

### 2.6 Flagged for a decision, not changed here

- **Compliance:** Shop checkout links press "Pay now" every 6 s for up to 8 hours and carry on after Shopify's "Too many
  checkout attempts" (after a 3-minute wait); cart links carry the item's quantity, which can pass a cap a store only
  enforces in its theme. These are existing, deliberate features; they sit close to the "do not bypass purchase limits"
  line and deserve an owner's decision.
- **Security:** the card restore key is kept in the dashboard's localStorage and the backup copy includes the CVV; a
  checkout's full URL (with its Shopify/Global-e token) is sent to the server and forwarded to the member's DMs.

## 3. What Mugibot 2.0 changes (in priority order)

Chosen for measurable effect on the five goals — detection speed, accuracy, multi-client performance, checkout time and
reliability — and kept within the existing architecture (no new services or dependencies):

1. **Scheduler with per-retailer lanes** for server page checks: each store gets its own lane (its gap, one check at a
   time unless configured), a page skipped for its store's gap never blocks another store's, and the global pool grows
   from 4 to 12. Fixes findings 1–2.
2. **Per-retailer circuit breakers** with exponential backoff and jitter, Retry-After aware, half-open probes. Finding 4.
3. **Adaptive, demand-aware intervals:** armed and VIP pages, pages many members watch, products that changed lately and
   products inside a predicted drop window are checked sooner; long-quiet pages later — always within the store's own
   budget. Finding 5.
4. **Non-blocking alert pipeline:** page checks and sweeps never wait on Discord; DMs start with the channel posts
   (channel posts keep their priority lane). Findings 3, 7, 8, 14.
5. **Reliable Discord delivery:** retries with jittered backoff for 5xx/network/timeouts, idempotent message posts
   (`enforce_nonce`), per-route limits, more DM channels opened at once, fair DM order, de-duplicated channel posts,
   and a conditional status update so one restock DMs each member once. Findings 9–12.
6. **Delivery and detection metrics:** P50/P95/P99 histograms for detection→Discord, DM delivery, Discord request time,
   failures and retries, per store. Finding 13.
7. **Retailer reliability scores and a health panel:** success rate, latency, error rate, uptime, circuit state and
   alert delivery per store, as one score. `/readyz` deep health check. Findings 13, 20.
8. **Historical drop intelligence:** every confirmed stock change recorded (`stock_events`), restock frequency,
   availability duration, first listed / first in stock, per-retailer drop windows — and predictions, clearly labelled
   as such, that feed the adaptive scheduler.
9. **Product classification and smart alert priority:** game, product type (booster box, ETB, bundle, UPC/premium,
   case, tin…), set codes; high-priority alerts first in the Discord queue; members choose which kinds they want DMs for.
10. **Checkout isolation fixes** (findings 14–16) and the extension's listener that never dies.
11. **Operations:** deep readiness check used after deploys, a volume snapshot before every deploy (the rollback point),
    a pinned deploy action, longer shutdown grace, and a rollback/restore runbook; no member emails in logs.

Not in this round (see the outstanding issues in the final report): sitemap-based discovery (Shopify stores' newest
products already cover most new listings; the stores most worth it refuse servers), moving parsing to worker threads,
running more than one instance (needs the database off the volume), and the decisions in §2.6.

## 4. How it's measured

A benchmark harness (`bench/run.js`) runs the real app against the dummy stores and a fake Discord, on `main` and on
this branch, with the same scenarios: notification fan-out to 200 members (warm and cold DM channels, Discord latency,
429s and 5xx), cross-store isolation (a slow store beside a healthy one), duplicate alerts with several sources reading
the same restock, sweep detection latency (P50/P95/P99), and a load run (hundreds of products and members) for CPU,
memory and event-loop delay. Results are reported as measured, including where 2.0 is no faster.
