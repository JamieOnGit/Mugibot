// Adding, changing and removing monitors and Discord alert rules — shared by
// the dashboard (routes/monitor.js) and the /monitor slash command, so both
// check input the same way.

import { ALERT_KINDS, CATEGORIES, DEFAULT_KINDS, toMonitor, toProduct } from '../catalog.js';
import { NEWS_CHANNEL, NEWS_TOPIC, isNewsChannel } from '../news.js';
import { HttpError, bad, bool, item as checkItem, num, str } from '../schema.js';
import { OWN_CHANNEL_STORES } from './feed.js';
import { GATE_CHANNEL, GATE_TOPIC } from './gates.js';

const SNOWFLAKE = /^\d{5,25}$/;

function kindsFrom(v, { required = false } = {}) {
  if (v === undefined) return undefined;
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((k) => String(k).trim()).filter((k) => ALERT_KINDS.includes(k));
  if (required && !list.length) throw bad('Choose at least one kind of alert');
  return [...new Set(list)];
}

function categoryFrom(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const c = String(v).toLowerCase().replace(/[^a-z]/g, '');
  const key = { pokemon: 'pokemon', onepiece: 'onepiece', other: 'other', nontcg: 'nontcg' }[c];
  if (!key) throw bad(`Category must be one of: ${Object.values(CATEGORIES).join(', ')}`);
  return key;
}

export class MonitorAdmin {
  constructor(ctx) {
    this.ctx = ctx;
  }

  get catalog() { return this.ctx.catalog; }

  intervalFrom(v) {
    if (v === undefined) return undefined;
    if (v === null || v === '' || v === 0) return null;
    return num(v, { min: this.ctx.cfg.monitor.minIntervalSeconds, max: 3600, int: true, def: null });
  }

  /** The page the monitor loop checks for a product: its own page, or the store's search for its SKU. */
  pageFor(product) {
    if (product.url) return product.url;
    const r = this.ctx.retailers.get(product.store);
    return r ? this.ctx.retailers.searchUrl(r, product.sku) : null;
  }

  checkNow(product) {
    this.ctx.repo.ensurePageFor({ store: product.store, sku: product.sku, url: product.url });
    const page = this.pageFor(product);
    if (page) this.ctx.db.run('UPDATE page_checks SET next_check_at = 0 WHERE url = :url', { url: page });
    this.ctx.db.run('UPDATE products SET browser_next_at = 0 WHERE id = :id', { id: product.id });
  }

  /** input: { url } or { store, sku }, plus name, category, intervalSeconds, kinds, note, dropWatch (monitor/drops.js). */
  add(input, user) {
    const parsed = checkItem({ url: input.url, store: input.store, sku: input.sku, name: input.name }, { retailers: this.ctx.retailers });
    if (this.catalog.isBlocked(parsed.store, parsed.sku)) throw bad('That product is on the blacklist (Admin → Blacklist). Take it off the blacklist first.');
    const category = categoryFrom(input.category);
    const product = this.catalog.upsertProduct({ store: parsed.store, sku: parsed.sku, url: parsed.url, name: str(input.name, 120), category });
    const { monitor, created } = this.catalog.addMonitor(product.id, {
      intervalSeconds: this.intervalFrom(input.intervalSeconds) ?? null,
      kinds: kindsFrom(input.kinds, { required: true }) ?? DEFAULT_KINDS,
      note: str(input.note, 200),
      createdBy: user ? user.id : null,
    });
    // (A drop watch's monitor: one it made goes with the watch; one that was there before is taken on —
    // its alerts go where the watch's do — and left as it was when the watch goes. monitor/drops.js)
    if (input.dropWatch && (created || !monitor.drop_watch)) this.ctx.db.run('UPDATE monitors SET drop_watch = :w WHERE id = :id', { w: input.dropWatch, id: monitor.id });
    this.checkNow(product);
    if (created) this.ctx.repo.audit(user ? user.id : null, null, 'monitor-add', `${parsed.store} ${parsed.sku}`);
    return { product: toProduct(this.catalog.productById(product.id)), monitor: toMonitor(monitor), created };
  }

