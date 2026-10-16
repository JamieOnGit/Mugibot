// Admin console: run the community. Admins see accounts, memberships,
// Discord connections and counts — never anyone's address, card or
// activity. The SKU overview shows what members watch in total (how many
// people per SKU), not who. Every change is written to the audit log.

import { sendResetLink } from './auth.js';
import { serialize } from '../retailers/index.js';
import { commandDefinitions } from './discord.js';
import { EXTENSION_VERSION, isStoreUrl, storeUrl, storeZip } from '../extension.js';
import { HttpError, bad, bool, num, str } from '../schema.js';

const DAY = 24 * 60 * 60 * 1000;
const PLANS = ['none', 'trial', 'active', 'past_due', 'canceled', 'comped'];

export function register(router, ctx) {
  const { repo, cfg, retailers, discord, whop } = ctx;
  const target = (id) => {
    const u = repo.userById(id);
    if (!u) throw new HttpError(404, 'Member not found');
    return u;
  };
  const opts = { auth: 'admin' };

  router.get('/api/admin/stats', async () => repo.stats(), opts);

  router.get('/api/admin/users', async (req) => repo.listUsers({
    q: str(req.query.get('q'), 100),
    plan: PLANS.includes(req.query.get('plan')) ? req.query.get('plan') : '',
    limit: num(req.query.get('limit'), { min: 1, max: 200, def: 50, int: true }),
    offset: num(req.query.get('offset'), { min: 0, def: 0, int: true }),
  }), opts);

  router.put('/api/admin/users/:id', async (req) => {
    const u = target(req.params.id);
    const fields = {};
    const changes = [];
    if (req.body.plan !== undefined) {
      if (!PLANS.includes(req.body.plan)) throw bad('Unknown plan');
      fields.plan = req.body.plan;
      changes.push(`plan ${u.plan} → ${req.body.plan}`);
    }
    if (req.body.extendTrialDays !== undefined) {
      const days = num(req.body.extendTrialDays, { min: 1, max: 365, int: true });
      if (!days) throw bad('Days must be 1–365');
      fields.trial_ends_at = Math.max(repo.now(), u.trial_ends_at || 0) + days * DAY;
      if (['none', 'canceled', 'trial'].includes(u.plan)) fields.plan = 'trial';
      changes.push(`trial +${days} days`);
    }
    if (req.body.disabled !== undefined) {
      if (u.id === req.user.id) throw bad("You can't suspend your own account");
      fields.disabled = req.body.disabled ? 1 : 0;
      changes.push(req.body.disabled ? 'suspended' : 'unsuspended');
    }
    if (req.body.role !== undefined) {
      if (!['user', 'admin'].includes(req.body.role)) throw bad('Unknown role');
      if (u.id === req.user.id && req.body.role !== 'admin') throw bad("You can't remove your own admin access");
      fields.role = req.body.role;
      changes.push(`role ${u.role} → ${req.body.role}`);
    }
    if (!changes.length) throw bad('Nothing to change');
    const updated = repo.updateUser(u.id, fields);
    if (fields.disabled) {
      repo.deleteSessions(u.id);
      ctx.hub.disconnectUser(u.id);
    }
    repo.audit(req.user.id, u.id, 'update-member', `${u.username}: ${changes.join(', ')}`);
    await discord.sync(updated).catch(() => null);
    return { user: { id: updated.id, username: updated.username, plan: updated.plan, role: updated.role, disabled: !!updated.disabled, trial_ends_at: updated.trial_ends_at } };
  }, opts);

  router.post('/api/admin/users/:id/signout', async (req) => {
    const u = target(req.params.id);
    repo.deleteSessions(u.id);
    repo.deleteDevices(u.id);
    ctx.hub.disconnectUser(u.id);
    repo.audit(req.user.id, u.id, 'sign-out-member', u.username);
    return { ok: true };
  }, opts);

  // A password-reset link to give someone who has no email or Discord connected.
  router.post('/api/admin/users/:id/reset-link', async (req) => {
    const u = target(req.params.id);
    const { link, sent } = await sendResetLink(ctx, u);
    repo.audit(req.user.id, u.id, 'reset-link', u.username);
    return { link, sent };
  }, opts);

  router.post('/api/admin/users/:id/discord-sync', async (req) => {
    const u = target(req.params.id);
    if (!u.discord_id) throw bad("This member hasn't connected Discord");
    const sync = await discord.sync(u);
    repo.audit(req.user.id, u.id, 'discord-sync', `${u.username}: ${sync.error || 'ok'}`);
    return { sync };
  }, opts);

  router.post('/api/admin/users/:id/whop-sync', async (req) => {
    const u = target(req.params.id);
    const out = await whop.syncUser(u);
    return { result: out, plan: repo.userById(u.id).plan };
  }, opts);

  // Link a Whop membership to this member (e.g. bought on Whop, can't find their ID).
  router.post('/api/admin/users/:id/whop-link', async (req) => {
    const u = target(req.params.id);
    const id = str(req.body.membership, 100);
    const row = repo.membershipById(id);
    let out;
    if (whop.apiReady) {
      out = await whop.claim(u, id);
    } else {
      if (!row) throw bad("That membership hasn't been seen by this server — check the ID, or set WHOP_API_KEY");
      if (row.user_id && row.user_id !== u.id) throw new HttpError(409, 'That membership is linked to another account');
      repo.linkMembership(row.id, u.id);
      out = await whop.applyMembership({ id: row.id, status: row.status, product: { id: row.product_id }, plan: { id: row.plan_id }, renewal_period_end: row.renewal_period_end, cancel_at_period_end: !!row.cancel_at_period_end, manage_url: row.manage_url }, { forUserId: u.id });
    }
    repo.audit(req.user.id, u.id, 'whop-link', `${u.username}: ${id}`);
    return { result: out, plan: repo.userById(u.id).plan };
  }, opts);

  router.delete('/api/admin/users/:id', async (req) => {
    const u = target(req.params.id);
    if (u.id === req.user.id) throw bad('Delete your own account from Account instead');
    if (str(req.body.confirm, 60).toLowerCase() !== u.username) throw bad('Type the username to confirm');
    if (u.whop_membership_id && ['active', 'past_due'].includes(u.plan) && req.body.cancelWhop !== false) await whop.cancelNow(u);
    await discord.removeMember(u).catch(() => null);
    ctx.hub.disconnectUser(u.id);
    repo.deleteUser(u.id);
    repo.audit(req.user.id, u.id, 'delete-member', u.username);
    return { ok: true };
  }, opts);

  // --- SKUs: what members watch (counts only), and manual restock pings -----------
  router.get('/api/admin/skus', async () => ({
    skus: repo.skuSummary().map((s) => ({ ...s, storeName: retailers.name(s.store) })),
  }), opts);

  router.post('/api/admin/restock', async (req) => {
    const store = str(req.body.store, 40);
    if (!retailers.get(store)) throw bad('Unknown store');
    const sku = str(req.body.sku, 60);
    if (!sku) throw bad('Enter the SKU');
    const note = str(req.body.note, 200);
    const out = await ctx.monitor.broadcastRestock({ store, sku, note, url: str(req.body.url, 2000), name: str(req.body.name, 120) });
    repo.audit(req.user.id, null, 'restock-ping', `${store} ${sku}: ${out.pinged} pinged${note ? ` — ${note}` : ''}`);
    return out;
  }, opts);

  // --- The blacklist: products (or whole stores) that never alert or show in the Monitor -----
  router.get('/api/admin/blacklist', async () => ({ entries: ctx.catalog.listBlacklist().map((e) => ({ ...e, storeName: e.store ? retailers.name(e.store) : 'Every store' })) }), opts);

  router.post('/api/admin/blacklist', async (req) => {
    let store = str(req.body.store, 40);
    let sku = str(req.body.sku, 2000);
    if (store && !retailers.get(store)) throw bad('Unknown store');
    // A product link instead of a SKU: its store and SKU.
    if (/^https?:\/\//i.test(sku)) {
      const r = retailers.forUrl(sku);
      if (!r || r.id === 'other') throw bad("That link isn't on one of Mugibot's stores");
      if (store && store !== r.id) throw bad(`That link is on ${r.name}, not ${retailers.name(store)}`);
      store = r.id;
      sku = retailers.skuFromUrl(sku);
      if (!sku) throw bad("Couldn't find the product code in that link: enter the SKU instead");
    }
    if (sku.length > 80) throw bad('That SKU is too long');
    if (!store && !sku) throw bad('Choose a store, enter a SKU, or both');
    const known = store && sku ? ctx.catalog.productFor(store, sku) : null;
    const name = str(req.body.name, 200) || (known && known.name) || '';
    const out = ctx.catalog.addBlacklist({ store, sku, name, note: str(req.body.note, 300), createdBy: req.user.id });
    if (out.created) repo.audit(req.user.id, null, 'blacklist-add', `${store || 'every store'} ${sku || '(every product)'}${out.monitorsRemoved ? ` · ${out.monitorsRemoved} monitor(s) removed` : ''}`);
    return out;
  }, opts);

  router.delete('/api/admin/blacklist/:id', async (req) => {
    const e = ctx.catalog.removeBlacklist(req.params.id);
    if (!e) throw new HttpError(404, 'That entry is already gone');
    repo.audit(req.user.id, null, 'blacklist-remove', `${e.store || 'every store'} ${e.sku || '(every product)'}`);
    return { ok: true };
  }, opts);

  // --- Retailers and their checkout flows ----------------------------------------------
  router.get('/api/admin/retailers', async () => ({
    retailers: retailers.list.map((r) => ({
      ...retailers.publicList({ all: true }).find((x) => x.id === r.id),
      hosts: r.hosts, devPath: r.devPath || null, flow: serialize(r.flow), monitor: r.monitor,
    })),
  }), opts);

  router.put('/api/admin/retailers/:id', async (req) => {
    const r = retailers.get(req.params.id);
    if (!r || r.id === 'other') throw new HttpError(404, 'Retailer not found');
    const current = retailers.settings(r);
    const next = {
      enabled: req.body.enabled === undefined ? current.enabled : bool(req.body.enabled),
      serverChecks: req.body.serverChecks === undefined ? current.serverChecks : bool(req.body.serverChecks),
      browserChecks: req.body.browserChecks === undefined ? current.browserChecks : bool(req.body.browserChecks),
    };
    repo.setSetting(`retailer:${r.id}`, next);
    repo.audit(req.user.id, null, 'retailer', `${r.name}: ${Object.entries(next).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ')}`);
    return { retailer: retailers.publicList({ all: true }).find((x) => x.id === r.id) };
  }, opts);

  // --- Integrations: is everything set up? ----------------------------------------------
  router.get('/api/admin/integrations', async () => ({
    whop: whop.status(),
    discord: {
      oauth: discord.oauthReady, bot: discord.botReady, commands: discord.interactionsReady,
      guildId: cfg.discord.guildId || null, memberRoleId: cfg.discord.memberRoleId || null, restockChannelId: cfg.discord.restockChannelId || null,
      restockRoleId: cfg.discord.restockRoleId || null, inviteUrl: cfg.discord.inviteUrl || null, kickOnExpire: cfg.discord.kickOnExpire,
      redirectUri: discord.redirectUri, interactionsUrl: `${cfg.baseUrl}/api/discord/interactions`,
    },
    email: { configured: ctx.mailer.configured },
    monitor: { intervalSeconds: cfg.monitor.urlIntervalSeconds, browserIntervalSeconds: cfg.monitor.browserIntervalSeconds, hostGapSeconds: cfg.monitor.hostGapSeconds, userAgent: cfg.monitor.userAgent },
    baseUrl: cfg.baseUrl,
    demoStoreUrl: cfg.demoStoreUrl || null,
    trialDays: cfg.trialDays,
    price: cfg.priceDisplay,
  }), opts);

  router.post('/api/admin/integrations/discord-check', async () => ({ checks: await discord.check() }), opts);

  router.post('/api/admin/integrations/discord-commands', async (req) => {
    const r = await discord.registerCommands(commandDefinitions(retailers, { minInterval: cfg.monitor.minIntervalSeconds }));
    repo.audit(req.user.id, null, 'discord-commands', r.ok ? r.names.join(' ') : r.error);
    if (!r.ok) throw new HttpError(502, r.error);
    return { commands: r.names };
  }, opts);

  router.post('/api/admin/integrations/discord-post', async (req) => {
    if (!discord.botReady || !cfg.discord.restockChannelId) throw bad('Set DISCORD_BOT_TOKEN, DISCORD_GUILD_ID and DISCORD_RESTOCK_CHANNEL_ID first');
    const ok = await discord.post(cfg.discord.restockChannelId, ctx.notifier.message({ level: 'info', title: `${cfg.appName} is connected`, message: `Restocks of announced SKUs will be posted here. (Test message from ${req.user.username}.)` }));
    if (!ok) throw new HttpError(502, "Couldn't post — run the setup check above");
    return { ok: true };
  }, opts);

  // --- The browser extension: Chrome Web Store link, package, who's on which copy -------
  // Copies from the Chrome Web Store update by themselves; downloaded ones don't.
  // docs/CHROME-WEB-STORE.md walks through publishing it.
  const extensionInfo = () => {
    const setByAdmin = repo.getSetting('chrome_store_url') || '';
    return {
      version: EXTENSION_VERSION,
      storeUrl: storeUrl(cfg, repo) || null,
      storeUrlFrom: setByAdmin ? 'admin' : cfg.chromeStoreUrl ? 'env' : null,
      browsers: repo.extensionCounts(repo.now() - 30 * DAY).map((r) => ({ version: r.version || '?', source: r.source || 'unknown', count: r.n })),
      packageUrl: '/api/admin/extension/webstore.zip',
      autoPublish: 'GitHub Actions publishes each new version when it is merged, once the CWS_* settings are added (docs/CHROME-WEB-STORE.md)',
    };
  };
  router.get('/api/admin/extension', async () => extensionInfo(), opts);

  router.put('/api/admin/extension', async (req) => {
    const url = str(req.body.storeUrl, 300).trim();
    if (url && !isStoreUrl(url)) throw bad('Paste the listing link from the Chrome Web Store (https://chromewebstore.google.com/detail/…)');
    repo.setSetting('chrome_store_url', url || null);
    repo.audit(req.user.id, null, 'extension-store-link', url || 'removed');
    return extensionInfo();
  }, opts);

  // The package to upload to the Chrome Web Store (built for this site's addresses).
  router.get('/api/admin/extension/webstore.zip', async () => ({
    $raw: storeZip(cfg),
    type: 'application/zip',
    headers: { 'content-disposition': `attachment; filename="${cfg.appName.toLowerCase()}-webstore-${EXTENSION_VERSION}.zip"` },
  }), opts);

  // --- Whop memberships (including ones nobody has linked yet) -------------------------
  router.get('/api/admin/whop/memberships', async (req) => ({ memberships: repo.listMemberships({ unlinked: req.query.get('unlinked') === '1' }) }), opts);

  router.get('/api/admin/audit', async () => ({ entries: repo.listAudit(200) }), opts);
}
