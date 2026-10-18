// Clear cart (docs/AUTO-CHECKOUT.md): a member empties their bag at a store — or at every store, with
// Clear all — from the dashboard, wherever they are. A store keeps one bag for a browser, and
// Auto-checkout only ever buys the one item: anything else in the checkout browser's bag there stops it
// ("your bag already had 1 item in it"). Emptying the bags before a drop keeps that out of the way.
//
// The checkout browser does the emptying (the one Auto-checkout's runs go to, where those bags are):
// it opens the store's bag in a tab, presses each thing's own Remove (and the store's "Are you sure?"),
// opens the bag once more to check it's empty, and closes the tab. One store at a time. Mugibot's server
// never touches a store: it hands the browser what to empty, and keeps how each one went.
//
// A store where a checkout of the member's is going in that browser is left alone (its bag is that
// checkout's): the browser says so, and the member empties it once the checkout's done. So is one whose
// virtual queue that browser is in (asking the store for a page could lose the place in line).

import { entitlement } from './entitlement.js';
import { newId } from './crypto.js';
import { olderVersion } from './monitor/sweep.js';

// The oldest extension that empties bags (older ones would never pick a request up).
export const BAGS_EXTENSION_VERSION = '1.18.0';
// The checkout browser has this long to pick a request up: open, it asks at once (or, not listening for
// Auto-checkout, within a couple of minutes).
const PICKUP_MS = 4 * 60 * 1000;
// Handed over and not heard of since (the browser closed, or restarted mid-way): handed over again.
const RESEND_MS = 60 * 1000;
// One store's bag, from opening it to empty — at most (Clear all: each store in turn, so each its own time).
const CLEAR_MS = 3 * 60 * 1000;

const DONE = new Set(['cleared', 'empty', 'busy', 'failed', 'expired']);