  update(id, input, user) {
    const m = this.catalog.monitorById(id);
    if (!m) throw bad('That monitor no longer exists');
    const product = this.catalog.productById(m.product_id);
    const set = {};
    const category = categoryFrom(input.category);
    if (category) set.category = category;
    if (input.name !== undefined && str(input.name, 120)) set.name = str(input.name, 120);
    if (Object.keys(set).length) this.catalog.updateProduct(product.id, set);
    const paused = input.paused === undefined ? undefined : bool(input.paused);
    const fresh = this.catalog.updateMonitor(id, {
      intervalSeconds: this.intervalFrom(input.intervalSeconds),
      paused,
      kinds: kindsFrom(input.kinds, { required: input.kinds !== undefined }),
      note: input.note === undefined ? undefined : str(input.note, 200),
    });
    if (paused === false) this.checkNow(product);
    if (paused !== undefined) this.ctx.repo.audit(user ? user.id : null, null, paused ? 'monitor-pause' : 'monitor-resume', `${product.store} ${product.sku}`);
    return { product: toProduct(this.catalog.productById(product.id)), monitor: toMonitor(fresh) };
  }

  remove(id, user) {
    const m = this.catalog.monitorById(id);
    if (!m) throw bad('That monitor no longer exists');
    const product = this.catalog.productById(m.product_id);
    this.catalog.deleteMonitor(id);
    this.ctx.repo.audit(user ? user.id : null, null, 'monitor-remove', `${product.store} ${product.sku}`);
    return { ok: true, product: toProduct(product) };
  }

  route(input, existing = null) {
    const src = { ...(existing || {}), ...(input || {}) };
    const name = str(src.name, 60);
    if (!name) throw bad('Give the rule a name, e.g. "Pokémon restocks"');
    const channelId = str(src.channelId, 30);
    if (!SNOWFLAKE.test(channelId)) throw bad('Channel ID: right-click the channel in Discord → Copy Channel ID (Developer Mode on)');
    const roleId = str(src.roleId, 30);
    if (roleId && !SNOWFLAKE.test(roleId)) throw bad('Role ID: Server Settings → Roles → right-click the role → Copy Role ID, or leave it empty');
    const categories = [...new Set((src.categories || []).map((c) => categoryFrom(c)).filter(Boolean))];
    const stores = [...new Set((src.stores || []).map((s) => str(s, 40)).filter((s) => this.ctx.retailers.get(s)))];
    return {
      name, channelId, roleId, categories, stores,
      kinds: kindsFrom(src.kinds, { required: true }) || ['restock', 'listed'],
      keywords: str(src.keywords, 200),
      enabled: bool(src.enabled, true),
      // A catch-all (misc-retailers): only what no other rule took.
      fallback: bool(src.fallback, false),
      // The VIP channel (#vip-drop): VIP drops only (monitor/vip.js), and they go nowhere else.
      vip: bool(src.vip, false),
    };
  }

  saveRoute(id, input) {
    const existing = id ? this.catalog.routeById(id) : null;
    if (id && !existing) throw bad('That alert rule no longer exists');
    if (!id && this.catalog.listRoutes().length >= MAX_ROUTES) throw bad(`${MAX_ROUTES} alert rules is the most`);
    return this.catalog.saveRoute(id, this.route(input, existing));
  }

