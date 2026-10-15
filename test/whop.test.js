// Memberships through Whop: checkout links carrying the account ID, signed
// webhooks (and forged, stale and repeated ones), payment failures,
// cancellation, buying on Whop first and linking it, other products, free
// access, and the Discord role following the membership.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, PASSWORD, discordOpts, startApp, startFakeDiscord, startFakeWhop, whopOpts, whopWebhook } from './helpers.js';

let env;
let whop;
let discord;
before(async () => {
  whop = await startFakeWhop();
  discord = await startFakeDiscord();
  env = await startApp({ ...whopOpts(whop), ...discordOpts(discord) });
});
after(async () => {
  await env.close();
  await whop.close();
  await discord.close();
});

async function connectDiscord(c, discordId) {
  discord.state.users[discordId] = discord.state.users[discordId] || { id: discordId, username: discordId };
  discord.state.nextUser = discordId;
  const start = await c.get('/auth/discord');
  const consent = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = new URL(consent.headers.get('location'));
  return c.get(cb.pathname + cb.search);
}

const plan = (c) => env.app.repo.userById(c.user.id).plan;

test('subscribe: Whop checkout link made for this account (plan, metadata, way back)', async () => {
  const c = await Client.signup(env.url, 'ash');
  const r = await c.post('/api/membership/checkout');
  assert.equal(r.status, 200, r.text);
  assert.match(r.body.url, /^https:\/\/whop\.test\/checkout\/ch_\d+\/$/);
  const conf = whop.state.checkouts.at(-1);
  assert.equal(conf.mode, 'payment');
  assert.equal(conf.plan_id, 'plan_monthly');
  assert.equal(conf.metadata.mugibot_user_id, c.user.id);
  assert.equal(conf.metadata.mugibot_username, 'ash');
  assert.equal(conf.redirect_url, `${env.url}/app?membership=success#membership`);
  const m = await c.get('/api/membership');
  assert.equal(m.body.configured, true);
  assert.equal(m.body.entitlement.active, false);
});

