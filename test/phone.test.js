// A store's checkpoint from the phone (server/aco.js phoneState()/toPhone(), web/js/phone.js): Discord's
// ⚡ Buy pressed away from the computer meets JB Hi-Fi's checkpoint. The check is for the browser that
// checks out, so it's never solved on the phone for the computer: the member solves it on the computer
// from the phone (Chrome Remote Desktop), or finishes on the phone — the computer's checkout stops (only
// before it's got going, or while it waits at the check), and the phone gets the store's link.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, discordOpts, interactionKeys, makeMember, startApp, startFakeDiscord, waitFor } from './helpers.js';

let env;
let discord;
let keys;
let jess;
let desk;
let item;

before(async () => {
  discord = await startFakeDiscord();
  keys = interactionKeys();
  env = await startApp({ ...discordOpts(discord), discordPublicKey: keys.publicKey });
  jess = await Client.signup(env.url, 'jess');
  makeMember(env, jess);
  discord.state.users['d-jess'] = { id: 'd-jess', username: 'jess' };
  discord.state.nextUser = 'd-jess';
  const start = await jess.get('/auth/discord');
  const consent = await fetch(new URL(start.headers.get('location')), { redirect: 'manual' });
  const cb = new URL(consent.headers.get('location'));
  await jess.get(cb.pathname + cb.search);
  for (const it of (await jess.get('/api/items')).body.items) await jess.del(`/api/items/${it.id}`);
  const add = await jess.post('/api/items', { url: 'https://www.jbhifi.com.au/products/pokemon-tcg-prismatic-evolutions-booster-bundle', name: 'Prismatic Bundle', maxPrice: 80 });
  assert.equal(add.status, 200, add.text);
  item = add.body;
  // JB Hi-Fi's catalogue knows its option, so the phone gets Shopify's cart link with it in.
  const p = env.app.catalog.upsertProduct({ store: 'jbhifi', sku: item.sku, url: item.url, name: 'Prismatic Bundle' });
  env.app.catalog.updateProduct(p.id, { variant_id: '4455667788', price: 60 });
  desk = await Device.pair(env.url, jess, 'Jess desktop');
  await desk.call('GET', '/api/ext/me?v=1.21.0');
});
after(async () => {
  await env.close();
  await discord.close();
});

