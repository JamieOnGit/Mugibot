// Signed in at the stores that matter, 24/7 (Mugibot 2.0): EB Games, Premium Bandai, JB Hi-Fi, BIG W, Target and Kmart
// by default — each member chooses (Account → Store sign-ins), admins included.
//
// Where the readings come from: the extension (extension/logins.js) — the store pages you open, the stores whose pages
// say so read every 10 minutes, and the others' home pages opened in its own window now and then (1.40.0) — reported
// to POST /api/ext/logins and kept per browser (devices.logins). This keeps, per member and store, the state that counts
// (login_state): the checkout browser's reading — sign-ins are per browser, and that's where Auto-checkout and ⚡ Buy
// run — else the latest any of the member's browsers saw.
//
// Signed out → told at once: the dashboard, and a Discord DM with a "Sign in" button (Account → Store sign-ins can turn
// the DM off), again at most twice a day while it stays that way; signed back in → said so. Mugibot never signs in for
// you and never sees a password: the button opens the store's own sign-in page in your browser (Chrome's saved
// passwords fill it in if you keep them there).

import { entitlement } from './entitlement.js';
import { latestLogin } from './retailers/index.js';

export const DEFAULT_SIGNIN_STORES = Object.freeze(['ebgames', 'pbandai', 'jbhifi', 'bigw', 'target', 'kmart']);
// Still signed out: reminded at most this often.
export const REMIND_MS = 12 * 60 * 60 * 1000;
// No reading from the browser that counts for this long: "not checked lately" (the browser closed, the computer asleep).
export const STALE_MS = 2 * 60 * 60 * 1000;

const sydney = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', hour: 'numeric', minute: '2-digit' });

export class SignIns {
  constructor({ cfg, db, repo, retailers, notifier, hub, now = () => Date.now() }) {
    Object.assign(this, { cfg, db, repo, retailers, notifier, hub, now });
    this.aco = null; // (set by app.js: the checkout browser)
    // One review at a time per member: two reports close together never tell twice.
    this.busy = new Map();
  }

  /** Stores you can keep signed in to: those with an account (and the dummy copies where the dummy stores run). */
  candidates() {
    return this.retailers.list.filter((r) => r.account && this.retailers.enabled(r) && (!r.demo || this.cfg.demoStoreUrl));
  }

  /** The six (the real stores: a dummy store's copy only when you tick it). */
  defaults() {
    const ids = new Set(DEFAULT_SIGNIN_STORES);
    return this.candidates().filter((r) => ids.has(r.id)).map((r) => r.id);
  }

  /** { stores: [ids kept signed in to], dm: Discord DM when signed out } — your choice, else the six. */
  prefs(userId) {
    const saved = this.repo.getData(userId, 'signins', null) || {};
    const known = new Set(this.candidates().map((r) => r.id));
    const stores = Array.isArray(saved.stores) ? saved.stores.filter((id) => known.has(id)) : this.defaults();
    return { stores, dm: saved.dm !== false };
  }

  setPrefs(userId, input) {
    const cur = this.prefs(userId);
    const known = new Set(this.candidates().map((r) => r.id));
    const stores = Array.isArray(input.stores) ? [...new Set(input.stores.map((s) => String(s).slice(0, 40)).filter((id) => known.has(id)))] : cur.stores;
    const dm = typeof input.dm === 'boolean' ? input.dm : cur.dm;
    this.repo.setData(userId, 'signins', { stores, dm });
    // (A store no longer kept: its state forgotten, so keeping it again starts afresh.)
    const keep = new Set(stores);
    for (const row of this.db.all('SELECT store FROM login_state WHERE user_id = :u', { u: userId })) {
      if (!keep.has(row.store)) this.db.run('DELETE FROM login_state WHERE user_id = :u AND store = :s', { u: userId, s: row.store });
    }
    return { stores, dm };
  }

  /** The reading that counts at a store: the checkout browser's, else the latest any of the member's browsers saw. */
  reading(r, devices, checkout) {
    const own = checkout ? devices.find((d) => d.id === checkout.id) : null;
    return (own && latestLogin(r, [own])) || latestLogin(r, devices);
  }

  /**
   * Each kept store's state after a browser's report (or a change of settings): a store gone signed out is told at once,
   * reminded at most every REMIND_MS while it stays so; one signed back in after that is said so. Returns what was told:
   * [{ store, status: 'out' | 'in', reminder? }].
   */
  async review(userId) {
    const prev = this.busy.get(userId) || Promise.resolve();
    const next = prev.then(() => this.reviewNow(userId));
    const tail = next.catch(() => null);
    this.busy.set(userId, tail);
    tail.then(() => { if (this.busy.get(userId) === tail) this.busy.delete(userId); });
    return next;
  }

