// Puts the server together: database, routes, security checks, the restock
// monitor and the background jobs (Discord roles, Whop re-checks).

import http from 'node:http';
import { Aco } from './aco.js';
import { Bags } from './bags.js';
import { Pools } from './pools.js';
import { Drops } from './monitor/drops.js';
import { PageWatches } from './monitor/pages.js';
import { Vip } from './monitor/vip.js';
import { Catalog } from './catalog.js';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Discord } from './discord.js';
import { entitlement } from './entitlement.js';
import { Hub } from './hub.js';
import { Router, RateLimiter, clientIp, parseCookies, parseJson, readBody, securityHeaders, sendJson } from './http.js';
import { Mailer } from './mailer.js';
import { Feed } from './monitor/feed.js';
import { MonitorAdmin } from './monitor/manage.js';
import { Gates } from './monitor/gates.js';
import { storeFetch } from './monitor/http.js';
import { Monitor } from './monitor/index.js';
import { Sweeper } from './monitor/sweep.js';
import { News } from './news.js';
import { Notifier } from './notifier.js';
import { Repo } from './repo.js';
import { Retailers } from './retailers/index.js';
import { HttpError } from './schema.js';
import { Whop } from './whop.js';
import * as admin from './routes/admin.js';
import * as auth from './routes/auth.js';
import * as discordRoutes from './routes/discord.js';
import * as ext from './routes/ext.js';
import * as membership from './routes/membership.js';
import * as monitorRoutes from './routes/monitor.js';
import * as newsRoutes from './routes/news.js';
import { servePage } from './routes/pages.js';
import * as user from './routes/user.js';
import { handleWebRoute } from './routes/web.js';

const UNSAFE = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/**
 * options: config overrides (see config.js), plus
 *   fetch: used for outbound requests (Whop, Discord, email) — tests pass a fake
 *   storeFetch: used for store pages (monitor/http.js: Node's own client, which stores answer) — tests can pass a fake
 *   now: clock — tests pass a fake
 */
