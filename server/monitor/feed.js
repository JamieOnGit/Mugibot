// The Monitor feed (docs/MONITORING.md): what each check of a monitored
// product means for everyone. It keeps the product's status, price and image,
// writes the check log and price history, and turns confirmed changes into
// alerts: in the dashboard's live feed and in the Discord channels whose rules
// match.
//
// Alerts fire only on confirmed changes. A blocked or failed check keeps the
// last known status and never alerts. The same product and kind can't alert
// again within the cooldown (kept in the database, so it survives restarts).
//
// The live sweeps (sweep.js) see most products every few seconds. While a
// sweep has seen a product lately, a slower page check of it is only logged:
// the sweep's view is fresher, and two sources taking turns would flip its
// status back and forth.

import { CATEGORIES, categoryFor, toAlert, toProduct } from '../catalog.js';
import { entitlement } from '../entitlement.js';
import { STATUS, STATUS_LABEL, isOrderable } from './status.js';

const FAILED = new Set([STATUS.BLOCKED, STATUS.ERROR]);
// A sweep that saw the product this recently outranks a page check.
export const SWEEP_FRESH_MS = 3 * 60 * 1000;
const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—');

const KIND = {
  restock: { emoji: '🟢', label: 'In stock', color: 0x16a34a },
  preorder: { emoji: '🟣', label: 'Pre-order open', color: 0x7c3aed },
  listed: { emoji: '🆕', label: 'New drop', color: 0x2563eb },
  sold_out: { emoji: '🔴', label: 'Sold out', color: 0xdc2626 },
  price_drop: { emoji: '📉', label: 'Price drop', color: 0x0d9488 },
  price_rise: { emoji: '📈', label: 'Price up', color: 0xd97706 },
};

export class Feed {
  constructor({ cfg, repo, catalog, retailers, notifier, discord, hub, now = () => Date.now() }) {
    Object.assign(this, { cfg, repo, catalog, retailers, notifier, discord, hub, now });
  }

  get browserInterval() {
    return this.cfg.monitor.browserIntervalSeconds * 1000;
  }