  async reviewNow(userId) {
    const user = this.repo.userById(userId);
    if (!user || user.disabled) return [];
    const { stores, dm } = this.prefs(userId);
    const devices = this.repo.listDevices(userId);
    if (!devices.length || !stores.length) return [];
    const checkout = this.aco ? this.aco.checkoutDevice(userId) : null;
    const now = this.now();
    const active = entitlement(user, now).active;
    const told = [];
    for (const id of stores) {
      const r = this.retailers.get(id);
      if (!r || !r.account) continue;
      const l = this.reading(r, devices, checkout);
      if (!l || (l.status !== 'in' && l.status !== 'out')) continue;
      const row = this.db.get('SELECT * FROM login_state WHERE user_id = :u AND store = :s', { u: userId, s: id });
      if (row && row.status === l.status) {
        this.db.run('UPDATE login_state SET at = :at WHERE user_id = :u AND store = :s', { at: Math.max(row.at, l.at), u: userId, s: id });
        if (l.status === 'out' && active && (!row.alerted_at || now - row.alerted_at >= REMIND_MS)) {
          await this.tell(user, r, l, { dm, reminder: !!row.alerted_at, since: row.since });
          this.db.run('UPDATE login_state SET alerted_at = :t WHERE user_id = :u AND store = :s', { t: now, u: userId, s: id });
          told.push({ store: id, status: 'out', reminder: true });
        }
        continue;
      }
      // (A reading older than the state it would replace: an older report arriving late — ignored.)
      if (row && l.at < row.at) continue;
      const wasAlerted = !!(row && row.status === 'out' && row.alerted_at);
      let alerted = null;
      if (l.status === 'out' && active) {
        await this.tell(user, r, l, { dm, since: l.at });
        alerted = now;
        told.push({ store: id, status: 'out' });
      } else if (l.status === 'in' && wasAlerted) {
        await this.tell(user, r, l, { dm, back: true });
        told.push({ store: id, status: 'in' });
      }
      this.db.run(`INSERT INTO login_state (user_id, store, status, at, since, alerted_at) VALUES (:u, :s, :st, :at, :at, :al)
        ON CONFLICT (user_id, store) DO UPDATE SET status = excluded.status, at = excluded.at, since = excluded.since, alerted_at = excluded.alerted_at`,
      { u: userId, s: id, st: l.status, at: l.at, al: alerted });
    }
    if (told.length) this.hub.publish(userId, 'devices', {});
    return told;
  }

  async tell(user, r, l, { dm, reminder = false, back = false, since = null }) {
    const url = `${r.base}${r.account.signIn || ''}`;
    const where = l.device ? ` in ${l.device}` : '';
    if (back) {
      return this.notifier.notify(user.id, {
        type: 'signin', level: 'success', channel: dm ? 'signin' : undefined, store: r.id,
        title: `🔑 Signed in at ${r.name} again`, message: `Seen${where} at ${sydney.format(l.at)} — ⚡ Buy and Auto-checkout there have your saved details again.`,
      });
    }
    const required = r.account.required ? ` ${r.name} only sells to customers who are signed in: until you are, nothing there can be bought for you.` : ' Signed in, ⚡ Buy and Auto-checkout there go faster — the store fills in your saved details itself.';
    return this.notifier.notify(user.id, {
      type: 'signin', level: 'urgent', channel: dm ? 'signin' : undefined, store: r.id,
      title: `🔑 ${reminder ? 'Still signed out' : 'Signed out'} of ${r.name}`,
      message: `Not signed in${where} (seen ${sydney.format(l.at)}${reminder && since ? `; signed out since ${sydney.format(since)}` : ''}).${required}\nSign in before the next drop — in the browser Mugibot checks out in.`,
      url, buttons: [{ label: `Sign in at ${r.name}`, url }],
    });
  }

  /**
   * The profile's view: each store you can keep signed in to, whether you do, its state ('in' | 'out' | null: not seen
   * yet), when it was seen and by which browser, since when, and whether it hasn't been checked lately.
   */
  view(userId) {
    const { stores, dm } = this.prefs(userId);
    const keep = new Set(stores);
    const devices = this.repo.listDevices(userId);
    const checkout = this.aco ? this.aco.checkoutDevice(userId) : null;
    const rows = new Map(this.db.all('SELECT * FROM login_state WHERE user_id = :u', { u: userId }).map((x) => [x.store, x]));
    const now = this.now();
    const list = this.candidates().map((r) => {
      const l = this.reading(r, devices, checkout);
      const row = rows.get(r.id);
      return {
        id: r.id, keep: keep.has(r.id), since: row ? row.since : null, alertedAt: row ? row.alerted_at : null,
        stale: !!(l && keep.has(r.id) && now - l.at > STALE_MS),
      };
    });
    return { stores: list, prefs: { stores, dm }, checkoutBrowser: checkout ? checkout.name : null };
  }
}
