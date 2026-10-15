// Alerts for one member: their activity feed, their open dashboards, a
// Discord DM from the Mugibot bot, their own Discord webhook and their own
// email — never anyone else's. (Posts in the server's channels are the
// Monitor feed's: server/monitor/feed.js.)

import { purposeKey, signParts } from './crypto.js';
import { DEFAULT_ALERTS } from './schema.js';
import { STATUS_LABEL } from './monitor/status.js';

const BUY_LINK_TTL = 30 * 60 * 1000;
const COLORS = { urgent: 0x16a34a, success: 0x16a34a, warn: 0xd97706, info: 0x2563eb, listed: 0x7c3aed };

const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '');

export class Notifier {
  constructor({ cfg, repo, retailers, hub, mailer, discord, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { cfg, repo, retailers, hub, mailer, discord, fetch: fetchImpl, now });
    this.buyKey = purposeKey(cfg.dataKey, 'buy-link');
  }

  /** A ⚡ Buy link for a member's own item: opens the product with the extension ready to go. */
  buyLink(userId, item, quantity = item.quantity || 1) {
    const exp = this.now() + BUY_LINK_TTL;
    const t = signParts(this.buyKey, [userId, item.id, String(quantity)], exp);
    return `${this.cfg.baseUrl}/buy/${encodeURIComponent(item.id)}?qty=${quantity}&t=${t}`;
  }

  /**
   * ev: { type, level ('info'|'success'|'warn'|'urgent'), message, title?, name?, sku?, url?, buttons?: [{label, url}],
   *       channel?: 'restock' | 'listed' | 'checkout' — also DM / webhook / email per the member's settings;
   *                 'account' — membership news, DM'd if Discord is connected }
   * Returns { event, sent: ['discord-dm', 'webhook', 'email'] }.
   */
  async notify(userId, ev) {
    // The feed keeps one line: "In stock: Day UPC — Kmart · SKU 43818648 · $360.00".
    const firstLine = String(ev.message).split('\n')[0];
    const saved = this.repo.addEvent(userId, { ...ev, message: ev.title ? `${ev.title} — ${firstLine}` : ev.message });
    this.hub.publish(userId, 'event', { ...saved, title: ev.title || null, message: ev.title ? firstLine : saved.message });
    const sent = [];
    if (!ev.channel) return { event: saved, sent };
    const user = this.repo.userById(userId);
    if (!user) return { event: saved, sent };
    const settings = { ...DEFAULT_ALERTS, ...(this.repo.getData(userId, 'alerts', {}) || {}) };
    const jobs = [];
    const wantsDm = { restock: settings.discordDm, listed: settings.discordDmListed, checkout: settings.discordDmCheckout, account: true }[ev.channel];
    if (wantsDm && user.discord_id && this.discord.botReady) {
      jobs.push(this.discord.dm(user, this.message(ev)).then((ok) => ok && sent.push('discord-dm')));
    }
    if (settings.discordWebhook && ev.channel !== 'account') jobs.push(this.webhook(settings, ev).then((ok) => ok && sent.push('webhook')));
    const wantsEmail = { checkout: settings.emailOnCheckout, restock: settings.emailOnRestock, listed: settings.emailOnRestock, account: true }[ev.channel];
    if (wantsEmail && user.email) {
      const links = (ev.buttons || []).map((b) => `${b.label}: ${b.url}`).join('\n');
      jobs.push(this.mailer.send({
        to: user.email,
        subject: `${this.cfg.appName}: ${ev.title || ev.message}`,
        text: `${ev.title || ''}\n${ev.message}\n${ev.url || ''}\n${links}\n\nOpen your dashboard: ${this.cfg.baseUrl}/app\nChange alert settings: ${this.cfg.baseUrl}/app#discord`,
      }).then((ok) => ok && sent.push('email')));
    }
    await Promise.allSettled(jobs);
    return { event: saved, sent };
  }