  /**
   * "Set up store channels": a channel in the Discord server for each store and game (kmart-pokemon,
   * kmart-one-piece, …), one each for Premium Bandai and Pokémon Center, non-tcg-alerts for what
   * isn't trading cards, and misc-retailers for everything else — found by name, or made by the bot
   * (under "Mugibot alerts") — each with its
   * alert rule. Then #virtual-queue-detection: the stores' checkpoints and virtual queues going up
   * and coming down (monitor/gates.js); and #news, the release news (news.js). opts.roleId: a role
   * every channel but #news pings. opts.replace: remove the other rules.
   */
  async setupChannels(opts = {}, user = null) {
    const { discord, cfg } = this.ctx;
    if (!discord.botReady || !cfg.discord.guildId) throw new HttpError(503, "The Discord bot isn't set up yet (Admin → Setup check)");
    const roleId = str(opts.roleId, 30);
    if (roleId && !SNOWFLAKE.test(roleId)) throw bad('Role ID: Server Settings → Roles → right-click the role → Copy Role ID, or leave it empty');
    const list = await discord.guildChannels();
    if (list.status !== 200 || !Array.isArray(list.body)) throw new HttpError(502, `Couldn't read the server's channels (${discordProblem(list)})`);
    const channels = list.body;
    const byName = (names) => channels.find((c) => c && (c.type === 0 || c.type === 5) && names.includes(String(c.name || '').toLowerCase()));
    let parent = channels.find((c) => c && c.type === 4 && /^mugibot alerts$/i.test(c.name || ''));
    const made = [];
    const make = async (body) => {
      const r = await discord.createChannel(body);
      // (No permission is for the admin to fix in Discord: a 409, not Discord failing.)
      if (r.status === 403) throw new HttpError(409, "The bot can't make channels: give its role the Manage Channels permission (Server Settings → Roles), or make the channels yourself and press this again — it finds them by name");
      if (r.status !== 200 && r.status !== 201) throw new HttpError(502, `Couldn't make #${body.name} (${discordProblem(r)})`);
      channels.push(r.body);
      return r.body;
    };
    const plan = channelPlan();
    const out = [];
    for (const want of plan) {
      let ch = byName(want.names);
      if (!ch) {
        if (!parent) parent = await make({ name: 'Mugibot alerts', type: 4 });
        ch = await make({ name: want.names[0], type: 0, parent_id: parent.id, topic: want.topic });
        made.push(ch.name);
      }
      out.push({ ...want, channelId: String(ch.id), channelName: ch.name });
    }
    // Their rules: one per channel (an existing rule for that channel is brought in line).
    const routes = this.catalog.listRoutes();
    const keep = new Set();
    let added = 0;
    for (const w of out) {
      const existing = routes.find((r) => r.channelId === w.channelId);
      const rule = {
        name: `#${w.channelName}`, channelId: w.channelId, roleId: roleId || (existing ? existing.roleId : ''), categories: w.categories, stores: w.stores,
        // (#non-tcg-alerts: the drop watches' price drops too — a console's, say.)
        kinds: existing ? existing.kinds : w === nonTcgOf(out) ? ['restock', 'listed', 'price_drop'] : ['restock', 'listed'], keywords: '', enabled: true, fallback: w.fallback,
      };
      const saved = this.catalog.saveRoute(existing ? existing.id : null, this.route(rule));
      if (!existing) added += 1;
      keep.add(saved.id);
    }
    let removed = 0;
    // (The VIP channel's rule stays: it isn't a store channel.)
    if (opts.replace) for (const r of routes) if (!keep.has(r.id) && !r.vip && this.catalog.deleteRoute(r.id)) removed += 1;
    // #virtual-queue-detection: not an alert rule (no products go there) — the gates' own channel.
    let gate = byName([GATE_CHANNEL]);
    if (!gate) {
      if (!parent) parent = await make({ name: 'Mugibot alerts', type: 4 });
      gate = await make({ name: GATE_CHANNEL, type: 0, parent_id: parent.id, topic: GATE_TOPIC });
      made.push(gate.name);
    }
    const before = this.ctx.repo.getSetting('gateChannel') || {};
    this.ctx.repo.setSetting('gateChannel', { channelId: String(gate.id), roleId: roleId || (before.channelId === String(gate.id) ? before.roleId || '' : '') });
    // #news: release news (server/news.js) — no alert rule either. (It doesn't ping the store channels'
    // role: news isn't a drop. "Set up #news" picks its own.)
    let news = channels.find(isNewsChannel);
    if (!news) {
      if (!parent) parent = await make({ name: 'Mugibot alerts', type: 4 });
      news = await make({ name: NEWS_CHANNEL, type: 0, parent_id: parent.id, topic: NEWS_TOPIC });
      made.push(news.name);
    }
    this.ctx.news.saveChannel(String(news.id));
    if (user) this.ctx.repo.audit(user.id, null, 'alert-channels-setup', `${out.length + 2} channels (${made.length} made), ${added} rules added${removed ? `, ${removed} removed` : ''}`);
    return {
      channels: [
        ...out.map((w) => ({ name: w.channelName, id: w.channelId, made: made.includes(w.channelName), rule: `#${w.channelName}` })),
        { name: gate.name, id: String(gate.id), made: made.includes(gate.name), rule: 'Checkpoints and virtual queues' },
        { name: news.name, id: String(news.id), made: made.includes(news.name), rule: 'Release news' },
      ],
      made: made.length, added, removed,
    };
  }

