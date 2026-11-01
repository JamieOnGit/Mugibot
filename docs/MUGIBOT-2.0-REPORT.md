# Mugibot 2.0 — testing and deployment report

The Phase 1 assessment, with its findings and the reasons for each change, is in
[`ARCHITECTURE-REVIEW.md`](ARCHITECTURE-REVIEW.md). This report covers what changed, how it was tested, the
before/after measurements, how it deploys and rolls back, and what's still outstanding.

Every number below was measured in this repository's own harness or tests, against the dummy stores
(`devtools/mockstore.js`) and a fake Discord. **Nothing was run against a real retailer or the real Discord.** There
is no authorised test route to them, and the tests are built never to touch real stores.

## 1. What changed

### The engine and alert delivery (findings 1–16, 20, 21)

| Change | Where | Findings |
|---|---|---|
| Each store gets its own lane for server page checks: up to 12 reads at once across stores, at most 4 for one store, and up to 12 of each store's due pages considered per tick. One store never blocks another's pages. | `server/monitor/index.js` (`tick`, `take`) | 1, 2 |
| A page's slot is freed as soon as the store answers; its alerts go out while the next pages are read | `checkPage` → `applyRead` | 3 |
| A circuit breaker per store. It opens after 5 failed reads in a row. Backoff is jittered and exponential (30 s up to 10 min), never shorter than a `Retry-After`, with a half-open probe. | `server/monitor/breaker.js` | 4 |
| Members' DMs go out at the same time as the channel posts instead of after them. The live sweep loop never waits for Discord. | `sweep.js` (`ingest`, `ingestPage`, `track`, `loop`), `feed.js` (`transitions`) | 7, 8 |
| Discord retries:<br>• network errors, timeouts and 5xx are retried 3 times (300 ms, 600 ms, 1.2 s, ±25%)<br>• a 429 is waited out up to 8 times<br>• every message carries an enforced nonce, so a message that already arrived is never posted twice<br>• only requests that are safe to repeat are retried | `server/discord.js` | 9 |
| Four DM channels opened at once (was two) | `server/discord.js` | 10 |
| Metrics:<br>• P50/P95/P99 for page reads (per store), Discord requests, drop→Discord (per store) and member DMs<br>• counts of what failed and what was retried | `server/metrics.js` | 13 |
| `/readyz`, plus an admin **Reliability & delivery** panel: score, breaker and P95s per store, Discord retries, drop windows | `server/health.js`, `routes/pages.js`, `routes/admin.js`, `web/js/monitor.js` | 13, 20 |
| Checkout isolation:<br>• `broadcastRestock` creates every armed run before any DM<br>• one pool member's error no longer stops the others' runs<br>• scheduled starts never wait on a DM<br>• the extension's checkout listener keeps retrying through a server restart | `monitor/index.js`, `pools.js`, `aco.js`, `extension/background.js` | 14, 15, 16 |
| Production logs no longer contain member email addresses, email bodies or password-reset links | `server/mailer.js` | 21 |
| Uncaught promise rejections are logged (message only) | `server/main.js` | — |

### New features

- **One Piece at EB Games and Premium Bandai** (your request):
  - **Product classification** (`server/monitor/classify.js`): game, product type and set codes (OP-20, EB-05, PRB-02…).
  - **Quantity rule:**
    - booster box, display or case → 1;
    - booster pack, hangsell or blister → as many as the store allows;
    - accessories (playmats, deck cases) → reported but never bought.
  - **Watch quantity setting:** drop and VIP watches take `auto` / `max` / 1–10.
  - **"Most allowed" quantity:** items can be set to buy the most the store allows. Extension 1.40.0 then puts in the least of:
    - the page's per-customer limit text;
    - the drop-down's highest option, the box's max, or the + button's last press;
    - 10;
    - what the member's own Auto-checkout limits allow at the price seen (fewer units, never a skipped run).

    An older extension buys one.
  - **🏴‍☠️ One Piece preset:** one click adds watches for EB Games and Premium Bandai, armed up to a max price.
  - **Faster blind-store alerts:** stores that only admins' browsers search are flagged to admins after **3 minutes** unsearched (was 20 minutes without a product found).
- **Store sign-ins, 24/7** (your request):
  - **Profile panel:** Account → 🔑 Store sign-ins, for every user including admins. Default stores: EB Games, Premium Bandai, JB Hi-Fi, BIG W, Target and Kmart.
  - **State tracked per member and store** (`login_state`), using the checkout browser's reading.
  - **When signed out:** it shows at once on the dashboard and on the extension's toolbar button (`IN?`), and arrives as a Discord DM with a **Sign in** button.
  - **Reminders:** at most twice a day; you're told when you're back in.
  - **Extension 1.40.0 checks the stores:**
    - stores whose page source says whether you're signed in: every 10 minutes;
    - the others: opens their home page in the extension's own window after 20 quiet minutes (BIG W: hourly; never while a store's queue is up or after it said "Access Denied").
  - **Popup:** signed-out stores are listed first, each with a Sign in link.
  - **Passwords:** Mugibot never signs in for anyone and never sees a password.
