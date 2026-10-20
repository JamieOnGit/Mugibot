// Checkpoints and virtual queues (server/monitor/gates.js, docs/MONITORING.md): JB Hi-Fi's hCaptcha
// checkpoint, seen by the server; EB Games' and Pokémon Center's queues, seen by browsers (members'
// in the queue, admins' as a new visitor). Each going up and coming down is posted in
// #virtual-queue-detection like the monitor's own embed, DM'd to members watching that store, and
// shown on the dashboard. While a queue's up, nothing of Mugibot's asks that store for anything from
// a browser that isn't through it; Auto-checkout's runs wait in line (never refreshing) and carry on.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { classify, gateOnPage } from '../server/monitor/gate.js';
import { Client, Device, discordOpts, interactionKeys, makeMember, startApp, startFakeDiscord, waitFor } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';

const MIN = 60 * 1000;
let env;
let store;
let discord;
let keys;
let clock;
let boss;
let ash;
let misty;
let bossBrowser;
let ashBrowser;
let mistyBrowser;

const GATE_CHANNEL = 'virtual-queue-detection';
const gatePosts = () => {
  const ch = discord.state.channels.find((c) => c.name === GATE_CHANNEL);
  return ch ? discord.channelPosts(ch.id) : [];
};
const lastPost = () => gatePosts().at(-1);
const SYDNEY_CLOCK = /\[\d\d:\d\d:\d\d AE[DS]T\]$/;

async function connect(c, discordId) {
  discord.state.users[discordId] = discord.state.users[discordId] || { id: discordId, username: discordId };
  discord.state.nextUser = discordId;
  const start = await c.get('/auth/discord');
  const consent = await fetch(new URL(start.headers.get('location')), { redirect: 'manual' });
  const cb = new URL(consent.headers.get('location'));
  await c.get(cb.pathname + cb.search);
}

let presses = 0;
async function press(discordId, customId) {
  presses += 1;
  const body = JSON.stringify({ type: 3, id: `i-${presses}`, token: `tok-${presses}`, member: { user: { id: discordId } }, data: { custom_id: customId, component_type: 2 } });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${env.url}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': keys.sign(ts, body), 'x-signature-timestamp': ts }, body });
  const out = await res.json().catch(() => null);
  return { status: res.status, content: out && out.data && out.data.content };
}

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  keys = interactionKeys();
  clock = Date.now();
  env = await startApp({ demoStoreUrl: store.url, allowPrivateHosts: true, hostGapSeconds: 0, ...discordOpts(discord), discordPublicKey: keys.publicKey, now: () => clock });
  boss = await Client.signup(env.url, 'boss');
  env.app.repo.updateUser(boss.user.id, { role: 'admin' });
  ash = await Client.signup(env.url, 'ash');
  misty = await Client.signup(env.url, 'misty');
  for (const c of [boss, ash, misty]) makeMember(env, c);
  await connect(ash, 'd-ash');
  await connect(misty, 'd-misty');
  bossBrowser = await Device.pair(env.url, boss, 'Boss browser');
  ashBrowser = await Device.pair(env.url, ash, 'Ash desktop');
  mistyBrowser = await Device.pair(env.url, misty, 'Misty laptop');
  // Ash watches something at the dummy EB Games and the dummy JB Hi-Fi.
  for (const url of [store.productUrl('ebgames', '312345'), store.productUrl('jbhifi', 'pokemon-tcg-30th-celebration-etb')]) {
    const r = await ash.post('/api/items', { url, maxPrice: 300 });
    assert.equal(r.status, 200, r.text);
  }
  // The dummy EB Games is swept from an admin's browser here (its queue is looked at from there too).
  const s = env.app.sweeper.settings;
  env.app.repo.setSetting('sweep', { ...s, enabled: true, modesVersion: 2, stores: { ...Object.fromEntries(env.app.sweeper.stores().map(({ retailer: r }) => [r.id, 'off'])), 'demo-ebgames': 'browser', 'demo-pokemoncenter': 'browser' } });
});

after(async () => {
  env.app.gates.stop();
  await env.app.gates.settled();
  await env.close();
  await store.close();
  await discord.close();
});

