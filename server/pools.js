// Pools: an admin's watchlist, armed items and drop watches, shared with the members who join their pool — kept in
// step on each member's own watchlist the moment the admin changes theirs — and, for each member who agrees to it
// themselves, the admin's Auto-checkouts run for them too: in the member's own checkout browser, with their own card,
// delivery details and Auto-checkout limits, up to the most they set for the pool (docs/POOLS.md).
//
// Who decides what:
//   - Admins make a pool (they lead it) and invite members to it (admin console → Members → Pools). Nobody's in one
//     until they accept the invitation themselves. One pool at a time; a pool's leader isn't in anyone else's.
//   - The member decides the rest, from their own dashboard: joining (the leader's watchlist then shows on theirs,
//     🤝), checking out with the leader (a switch of their own, with what it does said in full and the most it may
//     cost them an item — never switched on by anyone else), skipping one of the leader's items, leaving.
//   - What's the leader's stays the leader's: the member's copy of an item follows it (its link, name, price, how
//     many, max price, paused, armed) and the member can't change it — only skip it. Their card, delivery details and
//     checkout browser are their own, and the leader never sees them.
//
// Checking out with the leader (follow_aco):
//   - The leader's armed items are armed on the member's watchlist too (while the leader's Auto-checkout is on), up to
//     the member's most (aco_cap). A drop starts the member's run at the same moment as the leader's: the leader's
//     run starts theirs (fanOut), and their own copy sees the same page check.
//   - The leader starting one themselves — Trigger ACO, ⚡ Buy (Discord, the dashboard, the ⚡ Buy page) with
//     Auto-checkout on, 🚦 Wait for queue, then ACO — starts the member's run for the same item at once.
//   - Each run is the member's own Auto-checkout's (server/aco.js): their limits (an order, a day), their mode (place
//     the order, or stop at the final button), one run at a time for an item, and they're told as it starts (DM).
//   - Bought once, the member's copy isn't armed again until the leader arms theirs again (pool_aco_at): never bought
//     twice for one arming. One purchase per drop watch, the same (pool_watch).
//
// The leader's group (the members who check out with them) and the stores' gates (monitor/gates.js):
//   - A virtual queue (EB Games, Pokémon Center): the leader getting in line — Discord's "📥 Join the queue" or the
//     🤝 Group Queue button on their own DM — gets each member's checkout browser in line too: a tab of its own,
//     waiting its turn like anyone's, never refreshed (groupQueue). Armed at a store whose queue goes up, a member's
//     browser gets in line by itself anyway (aco.js queueUp), as for anyone armed there.
//   - A checkpoint (JB Hi-Fi's hCaptcha): a human check, for each person in their own browser — Mugibot never solves
//     one, and passing it in one browser passes nobody else's. So it's opened for them ahead of the drop and they're
//     told to solve it: when it goes up where they're armed with the leader (checkpointUp), when the leader arms
//     something there while it's up, and when the leader presses 🤝 Group Checkpoint (groupCheckpoint).
//   - 🤝 Group Buy: the leader's ⚡ Buy, as their own DMs name it (notifier.buyLabel) — it starts the group's
//     checkouts (fanOut). The 🤝 buttons are on the leader's own DMs, so only they see them; pressed by anyone who
//     doesn't lead a group, they do nothing but say so (routes/discord.js).

import { newId } from './crypto.js';
import { entitlement } from './entitlement.js';
import { REMOTE_DESKTOP_URL } from './aco.js';
import { HttpError, bad, num, str } from './schema.js';

const SYNC_MS = 30 * 1000;
export const MAX_POOL_MEMBERS = 50;
const ACTIVE_RUN = "SELECT 1 AS y FROM aco_runs WHERE item_id = :i AND status IN ('queued', 'sent', 'started', 'waiting', 'checkout', 'placing') LIMIT 1";

export class Pools {
  constructor(ctx) {
    this.ctx = ctx;
    const { db, repo, hub, notifier, cfg } = ctx;
    Object.assign(this, { db, repo, hub, notifier, cfg });
    this.now = ctx.now || (() => Date.now());
    this.pending = new Set(); // leaders whose members' copies are brought in step on the next turn
    this.timer = null;
    this.leaders = null; // (cached: who leads a pool with members in it)
    this.headsUp = new Map(); // 'userId:store' → the checkpoint's `since` they were told to solve it for (once each time)
    // Every change to someone's watchlist — the dashboard's, Discord's, Auto-checkout's (armed, bought), a drop
    // watch's finds — and their Auto-checkout switch: their pool's copies brought in step straight away.
    repo.onItems = (userId) => this.touch(userId);
    hub.tap((type, userId, data) => {
      if (type === 'watch' || (type === 'aco' && data && data.settings)) this.touch(userId);
      // (Their drop watches: the members' dashboards look again.)
      if (type === 'drop' && !(data && data.pool)) this.relayDrops(userId);
    });
  }