  /**
   * One check of a product page (or its search page).
   * r: { status, title, price, image, variantId, error }   info: { source: 'server'|'browser', url, ms }
   */
  async applyCheck(product, r, { source, url, ms = null }) {
    const now = this.now();
    const failed = FAILED.has(r.status);
    this.catalog.logCheck({ productId: product.id, store: product.store, url, source, status: r.status, price: r.price ?? null, ms, error: r.error || '' });
    if (product.status_source === 'sweep' && product.sweep_seen_at && now - product.sweep_seen_at < SWEEP_FRESH_MS) return product;

    if (failed) {
      // An admin's browser is doing the checking for this store: a refused server check changes nothing.
      if (source === 'server' && product.status_source === 'browser' && product.checked_at && now - product.checked_at < 3 * this.browserInterval) return product;
      const fails = product.fail_count + 1;
      // Keep the last confirmed status; after 3 failures in a row, show the failure (it never alerts).
      const keep = product.confirmed && fails < 3;
      const fresh = this.catalog.updateProduct(product.id, {
        fail_count: fails, error: r.error || STATUS_LABEL[r.status], checked_at: now,
        status: keep ? product.status : r.status, confirmed: keep ? 1 : 0,
      });
      if (fresh.status !== product.status) this.broadcast('product', toProduct(fresh));
      return fresh;
    }

    const prev = product.status;
    const prevPrice = product.price;
    const price = typeof r.price === 'number' && Number.isFinite(r.price) && r.price > 0 ? Math.round(r.price * 100) / 100 : null;
    const set = { status: r.status, status_source: source, confirmed: 1, fail_count: 0, error: '', checked_at: now, last_ok_at: now };
    if (r.status !== prev) set.status_at = now;
    if (r.title && !product.name) set.name = String(r.title).slice(0, 200);
    if (r.image && /^https?:\/\//.test(r.image) && r.image !== product.image) set.image = String(r.image).slice(0, 1000);
    if (r.variantId) set.variant_id = String(r.variantId).slice(0, 40);
    if (product.category === 'other' && !product.name && r.title) set.category = categoryFor(r.title);
    const priceMoved = price !== null && (prevPrice === null || prevPrice === undefined || Math.abs(price - prevPrice) >= 0.005);
    if (priceMoved) {
      set.price = price;
      set.previous_price = prevPrice ?? null;
      set.price_at = now;
      this.catalog.addPrice(product.id, price);
    }
    const fresh = this.catalog.updateProduct(product.id, set);
    if (r.status !== prev || priceMoved) this.broadcast('product', toProduct(fresh));
    await this.transitions(product, fresh);
    return fresh;
  }

  /**
   * A monitored product's confirmed change → the alerts its monitor asks for.
   * The first successful check only sets the scene; changes after it are news.
   */
  async transitions(before, fresh) {
    let prev = before.status;
    const wasKnown = prev !== 'pending' && !!before.last_ok_at;
    if (!wasKnown) return;
    // Back after the store refused the checks for a while: compared with what the last check that could
    // read the page said (in stock then and now isn't a restock; with nothing to compare, nothing alerts).
    if (FAILED.has(prev)) {
      prev = this.catalog.lastReadStatus(before.id);
      if (!prev) return;
    }
    // Its stock read for the first time (a search that doesn't say it, like City Beach's): nothing
    // to compare with, so no stock alert — it's how it was, not a change.
    if (prev === STATUS.UNKNOWN) prev = fresh.status;
    if (isOrderable(fresh.status) && !isOrderable(prev)) {
      await this.alert(fresh, 'restock', { note: prev === STATUS.NOT_LISTED ? 'Just listed.' : '' });
    } else if (prev === STATUS.NOT_LISTED && ![STATUS.NOT_LISTED, STATUS.NOT_FOUND, STATUS.UNKNOWN].includes(fresh.status)) {
      await this.alert(fresh, 'listed');
    } else if (isOrderable(prev) && fresh.status === STATUS.OUT_OF_STOCK) {
      await this.alert(fresh, 'sold_out');
    }
    const price = fresh.price;
    const prevPrice = before.price;
    if (typeof price === 'number' && typeof prevPrice === 'number' && prevPrice > 0 && Math.abs(price - prevPrice) >= 0.005) {
      const pct = ((price - prevPrice) / prevPrice) * 100;
      if (Math.abs(pct) >= this.cfg.monitor.priceChangePercent) await this.alert(fresh, pct < 0 ? 'price_drop' : 'price_rise', { pct });
    }
  }

  /**
   * Send an alert for a product: kind 'restock' | 'listed' | 'sold_out' | 'price_drop' | 'price_rise'.
   * opts: { manual (an admin reported it: skips the cooldown), announce (an admin's 📣 SKU: no monitor needed),
   *         sweep (a live sweep found it: no monitor needed, the sweep settings decide), note, pct,
   *         detectedAt (when the store's answer came in: the alert says how long it took to reach dashboards),
   *         vip (a VIP watch found it: monitor/vip.js — a product with a VIP monitor is one too) }
   * Returns the saved alert, or null when a monitor isn't asking for it or the cooldown is running.
   */
  async alert(product, kind, { manual = false, announce = false, sweep = false, note = '', pct = null, detectedAt = null, vip = false } = {}) {
    // On the blacklist (Admin → Blacklist): never alerts. (An admin's own restock ping still goes out.)
    if (!manual && this.catalog.isBlocked(product.store, product.sku)) return null;
    const monitor = this.catalog.monitorForProduct(product.id);
    if (!manual && !announce && !sweep) {
      if (!monitor || monitor.paused) return null;
      let kinds = [];
      try { kinds = JSON.parse(monitor.kinds); } catch { kinds = []; }
      if (!kinds.includes(kind)) return null;
    }
    if (!manual) {
      const last = this.catalog.lastAlert(product.id, kind);
      if (last && this.now() - last.at < this.cfg.monitor.alertCooldownSeconds * 1000) return null;
    }
    const row = this.catalog.addAlert({
      product_id: product.id, kind, store: product.store, sku: product.sku, name: product.name || product.sku, url: product.url || '',
      image: product.image || '', category: product.category, status: product.status, price: product.price ?? null,
      previous_price: product.previous_price ?? null, manual: manual ? 1 : 0, vip: vip || (monitor && monitor.vip_watch) ? 1 : 0, note: [note, pct !== null ? `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` : ''].filter(Boolean).join(' '),
    });
    const alert = { ...toAlert(row), ttnMs: detectedAt ? Math.max(0, this.now() - detectedAt) : null };
    this.broadcast('feed', alert);
    const posted = await this.post(alert, product);
    if (posted.length) this.catalog.setPosted(row.id, posted);
    return { ...alert, posted };
  }

  /**
   * The Discord alert rules that want this alert. A catch-all rule (fallback: misc-retailers) only
   * gets what no other rule took. With no rules, the restock channel gets restocks and listings.
   * A rule for a store also takes its dummy-store copy's alerts. A VIP drop goes to the VIP rules
   * (#vip-drop) only — to the others only while there's no VIP rule — and nothing else goes there.
   */
  routesFor(alert) {
    const enabled = this.catalog.listRoutes().filter((r) => r.enabled);
    const vip = enabled.filter((r) => r.vip);
    if (alert.vip && vip.length) return vip.filter((r) => r.kinds.includes(alert.kind));
    let routes = enabled.filter((r) => !r.vip);
    if (!routes.length && this.cfg.discord.restockChannelId) {
      routes = [{ id: 'default', name: 'Restock channel', channelId: this.cfg.discord.restockChannelId, roleId: this.cfg.discord.restockRoleId || '', categories: [], stores: [], kinds: ['restock', 'listed'], keywords: '' }];
    }
    const name = String(alert.name || '').toLowerCase();
    const store = String(alert.store || '');
    const wants = (r) => (!r.categories.length || r.categories.includes(alert.category))
      && (!r.stores.length || r.stores.includes(store) || r.stores.includes(store.replace(/^demo-/, '')))
      && r.kinds.includes(alert.kind)
      && (!r.keywords.trim() || r.keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean).some((k) => name.includes(k)));
    const taken = routes.filter((r) => !r.fallback && wants(r));
    return taken.length ? taken : routes.filter((r) => r.fallback && wants(r));
  }

