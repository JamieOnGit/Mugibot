// Discord: the dashboard's Discord tab, and slash commands.
//
// Slash commands arrive at /api/discord/interactions, signed by Discord with
// Ed25519 (checked against DISCORD_PUBLIC_KEY before anything else). They
// act for the Mugibot account the Discord user has connected, and answer
// privately (only that person sees the reply).

import crypto from 'node:crypto';
import { entitlement } from '../entitlement.js';
import { STATUS_LABEL } from '../monitor/status.js';
import { HttpError, bad, item as checkItem, num, str } from '../schema.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const EPHEMERAL = 64;

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

/** The slash commands, as registered with Discord (npm run discord:commands). */
export function commandDefinitions(retailers) {
  const stores = retailers.publicList().filter((r) => !r.demo).slice(0, 25).map((r) => ({ name: r.name, value: r.id }));
  const storeOpt = (required) => ({ type: 3, name: 'store', description: 'Which store (not needed if you paste a product link)', required, choices: stores });
  return [
    {
      name: 'watch', description: 'Watch a SKU — get a DM with a ⚡ Buy button when it restocks', dm_permission: true,
      options: [
        { type: 3, name: 'sku', description: 'The SKU / keycode, or paste the product link', required: true },
        storeOpt(false),
        { type: 4, name: 'quantity', description: 'How many ⚡ Buy adds to your bag (1–10)', min_value: 1, max_value: 10 },
        { type: 10, name: 'max_price', description: 'Only ping me at or below this price ($)', min_value: 0 },
      ],
    },
    { name: 'unwatch', description: 'Stop watching a SKU', dm_permission: true, options: [{ type: 3, name: 'sku', description: 'The SKU / keycode', required: true }, storeOpt(false)] },
    { name: 'watchlist', description: 'Your SKUs and their stock right now', dm_permission: true },
    { name: 'buy', description: 'A ⚡ Buy button for one of your SKUs', dm_permission: true, options: [{ type: 3, name: 'sku', description: 'The SKU / keycode', required: true }, { type: 4, name: 'quantity', description: 'How many (1–10)', min_value: 1, max_value: 10 }] },
    { name: 'status', description: 'Your Mugibot membership, browser extension and Discord connection', dm_permission: true },
    {
      name: 'restock', description: '(Admins) Ping everyone watching a SKU that it is in stock', dm_permission: false, default_member_permissions: '32',
      options: [storeOpt(true), { type: 3, name: 'sku', description: 'The SKU / keycode', required: true }, { type: 3, name: 'note', description: 'Anything to add (e.g. "online only, limit 2")' }],
    },
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
    if (i.type !== 2) return reply('That isn\'t supported.');
    const discordId = (i.member && i.member.user && i.member.user.id) || (i.user && i.user.id);
    if (!limiter.hit(`slash:${discordId}`, 20, 60 * 1000)) return reply('Slow down a little — try again in a minute.');
    try {
      return await command(i, discordId);
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

  async function command(i, discordId) {
    const name = i.data && i.data.name;
    const opts = Object.fromEntries(((i.data && i.data.options) || []).map((o) => [o.name, o.value]));
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
      if (opts.quantity) input.quantity = opts.quantity;
      if (opts.max_price !== undefined) input.maxPrice = opts.max_price;
      const it = repo.addItem(user.id, checkItem(input, { retailers }));
      const note = ent.active ? '' : `\n⚠️ Monitoring starts once your membership is active: ${cfg.baseUrl}/app#membership`;
      return reply(`👀 Watching **${it.name}** — ${retailers.name(it.store)} · SKU ${it.sku} · quantity ${it.quantity}. I'll DM you when it's in stock.${it.url ? '' : ' (Not listed yet — I\'ll find the product page when it goes up.)'}${note}`);
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
        const buy = x.url && ent.active ? ` · [⚡ Buy ×${x.quantity}](${ctx.notifier.buyLink(user.id, x)})` : '';
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
      const qty = num(opts.quantity, { min: 1, max: 10, int: true, def: it.quantity });
      if (qty !== it.quantity) repo.db.run('UPDATE items SET quantity = :q WHERE id = :id AND user_id = :u', { q: qty, id: it.id, u: user.id });
      return reply('', card({
        level: 'urgent', title: `⚡ ${it.name}`, message: `${retailers.name(it.store)} · SKU ${it.sku} · ${label(it.status)}\nOpens in the browser where the ${cfg.appName} extension is connected, adds ${qty} to your bag and fills in checkout. You press the final button.`,
        url: it.url, buttons: [{ label: `⚡ Buy ×${qty}`, url: ctx.notifier.buyLink(user.id, it, qty) }, { label: 'Open product', url: it.url }],
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
            { name: 'Browser extension', value: devices ? `${devices} connected` : 'Not connected — see the Extension tab', inline: true },
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
    return reply('Unknown command.');
  }
}
