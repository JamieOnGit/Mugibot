// Checkpoints and virtual queues (docs/MONITORING.md → "Checkpoints and virtual queues"): the bot
// check JB Hi-Fi switches on before a big drop (Shopify's hCaptcha page at /checkpoint) and the
// virtual queues EB Games and Pokémon Center put up. Each store's gate is seen going up and coming
// down, posted in the Discord server's #virtual-queue-detection, shown on every dashboard, and DM'd
// to the members watching that store, so they can get ready for the drop. A queue going up also
// puts the checkout browsers of members armed at that store in line (aco.js: lobbies).
//
// Each store's gate is seen its own way (monitor/gate.js reads the pages):
// - JB Hi-Fi's checkpoint: the server looks at /checkpoint once a minute (JB answers servers, as
//   it does the sweeps). Up: the page with its hCaptcha on it. Down: gone (404), sent on to the
//   store, or no check there. A change is looked at again 10 seconds later, and counts when it's
//   seen twice in a row.
// - EB Games' and Pokémon Center's queues turn servers away, so browsers see them: a browser that
//   lands in the queue (an admin's counts at once; members' when two of them say so), and an
//   admin's browser asking for the store's front page as a new visitor — no cookies, so nobody's
//   place in line is touched — every 3 minutes (every minute while it's up). Down: the store's own
//   page for a new visitor, twice in a row at least 45 seconds apart. A browser that got through
//   the queue sees the store too: that's it being let in, not the queue coming down, so it never
//   counts. Not seen for 30 minutes while it was being looked for (or 3 hours at all): down.
//
// Nothing here gets past a check or jumps a queue: the server is honestly itself, and browsers wait
// their turn (the extension never refreshes a queue page and never touches a check).

import { entitlement } from '../entitlement.js';
import { serialize } from '../retailers/index.js';
import { num, str } from '../schema.js';
import { classify } from './gate.js';
import { BlockedUrlError, safeFetch } from './safeurl.js';
import { storeFetch } from './http.js';

const MIN = 60 * 1000;
// Two members' browsers in the queue within this long make it up (one admin's is enough).
const REPORTERS_MS = 10 * MIN;
// A queue's down only when a new visitor gets the store twice, this far apart.
const DOWN_GAP_MS = 45 * 1000;
// Not seen up for this long while something was looking for it (or this long at all): down.
const STALE_MS = 30 * MIN;
const STALE_MAX_MS = 3 * 60 * MIN;
// An admin's browser looks at a queue this often while it's up.
const CHECK_UP_SECONDS = 60;
const MAX_DMS = 500;
// The stores are Australian: the footer's clock is Sydney's ("09:55:00 AEDT").
const CLOCK = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' });
export const GATE_CHANNEL = 'virtual-queue-detection';
export const GATE_TOPIC = "Checkpoints and virtual queues at the stores, the moment they go up and come down — get ready for the drop. From Mugibot.";

const toGate = (row) => row && {
  store: row.store, kind: row.kind, status: row.status, since: row.since ?? null, seenAt: row.seen_at ?? null,
  lookedAt: row.looked_at ?? null, wait: row.wait ?? null, source: row.source || '',
};

export class Gates {
  constructor({ cfg, db, repo, retailers, discord, notifier, hub, feed, fetchImpl = storeFetch, now = () => Date.now() }) {
    Object.assign(this, { cfg, db, repo, retailers, discord, notifier, hub, feed, fetch: fetchImpl, now });
    this.mem = new Map(); // per store: readings in a row, members who saw it, the next look
    this.timers = new Map();
    this.running = false;
    this.told = new Map(); // per store: the members DM'd that it went up (they hear it came down)
    this.sweeper = null;
    this.aco = null;
    this.pools = null; // (server/pools.js: a leader's DM gets their 🤝 Group button)
    this.posting = Promise.resolve();
    this.telling = Promise.resolve();
  }

  /** Everything said so far has been sent (tests). */
  settled() {
    return Promise.all([this.posting, this.telling]);
  }

  // ---------------------------------------------------------------------------
  // The stores, and what's known
  // ---------------------------------------------------------------------------
  /** Stores with a checkpoint or a queue (switched on). */
  stores() {
    return this.retailers.list.filter((r) => r.gate && this.retailers.enabled(r));
  }

  get downGapMs() {
    return (this.cfg.monitor.gateDownGapSeconds ?? DOWN_GAP_MS / 1000) * 1000;
  }

