// Mugibot 2.0's engine: each store's circuit breaker, the metrics (P50/P95/P99), Discord deliveries tried again instead
// of lost (and never posted twice), /readyz, the health panel's reliability scores — and a store that keeps failing
// backed off without holding up another store's checks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Breakers, retryAfterMs, THRESHOLD } from '../server/monitor/breaker.js';
import { Metrics, percentile } from '../server/metrics.js';
import { Client, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';

test('a store\'s breaker: closed until THRESHOLD failed reads in a row; open, then half-open letting one read try; a read that works closes it, one that fails opens it for longer (jittered, never sooner than Retry-After)', () => {
  let t = 1_000_000;
  const lines = [];
  const b = new Breakers({ now: () => t, random: () => 0.5, log: (l) => lines.push(JSON.parse(l)) });
  for (let i = 1; i < THRESHOLD; i++) assert.equal(b.failure('kmart', { error: 'HTTP 503' }), 'closed');
  assert.equal(b.allow('kmart'), true);
  b.success('kmart');
  for (let i = 1; i < THRESHOLD; i++) b.failure('kmart');
  assert.equal(b.failure('kmart'), 'open', 'five in a row');
  assert.equal(b.allow('kmart'), false);
  assert.equal(b.allow('jbhifi'), true, 'another store: its own breaker');
  t += 29_000;
  assert.equal(b.state('kmart'), 'open', '30 s (±20%)');
  t += 2_000;
  assert.equal(b.state('kmart'), 'half-open');
  assert.equal(b.allow('kmart'), true, 'one read may try');
  assert.equal(b.allow('kmart'), false, '…only one');
  assert.equal(b.failure('kmart'), 'open');
  t += 31_000;
  assert.equal(b.state('kmart'), 'open', 'longer the second time (60 s)');
  t += 30_000;
  assert.equal(b.allow('kmart'), true);
  b.success('kmart');
  assert.equal(b.state('kmart'), 'closed');
  // A Retry-After: open at once, for at least that long.
  assert.equal(b.failure('bigw', { retryAfterMs: 120_000 }), 'open');
  t += 100_000;
  assert.equal(b.state('bigw'), 'open');
  assert.ok(lines.some((l) => l.evt === 'monitor.breaker' && l.store === 'kmart' && l.state === 'closed'));
  assert.equal(retryAfterMs('7'), 7000);
  assert.equal(retryAfterMs(new Date(Date.now() + 60_000).toUTCString()) > 50_000, true);
  assert.equal(retryAfterMs('soon'), 0);
});

test('metrics: P50 / P95 / P99 over the latest samples, per store too, with failures counted', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([], 50), null);
  const m = new Metrics({ samples: 100 });
  for (let i = 1; i <= 200; i++) m.observe('page_read_ms', i, { store: 'kmart', ok: i % 50 !== 0 });
  const all = m.summary('page_read_ms');
  assert.deepEqual([all.n, all.p50, all.p95, all.p99, all.max], [100, 150, 195, 199, 200], 'the latest 100');
  assert.equal(m.summary('page_read_ms{store=kmart}').n, 100);
  assert.equal(m.snapshot().counters['page_read_ms_failed{store=kmart}'], 4);
});

let env;
let discord;
let store;
before(async () => {
  discord = await startFakeDiscord();
  store = await startMockStore();
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, hostGapSeconds: 0, ...discordOpts(discord) });
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

