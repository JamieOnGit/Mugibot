// Adding, changing and removing monitors and Discord alert rules — shared by
// the dashboard (routes/monitor.js) and the /monitor slash command, so both
// check input the same way.

import { ALERT_KINDS, CATEGORIES, DEFAULT_KINDS, toMonitor, toProduct } from '../catalog.js';
import { bad, bool, item as checkItem, num, str } from '../schema.js';

const SNOWFLAKE = /^\d{5,25}$/;

function kindsFrom(v, { required = false } = {}) {
  if (v === undefined) return undefined;
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((k) => String(k).trim()).filter((k) => ALERT_KINDS.includes(k));
  if (required && !list.length) throw bad('Choose at least one kind of alert');
  return [...new Set(list)];
}

function categoryFrom(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const c = String(v).toLowerCase().replace(/[^a-z]/g, '');
  const key = { pokemon: 'pokemon', onepiece: 'onepiece', other: 'other' }[c];
  if (!key) throw bad(`Category must be one of: ${Object.values(CATEGORIES).join(', ')}`);
  return key;
}

export class MonitorAdmin {
  constructor(ctx) {
    this.ctx = ctx;
  }

  get catalog() { return this.ctx.catalog; }

  intervalFrom(v) {
    if (v === undefined) return undefined;
    if (v === null || v === '' || v === 0) return null;
    return num(v, { min: this.ctx.cfg.monitor.minIntervalSeconds, max: 3600, int: true, def: null });
  }

  /** The page the monitor loop checks for a product: its own page, or the store's search for its SKU. */
  pageFor(product) {
    if (product.url) return product.url;
    const r = this.ctx.retailers.get(product.store);
    return r ? this.ctx.retailers.searchUrl(r, product.sku) : null;
  }

  checkNow(product) {
    this.ctx.repo.ensurePageFor({ store: product.store, sku: product.sku, url: product.url });
    const page = this.pageFor(product);
    if (page) this.ctx.db.run('UPDATE page_checks SET next_check_at = 0 WHERE url = :url', { url: page });
    this.ctx.db.run('UPDATE products SET browser_next_at = 0 WHERE id = :id', { id: product.id });
  }

  /** input: { url } or { store, sku }, plus name, category, intervalSeconds, kinds, note. */
  add(input, user) {
    const parsed = checkItem({ url: input.url, store: input.store, sku: input.sku, name: input.name }, { retailers: this.ctx.retailers });
    const category = categoryFrom(input.category);
    const product = this.catalog.upsertProduct({ store: parsed.store, sku: parsed.sku, url: parsed.url, name: str(input.name, 120), category });
    const { monitor, created } = this.catalog.addMonitor(product.id, {
      intervalSeconds: this.intervalFrom(input.intervalSeconds) ?? null,
      kinds: kindsFrom(input.kinds, { required: true }) ?? DEFAULT_KINDS,
      note: str(input.note, 200),
      createdBy: user ? user.id : null,
    });
    this.checkNow(product);
    if (created) this.ctx.repo.audit(user ? user.id : null, null, 'monitor-add', `${parsed.store} ${parsed.sku}`);
    return { product: toProduct(this.catalog.productById(product.id)), monitor: toMonitor(monitor), created };
  }

  update(id, input, user) {
    const m = this.catalog.monitorById(id);
    if (!m) throw bad('That monitor no longer exists');
    const product = this.catalog.productById(m.product_id);
    const set = {};
    const category = categoryFrom(input.category);
    if (category) set.category = category;
    if (input.name !== undefined && str(input.name, 120)) set.name = str(input.name, 120);
    if (Object.keys(set).length) this.catalog.updateProduct(product.id, set);
    const paused = input.paused === undefined ? undefined : bool(input.paused);
    const fresh = this.catalog.updateMonitor(id, {
      intervalSeconds: this.intervalFrom(input.intervalSeconds),
      paused,
      kinds: kindsFrom(input.kinds, { required: input.kinds !== undefined }),
      note: input.note === undefined ? undefined : str(input.note, 200),
    });
    if (paused === false) this.checkNow(product);
    if (paused !== undefined) this.ctx.repo.audit(user ? user.id : null, null, paused ? 'monitor-pause' : 'monitor-resume', `${product.store} ${product.sku}`);
    return { product: toProduct(this.catalog.productById(product.id)), monitor: toMonitor(fresh) };
  }

  remove(id, user) {
    const m = this.catalog.monitorById(id);
    if (!m) throw bad('That monitor no longer exists');
    const product = this.catalog.productById(m.product_id);
    this.catalog.deleteMonitor(id);
    this.ctx.repo.audit(user ? user.id : null, null, 'monitor-remove', `${product.store} ${product.sku}`);
    return { ok: true, product: toProduct(product) };
  }

  route(input, existing = null) {
    const src = { ...(existing || {}), ...(input || {}) };
    const name = str(src.name, 60);
    if (!name) throw bad('Give the rule a name, e.g. "Pokémon restocks"');
    const channelId = str(src.channelId, 30);
    if (!SNOWFLAKE.test(channelId)) throw bad('Channel ID: right-click the channel in Discord → Copy Channel ID (Developer Mode on)');
    const roleId = str(src.roleId, 30);
    if (roleId && !SNOWFLAKE.test(roleId)) throw bad('Role ID: Server Settings → Roles → right-click the role → Copy Role ID, or leave it empty');
    const categories = [...new Set((src.categories || []).map((c) => categoryFrom(c)).filter(Boolean))];
    const stores = [...new Set((src.stores || []).map((s) => str(s, 40)).filter((s) => this.ctx.retailers.get(s)))];
    return {
      name, channelId, roleId, categories, stores,
      kinds: kindsFrom(src.kinds, { required: true }) || ['restock', 'listed'],
      keywords: str(src.keywords, 200),
      enabled: bool(src.enabled, true),
    };
  }

  saveRoute(id, input) {
    const existing = id ? this.catalog.routeById(id) : null;
    if (id && !existing) throw bad('That alert rule no longer exists');
    if (!id && this.catalog.listRoutes().length >= 25) throw bad('25 alert rules is the most');
    return this.catalog.saveRoute(id, this.route(input, existing));
  }
}
