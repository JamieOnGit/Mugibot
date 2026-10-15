// Test helpers: a throwaway server with its own database, a browser-like API
// client with a cookie jar, fake Whop and Discord APIs, and captured
// webhook messages.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { signWebhook } from '../server/whop.js';

export const PASSWORD = 'correct horse battery staple';

function jsonServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const u = new URL(req.url, 'http://x');
      let parsed = {};
      if (body) {
        try { parsed = (req.headers['content-type'] || '').includes('json') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)); } catch { parsed = {}; }
      }
      const call = { method: req.method, path: u.pathname, query: u.searchParams, body: parsed, auth: req.headers.authorization || '' };
      calls.push(call);
      const reply = (status, obj = null, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(obj === null ? '' : JSON.stringify(obj));
      };
      try { await handler(call, reply, res); } catch (e) { reply(500, { message: e.message }); }
    });
  });
  return {
    calls,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

/**
 * A fake Discord: OAuth2, the bot's REST API (members, roles, DMs, channel
 * messages, commands) — and an /oauth2/authorize page that sends you
 * straight back as `nextUser`.
 */
export async function startFakeDiscord() {
  const state = {
    users: { 'd-ash': { id: 'd-ash', username: 'ash_k', global_name: 'Ash' }, 'd-misty': { id: 'd-misty', username: 'misty', global_name: 'Misty' } },
    nextUser: 'd-ash',
    members: new Map(), // discord id → Set of role ids
    dmsClosed: new Set(),
    messages: [], // { channel, body }
    guild: { id: 'guild-1', name: 'Mugibot Members' },
    roles: [{ id: 'role-member', name: 'Member', position: 1 }, { id: 'role-bot', name: 'Mugibot', position: 5 }],
    botRoles: ['role-bot'],
    rateLimitNext: 0,
  };
  const fake = jsonServer(async (c, reply, res) => {
    if (state.rateLimitNext > 0 && c.path.includes('/messages')) {
      state.rateLimitNext -= 1;
      return reply(429, { message: 'You are being rate limited.', retry_after: 0.05, global: false });
    }
    const p = c.path.replace(/^\/api\/v10/, '');
    const bearer = c.auth.startsWith('Bearer ') ? c.auth.slice(7) : null;
    const bot = c.auth === 'Bot bot-token';
    if (p === '/oauth2/authorize') {
      const back = new URL(c.query.get('redirect_uri'));
      back.searchParams.set('code', `code-${state.nextUser}`);
      back.searchParams.set('state', c.query.get('state'));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (p === '/oauth2/token' && c.method === 'POST') {
      if (c.body.client_secret !== 'client-secret') return reply(401, { error: 'invalid_client' });
      if (c.body.grant_type === 'authorization_code') {
        const id = String(c.body.code || '').replace(/^code-/, '');
        if (!state.users[id]) return reply(400, { error: 'invalid_grant' });
        return reply(200, { access_token: `at-${id}`, refresh_token: `rt-${id}`, expires_in: 604800, scope: 'identify guilds.join', token_type: 'Bearer' });
      }
      if (c.body.grant_type === 'refresh_token') {
        const id = String(c.body.refresh_token || '').replace(/^rt-/, '');
        return reply(200, { access_token: `at-${id}`, refresh_token: `rt-${id}`, expires_in: 604800 });
      }
      return reply(400, { error: 'unsupported_grant_type' });
    }
    if (p === '/oauth2/token/revoke') return reply(200, {});
    if (p === '/users/@me' && c.method === 'GET') {
      if (bot) return reply(200, { id: 'bot-1', username: 'MugibotBot', bot: true });
      const id = bearer && bearer.replace(/^at-/, '');
      return state.users[id] ? reply(200, state.users[id]) : reply(401, { message: '401: Unauthorized', code: 0 });
    }
    if (!bot) return reply(401, { message: '401: Unauthorized', code: 0 });
    let m;
    if ((m = p.match(/^\/guilds\/([^/]+)$/))) return m[1] === state.guild.id ? reply(200, state.guild) : reply(404, { message: 'Unknown Guild', code: 10004 });
    if ((m = p.match(/^\/guilds\/([^/]+)\/roles$/))) return reply(200, state.roles);
    if ((m = p.match(/^\/guilds\/([^/]+)\/members\/([^/]+)$/))) {
      const uid = m[2];
      if (uid === 'bot-1') return reply(200, { user: { id: 'bot-1' }, roles: state.botRoles });
      if (c.method === 'GET') return state.members.has(uid) ? reply(200, { user: { id: uid }, roles: [...state.members.get(uid)] }) : reply(404, { message: 'Unknown Member', code: 10007 });
      if (c.method === 'PUT') {
        if (c.body.access_token !== `at-${uid}`) return reply(403, { message: 'Missing Access', code: 50001 });
        if (state.members.has(uid)) return reply(204);
        state.members.set(uid, new Set(c.body.roles || []));
        return reply(201, { user: { id: uid }, roles: c.body.roles || [] });
      }
      if (c.method === 'DELETE') { state.members.delete(uid); return reply(204); }
    }
    if ((m = p.match(/^\/guilds\/([^/]+)\/members\/([^/]+)\/roles\/([^/]+)$/))) {
      const roles = state.members.get(m[2]);
      if (!roles) return reply(404, { message: 'Unknown Member', code: 10007 });
      if (!state.roles.some((r) => r.id === m[3])) return reply(404, { message: 'Unknown Role', code: 10011 });
      if (c.method === 'PUT') roles.add(m[3]);
      if (c.method === 'DELETE') roles.delete(m[3]);
      return reply(204);
    }
    if (p === '/users/@me/channels' && c.method === 'POST') return reply(200, { id: `dm-${c.body.recipient_id}`, type: 1 });
    if ((m = p.match(/^\/channels\/([^/]+)\/messages$/)) && c.method === 'POST') {
      const recipient = m[1].startsWith('dm-') ? m[1].slice(3) : null;
      if (recipient && state.dmsClosed.has(recipient)) return reply(403, { message: 'Cannot send messages to this user', code: 50007 });
      state.messages.push({ channel: m[1], to: recipient, body: c.body });
      return reply(200, { id: `msg-${state.messages.length}`, channel_id: m[1] });
    }
    if ((m = p.match(/^\/channels\/([^/]+)$/))) return reply(200, { id: m[1], name: 'restocks' });
    if ((m = p.match(/^\/applications\/([^/]+)\/guilds\/([^/]+)\/commands$/)) && c.method === 'PUT') return reply(200, c.body.map((x, i) => ({ ...x, id: `cmd-${i}` })));
    return reply(404, { message: `fake discord: no route ${c.method} ${p}`, code: 0 });
  });
  await fake.start();
  return Object.assign(fake, {
    state,
    dmsTo: (discordId) => state.messages.filter((x) => x.to === discordId),
    channelPosts: (channel) => state.messages.filter((x) => x.channel === channel),
  });
}

/** A fake Whop API: memberships, checkout configurations and cancelling. */
export async function startFakeWhop() {
  const state = { memberships: new Map(), checkouts: [] };
  const fake = jsonServer(async (c, reply) => {
    if (c.auth !== 'Bearer whop-key') return reply(401, { error: { message: 'unauthorized' } });
    let m;
    if (c.path === '/checkout_configurations' && c.method === 'POST') {
      const id = `ch_${state.checkouts.length + 1}`;
      state.checkouts.push({ id, ...c.body });
      return reply(200, { id, mode: c.body.mode, metadata: c.body.metadata, redirect_url: c.body.redirect_url, purchase_url: `https://whop.test/checkout/${id}/`, plan: { id: c.body.plan_id } });
    }
    if ((m = c.path.match(/^\/memberships\/([^/]+)\/cancel$/)) && c.method === 'POST') {
      const mem = state.memberships.get(m[1]);
      if (!mem) return reply(404, { error: { message: 'not found' } });
      mem.status = 'canceled';
      return reply(200, mem);
    }
    if ((m = c.path.match(/^\/memberships\/([^/]+)$/)) && c.method === 'GET') {
      const key = decodeURIComponent(m[1]);
      const mem = state.memberships.get(key) || [...state.memberships.values()].find((x) => x.license_key === key);
      return mem ? reply(200, mem) : reply(404, { error: { message: 'not found' } });
    }
    return reply(404, { error: { message: `fake whop: no route ${c.method} ${c.path}` } });
  });
  await fake.start();
  return Object.assign(fake, {
    state,
    /** Add or change a membership the way Whop would have it. */
    membership(id, fields = {}) {
      const existing = state.memberships.get(id) || {
        id, status: 'active', cancel_at_period_end: false, license_key: `LIC-${id}`, manage_url: `https://whop.test/manage/${id}`,
        renewal_period_end: new Date(Date.now() + 30 * 86400000).toISOString(), metadata: null,
        product: { id: 'prod_mugibot', title: 'Mugibot' }, plan: { id: 'plan_monthly' }, user: { id: `user_${id}`, username: `whop_${id}`, email: `${id}@buyer.example` },
      };
      const next = { ...existing, ...fields };
      state.memberships.set(id, next);
      return next;
    },
  });
}

export const WHOP_SECRET = 'ws_test_secret_123';

/** Send a signed Whop webhook (Standard Webhooks). */
export async function whopWebhook(base, type, data, { secret = WHOP_SECRET, id = `msg_${crypto.randomBytes(6).toString('hex')}`, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify({ id, type, api_version: 'v1', timestamp: new Date(timestamp * 1000).toISOString(), account_id: 'biz_test', data });
  const sig = signWebhook(secret, id, timestamp, body);
  const res = await fetch(`${base}/api/whop/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${sig}` }, body });
  return { status: res.status, body: await res.json().catch(() => null), id };
}

/** Ed25519 keys for signing fake Discord interactions. */
export function interactionKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return {
    publicKey: raw,
    sign(timestamp, body) { return crypto.sign(null, Buffer.from(timestamp + body), privateKey).toString('hex'); },
  };
}