  m(id) {
    let x = this.mem.get(id);
    if (!x) this.mem.set(id, (x = { ups: 0, downs: 0, downAt: 0, reporters: new Map(), checkNext: 0 }));
    return x;
  }

  row(id) {
    return this.db.get('SELECT * FROM gates WHERE store = :s', { s: id });
  }

  /** The gate's state: { store, kind, status, since, seenAt, wait, … } (down, never seen, when it's not known). */
  get(id) {
    const r = this.retailers.get(id);
    if (!r || !r.gate) return null;
    return toGate(this.row(id)) || { store: id, kind: r.gate.kind, status: 'down', since: null, seenAt: null, lookedAt: null, wait: null, source: '' };
  }

  isUp(id) {
    const g = this.get(id);
    return !!g && g.status === 'up';
  }

  /** A virtual queue is up there: browsers make no requests there unless they're through it. */
  queueUp(id) {
    const g = this.get(id);
    return !!g && g.kind === 'queue' && g.status === 'up';
  }

  /** The address people go to: JB Hi-Fi's /checkpoint, EB's front page, Pokémon Center's /?queue. */
  link(r) {
    const path = (r.gate && r.gate.url) || '/';
    return r.demo ? `${r.base}${path === '/' ? '/' : path}` : `${new URL(r.base).origin}${path}`;
  }

  checkUrl(r, path) {
    return r.demo ? `${r.base}${path}` : `${new URL(r.base).origin}${path}`;
  }

  /** Every store's gate, for the dashboard (members and admins). */
  list() {
    this.expireStale();
    return this.stores().map((r) => ({ ...this.get(r.id), name: r.name, label: r.gate.label, url: this.link(r), demo: !!r.demo }));
  }

