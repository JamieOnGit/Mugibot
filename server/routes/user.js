// The signed-in member's own data: watchlist, delivery details, alert
// settings, activity and connected browsers. Every handler reads req.user.id
// — there is no parameter that could point at someone else.

import { discordBotConfigured, discordOAuthConfigured } from '../config.js';
import { entitlement } from '../entitlement.js';
import { BAGS_EXTENSION_VERSION } from '../bags.js';
import { ACO_EXTENSION_VERSION, EXTENSION_VERSION, REMOTE_EXTENSION_VERSION, storeUrl } from '../extension.js';
import { DUMMY_PRODUCTS, STARTER_ITEMS, dummyProductPath } from '../presets.js';
import { DEFAULT_ALERTS, HttpError, acoSettings, alerts as checkAlerts, bad, cardBackupInfo, item as checkItem, num, profiles as checkProfiles, str } from '../schema.js';
import { publicUser } from './auth.js';

const notFound = (what) => new HttpError(404, `${what} not found`);

export function register(router, ctx) {
  const { cfg, repo, limiter, retailers } = ctx;

  const withStore = (it) => {
    if (!it) return it;
    const r = retailers.get(it.store);
    // acoPlaces: Auto-checkout can press this store's final button (not in another site's frame it doesn't know,
    // nor at a store that only takes PayPal: it stops there). acoStops: why not, for the dashboard.
    const C = r && r.flow && r.flow.checkout;
    const places = !!(C && (!C.inFrame || (C.frames && C.frames.length)) && C.payment !== 'paypal');
    const acoStops = !C || places ? null : C.payment === 'paypal' ? 'paypal' : 'frame';
    return { ...it, storeName: r ? retailers.siteName(it.store, it.url) : it.store, flowStatus: r ? r.flowStatus : 'none', acoCan: !!(r && r.flow), acoPlaces: places, acoStops };
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

  // ⚡ Buy: a one-time code the extension redeems on the store's page.
  router.post('/api/items/:id/go', async (req) => {
    if (!limiter.hit(`go:${req.user.id}`, 60, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const it = repo.getItem(req.user.id, req.params.id);
    if (!it) throw notFound('SKU');
    return startBuy(ctx, req.user, it);
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

  // --- The card's locked backup (made and opened in the extension; routes/ext.js) ----------
  router.get('/api/card-backup', async (req) => ({ backup: cardBackupInfo(repo.getData(req.user.id, 'cardBackup', null)) }));
  router.delete('/api/card-backup', async (req) => {
    repo.deleteData(req.user.id, 'cardBackup');
    repo.addEvent(req.user.id, { type: 'card', level: 'info', message: 'Card backup deleted from your account' });
    ctx.hub.publish(req.user.id, 'card', { backup: null });
    return { ok: true };
  });

  // --- Activity -------------------------------------------------------------
  // (page: one page of the Activity table, newest first, with how many there are in all.)
  router.get('/api/events', async (req) => {
    const limit = num(req.query.get('limit'), { min: 1, max: 500, def: 100, int: true });
    const page = num(req.query.get('page'), { min: 1, max: 100000, def: null, int: true });
    const events = repo.listEvents(req.user.id, { limit, beforeId: num(req.query.get('before'), { int: true, def: null }), offset: page ? (page - 1) * limit : 0 });
    return page ? { events, page, pageSize: limit, total: repo.countEvents(req.user.id) } : { events };
  });

  router.get('/api/stream', async (req, res) => {
    ctx.hub.subscribe(req.user.id, req, res);
    return { $handled: true };
  });

  // --- Auto-checkout (server/aco.js, docs/AUTO-CHECKOUT.md) ---------------------
  // The member's switch and limits, and every run: what triggered it, each step, how it ended and why.
  router.get('/api/aco', async (req) => ({
    settings: ctx.aco.settings(req.user.id),
    today: ctx.aco.today(req.user.id),
    stats: ctx.aco.stats(req.user.id, 30),
    armed: ctx.aco.armedCount(req.user.id),
    extensionVersion: ACO_EXTENSION_VERSION,
    remoteVersion: REMOTE_EXTENSION_VERSION,
    // Your connected browsers: the one that checks out (runs and Discord's ⚡ Buy go there), and which are open now.
    browsers: ctx.aco.browsers(req.user.id),
    runs: ctx.aco.list(req.user.id, num(req.query.get('limit'), { min: 1, max: 200, def: 50, int: true })),
  }));

  router.put('/api/aco', async (req) => {
    const current = ctx.aco.settings(req.user.id);
    const next = acoSettings(req.body, current, repo.now());
    const devices = repo.listDevices(req.user.id);
    if (next.deviceId && !devices.some((d) => d.id === next.deviceId)) {
      if (req.body && req.body.deviceId !== undefined) throw bad("That browser isn't connected to your account");
      next.deviceId = ''; // it was disconnected since: the newest one checks out
    }
    repo.setData(req.user.id, 'aco', next);
    if (next.enabled !== current.enabled) {
      repo.addEvent(req.user.id, { type: 'aco', level: next.enabled ? 'warn' : 'info', message: next.enabled ? `Auto-checkout switched on (${next.mode === 'place' ? 'places orders' : 'stops at the final button'}, up to $${next.maxOrder} an order)` : 'Auto-checkout switched off' });
    }
    if (next.deviceId !== current.deviceId && next.deviceId) {
      repo.addEvent(req.user.id, { type: 'aco', level: 'info', message: `Checkout browser: ${devices.find((d) => d.id === next.deviceId).name} — Auto-checkout and Discord's ⚡ Buy check out there` });
    }
    ctx.hub.publish(req.user.id, 'aco', { settings: true });
    return { settings: next, today: ctx.aco.today(req.user.id), armed: ctx.aco.armedCount(req.user.id), browsers: ctx.aco.browsers(req.user.id) };
  });

  // "Send to my computer": check an item out in your checkout browser from wherever you are (the
  // buy page on a phone, with no extension) — what Discord's ⚡ Buy does (server/aco.js remote()).
  router.post('/api/aco/remote/:id', async (req) => {
    if (!limiter.hit(`aco-remote:${req.user.id}`, 10, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const out = await ctx.aco.remote(req.user.id, str(req.params.id, 40), { price: num(req.body && req.body.price, { min: 0, max: 100000, def: null }) });
    if (out.error) throw new HttpError(409, out.error);
    return out;
  }, { entitled: true });

  // Trigger ACO: a test run for one item, now — as if it had just dropped (the same limits and checks).
  router.post('/api/aco/test/:id', async (req) => {
    if (!limiter.hit(`aco-test:${req.user.id}`, 10, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const out = await ctx.aco.test(req.user.id, str(req.params.id, 40));
    if (out.error === 'not_found') throw notFound('SKU');
    if (out.error) throw new HttpError(409, out.error);
    return { run: out.run };
  }, { entitled: true });

  // Clear cart (server/bags.js): each store's bag in your checkout browser — emptying now, or how it went
  // last time — and emptying one, or all of them (stores: 'all'), from wherever you are.
  router.get('/api/bags', async (req) => {
    const device = ctx.aco.checkoutDevice(req.user.id);
    return {
      stores: ctx.bags.list(req.user.id),
      device: device ? { id: device.id, name: device.name, version: device.version || '', listening: ctx.aco.isListening(device.id) } : null,
      extensionVersion: BAGS_EXTENSION_VERSION,
    };
  });

  router.post('/api/bags/clear', async (req) => {
    // (Each press only queues a store's bag: room for a member pressing Clear cart at every store in turn.)
    if (!limiter.hit(`bags-clear:${req.user.id}`, 60, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const body = req.body || {};
    const stores = body.stores === 'all' ? 'all' : (Array.isArray(body.stores) ? body.stores : [body.store]).map((s) => str(s, 40)).filter(Boolean).slice(0, 40);
    if (stores !== 'all' && !stores.length) throw bad('Which store? (store, or stores: "all")');
    const out = ctx.bags.clear(req.user.id, stores);
    if (out.error) throw new HttpError(409, out.error);
    return out;
  }, { entitled: true });

  // --- Connected browsers (the extension) -----------------------------------
  router.get('/api/devices', async (req) => ({ devices: repo.listDevices(req.user.id) }));

  // The store login monitor: each store, and whether you're signed in there (the latest any of your
  // browsers saw), with where to sign in. Signed in, ⚡ Buy's checkout is faster.
  router.get('/api/logins', async (req) => {
    const devices = repo.listDevices(req.user.id);
    const stores = retailers.list.filter((r) => r.account && retailers.enabled(r) && (!r.demo || cfg.demoStoreUrl)).map((r) => {
      let best = null;
      for (const d of devices) {
        const l = d.logins && d.logins[r.id];
        if (l && (!best || l.at > best.at)) best = { ...l, device: d.name };
      }
      return {
        id: r.id, name: r.name, demo: !!r.demo, signInUrl: `${r.base}${r.account.signIn || ''}`,
        // required: the store only sells to signed-in customers (Amazon: no guest checkout).
        required: !!r.account.required, checked: !!r.account.check, status: best ? best.status : null, at: best ? best.at : null, how: best ? best.how : null, device: best ? best.device : null,
      };
    });
    return { stores, browsers: devices.length };
  });

  router.post('/api/devices/pair-code', async (req) => {
    if (!limiter.hit(`paircode:${req.user.id}`, 20, 60 * 60 * 1000)) throw new HttpError(429, 'Too many codes — try again later');
    return repo.createPairCode(req.user.id);
  });

  router.delete('/api/devices/:id', async (req) => {
    if (!repo.deleteDevice(req.user.id, req.params.id)) throw notFound('Browser');
    return { ok: true };
  });
}

/**
 * Make a ⚡ Buy code for one of this user's items (one of it — no quantities for now). The link
 * opens the store and the extension takes over. Shopify stores whose product option Mugibot
 * knows: the store's own cart link, which opens checkout with the product already in the cart.
 */
export function startBuy(ctx, user, it, { runId = null } = {}) {
  if (!it.url) throw new HttpError(409, `The product page for SKU ${it.sku} hasn't been found yet — paste its link into the item, or wait for it to be listed`);
  const profile = ctx.repo.profileFor(user.id, it.profileId);
  // runId: an Auto-checkout run (server/aco.js) — the code says so when the extension claims it.
  const code = ctx.repo.createGoCode(user.id, it, 1, profile ? profile.id : null, runId);
  const r = ctx.retailers.get(it.store);
  const known = r && r.cartPath && r.cartPath.includes('{variant}') && ctx.catalog ? ctx.catalog.productFor(it.store, it.sku) : null;
  const cart = known && known.variant_id ? ctx.retailers.cartUrl(it.store, { sku: it.sku, variantId: known.variant_id, qty: 1 }) : null;
  return { url: `${cart || it.url}#mgb-go=${code}`, item: it };
}
