// The Monitor tab (docs/MONITORING.md). Members with an active membership see
// the shared feed: live alerts, products, price history. Admins also manage
// monitors and Discord alert rules, and see the check log and health.

import { CATEGORIES, toMonitor, toProduct } from '../catalog.js';
import { MonitorAdmin } from '../monitor/manage.js';
import { HttpError, bad, str } from '../schema.js';

export function register(router, ctx) {
  const { cfg, catalog, retailers, monitor, feed, limiter } = ctx;
  const manage = new MonitorAdmin(ctx);
  ctx.monitorAdmin = manage;
  const member = { entitled: true };
  const admin = { auth: 'admin' };
  const isAdmin = (req) => req.user && req.user.role === 'admin';

  // --- Everyone with a membership --------------------------------------------------
  router.get('/api/monitor', async (req) => ({
    overview: catalog.overview(),
    alerts: catalog.recentAlerts({ limit: 30 }),
    categories: CATEGORIES,
    stores: retailers.publicList().filter((r) => !r.demo || cfg.demoStoreUrl).map((r) => ({ id: r.id, name: r.name })),
    admin: isAdmin(req),
  }), member);

  router.get('/api/monitor/products', async (req) => {
    const q = req.query;
    const list = catalog.listMonitors({
      q: str(q.get('q'), 80), category: str(q.get('category'), 20), store: str(q.get('store'), 40), status: str(q.get('status'), 20),
      paused: isAdmin(req) ? null : false,
    });
    return { products: list.map((p) => (isAdmin(req) ? p : { ...p, monitor: { id: p.monitor.id, paused: p.monitor.paused } })) };
  }, member);

  router.get('/api/monitor/products/:id', async (req) => {
    const p = catalog.productById(req.params.id);
    const m = p && catalog.monitorForProduct(p.id);
    if (!p || (!m && !isAdmin(req)) || (m && m.paused && !isAdmin(req))) throw new HttpError(404, 'Not found');
    return {
      product: toProduct(p),
      monitor: m ? (isAdmin(req) ? toMonitor(m) : { id: m.id, paused: !!m.paused }) : null,
      history: catalog.priceHistory(p.id, 180),
      alerts: catalog.recentAlerts({ productId: p.id, limit: 25 }),
      log: isAdmin(req) ? catalog.listLog({ productId: p.id, limit: 50 }) : null,
      cartUrl: retailers.cartUrl(p.store, { sku: p.sku, variantId: p.variant_id }),
    };
  }, member);

  router.get('/api/monitor/alerts', async (req) => ({
    alerts: catalog.recentAlerts({
      limit: 30, before: req.query.get('before') || null, kind: str(req.query.get('kind'), 20),
      category: str(req.query.get('category'), 20), store: str(req.query.get('store'), 40),
    }),
  }), member);

  // --- Admins: monitors ------------------------------------------------------------------
  router.post('/api/monitor/monitors', async (req) => {
    if (catalog.listMonitors({ limit: 2001 }).length >= 2000) throw bad('2,000 monitors is the most');
    return manage.add(req.body, req.user);
  }, admin);

  router.put('/api/monitor/monitors/:id', async (req) => manage.update(req.params.id, req.body, req.user), admin);

  router.delete('/api/monitor/monitors/:id', async (req) => manage.remove(req.params.id, req.user), admin);

  router.post('/api/monitor/monitors/:id/check', async (req) => {
    if (!limiter.hit(`mcheck:${req.user.id}`, 30, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const m = catalog.monitorById(req.params.id);
    if (!m) throw bad('That monitor no longer exists');
    manage.checkNow(catalog.productById(m.product_id));
    return { ok: true };
  }, admin);

  // --- Admins: health and the check log --------------------------------------------------
  router.get('/api/monitor/health', async () => {
    const now = ctx.repo.now();
    const due = ctx.db.get('SELECT COUNT(*) AS n FROM page_checks WHERE next_check_at <= :now', { now });
    return {
      overview: catalog.overview(),
      loop: { enabled: cfg.monitor.enabled, lastTickAt: monitor.lastTickAt, inFlight: monitor.inFlight.size, due: due ? due.n : 0, intervalSeconds: cfg.monitor.urlIntervalSeconds, hostGapSeconds: cfg.monitor.hostGapSeconds },
      stores: catalog.health().map((h) => {
        const r = retailers.get(h.store);
        return { ...h, name: r ? r.name : h.store, serverChecks: r ? retailers.settings(r).serverChecks : true };
      }),
    };
  }, admin);

  router.get('/api/monitor/log', async (req) => ({
    log: catalog.listLog({ productId: str(req.query.get('product'), 40) || null, store: str(req.query.get('store'), 40), errorsOnly: req.query.get('errors') === '1', limit: 200 }),
  }), admin);

  // --- Admins: Discord alert rules -------------------------------------------------------
  router.get('/api/monitor/routes', async () => ({
    routes: catalog.listRoutes(),
    fallback: catalog.listRoutes().length ? null : { channelId: cfg.discord.restockChannelId || null, roleId: cfg.discord.restockRoleId || null },
    bot: ctx.discord.botReady,
  }), admin);

  router.post('/api/monitor/routes', async (req) => ({ route: manage.saveRoute(null, req.body) }), admin);
  router.put('/api/monitor/routes/:id', async (req) => ({ route: manage.saveRoute(req.params.id, req.body) }), admin);
  router.delete('/api/monitor/routes/:id', async (req) => ({ ok: catalog.deleteRoute(req.params.id) }), admin);

  router.post('/api/monitor/routes/:id/test', async (req) => {
    if (!limiter.hit(`rtest:${req.user.id}`, 10, 10 * 60 * 1000)) throw new HttpError(429, 'Try again in a few minutes');
    const r = catalog.routeById(req.params.id);
    if (!r) throw bad('That alert rule no longer exists');
    if (!ctx.discord.botReady) throw new HttpError(503, "The Discord bot isn't set up yet (Admin → Setup check)");
    const sample = {
      kind: 'restock', store: 'kmart', sku: '43818648', name: 'Test alert — Pokémon TCG: Example Elite Trainer Box', url: retailers.get('kmart').base,
      image: '', category: 'pokemon', status: 'in_stock', price: 89, previousPrice: null, manual: false, note: `Test from ${req.user.username}: this is how "${r.name}" alerts look.`, productId: null,
    };
    const ok = await ctx.discord.post(r.channelId, feed.message(sample, {}, { mention: '' }));
    if (!ok) throw new HttpError(502, "Couldn't post there — check the channel ID and that the bot can see and post in that channel");
    return { ok: true };
  }, admin);
}