/** Discord settings pointing at a fake Discord. */
export function discordOpts(fake, extra = {}) {
  return {
    discordApiBase: fake.url, discordOAuthBase: fake.url, discordClientId: 'app-1', discordClientSecret: 'client-secret', discordBotToken: 'bot-token',
    discordGuildId: 'guild-1', discordMemberRoleId: 'role-member', discordRestockChannelId: 'chan-restocks', discordRestockRoleId: 'role-restock-pings',
    discordLinkButtons: true, ...extra,
  };
}

export function whopOpts(fake, extra = {}) {
  return { whopApiBase: fake.url, whopApiKey: 'whop-key', whopPlanId: 'plan_monthly', whopProductId: 'prod_mugibot', whopWebhookSecret: WHOP_SECRET, ...extra };
}

/**
 * Start a server for one test file. opts are config overrides.
 * Returns { app, url, outbox, webhooks, close() }.
 */
export async function startApp(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mugibot-test-'));
  const outbox = [];
  const webhooks = [];
  // Outbound requests: members' own Discord webhooks are captured; everything else (fakes, the dummy store) goes through.
  const fetchImpl = async (url, init = {}) => {
    if (/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(String(url))) {
      webhooks.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    return fetch(url, init);
  };
  const app = await createApp({
    databasePath: path.join(dir, 'mugibot.db'),
    outbox,
    monitorEnabled: false,
    jobsEnabled: false,
    signupsPerHour: 1000,
    log: () => {},
    fetch: fetchImpl,
    ...opts,
  });
  const url = await app.listen(0, '127.0.0.1');
  return {
    app,
    url,
    dir,
    outbox,
    webhooks,
    async close() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A browser-like client: keeps the session cookie and sends the dashboard's header. */
export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async call(method, p, body, headers = {}) {
    const res = await fetch(this.base + p, {
      method,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-mugibot': '1', origin: this.base, ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const [pair] = c.split(';');
      const [name, value] = pair.split('=');
      this.cookie = value ? `${name}=${value}` : '';
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  get(p, h) { return this.call('GET', p, undefined, h); }
  post(p, b = {}, h) { return this.call('POST', p, b, h); }
  put(p, b = {}, h) { return this.call('PUT', p, b, h); }
  del(p, b, h) { return this.call('DELETE', p, b, h); }

  static async signup(base, username, extra = {}) {
    const c = new Client(base);
    const r = await c.post('/api/auth/signup', { username, password: PASSWORD, acceptTerms: true, ...extra });
    if (r.status !== 200) throw new Error(`signup failed: ${r.status} ${r.text}`);
    c.user = r.body.user;
    return c;
  }
}

/** Give an account an active membership straight in the database (tests that aren't about billing). */
export function makeMember(env, client, plan = 'comped') {
  env.app.repo.updateUser(client.user.id, { plan });
}

/** The extension's view of the API: a device token instead of a cookie. */
export class Device {
  constructor(base, token) {
    this.base = base;
    this.token = token;
  }

  static async pair(base, client, name = 'Test browser') {
    const { body } = await client.post('/api/devices/pair-code');
    const res = await fetch(`${base}/api/ext/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: body.code, name }) });
    const data = await res.json();
    if (!res.ok) throw new Error(`pair failed: ${data.error}`);
    const d = new Device(base, data.token);
    d.user = data.user;
    return d;
  }

  async call(method, p, body) {
    const res = await fetch(this.base + p, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
}

export async function waitFor(fn, { timeout = 10000, interval = 100, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