test('Discord: a 5xx is tried again and delivered; a message taken whose answer was lost is tried again and posted once (its nonce); a burst of 429s is waited out — nothing lost', async () => {
  const d = env.app.discord;
  const before = discord.channelPosts('chan-restocks').length;
  discord.state.failNext = 2;
  assert.equal(await d.post('chan-restocks', { content: 'after two 500s' }), true);
  discord.state.lostNext = 1;
  assert.equal(await d.post('chan-restocks', { content: 'taken, answer lost' }), true);
  discord.state.rateLimitNext = 6;
  assert.equal(await d.post('chan-restocks', { content: 'after six 429s' }), true);
  const posts = discord.channelPosts('chan-restocks').slice(before).map((p) => p.body.content);
  assert.deepEqual(posts, ['after two 500s', 'taken, answer lost', 'after six 429s'], 'each exactly once');
  const c = env.app.metrics.snapshot().counters;
  assert.ok(c['discord_retried{why=500}'] >= 2 && c['discord_retried{why=502}'] >= 1 && c['discord_retried{why=429}'] >= 6, JSON.stringify(c));
  // A POST that isn't safe to repeat (no nonce: a token, a channel made) is never tried again on a 5xx.
  discord.state.failNext = 1;
  const r = await d.api('POST', '/channels/chan-restocks/messages', { content: 'no retry' });
  assert.equal(r.status, 500);
  // A DM too.
  const ash = await Client.signup(env.url, 'ash');
  makeMember(env, ash);
  env.app.repo.updateUser(ash.user.id, { discord_id: 'd-ash', discord_dm_channel: null });
  discord.state.failNext = 1;
  assert.equal(await d.dm(env.app.repo.userById(ash.user.id), { content: 'hello' }), true);
  assert.equal(discord.dmsTo('d-ash').filter((m) => m.body.content === 'hello').length, 1);
});

test('/readyz: the database, the monitor and the process checked — 200 when all pass, 503 naming the failing one; the admin health panel has each store\'s score and breaker', async () => {
  let r = await fetch(`${env.url}/readyz`);
  let body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.checks).sort(), ['database', 'eventLoop', 'monitor', 'sweeps']);
  assert.doesNotMatch(JSON.stringify(body), /token|secret|key|@/i, 'nothing about members or keys');
  // A monitor that's stopped ticking: not ready.
  const m = env.app.monitor;
  const was = { timer: m.timer, lastTickAt: m.lastTickAt, enabled: env.app.cfg.monitor.enabled };
  try {
    env.app.cfg.monitor.enabled = true;
    Object.assign(m, { timer: m.timer || 1, lastTickAt: Date.now() - 60_000 });
    r = await fetch(`${env.url}/readyz`);
    body = await r.json();
    assert.equal(r.status, 503);
    assert.equal(body.checks.monitor.ok, false);
  } finally {
    env.app.cfg.monitor.enabled = was.enabled;
    Object.assign(m, { timer: was.timer, lastTickAt: was.lastTickAt });
  }
  // The health panel (admins only).
  const boss = await Client.signup(env.url, 'boss');
  env.app.repo.updateUser(boss.user.id, { role: 'admin' });
  env.app.catalog.logCheck({ productId: null, store: 'demo-kmart', url: 'x', source: 'server', status: 'in_stock', price: 1, ms: 300, error: '' });
  env.app.catalog.logCheck({ productId: null, store: 'demo-kmart', url: 'x', source: 'server', status: 'error', price: null, ms: 15000, error: 'timeout' });
  const h = await boss.get('/api/admin/health');
  assert.equal(h.status, 200, h.text);
  const k = h.body.stores.find((s) => s.store === 'demo-kmart');
  assert.equal(k.successRate, 50);
  assert.ok(k.score > 0 && k.score < 100, JSON.stringify(k));
  assert.ok(h.body.metrics.counters, 'metrics');
  assert.equal((await (await Client.signup(env.url, 'pleb')).get('/api/admin/health')).status, 404);
});

test("a store that keeps failing: its breaker opens after five failed reads — it's left alone a while (no read, no slot held) — while another store's pages are read as usual", async () => {
  const m = env.app.monitor;
  const ash = await Client.signup(env.url, 'ash2');
  makeMember(env, ash);
  for (const it of (await ash.get('/api/items')).body.items) await ash.del(`/api/items/${it.id}`);
  const urls = [];
  for (let i = 0; i < 6; i++) urls.push(store.addProduct('jbhifi', { sku: `77000${i}`, name: `Broken ${i}`, price: 10, status: 'in_stock' }));
  for (const url of urls) assert.equal((await ash.post('/api/items', { url, name: 'x' })).status, 200);
  const other = store.addProduct('ebgames', { sku: '399001', name: 'Healthy Box', price: 10, status: 'in_stock' });
  assert.equal((await ash.post('/api/items', { url: other, name: 'Healthy' })).status, 200);
  store.state.blockNonBrowsers = true;
  try {
    // (EB Games' dummy copy reads from the server here: only JB Hi-Fi's refuses.)
    for (const url of urls) await m.checkPage(url);
    assert.equal(m.breakers.state('demo-jbhifi'), 'open');
    const asked = store.state.requests.length;
    env.app.db.run("UPDATE page_checks SET next_check_at = 0 WHERE url LIKE '%/jbhifi/%' OR url = :o", { o: other });
    await m.tick();
    const jb = store.state.requests.slice(asked).filter((q) => q.path.includes('/jbhifi/'));
    assert.equal(jb.length, 0, 'JB Hi-Fi left alone while its breaker is open');
  } finally {
    store.state.blockNonBrowsers = false;
  }
});