  /**
   * A store channel the set-up has gained since it was made (Oct 2026: #amazon — Amazon's alerts out of
   * misc-retailers, into a channel of their own): found by name, or made by the bot under "Mugibot alerts", with
   * its rule, pinging the role misc-retailers pings. Only where the store channels are set up (misc-retailers has
   * its rule), for a store with no channel of its own yet: run at start and every few hours (app.js), so it's
   * there without anyone pressing "Set up store channels" again. The channels made or found.
   */
  async ensureOwnChannels() {
    const { discord, cfg } = this.ctx;
    if (!discord.botReady || !cfg.discord.guildId) return [];
    const routes = this.catalog.listRoutes();
    const misc = routes.find((r) => r.fallback && !r.vip && r.enabled);
    if (!misc) return [];
    const own = (store) => routes.some((r) => !r.vip && !r.fallback && !r.categories.length && r.stores.length === 1 && r.stores[0] === store);
    const wanted = channelPlan().filter((w) => w.stores.length === 1 && OWN_CHANNEL_STORES.has(w.stores[0]) && !own(w.stores[0]));
    if (!wanted.length) return [];
    const list = await discord.guildChannels();
    if (list.status !== 200 || !Array.isArray(list.body)) return [];
    const channels = list.body;
    let parent = channels.find((c) => c && c.type === 4 && /^mugibot alerts$/i.test(c.name || ''));
    const out = [];
    for (const w of wanted) {
      let ch = channels.find((c) => c && (c.type === 0 || c.type === 5) && w.names.includes(String(c.name || '').toLowerCase()));
      let made = false;
      if (!ch) {
        if (!parent) {
          const p = await discord.createChannel({ name: 'Mugibot alerts', type: 4 });
          if (p.status !== 200 && p.status !== 201) break;
          parent = p.body;
          channels.push(parent);
        }
        const r = await discord.createChannel({ name: w.names[0], type: 0, parent_id: parent.id, topic: w.topic });
        if (r.status !== 200 && r.status !== 201) break; // (no Manage Channels: "Set up store channels" says what to do)
        ch = r.body;
        channels.push(ch);
        made = true;
      }
      if (this.catalog.listRoutes().length >= MAX_ROUTES) break;
      this.catalog.saveRoute(null, this.route({
        name: `#${ch.name}`, channelId: String(ch.id), roleId: misc.roleId || '', categories: [], stores: w.stores,
        kinds: misc.kinds && misc.kinds.length ? misc.kinds : ['restock', 'listed'], keywords: '', enabled: true, fallback: false,
      }));
      this.ctx.repo.audit(null, null, 'alert-channel-added', `#${ch.name}${made ? ' (made)' : ''}: ${w.stores.join(', ')} on its own`);
      out.push({ name: ch.name, id: String(ch.id), made });
    }
    return out;
  }