  /** The ones up now (one quick look: it rides along on every Auto-checkout answer to a browser). */
  upList() {
    return this.db.all("SELECT * FROM gates WHERE status = 'up'").map((row) => {
      const r = this.retailers.get(row.store);
      return r && r.gate && this.retailers.enabled(r) ? { ...toGate(row), name: r.name, label: r.gate.label, url: this.link(r), demo: !!r.demo } : null;
    }).filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // What was seen
  // ---------------------------------------------------------------------------
  /**
   * A reading of a store's gate: 'up', 'down' or null (couldn't tell).
   * o.source: 'server' (its own look), 'probe' (an admin's browser, as a new visitor) or 'page' (a
   *   browser on the gate's page: someone in the queue, or at the checkpoint).
   * o.user: whose browser. o.wait: the queue's estimated wait (minutes).
   * Returns the gate's state.
   */
  observe(id, reading, o = {}) {
    const r = this.retailers.get(id);
    if (!r || !r.gate || !this.retailers.enabled(r)) return null;
    const now = this.now();
    const source = ['server', 'probe', 'page'].includes(o.source) ? o.source : 'page';
    const admin = !!(o.user && o.user.role === 'admin');
    const trusted = source === 'server' || source === 'probe' || admin;
    const m = this.m(id);
    const before = this.get(id);
    this.ensureRow(r);
    const wait = num(o.wait, { min: 0, max: 24 * 60, int: true, def: null });
    // (Looked at: a check that could tell — or an admin's browser's, which can't always: a bot check's page.)
    if (trusted && (reading || source === 'probe')) this.db.run('UPDATE gates SET looked_at = :t WHERE store = :s', { t: now, s: id });
    if (reading === 'up') {
      m.downs = 0;
      m.downAt = 0;
      if (before.status === 'up') {
        // (Members' browsers in the queue keep it fresh, and say what the wait is now.)
        this.db.run('UPDATE gates SET seen_at = :t, wait = COALESCE(:w, wait) WHERE store = :s', { t: now, w: wait, s: id });
        return this.get(id);
      }
      let sure = false;
      if (source === 'server') {
        m.ups += 1;
        sure = m.ups >= 2;
        if (!sure) this.soon(r);
      } else if (trusted) {
        sure = true;
      } else if (o.user) {
        m.reporters.set(o.user.id, now);
        for (const [u, at] of m.reporters) if (now - at > REPORTERS_MS) m.reporters.delete(u);
        sure = m.reporters.size >= 2;
      }
      if (sure) return this.flip(r, 'up', { source: source === 'probe' ? 'probe' : source === 'server' ? 'server' : 'browser', wait });
      return before;
    }
    if (reading === 'down') {
      // Only a look as a new visitor tells (someone through the queue sees the store too).
      if (!(source === 'server' || source === 'probe')) return before;
      m.ups = 0;
      m.reporters.clear();
      if (before.status !== 'up') return before;
      if (source === 'server') {
        m.downs += 1;
      } else if (!m.downAt || now - m.downAt >= this.downGapMs) {
        m.downs += 1;
        m.downAt = now;
      }
      if (m.downs >= 2) return this.flip(r, 'down', { source });
      if (source === 'server') this.soon(r);
      return before;
    }
    return before;
  }

  ensureRow(r) {
    this.db.run('INSERT INTO gates (store, kind, status) VALUES (:s, :k, \'down\') ON CONFLICT (store) DO NOTHING', { s: r.id, k: r.gate.kind });
  }

  /** It went up, or came down: saved, then said everywhere. */
  flip(r, status, { source = '', wait = null } = {}) {
    const now = this.now();
    const prev = this.get(r.id);
    if (prev.status === status) return prev;
    this.ensureRow(r);
    this.db.run(`UPDATE gates SET kind = :k, status = :st, since = :t, source = :src, wait = :w, seen_at = CASE WHEN :st = 'up' THEN :t ELSE seen_at END,
      ups = ups + CASE WHEN :st = 'up' THEN 1 ELSE 0 END WHERE store = :s`, { k: r.gate.kind, st: status, t: now, src: source, w: status === 'up' ? wait : null, s: r.id });
    const m = this.m(r.id);
    Object.assign(m, { ups: 0, downs: 0, downAt: 0, checkNext: 0 });
    m.reporters.clear();
    const gate = this.get(r.id);
    // (For every dashboard: not what saw it.)
    const view = { store: r.id, kind: gate.kind, status, since: gate.since, wait: gate.wait, name: r.name, label: r.gate.label, url: this.link(r), demo: !!r.demo, upFor: status === 'down' && prev.since ? now - prev.since : null };
    this.cfg.log(JSON.stringify({ evt: 'gate', store: r.id, kind: r.gate.kind, status, source }));
    if (this.sweeper) this.sweeper.sys(this.line(r, gate).replace(/ \| .*$/, ''), { store: r.id, level: status === 'up' ? 'warn' : 'info' });
    if (this.feed) this.feed.broadcast('gate', view);
    // A queue's up: the checkout browsers of members armed at that store get in line. A checkpoint's up: members armed
    // there with their pool's leader get its check page opened, to solve before the drop (told by a DM of its own, so
    // not the usual one as well).
    let opened = new Set();
    if (this.aco) {
      if (status === 'up' && r.gate.kind === 'queue') this.aco.queueUp(r, gate);
      if (status === 'up' && r.gate.kind === 'checkpoint') opened = this.aco.checkpointUp(r) || new Set();
      if (status === 'down') this.aco.gateDown(r);
    }
    // (Posts one after another: in the order they happened, and the channel found or made once. The
    // members' DMs on a line of their own, so a big store's DMs never hold up the next post.)
    this.posting = this.posting.then(() => this.post(r, gate)).catch((e) => this.cfg.log('[gates]', e.message));
    this.telling = this.telling.then(() => this.tellMembers(r, gate, { skip: opened })).catch((e) => this.cfg.log('[gates]', e.message));
    return gate;
  }

  /** Not seen up for a while, while something looked for it — or for hours at all: down. */
  expireStale() {
    const now = this.now();
    const rows = this.db.all("SELECT * FROM gates WHERE status = 'up' AND seen_at < :t", { t: now - STALE_MS });
    for (const row of rows) {
      const r = this.retailers.get(row.store);
      if (!r || !r.gate) continue;
      // (A store nothing looks at by itself — only seen on pages people open — is down once nobody's seen it for a while.)
      const looked = (row.looked_at && row.looked_at > row.seen_at + DOWN_GAP_MS) || (!r.gate.probe && !r.gate.check);
      if (looked || now - row.seen_at > STALE_MAX_MS) this.flip(r, 'down', { source: 'stale' });
    }
  }

  // ---------------------------------------------------------------------------
  // Telling people
  // ---------------------------------------------------------------------------
  /** "🟢 hcaptcha Checkpoint up for JB Hi-Fi | https://www.jbhifi.com.au/checkpoint" */
  line(r, gate) {
    const where = `${r.name} | ${this.link(r)}`;
    if (gate.status === 'up') return `🟢 ${r.gate.label} up for ${where}`;
    return r.gate.kind === 'checkpoint' ? `🔴 Checkpoint disabled for ${where}` : `🔴 ${r.gate.label} down for ${where}`;
  }

  clock() {
    const parts = Object.fromEntries(CLOCK.formatToParts(new Date(this.now())).map((p) => [p.type, p.value]));
    return `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName || ''}`.trim();
  }

  /** The Discord post: the monitor's embed (white, the store's address on top, its title, one line). */
  message(r, gate, { mention = '' } = {}) {
    const origin = r.demo ? `${r.base}/` : `${new URL(r.base).origin}/`;
    const lines = [this.line(r, gate)];
    const up = gate.status === 'up';
    if (up && r.gate.kind === 'queue') {
      if (gate.wait !== null && gate.wait !== undefined) lines.push(`Estimated wait: ${gate.wait} minute${gate.wait === 1 ? '' : 's'}`);
      lines.push("Get in line and leave the page alone: it refreshes itself — refreshing it yourself can lose your place.");
    }
    if (up && r.gate.kind === 'checkpoint') lines.push("Solve it once in your browser before the drop: ⚡ Buy and Auto-checkout wait for you there, then carry on.");
    const msg = {
      content: mention || undefined,
      allowed_mentions: { parse: [], roles: mention ? [...mention.matchAll(/<@&(\d+)>/g)].map((x) => x[1]) : [] },
      embeds: [{
        author: { name: origin, url: origin },
        title: r.gate.title || (r.gate.kind === 'checkpoint' ? 'Checkpoint Monitor' : 'Queue Monitor'),
        description: lines.join('\n'),
        color: 0xffffff,
        footer: { text: `${r.gate.module || r.name} | ${this.cfg.appName} Monitors [${this.clock()}]` },
        timestamp: new Date(this.now()).toISOString(),
      }],
    };
    // A queue's up: "Join the queue on my computer" puts the member's checkout browser in line.
    if (up && r.gate.kind === 'queue' && this.discord && this.discord.interactionsReady) {
      msg.components = [{ type: 1, components: [
        { type: 2, style: 1, label: '📥 Join the queue on my computer', custom_id: `queue:${r.id}` },
        { type: 2, style: 5, label: `Open ${r.name}`.slice(0, 80), url: this.link(r) },
      ] }];
    }
    return msg;
  }

  /** #virtual-queue-detection: the one saved by "Set up store channels", else found by name (or made). */
  async channel() {
    const saved = this.repo.getSetting('gateChannel');
    if (saved && saved.channelId) return saved;
    if (!this.discord || !this.discord.botReady || !this.cfg.discord.guildId) return null;
    const list = await this.discord.guildChannels();
    if (list.status !== 200 || !Array.isArray(list.body)) return null;
    let ch = list.body.find((c) => c && (c.type === 0 || c.type === 5) && String(c.name || '').toLowerCase() === GATE_CHANNEL);
    if (!ch) {
      const parent = list.body.find((c) => c && c.type === 4 && /^mugibot alerts$/i.test(c.name || ''));
      const made = await this.discord.createChannel({ name: GATE_CHANNEL, type: 0, topic: GATE_TOPIC, ...(parent ? { parent_id: parent.id } : {}) });
      if (made.status !== 200 && made.status !== 201) return null;
      ch = made.body;
    }
    const out = { channelId: String(ch.id), roleId: '' };
    this.repo.setSetting('gateChannel', out);
    return out;
  }

  /** The post in #virtual-queue-detection (pinging the store channels' role, when they ping one). */
  async post(r, gate) {
    if (!this.discord || !this.discord.botReady) return;
    const ch = await this.channel();
    if (!ch) return;
    const ok = await this.discord.post(ch.channelId, this.message(r, gate, { mention: ch.roleId ? `<@&${ch.roleId}>` : '' }));
    if (ok) this.db.run('UPDATE gates SET posted_at = :t WHERE store = :s', { t: this.now(), s: r.id });
  }

  /**
   * The members watching something at that store: their activity feed and DM (up; down, to those told it was up).
   * A pool's leader with a group hears it too, watching there or not — with the 🤝 Group Queue / 🤝 Group Checkpoint
   * button that starts it for the group, on their own DM (so nobody else sees it). skip: members told already, by a DM
   * of its own (their pool's checkpoint opened for them).
   */
  async tellMembers(r, gate, { skip = new Set() } = {}) {
    const up = gate.status === 'up';
    const leaders = up && this.pools ? [...this.pools.leaderIds()].filter((id) => this.pools.leadsGroup(id)) : [];
    const ids = up
      ? [...new Set([...this.db.all('SELECT DISTINCT user_id FROM items WHERE store = :s LIMIT :n', { s: r.id, n: MAX_DMS }).map((x) => x.user_id), ...leaders])]
      : [...(this.told.get(r.id) || [])];
    if (up) this.told.set(r.id, new Set());
    else this.told.delete(r.id);
    const queue = r.gate.kind === 'queue';
    const wait = gate.wait !== null && gate.wait !== undefined ? ` — about ${gate.wait} minute${gate.wait === 1 ? '' : 's'}` : '';
    for (const id of ids) {
      const u = this.repo.userById(id);
      if (!u || u.disabled || !entitlement(u, this.now()).active) continue;
      if (up) this.told.get(r.id).add(id);
      if (up && skip.has(id)) continue;
      const armed = up && queue && this.aco && this.aco.joinsQueue(id, r.id);
      const group = up && leaders.includes(id) ? this.pools.group(id).length : 0;
      const ev = up
        ? {
          type: 'gate', level: 'urgent', channel: group ? 'aco' : 'restock',
          title: queue ? `🚦 ${r.name}'s virtual queue is up${wait}` : `🛡️ ${r.name}'s checkpoint is up`,
          message: (queue
            ? `${armed ? 'Your checkout browser is getting in line for your armed items. ' : 'Get in line in your browser now, before the drop. '}Leave the queue page alone: it refreshes itself, and refreshing it yourself can lose your place.`
            : `${r.name} wants a human check before checkout (hCaptcha). ⚡ Buy and Auto-checkout stop at it and wait for you to solve it, then carry on.`)
            + (!group ? '' : queue
              ? `\n🤝 **Group Queue** puts your checkout browser in line, and the checkout browsers of the ${group} member${group === 1 ? '' : 's'} of your pool who check out with you — each a tab of its own, its own place in line.`
              : `\n🤝 **Group Checkpoint** opens ${r.name}'s check page in your checkout browser and in those of the ${group} member${group === 1 ? '' : 's'} of your pool who check out with you, and tells each to solve it there before the drop (a human check: each solves their own).`),
          url: this.link(r),
          buttons: [
            ...(group ? [{ label: queue ? '🤝 Group Queue' : '🤝 Group Checkpoint', url: `${this.cfg.baseUrl}/app#pool`, action: `${queue ? 'gq' : 'gc'}:${r.id}` }] : []),
            { label: `Open ${r.name}`, url: this.link(r) },
          ],
        }
        : {
          type: 'gate', level: 'info', channel: 'restock',
          title: queue ? `🔴 ${r.name}'s virtual queue is down` : `🔴 ${r.name}'s checkpoint is off`,
          message: queue ? `Anyone can go straight to ${r.name} again.` : `Checkout at ${r.name} is straight through again.`,
          url: this.link(r),
        };
      await this.notifier.notify(id, ev).catch(() => null);
    }
  }

  // ---------------------------------------------------------------------------
  // The server's own looks (JB Hi-Fi's checkpoint)
  // ---------------------------------------------------------------------------
  probeSeconds(r) {
    return Math.max(1, this.cfg.monitor.gateProbeSeconds || (r.gate.probe && r.gate.probe.intervalSeconds) || 60);
  }

  start() {
    if (this.running || !this.cfg.monitor.enabled) return;
    this.running = true;
    for (const r of this.stores()) if (r.gate.probe) this.schedule(r, 1000);
    this.staleTimer = setInterval(() => { try { this.expireStale(); } catch (e) { this.cfg.log('[gates]', e.message); } }, MIN);
    this.staleTimer.unref?.();
  }

  stop() {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    clearInterval(this.staleTimer);
  }

  schedule(r, ms) {
    if (!this.running) return;
    clearTimeout(this.timers.get(r.id));
    const t = setTimeout(() => {
      this.probe(r).catch((e) => this.cfg.log('[gates]', e.message)).finally(() => {
        if (!this.timers.has(r.id) || this.timers.get(r.id) === t) this.schedule(r, this.probeSeconds(r) * 1000);
      });
    }, ms);
    t.unref?.();
    this.timers.set(r.id, t);
  }

  /** Looked at again in a moment, to be sure of a change. */
  soon(r) {
    if (!this.running || !r.gate.probe) return;
    this.schedule(r, Math.max(1, this.cfg.monitor.gateConfirmSeconds) * 1000);
  }

  /** One look at a store's checkpoint from the server: honestly Mugibot, like its sweeps. */
  async probe(r) {
    if (!this.retailers.enabled(r) || !r.gate || !r.gate.probe) return null;
    const url = this.checkUrl(r, r.gate.probe.path || r.gate.url || '/');
    let res;
    let html = '';
    try {
      const timeoutMs = Math.min(this.cfg.monitor.timeoutMs, 15000);
      res = await safeFetch(this.fetch, url, {
        headers: { 'user-agent': this.cfg.monitor.userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-AU,en;q=0.9' },
        timeoutMs, signal: AbortSignal.timeout(timeoutMs), maxBytes: 2 * 1024 * 1024,
      }, { allowPrivate: this.cfg.monitor.allowPrivateHosts });
      html = await res.text();
    } catch (e) {
      if (!(e instanceof BlockedUrlError)) this.observe(r.id, null, { source: 'server' });
      return null;
    }
    const reading = classify(r.gate, { status: res.status, url: res.url || url, html });
    this.observe(r.id, reading, { source: 'server' });
    return reading;
  }

  // ---------------------------------------------------------------------------
  // Admins' browsers (EB Games' and Pokémon Center's queues)
  // ---------------------------------------------------------------------------
  checkSeconds(r, up) {
    if (this.cfg.monitor.gateCheckSeconds) return this.cfg.monitor.gateCheckSeconds;
    return up ? CHECK_UP_SECONDS : (r.gate.check && r.gate.check.everySeconds) || 180;
  }

  /**
   * The queues an admin's browser should look at now, as a new visitor (no cookies), and when the
   * next is due. Two admins' browsers share them. { probes: [{ store, url, kind, page }], nextAt }
   */
  probesFor(user) {
    if (!user || user.role !== 'admin') return { probes: [], nextAt: null };
    const now = this.now();
    const probes = [];
    let nextAt = null;
    for (const r of this.stores()) {
      if (!r.gate.check || r.gate.kind !== 'queue') continue;
      // (The real stores while the monitor's on; their dummy-store copies while they're swept, in tests and trials.)
      if (r.demo ? !this.sweeper || this.sweeper.modeFor(r) === 'off' : !this.cfg.monitor.enabled) continue;
      const m = this.m(r.id);
      if (m.checkNext > now) { nextAt = Math.min(nextAt ?? Infinity, m.checkNext); continue; }
      m.checkNext = now + this.checkSeconds(r, this.isUp(r.id)) * 1000;
      nextAt = Math.min(nextAt ?? Infinity, m.checkNext);
      probes.push(serialize({ store: r.id, url: this.checkUrl(r, r.gate.check.path || '/'), kind: r.gate.kind, page: r.gate.page }));
    }
    return { probes, nextAt };
  }

  /**
   * What browsers saw (POST /api/ext/gates). Each: { store, status: 'up' | 'down' | 'unknown',
   * how: 'page' (on the gate's page) | 'probe' (an admin's browser, as a new visitor), wait }.
   * A member's browser can only say it's in a queue, or at a checkpoint.
   */
  reports(user, list) {
    const out = [];
    for (const x of (Array.isArray(list) ? list : []).slice(0, 10)) {
      if (!x || typeof x !== 'object') continue;
      const id = str(x.store, 40);
      const r = this.retailers.get(id);
      if (!r || !r.gate) continue;
      const how = x.how === 'probe' ? 'probe' : 'page';
      if (how === 'probe' && user.role !== 'admin') continue;
      const reading = x.status === 'up' ? 'up' : x.status === 'down' && how === 'probe' ? 'down' : null;
      if (how === 'page' && reading !== 'up') continue;
      const g = this.observe(id, reading, { source: how, user, wait: x.wait });
      // A look as a new visitor: the next one's due a while from now (sooner while it's up).
      if (how === 'probe') this.m(id).checkNext = this.now() + this.checkSeconds(r, this.isUp(id)) * 1000;
      if (g) out.push({ store: id, status: g.status });
    }
    return out;
  }
}
