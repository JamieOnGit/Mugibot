// VIP drops (docs/MONITORING.md → VIP drops): drops an admin picks out, alerted in the VIP channel
// (#vip-drop) instead of the store channels, and checked every few seconds around their drop time.
//
// A watch is either:
// - a store and the words in the product's name ("pokemon skate" at City Beach): searched at that
//   store along with the sweep's keywords (every other search; only these, every few seconds, in
//   the drop window). Anything whose name has every word counts, trading cards or not.
// - a product page: a VIP monitor on it.
// What a keyword watch finds gets a VIP monitor too, so its page is read straight away (and every
// few seconds in the window) for its stock. With "Auto-checkout it for me", it also goes on that
// admin's watchlist, armed up to their max price, so their browser checks out the moment it's in
// stock — but only what drops after the watch was added: a new listing, or something that wasn't on
// sale when the watch first read it. Never what was already on sale when the watch was added (a broad
// watch would otherwise buy everything that matches). What the watch itself saw decides
// (monitor/sightings.js), never the catalogue's last status.

import { PRODUCTS_FOR_PAGE, toProduct } from '../catalog.js';
import { newId } from '../crypto.js';
import { bad, bool, httpUrl, item as checkItem, num, str } from '../schema.js';
import { mentions, norm } from './listing.js';
import { STATUS, isOrderable } from './status.js';

// Fast from 15 minutes before the drop time to 3 hours after it.
export const VIP_BEFORE_MS = 15 * 60 * 1000;
export const VIP_AFTER_MS = 3 * 3600 * 1000;
const MAX_WATCHES = 30;
const KINDS = ['restock', 'listed', 'price_drop'];
export const VIP_NOTE = 'VIP drop';

// Auto-checkout for one thing a watch found: 'armed', 'pending' (its page is being read: armed if
// it isn't on sale yet), 'skipped' (it was on sale already when the watch was added) or ''. (Found
// before this was kept: armed when found.)
const armOf = (w, f) => (w.acoUser && w.maxPrice !== null ? f.arm || 'armed' : '');

function toWatch(r) {
  let found = [];
  try { found = JSON.parse(r.found || '[]'); } catch { found = []; }
  return r && {
    id: r.id, store: r.store, words: r.words, url: r.url, label: r.label, dropAt: r.drop_at ?? null,
    acoUser: r.aco_user || null, maxPrice: r.max_price ?? null, found, createdBy: r.created_by, createdAt: r.created_at,
  };
}

export class Vip {
  constructor({ cfg, db, repo, catalog, retailers, hub, now = () => Date.now() }) {
    Object.assign(this, { cfg, db, repo, catalog, retailers, hub, now });
    this.cache = null;
  }

  get fastSeconds() { return Math.max(2, this.cfg.monitor.vipFastSeconds || 5); }
  get slowSeconds() { return Math.max(this.fastSeconds, this.cfg.monitor.vipSlowSeconds || 15); }
  get sweepSeconds() { return Math.max(2, this.cfg.monitor.vipSweepSeconds || 4); }

  /** Every watch (cached: the sweeps ask on every search). */
  watches() {
    if (!this.cache) this.cache = this.db.all('SELECT * FROM vip_watches ORDER BY created_at').map(toWatch);
    return this.cache;
  }

  get(id) {
    return this.watches().find((w) => w.id === id) || null;
  }

  changed() {
    this.cache = null;
  }

  /** In its drop window: from 15 minutes before the drop time to 3 hours after. */
  inWindow(w, now = this.now()) {
    return !!w.dropAt && now >= w.dropAt - VIP_BEFORE_MS && now <= w.dropAt + VIP_AFTER_MS;
  }

  /** The keyword watches searched at a store. */
  termsFor(storeId) {
    return this.watches().filter((w) => w.words && w.store === storeId);
  }

  /** A store with a keyword watch in its drop window: searched for it every few seconds. */
  fast(storeId, now = this.now()) {
    return this.termsFor(storeId).some((w) => this.inWindow(w, now));
  }

  /** The watch a product at a store counts for: every word of it in the name (only: that one watch). */
  matchFor(storeId, title, only = null) {
    const name = norm(title);
    if (!name) return null;
    return this.termsFor(storeId).find((w) => (!only || w.id === only) && mentions(name, w.words)) || null;
  }