beforeEach(async () => {
  // (The last test's posts and DMs, sent before this one starts.)
  await env.app.gates.settled();
  store.reset();
});

test('reading a gate: the checkpoint is its own address with the hCaptcha on it; a queue is its words; a bot check is neither', () => {
  const jb = env.app.retailers.get('jbhifi').gate;
  const eb = env.app.retailers.get('ebgames').gate;
  const pc = env.app.retailers.get('pokemoncenter').gate;
  const captcha = '<html><body><form><div class="h-captcha" data-sitekey="x"></div></form><script src="https://hcaptcha.com/1/api.js"></script></body></html>';
  assert.equal(classify(jb, { status: 200, url: 'https://www.jbhifi.com.au/checkpoint', html: captcha }), 'up');
  assert.equal(classify(jb, { status: 404, url: 'https://www.jbhifi.com.au/checkpoint', html: '<h1>404 Page Not Found</h1>' }), 'down');
  assert.equal(classify(jb, { status: 200, url: 'https://www.jbhifi.com.au/', html: `<html>${'<p>The store</p>'.repeat(40)}</html>` }), 'down', 'sent on to the store');
  assert.equal(classify(jb, { status: 429, url: 'https://www.jbhifi.com.au/checkpoint', html: '' }), null, 'refused: can\'t tell');
  assert.equal(classify(jb, { status: 200, url: 'https://www.jbhifi.com.au/checkpoint', html: `${captcha}<div id="cf-chl-widget">` }), null, "a CDN's own check isn't the store's checkpoint");
  assert.equal(gateOnPage(jb, { url: 'https://www.jbhifi.com.au/products/x', html: captcha }), null, 'a captcha elsewhere is not the checkpoint');

  const queue = "<html><body><h1>You're in the queue!</h1><p>Your estimated wait time is 23 minutes.</p><p>We are experiencing a high volume of traffic and using a virtual queue</p><p>This page will automatically refresh</p></body></html>";
  assert.deepEqual(gateOnPage(eb, { url: 'https://www.ebgames.com.au/', html: queue }), { kind: 'queue', wait: 23 });
  assert.equal(classify(eb, { status: 200, url: 'https://www.ebgames.com.au/', html: queue }), 'up');
  assert.equal(classify(eb, { status: 200, url: 'https://www.ebgames.com.au/', html: `<html><title>EB Games</title>${'<a href="/product/x">x</a>'.repeat(80)}</html>` }), 'down');
  assert.equal(classify(eb, { status: 200, url: 'https://www.ebgames.com.au/', html: '<html><title>Just a moment...</title>cf-chl-'.padEnd(3000, ' ') }), null, "Cloudflare's check: can't tell");
  assert.equal(classify(eb, { status: 403, url: 'https://www.ebgames.com.au/', html: '' }), null);
  assert.equal(gateOnPage(pc, { url: 'https://www.pokemoncenter.com/?queue', html: '<html></html>' }).kind, 'queue', "Pokémon Center's ?queue");
  assert.equal(gateOnPage(pc, { url: 'https://www.pokemoncenter.com/en-au/product/x', html: '<html>Pikachu plush</html>' }), null);
  // A store page that mentions its queue (a launch banner) is still the store: its menus and products give it away.
  const storePage = `<html><body><div class="banner">Big launches use a virtual queue — you're in the queue when you see our waiting page.</div>${'<a href="/en-au/category/x">x</a>'.repeat(60)}</body></html>`;
  assert.equal(gateOnPage(pc, { url: 'https://www.pokemoncenter.com/en-au/product/x', html: storePage }), null);
  assert.equal(gateOnPage(eb, { url: 'https://www.ebgames.com.au/product/x', html: storePage }), null);
  assert.equal(classify(eb, { status: 200, url: 'https://www.ebgames.com.au/', html: storePage.padEnd(3000, ' ') }), 'down');
  assert.equal(gateOnPage(pc, { url: 'https://www.pokemoncenter.com/?queue', html: storePage }), null, 'let in at ?queue: the store itself');
  // The queue's words with the page's own entities: still read.
  assert.deepEqual(gateOnPage(eb, { url: 'https://www.ebgames.com.au/', html: '<html><body><h1>You&#39;re in the queue!</h1><p>Your estimated wait time is 9 minutes.</p></body></html>' }), { kind: 'queue', wait: 9 });
});

