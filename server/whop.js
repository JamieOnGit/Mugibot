// Memberships through Whop (A$19.99 / month by default).
//
// * Subscribe: Mugibot asks Whop for a checkout link that carries the
//   member's account ID (checkout configuration "metadata"), so the payment
//   is matched to the right login automatically.
// * Bought on Whop directly? The member pastes their membership ID
//   (mem_…) or license key under Membership, and Mugibot checks it with Whop.
// * Webhooks (Standard Webhooks signatures) keep each account's membership
//   up to date: activated, renewed, payment failed, cancelled, expired.
//   Mugibot re-reads the membership from Whop's API on every webhook, so
//   events arriving late or out of order can't leave someone with the wrong
//   access.
// * Card payments for memberships are handled entirely by Whop.

import crypto from 'node:crypto';
import { whopConfigured } from './config.js';
import { HttpError } from './schema.js';

// Whop membership status → Mugibot plan.
const PLAN_FOR = {
  active: 'active', trialing: 'active', canceling: 'active',
  past_due: 'past_due', unresolved: 'past_due',
  completed: 'canceled', canceled: 'canceled', expired: 'canceled',
};
export const ACTIVE_STATUSES = new Set(['active', 'trialing', 'canceling', 'past_due', 'unresolved']);

const toMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** Standard Webhooks: base64(HMAC-SHA256(key, "<id>.<timestamp>.<body>")), header "v1,<sig> v1,<sig>…". */
export function signWebhook(secret, id, timestamp, body) {
  return crypto.createHmac('sha256', webhookKeys(secret)[0]).update(`${id}.${timestamp}.`).update(body).digest('base64');
}

/** Whop signs with the whole "ws_…" secret; a "whsec_<base64>" secret (the Standard Webhooks default) is base64-decoded. */
function webhookKeys(secret) {
  const keys = [Buffer.from(String(secret), 'utf8')];
  const m = String(secret).match(/^whsec_(.+)$/);
  if (m) keys.unshift(Buffer.from(m[1], 'base64'));
  return keys;
}

export class Whop {
  constructor({ cfg, repo, notifier, discord, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { cfg, repo, notifier, discord, fetch: fetchImpl, now });
    this.w = cfg.whop;
  }

  /** The API key and plan are set: checkout links are made per member and memberships can be checked. */
  get configured() {
    return whopConfigured(this.cfg);
  }

  get apiReady() {
    return !!this.w.apiKey;
  }

