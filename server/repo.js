// All reads and writes of user data. Every function that touches someone's
// data takes their userId and puts it in the WHERE clause — there is no way to
// fetch a watchlist item, address, device or event without saying whose it
// is. Admin functions only see account fields and counts, never personal
// details.

import { decryptJSON, encryptJSON, humanCode, newId, newUserKey, normalizeHumanCode, randomToken, sha256, unwrapUserKey } from './crypto.js';
import { EMPTY_PROFILE, HttpError } from './schema.js';

const DAY = 24 * 60 * 60 * 1000;
const GO_CODE_TTL = 2 * 60 * 1000;
const PAIR_CODE_TTL = 10 * 60 * 1000;
const RESET_TTL = 60 * 60 * 1000;
const OAUTH_TTL = 10 * 60 * 1000;
const EVENTS_KEPT = 500;

const USER_FIELDS = ['username', 'email', 'name', 'password_hash', 'role', 'plan', 'trial_ends_at', 'current_period_end', 'cancel_at_period_end',
  'whop_membership_id', 'whop_user_id', 'discord_id', 'discord_username', 'discord_in_guild', 'discord_role', 'discord_dm_channel',
  'discord_synced_at', 'discord_error', 'disabled', 'last_login_at'];

// SQL for "has an active trial, membership or free access" (u = users).
export const ENTITLED_SQL = "(u.role = 'admin' OR u.plan IN ('active', 'comped', 'past_due') OR (u.plan = 'trial' AND u.trial_ends_at > :now))";

