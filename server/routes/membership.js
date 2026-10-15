// Membership (Whop): subscribe, manage, link a membership bought on Whop,
// and Whop's webhook.

import { entitlement } from '../entitlement.js';
import { HttpError, str } from '../schema.js';

export function register(router, ctx) {
  const { whop, repo, cfg, limiter } = ctx;

  router.get('/api/membership', async (req) => {
    const row = repo.membershipById(req.user.whop_membership_id);
    return {
      configured: whop.configured,
      checkout: whop.configured || !!cfg.whop.checkoutUrl,
      canClaim: whop.apiReady,
      price: cfg.priceDisplay,
      entitlement: entitlement(req.user, repo.now()),
      membership: row ? { id: row.id, status: row.status, renewsAt: row.renewal_period_end, cancelAtPeriodEnd: !!row.cancel_at_period_end, whopUsername: row.whop_username } : null,
    };
  });

  router.post('/api/membership/checkout', async (req) => ({ url: await whop.checkoutUrl(req.user) }));

  router.post('/api/membership/manage', async (req) => {
    if (!req.user.whop_membership_id) throw new HttpError(400, "You don't have a Whop membership linked yet");
    return { url: await whop.manageUrl(req.user) };
  });

  router.post('/api/membership/claim', async (req) => {
    if (!limiter.hit(`claim-whop:${req.user.id}`, 10, 60 * 60 * 1000)) throw new HttpError(429, 'Too many attempts — try again later');
    const out = await whop.claim(req.user, str(req.body.membership, 100));
    return { ok: true, plan: repo.userById(req.user.id).plan, ...out };
  });

  router.post('/api/membership/sync', async (req) => {
    if (!limiter.hit(`sync-whop:${req.user.id}`, 10, 10 * 60 * 1000)) throw new HttpError(429, 'Try again in a few minutes');
    await whop.syncUser(req.user);
    return { entitlement: entitlement(repo.userById(req.user.id), repo.now()) };
  });

  router.post('/api/whop/webhook', async (req) => whop.handleWebhook(req.rawBody, req.headers), { auth: 'none', csrf: false, raw: true });
}