  /** Every keyword watch at a store whose words are in this name (what it sees: monitor/sightings.js). */
  watchesFor(storeId, title) {
    const name = norm(title);
    return name ? this.termsFor(storeId).filter((w) => mentions(name, w.words)) : [];
  }

  /** How often a VIP monitor's page is read (seconds): every few seconds in its drop window. Null: not a VIP page. */
  pageSeconds(url, now = this.now()) {
    if (!this.watches().length) return null;
    const rows = this.db.all(`SELECT w.drop_at FROM page_checks c JOIN products p ON ${PRODUCTS_FOR_PAGE}
      JOIN monitors m ON m.product_id = p.id AND m.paused = 0 JOIN vip_watches w ON w.id = m.vip_watch WHERE c.url = :url`, { url });
    if (!rows.length) return null;
    return rows.some((r) => this.inWindow({ dropAt: r.drop_at }, now)) ? this.fastSeconds : this.slowSeconds;
  }

  /** The watches for the dashboard, with what each found (and whether it's checking fast now). */
  view() {
    const now = this.now();
    return this.watches().map((w) => {
      const r = w.store ? this.retailers.get(w.store) : null;
      const owner = w.acoUser ? this.repo.userById(w.acoUser) : null;
      const found = w.found.map((f) => [f, this.catalog.productById(f.productId)]).filter(([, p]) => p).map(([f, p]) => {
        const x = toProduct(p);
        return { id: x.id, name: x.name, url: x.url, status: x.status, price: x.price, store: x.store, image: x.image, arm: armOf(w, f) };
      });
      return { ...w, storeName: r ? r.name : '', acoUserName: owner ? owner.username : '', found, fastNow: this.inWindow(w, now) };
    });
  }

  /**
   * An admin's new watch. input: { store, words } or { url }, plus label, dropAt (ms), aco (buy it
   * for me: needs maxPrice). monitorAdmin: MonitorAdmin (a link watch's monitor).
   */
  add(input, user, monitorAdmin) {
    if (this.watches().length >= MAX_WATCHES) throw bad(`${MAX_WATCHES} VIP watches is the most — remove one first`);
    const url = httpUrl(input.url, 'Link', { required: false });
    const label = str(input.label, 80);
    let dropAt = null;
    if (input.dropAt !== undefined && input.dropAt !== null && input.dropAt !== '') {
      dropAt = num(input.dropAt, { min: this.now() - 7 * 86400000, max: this.now() + 90 * 86400000, int: true, def: null });
      if (dropAt === null) throw bad('Drop time: pick a date within the next 90 days, or leave it empty');
    }
    const aco = bool(input.aco, false);
    const maxPrice = aco ? num(input.maxPrice, { min: 1, max: 100000, def: null }) : null;
    if (aco && maxPrice === null) throw bad('Set a max price to auto-checkout it: Mugibot never pays more than that');
    let store = '';
    let words = '';
    if (!url) {
      store = str(input.store, 40);
      const r = this.retailers.get(store);
      if (!r || !r.sweep) throw bad('Choose a store Mugibot searches, or paste a product link');
      words = norm(str(input.words, 60)).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (words.length < 3) throw bad('Words in its name, e.g. "pokemon skate" (every word must be in the name)');
      if (this.watches().some((w) => w.store === store && w.words === words)) throw bad('That store and words are already a VIP watch');
      if (aco && !r.flow) throw bad(`Auto-checkout works at stores Mugibot has a checkout for — not ${r.name} yet`);
    }
    const id = newId('vip');
    this.db.run(`INSERT INTO vip_watches (id, store, words, url, label, drop_at, aco_user, max_price, created_by, created_at)
      VALUES (:id, :store, :words, :url, :label, :drop, :acoUser, :max, :by, :t)`, {
      id, store, words, url: url || '', label, drop: dropAt, acoUser: aco && user ? user.id : null, max: maxPrice, by: user ? user.id : null, t: this.now(),
    });
    this.changed();
    try {
      if (url) {
        const { product } = monitorAdmin.add({ url, kinds: KINDS, note: VIP_NOTE }, user);
        // (Already listed: armed once its page says it isn't on sale yet.)
        this.found(this.get(id), this.catalog.productById(product.id)).catch((e) => this.cfg.log('[vip]', e.message));
      }
    } catch (e) {
      this.db.run('DELETE FROM vip_watches WHERE id = :id', { id });
      this.changed();
      throw e;
    }
    if (user) this.repo.audit(user.id, null, 'vip-add', url || `${store}: ${words}`);
    return this.view().find((w) => w.id === id);
  }

