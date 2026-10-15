// The signed-in member's own data: watchlist, delivery details, alert
// settings, activity and connected browsers. Every handler reads req.user.id
// — there is no parameter that could point at someone else.

import { discordBotConfigured, discordOAuthConfigured } from '../config.js';
import { entitlement } from '../entitlement.js';
import { EXTENSION_VERSION, storeUrl } from '../extension.js';
import { DUMMY_PRODUCTS, STARTER_ITEMS, dummyProductPath } from '../presets.js';
import { DEFAULT_ALERTS, HttpError, alerts as checkAlerts, bad, item as checkItem, num, profiles as checkProfiles, str } from '../schema.js';
import { publicUser } from './auth.js';

const notFound = (what) => new HttpError(404, `${what} not found`);

export function register(router, ctx) {
  const { cfg, repo, limiter, retailers } = ctx;

  const withStore = (it) => {
    if (!it) return it;
    const r = retailers.get(it.store);
    return { ...it, storeName: r ? r.name : it.store, flowStatus: r ? r.flowStatus : 'none' };
  };
  const isAdmin = (req) => req.user.role === 'admin';

  router.get('/api/me', async (req) => ({
    user: publicUser(req.user),
    entitlement: entitlement(req.user, repo.now()),
    app: {
      name: cfg.appName,
      price: cfg.priceDisplay,
      trialDays: cfg.trialDays,
      whop: { configured: ctx.whop.configured, link: !!cfg.whop.checkoutUrl },
      discord: { oauth: discordOAuthConfigured(cfg), bot: discordBotConfigured(cfg), inviteUrl: cfg.discord.inviteUrl },
      email: ctx.mailer.configured,
      supportEmail: cfg.supportEmail,
      limits: cfg.limits,
      extensionVersion: EXTENSION_VERSION,
      host: new URL(cfg.baseUrl).host,
      chromeStoreUrl: storeUrl(cfg, repo),
      monitorIntervalSeconds: cfg.monitor.urlIntervalSeconds,
      browserIntervalSeconds: cfg.monitor.browserIntervalSeconds,
      demo: !!cfg.demoStoreUrl,
      demoStoreUrl: cfg.demoStoreUrl,
    },
  }));

  router.get('/api/retailers', async () => ({ retailers: retailers.publicList() }));

  // --- Watchlist ---------------------------------------------------------------
  router.get('/api/items', async (req) => ({ items: repo.listItems(req.user.id).map(withStore), active: entitlement(req.user, repo.now()).active }));

  router.post('/api/items', async (req) => {
    if (repo.countItems(req.user.id) >= cfg.limits.items) throw bad(`You can watch up to ${cfg.limits.items} SKUs`);
    return withStore(repo.addItem(req.user.id, checkItem(req.body, { retailers, isAdmin: isAdmin(req) })));
  });

  router.put('/api/items/:id', async (req) => {
    const existing = repo.getItem(req.user.id, req.params.id);
    if (!existing) throw notFound('SKU');
    return withStore(repo.updateItem(req.user.id, existing.id, checkItem(req.body, { retailers, existing, isAdmin: isAdmin(req) })));
  });

  router.delete('/api/items/:id', async (req) => {
    if (!repo.deleteItem(req.user.id, req.params.id)) throw notFound('SKU');
    return { ok: true };
  });

  router.post('/api/items/reorder', async (req) => {
    if (!Array.isArray(req.body.ids)) throw bad('ids must be a list');
    return { items: repo.reorderItems(req.user.id, req.body.ids.slice(0, 500)).map(withStore) };
  });

  const addMissing = (userId, list) => {
    let added = 0;
    for (const p of list) {
      if (repo.countItems(userId) >= cfg.limits.items) break;
      const it = checkItem(p, { retailers });
      if (repo.itemBySku(userId, it.store, it.sku)) continue;
      repo.addItem(userId, it);
      added += 1;
    }
    return added;
  };

  router.post('/api/items/starter', async (req) => {
    const added = addMissing(req.user.id, STARTER_ITEMS);
    return { added, items: repo.listItems(req.user.id).map(withStore) };
  });

  // Dummy-store test items (only when DEMO_STORE_URL is set).
  router.post('/api/items/demo', async (req) => {
    if (!cfg.demoStoreUrl) throw new HttpError(404, 'The dummy store is not switched on on this server');
    const list = Object.entries(DUMMY_PRODUCTS).flatMap(([store, products]) => products.slice(0, 2).map((p) => ({
      url: `${cfg.demoStoreUrl}${dummyProductPath(store, p)}`, sku: p.sku, name: `${p.name.replace(/^Pokémon TCG:? /, '')} (dummy ${store})`, price: p.price, quantity: 1,
    })));
    const added = addMissing(req.user.id, list);
    return { added, items: repo.listItems(req.user.id).map(withStore) };
  });

  // Look up your own item for a store + SKU (the ⚡ Buy page opened from a Discord post).
  router.get('/api/items/lookup', async (req) => {
    const it = repo.itemBySku(req.user.id, str(req.query.get('store'), 40), str(req.query.get('sku'), 60));
    return { item: withStore(it) };
  });

  // ⚡ Buy: a one-time code the extension redeems on the product page.
  router.post('/api/items/:id/go', async (req) => {
    if (!limiter.hit(`go:${req.user.id}`, 60, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const it = repo.getItem(req.user.id, req.params.id);
    if (!it) throw notFound('SKU');
    return startBuy(ctx, req.user, it, req.body.quantity);
  }, { entitled: true });

  // "Check now": the next monitor pass (server and your browser) looks at it first.
  router.post('/api/items/:id/check', async (req) => {
    if (!limiter.hit(`check:${req.user.id}`, 20, 10 * 60 * 1000)) throw new HttpError(429, 'You can ask for 20 checks every 10 minutes');
    const it = repo.getItem(req.user.id, req.params.id);
    if (!it) throw notFound('SKU');
    repo.db.run('UPDATE items SET browser_next_at = 0 WHERE id = :id AND user_id = :u', { id: it.id, u: req.user.id });
    if (it.url) repo.db.run('UPDATE page_checks SET next_check_at = 0 WHERE url = :url AND fail_count = 0', { url: it.url });
    return { ok: true };
  }, { entitled: true });

  // --- Delivery details (encrypted with this user's key) ---------------------
  router.get('/api/profiles', async (req) => repo.getProfiles(req.user.id));

  router.put('/api/profiles', async (req) => repo.setData(req.user.id, 'profiles', checkProfiles(req.body, cfg.limits.profiles)));

  // --- Alerts ---------------------------------------------------------------
  router.get('/api/alerts', async (req) => ({ alerts: { ...DEFAULT_ALERTS, ...(repo.getData(req.user.id, 'alerts', {}) || {}) } }));

  router.put('/api/alerts', async (req) => {
    const current = repo.getData(req.user.id, 'alerts', DEFAULT_ALERTS) || DEFAULT_ALERTS;
    return { alerts: repo.setData(req.user.id, 'alerts', checkAlerts(req.body, current)) };
  });

  router.post('/api/alerts/test', async (req) => {
    if (!limiter.hit(`alert-test:${req.user.id}`, 5, 10 * 60 * 1000)) throw new HttpError(429, 'You can send 5 test alerts every 10 minutes');
    const r = await ctx.notifier.notify(req.user.id, {
      type: 'test', level: 'urgent', channel: 'restock',
      title: 'Test alert', message: `This is how ${cfg.appName} restock pings look. You're all set!`, url: `${cfg.baseUrl}/app`,
      buttons: [{ label: 'Open dashboard', url: `${cfg.baseUrl}/app` }],
    });
    return { ok: true, sent: r.sent };
  });

  // --- Activity -------------------------------------------------------------
  router.get('/api/events', async (req) => ({
    events: repo.listEvents(req.user.id, { limit: num(req.query.get('limit'), { min: 1, max: 500, def: 100, int: true }), beforeId: num(req.query.get('before'), { int: true, def: null }) }),
  }));

  router.get('/api/stream', async (req, res) => {
    ctx.hub.subscribe(req.user.id, req, res);
    return { $handled: true };
  });

  // --- Connected browsers (the extension) -----------------------------------
  router.get('/api/devices', async (req) => ({ devices: repo.listDevices(req.user.id) }));

  router.post('/api/devices/pair-code', async (req) => {
    if (!limiter.hit(`paircode:${req.user.id}`, 20, 60 * 60 * 1000)) throw new HttpError(429, 'Too many codes — try again later');
    return repo.createPairCode(req.user.id);
  });

  router.delete('/api/devices/:id', async (req) => {
    if (!repo.deleteDevice(req.user.id, req.params.id)) throw notFound('Browser');
    return { ok: true };
  });
}

/** Make a ⚡ Buy code for one of this user's items: the link opens the product and the extension takes over. */
export function startBuy(ctx, user, it, quantityInput) {
  if (!it.url) throw new HttpError(409, `The product page for SKU ${it.sku} hasn't been found yet — paste its link into the item, or wait for it to be listed`);
  const quantity = num(quantityInput, { min: 1, max: 10, int: true, def: it.quantity });
  if (quantity !== it.quantity) ctx.repo.db.run('UPDATE items SET quantity = :q, updated_at = :t WHERE id = :id AND user_id = :u', { q: quantity, t: ctx.repo.now(), id: it.id, u: user.id });
  const profile = ctx.repo.profileFor(user.id, it.profileId);
  const code = ctx.repo.createGoCode(user.id, it, quantity, profile ? profile.id : null);
  return { url: `${it.url}#mgb-go=${code}`, quantity, item: { ...it, quantity } };
}
