// The Monitor tab (docs/MONITORING.md). Members with an active membership see
// the shared feed: live alerts, products, price history. Admins also manage
// the live sweeps, monitors and Discord alert rules, and see the check log
// and health.

import { CATEGORIES, toMonitor, toProduct } from '../catalog.js';
import { MonitorAdmin } from '../monitor/manage.js';
import { SWEEP_DEFAULTS } from '../monitor/sweep.js';
import { HttpError, bad, str } from '../schema.js';

export function register(router, ctx) {
  const { cfg, catalog, retailers, monitor, sweeper, feed, limiter } = ctx;
  const manage = new MonitorAdmin(ctx);
  ctx.monitorAdmin = manage;
  const member = { entitled: true };
  const admin = { auth: 'admin' };
  const isAdmin = (req) => req.user && req.user.role === 'admin';

  // --- Everyone with a membership --------------------------------------------------
  // The numbers at the top: page checks and sweeps together.
  const overview = () => {
    const o = catalog.overview();
    const sw = sweeper.summary();
    const checks = o.checks1h + sw.sweeps1h;
    const ok = o.ok1h + sw.sweepsOk1h;
    return { ...o, ...sw, checks1h: checks, ok1h: ok, okRate1h: checks ? Math.round((ok / checks) * 100) : null };
  };

  router.get('/api/monitor', async (req) => ({
    overview: overview(),
    alerts: catalog.recentAlerts({ limit: 30 }),
    categories: CATEGORIES,
    stores: retailers.publicList().filter((r) => !r.demo || cfg.demoStoreUrl).map((r) => ({ id: r.id, name: r.name })),
    admin: isAdmin(req),
  }), member);

  // The live monitor: each store's searches as they happen, the counters and the latest events.
  router.get('/api/monitor/live', async (req) => {
    const s = sweeper.settings;
    return {
      ...sweeper.live(),
      overview: overview(),
      alerts: catalog.recentAlerts({ limit: 40 }),
      settings: isAdmin(req) ? s : {
        enabled: s.enabled, keywords: s.keywords, everySeconds: s.everySeconds, browserEverySeconds: s.browserEverySeconds,
        newAlerts: s.newAlerts, restockAlerts: s.restockAlerts, priceAlerts: s.priceAlerts, priceDropPercent: s.priceDropPercent,
      },
      admin: isAdmin(req),
    };
  }, member);

  router.get('/api/monitor/products', async (req) => {
    const q = req.query;
    const list = catalog.listProducts({
      q: str(q.get('q'), 80), category: str(q.get('category'), 20), store: str(q.get('store'), 40), status: str(q.get('status'), 20), admin: isAdmin(req),
    });
    return { products: list.map((p) => (isAdmin(req) || !p.monitor ? p : { ...p, monitor: { id: p.monitor.id, paused: p.monitor.paused } })) };
  }, member);

  router.get('/api/monitor/products/:id', async (req) => {
    const p = catalog.productById(req.params.id);
    const m = p && catalog.monitorForProduct(p.id);
    if (!p || (!isAdmin(req) && !catalog.isListed(p))) throw new HttpError(404, 'Not found');
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

  // --- Admins: the live sweeps -----------------------------------------------------------
  const sweepView = () => ({
    settings: sweeper.settings,
    defaults: { tcgTerms: SWEEP_DEFAULTS.tcgTerms, notCardTerms: SWEEP_DEFAULTS.notCardTerms, keywords: SWEEP_DEFAULTS.keywords },
    stores: sweeper.health(),
    running: sweeper.running,
    monitorEnabled: cfg.monitor.enabled,
  });

  router.get('/api/monitor/sweep', async () => sweepView(), admin);

  router.put('/api/monitor/sweep', async (req) => {
    sweeper.save(req.body, req.user);
    return sweepView();
  }, admin);

  router.post('/api/monitor/sweep/now', async (req) => {
    if (!limiter.hit(`sweepnow:${req.user.id}`, 10, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    sweeper.sweepNow();
    return { ok: true };
  }, admin);

  // Reset one store (body.store) or every store that's being swept: see Sweeper.reset.
  router.post('/api/monitor/sweep/reset', async (req) => {
    if (!limiter.hit(`sweepreset:${req.user.id}`, 20, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const store = str(req.body.store, 40) || null;
    if (store && !retailers.get(store)) throw bad('No such store');
    const reset = sweeper.reset(store, req.user);
    if (store && !reset.length) throw bad('That store has no sweeps');
    return { ok: true, reset };
  }, admin);

  // --- Admins: health and the check log --------------------------------------------------
  router.get('/api/monitor/health', async () => {
    const now = ctx.repo.now();
    const due = ctx.db.get('SELECT COUNT(*) AS n FROM page_checks WHERE next_check_at <= :now', { now });
    return {
      overview: overview(),
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
  // "Set up store channels": a channel per store and game, made by the bot where missing (manage.js).
  router.post('/api/monitor/routes/setup', async (req) => {
    if (!limiter.hit(`rsetup:${req.user.id}`, 5, 10 * 60 * 1000)) throw new HttpError(429, 'Try again in a few minutes');
    const out = await manage.setupChannels({ roleId: req.body.roleId, replace: req.body.replace === true }, req.user);
    return { ...out, routes: catalog.listRoutes() };
  }, admin);
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