test("🛡️ JB Hi-Fi's checkpoint: the server looks (honestly itself), a change seen twice counts; up and disabled are posted in #virtual-queue-detection like the monitor's embed; members watching JB hear it", async () => {
  const g = env.app.gates;
  const jb = env.app.retailers.get('demo-jbhifi');
  assert.equal(await g.probe(jb), 'down', 'no checkpoint: /checkpoint is a 404');
  assert.equal(g.get('demo-jbhifi').status, 'down');
  store.shop('jbhifi').checkpoint.on = true;
  assert.equal(await g.probe(jb), 'up');
  assert.equal(g.get('demo-jbhifi').status, 'down', 'once is not enough');
  await g.probe(jb);
  assert.equal(g.get('demo-jbhifi').status, 'up');
  // The server asked as itself.
  const asked = store.state.requests.filter((r) => r.path === '/jbhifi/checkpoint');
  assert.ok(asked.length >= 3 && asked.every((r) => /^Mugibot\/1\.0/.test(r.ua)), JSON.stringify(asked.slice(0, 2)));

  // The post: made the channel (it wasn't there), the monitor's embed.
  await waitFor(() => gatePosts().length === 1, { message: 'posted in #virtual-queue-detection' });
  const ch = discord.state.channels.find((c) => c.name === GATE_CHANNEL);
  assert.ok(ch, 'the bot made #virtual-queue-detection');
  const e = lastPost().body.embeds[0];
  assert.equal(e.author.name, `${store.url}/jbhifi/`);
  assert.equal(e.title, 'Checkpoint Monitor');
  assert.equal(e.description.split('\n')[0], `🟢 hcaptcha Checkpoint up for JB Hi-Fi (dummy store) | ${store.url}/jbhifi/checkpoint`);
  assert.equal(e.color, 0xffffff);
  assert.match(e.footer.text, /^Shopify \| Mugibot Monitors /);
  assert.match(e.footer.text, SYDNEY_CLOCK);
  assert.ok(e.timestamp);
  assert.equal(env.app.repo.getSetting('gateChannel').channelId, ch.id, 'remembered');
  // Ash watches something at JB: a DM (and his activity feed).
  await waitFor(() => discord.dmsTo('d-ash').some((m) => /JB Hi-Fi \(dummy store\)'s checkpoint is up/.test(m.body.embeds[0].title)), { message: "Ash's DM" });
  assert.ok(!discord.dmsTo('d-misty').some((m) => /checkpoint/.test(m.body.embeds[0].title)), 'Misty watches nothing there');
  // The dashboard.
  const list = (await ash.get('/api/gates')).body.gates;
  const jbGate = list.find((x) => x.store === 'demo-jbhifi');
  assert.deepEqual([jbGate.status, jbGate.kind, jbGate.label, jbGate.url], ['up', 'checkpoint', 'hcaptcha Checkpoint', `${store.url}/jbhifi/checkpoint`]);
  assert.equal(jbGate.source, undefined, 'members: not where it was seen from');
  assert.equal((await boss.get('/api/gates')).body.gates.find((x) => x.store === 'demo-jbhifi').source, 'server');

  // Disabled: seen twice.
  store.shop('jbhifi').checkpoint.on = false;
  await g.probe(jb);
  assert.equal(g.get('demo-jbhifi').status, 'up');
  await g.probe(jb);
  assert.equal(g.get('demo-jbhifi').status, 'down');
  await waitFor(() => gatePosts().length === 2, { message: 'the disabled post' });
  assert.equal(lastPost().body.embeds[0].description, `🔴 Checkpoint disabled for JB Hi-Fi (dummy store) | ${store.url}/jbhifi/checkpoint`);
  await waitFor(() => discord.dmsTo('d-ash').some((m) => /checkpoint is off/.test(m.body.embeds[0].title)), { message: 'Ash hears it went' });
});

test('the server keeps looking by itself: once a minute, and again 10 seconds after a change to be sure', async () => {
  const g = env.app.gates;
  const cfg = env.app.cfg.monitor;
  Object.assign(cfg, { enabled: true, gateProbeSeconds: 2, gateConfirmSeconds: 1 });
  try {
    g.start();
    store.shop('jbhifi').checkpoint.on = true;
    await waitFor(() => g.get('demo-jbhifi').status === 'up', { timeout: 15000, message: 'up, from the loop' });
    store.shop('jbhifi').checkpoint.on = false;
    await waitFor(() => g.get('demo-jbhifi').status === 'down', { timeout: 15000, message: 'down, from the loop' });
  } finally {
    g.stop();
    Object.assign(cfg, { enabled: false, gateProbeSeconds: 0, gateConfirmSeconds: 10 });
  }
});

test("🚦 EB Games' queue: members' browsers in it (two of them), or an admin's, put it up; only a new visitor's look (an admin's browser, no cookies) takes it down — twice, 45 s apart", async () => {
  const g = env.app.gates;
  const before = gatePosts().length;
  const seen = (dev, status, how = 'page', wait = 23) => dev.call('POST', '/api/ext/gates', { seen: [{ store: 'demo-ebgames', status, how, wait }] });
  assert.equal((await seen(ashBrowser, 'up')).status, 200);
  assert.equal(g.get('demo-ebgames').status, 'down', 'one member is not enough');
  await seen(ashBrowser, 'up');
  assert.equal(g.get('demo-ebgames').status, 'down', 'the same member twice is still one');
  await seen(mistyBrowser, 'up');
  assert.equal(g.get('demo-ebgames').status, 'up');
  assert.equal(g.get('demo-ebgames').wait, 23);
  await waitFor(() => gatePosts().length === before + 1, { message: 'the up post' });
  const msg = lastPost().body;
  assert.equal(msg.embeds[0].title, 'Queue Monitor');
  assert.equal(msg.embeds[0].author.name, `${store.url}/ebgames/`);
  const lines = msg.embeds[0].description.split('\n');
  assert.equal(lines[0], `🟢 Virtual queue up for EB Games (dummy store) | ${store.url}/ebgames/`);
  assert.equal(lines[1], 'Estimated wait: 23 minutes');
  assert.match(lines[2], /leave the page alone: it refreshes itself — refreshing it yourself can lose your place/);
  assert.match(msg.embeds[0].footer.text, /^EB Games \| Mugibot Monitors /);
  // "Join the queue on my computer", and a link to the store.
  assert.deepEqual(msg.components[0].components.map((b) => b.custom_id || b.url), ['queue:demo-ebgames', `${store.url}/ebgames/`]);

  // A member can't say it's down (someone through the queue sees the store too).
  await seen(ashBrowser, 'down', 'probe');
  await seen(ashBrowser, 'down');
  assert.equal(g.get('demo-ebgames').status, 'up');
  // An admin's look as a new visitor: down once isn't enough, nor twice in a row at once.
  await seen(bossBrowser, 'down', 'probe');
  await seen(bossBrowser, 'down', 'probe');
  assert.equal(g.get('demo-ebgames').status, 'up');
  clock += 50 * 1000;
  await seen(bossBrowser, 'down', 'probe');
  assert.equal(g.get('demo-ebgames').status, 'down');
  await waitFor(() => gatePosts().length === before + 2, { message: 'the down post' });
  assert.equal(lastPost().body.embeds[0].description, `🔴 Virtual queue down for EB Games (dummy store) | ${store.url}/ebgames/`);
  assert.equal(lastPost().body.components, undefined, 'no Join button when it is down');
  // An admin's browser in the queue counts at once.
  await seen(bossBrowser, 'up', 'page', 40);
  assert.equal(g.get('demo-ebgames').status, 'up');
  assert.equal(g.get('demo-ebgames').source, 'browser');
  // (Back down for the next tests.)
  clock += 50 * 1000;
  await seen(bossBrowser, 'down', 'probe');
  clock += 50 * 1000;
  await seen(bossBrowser, 'down', 'probe');
  assert.equal(g.get('demo-ebgames').status, 'down');
});

test("an admin's browser looks at the queues as a new visitor every few minutes (every minute while one's up), with its searches", async () => {
  const g = env.app.gates;
  clock += 4 * MIN; // (the last test's looks: long enough ago)
  const due = (await bossBrowser.call('GET', '/api/ext/sweeps?v=1.16.0')).body;
  const probe = due.probes.find((p) => p.store === 'demo-ebgames');
  assert.ok(probe, JSON.stringify(due.probes));
  assert.equal(probe.url, `${store.url}/ebgames/`);
  assert.equal(probe.kind, 'queue');
  assert.ok(probe.page.text.length, 'with what the queue looks like');
  assert.ok(due.probes.some((p) => p.store === 'demo-pokemoncenter'));
  assert.ok(!due.probes.some((p) => p.store === 'ebgames'), 'not the real stores (the monitor is off in tests)');
  assert.deepEqual((await ashBrowser.call('GET', '/api/ext/sweeps?v=1.16.0')).body.probes || [], [], 'members never look');
  // Not again straight away; a minute while it's up, 3 minutes while it's down.
  assert.ok(!(await bossBrowser.call('GET', '/api/ext/sweeps?v=1.16.0')).body.probes.some((p) => p.store === 'demo-ebgames'));
  await bossBrowser.call('POST', '/api/ext/gates', { seen: [{ store: 'demo-ebgames', status: 'up', how: 'probe', wait: 5 }] });
  assert.equal(g.get('demo-ebgames').status, 'up');
  clock += 61 * 1000;
  assert.ok((await bossBrowser.call('GET', '/api/ext/sweeps?v=1.16.0')).body.probes.some((p) => p.store === 'demo-ebgames'), 'a minute later while it is up');
  clock += 50 * 1000;
  await bossBrowser.call('POST', '/api/ext/gates', { seen: [{ store: 'demo-ebgames', status: 'down', how: 'probe' }] });
  clock += 50 * 1000;
  await bossBrowser.call('POST', '/api/ext/gates', { seen: [{ store: 'demo-ebgames', status: 'down', how: 'probe' }] });
  assert.equal(g.get('demo-ebgames').status, 'down');
  clock += 61 * 1000;
  assert.ok(!(await bossBrowser.call('GET', '/api/ext/sweeps?v=1.16.0')).body.probes.some((p) => p.store === 'demo-ebgames'), 'down: every 3 minutes');
  clock += 3 * MIN;
  assert.ok((await bossBrowser.call('GET', '/api/ext/sweeps?v=1.16.0')).body.probes.some((p) => p.store === 'demo-ebgames'));
});

test('while a queue is up, browsers that aren\'t through it ask that store for nothing: no checks, no searches — the ones through it carry on', async () => {
  const g = env.app.gates;
  // (The server doesn't check the dummy EB Games, so Ash's browser does — the rest of his list isn't due.)
  env.app.repo.setSetting('retailer:demo-ebgames', { serverChecks: false });
  const checksDue = () => env.app.db.run("UPDATE items SET browser_next_at = CASE WHEN store = 'demo-ebgames' THEN 0 ELSE 9000000000000000 END");
  checksDue();
  assert.ok((await ashBrowser.call('GET', '/api/ext/checks')).body.checks.some((c) => c.store === 'demo-ebgames'), 'checked while the queue is down');
  g.flip(env.app.retailers.get('demo-ebgames'), 'up', { source: 'browser', wait: 10 });
  checksDue();
  assert.ok(!(await ashBrowser.call('GET', '/api/ext/checks')).body.checks.some((c) => c.store === 'demo-ebgames'), 'held while it is up');
  checksDue();
  assert.ok((await ashBrowser.call('GET', '/api/ext/checks?through=demo-ebgames')).body.checks.some((c) => c.store === 'demo-ebgames'), 'through it: checked');
  // The admin's searches there: held (and said once in the live monitor), unless through.
  env.app.sweeper.stat('demo-ebgames').browserNext = 0;
  let due = (await bossBrowser.call('GET', '/api/ext/sweeps?v=1.16.0')).body;
  assert.ok(!due.terms.some((t) => t.store === 'demo-ebgames'));
  assert.deepEqual(due.held, ['demo-ebgames']);
  assert.ok(env.app.sweeper.events.some((e) => e.type === 'sys' && /its virtual queue is up — searches from boss's browser wait/.test(e.message)));
  assert.equal(env.app.sweeper.live().stores.find((s) => s.id === 'demo-ebgames').status, 'held');
  due = (await bossBrowser.call('GET', '/api/ext/sweeps?v=1.16.0&through=demo-ebgames')).body;
  const term = due.terms.find((t) => t.store === 'demo-ebgames');
  assert.ok(term, 'through it: searched again');
  assert.equal(term.gate.kind, 'queue', 'with what its queue looks like (the tab is never navigated while it shows it)');
  // A search that runs into the queue: no failure, no backing off.
  const st = env.app.sweeper.stat('demo-ebgames');
  const fails = st.fails;
  await bossBrowser.call('POST', '/api/ext/sweeps', { results: [{ store: 'demo-ebgames', keyword: term.keyword, page: 1, ok: false, gate: { kind: 'queue', wait: 12 }, ms: 40 }] });
  assert.equal(st.fails, fails);
  assert.equal(g.get('demo-ebgames').wait, 12);
  g.flip(env.app.retailers.get('demo-ebgames'), 'down', { source: 'probe' });
  env.app.repo.setSetting('retailer:demo-ebgames', {});
});

test("the server's own page checks see a queue where the product should be: never read as its stock", async () => {
  const g = env.app.gates;
  store.shop('ebgames').queue.on = true;
  const url = store.productUrl('ebgames', '312345');
  const r = env.app.retailers.get('demo-ebgames');
  const a = await env.app.monitor.read(url, r);
  assert.equal(a.status, 'blocked');
  assert.match(a.error, /virtual queue was there instead of the page/);
  assert.equal(g.get('demo-ebgames').status, 'down', 'once from the server');
  await env.app.monitor.read(url, r);
  assert.equal(g.get('demo-ebgames').status, 'up', 'twice');
  assert.ok(store.shop('ebgames').queue.cookieless >= 2, 'the server is always a new visitor: nobody\'s place in line');
  g.flip(r, 'down', { source: 'probe' });
});

test('not seen for 30 minutes while it was looked for: down (and said so)', async () => {
  const g = env.app.gates;
  const r = env.app.retailers.get('demo-pokemoncenter');
  await bossBrowser.call('POST', '/api/ext/gates', { seen: [{ store: 'demo-pokemoncenter', status: 'up', how: 'page' }] });
  assert.equal(g.get('demo-pokemoncenter').status, 'up');
  const before = gatePosts().length;
  clock += 10 * MIN;
  // An admin's look that couldn't tell (a bot check's page) still counts as looking.
  await bossBrowser.call('POST', '/api/ext/gates', { seen: [{ store: 'demo-pokemoncenter', status: 'unknown', how: 'probe' }] });
  clock += 25 * MIN;
  g.expireStale();
  assert.equal(g.get('demo-pokemoncenter').status, 'down');
  assert.equal(g.get('demo-pokemoncenter').source, 'stale');
  await waitFor(() => gatePosts().length === before + 2, { message: `up and down posts (${gatePosts().slice(before).map((p) => p.body.embeds[0].description).join(' | ')}) ${JSON.stringify(env.app.db.all('SELECT * FROM gates'))} ${discord.state.messages.length}` });
  assert.equal(lastPost().body.embeds[0].description, `🔴 Virtual queue down for Pokémon Center (dummy store) | ${store.url}/pokemoncenter/?queue`);
  assert.equal(r.gate.kind, 'queue');
});

test('Auto-checkout through a queue: the checkout browsers of members armed there get in line (once), runs wait without timing out, then carry on with a fresh link', async () => {
  const g = env.app.gates;
  const eb = (await ash.get('/api/items')).body.items.find((x) => x.store === 'demo-ebgames');
  assert.equal((await ash.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 500, perDay: 3, spendPerDay: 1000 })).status, 200);
  assert.equal((await ash.put(`/api/items/${eb.id}`, { aco: true, maxPrice: 300 })).status, 200);
  const r = env.app.retailers.get('demo-ebgames');
  g.flip(r, 'up', { source: 'probe', wait: 23 });
  // His checkout browser: told to get in line at the store's front page — once.
  let next = (await ashBrowser.call('GET', '/api/ext/aco/next')).body;
  assert.deepEqual(next.lobbies.map((l) => [l.store, l.url, l.by]), [['demo-ebgames', `${store.url}/ebgames/`, 'auto']]);
  assert.ok(next.gates.some((x) => x.store === 'demo-ebgames' && x.kind === 'queue'), "and what's up");
  assert.deepEqual((await ashBrowser.call('GET', '/api/ext/aco/next')).body.lobbies, []);
  // The DM says his browser is getting in line.
  await waitFor(() => discord.dmsTo('d-ash').some((m) => /virtual queue is up/.test(m.body.embeds[0].title) && /Your checkout browser is getting in line/.test(m.body.embeds[0].description)), { message: "Ash's queue DM" });

  // It drops: the run waits in line (reported by his browser), not timing out at 10 minutes.
  const run = await env.app.aco.trigger(env.app.db.get('SELECT * FROM items WHERE id = :i', { i: eb.id }), { price: 99, source: 'browser' });
  assert.ok(run);
  next = (await ashBrowser.call('GET', '/api/ext/aco/next')).body;
  assert.equal(next.runs.length, 1);
  let rep = await ashBrowser.call('POST', `/api/ext/aco/${run.id}`, { status: 'waiting', reason: 'queue', message: 'In EB Games (dummy store)\'s virtual queue in this browser — about 23 min' });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.equal(rep.body.run.status, 'waiting');
  assert.equal(rep.body.run.statusText, 'Waiting in line');
  await waitFor(() => discord.dmsTo('d-ash').some((m) => /In EB Games \(dummy store\)'s queue/.test(m.body.embeds[0].title)), { message: 'the waiting DM' });
  const dms = discord.dmsTo('d-ash').length;
  for (let i = 0; i < 3; i++) {
    clock += 3 * MIN;
    await ashBrowser.call('POST', `/api/ext/aco/${run.id}`, { status: 'waiting', reason: 'queue', message: 'In EB Games (dummy store)\'s virtual queue in this browser — about 23 min' });
    env.app.aco.expire();
  }
  const row = env.app.db.get('SELECT * FROM aco_runs WHERE id = :id', { id: run.id });
  assert.equal(row.status, 'waiting', 'still waiting after 9 minutes and more');
  assert.equal(JSON.parse(row.steps).filter((s) => s.status === 'waiting').length, 1, 'the same message again is no new step');
  assert.equal(discord.dmsTo('d-ash').length, dms, 'told once');
  // Through: a fresh link (the first code is long gone), claimed as the run, carrying on.
  const link = await ashBrowser.call('POST', `/api/ext/aco/${run.id}/link`, {});
  assert.equal(link.status, 200);
  const code = new URL(link.body.url).hash.replace('#mgb-go=', '');
  const claim = (await ashBrowser.call('POST', '/api/ext/claim', { code })).body;
  assert.equal(claim.aco.runId, run.id);
  rep = await ashBrowser.call('POST', `/api/ext/aco/${run.id}`, { status: 'checkout', message: 'At checkout' });
  assert.equal(rep.body.run.status, 'checkout');
  // (Finished, for the next test.)
  await ashBrowser.call('POST', `/api/ext/aco/${run.id}`, { status: 'failed', reason: 'stopped', message: 'done' });
  assert.equal((await misty.get('/api/aco')).body.runs.length, 0, "nobody else's");
  g.flip(r, 'down', { source: 'probe' });
  assert.deepEqual((await ashBrowser.call('GET', '/api/ext/aco/next')).body.lobbies, [], 'down: no lobby');
});

test('waiting is not forever: lost touch for 10 minutes, a checkpoint unsolved for 20, a queue for 2 hours', async () => {
  const eb = (await ash.get('/api/items')).body.items.find((x) => x.store === 'demo-ebgames');
  const row = env.app.db.get('SELECT * FROM items WHERE id = :i', { i: eb.id });
  const start = async (reason) => {
    env.app.db.run("UPDATE aco_runs SET status = 'failed' WHERE status IN ('queued', 'sent', 'started', 'waiting', 'checkout', 'placing')");
    env.app.db.run('UPDATE items SET aco = 1 WHERE id = :i', { i: eb.id });
    const run = await env.app.aco.test(ash.user.id, eb.id);
    assert.ok(run.run, JSON.stringify(run));
    await ashBrowser.call('GET', '/api/ext/aco/next');
    await ashBrowser.call('POST', `/api/ext/aco/${run.run.id}`, { status: 'waiting', reason, message: reason === 'checkpoint' ? 'At the checkpoint — solve it in this tab' : 'In the queue' });
    return run.run.id;
  };
  const status = (id) => env.app.db.get('SELECT status, message FROM aco_runs WHERE id = :id', { id });
  let id = await start('queue');
  clock += 11 * MIN;
  env.app.aco.expire();
  assert.equal(status(id).status, 'failed');
  assert.match(status(id).message, /Lost touch with your browser while it waited at EB Games \(dummy store\)/);
  id = await start('checkpoint');
  assert.equal(toText(id), 'Waiting for you at the checkpoint');
  for (let i = 0; i < 4; i++) { clock += 5 * MIN; await ashBrowser.call('POST', `/api/ext/aco/${id}`, { status: 'waiting', reason: 'checkpoint', message: 'At the checkpoint — solve it in this tab' }); env.app.aco.expire(); }
  clock += MIN;
  env.app.aco.expire();
  assert.equal(status(id).status, 'failed');
  assert.match(status(id).message, /checkpoint wasn't solved within 20 minutes/);
  id = await start('queue');
  for (let i = 0; i < 14; i++) { clock += 9 * MIN; await ashBrowser.call('POST', `/api/ext/aco/${id}`, { status: 'waiting', reason: 'queue', message: `In the queue ${i}` }); env.app.aco.expire(); }
  assert.equal(status(id).status, 'failed');
  assert.match(status(id).message, /Still in EB Games \(dummy store\)'s queue after 2 hours/);
  env.app.db.run('UPDATE items SET aco = 0 WHERE id = :i', { i: row.id });

  function toText(runId) {
    return env.app.aco.list(ash.user.id).find((x) => x.id === runId).statusText;
  }
});

test('📥 "Join the queue on my computer": the presser\'s checkout browser gets in line — while the queue is up', async () => {
  const g = env.app.gates;
  const r = env.app.retailers.get('demo-ebgames');
  let res = await press('d-misty', 'queue:demo-ebgames');
  assert.match(res.content, /virtual queue isn't up right now — nothing to join/);
  g.flip(r, 'up', { source: 'probe', wait: 15 });
  res = await press('d-misty', 'queue:demo-ebgames');
  assert.match(res.content, /🚦 \*\*Misty laptop\*\* is getting in line at EB Games \(dummy store\): a tab of its own opens there and waits its turn\. Leave it alone/);
  assert.match(res.content, /isn't open right now/, 'not listening yet');
  const next = (await mistyBrowser.call('GET', '/api/ext/aco/next')).body;
  assert.deepEqual(next.lobbies.map((l) => [l.store, l.by]), [['demo-ebgames', 'discord']]);
  res = await press('d-nobody', 'queue:demo-ebgames');
  assert.match(res.content, /isn't connected to a Mugibot account/);
  assert.match((await press('d-misty', 'queue:kmart')).content, /doesn't have a virtual queue/);
  g.flip(r, 'down', { source: 'probe' });
});

test("Discord's ⚡ Buy reply while a run waits says where it is", () => {
  const aco = env.app.aco;
  const base = { name: 'Elite Trainer Box', store: 'demo-ebgames', status: 'waiting' };
  assert.match(aco.remoteText({ ...base, reason: 'queue', message: 'In the queue — about 23 min' }, 'Ash desktop'), /🚦 In EB Games \(dummy store\)'s virtual queue in \*\*Ash desktop\*\* — about 23 min\. It waits its turn \(never refreshing the page\), then checks out\./);
  assert.match(aco.remoteText({ ...base, store: 'demo-jbhifi', reason: 'checkpoint', message: '' }, 'Ash desktop'), /🛡️ JB Hi-Fi \(dummy store\)'s checkpoint wants a human, in \*\*Ash desktop\*\* \(its tab is in front, waiting\)\. .*\*\*🖥️ Solve it on my computer\*\* \(Chrome Remote Desktop\) and it carries on to checkout — or \*\*📱 Finish on this phone\*\*/);
});