export async function createApp(options = {}) {
  const { fetch: fetchImpl = globalThis.fetch, storeFetch: storeFetchImpl = storeFetch, now = () => Date.now(), ...overrides } = options;
  const cfg = options.cfg || loadConfig(overrides);
  const db = new Db(cfg.databasePath);
  const repo = new Repo(db, cfg, now);
  const retailers = new Retailers(cfg, (key) => repo.getSetting(key));
  repo.retailers = retailers;
  const hub = new Hub();
  const mailer = new Mailer(cfg, fetchImpl);
  const discord = new Discord({ cfg, repo, fetchImpl, now });
  const notifier = new Notifier({ cfg, repo, retailers, hub, mailer, discord, fetchImpl, now });
  const whop = new Whop({ cfg, repo, notifier, discord, fetchImpl, now });
  const catalog = new Catalog({ db, repo, now });
  const feed = new Feed({ cfg, repo, catalog, retailers, notifier, discord, hub, now });
  const monitor = new Monitor({ cfg, repo, retailers, notifier, hub, catalog, feed, fetchImpl: storeFetchImpl, now });
  const sweeper = new Sweeper({ cfg, repo, catalog, feed, monitor, retailers, hub, fetchImpl: storeFetchImpl, now });
  monitor.sweeper = sweeper; // (a product the searches found, read off its own page: sweeper.pageRead)
  const limiter = new RateLimiter(now);
  // VIP drops: admins' watches, alerted in #vip-drop and checked fast around their drop time.
  const vip = new Vip({ cfg, db, repo, catalog, retailers, hub, now });
  monitor.vip = vip;
  sweeper.vip = vip;
  // Checkpoints and virtual queues (JB Hi-Fi's, EB Games', Pokémon Center's): seen up and down, posted in #virtual-queue-detection.
  const gates = new Gates({ cfg, db, repo, retailers, discord, notifier, hub, feed, fetchImpl: storeFetchImpl, now });
  gates.sweeper = sweeper;
  sweeper.gates = gates;
  monitor.gates = gates;
  // Drop watches: anything outside the card keywords, by link or words, at any store or website.
  const drops = new Drops({ cfg, db, repo, catalog, retailers, hub, notifier, fetchImpl: storeFetchImpl, now });
  Object.assign(drops, { monitor, sweeper });
  monitor.drops = drops;
  sweeper.drops = drops;
  feed.drops = drops;
  // Search pages (drop watches on a store's search, category or collection page): read every few seconds for their key phrases.
  const pages = new PageWatches({ cfg, db, retailers, drops, hub, fetchImpl: storeFetchImpl, now });
  Object.assign(pages, { sweeper, monitor, gates });
  drops.pages = pages;
  sweeper.pages = pages;
  // Release news: admins' and the news feeds', posted in #news (and a digest each morning).
  const news = new News({ cfg, db, repo, retailers, discord, notifier, fetchImpl: storeFetchImpl, now });
  const ctx = { cfg, db, repo, retailers, hub, mailer, discord, notifier, whop, monitor, sweeper, catalog, feed, vip, gates, drops, pages, news, limiter, pageCache: new Map() };
  drops.ctx = ctx;
  // Auto-checkout: started by the monitor when an armed item drops.
  const aco = new Aco({ ...ctx, now });
  ctx.aco = aco;
  monitor.aco = aco;
  gates.aco = aco;
  // Clear cart: the member's bags, emptied in their checkout browser (from the dashboard, anywhere).
  const bags = new Bags({ ...ctx, now });
  ctx.bags = bags;
  // Pools: an admin's watchlist shared with the members who join it, kept in step — and, for those who agree, their
  // Auto-checkouts started with the admin's (server/pools.js).
  const pools = new Pools({ ...ctx, now });
  ctx.pools = pools;
  aco.ctx.pools = pools;
  drops.pools = pools;
  notifier.pools = pools; // (a leader's ⚡ Buy on their own DMs: 🤝 Group Buy)
  gates.pools = pools; // (a leader's DM when a queue or checkpoint goes up: 🤝 Group Queue / 🤝 Group Checkpoint)

  const router = new Router();
  auth.register(router, ctx);
  user.register(router, ctx);
  ext.register(router, ctx);
  membership.register(router, ctx);
  discordRoutes.register(router, ctx);
  admin.register(router, ctx);
  monitorRoutes.register(router, ctx);
  newsRoutes.register(router, ctx);

  const headers = securityHeaders(cfg);
  const allowedOrigins = () => new Set([new URL(cfg.baseUrl).origin, ...cfg.extraOrigins]);
  // Is the request from one of our own pages? The browser's Origin must be the
  // site it's on (same host as the request) or a configured address. Other
  // websites can't fake either, nor send the x-mugibot header without a
  // CORS preflight we never approve.
  const sameSite = (req) => {
    const origin = req.headers.origin;
    if (!origin || allowedOrigins().has(origin)) return true;
    try { return new URL(origin).host === String(req.headers.host || '').toLowerCase(); } catch { return false; }
  };
  const cookieName = auth.sessionCookieName(cfg);

  async function handleApi(req, res, url) {
    const m = router.match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found');
    if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    const { route, params } = m;
    const o = route.opts;
    const mode = o.auth || 'user';
    req.params = params;

    // Requests from the dashboard must come from our own pages (blocks cross-site request forgery).
    if (UNSAFE.has(req.method) && mode !== 'device' && o.csrf !== false) {
      if (req.headers['x-mugibot'] !== '1' || !sameSite(req)) throw new HttpError(403, 'Request blocked (cross-site)');
    }

    if (mode === 'device') {
      const m2 = String(req.headers.authorization || '').match(/^Bearer\s+([A-Za-z0-9_-]{20,100})$/);
      const found = m2 ? repo.deviceByToken(m2[1]) : null;
      if (!found) throw new HttpError(401, 'This browser is not connected — connect it again from your dashboard');
      req.user = found.user;
      req.device = found.device;
    } else if (mode === 'user' || mode === 'admin') {
      if (!req.user) throw new HttpError(401, 'Please log in');
      if (mode === 'admin' && req.user.role !== 'admin') throw new HttpError(404, 'Not found');
    }
    if (o.entitled && !entitlement(req.user, repo.now()).active) {
      throw new HttpError(402, 'This needs an active membership — start one under Membership', { code: 'membership_required' });
    }

    if (UNSAFE.has(req.method)) {
      const raw = await readBody(req, o.raw ? 1024 * 1024 : o.maxBody || 64 * 1024);
      if (o.raw) req.rawBody = raw;
      else req.body = parseJson(raw);
    } else {
      req.body = {};
    }

    const out = await route.handler(req, res);
    if (out && out.$handled) return;
    if (out && out.$raw) {
      res.writeHead(200, { 'content-type': out.type, 'cache-control': 'no-store', ...(out.headers || {}), ...req.extraHeaders() });
      res.end(out.$raw);
      return;
    }
    sendJson(res, 200, out ?? { ok: true }, req.extraHeaders());
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const cookies = [];
    req.setCookie = (c) => cookies.push(c);
    req.extraHeaders = () => (cookies.length ? { 'set-cookie': cookies } : {});
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      res.writeHead(400).end();
      return;
    }
    // www.<your domain> → <your domain>: the extension only works on BASE_URL.
    const base = new URL(cfg.baseUrl);
    if ((req.method === 'GET' || req.method === 'HEAD')
      && String(req.headers.host || '').toLowerCase() === `www.${base.host}`) {
      res.writeHead(301, { location: base.origin + url.pathname + url.search }).end();
      return;
    }
    req.query = url.searchParams;
    req.ip = clientIp(req, cfg.trustProxy);
    try {
      // Who is this? (session cookie)
      const token = parseCookies(req.headers.cookie)[cookieName];
      if (token) {
        req.sessionToken = token;
        const s = repo.sessionUser(token);
        if (s) {
          req.user = s.user;
          req.sessionHash = s.sessionHash;
        }
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (await handleWebRoute(ctx, req, res, url)) return;
      if (!servePage(ctx, req, res, url)) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Not found</title><p>Page not found. <a href="/">Go home</a></p>');
      }
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: e.message, ...e.extra }, req.extraHeaders());
      } else {
        cfg.log('[error]', req.method, url.pathname, e.stack || e.message);
        sendJson(res, 500, { error: 'Something went wrong on our side — please try again' });
      }
    }
  });
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;

  // Background jobs: members whose role doesn't match their membership (trials
  // ending, missed webhooks), and Whop memberships past their renewal date.
  const timers = [];
  function startJobs() {
    if (!cfg.jobsEnabled) return;
    const every = (ms, fn) => {
      const t = setInterval(() => { fn().catch((e) => cfg.log('[jobs]', e.message)); }, ms);
      t.unref?.();
      timers.push(t);
    };
    every(10 * 60 * 1000, () => discord.sweep());
    every(60 * 60 * 1000, () => whop.reconcile());
    // A store channel the set-up has gained since it was made (#amazon): there by itself, its rule with it.
    const ownChannels = async () => {
      const made = await new MonitorAdmin(ctx).ensureOwnChannels();
      if (made.length) cfg.log('[discord]', `store channels added: ${made.map((c) => `#${c.name}${c.made ? ' (made)' : ''}`).join(', ')}`);
    };
    const first = setTimeout(() => { ownChannels().catch((e) => cfg.log('[jobs]', e.message)); }, 20000);
    first.unref?.();
    timers.push(first);
    every(6 * 60 * 60 * 1000, ownChannels);
  }

  const app = {
    cfg,
    ctx,
    db,
    repo,
    retailers,
    hub,
    monitor,
    sweeper,
    gates,
    drops,
    pages,
    news,
    aco,
    bags,
    pools,
    catalog,
    feed,
    discord,
    whop,
    notifier,
    server,
    url: null,
    async listen(port = cfg.port, host = cfg.host) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
      const addr = server.address();
      // Listening on every interface: "localhost" is the address people type.
      app.url = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${addr.port}`;
      if (cfg.baseUrlAuto) cfg.baseUrl = app.url;
      monitor.start();
      sweeper.start();
      gates.start();
      drops.start();
      pages.start();
      news.start();
      aco.start();
      bags.start();
      pools.start();
      startJobs();
      return app.url;
    },
    async close() {
      monitor.stop();
      sweeper.stop();
      gates.stop();
      drops.stop();
      pages.stop();
      news.stop();
      aco.stop();
      bags.stop();
      pools.stop();
      timers.forEach(clearInterval);
      hub.close();
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
      db.close();
    },
  };
  return app;
}
