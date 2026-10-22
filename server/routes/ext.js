// API for the Mugibot browser extension. The extension signs in with a
// device token (from pairing) and only ever sees the account it's paired to.
// Card details are not part of this API: they stay in the extension. (A member can keep a backup of
// their card in their account, locked in the extension with a passphrase only they know: Mugibot
// keeps the locked copy and can't open it — a new install restores it with that passphrase. And from
// 1.20, a copy for reinstalls: locked in the extension with a key the member's dashboard keeps in their
// browser — Mugibot keeps the locked copy and never has the key — so a new install, once connected
// from the dashboard, has the card back with no passphrase.)

import { entitlement } from '../entitlement.js';
import { EXTENSION_VERSION, appOrigins, storeUrl } from '../extension.js';
import { REASONS } from '../aco.js';
import { DEFAULT_ALERTS, HttpError, MAX_RESTORE_COPIES, RESTORE_KEY_ID, bad, cardBackup, cardBackupInfo, cardRestoreCopy, cardRestoreInfo, num, str } from '../schema.js';

const EVENT_TYPES = { add: 'info', basket: 'info', step: 'info', checkout: 'success', ready: 'success', error: 'warn' };

/** "ebgames,pokemoncenter" → the stores this browser has got through the queue of (it says, since 1.16.0). */
// Other websites this browser may read (its extension allowed there: their addresses, '*' for any).
const sitesFrom = (v) => new Set(String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => x === '*' || /^[a-z0-9.-]{1,253}(:(\d{1,5}|\*))?$/.test(x)).slice(0, 200));
const throughFrom = (v) => new Set(String(v || '').split(',').map((x) => x.trim()).filter((x) => /^[a-z0-9-]{1,40}$/.test(x)).slice(0, 20));

