// Accounts: username + password sign-up and log-in, sessions, cross-site
// protection, rate limits, password reset (email, Discord DM, admin link),
// password change, account deletion and data export.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client, PASSWORD, discordOpts, startApp, startFakeDiscord } from './helpers.js';
import { STARTER_ITEMS } from '../server/presets.js';

let env;
let discord;
before(async () => {
  discord = await startFakeDiscord();
  env = await startApp({ adminUsernames: 'boss', ...discordOpts(discord) });
});
after(async () => {
  await env.close();
  await discord.close();
});

test('sign up with a username and password: signed in, not a member yet, own starter watchlist', async () => {
  const c = new Client(env.url);
  const r = await c.post('/api/auth/signup', { username: 'Ash.Ketchum', password: PASSWORD, acceptTerms: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.user.username, 'ash.ketchum', 'usernames are stored lower-case');
  assert.equal(r.body.user.email, '', 'email is optional');
  const cookie = r.headers.getSetCookie()[0];
  assert.match(cookie, /^mgb_session=[\w-]{40,};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.entitlement.active, false, 'no free trial by default');
  assert.equal(me.body.entitlement.label, 'Not a member yet');
  assert.match(me.body.app.price, /A\$19\.99/);
  const items = (await c.get('/api/items')).body.items;
  assert.deepEqual(items.map((p) => p.sku), STARTER_ITEMS.map((p) => p.sku));
  assert.equal(items[0].storeName, 'Kmart');
  assert.equal(items[0].flowStatus, 'verified');
  assert.equal((await c.post(`/api/items/${items[0].id}/go`, {})).status, 402, '⚡ Buy needs a membership');
});

test('sign-up checks: terms, weak password, bad or reserved usernames, duplicates, optional email', async () => {
  const c = new Client(env.url);
  assert.equal((await c.post('/api/auth/signup', { username: 'brock', password: PASSWORD })).status, 400, 'must accept terms');
  assert.equal((await c.post('/api/auth/signup', { username: 'brock', password: 'short', acceptTerms: true })).status, 400);
  for (const bad of ['ab', 'has space', '-dash', 'x'.repeat(25), 'emoji😀', 'admin', 'mugibot']) {
    assert.equal((await c.post('/api/auth/signup', { username: bad, password: PASSWORD, acceptTerms: true })).status, 400, bad);
  }
  assert.equal((await c.post('/api/auth/signup', { username: 'ASH.ketchum', password: PASSWORD, acceptTerms: true })).status, 409, 'taken (any case)');
  assert.equal((await c.post('/api/auth/signup', { username: 'brock', password: PASSWORD, email: 'not-an-email', acceptTerms: true })).status, 400);
  const ok = await new Client(env.url).post('/api/auth/signup', { username: 'brock', password: PASSWORD, email: 'Brock@Example.com', acceptTerms: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, 'brock@example.com');
  const dupEmail = await new Client(env.url).post('/api/auth/signup', { username: 'brock2', password: PASSWORD, email: 'brock@example.com', acceptTerms: true });
  assert.equal(dupEmail.status, 409);
});

test('log in with username (any case) or email, wrong password, log out', async () => {
  const c = new Client(env.url);
  assert.equal((await c.get('/api/me')).status, 401);
  const bad = await c.post('/api/auth/login', { username: 'ash.ketchum', password: 'wrong password!' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'Wrong username or password');
  const unknown = await c.post('/api/auth/login', { username: 'nobody', password: PASSWORD });
  assert.equal(unknown.body.error, 'Wrong username or password', 'same message whether or not the account exists');
  assert.equal((await c.post('/api/auth/login', { username: 'Ash.Ketchum', password: PASSWORD })).status, 200);
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await new Client(env.url).post('/api/auth/login', { username: 'BROCK@example.com', password: PASSWORD })).status, 200, 'the email on the account works too');
  const stolen = c.cookie;
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/me')).status, 401);
  const replay = new Client(env.url);
  replay.cookie = stolen;
  assert.equal((await replay.get('/api/me')).status, 401, 'a logged-out session is gone from the server');
});

test('sign-ups per network are limited', async () => {
  const limited = await startApp({ signupsPerHour: 2 });
  try {
    await Client.signup(limited.url, 'one');
    await Client.signup(limited.url, 'two');
    const r = await new Client(limited.url).post('/api/auth/signup', { username: 'three', password: PASSWORD, acceptTerms: true });
    assert.equal(r.status, 429);
  } finally {
    await limited.close();
  }
});

test('too many wrong passwords locks the username for a while', async () => {
  const c = await Client.signup(env.url, 'erika');
  const other = new Client(env.url);
  for (let i = 0; i < 10; i++) await other.post('/api/auth/login', { username: 'erika', password: `guess-${i}-xxxxx` });
  const r = await other.post('/api/auth/login', { username: 'erika', password: PASSWORD });
  assert.equal(r.status, 429);
  assert.equal((await c.get('/api/me')).status, 200, 'existing sessions keep working');
});

test('cross-site requests are refused (missing header or foreign Origin)', async () => {
  const c = await Client.signup(env.url, 'misty');
  const item = { url: 'https://www.kmart.com.au/product/x-43000001/' };
  assert.equal((await c.post('/api/items', item, { 'x-mugibot': '' })).status, 403);
  assert.equal((await c.post('/api/items', item, { origin: 'https://evil.example' })).status, 403);
  const ok = await c.post('/api/items', item);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sku, '43000001');
});

