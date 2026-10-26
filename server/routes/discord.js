// Discord: the dashboard's Discord tab, and slash commands.
//
// Slash commands, and the ⚡ Buy buttons on alerts and DMs, arrive at
// /api/discord/interactions, signed by Discord with Ed25519 (checked against
// DISCORD_PUBLIC_KEY before anything else). They act for the Mugibot account
// the Discord user has connected, and answer privately (only that person sees
// the reply).

import crypto from 'node:crypto';
import { linkRows } from '../aco.js';
import { entitlement } from '../entitlement.js';
import { CATEGORIES } from '../catalog.js';
import { buyAction } from '../notifier.js';
import { STATUS_LABEL } from '../monitor/status.js';
import { HttpError, bad, item as checkItem, str } from '../schema.js';
import { alertItem } from './web.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const EPHEMERAL = 64;
const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '');

/** Is this request really from Discord? */
export function verifyDiscordSignature(publicKeyHex, signatureHex, timestamp, rawBody) {
  try {
    if (!/^[0-9a-f]{64}$/i.test(publicKeyHex || '') || !/^[0-9a-f]{128}$/i.test(signatureHex || '') || !timestamp) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.concat([Buffer.from(String(timestamp)), rawBody]), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

const CATEGORY_CHOICES = Object.entries(CATEGORIES).map(([value, name]) => ({ name, value }));
const ALERT_EMOJI = { restock: '🟢', listed: '🆕', sold_out: '🔴', price_drop: '📉', price_rise: '📈' };

/** The slash commands, as registered with Discord (Admin → Setup check → Register slash commands). */
export function commandDefinitions(retailers, { minInterval = 20 } = {}) {
  const stores = retailers.publicList().filter((r) => !r.demo).slice(0, 25).map((r) => ({ name: r.name, value: r.id }));
  const storeOpt = (required) => ({ type: 3, name: 'store', description: 'Which store (not needed if you paste a product link)', required, choices: stores });
  const categoryOpt = (description) => ({ type: 3, name: 'category', description, choices: CATEGORY_CHOICES });
  const target = [{ type: 3, name: 'target', description: 'The SKU, the product link, or the monitor ID', required: true }, storeOpt(false)];
  return [
    {
      name: 'watch', description: 'Watch a SKU — get a DM with a ⚡ Buy button when it restocks', dm_permission: true,
      options: [
        { type: 3, name: 'sku', description: 'The SKU / keycode, or paste the product link', required: true },
        storeOpt(false),
        { type: 10, name: 'max_price', description: 'Only ping me at or below this price ($)', min_value: 0 },
      ],
    },
    { name: 'unwatch', description: 'Stop watching a SKU', dm_permission: true, options: [{ type: 3, name: 'sku', description: 'The SKU / keycode', required: true }, storeOpt(false)] },
    { name: 'watchlist', description: 'Your SKUs and their stock right now', dm_permission: true },
    { name: 'buy', description: 'A ⚡ Buy button for one of your SKUs', dm_permission: true, options: [{ type: 3, name: 'sku', description: 'The SKU / keycode', required: true }] },
    { name: 'status', description: 'Your Mugibot membership, browser extension and Discord connection', dm_permission: true },
    {
      name: 'restock', description: '(Admins) Ping everyone watching a SKU that it is in stock', dm_permission: false, default_member_permissions: '32',
      options: [storeOpt(true), { type: 3, name: 'sku', description: 'The SKU / keycode', required: true }, { type: 3, name: 'note', description: 'Anything to add (e.g. "online only, limit 2")' }],
    },
    {
      name: 'monitor', description: '(Admins) The Monitor feed: add, list, pause, resume, remove, status', dm_permission: false, default_member_permissions: '32',
      options: [
        {
          type: 1, name: 'add', description: 'Monitor a product and post its restocks in your channels',
          options: [
            { type: 3, name: 'link', description: 'The product link (or a SKU, with the store option)', required: true },
            categoryOpt('Pokémon, One Piece or Other (guessed from the name if left out)'),
            storeOpt(false),
            { type: 4, name: 'interval', description: `Seconds between checks (${minInterval}–3600; default 60)`, min_value: minInterval, max_value: 3600 },
            { type: 3, name: 'name', description: "The name to show (default: the store page's)" },
          ],
        },
        {
          type: 1, name: 'list', description: 'Monitored products and their stock right now',
          options: [categoryOpt('Only this category'), storeOpt(false), {
            type: 3, name: 'status', description: 'Only these', choices: [{ name: 'Available now', value: 'available' }, { name: 'Not available', value: 'unavailable' }, { name: 'Having problems', value: 'problem' }, { name: 'Paused', value: 'paused' }],
          }],
        },
        { type: 1, name: 'pause', description: 'Stop checking a product (and its alerts) for now', options: target },
        { type: 1, name: 'resume', description: 'Start checking a paused product again', options: target },
        { type: 1, name: 'remove', description: 'Stop monitoring a product (its history is kept)', options: target },
        { type: 1, name: 'status', description: 'Monitoring health: checks, stores, latest alerts' },
      ],
    },
    { name: 'restocks', description: 'The latest restocks and price changes from the Monitor', dm_permission: true, options: [categoryOpt('Only this category')] },
  ];
}

export function register(router, ctx) {
  const { cfg, repo, discord, retailers, limiter } = ctx;

  // --- Dashboard: the Discord tab ------------------------------------------------
  router.get('/api/discord', async (req) => {
    const u = req.user;
    return {
      oauth: discord.oauthReady,
      bot: discord.botReady,
      linked: !!u.discord_id,
      username: u.discord_username || null,
      inServer: !!u.discord_in_guild,
      hasRole: !!u.discord_role,
      error: u.discord_error || '',
      inviteUrl: cfg.discord.inviteUrl || null,
      commands: discord.interactionsReady,
    };
  });

  router.post('/api/discord/sync', async (req) => {
    if (!limiter.hit(`dsync:${req.user.id}`, 10, 10 * 60 * 1000)) throw new HttpError(429, 'Try again in a few minutes');
    if (!req.user.discord_id) throw bad('Connect Discord first');
    return { sync: await discord.sync(req.user) };
  });

  router.post('/api/discord/unlink', async (req) => {
    await discord.unlink(req.user);
    repo.addEvent(req.user.id, { type: 'account', level: 'info', message: 'Discord disconnected.' });
    return { ok: true };
  });

  router.post('/api/discord/test', async (req) => {
    if (!limiter.hit(`dtest:${req.user.id}`, 5, 10 * 60 * 1000)) throw new HttpError(429, 'You can send 5 test messages every 10 minutes');
    if (!req.user.discord_id) throw bad('Connect Discord first');
    if (!discord.botReady) throw new HttpError(503, "The Discord bot isn't set up on this server yet");
    const ok = await discord.dm(req.user, ctx.notifier.message({ level: 'urgent', title: '🟢 Test ping', message: `This is how ${cfg.appName} restock pings look in your DMs.`, buttons: [{ label: 'Open dashboard', url: `${cfg.baseUrl}/app` }] }));
    if (!ok) throw new HttpError(502, repo.userById(req.user.id).discord_error || "Couldn't DM you — check that you're in the server and allow DMs from server members");
    return { ok: true };
  });

  // --- Slash commands ------------------------------------------------------------------
  router.post('/api/discord/interactions', async (req) => {
    if (!discord.interactionsReady) throw new HttpError(404, 'Not found');
    const ok = verifyDiscordSignature(cfg.discord.publicKey, String(req.headers['x-signature-ed25519'] || ''), String(req.headers['x-signature-timestamp'] || ''), req.rawBody);
    if (!ok) throw new HttpError(401, 'invalid request signature');
    let i;
    try { i = JSON.parse(req.rawBody.toString('utf8')); } catch { throw bad('Bad JSON'); }
    if (i.type === 1) return { type: 1 }; // PING
    if (i.type !== 2 && i.type !== 3) return reply('That isn\'t supported.');
    const discordId = (i.member && i.member.user && i.member.user.id) || (i.user && i.user.id);
    if (!limiter.hit(`slash:${discordId}`, 20, 60 * 1000)) return reply('Slow down a little — try again in a minute.');
    try {
      // 3: a button on one of the bot's messages (⚡ Buy); 2: a slash command.
      return i.type === 3 ? await press(i, discordId) : await command(i, discordId);
    } catch (e) {
      if (e instanceof HttpError) return reply(`⚠️ ${e.message}`);
      cfg.log('[discord] command failed', e.stack || e.message);
      return reply('⚠️ Something went wrong on our side — try again.');
    }
  }, { auth: 'none', csrf: false, raw: true });

  function reply(content, extra = {}) {
    return { type: 4, data: { flags: EPHEMERAL, content: content || undefined, allowed_mentions: { parse: [] }, ...extra } };
  }

  function card(ev) {
    const m = ctx.notifier.message(ev);
    return { embeds: m.embeds, components: m.components };
  }

  /**
   * ⚡ Buy pressed — on a phone, a computer, anywhere. Discord says who pressed it, so it checks out
   * in their checkout browser (server/aco.js remote()): nothing to sign in to, and no browser
   * needed, where they pressed it. The reply (only they see it) is kept up to date as it goes.
   * custom_id: 'buy:a:<alert>' (a Monitor alert in a channel) or 'buy:i:<item>' (their own SKU).
   */
  async function press(i, discordId) {
    const q = String((i.data && i.data.custom_id) || '').match(/^queue:([\w-]{1,40})$/);
    if (q) return joinQueue(q[1], discordId);
    // 🤝 Group Queue / 🤝 Group Checkpoint: on a pool's leader's own DM (server/monitor/gates.js tellMembers).
    const g = String((i.data && i.data.custom_id) || '').match(/^g(q|c):([\w-]{1,40})$/);
    if (g) return groupGate(g[1] === 'q' ? 'queue' : 'checkpoint', g[2], discordId);
    const m = String((i.data && i.data.custom_id) || '').match(/^buy:(a|i):([\w-]{1,60})$/);
    if (!m) return reply('That button is from an older message — use a newer one.');
    const alert = m[1] === 'a' ? ctx.catalog.alertById(m[2]) : null;
    const user = repo.userByDiscordId(discordId);
    if (!user) return reply(`Your Discord isn't connected to a ${cfg.appName} account yet. Log in at ${cfg.baseUrl}/app#discord and press **Connect Discord** — then ⚡ Buy checks out in your computer's browser, wherever you press it.`);
    if (user.disabled) return reply('Your account is suspended — contact support.');
    if (!entitlement(user, repo.now()).active) return reply(`⚡ Buy needs an active membership: ${cfg.baseUrl}/app#membership`);
    let item;
    let price = null;
    if (m[1] === 'i') {
      item = repo.getItem(user.id, m[2]);
      if (!item) return reply('That SKU isn\'t on your watchlist any more.');
      price = item.lastPrice ?? item.price ?? null;
    } else {
      if (!alert) return reply('That alert is too old to buy from — look for a newer one.');
      // Theirs if it's on their watchlist, else added to it (like the alert's link does).
      item = alertItem(ctx, user, alert);
      if (!item) return reply(repo.countItems(user.id) >= cfg.limits.items ? `Your watchlist is full (${cfg.limits.items} SKUs) — remove one to buy this.` : 'That product\'s page isn\'t known yet.');
      price = alert.price;
    }
    const out = await ctx.aco.remote(user.id, item.id, { price });
    // (A pool's leader's own checkout couldn't start — their group's did all the same: aco.js remote().)
    if (out.error) return reply(`⚠️ ${out.error}${out.group ? `\n🤝 **Group Buy**: the ${out.group} member${out.group === 1 ? '' : 's'} of your pool who check out with you ${out.group === 1 ? 'starts theirs' : 'start theirs'} all the same — each in their own checkout browser, with their own card and within their own limits.` : ''}`);
    // (A pool's leader: their ⚡ Buy — 🤝 Group Buy on their own DMs — starts their group's checkouts too: aco.js remote().)
    const group = ctx.pools ? ctx.pools.group(user.id).length : 0;
    const how = (out.mode === 'place'
      ? `It places the order by itself, within your Auto-checkout limits (up to ${money(out.run.maxPrice)} for it, plus delivery).`
      : `It fills checkout in and stops at the final button — ${out.why}.`)
      + (group ? `\n🤝 **Group Buy**: the ${group} member${group === 1 ? '' : 's'} of your pool who check out with you ${group === 1 ? 'starts theirs' : 'start theirs'} too — each in their own checkout browser, with their own card and within their own limits.` : '');
    ctx.aco.follow(out.run.id, i.token, out.device.name, how);
    // (Not open: it starts the moment it is — or, with the backup on, the moment any browser of yours is.
    //  standIn: the checkout browser isn't open, so another of yours, open, checks out instead.)
    const asleep = !out.listening ? `\n⚠️ **${out.device.name}** isn't open right now${out.fallback ? ', nor is any other browser of yours' : ''} — it starts as soon as ${out.fallback ? 'one is' : 'it is'} (within 2 minutes).`
      : out.standIn ? `\nℹ️ **${out.standIn}** (your checkout browser) isn't open, so **${out.device.name}** checks out instead.` : '';
    // The store's checkpoint is up right now: the computer will stop at it for a human — say so, with
    // the two ways through from the phone (server/aco.js phoneButtons()).
    const gate = ctx.gates ? ctx.gates.get(item.store) : null;
    if (gate && gate.kind === 'checkpoint' && gate.status === 'up') {
      const where = retailers.name(item.store);
      const row = { ...out.run, user_id: user.id, device_id: null, status: 'queued', reason: '' };
      return reply(`${ctx.aco.remoteText(out.run, out.device.name)}\n${how}${asleep}\n🛡️ **${where}'s checkpoint is up right now**: **${out.device.name}** will stop at it for a human check — a check for that browser, so solving it on your phone can't let it through. From here: **🖥️ Solve it on my computer** (Chrome Remote Desktop) when it gets there, or **📱 Finish on this phone** now — your computer won't start it, and ${where} opens here for you to pass the check and pay.`,
        { components: linkRows(ctx.aco.phoneButtons(row)) });
    }
    return reply(`${ctx.aco.remoteText(out.run, out.device.name)}\n${how}${asleep}`);
  }

  /**
   * "📥 Join the queue on my computer" on a #virtual-queue-detection post (monitor/gates.js): the
   * member's checkout browser opens the store in a tab of its own and waits its turn in line there
   * (never refreshing it). Their ⚡ Buy and Auto-checkout at that store carry on from that tab once
   * it's through.
   */
  async function joinQueue(store, discordId) {
    const user = repo.userByDiscordId(discordId);
    if (!user) return reply(`Your Discord isn't connected to a ${cfg.appName} account yet. Log in at ${cfg.baseUrl}/app#discord and press **Connect Discord** — then this puts your computer's browser in line.`);
    const out = ctx.aco.joinQueue(user.id, store);
    // (A pool's leader: the members who check out with them got in line too — aco.js joinQueue → pools.js groupQueue.)
    const pool = out.pool && out.pool.of ? `\n🤝 **Group Queue**: ${groupLine(out.pool.put, out.pool.of, ['is getting in line too', 'are getting in line too'], ' — each a tab of its own in their own checkout browser, their own place in line')}` : '';
    if (out.error) return reply(`⚠️ ${out.error}${pool}`);
    const name = out.lobby.storeName;
    const asleep = out.listening ? '' : `\n⚠️ **${out.device.name}** isn't open right now — it gets in line as soon as it is (Discord's ⚡ Buy from your phone needs to be on: ${cfg.baseUrl}/app#aco).`;
    return reply(`🚦 **${out.device.name}** is getting in line at ${name}: a tab of its own opens there and waits its turn. Leave it alone — the queue page refreshes itself, and refreshing it yourself can lose your place. ⚡ Buy and Auto-checkout at ${name} carry on from there once you're through.${asleep}${pool}`);
  }

  /**
   * "All 3 members of your pool who check out with you are getting in line too…" — or "2 of the 3 … ; 1 couldn't".
   * verbs: [one, many] (put === 1 takes the first).
   */
  function groupLine(put, of, [one, many], rest = '') {
    if (!put) return `none of the ${of === 1 ? 'member' : `${of} members`} of your pool who check out with you could — their Auto-checkout is off, or no checkout browser is connected to their account (they're told).`;
    const who = put === of ? (of === 1 ? 'the member' : `all ${of} members`) : `${put} of the ${of} members`;
    const left = of - put;
    return `${who} of your pool who check out with you ${put === 1 ? one : many}${rest}.`
      + (left ? ` ${left} couldn't (their Auto-checkout is off, or no checkout browser is connected to their account) — they're told.` : '');
  }

  /**
   * 🤝 Group Queue / 🤝 Group Checkpoint, on a pool's leader's own DM: for the leader and the members who check out
   * with them. Anyone else pressing one (a forwarded DM, an old one) is told it's the leader's.
   */
  async function groupGate(kind, store, discordId) {
    const user = repo.userByDiscordId(discordId);
    if (!user) return reply(`Your Discord isn't connected to a ${cfg.appName} account yet. Log in at ${cfg.baseUrl}/app#discord and press **Connect Discord**.`);
    if (user.disabled) return reply('Your account is suspended — contact support.');
    if (!entitlement(user, repo.now()).active) return reply(`This needs an active membership: ${cfg.baseUrl}/app#membership`);
    if (!ctx.pools || !ctx.pools.leadsGroup(user.id)) return reply("🤝 That button is for a pool's leader — one whose pool has members who check out with them.");
    if (kind === 'queue') return joinQueue(store, discordId);
    const out = ctx.pools.groupCheckpoint(user.id, store);
    if (out.error) return reply(`⚠️ ${out.error}`);
    const name = out.store.name;
    const own = !out.device
      ? `⚠️ No browser with the ${cfg.appName} extension is connected to your account — connect your checkout browser at ${cfg.baseUrl}/app#extension.`
      : `🛡️ **${out.device.name}** is opening ${name}'s check page in a tab: solve it there — it has to be solved in that browser (from your phone: 🖥️ Chrome Remote Desktop).${out.listening ? '' : ` ⚠️ It isn't open right now — the page opens as soon as it is.`}`;
    return reply(`${own}\n🤝 **Group Checkpoint**: ${groupLine(out.opened, out.of, ['has it opened in their checkout browser too', 'have it opened in their checkout browsers too'], ', and told to solve it there before the drop — a human check: each solves their own')}`);
  }

  async function command(i, discordId) {
    const name = i.data && i.data.name;
    const first = ((i.data && i.data.options) || [])[0];
    // /monitor <subcommand> carries its options one level down.
    const sub = first && first.type === 1 ? first.name : null;
    const opts = Object.fromEntries(((sub ? first.options : i.data && i.data.options) || []).map((o) => [o.name, o.value]));
    const user = repo.userByDiscordId(discordId);
    if (!user) return reply(`Your Discord isn't connected to a ${cfg.appName} account yet. Log in at ${cfg.baseUrl}/app#discord and press **Connect Discord**.`);
    if (user.disabled) return reply('Your account is suspended — contact support.');
    const ent = entitlement(user, repo.now());
    const label = (s) => STATUS_LABEL[s] || (s === 'pending' ? 'Checking soon' : s);

    if (name === 'watch') {
      if (repo.countItems(user.id) >= cfg.limits.items) return reply(`You can watch up to ${cfg.limits.items} SKUs.`);
      const raw = str(opts.sku, 2000);
      const input = /^https?:\/\//i.test(raw) ? { url: raw } : { store: str(opts.store, 40), sku: raw };
      if (!input.url && !input.store) return reply('Which store? Add the `store` option, or paste the product link instead of the SKU.');
      if (opts.max_price !== undefined) input.maxPrice = opts.max_price;
      const it = repo.addItem(user.id, checkItem(input, { retailers }));
      const note = ent.active ? '' : `\n⚠️ Monitoring starts once your membership is active: ${cfg.baseUrl}/app#membership`;
      return reply(`👀 Watching **${it.name}** — ${retailers.name(it.store)} · SKU ${it.sku}. I'll DM you when it's in stock.${it.url ? '' : ' (Not listed yet — I\'ll find the product page when it goes up.)'}${note}`);
    }

    if (name === 'unwatch') {
      const sku = str(opts.sku, 60);
      const matches = repo.listItems(user.id).filter((x) => x.sku.toLowerCase() === sku.toLowerCase() && (!opts.store || x.store === opts.store));
      if (!matches.length) return reply(`SKU ${sku} isn't on your watchlist.`);
      if (matches.length > 1) return reply(`SKU ${sku} is on your list at ${matches.map((x) => retailers.name(x.store)).join(' and ')} — add the \`store\` option.`);
      repo.deleteItem(user.id, matches[0].id);
      return reply(`Stopped watching **${matches[0].name}** (${retailers.name(matches[0].store)} · SKU ${sku}).`);
    }

    if (name === 'watchlist') {
      const items = repo.listItems(user.id);
      if (!items.length) return reply(`Your watchlist is empty. Add a SKU with \`/watch\` or at ${cfg.baseUrl}/app`);
      const lines = items.slice(0, 20).map((x) => {
        const buy = x.url && ent.active ? ` · [⚡ Buy](${ctx.notifier.buyLink(user.id, x)})` : '';
        return `${x.monitor ? '•' : '⏸'} **${x.name}** — ${retailers.name(x.store)} · \`${x.sku}\` · ${label(x.status)}${buy}`;
      });
      if (items.length > 20) lines.push(`…and ${items.length - 20} more at ${cfg.baseUrl}/app`);
      return reply('', { embeds: [{ title: `Your watchlist (${items.length})`, description: lines.join('\n').slice(0, 4000), color: 0x2563eb, url: `${cfg.baseUrl}/app#watch` }] });
    }

    if (name === 'buy') {
      if (!ent.active) return reply(`⚡ Buy needs an active membership: ${cfg.baseUrl}/app#membership`);
      const sku = str(opts.sku, 60);
      const it = repo.listItems(user.id).find((x) => x.sku.toLowerCase() === sku.toLowerCase());
      if (!it) return reply(`SKU ${sku} isn't on your watchlist — add it with \`/watch\` first.`);
      if (!it.url) return reply(`The product page for SKU ${sku} hasn't been found yet.`);
      return reply('', card({
        level: 'urgent', title: `⚡ ${it.name}`, message: `${retailers.name(it.store)} · SKU ${it.sku} · ${label(it.status)}\nPress ⚡ Buy, from here or your phone: your checkout browser (the one with the ${cfg.appName} extension) opens the store and checks out — placing the order within your limits with Auto-checkout on, or stopping at the final button for you.`,
        url: it.url, buttons: [{ label: '⚡ Buy', url: ctx.notifier.buyLink(user.id, it), action: buyAction('i', it.id) }, { label: 'Open product', url: it.url }],
      }));
    }

    if (name === 'status') {
      const devices = repo.listDevices(user.id).length;
      const items = repo.listItems(user.id);
      const instock = items.filter((x) => x.status === 'in_stock' || x.status === 'preorder').length;
      return reply('', {
        embeds: [{
          title: `${cfg.appName} — ${user.username}`, color: ent.active ? 0x16a34a : 0xd97706, url: `${cfg.baseUrl}/app`,
          fields: [
            { name: 'Membership', value: ent.label, inline: true },
            { name: 'Watchlist', value: `${items.length} SKUs (${instock} available now)`, inline: true },
            { name: 'Browser extension', value: devices ? `${devices} connected` : 'Not connected — see the Setup page', inline: true },
            { name: 'Members\' server', value: user.discord_in_guild ? (user.discord_role || !cfg.discord.memberRoleId ? 'In the server ✓' : 'In the server, no member role yet') : 'Not in the server', inline: true },
          ],
        }],
      });
    }

    if (name === 'restock') {
      if (user.role !== 'admin') return reply('Only admins can do that.');
      const store = str(opts.store, 40);
      if (!retailers.get(store)) return reply('Unknown store.');
      const sku = str(opts.sku, 60);
      const watchers = repo.db.get('SELECT COUNT(*) AS n FROM items WHERE store = :s AND sku = :k COLLATE NOCASE AND monitor = 1', { s: store, k: sku }).n;
      repo.audit(user.id, null, 'restock-ping', `${store} ${sku} (Discord)${opts.note ? `: ${opts.note}` : ''}`);
      ctx.monitor.broadcastRestock({ store, sku, note: str(opts.note, 200) }).catch((e) => cfg.log('[discord] restock ping failed', e.message));
      return reply(`📣 Pinging ${watchers} member${watchers === 1 ? '' : 's'} watching ${retailers.name(store)} SKU ${sku}${cfg.discord.restockChannelId ? ', and posting in the restock channel' : ''}.`);
    }
    if (name === 'monitor') {
      if (user.role !== 'admin') return reply('Only Mugibot admins can manage monitors.');
      return monitorCommand(sub, opts, user);
    }

    if (name === 'restocks') {
      if (!ent.active) return reply(`The Monitor feed is for members: ${cfg.baseUrl}/app#membership`);
      const alerts = ctx.catalog.recentAlerts({ limit: 10, category: str(opts.category, 20) });
      if (!alerts.length) return reply(`No alerts yet. The live feed is at ${cfg.baseUrl}/app#monitor`);
      const lines = alerts.map((a) => `${ALERT_EMOJI[a.kind] || '•'} **${a.name}** — ${retailers.name(a.store)}${typeof a.price === 'number' ? ` · $${a.price.toFixed(2)}` : ''} · <t:${Math.floor(a.at / 1000)}:R>${a.kind !== 'sold_out' ? ` · [⚡ Buy](${ctx.notifier.alertBuyLink(a)})` : ''}`);
      return reply('', { embeds: [{ title: 'Latest from the Monitor', description: lines.join('\n').slice(0, 4000), color: 0x16a34a, url: `${cfg.baseUrl}/app#monitor` }] });
    }
    return reply('Unknown command.');
  }

  function monitorCommand(sub, opts, user) {
    const { catalog, monitorAdmin: manage } = ctx;
    const label = (s) => STATUS_LABEL[s] || (s === 'pending' ? 'Checking soon' : s);
    const money = (n) => (typeof n === 'number' ? ` · $${n.toFixed(2)}` : '');
    const find = () => {
      const m = catalog.findMonitor(str(opts.target, 2000), opts.store ? str(opts.store, 40) : null);
      if (!m) throw bad(`No monitor matches "${str(opts.target, 80)}". \`/monitor list\` shows them all.`);
      if (m.ambiguous) throw bad(`${m.ambiguous} monitors match — add the \`store\` option, or use the monitor ID from the dashboard.`);
      return m;
    };
    if (sub === 'add') {
      const raw = str(opts.link, 2000);
      const input = /^https?:\/\//i.test(raw) ? { url: raw } : { store: str(opts.store, 40), sku: raw };
      if (!input.url && !input.store) return reply('Which store? Add the `store` option, or paste the product link.');
      Object.assign(input, { category: opts.category, intervalSeconds: opts.interval, name: opts.name });
      const r = manage.add(input, user);
      const p = r.product;
      return reply(r.created
        ? `📡 Monitoring **${p.name || p.sku}** — ${retailers.name(p.store)} · SKU \`${p.sku}\` · ${CATEGORIES[p.category]} · every ${r.monitor.intervalSeconds || cfg.monitor.urlIntervalSeconds}s. First check in a moment.`
        : `**${p.name || p.sku}** is already monitored (${r.monitor.paused ? 'paused' : 'active'}).`);
    }
    if (sub === 'list') {
      const status = str(opts.status, 20);
      const list = catalog.listMonitors({ category: str(opts.category, 20), store: str(opts.store, 40), status: status === 'paused' ? '' : status, paused: status === 'paused' ? true : null, limit: 200 });
      if (!list.length) return reply(`No monitors${status || opts.category || opts.store ? ' match that' : ' yet — add one with `/monitor add`'}.`);
      const icon = (p) => (p.monitor.paused ? '⏸' : p.status === 'in_stock' || p.status === 'preorder' ? '🟢' : p.confirmed ? '⚪' : '⚠️');
      const lines = list.slice(0, 20).map((p) => `${icon(p)} **${p.name || p.sku}** — ${retailers.name(p.store)} · \`${p.sku}\`${money(p.price)} · ${label(p.status)}`);
      if (list.length > 20) lines.push(`…and ${list.length - 20} more at ${cfg.baseUrl}/app#monitor`);
      return reply('', { embeds: [{ title: `Monitors (${list.length})`, description: lines.join('\n').slice(0, 4000), color: 0x7c3aed, url: `${cfg.baseUrl}/app#monitor` }] });
    }
    if (sub === 'pause' || sub === 'resume') {
      const r = manage.update(find().id, { paused: sub === 'pause' }, user);
      return reply(`${sub === 'pause' ? '⏸ Paused' : '▶️ Resumed'} **${r.product.name || r.product.sku}** (${retailers.name(r.product.store)}).`);
    }
    if (sub === 'remove') {
      const r = manage.remove(find().id, user);
      return reply(`🗑 Stopped monitoring **${r.product.name || r.product.sku}** (${retailers.name(r.product.store)}). Its history is kept.`);
    }
    if (sub === 'status') {
      const o = catalog.overview();
      const stores = catalog.health();
      const tick = ctx.monitor.lastTickAt;
      const fields = [
        { name: 'Monitors', value: `${o.monitors} active · ${o.paused} paused · ${o.available} available now` },
        { name: 'Last 24 hours', value: `${o.restocks24h} restocks · ${o.priceChanges24h} price changes` },
        { name: 'Last hour', value: o.checks1h ? `${o.checks1h} checks · ${o.okRate1h}% OK` : 'No checks yet' },
        { name: 'Monitor loop', value: tick ? `Running · last tick <t:${Math.floor(tick / 1000)}:R>` : 'Not started' },
      ];
      if (stores.length) fields.push({ name: 'Stores (last hour)', value: stores.map((h) => `${retailers.name(h.store)}: ${h.ok}/${h.checks} OK${h.blocked ? ` · ${h.blocked} blocked` : ''}${h.errors ? ` · ${h.errors} errors` : ''}`).join('\n').slice(0, 1000) });
      return reply('', { embeds: [{ title: 'Monitor status', color: o.okRate1h === null || o.okRate1h >= 80 ? 0x16a34a : 0xd97706, fields, url: `${cfg.baseUrl}/app#monitor` }] });
    }
    return reply('Unknown subcommand.');
  }
}
