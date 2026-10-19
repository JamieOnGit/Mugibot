// The Monitor's data (docs/MONITORING.md): the shared product catalogue, the
// monitors admins run on it, price history, the check log, the alerts it
// sent and the Discord alert rules. Members' own watchlists stay in repo.js;
// this is the shared feed everyone sees.

import { newId } from './crypto.js';
import { slugWords } from './monitor/extract.js';

// nontcg: not trading cards at all — what drop watches find (monitor/drops.js), in #non-tcg-alerts.
export const CATEGORIES = { pokemon: 'Pokémon', onepiece: 'One Piece', other: 'Other', nontcg: 'Non-TCG' };
export const ALERT_KINDS = ['restock', 'listed', 'sold_out', 'price_drop', 'price_rise'];
export const DEFAULT_KINDS = ['restock', 'listed', 'price_drop'];

/** Pokémon / One Piece from a product name ("other" when it isn't clear). */
export function categoryFor(name) {
  const n = String(name || '').toLowerCase();
  if (/pok[eé]mon|pikachu|scarlet\s*&?\s*violet|elite trainer|\betb\b/.test(n)) return 'pokemon';
  if (/one\s*piece|\bop-?\d{2}\b|straw hat/.test(n)) return 'onepiece';
  return 'other';
}

// Which products a page check is for: the product page itself, or the search page for a SKU
// that hasn't got a product page yet (same rule as members' items).
export const PRODUCTS_FOR_PAGE = `((c.kind = 'product' AND p.url = c.url) OR (c.kind = 'search' AND p.url = '' AND p.store = c.store AND p.sku = c.sku COLLATE NOCASE))`;

const json = (s, fallback) => { try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; } };

/** A name from a product link ("…/d/xbox-series-x25-limited-edition/8wg5vqp0x4h3" → "Xbox Series X25 Limited Edition"). */
export function linkName(url) {
  let p = '';
  try { p = new URL(url).pathname; } catch { return ''; }
  return slugWords(p).replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 120);
}

/**
 * A product at another website that hasn't been named yet (its page hasn't been read): the words in
 * its link, until its page's title comes in. (Its SKU there is only Mugibot's own code for the link.)
 */
const unnamed = (r) => r.store === 'other' && (!r.name || r.name === linkName(r.url));
const shownName = (r) => r.name || (r.store === 'other' ? linkName(r.url) : '');

/** What a product is called, wherever it's shown: its name, else (another website) its link's words, else its SKU. */
export const productName = (r) => shownName(r) || r.sku;

/** May the page's title name this product? Not named yet — or named only by its link's words. */
export const nameable = (r) => !r.name || unnamed(r);

export function toProduct(r) {
  return r && {
    id: r.id, store: r.store, sku: r.sku, name: shownName(r), url: r.url, image: r.image, category: r.category,
    status: r.status, statusSource: r.status_source, confirmed: !!r.confirmed, price: r.price, previousPrice: r.previous_price,
    variantId: r.variant_id, failCount: r.fail_count, error: r.error,
    statusAt: r.status_at, priceAt: r.price_at, checkedAt: r.checked_at, lastOkAt: r.last_ok_at, createdAt: r.created_at,
    sweep: r.sweep_first_at ? { firstAt: r.sweep_first_at, seenAt: r.sweep_seen_at, keyword: r.sweep_keyword } : null,
  };
}

// How long a product a sweep stopped seeing stays in the list (sold out products often drop out of search).
const SWEPT_DAYS = 14;

// Not on the blacklist (Admin → Blacklist): a product there, or its whole store, stays off the lists.
const unblocked = (t) => `NOT EXISTS (SELECT 1 FROM blacklist b WHERE (b.store = '' OR b.store = ${t}.store) AND (b.sku = '' OR b.sku = ${t}.sku COLLATE NOCASE))`;

