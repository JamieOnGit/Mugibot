// Mugibot benchmark harness: the real app, the dummy stores, a fake Discord and a deliberately slow store — the same
// scenarios run on any version of Mugibot (main before 2.0, and 2.0), so the numbers compare like with like.
//
//   node --disable-warning=ExperimentalWarning bench/run.js [--only notify,isolation,dupes,load,sweep] [--out results.json]
//
// Scenarios (each on a fresh app and database):
//   notify     a restock read by a page check → the channel post and every member's DM (200 members): how long each
//              took, how many arrived — Discord answering in 150 ms; then the same with first-time DM channels, with
//              Discord failing some posts (HTTP 500 and dropped connections), and with Discord rate-limiting (429).
//   isolation  page checks at a healthy store while another store hangs: how often each healthy page was read, and
//              how long a restock there took to be seen.
//   dupes      one product, 20 members, read by the live sweeps and by page checks at once, through restock/sold-out
//              cycles: DMs per member per restock (1 is right), channel posts, missed and extra alerts.
//   sweep      a new listing at a store searched every few seconds: time from listing to alert (P50/P95/P99).
//   load       hundreds of products and members, sweeps and page checks running: CPU, memory, event-loop delay, store
//              requests per product page.
// Nothing here touches a real store or Discord: every address is on this computer.

import fs from 'node:fs';
import http from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { discordOpts, startApp, startFakeDiscord } from '../test/helpers.js';
import { startMockStore } from '../devtools/mockstore.js';

const args = process.argv.slice(2);
const opt = (name, def = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const ONLY = (opt('only', 'notify,isolation,dupes,sweep,load') || '').split(',').filter(Boolean);
const OUT = opt('out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

// A seeded random number generator: the same faults and timings on every version.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function pct(list, p) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]);
}
const stats = (list) => ({ n: list.length, p50: pct(list, 50), p95: pct(list, 95), p99: pct(list, 99), max: list.length ? Math.round(Math.max(...list)) : null });
async function until(fn, timeoutMs, everyMs = 50) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await sleep(everyMs);
  }
}

/** A fetch for the app's Discord and webhook calls: faults injected into Discord's message posts, by a seeded draw. */
function faultyFetch({ fail500 = 0, drop = 0, seed = 7 } = {}) {
  const r = rng(seed);
  const counts = { posts: 0, fail500: 0, dropped: 0 };
  const f = async (url, init = {}) => {
    const u = String(url);
    if (/\/channels\/[^/]+\/messages$/.test(new URL(u).pathname) && (init.method || 'GET') === 'POST') {
      counts.posts += 1;
      const x = r();
      if (x < fail500) { counts.fail500 += 1; return new Response(JSON.stringify({ message: '500: Internal Server Error', code: 0 }), { status: 500, headers: { 'content-type': 'application/json' } }); }
      if (x < fail500 + drop) { counts.dropped += 1; throw new TypeError('fetch failed (connection reset)'); }
    }
    if (/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(u)) return new Response(null, { status: 204 });
    return fetch(url, init);
  };
  f.counts = counts;
  return f;
}

async function env({ discordDelayMs = 0, fetchFaults = null, opts = {} } = {}) {
  const store = await startMockStore();
  const discord = await startFakeDiscord();
  discord.state.delayMs = discordDelayMs;
  const fetchImpl = fetchFaults ? faultyFetch(fetchFaults) : undefined;
  const app = await startApp({
    allowPrivateHosts: true, demoStoreUrl: store.url, hostGapSeconds: 0, log: quiet,
    ...discordOpts(discord), ...(fetchImpl ? { fetch: fetchImpl } : {}), ...opts,
  });
  return {
    store, discord, app, fetchImpl,
    async close() { await app.close(); await store.close(); await discord.close(); },
  };
}