test('pages: dashboard needs a login; security headers are set', async () => {
  const anon = new Client(env.url);
  const r = await anon.get('/app');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login?next=%2Fapp');
  const buy = await anon.get('/buy/itm_abcdef?qty=2&t=x');
  assert.equal(buy.headers.get('location'), `/login?next=${encodeURIComponent('/buy/itm_abcdef?qty=2&t=x')}`, 'a ⚡ Buy link survives logging in');
  const home = await anon.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Mugibot/);
  assert.match(home.text, /A\$19\.99 \/ month/);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  const c = await Client.signup(env.url, 'gary');
  assert.equal((await c.get('/app')).status, 200);
  assert.equal((await c.get('/login')).status, 302, 'logged-in users skip the login page');
  assert.equal((await c.get('/admin')).status, 302, 'non-admins are sent back to the dashboard');
  assert.equal((await c.get('/api/admin/users')).status, 404, 'admin API is invisible to non-admins');
  assert.equal((await anon.get('/download/extension.zip')).status, 302, 'extension download needs an account');
  assert.equal((await anon.get('/api/items')).status, 401);
  assert.equal((await anon.get('/api/nope')).status, 404);
});

test('forgot password → link by email → new password; sessions and extensions signed out', async () => {
  const c = await Client.signup(env.url, 'sabrina', { email: 'sabrina@example.com' });
  const { body } = await c.post('/api/devices/pair-code');
  await fetch(`${env.url}/api/ext/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: body.code }) });
  assert.equal((await c.get('/api/devices')).body.devices.length, 1);

  const anon = new Client(env.url);
  const r = await anon.post('/api/auth/forgot', { username: 'sabrina' });
  assert.equal(r.status, 200);
  const unknown = await anon.post('/api/auth/forgot', { username: 'nobody-here' });
  assert.deepEqual(unknown.body, r.body, 'same answer for unknown accounts');
  const mail = env.outbox.find((m) => m.to === 'sabrina@example.com');
  assert.ok(mail, 'reset email sent');
  assert.match(mail.text, /"sabrina"/);
  const token = mail.text.match(/reset\?token=([\w-]+)/)[1];

  assert.equal((await anon.post('/api/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await anon.post('/api/auth/reset', { token, password: 'a brand new password' })).status, 200);
  assert.equal((await anon.get('/api/me')).status, 200, 'signed in after resetting');
  assert.equal((await anon.post('/api/auth/reset', { token, password: 'another new password' })).status, 400, 'links work once');
  assert.equal((await c.get('/api/me')).status, 401, 'other sessions signed out');
  assert.equal((await anon.get('/api/devices')).body.devices.length, 0, 'extensions disconnected');
  assert.equal((await new Client(env.url).post('/api/auth/login', { username: 'sabrina', password: 'a brand new password' })).status, 200);
});

test('forgot password with no email: the link goes by Discord DM to the connected account', async () => {
  const c = await Client.signup(env.url, 'koga');
  discord.state.users['d-koga'] = { id: 'd-koga', username: 'koga_ninja' };
  discord.state.nextUser = 'd-koga';
  // Connect Discord (the fake Discord sends straight back).
  const start = await c.get('/auth/discord');
  const consent = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const callback = new URL(consent.headers.get('location'));
  const done = await c.get(callback.pathname + callback.search);
  assert.match(done.headers.get('location'), /discord=linked/);
  const before = discord.dmsTo('d-koga').length;
  await new Client(env.url).post('/api/auth/forgot', { username: 'koga' });
  const dms = discord.dmsTo('d-koga').slice(before);
  assert.equal(dms.length, 1);
  assert.match(JSON.stringify(dms[0].body), /reset\?token=[\w-]+/);
});

test('change password keeps this session and signs out the others', async () => {
  const c = await Client.signup(env.url, 'blaine');
  const other = new Client(env.url);
  await other.post('/api/auth/login', { username: 'blaine', password: PASSWORD });
  assert.equal((await c.post('/api/me/password', { current: 'wrong', next: 'new password 123' })).status, 400);
  assert.equal((await c.post('/api/me/password', { current: PASSWORD, next: 'new password 123' })).status, 200);
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await other.get('/api/me')).status, 401);
});

test('ADMIN_USERNAMES become admins; set an email later; export and delete your own account', async () => {
  const boss = await Client.signup(env.url, 'boss');
  assert.equal(boss.user.role, 'admin');
  assert.equal((await boss.get('/admin')).status, 200);
  assert.equal((await boss.get('/api/me')).body.entitlement.label, 'Admin');

  const c = await Client.signup(env.url, 'giovanni');
  assert.equal((await c.put('/api/me', { email: 'gio@example.com', name: 'Gio' })).body.user.email, 'gio@example.com');
  assert.equal((await c.put('/api/me', { email: 'brock@example.com' })).status, 409, "someone else's email");
  await c.put('/api/profiles', { profiles: [{ label: 'Home', firstName: 'Gio', address1: '1 Viridian St', suburb: 'Viridian', state: 'NSW', postcode: '2000' }] });
  const exp = await c.get('/api/me/export');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /attachment/);
  const data = JSON.parse(exp.text);
  assert.equal(data.account.username, 'giovanni');
  assert.equal(data.deliveryDetails[0].firstName, 'Gio');
  assert.equal(data.watchlist.length, STARTER_ITEMS.length);

  const id = c.user.id;
  assert.equal((await c.post('/api/me/delete', { password: 'wrong' })).status, 400);
  assert.equal((await c.post('/api/me/delete', { password: PASSWORD })).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
  const db = env.app.db;
  for (const table of ['users', 'sessions', 'items', 'user_data', 'events', 'devices']) {
    const col = table === 'users' ? 'id' : 'user_id';
    assert.equal(db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = :id`, { id }).n, 0, `${table} emptied`);
  }
  assert.equal((await new Client(env.url).post('/api/auth/login', { username: 'giovanni', password: PASSWORD })).status, 401);
});

/** A request with our own Host header (fetch can't set it). */
function raw(method, path, headers, body) {
  const u = new URL(env.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('opened at another address for this server (localhost vs 127.0.0.1): sign-up works and the page says which address to use', async () => {
  const port = new URL(env.url).port;
  const other = `localhost:${port}`;
  const body = JSON.stringify({ username: 'otherhost', password: PASSWORD, acceptTerms: true });
  const ok = await raw('POST', '/api/auth/signup', { host: other, origin: `http://${other}`, 'x-mugibot': '1', 'content-type': 'application/json' }, body);
  assert.equal(ok.status, 200, ok.text);
  const evil = await raw('POST', '/api/auth/signup', { host: other, origin: 'http://evil.example', 'x-mugibot': '1', 'content-type': 'application/json' }, body);
  assert.equal(evil.status, 403, 'other websites are still blocked');
  const page = await raw('GET', '/signup?x=1', { host: other });
  assert.match(page.text, /class="host-warning"/);
  assert.ok(page.text.includes(`href="${env.url}/signup?x=1"`), 'links to the configured address');
});