  /**
   * "Make the #vip-drop channel": the VIP section of the Discord server — a "VIP" category with
   * #vip-drop in it (found by name, or made by the bot) — and its rule, which takes VIP drops only.
   * opts.roleId: a role it pings (e.g. @VIP).
   */
  async setupVip(opts = {}, user = null) {
    const { discord, cfg } = this.ctx;
    if (!discord.botReady || !cfg.discord.guildId) throw new HttpError(503, "The Discord bot isn't set up yet (Admin → Setup check)");
    const roleId = str(opts.roleId, 30);
    if (roleId && !SNOWFLAKE.test(roleId)) throw bad('Role ID: Server Settings → Roles → right-click the role → Copy Role ID, or leave it empty');
    const list = await discord.guildChannels();
    if (list.status !== 200 || !Array.isArray(list.body)) throw new HttpError(502, `Couldn't read the server's channels (${discordProblem(list)})`);
    const channels = list.body;
    const make = async (body) => {
      const r = await discord.createChannel(body);
      if (r.status === 403) throw new HttpError(409, "The bot can't make channels: give its role the Manage Channels permission (Server Settings → Roles), or make #vip-drop yourself and press this again — it finds it by name");
      if (r.status !== 200 && r.status !== 201) throw new HttpError(502, `Couldn't make #${body.name} (${discordProblem(r)})`);
      return r.body;
    };
    let ch = channels.find((c) => c && (c.type === 0 || c.type === 5) && ['vip-drop', 'vip-drops'].includes(String(c.name || '').toLowerCase()));
    let made = false;
    if (!ch) {
      let parent = channels.find((c) => c && c.type === 4 && /^vip( drops?)?$/i.test(c.name || ''));
      if (!parent) parent = await make({ name: 'VIP', type: 4 });
      ch = await make({ name: 'vip-drop', type: 0, parent_id: parent.id, topic: 'VIP drops picked by the admins, the moment they drop — from Mugibot.' });
      made = true;
    }
    const existing = this.catalog.listRoutes().find((r) => r.channelId === String(ch.id));
    if (!existing && this.catalog.listRoutes().length >= MAX_ROUTES) throw bad(`${MAX_ROUTES} alert rules is the most`);
    const rule = this.catalog.saveRoute(existing ? existing.id : null, this.route({
      name: `#${ch.name}`, channelId: String(ch.id), roleId: roleId || (existing ? existing.roleId : ''), categories: [], stores: [],
      kinds: ['restock', 'listed', 'price_drop'], keywords: '', enabled: true, fallback: false, vip: true,
    }));
    if (user) this.ctx.repo.audit(user.id, null, 'vip-channel-setup', `#${ch.name}${made ? ' (made)' : ''}`);
    return { channel: { name: ch.name, id: String(ch.id), made }, rule };
  }

  /**
   * "Make #non-tcg-alerts" (the drop watches' card): just that channel of the store channels' set-up —
   * found by name, or made by the bot under "Mugibot alerts" — and its rule. opts.roleId: a role it pings.
   */
  async setupNonTcg(opts = {}, user = null) {
    const { discord, cfg } = this.ctx;
    if (!discord.botReady || !cfg.discord.guildId) throw new HttpError(503, "The Discord bot isn't set up yet (Admin → Setup check)");
    const roleId = str(opts.roleId, 30);
    if (roleId && !SNOWFLAKE.test(roleId)) throw bad('Role ID: Server Settings → Roles → right-click the role → Copy Role ID, or leave it empty');
    const list = await discord.guildChannels();
    if (list.status !== 200 || !Array.isArray(list.body)) throw new HttpError(502, `Couldn't read the server's channels (${discordProblem(list)})`);
    const channels = list.body;
    let ch = channels.find((c) => c && (c.type === 0 || c.type === 5) && NON_TCG_PLAN.names.includes(String(c.name || '').toLowerCase()));
    let made = false;
    if (!ch) {
      const make = async (body) => {
        const r = await discord.createChannel(body);
        if (r.status === 403) throw new HttpError(409, `The bot can't make channels: give its role the Manage Channels permission (Server Settings → Roles), or make #${NON_TCG_CHANNEL} yourself and press this again — it finds it by name`);
        if (r.status !== 200 && r.status !== 201) throw new HttpError(502, `Couldn't make #${body.name} (${discordProblem(r)})`);
        return r.body;
      };
      let parent = channels.find((c) => c && c.type === 4 && /^mugibot alerts$/i.test(c.name || ''));
      if (!parent) parent = await make({ name: 'Mugibot alerts', type: 4 });
      ch = await make({ name: NON_TCG_CHANNEL, type: 0, parent_id: parent.id, topic: NON_TCG_PLAN.topic });
      made = true;
    }
    const existing = this.catalog.listRoutes().find((r) => r.channelId === String(ch.id));
    if (!existing && this.catalog.listRoutes().length >= MAX_ROUTES) throw bad(`${MAX_ROUTES} alert rules is the most`);
    const rule = this.catalog.saveRoute(existing ? existing.id : null, this.route({
      name: `#${ch.name}`, channelId: String(ch.id), roleId: roleId || (existing ? existing.roleId : ''), categories: ['nontcg'], stores: [],
      kinds: existing ? existing.kinds : ['restock', 'listed', 'price_drop'], keywords: '', enabled: true, fallback: false,
    }));
    if (user) this.ctx.repo.audit(user.id, null, 'non-tcg-channel-setup', `#${ch.name}${made ? ' (made)' : ''}`);
    return { channel: { name: ch.name, id: String(ch.id), made }, rule };
  }
}