let userSeq = 0;
/** Members with a membership, Discord connected (a DM channel already open unless cold), each watching these pages. */
function members(e, n, items, { warmDm = true } = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const username = `bench${++userSeq}`;
    const u = e.app.app.repo.createUser({ username, passwordHash: 'x', plan: 'comped' });
    const did = `d-${username}`;
    e.app.app.repo.updateUser(u.id, { discord_id: did, discord_username: username, discord_in_guild: 1, ...(warmDm ? { discord_dm_channel: `dm-${did}` } : {}) });
    for (const it of items) {
      const saved = e.app.app.repo.addItem(u.id, { store: it.store, sku: it.sku, name: it.name, url: it.url, price: null, maxPrice: null, quantity: 1, profileId: null, monitor: true });
      e.app.app.db.run("UPDATE items SET status = :st, status_source = 'server', status_at = :t, checked_at = :t WHERE id = :id", { st: it.status || 'out_of_stock', t: Date.now() - 60000, id: saved.id });
    }
    ids.push({ id: u.id, discord: did });
  }
  return ids;
}

/** A monitored product (its channel alerts), its stock known (so a change is news). */
function monitored(e, { store, sku, url, name, status = 'out_of_stock' }) {
  const app = e.app.app;
  const p = app.catalog.upsertProduct({ store, sku, url, name });
  app.catalog.addMonitor(p.id);
  app.catalog.updateProduct(p.id, { status, confirmed: 1, last_ok_at: Date.now() - 60000, status_at: Date.now() - 60000 });
  app.repo.ensurePage(url, 'product', store, sku);
  return p;
}

// --- notify ---------------------------------------------------------------------------------------------------------
async function notifyRun(label, { n = 200, discordDelayMs = 150, warmDm = true, fetchFaults = null, rateLimitNext = 0, timeoutMs = 180000 } = {}) {
  const e = await env({ discordDelayMs, fetchFaults, opts: { monitorEnabled: false } });
  try {
    const sku = 'pokemon-tcg-30th-celebration-upc';
    const url = e.store.productUrl('jbhifi', sku);
    const name = 'Pokémon TCG 30th Celebration Ultra-Premium Collection';
    e.store.set('jbhifi', sku, { status: 'out_of_stock' });
    monitored(e, { store: 'demo-jbhifi', sku, url, name });
    const who = members(e, n, [{ store: 'demo-jbhifi', sku, url, name }], { warmDm });
    e.discord.state.rateLimitNext = rateLimitNext;
    e.store.set('jbhifi', sku, { status: 'in_stock' });
    const before = e.discord.state.messages.length;
    const t0 = Date.now();
    await e.app.app.monitor.checkPage(url);
    const heldMs = Date.now() - t0; // how long the page check (one of the monitor's slots) was held
    const want = new Set(who.map((w) => w.discord));
    const msgs = () => e.discord.state.messages.slice(before);
    const done = await until(() => { const m = msgs(); return m.some((x) => !x.to) && new Set(m.filter((x) => x.to).map((x) => x.to)).size >= want.size; }, timeoutMs, 100);
    await e.app.app.monitor.delivered();
    await sleep(300);
    const m = msgs();
    const channel = m.filter((x) => !x.to);
    const dms = m.filter((x) => x.to && want.has(x.to));
    const per = new Map();
    for (const d of dms) per.set(d.to, (per.get(d.to) || 0) + 1);
    const lat = [...per.keys()].map((to) => dms.find((d) => d.to === to).at - t0);
    return {
      label, members: n, discordDelayMs, warmDm, finishedInTime: done,
      pageCheckHeldMs: heldMs,
      channelPosts: channel.length, channelPostMs: channel.length ? channel[0].at - t0 : null,
      dmsDelivered: per.size, dmsExpected: n, dmsLost: n - per.size, duplicateDms: [...per.values()].filter((c) => c > 1).length,
      dmLatencyMs: stats(lat), lastDmMs: lat.length ? Math.max(...lat) : null,
      faults: e.fetchImpl ? e.fetchImpl.counts : null,
    };
  } finally {
    await e.close();
  }
}

async function notify() {
  return [
    await notifyRun('warm DM channels, Discord 150 ms'),
    await notifyRun('first-time DM channels, Discord 150 ms', { warmDm: false }),
    await notifyRun('Discord failing 5% (HTTP 500) + 3% dropped connections', { fetchFaults: { fail500: 0.05, drop: 0.03, seed: 11 } }),
    await notifyRun('Discord rate-limiting the first 30 posts (429)', { rateLimitNext: 30 }),
  ];
}

