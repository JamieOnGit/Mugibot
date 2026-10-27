// SQLite database (built into Node 22+: node:sqlite). One file, easy to back up.
//
// Every table that holds someone's data has a user_id column that references
// users(id) ON DELETE CASCADE, and every query in repo.js filters by it, so
// one account can never see or change another's data. Deleting an account
// removes everything that belongs to it.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT COLLATE NOCASE,              -- optional: password resets and email alerts
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    data_key TEXT NOT NULL,                 -- this user's own encryption key, wrapped with the server key
    role TEXT NOT NULL DEFAULT 'user',      -- 'user' | 'admin'
    plan TEXT NOT NULL DEFAULT 'none',      -- 'none' | 'trial' | 'active' | 'past_due' | 'canceled' | 'comped'
    trial_ends_at INTEGER,
    current_period_end INTEGER,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    whop_membership_id TEXT UNIQUE,
    whop_user_id TEXT,
    discord_id TEXT UNIQUE,
    discord_username TEXT,
    discord_in_guild INTEGER NOT NULL DEFAULT 0,
    discord_role INTEGER NOT NULL DEFAULT 0,  -- has the member role right now
    discord_dm_channel TEXT,
    discord_synced_at INTEGER,
    discord_error TEXT NOT NULL DEFAULT '',
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- Encrypted personal details, one row per kind
  -- ('profiles' = delivery details, 'alerts' = alert settings, 'discord_oauth' = Discord tokens).
  CREATE TABLE user_data (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    enc TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind)
  );

  -- Watchlist: the SKUs someone monitors and buys with ⚡ Buy.
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    store TEXT NOT NULL,                    -- retailer id ('kmart', 'bigw', …) or 'other'
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',           -- product page ('' until it's found from the SKU)
    price REAL,                             -- the price you expect (shown on your list)
    max_price REAL,                         -- only alert at or below this
    quantity INTEGER NOT NULL DEFAULT 1,
    profile_id TEXT,                        -- which delivery details checkout uses (null = default)
    monitor INTEGER NOT NULL DEFAULT 1,
    announce INTEGER NOT NULL DEFAULT 0,    -- admins: also post restocks in the Discord server
    status TEXT NOT NULL DEFAULT 'pending',
    status_source TEXT,                     -- 'server' | 'browser'
    status_at INTEGER,
    checked_at INTEGER,
    title TEXT,
    last_price REAL,
    error TEXT NOT NULL DEFAULT '',
    browser_checked_at INTEGER,
    browser_next_at INTEGER NOT NULL DEFAULT 0,
    browser_fails INTEGER NOT NULL DEFAULT 0,
    last_alert_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX items_user ON items(user_id, position);
  CREATE INDEX items_url ON items(url);
  CREATE INDEX items_store_sku ON items(store, sku);
  CREATE UNIQUE INDEX items_one_per_sku ON items(user_id, store, sku COLLATE NOCASE);

  -- The public stock status of a page (a product page, or a search page while
  -- a SKU isn't listed yet). Shared so a page is checked once however many
  -- people watch it; holds nothing about who watches it.
  CREATE TABLE page_checks (
    url TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'product',   -- 'product' | 'search'
    store TEXT NOT NULL DEFAULT '',
    sku TEXT NOT NULL DEFAULT '',
    status TEXT,
    title TEXT,
    price REAL,
    signals TEXT,
    found_url TEXT,
    checked_at INTEGER,
    next_check_at INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );

  -- One-time ⚡ Buy codes (2 minutes, single use, only for the account that made them).
  CREATE TABLE go_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    host TEXT NOT NULL,
    profile_id TEXT,
    expires_at INTEGER NOT NULL
  );

  -- Codes for connecting the browser extension to an account.
  CREATE TABLE pair_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  -- Connected browser extensions.
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX devices_user ON devices(user_id);

  -- Activity feed and alerts.
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    name TEXT,
    sku TEXT,
    url TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX events_user ON events(user_id, id);

  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  -- "Connect Discord" in progress (OAuth state), tied to the account that started it.
  CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  -- Whop memberships we've heard about (linked to an account, or waiting to be claimed).
  CREATE TABLE whop_memberships (
    id TEXT PRIMARY KEY,                    -- mem_…
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    whop_user_id TEXT,
    whop_username TEXT,
    email TEXT,
    product_id TEXT,
    plan_id TEXT,
    renewal_period_end INTEGER,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    manage_url TEXT,
    metadata_user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX whop_memberships_user ON whop_memberships(user_id);

  -- Webhooks already handled (Whop delivers at least once).
  CREATE TABLE webhook_events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );

  -- Admin settings (e.g. a retailer switched off), as JSON.
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- What admins changed, and on whose account.
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT,
    target_user_id TEXT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  `,
  // 2 — the address each connected extension talks to (an extension is built for one address)
  `ALTER TABLE devices ADD COLUMN host TEXT NOT NULL DEFAULT '';`,
  // 3 — the Monitor feed (docs/MONITORING.md): a shared product catalogue, the monitors admins
  //     run on it, price history, a check log, the alerts it sent, and which channel gets what.
  `
  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    store TEXT NOT NULL,
    sku TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',          -- '' until the product page is found
    image TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'other', -- pokemon | onepiece | other
    status TEXT NOT NULL DEFAULT 'pending',
    status_source TEXT NOT NULL DEFAULT '', -- server | browser | manual
    confirmed INTEGER NOT NULL DEFAULT 0,    -- 1 = the last check succeeded
    price REAL,
    previous_price REAL,
    variant_id TEXT NOT NULL DEFAULT '',    -- Shopify: for the add-to-cart link
    fail_count INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    status_at INTEGER,
    price_at INTEGER,
    checked_at INTEGER,
    last_ok_at INTEGER,
    browser_next_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (store, sku)
  );

  CREATE TABLE monitors (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
    interval_seconds INTEGER,              -- NULL = the default
    paused INTEGER NOT NULL DEFAULT 0,
    kinds TEXT NOT NULL DEFAULT '["restock","listed","price_drop"]',
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price REAL NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX price_history_product ON price_history(product_id, at);

  CREATE TABLE check_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
    store TEXT NOT NULL,
    url TEXT NOT NULL,
    source TEXT NOT NULL,                  -- server | browser
    status TEXT NOT NULL,
    price REAL,
    ms INTEGER,
    error TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  );
  CREATE INDEX check_log_product ON check_log(product_id, at);
  CREATE INDEX check_log_at ON check_log(at);

  CREATE TABLE feed_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,                    -- restock | listed | sold_out | price_drop | price_rise
    store TEXT NOT NULL,
    sku TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'other',
    status TEXT NOT NULL DEFAULT '',
    price REAL,
    previous_price REAL,
    manual INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    posted TEXT NOT NULL DEFAULT '[]',     -- the Discord channels it went to
    at INTEGER NOT NULL
  );
  CREATE INDEX feed_alerts_at ON feed_alerts(at);
  CREATE INDEX feed_alerts_product ON feed_alerts(product_id, kind, at);

  CREATE TABLE alert_routes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    role_id TEXT NOT NULL DEFAULT '',
    categories TEXT NOT NULL DEFAULT '[]', -- [] = every category
    stores TEXT NOT NULL DEFAULT '[]',     -- [] = every store
    kinds TEXT NOT NULL DEFAULT '["restock","listed"]',
    keywords TEXT NOT NULL DEFAULT '',     -- comma-separated; any must appear in the product name
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  `,
  // 4 — where each connected extension came from: 'store' (the Chrome Web Store copy,
  //     which updates itself) or 'download' (a copy loaded from the dashboard's zip).
  `ALTER TABLE devices ADD COLUMN source TEXT NOT NULL DEFAULT '';`,
  // 5 — live sweeps (docs/MONITORING.md): each store's search for each keyword, every few seconds.
  //     Every product they find joins the catalogue; sweep_terms remembers each search.
  `
  ALTER TABLE products ADD COLUMN sweep_first_at INTEGER;             -- first found by a sweep
  ALTER TABLE products ADD COLUMN sweep_seen_at INTEGER;              -- last seen by a sweep
  ALTER TABLE products ADD COLUMN sweep_keyword TEXT NOT NULL DEFAULT '';
  ALTER TABLE products ADD COLUMN restock_day TEXT NOT NULL DEFAULT ''; -- the day it last alerted a restock
  CREATE INDEX products_sweep ON products(sweep_seen_at);

  CREATE TABLE sweep_terms (
    store TEXT NOT NULL,
    keyword TEXT NOT NULL,
    page INTEGER NOT NULL DEFAULT 1,
    url TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',        -- server | browser
    baseline_at INTEGER,                    -- its first good sweep: what it found then was already there
    last_at INTEGER,
    last_ok_at INTEGER,
    found INTEGER NOT NULL DEFAULT 0,       -- products on the page
    kept INTEGER NOT NULL DEFAULT 0,        -- …that passed the filters
    total INTEGER,                          -- results the store says it has
    fails INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    ms INTEGER,
    PRIMARY KEY (store, keyword, page)
  );
  `,
  // 6 — the blacklist (Admin → Blacklist): products, or whole stores, that never alert, aren't
  //     tracked by the sweeps and stay off the Monitor lists. Its first entry: a Kmart bookcase
  //     that kept pinging the restock channel.
  `
  CREATE TABLE blacklist (
    id TEXT PRIMARY KEY,
    store TEXT NOT NULL DEFAULT '',         -- '' = at every store
    sku TEXT NOT NULL DEFAULT '',           -- '' = every product at the store
    name TEXT NOT NULL DEFAULT '',          -- what it is, for the list
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX blacklist_entry ON blacklist(store, sku COLLATE NOCASE);
  INSERT INTO blacklist (id, store, sku, name, note, created_at)
    VALUES ('bl_kmart_43746880', 'kmart', '43746880', 'Wave Book Storage - Oak - One Size', 'Not a trading-card product; it kept pinging the restock channel.', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  DELETE FROM monitors WHERE product_id IN (SELECT id FROM products WHERE store = 'kmart' AND sku = '43746880');
  `,
  // 7 — who sells a product, where the store's search doesn't say (JB Hi-Fi's marketplace):
  //     NULL = not asked yet, '' = the store itself, else the marketplace seller(s); a Discord
  //     alert channel that takes only what no other channel took (misc-retailers); and which
  //     stores each connected browser is signed in to (the store login monitor).
  `
  ALTER TABLE products ADD COLUMN seller TEXT;
  ALTER TABLE alert_routes ADD COLUMN fallback INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE devices ADD COLUMN logins TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE devices ADD COLUMN logins_at INTEGER;
  `,
  // 8 — Auto-checkout (docs/AUTO-CHECKOUT.md): an item armed to be bought by itself when it drops
  //     (one purchase, then it waits to be armed again), the ⚡ Buy code a run opens the store
  //     with, and every run: what triggered it, each step, and how it ended (with why).
  `
  ALTER TABLE items ADD COLUMN aco INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE items ADD COLUMN aco_at INTEGER;
  ALTER TABLE go_codes ADD COLUMN run_id TEXT;
  CREATE TABLE aco_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT,
    store TEXT NOT NULL,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    price REAL,                      -- what the monitor saw when it triggered
    total REAL,                      -- the order total read at checkout
    max_price REAL,                  -- the item's limit at the time
    mode TEXT NOT NULL,              -- 'place' (press the final button) | 'fill' (stop there for you)
    trigger TEXT NOT NULL DEFAULT '',-- what saw it drop: 'sweep' | 'server' | 'browser' | 'manual'
    status TEXT NOT NULL,            -- queued, sent, started, checkout, ready, placing, placed, needs_you, failed, skipped, expired
    reason TEXT NOT NULL DEFAULT '', -- why it stopped: sold_out, over_limit, card_declined, bank_check, …
    message TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]',-- [{ at, status, message }]
    device_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX aco_runs_user ON aco_runs (user_id, created_at);
  CREATE INDEX aco_runs_status ON aco_runs (status, created_at);
  `,
  // 9 — VIP drops (server/monitor/vip.js): admins' watches (a store + words, or a link) whose
  //     alerts go to the VIP channel (#vip-drop), checked fast around their drop time.
  `
  CREATE TABLE vip_watches (
    id TEXT PRIMARY KEY,
    store TEXT NOT NULL DEFAULT '',      -- a keyword watch: the store searched ('' for a link)
    words TEXT NOT NULL DEFAULT '',      -- …every word in the product's name
    url TEXT NOT NULL DEFAULT '',        -- a link watch: the product page
    label TEXT NOT NULL DEFAULT '',
    drop_at INTEGER,                     -- when it drops: checked every few seconds around then
    aco_user TEXT,                       -- an admin it's bought for (Auto-checkout), up to max_price
    max_price REAL,
    found TEXT NOT NULL DEFAULT '[]',    -- products it found: [{ productId, at }]
    created_by TEXT,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE monitors ADD COLUMN vip_watch TEXT;
  ALTER TABLE alert_routes ADD COLUMN vip INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE feed_alerts ADD COLUMN vip INTEGER NOT NULL DEFAULT 0;
  `,
  // 10 — checkpoints and virtual queues (server/monitor/gates.js): whether each store's gate (JB
  //      Hi-Fi's hCaptcha checkpoint, EB Games' and Pokémon Center's queues) is up, since when,
  //      and what it last said about the wait.
  `
  CREATE TABLE gates (
    store TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                  -- checkpoint | queue
    status TEXT NOT NULL DEFAULT 'down', -- up | down
    since INTEGER,                       -- when it went up (or down)
    seen_at INTEGER,                     -- last seen up
    looked_at INTEGER,                   -- last looked at by a check that tells (server, an admin's browser)
    wait INTEGER,                        -- the queue's estimated wait, in minutes
    source TEXT NOT NULL DEFAULT '',     -- what saw it change: server | browser | probe | stale
    ups INTEGER NOT NULL DEFAULT 0,      -- times it's gone up
    posted_at INTEGER
  );
  `,
  // 11 — drop watches (server/monitor/drops.js): anything outside the card keywords, by its link or
  //      the words in its name, at a store Mugibot knows or any other website. An admin's are for
  //      everyone (#non-tcg-alerts); a member's are their own (their watchlist and DMs).
  `
  CREATE TABLE drop_watches (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared INTEGER NOT NULL DEFAULT 0,   -- an admin's, for everyone: #non-tcg-alerts and every dashboard
    store TEXT NOT NULL DEFAULT '',      -- the store ('jbhifi', …), or 'other' (another website)
    site TEXT NOT NULL DEFAULT '',       -- words at another website: where they're looked for
    words TEXT NOT NULL DEFAULT '',      -- a words watch: every word in the product's name
    url TEXT NOT NULL DEFAULT '',        -- a link watch: the product page
    label TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'nontcg',
    aco INTEGER NOT NULL DEFAULT 0,      -- Auto-checkout it (stores Mugibot checks out at), up to max_price
    max_price REAL,
    found TEXT NOT NULL DEFAULT '[]',    -- what it found: [{ productId | itemId, sku, at, arm }]
    how TEXT NOT NULL DEFAULT '',        -- words at another website: how its products are read
    seen INTEGER NOT NULL DEFAULT 0,     -- products on the page (or in the search) its last look read
    baseline_at INTEGER,                 -- its first look (what was there then was there already)
    next_at INTEGER NOT NULL DEFAULT 0,
    last_at INTEGER,
    last_ok_at INTEGER,
    fails INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX drop_watches_user ON drop_watches (user_id);
  ALTER TABLE items ADD COLUMN drop_watch TEXT;     -- put on the watchlist by this drop watch
  ALTER TABLE monitors ADD COLUMN drop_watch TEXT;  -- made by this (shared) drop watch
  `,
  // 12 — where an admin's drop watch for everyone posts (an admin picks): its drops and restocks go in
  //      this Discord channel, pinging this role — instead of #non-tcg-alerts. '' = the usual rules.
  `
  ALTER TABLE drop_watches ADD COLUMN channel_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE drop_watches ADD COLUMN role_id TEXT NOT NULL DEFAULT '';
  `,
  // 13 — a drop watch's find going down in price (📉, your own watch's DM — at any store or website):
  //      when its owner was last told, and at what price (told again only when it goes lower still, or a
  //      while later).
  `
  ALTER TABLE items ADD COLUMN price_alert_at INTEGER;
  ALTER TABLE items ADD COLUMN price_alert_price REAL;
  `,
  // 14 — a Shop checkout link's discount code (yours, typed in beforehand): Auto-checkout types it into
  //      Shop's checkout and presses Apply before "Pay now" ('' = none: the discount box is left alone).
  `
  ALTER TABLE items ADD COLUMN discount TEXT NOT NULL DEFAULT '';
  `,
  // 15 — 🚦 Wait for queue, then ACO at a time the member picked (a Shop checkout link's): when it starts by itself.
  `
  ALTER TABLE items ADD COLUMN queue_at INTEGER;
  `,
  // 16 — release news (server/news.js, docs/NEWS.md): what's coming out, when and at which stores — an
  //      admin's, or from the news feeds Mugibot reads (RSS and Atom) — posted in the Discord server's
  //      #news; and the feeds, with what their last read said.
  `
  CREATE TABLE news_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'admin',   -- 'admin' | 'feed'
    source_name TEXT NOT NULL DEFAULT '',   -- the feed's name ("Nintendo Life"), or the app's for an admin's
    feed_id TEXT,                           -- the feed it came from (NULL: an admin's)
    category TEXT NOT NULL DEFAULT 'other', -- 'tcg' | 'console' | 'collectible' | 'other'
    stores TEXT NOT NULL DEFAULT '[]',      -- the retailers it names: ["ebgames", "bigw", …]
    release_at INTEGER,                     -- its release date (midnight in Sydney), when it says one
    release_text TEXT NOT NULL DEFAULT '',  -- …as written ("14 November")
    dedupe_key TEXT NOT NULL UNIQUE,        -- a feed entry's guid or link ('admin:<id>' for an admin's)
    published_at INTEGER,                   -- when its feed says it was published
    posted_at INTEGER,                      -- last posted in #news
    posted_channel TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX news_items_release ON news_items (release_at);
  CREATE INDEX news_items_created ON news_items (created_at);
  CREATE INDEX news_items_url ON news_items (url);

  CREATE TABLE news_feeds (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    keywords TEXT NOT NULL DEFAULT '',      -- comma list added to the hyped products ('' = the defaults; -word leaves out)
    baseline_at INTEGER,                    -- its first read: what was in it then is old news, never posted
    next_at INTEGER NOT NULL DEFAULT 0,
    fails INTEGER NOT NULL DEFAULT 0,       -- reads gone wrong in a row (it backs off)
    last_fetch_at INTEGER,
    last_ok_at INTEGER,
    last_error TEXT NOT NULL DEFAULT '',
    last_result TEXT NOT NULL DEFAULT '',
    etag TEXT NOT NULL DEFAULT '',          -- for a conditional read (304: nothing new)
    last_modified TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  `,
  // 17 — how many an Auto-checkout run puts in the bag (its item's quantity when it started; 1 before quantities).
  `
  ALTER TABLE aco_runs ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
  `,
  // 18 — a drop watch's words (a key phrase) at every store Mugibot searches (store 'all'): its first look at each
  //      store, { store: at } — what was listed there then was there already.
  `
  ALTER TABLE drop_watches ADD COLUMN bases TEXT NOT NULL DEFAULT '{}';
  `,
  // 19 — which of the member's cards an item is paid with (extension 1.33 keeps several, one the default):
  //      the card's id in their extension — never the card ('' = their default).
  `
  ALTER TABLE items ADD COLUMN card_id TEXT NOT NULL DEFAULT '';
  `,
  // 20 — a drop watch on a search page (server/monitor/pages.js): any store's search, category or collection page,
  //      read every few seconds for its key phrases — page: its link; phrases: what's looked for on it (any one of
  //      them in a product's name); every_seconds: how often it's read (never faster than its store allows).
  `
  ALTER TABLE drop_watches ADD COLUMN page TEXT NOT NULL DEFAULT '';
  ALTER TABLE drop_watches ADD COLUMN phrases TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE drop_watches ADD COLUMN every_seconds INTEGER NOT NULL DEFAULT 0;
  `,
  // 21 — pools (server/pools.js): an admin's watchlist, armed items and drop watches shared with the members who join
  //      their pool, kept in step on each member's own watchlist as they change — and, for each member who agrees to it
  //      themselves, the admin's Auto-checkouts run for them too, in their own browser, with their own card, details
  //      and limits. pool_members.status: 'invited' (asked, not answered) or 'active' (joined: one pool at a time);
  //      follow_aco/aco_cap/aco_agreed_at: the member's own say over checking out with the pool's leader.
  //      items.pool_src: the leader's item this one mirrors; pool_aco_at: the leader's arming it was armed for (bought
  //      once, it isn't armed again till the leader arms theirs again); pool_hold: the member skips this one;
  //      pool_watch: the leader's drop watch that found it (one purchase per watch, for the member too).
  `
  CREATE TABLE pools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX pools_owner ON pools(owner_id);
  CREATE TABLE pool_members (
    pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'invited',
    invited_by TEXT,
    invited_at INTEGER NOT NULL,
    joined_at INTEGER,
    follow_aco INTEGER NOT NULL DEFAULT 0,
    aco_cap REAL,
    aco_agreed_at INTEGER,
    PRIMARY KEY (pool_id, user_id)
  );
  CREATE UNIQUE INDEX pool_members_one_active ON pool_members(user_id) WHERE status = 'active';
  ALTER TABLE items ADD COLUMN pool_src TEXT;
  ALTER TABLE items ADD COLUMN pool_aco_at INTEGER;
  ALTER TABLE items ADD COLUMN pool_hold INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE items ADD COLUMN pool_watch TEXT;
  CREATE INDEX items_pool_src ON items(pool_src);
  `,
  // 22 — a words watch's first look at each store (VIP and drop watches: watch_id): whether its page was full — more
  //      listed than the page held, so something listed all along may show up in it only later, and an Auto-checkout
  //      watch then doesn't buy what's new to it on the search's say. A store a watch looked at before this has no row
  //      (as full); VIP keyword watches from before this: full. (A table of its own, made only where it isn't there, so
  //      this migration is safe to run again if another branch's lands next to it.)
  `
  CREATE TABLE IF NOT EXISTS first_looks (
    watch_id TEXT NOT NULL,
    store TEXT NOT NULL,
    full INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (watch_id, store)
  );
  INSERT OR IGNORE INTO first_looks (watch_id, store, full, at) SELECT id, store, 1, created_at FROM vip_watches WHERE words <> '';
  `,
];

export class Db {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.cache = new Map();
    this.migrate();
  }

  migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get();
    let version = row ? row.version : 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    while (version < MIGRATIONS.length) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[version]);
        version += 1;
        this.db.prepare('UPDATE schema_version SET version = ?').run(version);
      });
    }
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      s.setAllowUnknownNamedParameters?.(true);
      this.cache.set(sql, s);
    }
    return s;
  }

  get(sql, params = {}) {
    const row = this.stmt(sql).get(params);
    return row ? { ...row } : null;
  }

  all(sql, params = {}) {
    return this.stmt(sql).all(params).map((r) => ({ ...r }));
  }

  run(sql, params = {}) {
    return this.stmt(sql).run(params);
  }

  tx(fn) {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  close() {
    this.db.close();
  }
}