  async post(alert, product) {
    if (!this.discord.botReady) return [];
    const routes = this.routesFor(alert);
    const posted = [];
    for (const r of routes) {
      const ok = await this.discord.post(r.channelId, this.message(alert, product, { mention: r.roleId ? `<@&${r.roleId}>` : '' }));
      if (ok && !posted.includes(r.channelId)) posted.push(r.channelId);
    }
    return posted;
  }

  /** The Discord embed: image, store, price, stock, SKU, category, time; ⚡ Buy and quick links. */
  message(alert, product = {}, { mention = '' } = {}) {
    const k = alert.kind === 'restock' && alert.status === STATUS.PREORDER ? KIND.preorder : KIND[alert.kind] || KIND.restock;
    const storeName = this.retailers.name(alert.store);
    const buttons = [];
    // One click to the store, with whoever presses it's own checkout (signed: see Notifier.alertBuyLink).
    if (alert.kind !== 'sold_out') buttons.push({ label: '⚡ Buy with Mugibot', url: this.notifier.alertBuyLink(alert) });
    if (alert.url) buttons.push({ label: 'Open product', url: alert.url });
    const cart = alert.kind !== 'sold_out' && this.retailers.cartUrl(alert.store, { sku: alert.sku, variantId: product.variant_id || product.variantId });
    if (cart) buttons.push({ label: 'Add to cart', url: cart });
    if (alert.productId) buttons.push({ label: 'Price history', url: `${this.cfg.baseUrl}/app#monitor/${alert.productId}` });
    const was = typeof alert.previousPrice === 'number' && alert.previousPrice !== alert.price ? ` (was ${money(alert.previousPrice)})` : '';
    const fields = [
      { name: 'Store', value: storeName, inline: true },
      { name: 'Price', value: `${money(alert.price)}${was}`, inline: true },
      { name: 'Stock', value: STATUS_LABEL[alert.status] || alert.status || '—', inline: true },
      { name: 'SKU', value: String(alert.sku), inline: true },
      { name: 'Category', value: CATEGORIES[alert.category] || 'Other', inline: true },
    ];
    return this.notifier.message({
      level: 'urgent', color: null,
      title: `${alert.vip ? '⭐ VIP · ' : ''}${k.emoji} ${k.label}: ${alert.name}`,
      message: [alert.note, alert.manual ? 'Reported by an admin.' : ''].filter(Boolean).join('\n'),
      url: alert.url, image: alert.image, fields, footer: `${this.cfg.appName} Monitor`, embedColor: k.color, buttons,
    }, { mention });
  }

  /** Live updates for every open dashboard of a member (or admin). */
  broadcast(type, data) {
    for (const userId of this.hub.userIds()) {
      const u = this.repo.userById(userId);
      if (u && !u.disabled && entitlement(u, this.now()).active) this.hub.publish(userId, `monitor-${type}`, data);
    }
  }
}