export function register(router, ctx) {
  const { cfg, repo, limiter, retailers } = ctx;
  const gatesUp = () => (ctx.gates ? ctx.gates.upList().map((g) => ({ store: g.store, kind: g.kind, since: g.since, wait: g.wait })) : []);

  // Pairing: a code shown in the dashboard → a device token for this browser.
  router.post('/api/ext/pair', async (req) => {
    if (!limiter.hit(`pair-ip:${req.ip}`, 15, 15 * 60 * 1000)) throw new HttpError(429, 'Too many attempts — wait 15 minutes');
    const userId = repo.redeemPairCode(str(req.body.code, 20));
    if (!userId) throw new HttpError(400, 'That code is wrong or has expired — get a new one from your dashboard');
    const user = repo.userById(userId);
    if (!user || user.disabled) throw new HttpError(403, 'This account is not available');
    const { token, device } = repo.addDevice(userId, str(req.body.name, 60) || 'Browser', str(req.body.version, 20));
    // Which address it was built for, and where it came from (Chrome Web Store or download).
    const source = ['store', 'download'].includes(req.body.source) ? req.body.source : '';
    repo.setDeviceSeen(userId, device.id, { version: device.version, host: String(req.headers.host || ''), source });
    Object.assign(device, { host: String(req.headers.host || '').toLowerCase(), source });
    repo.addEvent(userId, { type: 'device', level: 'success', message: `Extension connected: ${device.name}` });
    ctx.hub.publish(userId, 'devices', {});
    return { token, device, user: { id: user.id, username: user.username } };
  }, { auth: 'none', csrf: false });

  // Which version this extension is, which of the site's addresses it was built for,
  // and where it came from (the Chrome Web Store, or the dashboard's download).
  const seen = (req, version = req.device.version, source = req.device.source) => {
    const host = String(req.headers.host || '').toLowerCase();
    if (version !== req.device.version || host !== req.device.host || source !== req.device.source) {
      repo.setDeviceSeen(req.user.id, req.device.id, { version, host, source });
      ctx.hub.publish(req.user.id, 'devices', {}); // an open dashboard can say "downloaded for another address" straight away
    }
  };

  router.get('/api/ext/me', async (req) => {
    const src = str(req.query.get('src'), 10);
    seen(req, str(req.query.get('v'), 20) || req.device.version, ['store', 'download'].includes(src) ? src : req.device.source);
    return { user: { id: req.user.id, username: req.user.username }, device: req.device, entitlement: entitlement(req.user, repo.now()) };
  }, { auth: 'device' });

  // For the extension's update check: the newest version, the site's address (an
  // extension downloaded before the site moved still talks to the old one), and the
  // Chrome Web Store listing, once there is one (that copy updates itself).
  router.get('/api/ext/app', async () => ({
    name: cfg.appName, url: cfg.baseUrl, origins: appOrigins(cfg), extensionVersion: EXTENSION_VERSION, chromeStoreUrl: storeUrl(cfg, repo) || null,
  }), { auth: 'none' });

  // The card's locked backup in the member's account (see the top of this file).
  router.get('/api/ext/card-backup', async (req) => ({ backup: repo.getData(req.user.id, 'cardBackup', null) }), { auth: 'device' });
  router.put('/api/ext/card-backup', async (req) => {
    if (!limiter.hit(`cardbackup:${req.user.id}`, 20, 60 * 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const fresh = !repo.getData(req.user.id, 'cardBackup', null);
    const backup = repo.setData(req.user.id, 'cardBackup', cardBackup(req.body, repo.now()));
    repo.addEvent(req.user.id, { type: 'card', level: 'info', message: `${fresh ? 'Card backed up' : 'Card backup updated'}: ${backup.brand} •••• ${backup.last4}, locked with your card passphrase` });
    ctx.hub.publish(req.user.id, 'card', { backup: cardBackupInfo(backup) });
    return { backup: cardBackupInfo(backup) };
  }, { auth: 'device' });
  router.delete('/api/ext/card-backup', async (req) => {
    repo.deleteData(req.user.id, 'cardBackup');
    ctx.hub.publish(req.user.id, 'card', { backup: null });
    return { ok: true };
  }, { auth: 'device' });

  // The card's copy for reinstalls (see the top of this file): the one locked with this browser's key.
  router.get('/api/ext/card-restore/:id', async (req) => {
    if (!limiter.hit(`cardrestore-get:${req.device.id}`, 60, 60 * 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const id = str(req.params.id, 40);
    const doc = repo.getData(req.user.id, 'cardRestore', null);
    const copy = doc && !doc.off && (doc.copies || []).find((c) => c.id === id);
    if (!copy) throw new HttpError(404, 'No copy of your card for this browser');
    return { copy };
  }, { auth: 'device' });
  router.put('/api/ext/card-restore/:id', async (req) => {
    if (!limiter.hit(`cardrestore:${req.user.id}`, 30, 60 * 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const id = str(req.params.id, 40);
    if (!RESTORE_KEY_ID.test(id)) throw bad("That isn't a browser's key");
    const doc = repo.getData(req.user.id, 'cardRestore', null) || { off: false, copies: [] };
    if (doc.off) throw new HttpError(409, 'Keeping your card for extension updates is switched off (Setup → Delivery & card)');
    const copy = { id, ...cardRestoreCopy(req.body, repo.now()) };
    const before = (doc.copies || []).find((c) => c.id === id);
    const copies = [copy, ...(doc.copies || []).filter((c) => c.id !== id)].slice(0, MAX_RESTORE_COPIES);
    repo.setData(req.user.id, 'cardRestore', { off: false, copies });
    if (!before || before.last4 !== copy.last4 || before.expMonth !== copy.expMonth || before.expYear !== copy.expYear) {
      repo.addEvent(req.user.id, { type: 'card', level: 'info', message: `🔁 Your ${copy.brand === 'Card' ? 'card' : `${copy.brand} card`} comes back by itself after an extension update in ${req.device.name}: a copy locked with a key kept in that browser (Mugibot can't open it)` });
    }
    const restore = cardRestoreInfo({ off: false, copies });
    ctx.hub.publish(req.user.id, 'card', { restore });
    return { ok: true, restore };
  }, { auth: 'device' });
  // The card removed in an extension: no copy kept anywhere (another browser with it saved makes its own again).
  router.delete('/api/ext/card-restore', async (req) => {
    const doc = repo.getData(req.user.id, 'cardRestore', null);
    if (doc && (doc.copies || []).length) {
      repo.setData(req.user.id, 'cardRestore', { off: !!doc.off, copies: [] });
      repo.addEvent(req.user.id, { type: 'card', level: 'info', message: `Card removed in ${req.device.name}: the copies kept for extension updates are deleted` });
    }
    const restore = cardRestoreInfo(repo.getData(req.user.id, 'cardRestore', null));
    ctx.hub.publish(req.user.id, 'card', { restore });
    return { ok: true, restore };
  }, { auth: 'device' });

  router.post('/api/ext/unpair', async (req) => {
    repo.deleteDevice(req.user.id, req.device.id);
    ctx.hub.publish(req.user.id, 'devices', {});
    return { ok: true };
  }, { auth: 'device' });

  // Your watchlist and the checkout flow of every store.
  router.get('/api/ext/items', async (req) => {
    const src = str(req.query.get('src'), 10);
    seen(req, req.device.version, ['store', 'download'].includes(src) ? src : req.device.source);
    // (Whether its card is ready — never the card: the dashboard's Armed checks, from anywhere.)
    ctx.aco.noteCard(req.device.id, str(req.query.get('card'), 10));
    const settings = { ...DEFAULT_ALERTS, ...(repo.getData(req.user.id, 'alerts', {}) || {}) };
    return {
      items: repo.listItems(req.user.id).map((it) => ({
        id: it.id, store: it.store, storeName: retailers.name(it.store), sku: it.sku, name: it.name, url: it.url, price: it.price, profileId: it.profileId, status: it.status,
        aco: it.aco, maxPrice: it.maxPrice,
      })),
      flows: retailers.forExtension(),
      active: entitlement(req.user, repo.now()).active,
      browserChecks: settings.browserChecks,
      browserIntervalSeconds: cfg.monitor.browserIntervalSeconds,
      // Auto-checkout: switched on, with items armed — this browser listens for runs.
      // (pending: runs waiting to start — a Trigger ACO test, for one, whose item needn't be armed.
      //  listen: this is the checkout browser, so Discord's ⚡ Buy may start a run here any time.)
      aco: {
        enabled: ctx.aco.settings(req.user.id).enabled, armed: ctx.aco.armedCount(req.user.id), pending: ctx.aco.pendingCount(req.user.id), listen: ctx.aco.listens(req.user, req.device), going: ctx.aco.goingCount(req.user.id), scheduled: ctx.aco.scheduledCount(req.user.id),
        // Clear cart (server/bags.js): bags for this browser to empty — it asks for them while there are.
        clears: ctx.bags.activeFor(req.user, req.device),
      },
      // Checkpoints and virtual queues up now (monitor/gates.js): this browser makes no requests to a store
      // whose queue is up, unless it's got through it.
      gates: gatesUp(),
    };
  }, { auth: 'device' });

  // Redeem a ⚡ Buy code. Codes only work for the account that made them.
  router.post('/api/ext/claim', async (req) => {
    if (!limiter.hit(`claim:${req.device.id}`, 60, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const row = repo.claimGoCode(req.user.id, str(req.body.code, 100));
    if (!row) throw new HttpError(404, 'That ⚡ Buy link has expired — press ⚡ Buy again');
    // An Auto-checkout run's code: what this checkout may do by itself (null: an ordinary ⚡ Buy).
    // (Finished on the phone instead: the computer opens nothing.)
    if (row.run_id && ctx.aco.handedOff(req.user.id, row.run_id)) throw new HttpError(409, 'You finished this one on your phone — nothing to do here');
    // (Your own ⚡ Buy — the dashboard's, a channel's link — with Auto-checkout set to "Place the order for me":
    //  a run for it, placing the order within your limits. Otherwise it stops at the final button for you.)
    const aco = row.run_id ? ctx.aco.claimed(req.user.id, row.run_id, req.device)
      : row.item_id ? ctx.aco.own(req.user, req.device, { id: row.item_id }, { qty: row.quantity }) : null;
    // (The product's page: where to go once through a store's queue, which may let you in at its front page.)
    const item = row.item_id ? repo.getItem(req.user.id, row.item_id) : null;
    // (A Shop checkout link's code is only taken up on Shop's checkout: it opened signed in for that link.)
    if (item) ctx.aco.noteShopSeen(req.user.id, item, 'in', aco ? 'run' : 'buy');
    return { ok: true, itemId: row.item_id, sku: row.sku, name: row.name, url: (item && item.url) || null, host: row.host, profileId: row.profile_id, aco };
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

  // In-browser checks: which of your SKUs your browser should look at now — and, a website refusing the
  // server, its pages (an admin's browser: the shared monitors and drop watches; yours: your own)…
  // sites: the other websites this browser may read; it's told the ones it could (to offer allowing them).
  router.get('/api/ext/checks', async (req) => {
    if (!limiter.hit(`checks:${req.device.id}`, 30, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const sites = sitesFrom(req.query.get('sites'));
    const want = new Set();
    // (Only an extension that can be allowed other websites says which it may read: 1.26.0 or later.)
    if (req.query.has('sites')) ctx.monitor.noteSites(req.user.id, req.device.id, sites);
    // (Which copy this is: it says, from 1.28.0 — before, the version it last told /api/ext/me or the searches.)
    const version = str(req.query.get('v'), 20) || req.device.version;
    if (version !== req.device.version) seen(req, version);
    const checks = ctx.monitor.browserDue(req.user, { through: throughFrom(req.query.get('through')), sites, want, version });
    if (ctx.drops && ctx.monitor.browserChecksOn(req.user)) checks.push(...ctx.drops.browserDue(req.user, { sites, want }));
    return { checks, intervalSeconds: cfg.monitor.browserIntervalSeconds, sites: [...want].slice(0, 20) };
  }, { auth: 'device', entitled: true });

  // …and what it saw. Results only ever update this account's own items.
  router.post('/api/ext/checks', async (req) => {
    if (!limiter.hit(`checks-post:${req.device.id}`, 30, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    if (!Array.isArray(req.body.results)) throw bad('results must be a list');
    const results = req.body.results.slice(0, 20);
    let applied = await ctx.monitor.browserResults(req.user, results.filter((r) => !(r && typeof r.id === 'string' && r.id.startsWith('d:'))));
    // (Another website's search read for a drop watch.)
    for (const r of results) if (r && typeof r.id === 'string' && r.id.startsWith('d:') && ctx.drops && (await ctx.drops.browserResult(req.user, r))) applied += 1;
    return { ok: true, applied };
  }, { auth: 'device', entitled: true, maxBody: 512 * 1024 });

  // The store login monitor: which stores this browser is signed in to (it looks when you open a
  // store, and checks the stores that say so in their pages every 10 minutes). Signed in, ⚡ Buy is
  // faster: the store fills in your saved details itself.
  router.post('/api/ext/logins', async (req) => {
    if (!limiter.hit(`logins:${req.device.id}`, 30, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const src = req.body.logins && typeof req.body.logins === 'object' ? req.body.logins : null;
    if (!src) throw bad('logins must be an object');
    const now = repo.now();
    const out = {};
    for (const [store, v] of Object.entries(src).slice(0, 40)) {
      if (!retailers.get(store) || !v || typeof v !== 'object') continue;
      if (!['in', 'out', 'unknown'].includes(v.status)) continue;
      const at = Number(v.at);
      // how: 'check' (a page fetched), 'page' (the page you have open), 'screen' (read off the screen: Shop's
      // checkout), 'run' (a checkout link that went on to the store's guest checkout).
      out[store] = { status: v.status, at: Number.isFinite(at) && at > 0 && at <= now + 60000 ? Math.round(at) : now, how: ['check', 'screen', 'run'].includes(v.how) ? v.how : 'page' };
    }
    const logins = repo.setDeviceLogins(req.user.id, req.device.id, out);
    if (logins && Object.keys(out).length) ctx.hub.publish(req.user.id, 'devices', {});
    return { ok: true };
  }, { auth: 'device' });

  // Auto-checkout (server/aco.js): runs for this browser to start. It asks again as soon as it has an
  // answer; with nothing to start, the answer waits up to `wait` seconds for an armed item to drop.
  router.get('/api/ext/aco/next', async (req, res) => {
    if (!limiter.hit(`aco-next:${req.device.id}`, 30, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const waitMs = num(req.query.get('wait'), { min: 0, max: 25, def: 0 }) * 1000;
    ctx.aco.noteCard(req.device.id, str(req.query.get('card'), 10));
    let gone = false;
    res.on('close', () => { gone = true; });
    // Bags to empty (Clear cart, server/bags.js): handed over at once — with them, the answer doesn't wait.
    let clears = ctx.bags.forBrowser(req.user, req.device);
    const runs = await ctx.aco.next(req.user, req.device, { waitMs: clears.length ? 0 : waitMs, alive: () => !gone && !res.writableEnded });
    if (!clears.length) clears = ctx.bags.forBrowser(req.user, req.device);
    const s = ctx.aco.settings(req.user.id);
    return {
      runs, enabled: s.enabled, armed: ctx.aco.armedCount(req.user.id), pending: ctx.aco.pendingCount(req.user.id), listen: ctx.aco.listens(req.user, req.device), going: ctx.aco.goingCount(req.user.id), scheduled: ctx.aco.scheduledCount(req.user.id),
      // Queues to get in line at (a queue went up where something's armed, or Discord's "Join the queue"), and what's up now.
      lobbies: ctx.aco.lobbiesFor(req.user, req.device), gates: gatesUp(),
      clears, clearing: ctx.bags.activeFor(req.user, req.device),
      // Runs you stopped on your dashboard: their tabs here press nothing more.
      stops: ctx.aco.stopsFor(req.user),
    };
  }, { auth: 'device', entitled: true });

  // The store panel's "Add to bag → Checkout" pressed on a product's page (yours on your watchlist, or the page's
  // own): with Auto-checkout set to "Place the order for me", a run for it (what its checkout may do) — or none.
  router.post('/api/ext/aco/own', async (req) => {
    if (!limiter.hit(`aco-own:${req.device.id}`, 30, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const p = req.body.product && typeof req.body.product === 'object' ? req.body.product : {};
    const product = { id: str(p.id, 40) || null, store: str(p.store, 40), sku: str(p.sku, 80), name: str(p.name, 200), url: str(p.url, 2000) };
    if (product.url && !/^https?:\/\//i.test(product.url)) product.url = '';
    return { aco: ctx.aco.own(req.user, req.device, product, { price: num(p.price, { min: 0, max: 100000, def: null }) }) };
  }, { auth: 'device', entitled: true });

  // A run this browser held while it waited in a store's queue, through now: a fresh link to open the store with.
  router.post('/api/ext/aco/:id/link', async (req) => {
    if (!limiter.hit(`aco-link:${req.device.id}`, 30, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const url = ctx.aco.freshLink(req.user, str(req.params.id, 40));
    if (!url) throw new HttpError(404, 'That Auto-checkout run is not waiting any more');
    return { url };
  }, { auth: 'device', entitled: true });

  // …and how each run is going: 'checkout' | 'placing' | 'placed' | 'ready' | 'needs_you' | 'failed' (with why).
  router.post('/api/ext/aco/:id', async (req) => {
    if (!limiter.hit(`aco-report:${req.device.id}`, 120, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const reason = str(req.body.reason, 30);
    const run = await ctx.aco.report(req.user.id, str(req.params.id, 40), {
      status: str(req.body.status, 20), reason: !reason || REASONS[reason] ? reason : 'error', message: str(req.body.message, 300),
      total: num(req.body.total, { min: 0, max: 100000, def: null }), pressed: req.body.pressed === true, again: req.body.again === true, live: req.body.live === true,
    });
    if (!run) throw new HttpError(404, 'That Auto-checkout run was not found');
    return { ok: true, run };
  }, { auth: 'device' });

  // Clear cart: how emptying a store's bag is going — 'clearing' (how many removed so far), or how it
  // ended: 'cleared', 'empty', 'busy' (a checkout of yours is going there: left alone) or 'failed' (why).
  router.post('/api/ext/bags/:id', async (req) => {
    if (!limiter.hit(`bags-report:${req.device.id}`, 240, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    const status = str(req.body.status, 20);
    if (!['clearing', 'cleared', 'empty', 'busy', 'failed'].includes(status)) throw bad('Unknown status');
    const job = ctx.bags.report(req.user.id, str(req.params.id, 40), {
      status, removed: num(req.body.removed, { min: 0, max: 500, int: true, def: 0 }), message: str(req.body.message, 300),
    });
    if (!job) throw new HttpError(404, 'That Clear cart request was not found');
    return { ok: true };
  }, { auth: 'device' });

  // Checkpoints and virtual queues (monitor/gates.js): what this browser saw — a store page that's the
  // queue or the checkpoint (anyone's browser), or an admin's browser's look at a store as a new visitor.
  router.post('/api/ext/gates', async (req) => {
    if (!limiter.hit(`gates:${req.device.id}`, 60, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    if (!Array.isArray(req.body.seen)) throw bad('seen must be a list');
    return { ok: true, gates: ctx.gates.reports(req.user, req.body.seen) };
  }, { auth: 'device' });

  // Live sweeps from an admin's browser (docs/MONITORING.md): the next search at each store
  // that refuses servers… Members' browsers get none: only admins can change the shared feed.
  router.get('/api/ext/sweeps', async (req) => {
    // (Each store's search runs on its own in an admin's browser, side by side — from every 2 s each — so room for them all.)
    if (!limiter.hit(`sweeps:${req.device.id}`, 600, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    // Which version this copy of the extension is (it says, since 1.8.1; before that, the one it connected with).
    const version = str(req.query.get('v'), 20) || req.device.version || '';
    // (Kept as this browser's version: its in-browser checks go by it too — an extension updated since it last
    //  opened its menu was taken for the old one, and left out of BIG W's checks.)
    if (version && version !== req.device.version) seen(req, version);
    // (busy: the stores this browser is still searching — the same list as `through`.)
    return ctx.sweeper.browserDue(req.user, { version, who: req.user.username, through: throughFrom(req.query.get('through')), busy: throughFrom(req.query.get('busy')) });
  }, { auth: 'device' });

  // …and what they found.
  router.post('/api/ext/sweeps', async (req) => {
    if (!limiter.hit(`sweeps-post:${req.device.id}`, 600, 60 * 1000)) throw new HttpError(429, 'Slow down a little');
    if (!Array.isArray(req.body.results)) throw bad('results must be a list');
    if (req.user.role !== 'admin') return { ok: true, results: [] };
    return { ok: true, results: await ctx.sweeper.browserResults(req.user, req.body.results) };
  }, { auth: 'device', maxBody: 768 * 1024 });
}