let presses = 0;
async function press(customId) {
  presses += 1;
  const token = `ptok-${presses}`;
  const body = JSON.stringify({ type: 3, id: `pi-${presses}`, token, member: { user: { id: 'd-jess' } }, data: { custom_id: customId, component_type: 2 } });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${env.url}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': keys.sign(ts, body), 'x-signature-timestamp': ts }, body });
  const out = await res.json();
  return { content: out.data.content, buttons: ((out.data.components || [])[0] || { components: [] }).components, token };
}
const runOf = () => env.app.db.get('SELECT * FROM aco_runs WHERE item_id = :i ORDER BY created_at DESC LIMIT 1', { i: item.id });
const finishRuns = () => env.app.db.run("UPDATE aco_runs SET status = 'failed' WHERE status IN ('queued', 'sent', 'started', 'waiting', 'checkout', 'placing')");
const linkParts = (url) => { const u = new URL(url); return { id: u.pathname.split('/').pop(), t: u.searchParams.get('t'), path: u.pathname + u.search }; };
const phoneApi = (method, link, body) => fetch(`${env.url}/api/phone/${link.id}${method === 'GET' ? `?t=${encodeURIComponent(link.t)}` : ''}`, {
  method, headers: { 'content-type': 'application/json', 'x-mugibot': '1' }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const lastEdit = (token) => env.app && discord.state.edits.filter((e) => e.token === token).at(-1);

/** ⚡ Buy pressed, the desktop picks it up and waits at JB Hi-Fi's checkpoint. */
async function atCheckpoint() {
  finishRuns();
  const r = await press(`buy:i:${item.id}`);
  const next = (await desk.call('GET', '/api/ext/aco/next')).body;
  assert.equal(next.runs.length, 1);
  const code = new URL(next.runs[0].url).hash.replace('#mgb-go=', '');
  assert.equal((await desk.call('POST', '/api/ext/claim', { code })).status, 200);
  const row = runOf();
  await desk.call('POST', `/api/ext/aco/${row.id}`, { status: 'waiting', reason: 'checkpoint', message: "At JB Hi-Fi's checkpoint — solve it in this tab" });
  return { r, row: runOf() };
}

test("🛡️ ⚡ Buy pressed while JB Hi-Fi's checkpoint is up: the reply says the computer will stop at it, and offers both ways through from the phone", async () => {
  const gates = env.app.gates;
  const jb = env.app.retailers.get('jbhifi');
  gates.flip(jb, 'up', { source: 'probe' });
  try {
    const r = await press(`buy:i:${item.id}`);
    assert.match(r.content, /🛡️ \*\*JB Hi-Fi's checkpoint is up right now\*\*: \*\*Jess desktop\*\* will stop at it for a human check — a check for that browser, so solving it on your phone can't let it through/);
    assert.deepEqual(r.buttons.map((b) => [b.style, b.label]), [[5, '📱 Finish on this phone'], [5, '🖥️ Solve it on my computer']]);
    assert.equal(r.buttons[1].url, 'https://remotedesktop.google.com/access');
    assert.match(r.buttons[0].url, new RegExp(`^${env.url}/phone/acr_[\\w-]+\\?t=\\d+\\.[\\w-]{43}$`));
    // Before the computer has started it: the phone takes it over, and the computer never does.
    const link = linkParts(r.buttons[0].url);
    const info = await phoneApi('GET', link);
    assert.equal(info.status, 200);
    assert.deepEqual([info.body.name, info.body.storeName, info.body.can, info.body.stop, info.body.checkpoint], ['Prismatic Bundle', 'JB Hi-Fi', true, true, false]);
    const out = await phoneApi('POST', link, { t: link.t });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.url, 'https://www.jbhifi.com.au/cart/4455667788:1', "Shopify's cart link with it in — no ⚡ Buy code: there's no extension on the phone");
    assert.deepEqual([runOf().status, runOf().reason], ['skipped', 'phone']);
    assert.deepEqual((await desk.call('GET', '/api/ext/aco/next')).body.runs, [], 'the computer gets nothing to start');
  } finally {
    gates.flip(jb, 'down', { source: 'probe' });
  }
});

test('📱 at the checkpoint: the reply follows it with both buttons; "Finish on this phone" stops the computer there, and its browser hears the run is over (it never carries on to the final button)', async () => {
  const { r, row } = await atCheckpoint();
  assert.deepEqual([row.status, row.reason], ['waiting', 'checkpoint']);
  await waitFor(() => (lastEdit(r.token) || { body: {} }).body.components?.length, { message: 'the reply got its buttons' });
  const edit = lastEdit(r.token).body;
  assert.match(edit.content, /🛡️ JB Hi-Fi's checkpoint wants a human, in \*\*Jess desktop\*\* \(its tab is in front, waiting\)\. The check is for that browser, so solving it on your phone wouldn't let it through/);
  const buttons = edit.components[0].components;
  assert.deepEqual(buttons.map((b) => b.label), ['📱 Finish on this phone', '🖥️ Solve it on my computer']);
  // The DM says the same, with the same two ways.
  const dm = discord.dmsTo('d-jess').filter((m) => /checkpoint needs you: Prismatic Bundle/.test(m.body.embeds[0].title)).at(-1);
  assert.ok(dm, 'a DM about the checkpoint');
  assert.match(dm.body.embeds[0].description, /On your phone: solve it on the computer with Chrome Remote Desktop \(the tab's in front\), or finish it on the phone instead/);
  assert.deepEqual(dm.body.components[0].components.map((b) => b.label).slice(0, 2), ['📱 Finish on this phone', '🖥️ Solve it on my computer']);

  // Opening the link only shows what pressing does (a link checker's look changes nothing).
  const link = linkParts(buttons[0].url);
  const page = await fetch(`${env.url}${link.path}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Finish on this phone/);
  const info = (await phoneApi('GET', link)).body;
  assert.deepEqual([info.can, info.stop, info.checkpoint, info.statusText], [true, true, true, 'Waiting for you at the checkpoint']);
  assert.equal(runOf().status, 'waiting', 'still waiting: nothing happened by looking');
  // A link Mugibot didn't make (or someone else's run) does nothing.
  assert.equal((await phoneApi('GET', { id: row.id, t: `${Date.now() + 60000}.${'x'.repeat(43)}` })).status, 404);
  assert.equal((await phoneApi('POST', { id: row.id }, { t: 'nope' })).status, 409);

  const out = await phoneApi('POST', link, { t: link.t });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual([out.body.url, out.body.stopped], ['https://www.jbhifi.com.au/cart/4455667788:1', true]);
  const done = runOf();
  assert.deepEqual([done.status, done.reason], ['skipped', 'phone']);
  assert.match(done.message, /You finished it on your phone instead — your computer stopped at JB Hi-Fi's checkpoint/);
  await waitFor(() => /📱 \*\*Finishing it on your phone\*\* — \*\*Jess desktop\*\* stopped/.test(lastEdit(r.token).body.content), { message: 'the reply says so' });
  assert.deepEqual(lastEdit(r.token).body.components, [], 'no buttons once it\'s over');
  // The computer's tab: still at the check, or just through it — either way its account says the run is over.
  for (const status of ['waiting', 'started']) {
    const said = await desk.call('POST', `/api/ext/aco/${row.id}`, { status, reason: status === 'waiting' ? 'checkpoint' : '', message: 'x' });
    assert.equal(said.body.run.active, false, `${status}: the run is over`);
    assert.equal(said.body.run.status, 'skipped');
  }
  // Pressed again (the phone's tab closed): the store's link again, nothing else to stop.
  const again = await phoneApi('POST', link, { t: link.t });
  assert.deepEqual([again.status, again.body.stopped], [200, false]);
  assert.ok((await jess.get('/api/events')).body.events.some((e) => /📱 Prismatic Bundle: finishing it on your phone — your computer's checkout at JB Hi-Fi stopped/.test(e.message)));
});

test("a ⚡ Buy code for a run finished on the phone opens nothing on the computer", async () => {
  finishRuns();
  await press(`buy:i:${item.id}`);
  const next = (await desk.call('GET', '/api/ext/aco/next')).body;
  const code = new URL(next.runs[0].url).hash.replace('#mgb-go=', '');
  const row = runOf();
  assert.equal(row.status, 'sent');
  const link = linkParts(env.app.aco.phoneLink(env.app.db.get('SELECT user_id FROM aco_runs WHERE id = :id', { id: row.id }).user_id, row.id));
  assert.equal((await phoneApi('POST', link, { t: link.t })).status, 200);
  const claim = await desk.call('POST', '/api/ext/claim', { code });
  assert.equal(claim.status, 409);
  assert.match(claim.body.error, /You finished this one on your phone — nothing to do here/);
});

test('never once the computer may be paying, nor where it can\'t be stopped: checking out, the final button pressed, placed, an older extension at the check', async () => {
  const { row } = await atCheckpoint();
  const userId = row.user_id;
  const link = linkParts(env.app.aco.phoneLink(userId, row.id));
  // Through the checkpoint a moment before the phone pressed: it carries on — the phone is told not to buy it too.
  await desk.call('POST', `/api/ext/aco/${row.id}`, { status: 'started', message: 'Through' });
  await desk.call('POST', `/api/ext/aco/${row.id}`, { status: 'checkout', message: 'At checkout' });
  let out = await phoneApi('POST', link, { t: link.t });
  assert.equal(out.status, 409);
  assert.match(out.body.error, /Your computer is checking it out at JB Hi-Fi right now — let it finish/);
  assert.equal(runOf().status, 'checkout', 'untouched');
  await desk.call('POST', `/api/ext/aco/${row.id}`, { status: 'placing', message: 'Final button pressed' });
  out = await phoneApi('POST', link, { t: link.t });
  assert.match(out.body.error, /Your computer pressed JB Hi-Fi's final button — check your email from the store/);
  await desk.call('POST', `/api/ext/aco/${row.id}`, { status: 'placed', message: 'Order placed', pressed: true });
  out = await phoneApi('POST', link, { t: link.t });
  assert.match(out.body.error, /already placed the order at JB Hi-Fi/);
  assert.equal(runOf().status, 'placed');

  // An older extension (1.20) carries on by itself once through the check: it can't be stopped from the phone.
  await desk.call('GET', '/api/ext/me?v=1.20.0');
  try {
    const { r, row: old } = await atCheckpoint();
    const info = (await phoneApi('GET', linkParts(env.app.aco.phoneLink(userId, old.id)))).body;
    assert.equal(info.can, false);
    assert.match(info.note, /Jess desktop has an older copy of Mugibot's extension \(1\.20\.0\), which can't be stopped at the checkpoint from here\. Solve the check on your computer \(from your phone: Chrome Remote Desktop\), and update the extension to 1\.21\.0/);
    await waitFor(() => (lastEdit(r.token) || { body: {} }).body.components?.length, { message: 'the reply got its buttons' });
    assert.deepEqual(lastEdit(r.token).body.components[0].components.map((b) => b.label), ['🖥️ Solve it on my computer'], 'only the way that works');
  } finally {
    await desk.call('GET', '/api/ext/me?v=1.21.0');
  }
});

test('Auto-checkout at the checkpoint (armed, not pressed): finished on the phone, it\'s disarmed — one purchase per arming', async () => {
  finishRuns();
  assert.equal((await jess.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 400, perDay: 5, spendPerDay: 2000 })).status, 200);
  assert.equal((await jess.put(`/api/items/${item.id}`, { aco: true, maxPrice: 80 })).status, 200);
  const run = await env.app.aco.test(jess.user.id, item.id);
  assert.ok(run.run, JSON.stringify(run));
  await desk.call('GET', '/api/ext/aco/next');
  await desk.call('POST', `/api/ext/aco/${run.run.id}`, { status: 'waiting', reason: 'checkpoint', message: "At JB Hi-Fi's checkpoint" });
  const out = await env.app.aco.toPhone(run.run.id, linkParts(env.app.aco.phoneLink(jess.user.id, run.run.id)).t);
  assert.equal(out.stopped, true);
  assert.equal((await jess.get('/api/items')).body.items.find((x) => x.id === item.id).aco, false, 'disarmed');
  assert.ok((await jess.get('/api/events')).body.events.some((e) => /it's disarmed \(arm it again for the next drop\)/.test(e.message)));
});