export function toBlacklisted(r) {
  return r && { id: r.id, store: r.store, sku: r.sku, name: r.name, note: r.note, createdBy: r.created_by, createdAt: r.created_at };
}

export function toMonitor(r) {
  return r && {
    id: r.id, productId: r.product_id, intervalSeconds: r.interval_seconds, paused: !!r.paused, vipWatch: r.vip_watch || null, dropWatch: r.drop_watch || null,
    kinds: json(r.kinds, DEFAULT_KINDS), note: r.note, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function toAlert(r) {
  return r && {
    id: r.id, productId: r.product_id, kind: r.kind, store: r.store, sku: r.sku, name: r.name, url: r.url, image: r.image,
    category: r.category, status: r.status, price: r.price, previousPrice: r.previous_price, manual: !!r.manual, note: r.note,
    posted: json(r.posted, []), vip: !!r.vip, at: r.at,
  };
}

export function toRoute(r) {
  return r && {
    id: r.id, name: r.name, channelId: r.channel_id, roleId: r.role_id, categories: json(r.categories, []), stores: json(r.stores, []),
    kinds: json(r.kinds, ['restock', 'listed']), keywords: r.keywords, enabled: !!r.enabled, fallback: !!r.fallback, vip: !!r.vip, createdAt: r.created_at,
  };
}

export class Catalog {
  constructor({ db, repo, now = () => Date.now() }) {
    Object.assign(this, { db, repo, now });
    this.blacklistCache = null;
  }

  // ---------------------------------------------------------------------------
  // The blacklist: products (a store and a SKU), a SKU at any store, or a whole store
  // ---------------------------------------------------------------------------
  listBlacklist() {
    return this.db.all('SELECT * FROM blacklist ORDER BY created_at DESC').map(toBlacklisted);
  }

  /** Is this product on the blacklist? codes: its SKU and any other codes it goes by. */
  isBlocked(store, ...codes) {
    if (!this.blacklistCache) this.blacklistCache = this.db.all('SELECT store, sku FROM blacklist');
    const cs = codes.flat().filter(Boolean).map((c) => String(c).toLowerCase());
    return this.blacklistCache.some((b) => (!b.store || b.store === store) && (!b.sku || cs.includes(b.sku.toLowerCase())));
  }

  /** Add an entry, and remove the monitors it covers. Returns { entry, created, monitorsRemoved }. */
  addBlacklist({ store = '', sku = '', name = '', note = '', createdBy = null }) {
    const existing = this.db.get('SELECT * FROM blacklist WHERE store = :s AND sku = :k COLLATE NOCASE', { s: store, k: sku });
    if (existing) return { entry: toBlacklisted(existing), created: false, monitorsRemoved: 0 };
    const id = newId('bl');
    this.db.run(`INSERT INTO blacklist (id, store, sku, name, note, created_by, created_at) VALUES (:id, :s, :k, :n, :note, :by, :t)`,
      { id, s: store, k: sku, n: String(name || '').slice(0, 200), note: String(note || '').slice(0, 300), by: createdBy, t: this.now() });
    this.blacklistCache = null;
    const monitorsRemoved = this.db.run(`DELETE FROM monitors WHERE product_id IN (SELECT id FROM products p WHERE (:s = '' OR p.store = :s) AND (:k = '' OR p.sku = :k COLLATE NOCASE))`,
      { s: store, k: sku }).changes;
    return { entry: toBlacklisted(this.db.get('SELECT * FROM blacklist WHERE id = :id', { id })), created: true, monitorsRemoved };
  }

  removeBlacklist(id) {
    const row = this.db.get('SELECT * FROM blacklist WHERE id = :id', { id: String(id || '') });
    if (!row) return null;
    this.db.run('DELETE FROM blacklist WHERE id = :id', { id: row.id });
    this.blacklistCache = null;
    return toBlacklisted(row);
  }

  // ---------------------------------------------------------------------------
  // Products
  // ---------------------------------------------------------------------------
  productById(id) {
    return this.db.get('SELECT * FROM products WHERE id = :id', { id: String(id || '') });
  }

  productFor(store, sku) {
    return this.db.get('SELECT * FROM products WHERE store = :s AND sku = :k COLLATE NOCASE', { s: store, k: String(sku || '') });
  }

  /** The catalogue entry for a store + SKU, created if new. Fills in what it didn't know yet. */
  upsertProduct({ store, sku, url = '', name = '', category = '', image = '' }) {
    const t = this.now();
    this.db.run(`INSERT OR IGNORE INTO products (id, store, sku, name, url, image, category, created_at, updated_at)
      VALUES (:id, :s, :k, :n, :u, :img, :c, :t, :t)`,
    { id: newId('prd'), s: store, k: String(sku), n: String(name || '').slice(0, 200), u: url || '', img: image || '', c: category || categoryFor(name), t });
    const p = this.productFor(store, sku);
    const set = {};
    if (url && !p.url) set.url = url;
    if (name && !p.name) set.name = String(name).slice(0, 200);
    if (image && !p.image) set.image = image;
    if (category && category !== p.category) set.category = category;
    if (Object.keys(set).length) return this.updateProduct(p.id, set);
    return p;
  }

  updateProduct(id, fields) {
    const cols = Object.keys(fields);
    if (cols.length) {
      this.db.run(`UPDATE products SET ${cols.map((c) => `${c} = :${c}`).join(', ')}, updated_at = :updated_at WHERE id = :id`, { ...fields, updated_at: this.now(), id });
    }
    return this.productById(id);
  }

  /** The products a page check is for (only ones a monitor or announcement uses). */
  productsForPage(url) {
    return this.db.all(`SELECT p.* FROM products p, page_checks c WHERE c.url = :url AND ${PRODUCTS_FOR_PAGE}`, { url });
  }

  /** The product page for a SKU was found. */
  resolveProduct(store, sku, url) {
    this.db.run(`UPDATE products SET url = :url, status = CASE WHEN status = 'pending' THEN 'not_listed' ELSE status END, updated_at = :t
      WHERE url = '' AND store = :s AND sku = :k COLLATE NOCASE`, { url, s: store, k: sku, t: this.now() });
  }

  addPrice(productId, price) {
    this.db.run('INSERT INTO price_history (product_id, price, at) VALUES (:p, :price, :at)', { p: productId, price, at: this.now() });
  }

  priceHistory(productId, days = 90) {
    return this.db.all('SELECT price, at FROM price_history WHERE product_id = :p AND at >= :since ORDER BY at',
      { p: productId, since: this.now() - days * 86400000 });
  }

  // ---------------------------------------------------------------------------
  // Monitors
  // ---------------------------------------------------------------------------
  monitorById(id) {
    return this.db.get('SELECT * FROM monitors WHERE id = :id', { id: String(id || '') });
  }

  monitorForProduct(productId) {
    return this.db.get('SELECT * FROM monitors WHERE product_id = :p', { p: productId });
  }

  /** Find a monitor by its ID, a SKU, or a product link. */
  findMonitor(target, store = null) {
    const t = String(target || '').trim();
    if (!t) return null;
    const byId = this.monitorById(t);
    if (byId) return byId;
    const rows = this.db.all(`SELECT m.* FROM monitors m JOIN products p ON p.id = m.product_id
      WHERE (p.sku = :t COLLATE NOCASE OR p.url = :t OR p.url = :t2)${store ? ' AND p.store = :s' : ''} ORDER BY m.created_at`,
    { t, t2: t.replace(/[?#].*$/, ''), s: store });
    return rows.length === 1 ? rows[0] : rows.length ? { ambiguous: rows.length } : null;
  }

  addMonitor(productId, { intervalSeconds = null, kinds = DEFAULT_KINDS, note = '', createdBy = null } = {}) {
    const existing = this.monitorForProduct(productId);
    if (existing) return { monitor: existing, created: false };
    const t = this.now();
    const id = newId('mon');
    this.db.run(`INSERT INTO monitors (id, product_id, interval_seconds, kinds, note, created_by, created_at, updated_at)
      VALUES (:id, :p, :iv, :k, :note, :by, :t, :t)`,
    { id, p: productId, iv: intervalSeconds, k: JSON.stringify(kinds), note, by: createdBy, t });
    return { monitor: this.monitorById(id), created: true };
  }

  updateMonitor(id, { intervalSeconds, paused, kinds, note } = {}) {
    const set = {};
    if (intervalSeconds !== undefined) set.interval_seconds = intervalSeconds;
    if (paused !== undefined) set.paused = paused ? 1 : 0;
    if (kinds !== undefined) set.kinds = JSON.stringify(kinds);
    if (note !== undefined) set.note = note;
    const cols = Object.keys(set);
    if (cols.length) this.db.run(`UPDATE monitors SET ${cols.map((c) => `${c} = :${c}`).join(', ')}, updated_at = :t WHERE id = :id`, { ...set, t: this.now(), id });
    return this.monitorById(id);
  }

  deleteMonitor(id) {
    return this.db.run('DELETE FROM monitors WHERE id = :id', { id }).changes > 0;
  }

  /** Monitors with their products, filtered and searched. */
  listMonitors({ q = '', category = '', store = '', status = '', paused = null, limit = 500 } = {}) {
    const where = [unblocked('p')];
    const params = { limit };
    if (q) { where.push('(p.name LIKE :q OR p.sku LIKE :q)'); params.q = `%${q}%`; }
    if (category) { where.push('p.category = :category'); params.category = category; }
    if (store) { where.push('p.store = :store'); params.store = store; }
    if (status === 'available') where.push("p.status IN ('in_stock', 'preorder')");
    else if (status === 'unavailable') where.push("p.status NOT IN ('in_stock', 'preorder')");
    else if (status === 'problem') where.push("(p.status IN ('blocked', 'error') OR p.fail_count > 0)");
    else if (status) { where.push('p.status = :status'); params.status = status; }
    if (paused !== null) { where.push('m.paused = :paused'); params.paused = paused ? 1 : 0; }
    return this.db.all(`SELECT p.*, m.id AS m_id, m.interval_seconds AS m_interval, m.paused AS m_paused, m.kinds AS m_kinds, m.note AS m_note,
        m.created_at AS m_created
      FROM monitors m JOIN products p ON p.id = m.product_id WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN p.status IN ('in_stock', 'preorder') THEN 0 ELSE 1 END, COALESCE(p.status_at, p.created_at) DESC LIMIT :limit`, params)
      .map((r) => ({
        ...toProduct(r),
        monitor: { id: r.m_id, intervalSeconds: r.m_interval, paused: !!r.m_paused, kinds: json(r.m_kinds, DEFAULT_KINDS), note: r.m_note, createdAt: r.m_created },
      }));
  }

  /**
   * The products list: everything the live sweeps track (seen lately) and every monitored product,
   * filtered and searched. Members don't see paused monitors that no sweep tracks.
   */
  listProducts({ limit = 600, offset = 0, ...filters } = {}) {
    const { where, params } = this.productsWhere(filters);
    return this.db.all(`SELECT p.*, m.id AS m_id, m.interval_seconds AS m_interval, m.paused AS m_paused, m.kinds AS m_kinds, m.note AS m_note,
        m.created_at AS m_created
      FROM products p LEFT JOIN monitors m ON m.product_id = p.id WHERE ${where}
      ORDER BY CASE WHEN p.status IN ('in_stock', 'preorder') THEN 0 ELSE 1 END, COALESCE(p.status_at, p.sweep_first_at, p.created_at) DESC, p.id DESC
      LIMIT :limit OFFSET :offset`, { ...params, limit, offset })
      .map((r) => ({
        ...toProduct(r),
        monitor: r.m_id ? { id: r.m_id, intervalSeconds: r.m_interval, paused: !!r.m_paused, kinds: json(r.m_kinds, DEFAULT_KINDS), note: r.m_note, createdAt: r.m_created } : null,
      }));
  }

  /** How many products the list has with these filters — all of them, not just a page. */
  countProducts(filters = {}) {
    const { where, params } = this.productsWhere(filters);
    return this.db.get(`SELECT COUNT(*) AS n FROM products p LEFT JOIN monitors m ON m.product_id = p.id WHERE ${where}`, params).n;
  }

  /** The products list's filters, as SQL. excludeStores: stores left out (a member's own store switches). */
  productsWhere({ q = '', category = '', store = '', status = '', admin = false, excludeStores = [] } = {}) {
    const where = [`(m.id IS NOT NULL${admin ? '' : ' AND m.paused = 0'} OR p.sweep_seen_at >= :swept)`, unblocked('p')];
    const params = { swept: this.now() - SWEPT_DAYS * 86400000 };
    if (q) { where.push('(p.name LIKE :q OR p.sku LIKE :q)'); params.q = `%${q}%`; }
    if (category) { where.push('p.category = :category'); params.category = category; }
    if (store) { where.push('p.store = :store'); params.store = store; }
    if (excludeStores.length) {
      where.push(`p.store NOT IN (${excludeStores.map((_, i) => `:x${i}`).join(', ')})`);
      excludeStores.forEach((id, i) => { params[`x${i}`] = id; });
    }
    if (status === 'available') where.push("p.status IN ('in_stock', 'preorder')");
    else if (status === 'unavailable') where.push("p.status NOT IN ('in_stock', 'preorder')");
    else if (status === 'problem') where.push("(p.status IN ('blocked', 'error') OR p.fail_count > 0)");
    else if (status === 'new') { where.push('p.sweep_first_at >= :day'); params.day = this.now() - 86400000; }
    else if (status) { where.push('p.status = :status'); params.status = status; }
    return { where: where.join(' AND '), params };
  }

  /** Is this product in the shared list (monitored, or tracked by a sweep lately)? */
  isListed(product, { admin = false } = {}) {
    if (!product || this.isBlocked(product.store, product.sku)) return false;
    const m = this.monitorForProduct(product.id);
    if (m && (admin || !m.paused)) return true;
    return !!product.sweep_seen_at && product.sweep_seen_at >= this.now() - SWEPT_DAYS * 86400000;
  }

  /** Active monitors at a store whose server checks can't be relied on: for admins' browsers to check. */
  browserTargets(stores, now, limit = 5) {
    if (!stores.length) return [];
    return this.db.all(`SELECT p.* FROM products p JOIN monitors m ON m.product_id = p.id
      WHERE m.paused = 0 AND p.browser_next_at <= :now AND p.store IN (${stores.map((_, i) => `:s${i}`).join(', ')})
      ORDER BY p.browser_next_at LIMIT :limit`, { now, limit, ...Object.fromEntries(stores.map((s, i) => [`s${i}`, s])) });
  }

  // ---------------------------------------------------------------------------
  // Check log
  // ---------------------------------------------------------------------------
  logCheck({ productId = null, store, url, source, status, price = null, ms = null, error = '' }) {
    this.db.run(`INSERT INTO check_log (product_id, store, url, source, status, price, ms, error, at)
      VALUES (:p, :store, :url, :source, :status, :price, :ms, :error, :at)`,
    { p: productId, store: store || '', url, source, status, price, ms, error: String(error || '').slice(0, 300), at: this.now() });
  }

  /** What the last check that could read the page said, before the latest refused or failed one (null: none). */
  lastReadStatus(productId) {
    const row = this.db.get(`SELECT status FROM check_log WHERE product_id = :p AND status NOT IN ('blocked', 'error')
      AND id < (SELECT MAX(id) FROM check_log WHERE product_id = :p AND status IN ('blocked', 'error')) ORDER BY id DESC LIMIT 1`, { p: productId });
    return row ? row.status : null;
  }

  listLog({ productId = null, store = '', errorsOnly = false, limit = 100 } = {}) {
    const where = ['1 = 1'];
    const params = { limit: Math.min(500, limit) };
    if (productId) { where.push('l.product_id = :p'); params.p = productId; }
    if (store) { where.push('l.store = :store'); params.store = store; }
    if (errorsOnly) where.push("(l.status IN ('blocked', 'error') OR l.error != '')");
    return this.db.all(`SELECT l.*, p.name AS name, p.sku AS sku FROM check_log l LEFT JOIN products p ON p.id = l.product_id
      WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT :limit`, params)
      .map((r) => ({ id: r.id, productId: r.product_id, name: r.name, sku: r.sku, store: r.store, url: r.url, source: r.source, status: r.status, price: r.price, ms: r.ms, error: r.error, at: r.at }));
  }

  /** Forget old log lines and alerts (the price history is small and kept). */
  prune(logDays) {
    this.db.run('DELETE FROM check_log WHERE at < :t', { t: this.now() - logDays * 86400000 });
    this.db.run('DELETE FROM feed_alerts WHERE at < :t', { t: this.now() - 180 * 86400000 });
  }

  // ---------------------------------------------------------------------------
  // Alerts
  // ---------------------------------------------------------------------------
  addAlert(a) {
    const { lastInsertRowid } = this.db.run(`INSERT INTO feed_alerts (product_id, kind, store, sku, name, url, image, category, status, price, previous_price, manual, note, vip, at)
      VALUES (:product_id, :kind, :store, :sku, :name, :url, :image, :category, :status, :price, :previous_price, :manual, :note, :vip, :at)`,
    { previous_price: null, price: null, note: '', image: '', url: '', name: '', status: '', manual: 0, vip: 0, ...a, at: this.now() });
    return this.db.get('SELECT * FROM feed_alerts WHERE id = :id', { id: Number(lastInsertRowid) });
  }

  setPosted(alertId, channels) {
    this.db.run('UPDATE feed_alerts SET posted = :p WHERE id = :id', { p: JSON.stringify(channels), id: alertId });
  }

  /** One alert (a Discord ⚡ Buy button says which). */
  alertById(id) {
    return toAlert(this.db.get('SELECT * FROM feed_alerts WHERE id = :id', { id: Number(id) || 0 }));
  }

  lastAlert(productId, kind) {
    return this.db.get('SELECT * FROM feed_alerts WHERE product_id = :p AND kind = :k ORDER BY at DESC LIMIT 1', { p: productId, k: kind });
  }

  recentAlerts({ limit = 30, before = null, kind = '', category = '', store = '', productId = null } = {}) {
    const where = [unblocked('feed_alerts')];
    const params = { limit: Math.min(100, limit) };
    if (before) { where.push('id < :before'); params.before = Number(before); }
    if (kind === 'price') where.push("kind IN ('price_drop', 'price_rise')");
    else if (kind) { where.push('kind = :kind'); params.kind = kind; }
    if (category) { where.push('category = :category'); params.category = category; }
    if (store) { where.push('store = :store'); params.store = store; }
    if (productId) { where.push('product_id = :p'); params.p = productId; }
    return this.db.all(`SELECT * FROM feed_alerts WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT :limit`, params).map(toAlert);
  }

  // ---------------------------------------------------------------------------
  // Discord alert rules
  // ---------------------------------------------------------------------------
  listRoutes() {
    return this.db.all('SELECT * FROM alert_routes ORDER BY created_at').map(toRoute);
  }

  routeById(id) {
    return toRoute(this.db.get('SELECT * FROM alert_routes WHERE id = :id', { id: String(id || '') }));
  }

  saveRoute(id, r) {
    const row = {
      name: r.name, channel_id: r.channelId, role_id: r.roleId || '', categories: JSON.stringify(r.categories || []),
      stores: JSON.stringify(r.stores || []), kinds: JSON.stringify(r.kinds || ['restock', 'listed']), keywords: r.keywords || '', enabled: r.enabled === false ? 0 : 1,
      fallback: r.fallback ? 1 : 0,
      vip: r.vip ? 1 : 0,
    };
    if (id) {
      this.db.run(`UPDATE alert_routes SET ${Object.keys(row).map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id`, { ...row, id });
      return this.routeById(id);
    }
    const nid = newId('rte');
    this.db.run(`INSERT INTO alert_routes (id, ${Object.keys(row).join(', ')}, created_at) VALUES (:id, ${Object.keys(row).map((c) => `:${c}`).join(', ')}, :t)`, { ...row, id: nid, t: this.now() });
    return this.routeById(nid);
  }

  deleteRoute(id) {
    return this.db.run('DELETE FROM alert_routes WHERE id = :id', { id }).changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Numbers for the dashboard
  // ---------------------------------------------------------------------------
  overview() {
    const now = this.now();
    const day = now - 86400000;
    const hour = now - 3600000;
    const one = (sql, p = {}) => Object.values(this.db.get(sql, p) || { n: 0 })[0] || 0;
    const checks = this.db.get(`SELECT COUNT(*) AS n, SUM(CASE WHEN status NOT IN ('blocked', 'error') AND error = '' THEN 1 ELSE 0 END) AS ok
      FROM check_log WHERE at >= :h`, { h: hour }) || { n: 0, ok: 0 };
    return {
      monitors: one('SELECT COUNT(*) FROM monitors WHERE paused = 0'),
      paused: one('SELECT COUNT(*) FROM monitors WHERE paused = 1'),
      available: one(`SELECT COUNT(*) FROM products p LEFT JOIN monitors m ON m.product_id = p.id
        WHERE ((m.id IS NOT NULL AND m.paused = 0) OR p.sweep_seen_at >= :d) AND p.status IN ('in_stock', 'preorder') AND ${unblocked('p')}`, { d: day }),
      restocks24h: one("SELECT COUNT(*) FROM feed_alerts WHERE kind = 'restock' AND at >= :d", { d: day }),
      drops24h: one("SELECT COUNT(*) FROM feed_alerts WHERE kind = 'listed' AND at >= :d", { d: day }),
      tracked: one(`SELECT COUNT(*) FROM products p WHERE p.sweep_seen_at >= :d AND ${unblocked('p')}`, { d: day }),
      priceChanges24h: one("SELECT COUNT(*) FROM feed_alerts WHERE kind IN ('price_drop', 'price_rise') AND at >= :d", { d: day }),
      checks1h: checks.n || 0,
      ok1h: checks.ok || 0,
      okRate1h: checks.n ? Math.round(((checks.ok || 0) / checks.n) * 100) : null,
    };
  }

  /** Per store, over the last hour: checks, how many worked, blocked, errors, response time, last success. */
  health() {
    const hour = this.now() - 3600000;
    return this.db.all(`SELECT store, COUNT(*) AS checks,
        SUM(CASE WHEN status NOT IN ('blocked', 'error') AND error = '' THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
        CAST(AVG(ms) AS INTEGER) AS avg_ms, MAX(at) AS last_at,
        MAX(CASE WHEN status NOT IN ('blocked', 'error') AND error = '' THEN at END) AS last_ok_at
      FROM check_log WHERE at >= :h GROUP BY store ORDER BY store`, { h: hour })
      .map((r) => ({ store: r.store, checks: r.checks, ok: r.ok, blocked: r.blocked, errors: r.errors, avgMs: r.avg_ms, lastAt: r.last_at, lastOkAt: r.last_ok_at }));
  }
}