test('drop intelligence: each store\'s drops by Sydney weekday and hour, the windows they come in most — an estimate, labelled so, only with enough history', async () => {
  const { dropWindows } = await import('../server/health.js');
  const db = env.app.db;
  // Six restocks at the dummy Kmart on Thursdays 9–10 am Sydney time, one on a Monday; two at JB Hi-Fi (too few to say).
  const thu9 = Date.parse('2026-10-29T09:15:00+11:00');
  const add = (store, at) => db.run("INSERT INTO feed_alerts (kind, store, sku, at) VALUES ('restock', :s, 'x', :at)", { s: store, at });
  // (Sydney's clocks went forward on 4 October: the Thursdays before it are +10:00.)
  for (const d of ['2026-10-29T09:15:00+11:00', '2026-10-22T09:40:00+11:00', '2026-10-15T09:05:00+11:00', '2026-10-08T09:55:00+11:00', '2026-10-01T09:20:00+10:00', '2026-09-24T09:30:00+10:00']) add('demo-kmart', Date.parse(d));
  add('demo-kmart', Date.parse('2026-10-26T14:05:00+11:00'));
  add('demo-jbhifi', thu9);
  add('demo-jbhifi', thu9 - 86400000);
  const out = dropWindows(env.app.ctx, { now: Date.parse('2026-10-30T00:00:00+11:00') });
  const k = out.find((x) => x.store === 'demo-kmart');
  assert.deepEqual(k.windows[0], { day: 'Thu', hour: 9, drops: 6, share: 86 });
  assert.equal(k.estimate, 'Thu 9:00–10:00 (estimate: 6 of 7 drops in the last 90 days)');
  assert.equal(out.find((x) => x.store === 'demo-jbhifi').estimate, null, 'two drops: nothing to go on');
});

test('Discord DMs: urgent ones (your SKU back, your checkout, a queue) ping with a header saying so; routine ones (listed, price drops) arrive silently — never sounding alike', async () => {
  const n = env.app.notifier;
  const urgent = n.message({ type: 'restock', level: 'urgent', title: '🟢 In stock: Box', message: 'EB Games' }, { quiet: false });
  assert.equal(urgent.embeds[0].author.name, '🚨 ON YOUR WATCHLIST — buy it now');
  assert.equal(urgent.flags, undefined, 'pings');
  const quiet = n.message({ type: 'listed', level: 'success', title: 'Listed: Box', message: 'EB Games' }, { quiet: true });
  assert.equal(quiet.flags, 4096, 'silent (@silent)');
  assert.equal(quiet.embeds[0].author, undefined);
  // Through notify: a member's in-stock DM pings, their "listed" DM doesn't.
  const misty = await Client.signup(env.url, 'misty-dm');
  makeMember(env, misty);
  env.app.repo.updateUser(misty.user.id, { discord_id: 'd-misty', discord_dm_channel: 'dm-d-misty' });
  const item = { store: 'demo-kmart', sku: '43818648', name: 'Day UPC', url: store.productUrl('kmart', '43818648'), last_price: 360, quantity: 1, id: 'itm_x' };
  await n.itemAlert(misty.user.id, item, 'restock', { status: 'in_stock', price: 360 });
  await n.itemAlert(misty.user.id, item, 'listed', { status: 'coming_soon', price: 360 });
  const [inStock, listed] = discord.dmsTo('d-misty').slice(-2).map((m) => m.body);
  assert.match(inStock.embeds[0].title, /In stock: Day UPC/);
  assert.equal(inStock.embeds[0].author.name, '🚨 ON YOUR WATCHLIST — buy it now');
  assert.equal(inStock.flags, undefined);
  assert.match(listed.embeds[0].title, /Listed: Day UPC/);
  assert.equal(listed.flags, 4096);
});