  /** A Discord message (embed + link buttons) for an event. */
  message(ev, { mention = '' } = {}) {
    const buttons = (ev.buttons || []).filter((b) => b && b.url).slice(0, 5);
    const useButtons = this.cfg.discord.linkButtons && buttons.every((b) => /^https?:\/\//.test(b.url));
    const linkText = !useButtons && buttons.length ? `\n\n${buttons.map((b) => `**${b.label}:** ${b.url}`).join('\n')}` : '';
    const msg = {
      content: mention || undefined,
      allowed_mentions: { parse: [], roles: mention ? [...mention.matchAll(/<@&([\w-]+)>/g)].map((m) => m[1]) : [], users: mention ? [...mention.matchAll(/<@!?([\w-]+)>/g)].map((m) => m[1]) : [] },
      embeds: [{
        title: String(ev.title || ev.message).slice(0, 250),
        description: `${ev.title ? String(ev.message) : ''}${linkText}`.slice(0, 4000) || undefined,
        url: /^https?:\/\//.test(ev.url || '') ? ev.url : undefined,
        color: ev.embedColor ?? (COLORS[ev.color || ev.level] || COLORS.info),
        fields: ev.fields || undefined,
        thumbnail: /^https?:\/\//.test(ev.image || '') ? { url: ev.image } : undefined,
        timestamp: new Date(this.now()).toISOString(),
        footer: { text: ev.footer || this.cfg.appName },
      }],
    };
    if (useButtons && buttons.length) {
      msg.components = [{ type: 1, components: buttons.map((b) => ({ type: 2, style: 5, label: String(b.label).slice(0, 80), url: b.url })) }];
    }
    return msg;
  }

  async webhook(settings, ev) {
    const body = { username: this.cfg.appName, ...this.message(ev, { mention: settings.discordMention }) };
    delete body.components; // buttons only work on messages from the bot
    if (body.embeds[0] && ev.buttons && ev.buttons.length && !/\*\*/.test(body.embeds[0].description || '')) {
      body.embeds[0].description = `${body.embeds[0].description || ''}\n\n${ev.buttons.map((b) => `**${b.label}:** ${b.url}`).join('\n')}`.trim();
    }
    body.allowed_mentions = { parse: ['users', 'roles'] };
    try {
      const res = await this.fetch(settings.discordWebhook, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return false; // Discord down or webhook deleted — the alert is still in the activity feed
    }
  }

  /**
   * One of a member's SKUs changed: kind 'restock' (in stock / pre-order) or 'listed'.
   * info: { status, price, source, manual, note }
   */
  async itemAlert(userId, item, kind, info = {}) {
    const storeName = this.retailers.name(item.store);
    const label = STATUS_LABEL[info.status] || info.status;
    const price = info.price ?? item.last_price ?? item.price;
    const qty = item.quantity || 1;
    const meta = [storeName, `SKU ${item.sku}`, money(price)].filter(Boolean).join(' · ');
    const buttons = [];
    if (item.url) buttons.push({ label: `⚡ Buy ×${qty}`, url: this.buyLink(userId, item, qty) });
    if (item.url) buttons.push({ label: 'Open product', url: item.url });
    buttons.push({ label: 'Watchlist', url: `${this.cfg.baseUrl}/app#watch` });
    if (kind === 'listed') {
      return this.notify(userId, {
        type: 'listed', level: 'success', color: 'listed', channel: 'listed',
        title: `Listed: ${item.name}`, message: `${meta}\nThe product page is up — now ${label.toLowerCase()}.`,
        name: item.name, sku: item.sku, url: item.url || null, buttons,
      });
    }
    const who = info.manual ? 'Reported by an admin' : info.source === 'browser' ? 'Seen by your browser' : 'Seen by the Mugibot monitor';
    return this.notify(userId, {
      type: 'restock', level: 'urgent', channel: 'restock',
      title: `${info.status === 'preorder' ? '🟣' : '🟢'} ${label}: ${item.name}`,
      message: `${meta}${info.note ? `\n${info.note}` : ''}\n${who}. Quantity set to ${qty} — press ⚡ Buy to go straight to checkout.`,
      name: item.name, sku: item.sku, url: item.url || null, buttons,
    });
  }
}