  async api(method, path, body) {
    if (!this.apiReady) throw new HttpError(503, 'Whop is not set up on this server yet');
    let res;
    try {
      res = await this.fetch(`${this.w.apiBase}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.w.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new HttpError(502, "Couldn't reach Whop — please try again in a minute");
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) return null;
    if (!res.ok) {
      this.cfg.log(`[whop] ${method} ${path} failed: HTTP ${res.status} ${(data && (data.message || (data.error && data.error.message))) || ''}`);
      throw new HttpError(502, "Whop didn't accept that — please try again, or contact support");
    }
    return data;
  }

  // -------------------------------------------------------------------------
  // Subscribing and managing
  // -------------------------------------------------------------------------
  /** Where this member goes to pay. */
  async checkoutUrl(user) {
    if (this.configured) {
      const conf = await this.api('POST', '/checkout_configurations', {
        mode: 'payment',
        plan_id: this.w.planId,
        metadata: { mugibot_user_id: user.id, mugibot_username: user.username },
        redirect_url: `${this.cfg.baseUrl}/app?membership=success#membership`,
      });
      if (!conf || !conf.purchase_url) throw new HttpError(502, "Whop didn't send a checkout link — please try again");
      return conf.purchase_url;
    }
    if (this.w.checkoutUrl) return this.w.checkoutUrl;
    throw new HttpError(503, 'Memberships are not set up yet — ask an admin');
  }

  /** Whop's page for managing (or cancelling) this member's membership. */
  async manageUrl(user) {
    const row = this.repo.membershipById(user.whop_membership_id);
    if (row && row.manage_url) return row.manage_url;
    if (user.whop_membership_id && this.apiReady) {
      const m = await this.api('GET', `/memberships/${encodeURIComponent(user.whop_membership_id)}`);
      if (m && m.manage_url) return m.manage_url;
    }
    return 'https://whop.com/';
  }

  /** Cancel straight away (account deleted, or an admin deleting the account). */
  async cancelNow(user) {
    if (!this.apiReady || !user.whop_membership_id) return;
    await this.api('POST', `/memberships/${encodeURIComponent(user.whop_membership_id)}/cancel`, { cancellation_mode: 'immediate' });
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------
  verify(raw, headers, toleranceSec = 300) {
    const secret = this.w.webhookSecret;
    if (!secret) throw new HttpError(503, 'Webhook secret is not set (WHOP_WEBHOOK_SECRET)');
    const id = String(headers['webhook-id'] || '');
    const ts = String(headers['webhook-timestamp'] || '');
    const sigHeader = String(headers['webhook-signature'] || '');
    if (!id || !/^\d+$/.test(ts) || !sigHeader) throw new HttpError(400, 'Missing signature');
    if (Math.abs(this.now() / 1000 - Number(ts)) > toleranceSec) throw new HttpError(400, 'Signature is too old');
    const sigs = sigHeader.split(' ').map((s) => s.split(',')).filter(([v, s]) => v === 'v1' && s).map(([, s]) => Buffer.from(s));
    for (const key of webhookKeys(secret)) {
      const expected = Buffer.from(crypto.createHmac('sha256', key).update(`${id}.${ts}.`).update(raw).digest('base64'));
      if (sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(s, expected))) return id;
    }
    throw new HttpError(400, 'Bad signature');
  }

  async handleWebhook(raw, headers) {
    const id = this.verify(raw, headers);
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Bad JSON'); }
    const type = String((event && (event.type || event.action)) || '');
    if (!type) throw new HttpError(400, 'Not a Whop event');
    if (!this.repo.markWebhook(id, 'whop', type)) return { duplicate: true };
    const data = event.data || {};
    if (!/^(membership|payment)\./.test(type)) return { ignored: type };
    // The membership this is about: the object itself, or the payment's membership.
    const membershipId = String(data.id || '').startsWith('mem_') ? data.id : data.membership_id || (data.membership && (data.membership.id || data.membership)) || null;
    if (!membershipId || typeof membershipId !== 'string') return { ignored: type };
    let m = this.apiReady ? await this.api('GET', `/memberships/${encodeURIComponent(membershipId)}`) : null;
    if (!m && String(data.id || '').startsWith('mem_')) {
      // No API key: trust the signed payload (legacy "went_valid / went_invalid" events say it directly).
      m = { ...data };
      if (/went_valid/.test(type) && !m.status) m.status = 'active';
      if (/went_invalid|deactivated/.test(type) && !ACTIVE_STATUSES.has(m.status)) m.status = m.status || 'expired';
    }
    if (!m) return { ignored: type };
    const out = await this.applyMembership(m);
    return { received: true, ...out };
  }

  // -------------------------------------------------------------------------
  // A membership → an account's plan
  // -------------------------------------------------------------------------
  isOurs(m) {
    const product = m.product && (m.product.id || m.product);
    const plan = m.plan && (m.plan.id || m.plan);
    if (this.w.productId) return product === this.w.productId;
    if (this.w.planId) return plan === this.w.planId;
    return true;
  }

  /**
   * Save what Whop says about a membership and update the linked account.
   * forUserId: link it to this account (a member claiming it).
   */
  async applyMembership(m, { forUserId = null } = {}) {
    if (!m || !m.id) return { skipped: 'no membership' };
    if (!this.isOurs(m)) return { skipped: 'another product' };
    const status = String(m.status || 'expired');
    const existing = this.repo.membershipById(m.id);
    const metaUserId = (m.metadata && (m.metadata.mugibot_user_id || m.metadata.user_id)) || null;
    let user = null;
    if (existing && existing.user_id) user = this.repo.userById(existing.user_id);
    if (!user) user = this.repo.userByWhopMembership(m.id);
    if (!user && forUserId) user = this.repo.userById(forUserId);
    if (!user && metaUserId) {
      const candidate = this.repo.userById(metaUserId);
      // Don't let a stale membership take over an account that already has a live one.
      const current = candidate && candidate.whop_membership_id && this.repo.membershipById(candidate.whop_membership_id);
      if (candidate && (!current || !ACTIVE_STATUSES.has(current.status) || current.id === m.id)) user = candidate;
    }
    if (forUserId && user && user.id !== forUserId) throw new HttpError(409, 'That Whop membership is already linked to another Mugibot account — contact support');

    const row = this.repo.upsertMembership({
      id: m.id,
      user_id: user ? user.id : null,
      status,
      whop_user_id: (m.user && m.user.id) || null,
      whop_username: (m.user && m.user.username) || null,
      email: (m.user && m.user.email) || null,
      product_id: (m.product && (m.product.id || m.product)) || null,
      plan_id: (m.plan && (m.plan.id || m.plan)) || null,
      renewal_period_end: toMs(m.renewal_period_end),
      cancel_at_period_end: m.cancel_at_period_end ? 1 : 0,
      manage_url: m.manage_url || null,
      metadata_user_id: metaUserId,
    });
    if (!user) return { linked: false, membership: row.id };

    // Another live membership on this account wins over this one ending.
    const plan = PLAN_FOR[status];
    const current = user.whop_membership_id && user.whop_membership_id !== m.id ? this.repo.membershipById(user.whop_membership_id) : null;
    if (current && ACTIVE_STATUSES.has(current.status) && !ACTIVE_STATUSES.has(status)) return { linked: true, user: user.id, unchanged: true };
    const fields = {
      whop_membership_id: m.id,
      whop_user_id: row.whop_user_id,
      current_period_end: row.renewal_period_end,
      cancel_at_period_end: row.cancel_at_period_end,
    };
    // Free access given by an admin isn't taken away by a lapsed membership.
    if (plan && !(user.plan === 'comped' && plan !== 'active')) fields.plan = plan;
    const before = user.plan;
    const updated = this.repo.updateUser(user.id, fields);
    if (fields.plan && fields.plan !== before) {
      const msg = {
        active: `Membership active — welcome to ${this.cfg.appName}! Monitoring, Discord pings and ⚡ Buy are on.`,
        past_due: 'Your last membership payment failed — update your card on Whop to keep access.',
        canceled: 'Your membership has ended. Your watchlist and details are kept if you come back.',
      }[fields.plan];
      await this.notifier.notify(user.id, { type: 'billing', level: fields.plan === 'active' ? 'success' : 'warn', title: 'Membership', message: msg, channel: 'account' });
    }
    await this.discord.sync(updated).catch((e) => this.cfg.log('[whop] discord sync failed', e.message));
    return { linked: true, user: user.id, plan: updated.plan };
  }

  /** A member says "this Whop membership is mine" (membership ID or license key). */
  async claim(user, idOrKey) {
    const key = String(idOrKey || '').trim();
    if (!/^[\w-]{6,80}$/.test(key)) throw new HttpError(400, 'Paste your Whop membership ID (mem_…) or license key');
    if (!this.apiReady) throw new HttpError(503, 'Linking a Whop membership needs the Whop API key on this server — ask an admin to link it for you');
    const m = await this.api('GET', `/memberships/${encodeURIComponent(key)}`);
    if (!m || !m.id) throw new HttpError(404, "Whop doesn't know that membership — check the ID or license key");
    if (!this.isOurs(m)) throw new HttpError(400, `That membership isn't for ${this.cfg.appName}`);
    const row = this.repo.membershipById(m.id);
    if (row && row.user_id && row.user_id !== user.id) throw new HttpError(409, 'That Whop membership is already linked to another Mugibot account — contact support');
    const other = this.repo.userByWhopMembership(m.id);
    if (other && other.id !== user.id) throw new HttpError(409, 'That Whop membership is already linked to another Mugibot account — contact support');
    const out = await this.applyMembership(m, { forUserId: user.id });
    this.repo.addEvent(user.id, { type: 'billing', level: 'info', message: `Whop membership ${m.id} linked (${m.status}).` });
    return out;
  }

  /** Re-read this account's membership from Whop. */
  async syncUser(user) {
    if (!this.apiReady || !user.whop_membership_id) return { skipped: true };
    const m = await this.api('GET', `/memberships/${encodeURIComponent(user.whop_membership_id)}`);
    if (!m) return { skipped: 'not found' };
    return this.applyMembership(m);
  }

  /** Catch anything a missed webhook left behind: memberships past their renewal date. */
  async reconcile(limit = 25) {
    if (!this.apiReady) return 0;
    const rows = this.repo.db.all(`SELECT * FROM users WHERE whop_membership_id IS NOT NULL AND plan IN ('active', 'past_due')
      AND current_period_end IS NOT NULL AND current_period_end < :t LIMIT :l`, { t: this.now() - 2 * 60 * 60 * 1000, l: limit });
    for (const u of rows) await this.syncUser(u).catch((e) => this.cfg.log('[whop] re-check failed', e.message));
    return rows.length;
  }

  /** For the admin page. */
  status() {
    const last = this.repo.lastWebhook('whop');
    return {
      apiKey: !!this.w.apiKey,
      webhookSecret: !!this.w.webhookSecret,
      planId: this.w.planId || null,
      productId: this.w.productId || null,
      checkoutUrl: this.w.checkoutUrl || null,
      webhookUrl: `${this.cfg.baseUrl}/api/whop/webhook`,
      lastWebhookAt: last ? last.received_at : null,
      lastWebhookType: last ? last.type : null,
    };
  }
}