  /**
   * Removed: its VIP monitors go (the ones it made; a monitor that was there before stays, as an
   * ordinary one), and what it armed for Auto-checkout is disarmed.
   */
  remove(id, user) {
    const w = this.get(String(id || ''));
    if (!w) return false;
    for (const f of w.found.filter((x) => armOf(w, x) === 'armed')) {
      const p = this.catalog.productById(f.productId);
      if (!p) continue;
      const item = this.repo.itemBySku(w.acoUser, p.store, p.sku);
      if (!item || !item.aco) continue;
      this.db.run('UPDATE items SET aco = 0, aco_at = NULL WHERE id = :id', { id: item.id });
      if (this.hub) this.hub.publish(w.acoUser, 'watch', { id: item.id, aco: false });
    }
    this.db.run('DELETE FROM monitors WHERE vip_watch = :id AND note = :note', { id: w.id, note: VIP_NOTE });
    this.db.run('UPDATE monitors SET vip_watch = NULL WHERE vip_watch = :id', { id: w.id });
    this.db.run('DELETE FROM vip_watches WHERE id = :id', { id: w.id });
    if (this.sightings) this.sightings.forget(w.id);
    this.changed();
    if (user) this.repo.audit(user.id, null, 'vip-remove', w.url || `${w.store}: ${w.words}`);
    return true;
  }

  /**
   * A watch found a product (a sweep's search, or its link): a VIP monitor on it, its page read now (unless it's
   * backing off: the store refused it), and — when an admin asked — on their watchlist armed for Auto-checkout, by
   * what the watch saw of it (monitor/sightings.js): verdict ('new': bought at once when status says it's on sale;
   * 'armed'; 'skipped'; 'pending': its page decides — checked()). status: this read's stock (or null). later: the
   * search's list for the alerts. Returns once any Auto-checkout run it starts is made.
   */
  found(w, product, { verdict = null, status = null, later = null } = {}) {
    if (!w || !product) return Promise.resolve();
    let monitor = this.catalog.monitorForProduct(product.id);
    if (!monitor) monitor = this.catalog.addMonitor(product.id, { kinds: KINDS, note: VIP_NOTE, createdBy: w.createdBy }).monitor;
    if (monitor.vip_watch !== w.id) this.db.run('UPDATE monitors SET vip_watch = :w, paused = 0 WHERE id = :id', { w: w.id, id: monitor.id });
    const isNew = !w.found.some((f) => f.productId === product.id);
    if (isNew) {
      // (Its link watch: nothing read yet.)
      if (!verdict && this.sightings) verdict = this.sightings.see(w, product.store, [product.sku], { how: 'link' }).verdict;
      this.saveFound(w, [...w.found, { productId: product.id, at: this.now(), ...(this.wants(w, product) ? { arm: 'pending' } : {}) }]);
      this.repo.ensurePageFor({ store: product.store, sku: product.sku, url: product.url });
      if (product.url) this.db.run('UPDATE page_checks SET next_check_at = 0 WHERE url = :url AND fail_count = 0', { url: product.url });
    }
    return this.settle(this.get(w.id) || w, product, verdict || 'pending', status, later);
  }

  /** Does this watch arm what it finds (an admin asked, with a max price) — and can this be bought (it has a link)? */
  wants(w, product) {
    return !!(w.acoUser && w.maxPrice !== null && product && product.url);
  }

  saveFound(w, found) {
    this.db.run('UPDATE vip_watches SET found = :f WHERE id = :id', { id: w.id, f: JSON.stringify(found.slice(-20)) });
    this.changed();
  }