  start() {
    if (this.timer) return;
    // (Anything a change didn't say: every half a minute, each pool's copies are looked over.)
    this.timer = setInterval(() => { try { this.syncAll(); } catch (e) { this.cfg.log('[pools]', e.message); } }, SYNC_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------------------
  // Who's in what
  // ---------------------------------------------------------------------------
  pool(id) {
    return this.db.get('SELECT p.*, u.username AS leader FROM pools p JOIN users u ON u.id = p.owner_id WHERE p.id = :id', { id: String(id || '') });
  }

  /** The leaders of pools that have members in them (cached till a pool changes). */
  leaderIds() {
    if (!this.leaders) {
      this.leaders = new Set(this.db.all("SELECT DISTINCT p.owner_id AS id FROM pools p JOIN pool_members m ON m.pool_id = p.id AND m.status = 'active'").map((r) => r.id));
    }
    return this.leaders;
  }

  changed() {
    this.leaders = null;
  }

  /** The members of this leader's pools (joined, account in good standing). */
  followers(leaderId) {
    return this.db.all(`SELECT m.*, u.username, p.name AS pool_name FROM pool_members m JOIN pools p ON p.id = m.pool_id JOIN users u ON u.id = m.user_id
      WHERE p.owner_id = :l AND m.status = 'active' AND u.disabled = 0 ORDER BY m.joined_at`, { l: leaderId });
  }

  /** The leader's group: the members who check out with them (follow_aco). */
  group(leaderId) {
    if (!leaderId || !this.leaderIds().has(leaderId)) return [];
    return this.followers(leaderId).filter((m) => m.follow_aco);
  }

  /** Does this person lead a group — a pool with someone in it who checks out with them? (Their 🤝 buttons.) */
  leadsGroup(userId) {
    return this.group(userId).length > 0;
  }

  /** The pool someone's in (joined), with its leader — or null. */
  membership(userId) {
    return this.db.get(`SELECT m.*, p.name AS pool_name, p.owner_id, u.username AS leader FROM pool_members m JOIN pools p ON p.id = m.pool_id
      JOIN users u ON u.id = p.owner_id WHERE m.user_id = :u AND m.status = 'active'`, { u: userId });
  }

  /** Whose pool someone's in: the leader's id — or null. */
  leaderOf(userId) {
    const m = this.membership(userId);
    return m ? m.owner_id : null;
  }

  ownsPool(userId) {
    return !!this.db.get('SELECT 1 AS y FROM pools WHERE owner_id = :u LIMIT 1', { u: userId });
  }

  // ---------------------------------------------------------------------------
  // Admins: pools and who's asked to join them
  // ---------------------------------------------------------------------------
  create(owner, name) {
    const n = str(name, 60).trim();
    if (!n) throw bad('Name the pool');
    if (this.membership(owner.id)) throw bad("You're in someone else's pool — leave it first to lead one of your own");
    const id = newId('pool');
    this.db.run('INSERT INTO pools (id, name, owner_id, created_at) VALUES (:id, :n, :o, :t)', { id, n, o: owner.id, t: this.now() });
    return this.adminView(id);
  }

  rename(poolId, name) {
    const p = this.pool(poolId);
    if (!p) throw new HttpError(404, 'Pool not found');
    const n = str(name, 60).trim();
    if (!n) throw bad('Name the pool');
    this.db.run('UPDATE pools SET name = :n WHERE id = :id', { n, id: p.id });
    return this.adminView(p.id);
  }

  async invite(poolId, username, by) {
    const p = this.pool(poolId);
    if (!p) throw new HttpError(404, 'Pool not found');
    const u = this.repo.userByUsername(str(username, 40).trim());
    if (!u) throw bad(`There's no member called "${str(username, 40).trim()}"`);
    if (u.disabled) throw bad(`${u.username}'s account is suspended`);
    if (u.id === p.owner_id) throw bad(`${u.username} leads this pool`);
    if (this.ownsPool(u.id)) throw bad(`${u.username} leads a pool of their own — a leader isn't in anyone else's`);
    const there = this.db.get('SELECT status FROM pool_members WHERE pool_id = :p AND user_id = :u', { p: p.id, u: u.id });
    if (there) throw new HttpError(409, there.status === 'active' ? `${u.username} is in this pool already` : `${u.username} has been asked already`);
    const count = this.db.get('SELECT COUNT(*) AS n FROM pool_members WHERE pool_id = :p', { p: p.id }).n;
    if (count >= MAX_POOL_MEMBERS) throw bad(`A pool has up to ${MAX_POOL_MEMBERS} members`);
    this.db.run('INSERT INTO pool_members (pool_id, user_id, status, invited_by, invited_at) VALUES (:p, :u, \'invited\', :by, :t)', { p: p.id, u: u.id, by: by ? by.id : null, t: this.now() });
    this.hub.publish(u.id, 'pool', {});
    await this.notifier.notify(u.id, {
      type: 'account', level: 'warn', channel: 'account',
      title: `🤝 ${p.leader} asked you to join the pool "${p.name}"`,
      message: `Join it and ${p.leader}'s watchlist, armed items and drop watches show up on yours, kept in step as they change. Checking out with them is a separate switch, yours alone. Answer on your dashboard: ${this.cfg.baseUrl}/app#pool`,
      buttons: [{ label: 'Open', url: `${this.cfg.baseUrl}/app#pool` }],
    }).catch(() => null);
    return this.adminView(p.id);
  }

  /** Taken out of the pool by an admin (asked or joined): their copies of the leader's items go. */
  async removeMember(poolId, userId) {
    const p = this.pool(poolId);
    if (!p) throw new HttpError(404, 'Pool not found');
    const m = this.db.get('SELECT * FROM pool_members WHERE pool_id = :p AND user_id = :u', { p: p.id, u: String(userId || '') });
    if (!m) throw new HttpError(404, 'Not in this pool');
    this.db.run('DELETE FROM pool_members WHERE pool_id = :p AND user_id = :u', { p: p.id, u: m.user_id });
    this.changed();
    this.clear(m.user_id);
    this.hub.publish(m.user_id, 'pool', {});
    if (m.status === 'active') {
      this.repo.addEvent(m.user_id, { type: 'account', level: 'info', message: `🤝 You're no longer in the pool "${p.name}" — ${p.leader}'s items are off your watchlist, and their checkouts don't start yours` });
    }
    return this.adminView(p.id);
  }

  /** A pool closed: every member's copies go. */
  drop(poolId) {
    const p = this.pool(poolId);
    if (!p) throw new HttpError(404, 'Pool not found');
    const members = this.db.all('SELECT user_id, status FROM pool_members WHERE pool_id = :p', { p: p.id });
    this.db.run('DELETE FROM pools WHERE id = :id', { id: p.id });
    this.changed();
    for (const m of members) {
      this.clear(m.user_id);
      this.hub.publish(m.user_id, 'pool', {});
      if (m.status === 'active') this.repo.addEvent(m.user_id, { type: 'account', level: 'info', message: `🤝 The pool "${p.name}" was closed — ${p.leader}'s items are off your watchlist` });
    }
    return { ok: true, name: p.name };
  }

  adminView(poolId) {
    const p = this.pool(poolId);
    if (!p) return null;
    const members = this.db.all(`SELECT m.user_id, m.status, m.follow_aco, m.invited_at, m.joined_at, u.username FROM pool_members m JOIN users u ON u.id = m.user_id
      WHERE m.pool_id = :p ORDER BY m.status = 'active' DESC, u.username`, { p: p.id });
    return {
      id: p.id, name: p.name, leader: { id: p.owner_id, username: p.leader }, createdAt: p.created_at,
      // (Whether each checks out with the leader, not how much they'd spend: that's theirs.)
      members: members.map((m) => ({ userId: m.user_id, username: m.username, status: m.status, followAco: m.status === 'active' && !!m.follow_aco, invitedAt: m.invited_at, joinedAt: m.joined_at })),
    };
  }

  adminList() {
    return this.db.all('SELECT id FROM pools ORDER BY created_at').map((r) => this.adminView(r.id));
  }

  // ---------------------------------------------------------------------------
  // Members: their own say
  // ---------------------------------------------------------------------------
  accept(user, poolId) {
    const p = this.pool(poolId);
    const m = p && this.db.get("SELECT * FROM pool_members WHERE pool_id = :p AND user_id = :u AND status = 'invited'", { p: p.id, u: user.id });
    if (!m) throw new HttpError(404, "That invitation isn't there any more");
    if (this.ownsPool(user.id)) throw bad('You lead a pool of your own — a leader isn\'t in anyone else\'s');
    const now = this.membership(user.id);
    if (now) throw bad(`You're in ${now.leader}'s pool "${now.pool_name}" — leave it first (one pool at a time)`);
    this.db.run("UPDATE pool_members SET status = 'active', joined_at = :t, follow_aco = 0 WHERE pool_id = :p AND user_id = :u", { t: this.now(), p: p.id, u: user.id });
    this.changed();
    this.repo.addEvent(user.id, { type: 'account', level: 'info', message: `🤝 You joined ${p.leader}'s pool "${p.name}": their watchlist, armed items and drop watches show on yours (🤝), kept in step. Checking out with them is off until you switch it on` });
    this.repo.addEvent(p.owner_id, { type: 'account', level: 'info', message: `🤝 ${user.username} joined your pool "${p.name}"` });
    this.hub.publish(p.owner_id, 'pool', {});
    this.sync(p.owner_id);
    return this.viewFor(user);
  }

  decline(user, poolId) {
    const n = this.db.run("DELETE FROM pool_members WHERE pool_id = :p AND user_id = :u AND status = 'invited'", { p: String(poolId || ''), u: user.id }).changes;
    if (!n) throw new HttpError(404, "That invitation isn't there any more");
    return this.viewFor(user);
  }

  leave(user) {
    const m = this.membership(user.id);
    if (!m) throw bad("You're not in a pool");
    this.db.run('DELETE FROM pool_members WHERE pool_id = :p AND user_id = :u', { p: m.pool_id, u: user.id });
    this.changed();
    this.clear(user.id);
    this.repo.addEvent(user.id, { type: 'account', level: 'info', message: `🤝 You left ${m.leader}'s pool "${m.pool_name}" — their items are off your watchlist` });
    this.repo.addEvent(m.owner_id, { type: 'account', level: 'info', message: `🤝 ${user.username} left your pool "${m.pool_name}"` });
    this.hub.publish(m.owner_id, 'pool', {});
    return this.viewFor(user);
  }

  /**
   * Checking out with the leader: { on, cap, agree }. Only ever switched on by the member, here — agreeing to what it
   * does the first time, with the most it may cost them an item, and their own Auto-checkout on.
   */
  follow(user, input = {}) {
    const m = this.membership(user.id);
    if (!m) throw bad("You're not in a pool");
    const on = input.on === true;
    if (on) {
      if (!m.aco_agreed_at && input.agree !== true) throw bad('Tick the box to agree first');
      const cap = num(input.cap, { min: 1, max: 100000, def: null });
      if (cap === null) throw bad('Set the most it may cost you an item ($1 or more)');
      const aco = this.ctx.aco ? this.ctx.aco.settings(user.id) : { enabled: false };
      if (!aco.enabled) throw bad("Switch your own Auto-checkout on first (above): the pool's checkouts are yours — your card, your details, your limits");
      this.db.run('UPDATE pool_members SET follow_aco = 1, aco_cap = :c, aco_agreed_at = COALESCE(aco_agreed_at, :t) WHERE pool_id = :p AND user_id = :u', { c: Math.round(cap * 100) / 100, t: this.now(), p: m.pool_id, u: user.id });
      if (!m.follow_aco || m.aco_cap !== cap) {
        this.repo.addEvent(user.id, { type: 'aco', level: 'warn', message: `🤝 Checking out with ${m.leader}: when their Auto-checkout starts — or one of their armed items drops — yours starts for the same item, in your checkout browser with your card and details, up to $${cap.toFixed(2)} an item and within your limits` });
      }
      if (!m.follow_aco) this.repo.addEvent(m.owner_id, { type: 'account', level: 'info', message: `🤝 ${user.username} checks out with you now (pool "${m.pool_name}")` });
    } else if (m.follow_aco) {
      this.db.run('UPDATE pool_members SET follow_aco = 0 WHERE pool_id = :p AND user_id = :u', { p: m.pool_id, u: user.id });
      this.repo.addEvent(user.id, { type: 'aco', level: 'info', message: `🤝 No longer checking out with ${m.leader}: their checkouts don't start yours, and their armed items aren't armed on yours` });
      this.repo.addEvent(m.owner_id, { type: 'account', level: 'info', message: `🤝 ${user.username} stopped checking out with you (pool "${m.pool_name}")` });
    }
    this.hub.publish(m.owner_id, 'pool', {});
    this.sync(m.owner_id);
    return this.viewFor(user);
  }

  /** Skip one of the leader's items (never armed on yours, never started by their checkouts) — or follow it again. */
  hold(user, itemId, hold) {
    const row = this.db.get('SELECT * FROM items WHERE id = :id AND user_id = :u AND pool_src IS NOT NULL', { id: String(itemId || ''), u: user.id });
    if (!row) throw new HttpError(404, "That isn't one of your pool's items");
    if (hold) {
      // (Armed: disarmed — and armed again when you follow it again. Bought already: it stays as it is.)
      this.db.run(row.aco ? 'UPDATE items SET pool_hold = 1, aco = 0, aco_at = NULL, pool_aco_at = NULL WHERE id = :id' : 'UPDATE items SET pool_hold = 1 WHERE id = :id', { id: row.id });
    } else {
      this.db.run('UPDATE items SET pool_hold = 0 WHERE id = :id', { id: row.id });
    }
    const m = this.membership(user.id);
    if (m) this.sync(m.owner_id);
    this.hub.publish(user.id, 'watch', { id: row.id, pool: true });
    return this.repo.getItem(user.id, row.id);
  }

  /** What the member's dashboard shows: invitations, their pool, and the pools they lead. */
  viewFor(user) {
    const rows = this.db.all(`SELECT m.*, p.name AS pool_name, p.owner_id, o.username AS leader FROM pool_members m JOIN pools p ON p.id = m.pool_id
      JOIN users o ON o.id = p.owner_id WHERE m.user_id = :u ORDER BY m.invited_at`, { u: user.id });
    const m = rows.find((r) => r.status === 'active') || null;
    const count = (sql, params) => this.db.get(sql, params).n;
    const leads = this.db.all('SELECT id FROM pools WHERE owner_id = :u ORDER BY created_at', { u: user.id }).map((r) => {
      const v = this.adminView(r.id);
      return { id: v.id, name: v.name, members: v.members.map(({ username, status, followAco, joinedAt }) => ({ username, status, followAco, joinedAt })) };
    });
    return {
      invites: rows.filter((r) => r.status === 'invited').map((r) => ({ poolId: r.pool_id, name: r.pool_name, leader: r.leader, invitedAt: r.invited_at })),
      pool: m ? {
        id: m.pool_id, name: m.pool_name, leader: m.leader, joinedAt: m.joined_at,
        followAco: !!m.follow_aco, cap: m.aco_cap ?? null, agreed: !!m.aco_agreed_at,
        members: count("SELECT COUNT(*) AS n FROM pool_members WHERE pool_id = :p AND status = 'active'", { p: m.pool_id }),
        shared: count('SELECT COUNT(*) AS n FROM items WHERE user_id = :u AND pool_src IS NOT NULL', { u: user.id }),
        armed: count('SELECT COUNT(*) AS n FROM items WHERE user_id = :u AND pool_src IS NOT NULL AND aco = 1', { u: user.id }),
        skipped: count('SELECT COUNT(*) AS n FROM items WHERE user_id = :u AND pool_src IS NOT NULL AND pool_hold = 1', { u: user.id }),
      } : null,
      leads,
      acoOn: !!(this.ctx.aco && this.ctx.aco.settings(user.id).enabled),
    };
  }

  // ---------------------------------------------------------------------------
  // Keeping the members' copies in step
  // ---------------------------------------------------------------------------
  /** Someone's watchlist (or Auto-checkout switch) changed: if they lead a pool, its copies follow straight away. */
  touch(userId) {
    if (!userId || !this.leaderIds().has(userId) || this.pending.has(userId)) return;
    this.pending.add(userId);
    setImmediate(() => {
      this.pending.delete(userId);
      try { this.sync(userId); } catch (e) { this.cfg.log('[pools]', e.message); }
    });
  }

  syncAll() {
    for (const id of this.leaderIds()) this.sync(id);
    // (Copies left from a pool someone isn't in any more — one still checking out when they left: gone now.)
    const stale = this.db.all(`SELECT DISTINCT i.user_id FROM items i WHERE i.pool_src IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pool_members m WHERE m.user_id = i.user_id AND m.status = 'active')`);
    for (const r of stale) this.clear(r.user_id);
  }

  /** Every member's copies of this leader's watchlist, as it is now. Returns how many changed. */
  sync(leaderId) {
    const members = this.followers(leaderId);
    if (!members.length) return 0;
    const src = this.db.all('SELECT * FROM items WHERE user_id = :u ORDER BY position, created_at', { u: leaderId });
    // (The leader's Auto-checkout switched off: nothing of theirs is armed on anyone's.)
    const leaderOn = !!(this.ctx.aco && this.ctx.aco.settings(leaderId).enabled);
    let n = 0;
    for (const m of members) n += this.mirror(src, m, leaderOn);
    return n;
  }

  mirror(src, m, leaderOn) {
    const userId = m.user_id;
    const mine = this.db.all('SELECT * FROM items WHERE user_id = :u AND pool_src IS NOT NULL', { u: userId });
    const bySrc = new Map(mine.map((r) => [r.pool_src, r]));
    const cap = m.follow_aco && m.aco_cap !== null && m.aco_cap !== undefined ? m.aco_cap : null;
    let changed = 0;
    const armedAt = new Set(); // (stores where a copy was armed just now: a checkpoint up there is opened for them)
    for (const s of src) {
      const row = bySrc.get(s.id);
      // (Never more than the member's own most for the pool, when they check out with the leader.)
      const max = cap === null ? s.max_price : s.max_price === null || s.max_price === undefined ? cap : Math.min(s.max_price, cap);
      const want = !!s.aco && !!m.follow_aco && leaderOn;
      if (!row) {
        // (One of their own already — the same store and SKU: theirs, as they have it.)
        if (this.db.get('SELECT 1 AS y FROM items WHERE user_id = :u AND store = :s AND sku = :k COLLATE NOCASE', { u: userId, s: s.store, k: s.sku })) continue;
        let added;
        try {
          added = this.repo.addItem(userId, {
            store: s.store, sku: s.sku, name: s.name, url: s.url, price: s.price, maxPrice: max, quantity: s.quantity,
            profileId: null, cardId: '', monitor: !!s.monitor, announce: false, aco: want, discount: s.discount || '',
          });
        } catch (e) {
          this.cfg.log('[pools]', `${m.username}: ${e.message}`);
          continue;
        }
        // (Its stock as the leader's copy knows it: the same page — not a change, so nothing's alerted or started by it.)
        this.db.run(`UPDATE items SET pool_src = :src, pool_aco_at = :at, pool_watch = :w, status = :st, status_source = :ss, status_at = :sat, checked_at = :ca,
            title = :ti, last_price = :lp WHERE id = :id`, {
          src: s.id, at: want ? s.aco_at : null, w: s.drop_watch || null, st: s.status, ss: s.status_source, sat: s.status_at, ca: s.checked_at,
          ti: s.title, lp: s.last_price, id: added.id,
        });
        if (want) armedAt.add(s.store);
        changed += 1;
        continue;
      }
      const same = (a, b) => (a ?? null) === (b ?? null);
      if (!same(row.store, s.store) || !same(row.sku, s.sku) || !same(row.name, s.name) || !same(row.url, s.url) || !same(row.price, s.price)
        || !same(row.max_price, max) || !same(row.quantity, s.quantity) || !!row.monitor !== !!s.monitor || !same(row.discount || '', s.discount || '')) {
        try {
          this.repo.updateItem(userId, row.id, {
            store: s.store, sku: s.sku, name: s.name, url: s.url, price: s.price, maxPrice: max, quantity: s.quantity,
            profileId: row.profile_id, cardId: row.card_id, monitor: !!s.monitor, announce: false, aco: !!row.aco, discount: s.discount || '',
          });
          changed += 1;
        } catch (e) {
          this.cfg.log('[pools]', `${m.username}: ${e.message}`);
        }
      }
      if (!same(row.pool_watch, s.drop_watch)) this.db.run('UPDATE items SET pool_watch = :w WHERE id = :id', { w: s.drop_watch || null, id: row.id });
      // Armed or not, as the leader's is — unless it's checking out right now (it finishes first), skipped, or bought
      // already for this arming of the leader's.
      if (this.db.get(ACTIVE_RUN, { i: row.id })) continue;
      const armed = want && !row.pool_hold;
      if (armed && !row.aco && !same(row.pool_aco_at, s.aco_at)) {
        this.db.run('UPDATE items SET aco = 1, aco_at = :t, pool_aco_at = :at WHERE id = :id', { t: this.now(), at: s.aco_at, id: row.id });
        armedAt.add(s.store);
        changed += 1;
      } else if (!armed && row.aco) {
        this.db.run('UPDATE items SET aco = 0, aco_at = NULL, pool_aco_at = NULL WHERE id = :id', { id: row.id });
        changed += 1;
      }
    }
    // Gone from the leader's watchlist: gone from theirs (once it's done checking out, if it is).
    const ids = new Set(src.map((s) => s.id));
    for (const row of mine) {
      if (ids.has(row.pool_src) || this.db.get(ACTIVE_RUN, { i: row.id })) continue;
      this.db.run('DELETE FROM items WHERE id = :id AND user_id = :u', { id: row.id, u: userId });
      changed += 1;
    }
    if (changed) this.hub.publish(userId, 'watch', { pool: true });
    // (Armed just now where a checkpoint's up: its check page opened for them to solve before the drop.)
    for (const store of armedAt) {
      const r = this.ctx.retailers && this.ctx.retailers.get(store);
      if (r && r.gate && r.gate.kind === 'checkpoint' && this.ctx.gates && this.ctx.gates.isUp(store)) this.checkpointFor(m, r, 'armed');
    }
    return changed;
  }

  /** Someone out of a pool: their copies of its leader's items go (one checking out goes once it's done). */
  clear(userId) {
    const rows = this.db.all('SELECT id FROM items WHERE user_id = :u AND pool_src IS NOT NULL', { u: userId });
    let n = 0;
    for (const r of rows) {
      if (this.db.get(ACTIVE_RUN, { i: r.id })) continue;
      n += this.db.run('DELETE FROM items WHERE id = :id AND user_id = :u', { id: r.id, u: userId }).changes;
    }
    if (n) this.hub.publish(userId, 'watch', { pool: true });
    return n;
  }

  /** The leader's drop watches changed: their members' dashboards look again. */
  relayDrops(userId) {
    if (!this.leaderIds().has(userId)) return;
    for (const m of this.followers(userId)) this.hub.publish(m.user_id, 'drop', { pool: true });
  }

  // ---------------------------------------------------------------------------
  // The leader's group at a store's gate: its virtual queue, its checkpoint
  // ---------------------------------------------------------------------------
  /**
   * A member of the group, ready for something to open in their checkout browser: their account in good standing, their
   * own Auto-checkout on (checking out with the leader is theirs to keep on), a checkout browser connected. Else null —
   * and, when it's theirs to fix, they're told what the leader started and why nothing opened on theirs.
   */
  ready(m, leaderName, what) {
    const u = this.repo.userById(m.user_id);
    if (!u || u.disabled || !entitlement(u, this.now()).active || !this.ctx.aco) return null;
    if (!this.ctx.aco.settings(u.id).enabled) {
      this.repo.addEvent(u.id, { type: 'aco', level: 'warn', message: `🤝 ${leaderName} ${what}, but your Auto-checkout is switched off — nothing opened on yours` });
      return null;
    }
    const device = this.ctx.aco.checkoutDevice(u.id);
    if (!device) {
      this.repo.addEvent(u.id, { type: 'aco', level: 'warn', message: `🤝 ${leaderName} ${what}, but no browser with the extension is connected to your account — connect your checkout browser (Setup → Extension)` });
      return null;
    }
    return { user: u, device, listening: this.ctx.aco.isListening(device.id) };
  }

  leaderName(leaderId) {
    const u = this.repo.userById(leaderId);
    return u ? u.username : "Your pool's leader";
  }

  /**
   * The leader got in line at a store's virtual queue (Discord's "📥 Join the queue on my computer", or 🤝 Group Queue):
   * each member who checks out with them gets their own checkout browser in line there too — a tab of its own, its own
   * place, waiting its turn (never refreshed). Told by DM (not waited for: Discord wants its answer in 3 seconds).
   * Returns { put, of }: how many got in line, of the group.
   */
  groupQueue(leaderId, r) {
    const group = this.group(leaderId);
    if (!group.length || !r || !r.gate || r.gate.kind !== 'queue') return { put: 0, of: group.length };
    const name = this.leaderName(leaderId);
    const link = this.ctx.gates ? this.ctx.gates.link(r) : r.base;
    let put = 0;
    for (const m of group) {
      const ok = this.ready(m, name, `got in line at ${r.name}'s virtual queue`);
      if (!ok) continue;
      const had = this.ctx.aco.inLobby(m.user_id, r.id);
      this.ctx.aco.lobby(m.user_id, r, 'pool');
      put += 1;
      if (had) continue; // (in line there already: said then)
      this.notifier.notify(m.user_id, {
        type: 'aco', level: 'urgent', channel: 'aco',
        title: `🚦 Getting in line at ${r.name} with ${name}`,
        message: `${name} got in line at ${r.name}'s virtual queue, and you check out with them (your pool): your checkout browser (${ok.device.name}) is getting in line too — a tab of its own, waiting its turn.\nLeave that tab alone: the queue page refreshes itself, and refreshing it yourself can lose your place. Your ⚡ Buy and Auto-checkout at ${r.name} carry on from there once you're through.${ok.listening ? '' : `\n⚠️ ${ok.device.name} isn't open right now — it gets in line as soon as it is.`}`,
        url: link, buttons: [{ label: '🖥️ Open my computer', url: REMOTE_DESKTOP_URL }, { label: 'Auto-checkout', url: `${this.cfg.baseUrl}/app#aco` }],
      }).catch((e) => this.cfg.log('[pools]', e.message));
    }
    return { put, of: group.length };
  }

  /**
   * A checkpoint's check page opened in a member's checkout browser, ahead of the drop, and them told to solve it there:
   * once for each time it goes up. why: 'up' (it went up where they're armed with the leader), 'armed' (the leader armed
   * something there while it's up), 'group' (the leader's 🤝 Group Checkpoint). Returns true if it opened (or was open).
   */
  checkpointFor(m, r, why) {
    const name = this.leaderName(m.owner_id || this.leaderOf(m.user_id));
    const ok = this.ready(m, name, why === 'group' ? `asked the pool to get through ${r.name}'s checkpoint` : `has something armed at ${r.name}, where the checkpoint is up`);
    if (!ok) return false;
    const gate = this.ctx.gates ? this.ctx.gates.get(r.id) : null;
    const key = `${m.user_id}:${r.id}`;
    const since = gate ? gate.since : null;
    this.ctx.aco.lobby(m.user_id, r, 'pool');
    if (this.headsUp.get(key) === since) return true; // (told already, this time it's up)
    this.headsUp.set(key, since);
    const reason = why === 'group' ? `${name} asked the pool to get through it (🤝 Group Checkpoint)` : `${name} has something armed there, and you check out with them (your pool)`;
    this.notifier.notify(m.user_id, {
      type: 'aco', level: 'urgent', channel: 'aco',
      title: `🛡️ Solve ${r.name}'s check now — before the drop`,
      message: `${r.name}'s checkpoint is up: ${reason}.\nYour checkout browser (${ok.device.name}) has opened ${r.name}'s check page in a tab — solve the human check there now, and your checkout goes straight through when it drops. It has to be solved in that browser: away from the computer, 🖥️ Open my computer (Chrome Remote Desktop).${ok.listening ? '' : `\n⚠️ ${ok.device.name} isn't open right now — the page opens as soon as it is.`}`,
      url: this.ctx.gates ? this.ctx.gates.link(r) : r.base,
      buttons: [{ label: '🖥️ Open my computer', url: REMOTE_DESKTOP_URL }, { label: 'Auto-checkout', url: `${this.cfg.baseUrl}/app#aco` }],
    }, { urgent: true }).catch((e) => this.cfg.log('[pools]', e.message));
    return true;
  }

  /**
   * A store's checkpoint went up (monitor/gates.js → aco.js): the members with something armed there with their pool's
   * leader (their copy armed, not skipped) get its check page opened and are told to solve it. Returns the ids told —
   * their DM says it all, so the store's usual "checkpoint is up" DM isn't sent them as well.
   */
  checkpointUp(r) {
    const told = new Set();
    if (!r || !r.gate || r.gate.kind !== 'checkpoint') return told;
    const rows = this.db.all(`SELECT DISTINCT i.user_id FROM items i JOIN pool_members m ON m.user_id = i.user_id AND m.status = 'active' AND m.follow_aco = 1
      WHERE i.store = :s AND i.aco = 1 AND i.pool_src IS NOT NULL AND i.pool_hold = 0`, { s: r.id });
    for (const { user_id: userId } of rows) {
      const m = this.membership(userId);
      if (m && this.checkpointFor(m, r, 'up')) told.add(userId);
    }
    return told;
  }

  /**
   * 🤝 Group Checkpoint (the leader's DM): the check page opened in the leader's own checkout browser and in each group
   * member's, each told to solve it themselves. { device, listening, opened, of } — or { error }.
   */
  groupCheckpoint(leaderId, storeId) {
    const r = this.ctx.retailers && this.ctx.retailers.get(String(storeId || ''));
    if (!r || !r.gate || r.gate.kind !== 'checkpoint') return { error: "That store doesn't have a checkpoint Mugibot knows." };
    if (!this.ctx.gates || !this.ctx.gates.isUp(r.id)) return { error: `${r.name}'s checkpoint isn't up right now — nothing to solve. Mugibot posts in #virtual-queue-detection when it is.` };
    const device = this.ctx.aco.checkoutDevice(leaderId);
    if (device) this.ctx.aco.lobby(leaderId, r, 'pool');
    const group = this.group(leaderId);
    let opened = 0;
    for (const m of group) if (this.checkpointFor(m, r, 'group')) opened += 1;
    return { store: r, device: device ? { id: device.id, name: device.name } : null, listening: device ? this.ctx.aco.isListening(device.id) : false, opened, of: group.length };
  }

  // ---------------------------------------------------------------------------
  // Checking out with the leader
  // ---------------------------------------------------------------------------
  /**
   * The leader's Auto-checkout started for one of their items (server/aco.js): each member who checks out with them
   * gets a run of their own for their copy of it — at once, in their own checkout browser, within their own limits.
   * explicit: the leader started it themselves (Trigger ACO, ⚡ Buy, 🚦 Wait for queue, then ACO): the member's copy
   * goes whether it's armed or not (unless they skip it); else (a drop) only an armed copy — one bought already for
   * this arming isn't. later: the alerts' list (a drop's: sent once every run is made). Returns the runs started.
   */
  async fanOut(leaderId, srcItemId, { explicit = false, price = null, later = null, variantId = null, queue = false } = {}) {
    if (!this.ctx.aco || !this.leaderIds().has(leaderId)) return [];
    const members = this.followers(leaderId).filter((m) => m.follow_aco);
    if (!members.length) return [];
    // (Their copies as the leader's list is now — one put on it a moment ago, by ⚡ Buy on a channel's alert, say.)
    this.sync(leaderId);
    const leader = this.repo.userById(leaderId);
    const tell = later || [];
    const runs = [];
    for (const m of members) {
      const row = this.db.get('SELECT * FROM items WHERE user_id = :u AND pool_src = :s', { u: m.user_id, s: srcItemId });
      if (!row || row.pool_hold || (!explicit && !row.aco)) continue;
      if (!this.ctx.aco.settings(m.user_id).enabled) {
        this.repo.addEvent(m.user_id, { type: 'aco', level: 'warn', message: `🤝 ${leader ? leader.username : 'Your pool\'s leader'} started Auto-checkout on ${row.name}, but yours is switched off — nothing started on your account`, name: row.name, sku: row.sku, url: row.url || null });
        continue;
      }
      const s = this.ctx.aco.settings(m.user_id);
      const run = await this.ctx.aco.trigger(row, {
        price, test: explicit, later: tell, variantId, queue: queue && s.mode === 'place',
        pool: { leader: leader ? leader.username : '', explicit },
      });
      if (run) runs.push(run);
    }
    // (Started first, every one of them — then told.)
    if (!later) await Promise.allSettled(tell.map((f) => f()));
    return runs;
  }
}