test('membership.activated webhook → member, Discord role given; payment failed → past due; cancelled → role taken away', async () => {
  const c = await Client.signup(env.url, 'misty');
  await connectDiscord(c, 'd-misty');
  assert.equal(discord.state.members.has('d-misty'), false, 'not in the server before paying');
  assert.equal((await c.get('/api/discord')).body.inServer, false);

  whop.membership('mem_misty', { metadata: { mugibot_user_id: c.user.id } });
  const r = await whopWebhook(env.url, 'membership.activated', { id: 'mem_misty', status: 'active' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.linked, true);
  assert.equal(plan(c), 'active');
  const me = (await c.get('/api/me')).body;
  assert.equal(me.entitlement.active, true);
  assert.equal(me.entitlement.label, 'Member');
  assert.equal(discord.state.members.has('d-misty'), true, 'added to the server');
  assert.ok(discord.state.members.get('d-misty').has('role-member'), 'with the member role');
  assert.ok(discord.dmsTo('d-misty').some((m) => /Membership active/.test(JSON.stringify(m.body))), 'welcome DM');
  assert.equal(env.app.repo.userById(c.user.id).whop_membership_id, 'mem_misty');
  assert.ok((await c.get('/api/membership')).body.membership.renewsAt > Date.now());
  assert.equal((await c.post('/api/membership/manage')).body.url, 'https://whop.test/manage/mem_misty');

  // Payment fails: still has access, with a warning.
  whop.membership('mem_misty', { status: 'past_due' });
  await whopWebhook(env.url, 'payment.failed', { id: 'pay_1', membership: { id: 'mem_misty' } });
  assert.equal(plan(c), 'past_due');
  assert.equal((await c.get('/api/me')).body.entitlement.active, true);
  assert.ok(discord.state.members.get('d-misty').has('role-member'), 'keeps the role while Whop retries');

  // Cancelled and the period ended.
  whop.membership('mem_misty', { status: 'canceled' });
  await whopWebhook(env.url, 'membership.updated', { id: 'mem_misty', status: 'canceled' });
  assert.equal(plan(c), 'canceled');
  assert.equal((await c.get('/api/me')).body.entitlement.active, false);
  assert.equal(discord.state.members.get('d-misty').has('role-member'), false, 'member role taken away');
  assert.equal(discord.state.members.has('d-misty'), true, 'not kicked unless DISCORD_KICK_ON_EXPIRE=1');

  // Comes back.
  whop.membership('mem_misty', { status: 'active' });
  await whopWebhook(env.url, 'membership.activated', { id: 'mem_misty' });
  assert.equal(plan(c), 'active');
  assert.ok(discord.state.members.get('d-misty').has('role-member'), 'role back');
});

test('webhooks: forged, stale, repeated and other-product events change nothing', async () => {
  const c = await Client.signup(env.url, 'brock');
  whop.membership('mem_brock', { metadata: { mugibot_user_id: c.user.id } });
  assert.equal((await whopWebhook(env.url, 'membership.activated', { id: 'mem_brock' }, { secret: 'ws_wrong' })).status, 400, 'bad signature');
  assert.equal((await whopWebhook(env.url, 'membership.activated', { id: 'mem_brock' }, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status, 400, 'too old');
  const unsigned = await fetch(`${env.url}/api/whop/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'membership.activated', data: { id: 'mem_brock' } }) });
  assert.equal(unsigned.status, 400);
  assert.equal(plan(c), 'none');

  const first = await whopWebhook(env.url, 'membership.activated', { id: 'mem_brock' }, { id: 'msg_repeat' });
  assert.equal(first.status, 200);
  assert.equal(plan(c), 'active');
  env.app.repo.updateUser(c.user.id, { plan: 'none' });
  const again = await whopWebhook(env.url, 'membership.activated', { id: 'mem_brock' }, { id: 'msg_repeat' });
  assert.deepEqual(again.body, { duplicate: true }, 'delivered twice, handled once');
  assert.equal(plan(c), 'none');

  // Another product of yours on Whop: not a Mugibot membership.
  const other = await Client.signup(env.url, 'gary');
  whop.membership('mem_other', { product: { id: 'prod_something_else' }, metadata: { mugibot_user_id: other.user.id } });
  const r = await whopWebhook(env.url, 'membership.activated', { id: 'mem_other' });
  assert.equal(r.body.skipped, 'another product');
  assert.equal(plan(other), 'none');
});

test('bought on Whop first: waits unlinked, then the member links it with their license key (once, one account)', async () => {
  whop.membership('mem_walkin', { metadata: null, user: { id: 'user_walkin', username: 'walkin', email: 'walkin@buyer.example' } });
  const r = await whopWebhook(env.url, 'membership.activated', { id: 'mem_walkin' });
  assert.equal(r.body.linked, false);
  const row = env.app.repo.membershipById('mem_walkin');
  assert.equal(row.user_id, null);
  assert.equal(row.whop_username, 'walkin');

  const c = await Client.signup(env.url, 'walkin');
  assert.equal((await c.post('/api/membership/claim', { membership: 'nope-not-real' })).status, 404);
  const claim = await c.post('/api/membership/claim', { membership: 'LIC-mem_walkin' });
  assert.equal(claim.status, 200, claim.text);
  assert.equal(claim.body.plan, 'active');
  assert.equal(env.app.repo.membershipById('mem_walkin').user_id, c.user.id);

  const thief = await Client.signup(env.url, 'thief');
  assert.equal((await thief.post('/api/membership/claim', { membership: 'mem_walkin' })).status, 409, 'already linked to another account');
  assert.equal(plan(thief), 'none');

  // Renewals keep coming to the right account without metadata.
  whop.membership('mem_walkin', { status: 'expired' });
  await whopWebhook(env.url, 'membership.updated', { id: 'mem_walkin' });
  assert.equal(plan(c), 'canceled');
});

test('an admin can link a membership; free access is not taken away by a lapsed membership', async () => {
  const boss = await Client.signup(env.url, 'boss');
  env.app.repo.updateUser(boss.user.id, { role: 'admin' });
  const c = await Client.signup(env.url, 'erika');
  whop.membership('mem_erika', { metadata: null });
  const r = await boss.post(`/api/admin/users/${c.user.id}/whop-link`, { membership: 'mem_erika' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.plan, 'active');

  await boss.put(`/api/admin/users/${c.user.id}`, { plan: 'comped' });
  whop.membership('mem_erika', { status: 'canceled' });
  await whopWebhook(env.url, 'membership.updated', { id: 'mem_erika' });
  assert.equal(plan(c), 'comped', 'free access stays');
  assert.ok(env.app.repo.listAudit().some((a) => a.action === 'whop-link'));
});

test('missed webhook: memberships past their renewal date are re-checked with Whop', async () => {
  const c = await Client.signup(env.url, 'sabrina');
  whop.membership('mem_sabrina', { metadata: { mugibot_user_id: c.user.id } });
  await whopWebhook(env.url, 'membership.activated', { id: 'mem_sabrina' });
  assert.equal(plan(c), 'active');
  // Whop ended it, but the webhook never arrived.
  whop.membership('mem_sabrina', { status: 'expired' });
  env.app.repo.updateUser(c.user.id, { current_period_end: Date.now() - 5 * 3600 * 1000 });
  const n = await env.app.whop.reconcile();
  assert.ok(n >= 1);
  assert.equal(plan(c), 'canceled');
});

test('deleting your account cancels your Whop membership straight away', async () => {
  const c = await Client.signup(env.url, 'koga');
  whop.membership('mem_koga', { metadata: { mugibot_user_id: c.user.id } });
  await whopWebhook(env.url, 'membership.activated', { id: 'mem_koga' });
  assert.equal((await c.post('/api/me/delete', { password: PASSWORD })).status, 200);
  const cancel = whop.calls.find((x) => x.path === '/memberships/mem_koga/cancel');
  assert.ok(cancel, 'cancel called');
  assert.equal(cancel.body.cancellation_mode, 'immediate');
  assert.equal(whop.state.memberships.get('mem_koga').status, 'canceled');
});

test('without the API key: the signed webhook payload is used, and a fallback checkout link works', async () => {
  const lite = await startApp({ whopWebhookSecret: 'ws_test_secret_123', whopCheckoutUrl: 'https://whop.com/mugibot-store/membership/' });
  try {
    const c = await Client.signup(lite.url, 'lite');
    assert.equal((await c.post('/api/membership/checkout')).body.url, 'https://whop.com/mugibot-store/membership/');
    const r = await whopWebhook(lite.url, 'membership.activated', { id: 'mem_lite', status: 'active', metadata: { mugibot_user_id: c.user.id }, product: { id: 'prod_any' }, plan: { id: 'plan_any' }, renewal_period_end: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(lite.app.repo.userById(c.user.id).plan, 'active');
    assert.equal((await c.post('/api/membership/claim', { membership: 'mem_xyz123' })).status, 503, 'linking needs the API key');
  } finally {
    await lite.close();
  }
});