const STATUS_TEXT = {
  queued: 'Waiting for your checkout browser', sent: 'Opening the bag', clearing: 'Emptying the bag',
  cleared: 'Emptied', empty: 'Already empty', busy: 'Left alone', failed: "Couldn't empty it", expired: "Didn't start",
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class Bags {
  constructor(ctx) {
    this.ctx = ctx;
    Object.assign(this, { repo: ctx.repo, hub: ctx.hub, retailers: ctx.retailers, cfg: ctx.cfg });
    this.now = ctx.now || (() => Date.now());
    this.jobs = new Map(); // userId → Map(store → job): requests still on their way
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.expire(), 30 * 1000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** The stores whose bag can be emptied: those Mugibot checks out at (the dummy store's copies too, when it's on). */
  storeList() {
    return this.retailers.list.filter((r) => r.flow && this.retailers.enabled(r) && (!r.demo || this.cfg.demoStoreUrl));
  }

  /** The store's bag page: its flow's bag.url, else /cart under the store's own address. */
  bagUrl(r) {
    const b = r.flow && r.flow.bag;
    return `${r.base}${(b && b.url) || '/cart'}`;
  }

  saved(userId) {
    return this.repo.getData(userId, 'bags', {}) || {};
  }

  /** Each store's bag, for the dashboard: emptying now, or how it went last time. */
  list(userId) {
    this.expire();
    const mine = this.jobs.get(userId) || new Map();
    const saved = this.saved(userId);
    return this.storeList().map((r) => {
      const job = mine.get(r.id);
      const last = saved[r.id] || null;
      const now = job || last;
      return {
        id: r.id, name: r.name, demo: !!r.demo,
        status: now ? now.status : null, statusText: now ? STATUS_TEXT[now.status] || now.status : '',
        active: !!job, removed: now ? now.removed || 0 : 0, message: now ? now.message || '' : '',
        at: job ? job.updatedAt : last ? last.at : null, device: now ? now.device || '' : '',
      };
    });
  }

  /**
   * Clear cart (one store), or Clear all ('all'): the member's checkout browser empties those bags.
   * { jobs, device, listening } — or { error } saying why not.
   */
  clear(userId, stores) {
    this.expire();
    const user = this.repo.userById(userId);
    if (!user || user.disabled) return { error: 'Your account is suspended — contact support.' };
    if (!entitlement(user, this.now()).active) return { error: `Clear cart needs an active membership: ${this.cfg.baseUrl}/app#membership` };
    const aco = this.ctx.aco;
    const device = aco.checkoutDevice(userId);
    if (!device) return { error: `No browser with the ${this.cfg.appName} extension is connected yet — connect the one on your computer (Extension tab), and its bags are emptied there.` };
    if (olderVersion(device.version, BAGS_EXTENSION_VERSION)) {
      return { error: `Clear cart needs the extension ${BAGS_EXTENSION_VERSION} or newer in ${device.name}${device.version ? ` (it has ${device.version})` : ''} — update it there from the Extension tab.` };
    }
    const all = this.storeList();
    const list = stores === 'all' ? all : all.filter((r) => (Array.isArray(stores) ? stores : [stores]).includes(r.id));
    if (!list.length) return { error: "That store isn't one Mugibot checks out at." };
    let mine = this.jobs.get(userId);
    if (!mine) this.jobs.set(userId, (mine = new Map()));
    const now = this.now();
    for (const r of list) {
      if (mine.has(r.id)) continue; // (already on its way)
      mine.set(r.id, { id: newId('bag'), store: r.id, storeName: r.name, url: this.bagUrl(r), status: 'queued', removed: 0, message: '', device: device.name, deviceId: device.id, at: now, updatedAt: now, sentAt: 0 });
    }
    this.repo.addEvent(userId, { type: 'aco', level: 'info', message: `🧹 Clear cart: ${list.length === 1 ? `your ${list[0].name} bag` : `your bags at ${plural(list.length, 'store')}`} — emptied in ${device.name}` });
    aco.wake(userId); // (a checkout browser waiting for runs hears now)
    this.publish(userId);
    return { jobs: this.list(userId).filter((s) => s.active), device: { id: device.id, name: device.name }, listening: aco.isListening(device.id) };
  }

  /** Bags for this browser to empty now (the checkout browser only), each handed over once — again if it went quiet. */
  forBrowser(user, device) {
    const mine = this.jobs.get(user.id);
    if (!mine || !mine.size) return [];
    const checkout = this.ctx.aco.checkoutDevice(user.id);
    if (!checkout || checkout.id !== device.id) return [];
    const now = this.now();
    const out = [];
    // (In the stores' order: Clear all goes through them one after another.)
    const order = this.storeList().map((r) => r.id);
    for (const job of [...mine.values()].sort((a, b) => order.indexOf(a.store) - order.indexOf(b.store))) {
      const quiet = job.status !== 'queued' && now - job.updatedAt > RESEND_MS;
      if (job.status !== 'queued' && !quiet) continue;
      Object.assign(job, { status: 'sent', sentAt: now, updatedAt: now, device: device.name, deviceId: device.id });
      out.push({ id: job.id, store: job.store, storeName: job.storeName, url: job.url });
    }
    if (out.length) this.publish(user.id);
    return out;
  }

  /**
   * How many bags this browser has to empty, handed over or not: it keeps asking while there are any
   * (/api/ext/items, /api/ext/aco/next) — a request waiting its turn in it is handed over again now and
   * then, so it never looks lost.
   */
  activeFor(user, device) {
    const mine = this.jobs.get(user.id);
    if (!mine || !mine.size) return 0;
    const checkout = this.ctx.aco.checkoutDevice(user.id);
    return checkout && checkout.id === device.id ? mine.size : 0;
  }

  /**
   * How it's going, from the browser: 'clearing' (removed: how many so far), or how it ended — 'cleared'
   * (removed: how many things), 'empty' (nothing in it), 'busy' (a checkout of theirs is going there: left
   * alone) or 'failed' (message: why).
   */
  report(userId, jobId, { status, removed = 0, message = '' }) {
    const mine = this.jobs.get(userId);
    const job = mine && [...mine.values()].find((j) => j.id === jobId);
    if (!job) return null;
    const now = this.now();
    const n = Math.max(0, Math.min(500, Math.round(Number(removed) || 0)));
    if (status === 'clearing') {
      Object.assign(job, { status: 'clearing', removed: Math.max(job.removed, n), message: String(message || '').slice(0, 300), updatedAt: now });
      this.publish(userId);
      return { ...job };
    }
    if (!DONE.has(status) || status === 'expired') return null;
    return this.finish(userId, job, status, n, message);
  }

  finish(userId, job, status, removed, message) {
    const now = this.now();
    const text = String(message || '').slice(0, 300) || (status === 'cleared' ? `${plural(removed, 'item')} removed` : status === 'empty' ? 'Nothing was in it' : '');
    const mine = this.jobs.get(userId);
    if (mine) {
      mine.delete(job.store);
      if (!mine.size) this.jobs.delete(userId);
    }
    const saved = this.saved(userId);
    saved[job.store] = { status, removed, message: text, at: now, device: job.device };
    this.repo.setData(userId, 'bags', saved);
    // (The activity feed: what was taken out, and what couldn't be — "already empty" and "left alone" show on the card.)
    if (status === 'cleared') this.repo.addEvent(userId, { type: 'aco', level: 'info', message: `🧹 Emptied your ${job.storeName} bag — ${plural(removed, 'item')} removed` });
    if (status === 'failed' || status === 'expired') this.repo.addEvent(userId, { type: 'aco', level: 'warn', message: `🧹 Couldn't empty your ${job.storeName} bag: ${text}` });
    this.publish(userId);
    return { ...job, status, removed, message: text };
  }

  /** Requests no browser picked up, or that never finished. */
  expire() {
    const now = this.now();
    for (const [userId, mine] of [...this.jobs]) {
      for (const job of [...mine.values()]) {
        if (job.status === 'queued' && now - job.at > PICKUP_MS) {
          this.finish(userId, job, 'expired', 0, `${job.device} didn't pick it up — is it open, with the extension connected?`);
        } else if (job.status !== 'queued' && now - job.updatedAt > CLEAR_MS) {
          this.finish(userId, job, 'failed', job.removed, `Lost touch with ${job.device} while it emptied the bag — is it still open?`);
        }
      }
    }
  }

  publish(userId) {
    this.hub.publish(userId, 'bags', {});
  }
}