const toItem = (r) => r && ({
  id: r.id, store: r.store, sku: r.sku, name: r.name, url: r.url, price: r.price, maxPrice: r.max_price, quantity: r.quantity,
  profileId: r.profile_id, monitor: !!r.monitor, announce: !!r.announce, position: r.position,
  status: r.status, statusSource: r.status_source, statusAt: r.status_at, checkedAt: r.checked_at, title: r.title || '',
  lastPrice: r.last_price, error: r.error || '', lastAlertAt: r.last_alert_at, createdAt: r.created_at,
});
const parseLogins = (v) => { try { const o = JSON.parse(v || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const toDevice = (r) => r && ({
  id: r.id, name: r.name, version: r.version, host: r.host || '', source: r.source || '', createdAt: r.created_at, lastSeenAt: r.last_seen_at,
  // Which stores this browser is signed in to (the store login monitor): { store: { status, at, how } }.
  logins: parseLogins(r.logins), loginsAt: r.logins_at || null,
});

function isUniqueError(e) {
  return /UNIQUE constraint failed/i.test(String(e && e.message));
}

export class Repo {
  constructor(db, cfg, now = () => Date.now()) {
    this.db = db;
    this.cfg = cfg;
    this.now = now;
    this.keys = new Map();
    this.settingsCache = new Map();
    this.retailers = null; // set by app.js (needs this repo for its settings)
  }

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------
  createUser({ username, email = null, name = '', passwordHash, role = 'user', plan = 'none', trialEndsAt = null }) {
    const id = newId('usr');
    const t = this.now();
    try {
      this.db.run(`INSERT INTO users (id, username, email, name, password_hash, data_key, role, plan, trial_ends_at, created_at, updated_at)
        VALUES (:id, :username, :email, :name, :hash, :key, :role, :plan, :trial, :t, :t)`,
      { id, username, email, name, hash: passwordHash, key: newUserKey(this.cfg.dataKey, id), role, plan, trial: trialEndsAt, t });
    } catch (e) {
      if (isUniqueError(e)) throw new HttpError(409, /email/.test(e.message) ? 'That email is already used by another account' : 'That username is taken — choose another');
      throw e;
    }
    return this.userById(id);
  }

  userById(id) {
    return this.db.get('SELECT * FROM users WHERE id = :id', { id: String(id || '') });
  }

  userByUsername(username) {
    return this.db.get('SELECT * FROM users WHERE username = :u', { u: String(username || '') });
  }

  userByEmail(email) {
    return email ? this.db.get('SELECT * FROM users WHERE email = :e', { e: String(email) }) : null;
  }

  userByDiscordId(discordId) {
    return discordId ? this.db.get('SELECT * FROM users WHERE discord_id = :d', { d: String(discordId) }) : null;
  }

  userByWhopMembership(membershipId) {
    return membershipId ? this.db.get('SELECT * FROM users WHERE whop_membership_id = :m', { m: String(membershipId) }) : null;
  }

  updateUser(id, fields) {
    const keys = Object.keys(fields).filter((k) => USER_FIELDS.includes(k));
    if (!keys.length) return this.userById(id);
    const params = { id, t: this.now() };
    keys.forEach((k) => { params[k] = typeof fields[k] === 'boolean' ? Number(fields[k]) : fields[k]; });
    try {
      this.db.run(`UPDATE users SET ${keys.map((k) => `${k} = :${k}`).join(', ')}, updated_at = :t WHERE id = :id`, params);
    } catch (e) {
      if (isUniqueError(e)) {
        if (/email/.test(e.message)) throw new HttpError(409, 'That email is already used by another account');
        if (/discord_id/.test(e.message)) throw new HttpError(409, 'That Discord account is already connected to another Mugibot account');
        if (/whop_membership_id/.test(e.message)) throw new HttpError(409, 'That Whop membership is already linked to another Mugibot account');
        throw new HttpError(409, 'That username is taken — choose another');
      }
      throw e;
    }
    return this.userById(id);
  }

  deleteUser(id) {
    this.keys.delete(id);
    // ON DELETE CASCADE removes sessions, details, watchlist, devices, codes and events.
    return this.db.run('DELETE FROM users WHERE id = :id', { id }).changes > 0;
  }

  countUsers() {
    return this.db.get('SELECT COUNT(*) AS n FROM users').n;
  }

  /** Admin list: account, membership and Discord fields only — never addresses or other personal details. */
  listUsers({ q = '', plan = '', limit = 50, offset = 0 } = {}) {
    const where = "(:q = '' OR u.username LIKE :like OR u.email LIKE :like OR u.name LIKE :like OR u.discord_username LIKE :like OR u.whop_membership_id = :q) AND (:plan = '' OR u.plan = :plan)";
    const params = { q, like: `%${q}%`, plan };
    const rows = this.db.all(`SELECT u.id, u.username, u.email, u.name, u.role, u.plan, u.trial_ends_at, u.current_period_end, u.cancel_at_period_end,
        u.whop_membership_id, u.discord_id, u.discord_username, u.discord_in_guild, u.discord_role, u.discord_error, u.disabled, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id) AS items,
        (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS devices
      FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT :limit OFFSET :offset`, { ...params, limit, offset });
    const total = this.db.get(`SELECT COUNT(*) AS n FROM users u WHERE ${where}`, params).n;
    return { users: rows, total };
  }

  stats() {
    const plans = Object.fromEntries(this.db.all('SELECT plan, COUNT(*) AS n FROM users GROUP BY plan').map((r) => [r.plan, r.n]));
    const n = (sql, p = {}) => this.db.get(sql, p).n;
    return {
      users: this.countUsers(),
      plans,
      signups7d: n('SELECT COUNT(*) AS n FROM users WHERE created_at > :t', { t: this.now() - 7 * DAY }),
      devices: n('SELECT COUNT(*) AS n FROM devices'),
      discordLinked: n('SELECT COUNT(*) AS n FROM users WHERE discord_id IS NOT NULL'),
      discordInServer: n('SELECT COUNT(*) AS n FROM users WHERE discord_in_guild = 1'),
      watchedSkus: n('SELECT COUNT(*) AS n FROM (SELECT DISTINCT store, sku FROM items WHERE monitor = 1)'),
      unlinkedMemberships: n("SELECT COUNT(*) AS n FROM whop_memberships WHERE user_id IS NULL AND status IN ('active', 'trialing', 'canceling', 'past_due')"),
    };
  }

  // ---------------------------------------------------------------------------
  // This user's own encryption key, and their encrypted details
  // ---------------------------------------------------------------------------
  userKey(userId) {
    let key = this.keys.get(userId);
    if (!key) {
      const row = this.db.get('SELECT data_key FROM users WHERE id = :id', { id: userId });
      if (!row) throw new Error('No such user');
      key = unwrapUserKey(this.cfg.dataKey, row.data_key, userId);
      this.keys.set(userId, key);
    }
    return key;
  }

  getData(userId, kind, fallback = null) {
    const row = this.db.get('SELECT enc FROM user_data WHERE user_id = :u AND kind = :k', { u: userId, k: kind });
    if (!row) return fallback;
    return decryptJSON(this.userKey(userId), row.enc, `${userId}:${kind}`);
  }

  setData(userId, kind, value) {
    const enc = encryptJSON(this.userKey(userId), value, `${userId}:${kind}`);
    this.db.run(`INSERT INTO user_data (user_id, kind, enc, updated_at) VALUES (:u, :k, :enc, :t)
      ON CONFLICT (user_id, kind) DO UPDATE SET enc = excluded.enc, updated_at = excluded.updated_at`,
    { u: userId, k: kind, enc, t: this.now() });
    return value;
  }

  deleteData(userId, kind) {
    this.db.run('DELETE FROM user_data WHERE user_id = :u AND kind = :k', { u: userId, k: kind });
  }

  /** Delivery details: { profiles: [...], defaultId } — there is always at least one (maybe empty). */
  getProfiles(userId) {
    const saved = this.getData(userId, 'profiles', null);
    if (saved && Array.isArray(saved.profiles) && saved.profiles.length) return saved;
    return { profiles: [{ ...EMPTY_PROFILE, id: 'pf_default' }], defaultId: 'pf_default' };
  }

  /** The delivery details checkout should use (the chosen set, else the default). */
  profileFor(userId, profileId = null) {
    const { profiles, defaultId } = this.getProfiles(userId);
    return profiles.find((p) => p.id === profileId) || profiles.find((p) => p.id === defaultId) || profiles[0];
  }

  // ---------------------------------------------------------------------------
  // Sessions (only the token's hash is stored)
  // ---------------------------------------------------------------------------
  createSession(userId, userAgent = '') {
    const token = randomToken();
    const t = this.now();
    this.db.run(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent)
      VALUES (:h, :u, :t, :exp, :t, :ua)`, { h: sha256(token), u: userId, t, exp: t + this.cfg.sessionDays * DAY, ua: String(userAgent).slice(0, 200) });
    return token;
  }

  /** The user behind a session cookie, renewing the session as it's used. */
  sessionUser(token) {
    if (!token) return null;
    const h = sha256(token);
    const row = this.db.get('SELECT * FROM sessions WHERE token_hash = :h', { h });
    if (!row) return null;
    const t = this.now();
    if (row.expires_at < t) {
      this.db.run('DELETE FROM sessions WHERE token_hash = :h', { h });
      return null;
    }
    if (t - row.last_seen_at > 60 * 60 * 1000) {
      this.db.run('UPDATE sessions SET last_seen_at = :t, expires_at = :exp WHERE token_hash = :h', { h, t, exp: t + this.cfg.sessionDays * DAY });
    }
    const user = this.userById(row.user_id);
    if (!user || user.disabled) return null;
    return { user, sessionHash: h };
  }

  deleteSession(token) {
    if (token) this.db.run('DELETE FROM sessions WHERE token_hash = :h', { h: sha256(token) });
  }

  /** Sign out everywhere (optionally keeping the current session). */
  deleteSessions(userId, exceptHash = '') {
    this.db.run('DELETE FROM sessions WHERE user_id = :u AND token_hash != :x', { u: userId, x: exceptHash });
  }

  // ---------------------------------------------------------------------------
  // Watchlist (SKUs to monitor and ⚡ Buy)
  // ---------------------------------------------------------------------------
  listItems(userId) {
    return this.db.all('SELECT * FROM items WHERE user_id = :u ORDER BY position, created_at', { u: userId }).map(toItem);
  }

  getItem(userId, id) {
    return toItem(this.db.get('SELECT * FROM items WHERE user_id = :u AND id = :id', { u: userId, id: String(id || '') }));
  }

  itemBySku(userId, store, sku) {
    return toItem(this.db.get('SELECT * FROM items WHERE user_id = :u AND store = :s AND sku = :k COLLATE NOCASE', { u: userId, s: store, k: String(sku || '') }));
  }

  countItems(userId) {
    return this.db.get('SELECT COUNT(*) AS n FROM items WHERE user_id = :u', { u: userId }).n;
  }

  addItem(userId, it) {
    const id = newId('itm');
    const t = this.now();
    const pos = this.db.get('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM items WHERE user_id = :u', { u: userId }).n;
    try {
      this.db.run(`INSERT INTO items (id, user_id, position, store, sku, name, url, price, max_price, quantity, profile_id, monitor, announce, created_at, updated_at)
        VALUES (:id, :u, :pos, :store, :sku, :name, :url, :price, :max, :qty, :pf, :mon, :ann, :t, :t)`,
      { id, u: userId, pos, store: it.store, sku: it.sku, name: it.name, url: it.url || '', price: it.price, max: it.maxPrice, qty: it.quantity, pf: it.profileId, mon: it.monitor ? 1 : 0, ann: it.announce ? 1 : 0, t });
    } catch (e) {
      if (isUniqueError(e)) throw new HttpError(409, `SKU ${it.sku} is already on your watchlist`);
      throw e;
    }
    const saved = this.getItem(userId, id);
    this.ensurePageFor(saved);
    return saved;
  }

  updateItem(userId, id, it) {
    const before = this.getItem(userId, id);
    if (!before) return null;
    const moved = before.url !== (it.url || '') || before.store !== it.store || before.sku !== it.sku;
    try {
      this.db.run(`UPDATE items SET store = :store, sku = :sku, name = :name, url = :url, price = :price, max_price = :max, quantity = :qty,
          profile_id = :pf, monitor = :mon, announce = :ann, updated_at = :t
          ${moved ? ", status = 'pending', status_source = NULL, status_at = NULL, checked_at = NULL, error = '', browser_next_at = 0, browser_fails = 0" : ''}
        WHERE user_id = :u AND id = :id`,
      { id: before.id, u: userId, store: it.store, sku: it.sku, name: it.name, url: it.url || '', price: it.price, max: it.maxPrice, qty: it.quantity, pf: it.profileId, mon: it.monitor ? 1 : 0, ann: it.announce ? 1 : 0, t: this.now() });
    } catch (e) {
      if (isUniqueError(e)) throw new HttpError(409, `SKU ${it.sku} is already on your watchlist`);
      throw e;
    }
    const saved = this.getItem(userId, before.id);
    this.ensurePageFor(saved);
    return saved;
  }

  deleteItem(userId, id) {
    return this.db.run('DELETE FROM items WHERE user_id = :u AND id = :id', { u: userId, id: String(id || '') }).changes > 0;
  }

  /** Put the given ids first, in that order; the rest keep their order after them. */
  reorderItems(userId, ids) {
    const current = this.listItems(userId);
    const known = new Set(current.map((p) => p.id));
    const first = [...new Set(ids.map(String))].filter((id) => known.has(id));
    const order = [...first, ...current.map((p) => p.id).filter((id) => !first.includes(id))];
    this.db.tx(() => order.forEach((id, i) => this.db.run('UPDATE items SET position = :i WHERE user_id = :u AND id = :id', { i, u: userId, id })));
    return this.listItems(userId);
  }

  /** Make sure the monitor knows about the page this item needs checked. */
  ensurePageFor(item) {
    if (!item) return;
    if (item.url) {
      this.ensurePage(item.url, 'product', item.store, item.sku);
      return;
    }
    const r = this.retailers && this.retailers.get(item.store);
    const search = r && this.retailers.searchUrl(r, item.sku);
    if (search) this.ensurePage(search, 'search', item.store, item.sku);
  }

  ensurePage(url, kind = 'product', store = '', sku = '') {
    this.db.run('INSERT OR IGNORE INTO page_checks (url, host, kind, store, sku, next_check_at) VALUES (:url, :host, :kind, :store, :sku, 0)',
      { url, host: new URL(url).host, kind, store, sku });
  }

  // ---------------------------------------------------------------------------
  // ⚡ Buy codes — single use, 2 minutes, and only for the account that made them
  // ---------------------------------------------------------------------------
  createGoCode(userId, item, quantity, profileId = null) {
    const code = randomToken(18);
    this.db.run(`INSERT INTO go_codes (code_hash, user_id, item_id, sku, name, quantity, host, profile_id, expires_at)
      VALUES (:h, :u, :iid, :sku, :name, :qty, :host, :pf, :exp)`,
    { h: sha256(code), u: userId, iid: item.id, sku: item.sku, name: item.name, qty: quantity, host: new URL(item.url).host, pf: profileId, exp: this.now() + GO_CODE_TTL });
    this.db.run('DELETE FROM go_codes WHERE expires_at < :t', { t: this.now() });
    return code;
  }

  claimGoCode(userId, code) {
    const h = sha256(code);
    return this.db.tx(() => {
      const row = this.db.get('SELECT * FROM go_codes WHERE code_hash = :h AND user_id = :u', { h, u: userId });
      if (!row) return null;
      this.db.run('DELETE FROM go_codes WHERE code_hash = :h', { h });
      return row.expires_at >= this.now() ? row : null;
    });
  }

  // ---------------------------------------------------------------------------
  // Browser extension: pairing codes and connected devices
  // ---------------------------------------------------------------------------
  createPairCode(userId) {
    const code = humanCode();
    this.db.run('DELETE FROM pair_codes WHERE user_id = :u OR expires_at < :t', { u: userId, t: this.now() });
    this.db.run('INSERT INTO pair_codes (code_hash, user_id, expires_at) VALUES (:h, :u, :exp)', { h: sha256(code), u: userId, exp: this.now() + PAIR_CODE_TTL });
    return { code, expiresAt: this.now() + PAIR_CODE_TTL };
  }

  redeemPairCode(code) {
    const h = sha256(normalizeHumanCode(code));
    return this.db.tx(() => {
      const row = this.db.get('SELECT * FROM pair_codes WHERE code_hash = :h', { h });
      if (!row) return null;
      this.db.run('DELETE FROM pair_codes WHERE code_hash = :h', { h });
      return row.expires_at >= this.now() ? row.user_id : null;
    });
  }

  addDevice(userId, name, version = '') {
    const token = randomToken();
    const id = newId('dev');
    const t = this.now();
    this.db.tx(() => {
      // Keep the newest few; connecting another browser retires the oldest.
      const existing = this.db.all('SELECT id FROM devices WHERE user_id = :u ORDER BY last_seen_at DESC', { u: userId });
      existing.slice(Math.max(0, this.cfg.limits.devices - 1)).forEach((d) => this.db.run('DELETE FROM devices WHERE id = :id', { id: d.id }));
      this.db.run('INSERT INTO devices (id, user_id, token_hash, name, version, created_at, last_seen_at) VALUES (:id, :u, :h, :name, :v, :t, :t)',
        { id, u: userId, h: sha256(token), name: String(name || 'Browser').slice(0, 60), v: String(version).slice(0, 20), t });
    });
    return { token, device: toDevice(this.db.get('SELECT * FROM devices WHERE id = :id', { id })) };
  }

  deviceByToken(token) {
    if (!token) return null;
    const row = this.db.get('SELECT * FROM devices WHERE token_hash = :h', { h: sha256(token) });
    if (!row) return null;
    const user = this.userById(row.user_id);
    if (!user || user.disabled) return null;
    if (this.now() - row.last_seen_at > 5 * 60 * 1000) this.db.run('UPDATE devices SET last_seen_at = :t WHERE id = :id', { t: this.now(), id: row.id });
    return { device: toDevice(row), user };
  }

  /** The extension's version, the address it talks to (it's built for one address), and where it came from. */
  setDeviceSeen(userId, id, { version, host, source }) {
    this.db.run('UPDATE devices SET version = :v, host = :h, source = :s WHERE user_id = :u AND id = :id',
      { v: String(version || '').slice(0, 20), h: String(host || '').toLowerCase().slice(0, 100), s: ['store', 'download'].includes(source) ? source : '', u: userId, id });
  }

  /** Connected browsers seen in the last 30 days, by extension version and where it came from (admin). */
  extensionCounts(since) {
    return this.db.all(`SELECT version, source, COUNT(*) AS n FROM devices WHERE last_seen_at > :since
      GROUP BY version, source ORDER BY n DESC`, { since });
  }

  /** The store login monitor: what this browser saw (merged with what it said before). */
  setDeviceLogins(userId, id, logins) {
    const row = this.db.get('SELECT logins FROM devices WHERE user_id = :u AND id = :id', { u: userId, id });
    if (!row) return null;
    const merged = { ...parseLogins(row.logins), ...logins };
    this.db.run('UPDATE devices SET logins = :l, logins_at = :t WHERE user_id = :u AND id = :id', { l: JSON.stringify(merged), t: this.now(), u: userId, id });
    return merged;
  }

  listDevices(userId) {
    return this.db.all('SELECT * FROM devices WHERE user_id = :u ORDER BY created_at DESC', { u: userId }).map(toDevice);
  }

  deleteDevice(userId, id) {
    return this.db.run('DELETE FROM devices WHERE user_id = :u AND id = :id', { u: userId, id: String(id || '') }).changes > 0;
  }

  deleteDevices(userId) {
    this.db.run('DELETE FROM devices WHERE user_id = :u', { u: userId });
  }

  // ---------------------------------------------------------------------------
  // Activity
  // ---------------------------------------------------------------------------
  addEvent(userId, { type, level = 'info', message, name = null, sku = null, url = null }) {
    const t = this.now();
    const r = this.db.run('INSERT INTO events (user_id, type, level, message, name, sku, url, created_at) VALUES (:u, :type, :level, :msg, :name, :sku, :url, :t)',
      { u: userId, type, level, msg: String(message).slice(0, 500), name, sku, url: url ? String(url).slice(0, 1000) : null, t });
    const id = Number(r.lastInsertRowid);
    if (id % 50 === 0) {
      this.db.run('DELETE FROM events WHERE user_id = :u AND id <= (SELECT id FROM events WHERE user_id = :u ORDER BY id DESC LIMIT 1 OFFSET :keep)', { u: userId, keep: EVENTS_KEPT });
    }
    return { id, type, level, message, name, sku, url, createdAt: t };
  }

  listEvents(userId, { limit = 100, beforeId = null } = {}) {
    return this.db.all('SELECT * FROM events WHERE user_id = :u AND (:b IS NULL OR id < :b) ORDER BY id DESC LIMIT :limit',
      { u: userId, b: beforeId, limit: Math.min(500, limit) })
      .map((r) => ({ id: r.id, type: r.type, level: r.level, message: r.message, name: r.name, sku: r.sku, url: r.url, createdAt: r.created_at }));
  }

  // ---------------------------------------------------------------------------
  // Password reset tokens, Discord connection states
  // ---------------------------------------------------------------------------
  createReset(userId) {
    const token = randomToken();
    this.db.run('DELETE FROM password_resets WHERE user_id = :u OR expires_at < :t', { u: userId, t: this.now() });
    this.db.run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (:h, :u, :exp)', { h: sha256(token), u: userId, exp: this.now() + RESET_TTL });
    return token;
  }

  useReset(token) {
    const h = sha256(token || '');
    return this.db.tx(() => {
      const row = this.db.get('SELECT * FROM password_resets WHERE token_hash = :h', { h });
      if (!row) return null;
      this.db.run('DELETE FROM password_resets WHERE token_hash = :h', { h });
      return row.expires_at >= this.now() ? row.user_id : null;
    });
  }

  createOAuthState(userId) {
    const state = randomToken(24);
    this.db.run('DELETE FROM oauth_states WHERE user_id = :u OR expires_at < :t', { u: userId, t: this.now() });
    this.db.run('INSERT INTO oauth_states (state_hash, user_id, expires_at) VALUES (:h, :u, :exp)', { h: sha256(state), u: userId, exp: this.now() + OAUTH_TTL });
    return state;
  }

  /** True once, for the account that started the connection, within 10 minutes. */
  useOAuthState(state, userId) {
    const h = sha256(state || '');
    return this.db.tx(() => {
      const row = this.db.get('SELECT * FROM oauth_states WHERE state_hash = :h', { h });
      if (!row) return false;
      this.db.run('DELETE FROM oauth_states WHERE state_hash = :h', { h });
      return row.user_id === userId && row.expires_at >= this.now();
    });
  }

  // ---------------------------------------------------------------------------
  // Whop memberships
  // ---------------------------------------------------------------------------
  membershipById(id) {
    return id ? this.db.get('SELECT * FROM whop_memberships WHERE id = :id', { id: String(id) }) : null;
  }

  upsertMembership(m) {
    const t = this.now();
    this.db.run(`INSERT INTO whop_memberships (id, user_id, status, whop_user_id, whop_username, email, product_id, plan_id, renewal_period_end, cancel_at_period_end, manage_url, metadata_user_id, created_at, updated_at)
      VALUES (:id, :user_id, :status, :whop_user_id, :whop_username, :email, :product_id, :plan_id, :renewal_period_end, :cancel_at_period_end, :manage_url, :metadata_user_id, :t, :t)
      ON CONFLICT (id) DO UPDATE SET user_id = COALESCE(excluded.user_id, whop_memberships.user_id), status = excluded.status,
        whop_user_id = COALESCE(excluded.whop_user_id, whop_memberships.whop_user_id), whop_username = COALESCE(excluded.whop_username, whop_memberships.whop_username),
        email = COALESCE(excluded.email, whop_memberships.email), product_id = COALESCE(excluded.product_id, whop_memberships.product_id),
        plan_id = COALESCE(excluded.plan_id, whop_memberships.plan_id), renewal_period_end = excluded.renewal_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end, manage_url = COALESCE(excluded.manage_url, whop_memberships.manage_url),
        metadata_user_id = COALESCE(excluded.metadata_user_id, whop_memberships.metadata_user_id), updated_at = excluded.updated_at`,
    { user_id: null, whop_user_id: null, whop_username: null, email: null, product_id: null, plan_id: null, renewal_period_end: null, cancel_at_period_end: 0, manage_url: null, metadata_user_id: null, ...m, t });
    return this.membershipById(m.id);
  }

  linkMembership(id, userId) {
    this.db.run('UPDATE whop_memberships SET user_id = :u, updated_at = :t WHERE id = :id', { id, u: userId, t: this.now() });
  }

  listMemberships({ unlinked = false, limit = 100 } = {}) {
    return this.db.all(`SELECT m.*, u.username FROM whop_memberships m LEFT JOIN users u ON u.id = m.user_id
      WHERE (:unl = 0 OR m.user_id IS NULL) ORDER BY m.updated_at DESC LIMIT :l`, { unl: unlinked ? 1 : 0, l: limit });
  }

  /** Remember a webhook; false if it was already handled. */
  markWebhook(id, source, type) {
    return this.db.run('INSERT OR IGNORE INTO webhook_events (id, source, type, received_at) VALUES (:id, :s, :type, :t)', { id: `${source}:${id}`, s: source, type, t: this.now() }).changes > 0;
  }

  lastWebhook(source) {
    return this.db.get('SELECT * FROM webhook_events WHERE source = :s ORDER BY received_at DESC LIMIT 1', { s: source });
  }

  // ---------------------------------------------------------------------------
  // Settings and the audit log
  // ---------------------------------------------------------------------------
  getSetting(key) {
    if (this.settingsCache.has(key)) return this.settingsCache.get(key);
    const row = this.db.get('SELECT value FROM settings WHERE key = :k', { k: key });
    const value = row ? JSON.parse(row.value) : null;
    this.settingsCache.set(key, value);
    return value;
  }

  setSetting(key, value) {
    this.db.run('INSERT INTO settings (key, value, updated_at) VALUES (:k, :v, :t) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      { k: key, v: JSON.stringify(value), t: this.now() });
    this.settingsCache.set(key, value);
    return value;
  }

  audit(actorId, targetUserId, action, detail = '') {
    this.db.run('INSERT INTO audit_log (actor_id, target_user_id, action, detail, created_at) VALUES (:a, :t2, :action, :d, :t)',
      { a: actorId, t2: targetUserId, action, d: String(detail).slice(0, 500), t: this.now() });
  }

  listAudit(limit = 100) {
    return this.db.all('SELECT a.*, u.username AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT :l', { l: limit });
  }

  /** Every SKU members watch, how many watch it and what the last server check saw (no names of who). */
  skuSummary(limit = 300) {
    const rows = this.db.all(`SELECT store, sku, MAX(name) AS name, COUNT(*) AS watchers, SUM(monitor) AS monitoring, MAX(announce) AS announced,
        MAX(url) AS url, MAX(status_at) AS status_at
      FROM items GROUP BY store, sku COLLATE NOCASE ORDER BY watchers DESC, name LIMIT :l`, { l: limit });
    return rows.map((r) => {
      const page = r.url ? this.db.get('SELECT status, checked_at, error, price FROM page_checks WHERE url = :u', { u: r.url }) : null;
      const statuses = this.db.all('SELECT status, COUNT(*) AS n FROM items WHERE store = :s AND sku = :k COLLATE NOCASE GROUP BY status', { s: r.store, k: r.sku });
      return { ...r, announced: !!r.announced, server: page, statuses: Object.fromEntries(statuses.map((s) => [s.status, s.n])) };
    });
  }

  /** Everything stored about one user (for "Download my data"). */
  exportUser(userId) {
    const u = this.userById(userId);
    const { profiles, defaultId } = this.getProfiles(userId);
    return {
      account: {
        username: u.username, email: u.email, name: u.name, plan: u.plan, createdAt: new Date(u.created_at).toISOString(),
        whopMembership: u.whop_membership_id, discord: u.discord_username,
      },
      deliveryDetails: profiles.map((p) => ({ ...p, default: p.id === defaultId })),
      alertSettings: this.getData(userId, 'alerts', null),
      watchlist: this.listItems(userId).map(({ id, store, sku, name, url, price, maxPrice, quantity, monitor }) => ({ id, store, sku, name, url, price, maxPrice, quantity, monitor })),
      devices: this.listDevices(userId),
      activity: this.listEvents(userId, { limit: 500 }),
      note: 'Card details are never stored by Mugibot — they stay in your browser extension.',
    };
  }
}