const MAX_ROUTES = 40;

// The store channels: the main stores split by game; Premium Bandai and Pokémon Center on their own;
// everything else (other stores, other games) in misc-retailers.
const SPLIT_STORES = [['kmart', 'Kmart'], ['bigw', 'BIG W'], ['target', 'Target'], ['jbhifi', 'JB Hi-Fi'], ['ebgames', 'EB Games'], ['zing', 'Zing'], ['toysrus', 'Toys"R"Us']];
const GAMES = [['pokemon', ['pokemon'], 'Pokémon'], ['onepiece', ['one-piece', 'onepiece'], 'One Piece']];

export function channelPlan() {
  const plan = [];
  for (const [store, storeName] of SPLIT_STORES) {
    for (const [category, names, game] of GAMES) {
      plan.push({ names: names.map((n) => `${store}-${n}`), stores: [store], categories: [category], fallback: false, topic: `${game} drops and restocks at ${storeName}, from Mugibot.` });
    }
  }
  plan.push({ names: ['premium-bandai'], stores: ['pbandai'], categories: [], fallback: false, topic: 'Drops and restocks at Premium Bandai, from Mugibot.' });
  plan.push({ names: ['pokemon-center'], stores: ['pokemoncenter'], categories: [], fallback: false, topic: 'Drops and restocks at Pokémon Center, from Mugibot.' });
  // Amazon on its own (from Oct 2026): it pings often — everything it alerts goes here, nowhere else (feed.js OWN_CHANNEL_STORES).
  plan.push({ names: ['amazon', 'amazon-au'], stores: ['amazon'], categories: [], fallback: false, topic: 'Every drop and restock at Amazon AU (trading cards and the rest), from Mugibot.' });
  plan.push(NON_TCG_PLAN);
  plan.push({ names: ['misc-retailers', 'misc-retailer'], stores: [], categories: [], fallback: true, topic: 'Every other store and game, from Mugibot.' });
  return plan;
}

/** The #non-tcg-alerts part of the store channels' set-up. */
const nonTcgOf = (out) => out.find((w) => w.names === NON_TCG_PLAN.names) || null;

// #non-tcg-alerts: what isn't trading cards (the admins' drop watches: monitor/drops.js), from every
// store — and only there (Feed.routesFor), not in the store channels.
export const NON_TCG_CHANNEL = 'non-tcg-alerts';
const NON_TCG_PLAN = Object.freeze({
  names: [NON_TCG_CHANNEL, 'non-tcg', 'non-tcg-alert'], stores: [], categories: ['nontcg'], fallback: false,
  topic: 'Drops that aren\'t trading cards — consoles, collectibles, anything the admins watch — from every store, from Mugibot.',
});

function discordProblem(r) {
  return r.status === 0 ? "Discord didn't answer" : `HTTP ${r.status}${r.body && r.body.message ? `: ${r.body.message}` : ''}`;
}