  /**
   * A find's Auto-checkout, by what the watch saw of it: armed ('new', or 'armed': not on sale when the watch first
   * read it), skipped (on sale then: never bought — said in the admin's activity), or still waiting for its page.
   * Each find is armed once: once it's bought and disarmed, it stays that way. 'new' and on sale now (status): its
   * Auto-checkout run starts at once.
   */
  async settle(w, product, verdict, status = null, later = null) {
    const f = w.found.find((x) => x.productId === product.id);
    // (Not asked for when it was found, or found before this was kept, or armed already.)
    if (!f || !f.arm || f.arm === 'armed' || !this.wants(w, product)) return;
    // (A find from before the watch kept what it saw: never new to it, and skipped stays skipped.)
    if (this.sightings) verdict = this.sightings.findVerdict(w, product.store, [product.sku], verdict, { foundAt: f.at, arm: f.arm });
    const arm = verdict === 'new' || verdict === 'armed' ? 'armed' : verdict;
    if (arm === f.arm || arm === 'pending') return;
    this.saveFound(w, w.found.map((x) => (x === f ? { ...x, arm } : x)));
    if (arm === 'skipped') {
      this.repo.addEvent(w.acoUser, { type: 'aco', level: 'info', message: `VIP watch: ${product.name || product.sku} was on sale already when the watch was added, so it isn't armed — ⚡ Buy it yourself if you want it`, name: product.name, sku: product.sku, url: product.url || null });
      return;
    }
    const item = this.arm(w, product, verdict === 'armed' ? status : null);
    if (!item || verdict !== 'new' || !this.monitor) return;
    // (New and on sale — as this read says, or as its last read did: bought now. Its stock not known yet: its first read
    //  that says on sale is the drop.)
    const row = this.db.get('SELECT status FROM items WHERE id = :id', { id: item.id });
    const onSale = isOrderable(status) ? status : row && isOrderable(row.status) ? row.status : null;
    if (onSale) await this.buyNow(item, product, onSale, later);
    else if (row && row.status === STATUS.UNKNOWN) this.db.run('UPDATE items SET status = :st WHERE id = :id', { st: STATUS.NOT_LISTED, id: item.id });
  }

  /** A new listing that's on sale as it's found: its Auto-checkout run now (its alerts on later), not at its next read. */
  async buyNow(item, product, status, later) {
    // (On the watchlist already as on sale: this read is its drop all the same.)
    this.db.run("UPDATE items SET status = 'pending' WHERE id = :id", { id: item.id });
    const row = this.db.get('SELECT * FROM items WHERE id = :id', { id: item.id });
    if (row) await this.monitor.applyResult(row, { status, title: product.name || null, price: typeof product.price === 'number' ? product.price : null, error: '', variantId: product.variant_id || null }, 'sweep', { later });
  }

  /**
   * A product's page was read (monitor/index.js; reading: what that read said — on sale or not yet): each watch that
   * found it records it, and a find waiting on its page is settled — armed if it isn't on sale, left alone if it is.
   * later: the read's list for the alerts.
   */
  async checked(product, reading, later = null) {
    if (!product || !reading || !this.sightings || !this.watches().length) return;
    for (const w of this.watches()) {
      if (!w.found.some((x) => x.productId === product.id)) continue;
      const { verdict } = this.sightings.see(w, product.store, [product.sku], { reading, how: 'page' });
      await this.settle(w, product, verdict, product.status, later);
    }
  }

  /**
   * On the admin's watchlist, armed for Auto-checkout up to the watch's max price. status: what its
   * page says now (not on sale yet), so the moment it goes on sale is a drop for the item too.
   */
  arm(w, product, status = null) {
    const user = this.repo.userById(w.acoUser);
    const r = this.retailers.get(product.store);
    if (!user || user.disabled || !r || !r.flow) return null;
    const existing = this.repo.itemBySku(user.id, product.store, product.sku);
    if (existing && existing.aco) return existing;
    try {
      let saved;
      if (existing) {
        saved = this.repo.updateItem(user.id, existing.id, checkItem({ aco: true, maxPrice: existing.maxPrice ?? w.maxPrice, monitor: true }, { retailers: this.retailers, existing, isAdmin: true }));
      } else {
        if (this.repo.countItems(user.id) >= this.cfg.limits.items) return null;
        saved = this.repo.addItem(user.id, checkItem({ url: product.url, sku: product.sku, name: product.name || product.sku, maxPrice: w.maxPrice, aco: true, monitor: true }, { retailers: this.retailers, isAdmin: true }));
      }
      if (status && !isOrderable(status)) {
        this.db.run("UPDATE items SET status = :st, status_source = 'server', status_at = :t, checked_at = :t WHERE id = :id", { st: status, t: this.now(), id: saved.id });
      }
      this.repo.addEvent(user.id, { type: 'aco', level: 'warn', message: `VIP drop: ${saved.name} armed for Auto-checkout, up to $${Number(saved.maxPrice).toFixed(2)}`, name: saved.name, sku: saved.sku, url: saved.url || null });
      if (this.hub) this.hub.publish(user.id, 'watch', { id: saved.id, added: true });
      return saved;
    } catch (e) {
      this.cfg.log('[vip]', e.message);
      return null;
    }
  }
}
