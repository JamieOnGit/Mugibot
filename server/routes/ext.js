// API for the Mugibot browser extension. The extension signs in with a
// device token (from pairing) and only ever sees the account it's paired to.
// Card details are not part of this API: they stay in the extension.

import { entitlement } from '../entitlement.js';
import { EXTENSION_VERSION } from '../extension.js';
import { DEFAULT_ALERTS, HttpError, bad, str } from '../schema.js';

const EVENT_TYPES = { add: 'info', basket: 'info', step: 'info', checkout: 'success', ready: 'success', error: 'warn' };

export function register(router, ctx) {
  const { cfg, repo, limiter, retailers } = ctx;

  // Pairing: a code shown in the dashboard → a device token for this browser.
  router.post('/api/ext/pair', async (req) => {
    if (!limiter.hit(`pair-ip:${req.ip}`, 15, 15 * 60 * 1000)) throw new HttpError(429, 'Too many attempts — wait 15 minutes');
    const userId = repo.redeemPairCode(str(req.body.code, 20));
    if (!userId) throw new HttpError(400, 'That code is wrong or has expired — get a new one from your dashboard');
    const user = repo.userById(userId);
    if (!user || user.disabled) throw new HttpError(403, 'This account is not available');
    const { token, device } = repo.addDevice(userId, str(req.body.name, 60) || 'Browser', str(req.body.version, 20));
    repo.addEvent(userId, { type: 'device', level: 'success', message: `Extension connected: ${device.name}` });
    ctx.hub.publish(userId, 'devices', {});
    return { token, device, user: { id: user.id, username: user.username } };
  }, { auth: 'none', csrf: false });

  // Which version this extension is, and which of the site's addresses it was built for.
  const seen = (req, version = req.device.version) => {
    const host = String(req.headers.host || '').toLowerCase();
    if (version !== req.device.version || host !== req.device.host) repo.setDeviceSeen(req.user.id, req.device.id, { version, host });
  };

  router.get('/api/ext/me', async (req) => {
    seen(req, str(req.query.get('v'), 20) || req.device.version);
    return { user: { id: req.user.id, username: req.user.username }, device: req.device, entitlement: entitlement(req.user, repo.now()) };
  }, { auth: 'device' });

  // For the extension's update check: the newest version, and the site's address
  // (an extension downloaded before the site moved still talks to the old one).
  router.get('/api/ext/app', async () => ({
    name: cfg.appName, url: cfg.baseUrl, extensionVersion: EXTENSION_VERSION, chromeStoreUrl: cfg.chromeStoreUrl || null,
  }), { auth: 'none' });

  router.post('/api/ext/unpair', async (req) => {
    repo.deleteDevice(req.user.id, req.device.id);
    ctx.hub.publish(req.user.id, 'devices', {});
    return { ok: true };
  }, { auth: 'device' });

  // Your watchlist and the checkout flow of every store.
  router.get('/api/ext/items', async (req) => {
    seen(req);
    const settings = { ...DEFAULT_ALERTS, ...(repo.getData(req.user.id, 'alerts', {}) || {}) };
    return {
      items: repo.listItems(req.user.id).map((it) => ({
        id: it.id, store: it.store, storeName: retailers.name(it.store), sku: it.sku, name: it.name, url: it.url, price: it.price, quantity: it.quantity, profileId: it.profileId, status: it.status,
      })),
      flows: retailers.forExtension(),
      active: entitlement(req.user, repo.now()).active,
      browserChecks: settings.browserChecks,
      browserIntervalSeconds: cfg.monitor.browserIntervalSeconds,
    };
  }, { auth: 'device' });

  // Redeem a ⚡ Buy code. Codes only work for the account that made them.
  router.post('/api/ext/claim', async (req) => {
    if (!limiter.hit(`claim:${req.device.id}`, 60, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const row = repo.claimGoCode(req.user.id, str(req.body.code, 100));
    if (!row) throw new HttpError(404, 'That ⚡ Buy link has expired — press ⚡ Buy again');
    return { ok: true, itemId: row.item_id, sku: row.sku, name: row.name, quantity: row.quantity, host: row.host, profileId: row.profile_id };
  }, { auth: 'device', entitled: true });

  // Delivery details for checkout autofill (the chosen set, else the default).
  router.get('/api/ext/profile', async (req) => {
    if (!limiter.hit(`profile:${req.device.id}`, 120, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const profile = { ...repo.profileFor(req.user.id, str(req.query.get('profile'), 40) || null) };
    if (!profile.email && req.user.email) profile.email = req.user.email;
    return { profile };
  }, { auth: 'device', entitled: true });

  // What happened on the store page ("added to bag", "at checkout"…).
  router.post('/api/ext/events', async (req) => {
    if (!limiter.hit(`events:${req.device.id}`, 300, 60 * 1000)) throw new HttpError(429, 'Too many events');
    const type = str(req.body.type, 20);
    if (!EVENT_TYPES[type]) throw bad('Unknown event type');
    const name = str(req.body.name, 120) || null;
    const message = str(req.body.message, 300) || type;
    const rawUrl = str(req.body.url, 1000);
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : null; // only web links (shown as links in the dashboard)
    const atCheckout = type === 'checkout' || type === 'ready';
    await ctx.notifier.notify(req.user.id, {
      type: 'quick', level: EVENT_TYPES[type], message: name ? `${name}: ${message}` : message, name, sku: str(req.body.sku, 60) || null, url,
      title: atCheckout ? `At checkout${name ? `: ${name}` : ''}` : null,
      channel: type === 'ready' ? 'checkout' : null,
    });
    return { ok: true };
  }, { auth: 'device' });

  // In-browser checks: which of your SKUs your browser should look at now…
  router.get('/api/ext/checks', async (req) => {
    if (!limiter.hit(`checks:${req.device.id}`, 30, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    return { checks: ctx.monitor.browserDue(req.user), intervalSeconds: cfg.monitor.browserIntervalSeconds };
  }, { auth: 'device', entitled: true });

  // …and what it saw. Results only ever update this account's own items.
  router.post('/api/ext/checks', async (req) => {
    if (!limiter.hit(`checks-post:${req.device.id}`, 30, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    if (!Array.isArray(req.body.results)) throw bad('results must be a list');
    const applied = await ctx.monitor.browserResults(req.user, req.body.results.slice(0, 20));
    return { ok: true, applied };
  }, { auth: 'device', entitled: true });
}