- **Historical drop intelligence:**
  - each store's drops and restocks over the last 90 days, by Sydney weekday and hour;
  - the windows they come in most;
  - an **estimate** of the likely next window, labelled as an estimate, and only shown with at least 5 drops to go on.

### Operations

- **Before each deploy (CI):** a snapshot of the database volume, the rollback point. No snapshot means no release.
- **After each deploy (CI):** `/readyz` must pass, or the job goes red with the rollback commands.
- **Shutdown:** `kill_timeout = "30s"` and `kill_signal = "SIGTERM"`, so a release lets alerts and runs finish.
- **Runbook:** `docs/OPERATIONS.md` covers releases, health, rollback, restore and the new environment variable.

## 2. Before / after (measured)

Main is commit `3a76b5d`, the branch this one was cut from. That's `bd6a0a0` plus the BIG W budget from
JamieOnGit/Mugibot#55. 2.0 is this branch. Both were run with the same harness, `node bench/run.js`, on the same
container. The raw results are in `bench/results/main.json` and `bench/results/2.0.json`.

| Scenario | main | 2.0 |
|---|---|---|
| 200 member DMs, DM channels known, Discord 150 ms: P50 / P95 / last | 2.40 s / 4.41 s / 4.58 s | 2.41 s / 4.42 s / 4.59 s (**no change**: bound by Discord's pace) |
| 200 member DMs, no DM channel known yet: P50 / P95 / last | 8.08 s / 14.99 s / 15.76 s | **4.69 s / 8.72 s / 9.18 s** |
| Discord failing 5% (HTTP 500) + 3% dropped connections: DMs delivered | 185 of 200 (**15 lost**) | **200 of 200, 0 duplicates** |
| Discord answering 429 to the first 30 posts: the drop's channel post | **lost** | **delivered** (798 ms) |
| A store hanging 20 s per page beside a healthy store: healthy-store reads per page in 75 s | median **1** (1–4) | median **6** (6–19)* |
| …restocks at the healthy store: detection P50 / P95, missed | 41.0 s / 51.7 s, **1 of 6 missed** | **7.0 s / 10.8 s, 0 missed** |
| …requests sent to the hanging store | 51 | **8** (its breaker opened) |
| 20 members × 5 restocks, sweeps and page checks both reading: DMs per member per restock | 100 exactly one, 0 duplicates | 100 exactly one, 0 duplicates (unchanged) |
| A new listing in a 3-second sweep → Discord: P50 / P95 | 2.07 s / 4.76 s | **1.64 s / 4.55 s** |
| Load: 300 products, 300 members × 5, 60 s — CPU, RSS | 5% of a core (2.88 s), 134 MB | 6% of a core (3.35 s), 129 MB |
| …event-loop delay P50 / P99 / max | 10 / 13 / 47 ms | 10 / 15 / 34 ms |
| …product-page reads per page per minute (interval 10 s) | 3.9 | 4.0 |

\* The healthy store has a 1-second gap between requests in this scenario. That allows about 75 reads for 12 pages,
or about 6.25 each, so 6 is the most it can do. The "15 expected" is the interval alone and ignores the gap.

The first 2.0 run of the load scenario read pages *less* often than main (2.6 vs 3.9 per page per minute). Each store
was capped at 3 candidate pages per tick, and pages still sending their alerts took those places. I raised the cap to
12 and re-ran the isolation and load scenarios. The table shows that re-run, and `bench/results/2.0.json` says so in
`notes`. The other scenarios come from the first run on the same engine.

**Checkout time** (new feature, so no main baseline). The real extension in Chromium ran against the dummy stores
(`test/extension.e2e.test.js`, "🏴‍☠️ One Piece drops…"), timed from run created to order placed:

| Product | Quantity | Time |
|---|---|---|
| EB Games OP-20 hangsell | 4 (the page's "Limit 4 per customer") | 4.6 s |
| EB Games OP-20 booster box | 1 | 4.6 s |
| Premium Bandai OP-12 pack | 6 (its drop-down's highest) | 5.8 s |

## 3. Tests

**New test files:**

| File | Tests | What they cover |
|---|---|---|
| `test/onepiece.test.js` | 5 | Classification on EB Games' and Premium Bandai's real product names; quantity settings; the preset; an `auto` drop watch arming a box for 1, a hangsell for the most and a playmat not at all; the most-allowed run within the member's limits, and 1 on an older extension; the 3-minute unsearched alert. |
| `test/signins.test.js` | 6 | Default stores for members and admins; signed out → DM with a Sign in button, only once, reminded after 12 h, told when back in; the checkout browser's reading counts; stores not kept and late reports ignored; preferences, including DM off; admins; stale readings; lapsed members. |
| `test/engine.test.js` | 6 | The breaker (threshold, half-open probe, backoff, Retry-After); metrics percentiles; Discord retries (500 twice, an answer lost and then deduplicated by its nonce, six 429s, no retry for unsafe POSTs, DMs); `/readyz` 200 and 503; the admin health panel; a failing store's breaker leaving it alone; drop windows across a daylight-saving change. |

**New end-to-end tests** (the real extension in Chromium, in `test/extension.e2e.test.js`):
- One Piece drops bought as they drop (the times above).
- Store sign-ins 24/7: the dummy EB Games' home page is looked at once in the extension's own window and the tab is closed; you get the signed-out DM with a Sign in button; the `IN?` badge, the Account panel and the popup update; signing in on the store's page sends the signed-back-in DM and clears the badge.

**Existing tests changed on purpose:**
- `sweep.test.js`, "📵 BIG W not watched": the store is now searched throughout the 20-minute "searches find nothing" case. A store not searched at all is the new 3-minute alert, and it no longer also sends the 20-minute one. Other stores are kept out of that test.
- `test/helpers.js`: the fake Discord can now answer 500, lose an answer after posting, and deduplicate by nonce.

**Full suite (`npm test`):** see the PR for the result on the final commit. CI runs the same suite before any deploy.

## 4. Deployment report

| | |
|---|---|
| Branch | `claude/mugibot-2-engine-overhaul`, which includes JamieOnGit/Mugibot#55's three BIG W commits |
| Services | Unchanged: one Node process on one Fly machine, one volume. No new service and no new npm dependency. |
| Database changes | Migration #25, additive only:<br>• `items.qty_rule`<br>• `drop_watches.qty`<br>• `vip_watches.qty`<br>• new table `login_state`<br>Existing rows keep their behaviour (default quantity 1, nothing set to "most"). |
| Environment variables | `MONITOR_MAX_IN_FLIGHT` (optional, default 12). Nothing to set. |
| Extension | 1.40.0: most-allowed quantity, store sign-in checks, badge and popup, checkout listener resilience. Older copies keep working; a most-allowed item buys one on them. |
| CI / deploy | Volume snapshot before the deploy; `/readyz` after it |
| Status | **Not deployed.** A deploy happens on merge to `main`, and you asked me not to merge without your explicit go-ahead. |
| Rollback | `flyctl releases -a mugibot-live`, then `flyctl deploy -a mugibot-live --image <previous>`. The migration only adds, so the previous release runs on the new database. To restore data, use the pre-deploy snapshot (`docs/OPERATIONS.md`). |

**Production-readiness criteria and where they stand:**

- Full suite green: see the PR.
- Benchmarks meet or beat main everywhere except warm-channel DM fan-out, which is unchanged because Discord's pace bounds it. CPU is up slightly (5% → 6% of a core under load).
- No secrets in logs.
- The rollback point is automated.
- **Not met: no staging environment.** The first real-world run of 2.0 would be production. Section 5 has the mitigation I'd suggest.

## 5. Outstanding issues and recommendations

**Not done in this round:**
- **Duplicate-alert fixes (finding 11).** Two alert rules on the same channel still post twice. A sweep that takes a monitored product from not listed to in stock still posts both "New drop" and "In stock". No conditional status update yet. The benchmark's duplicate scenario found none in its paths.
- **Fair DM order (finding 12).**
- **Member-configurable smart alert priority.** Classification and priority exist (`classify.js`), and channel posts already go first, but members can't choose yet.
- **Universal fuzzy discovery and sitemaps.**
- **Database indexes (finding 17).**
- **Re-scheduling idle page rows (finding 6).** I tried it and reverted it: it delayed pages that became watched again by up to 10 minutes.
- **Running more than one instance.** It needs the database off the volume.
- **Pinning the deploy action.** `setup-flyctl@master` is still unpinned because I couldn't verify a tag from here.

**Can't be verified from here:**
- **Real stores.** Sign-in detection on EB Games', BIG W's, Kmart's and Target's real headers uses the extension's existing heuristics (`logins.js`). It was tested against the dummy stores only.
- **Store limit text.** Reading a store's own per-customer limit relies on the page's wording ("Limit N per customer", "Max N per order"…).
- **Detection latency limits.**
  - **One Piece drops:** EB Games is searched only from admins' browsers. If none is open, drops can't be seen. That's now flagged within 3 minutes rather than 20.
  - **Silent sign-outs:** caught within 20 minutes (BIG W: 60), or immediately when the member opens the store.

**For an owner's decision** (from the assessment, §2.6):
- Shop checkout links keep pressing "Pay now".
- Cart links carry quantities that can exceed a cap the store only enforces in its theme.
- The card restore key and CVV are held in the dashboard's backup.

**Suggested rollout without a staging environment:**
1. Merge JamieOnGit/Mugibot#55 first, or close it, since this branch contains it.
2. Merge this PR at a quiet hour: CI snapshots the volume, deploys, and checks `/readyz`.
3. Watch Check log → 📈 Reliability & delivery and `flyctl logs` for `monitor.breaker` and `[unhandled]` lines for the first hour.
4. Roll back with the commands above if any store's score drops or alerts stop.
5. Publish extension 1.40.0 to members (Setup → Extension) once the server is confirmed healthy.

**Pre-existing and unrelated:** `test/arming-reviews.test.js`, "JB Hi-Fi's full top 10…", fails on its own on unmodified `main` (it depends on test order).