// --- isolation ------------------------------------------------------------------------------------------------------
async function slowServer(delayMs) {
  const hits = { n: 0 };
  const srv = http.createServer((req, res) => {
    hits.n += 1;
    const t = setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><h1>Slow product</h1><button>Add to cart</button></body></html>'); }, delayMs);
    req.on('close', () => clearTimeout(t));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, hits, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

async function isolation({ seconds = 75, healthy = 12, slow = 40 } = {}) {
  const slowSrv = await slowServer(20000);
  const e = await env({ opts: { monitorEnabled: true, urlIntervalSeconds: 5, minIntervalSeconds: 1, hostGapSeconds: 1, monitorTickMs: 200, monitorTimeoutMs: 6000 } });
  try {
    const app = e.app.app;
    const good = [];
    for (let i = 0; i < healthy; i++) {
      const sku = `bench-iso-${i}`;
      const url = e.store.addProduct('jbhifi', { sku, name: `Pokemon TCG Bench Box ${i}`, price: 99, status: 'out_of_stock' });
      good.push({ store: 'demo-jbhifi', sku, url, name: `Pokemon TCG Bench Box ${i}` });
    }
    const bad = Array.from({ length: slow }, (_, i) => ({ store: 'other', sku: `slow-${i}`, url: `${slowSrv.url}/p/slow-${i}`, name: `Slow page ${i}` }));
    members(e, 1, [...bad, ...good]);
    const reqs = (sku) => e.store.state.requests.filter((r) => r.path.includes(sku)).length;
    const r = rng(5);
    const flips = good.slice(0, 6).map((g, i) => ({ ...g, at: 15000 + i * 8000 + Math.round(r() * 3000) }));
    const start = Date.now();
    app.monitor.start();
    const seen = new Map();
    const timers = flips.map((f) => setTimeout(() => { e.store.set('jbhifi', f.sku, { status: 'in_stock' }); f.flippedAt = Date.now(); }, f.at));
    while (Date.now() - start < seconds * 1000) {
      for (const f of flips) {
        if (!f.flippedAt || seen.has(f.sku)) continue;
        const it = app.db.get('SELECT status FROM items WHERE url = :u', { u: f.url });
        if (it && it.status === 'in_stock') seen.set(f.sku, Date.now() - f.flippedAt);
      }
      await sleep(100);
    }
    timers.forEach(clearTimeout);
    app.monitor.stop();
    const reads = good.map((g) => reqs(g.sku));
    const expected = Math.floor(seconds / 5);
    return {
      seconds, healthyPages: healthy, slowPages: slow, intervalSeconds: 5, slowStoreHangs: true,
      healthyReadsPerPage: { expected, min: Math.min(...reads), median: pct(reads, 50), max: Math.max(...reads) },
      slowStoreRequests: slowSrv.hits.n,
      restocksAtHealthyStore: flips.length, restocksSeen: seen.size,
      detectionMs: stats([...seen.values()]), missed: flips.filter((f) => !seen.has(f.sku)).length,
    };
  } finally {
    await e.close();
    await slowSrv.close();
  }
}

// --- dupes ----------------------------------------------------------------------------------------------------------
async function dupes({ cycles = 5, n = 20, upMs = 14000, downMs = 14000 } = {}) {
  const e = await env({ opts: { monitorEnabled: true, urlIntervalSeconds: 3, minIntervalSeconds: 1, hostGapSeconds: 0, monitorTickMs: 200, alertCooldownSeconds: 1 } });
  try {
    const app = e.app.app;
    const off = Object.fromEntries(app.sweeper.stores().map((s) => [s.retailer.id, 'off']));
    app.sweeper.save({ everySeconds: 3, keywords: ['pokemon'], stores: { ...off, 'demo-jbhifi': 'server' } }, null);
    const sku = 'pokemon-tcg-30th-celebration-upc';
    const url = e.store.productUrl('jbhifi', sku);
    const name = 'Pokémon TCG 30th Celebration Ultra-Premium Collection';
    e.store.set('jbhifi', sku, { status: 'out_of_stock' });
    monitored(e, { store: 'demo-jbhifi', sku, url, name });
    const who = members(e, n, [{ store: 'demo-jbhifi', sku, url, name }]);
    app.sweeper.start();
    app.monitor.start();
    await sleep(8000); // (the sweeps' first look sets the scene)
    const windows = [];
    for (let c = 0; c < cycles; c++) {
      const from = Date.now();
      e.store.set('jbhifi', sku, { status: 'in_stock' });
      await sleep(upMs);
      e.store.set('jbhifi', sku, { status: 'out_of_stock' });
      await sleep(downMs);
      windows.push({ from, to: Date.now() });
    }
    app.sweeper.stop();
    app.monitor.stop();
    await app.monitor.delivered();
    const dms = e.discord.state.messages.filter((m) => m.to && who.some((w) => w.discord === m.to));
    const channel = e.discord.state.messages.filter((m) => !m.to);
    let exact = 0; let missed = 0; let extra = 0;
    for (const w of windows) {
      for (const m of who) {
        const k = dms.filter((d) => d.to === m.discord && d.at >= w.from && d.at < w.to).length;
        if (k === 1) exact += 1; else if (k === 0) missed += 1; else extra += k - 1;
      }
    }
    const outside = dms.filter((d) => !windows.some((w) => d.at >= w.from && d.at < w.to)).length;
    return {
      members: n, cycles, restockWindows: cycles * n,
      dmsPerMemberPerRestock: { exactlyOne: exact, missed, duplicates: extra },
      dmsOutsideRestocks: outside,
      channelPosts: channel.length, channelPostKinds: channel.map((m) => (m.body && m.body.embeds && m.body.embeds[0] && m.body.embeds[0].title || '').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(' ').slice(0, 3).join(' ')),
    };
  } finally {
    await e.close();
  }
}

// --- sweep ----------------------------------------------------------------------------------------------------------
async function sweep({ trials = 12 } = {}) {
  const e = await env({ opts: { monitorEnabled: true } });
  try {
    const app = e.app.app;
    const off = Object.fromEntries(app.sweeper.stores().map((s) => [s.retailer.id, 'off']));
    app.sweeper.save({ everySeconds: 3, keywords: ['pokemon'], stores: { ...off, 'demo-jbhifi': 'server' } }, null);
    app.sweeper.start();
    await sleep(7000);
    const r = rng(3);
    const toAlert = [];
    const toDiscord = [];
    for (let i = 0; i < trials; i++) {
      await sleep(1000 + Math.round(r() * 3000));
      const sku = `bench-new-${i}`;
      const before = e.discord.state.messages.length;
      const t0 = Date.now();
      e.store.addProduct('jbhifi', { sku, name: `Pokemon TCG Bench Drop ${i} Booster Box`, price: 199, status: 'in_stock' });
      const ok = await until(() => app.db.get("SELECT at AS created_at FROM feed_alerts WHERE sku = :s AND kind = 'listed'", { s: sku }), 30000, 25);
      if (ok) toAlert.push(app.db.get("SELECT at AS created_at FROM feed_alerts WHERE sku = :s AND kind = 'listed'", { s: sku }).created_at - t0);
      await until(() => e.discord.state.messages.slice(before).some((m) => !m.to && JSON.stringify(m.body).includes(`Bench Drop ${i} `)), 15000, 25);
      const post = e.discord.state.messages.slice(before).find((m) => !m.to && JSON.stringify(m.body).includes(`Bench Drop ${i} `));
      if (post) toDiscord.push(post.at - t0);
    }
    app.sweeper.stop();
    return { trials, searchEverySeconds: 3, listingToAlertMs: stats(toAlert), listingToDiscordMs: stats(toDiscord) };
  } finally {
    await e.close();
  }
}

// --- load -----------------------------------------------------------------------------------------------------------
async function load({ seconds = 60, products = 300, users = 300, perUser = 5 } = {}) {
  const e = await env({ opts: { monitorEnabled: true, urlIntervalSeconds: 10, minIntervalSeconds: 1, hostGapSeconds: 0, monitorTickMs: 250 } });
  try {
    const app = e.app.app;
    const pool = [];
    for (let i = 0; i < products; i++) {
      const sku = `bench-load-${i}`;
      const url = e.store.addProduct('jbhifi', { sku, name: `Pokemon TCG Load Box ${i}`, price: 50 + (i % 100), status: i % 7 ? 'out_of_stock' : 'in_stock' });
      pool.push({ store: 'demo-jbhifi', sku, url, name: `Pokemon TCG Load Box ${i}`, status: i % 7 ? 'out_of_stock' : 'in_stock' });
    }
    for (const p of pool.slice(0, 100)) monitored(e, p);
    const r = rng(9);
    for (let u = 0; u < users; u++) {
      const mine = new Set();
      // (Popular products: most members watch some of the same few dozen.)
      while (mine.size < perUser) mine.add(r() < 0.6 ? Math.floor(r() * 30) : Math.floor(r() * products));
      members(e, 1, [...mine].map((i) => pool[i]));
    }
    const off = Object.fromEntries(app.sweeper.stores().map((s) => [s.retailer.id, 'off']));
    app.sweeper.save({ everySeconds: 3, keywords: ['pokemon'], stores: { ...off, 'demo-jbhifi': 'server', 'demo-trainertown': 'server', 'demo-target': 'server' } }, null);
    const h = monitorEventLoopDelay({ resolution: 10 });
    const reqBefore = e.store.state.requests.length;
    const cpu0 = process.cpuUsage();
    let rssMax = 0;
    h.enable();
    app.sweeper.start();
    app.monitor.start();
    const r2 = rng(13);
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      // (Stock changing here and there all the while.)
      const p = pool[Math.floor(r2() * products)];
      e.store.set('jbhifi', p.sku, { status: r2() < 0.5 ? 'in_stock' : 'out_of_stock' });
      rssMax = Math.max(rssMax, process.memoryUsage().rss);
      await sleep(500);
    }
    app.sweeper.stop();
    app.monitor.stop();
    h.disable();
    const cpu = process.cpuUsage(cpu0);
    const reqs = e.store.state.requests.slice(reqBefore);
    const productReqs = reqs.filter((x) => /\/products\/bench-load-/.test(x.path));
    const uniq = new Set(productReqs.map((x) => x.path.replace(/\.js$/, ''))).size;
    const watchers = app.db.get('SELECT COUNT(*) AS n FROM items').n;
    return {
      seconds, products, users, itemsWatched: watchers, uniquePagesWatched: app.db.get("SELECT COUNT(*) AS n FROM page_checks WHERE kind = 'product'").n,
      cpuMs: Math.round((cpu.user + cpu.system) / 1000), cpuPercentOfOneCore: Math.round(((cpu.user + cpu.system) / 1000 / (seconds * 1000)) * 100),
      rssMaxMB: Math.round(rssMax / 1048576),
      eventLoopDelayMs: { p50: Math.round(h.percentile(50) / 1e6), p99: Math.round(h.percentile(99) / 1e6), max: Math.round(h.max / 1e6) },
      storeRequests: reqs.length, productPageRequests: productReqs.length, productPagesRead: uniq,
      requestsPerPagePerMinute: uniq ? Math.round((productReqs.length / uniq / (seconds / 60)) * 10) / 10 : null,
      note: 'The dummy stores run in the same process: CPU and memory include them (the same on every version).',
    };
  } finally {
    await e.close();
  }
}

const SCENARIOS = { notify, isolation, dupes, sweep, load };
const results = { version: process.env.BENCH_LABEL || 'unlabelled', node: process.version, at: new Date().toISOString(), scenarios: {} };
for (const name of ONLY) {
  const t = Date.now();
  process.stderr.write(`bench: ${name}…\n`);
  try {
    results.scenarios[name] = await SCENARIOS[name]();
  } catch (e) {
    results.scenarios[name] = { error: e.stack || String(e) };
  }
  process.stderr.write(`bench: ${name} done in ${Math.round((Date.now() - t) / 1000)} s\n`);
}
const text = JSON.stringify(results, null, 2);
if (OUT) fs.writeFileSync(OUT, text);
process.stdout.write(`${text}\n`);
process.exit(0);
