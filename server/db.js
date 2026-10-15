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
