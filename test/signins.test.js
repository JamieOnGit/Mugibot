// Store sign-ins, 24/7 (Mugibot 2.0, server/signins.js): the stores each member keeps signed in to — EB Games, Premium
// Bandai, JB Hi-Fi, BIG W, Target and Kmart by default, admins included — and the moment the browser Mugibot checks out
// in says they're signed out at one, they're told: the dashboard, and a Discord DM with a "Sign in" button. Once, then
// at most twice a day while it stays so; said again when they're back in. Never for a store they don't keep, nor by DM
// when they've turned that off.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { DEFAULT_SIGNIN_STORES, REMIND_MS, STALE_MS } from '../server/signins.js';

let env;
let discord;
let clock;
let ash;
let boss;
let chrome;
let laptop;
let bossChrome;

before(async () => {
  discord = await startFakeDiscord();
  clock = { offset: 0 };
  env = await startApp({ demoStoreUrl: 'http://127.0.0.1:9', adminUsernames: 'boss', now: () => Date.now() + clock.offset, ...discordOpts(discord) });
  ash = await Client.signup(env.url, 'ash');
  makeMember(env, ash);
  env.app.repo.updateUser(ash.user.id, { discord_id: 'd-ash', discord_dm_channel: 'dm-d-ash' });
  chrome = await Device.pair(env.url, ash, 'Chrome on Windows');
  laptop = await Device.pair(env.url, ash, 'Laptop Chrome');
  boss = await Client.signup(env.url, 'boss');
  env.app.repo.updateUser(boss.user.id, { discord_id: 'd-boss', discord_dm_channel: 'dm-d-boss' });
  bossChrome = await Device.pair(env.url, boss, 'Boss Chrome');
  // (Ash's checkout browser: Chrome on Windows.)
  const win = env.app.repo.listDevices(ash.user.id).find((d) => d.name === 'Chrome on Windows');
  const r = await ash.put('/api/aco', { deviceId: win.id, fallback: false });
  assert.equal(r.status, 200, r.text);
});
after(async () => {
  await env.close();
  await discord.close();
});

const report = async (device, logins) => {
  const r = await device.call('POST', '/api/ext/logins', { logins });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // (The review runs after the answer: let it finish.)
  await new Promise((ok) => setTimeout(ok, 20));
  await Promise.all([...env.app.signins.busy.values()]);
};
const seen = (status, ago = 0) => ({ status, at: Date.now() + clock.offset - ago, how: 'probe' });
const dms = (id) => discord.dmsTo(id).map((m) => JSON.stringify(m.body));
const logins = async (c) => (await c.get('/api/logins')).body;

test('🔑 the stores kept signed in to by default: EB Games, Premium Bandai, JB Hi-Fi, BIG W, Target and Kmart — for members and admins alike (a dummy store\'s copy only when ticked)', async () => {
  assert.deepEqual([...DEFAULT_SIGNIN_STORES].sort(), ['bigw', 'ebgames', 'jbhifi', 'kmart', 'pbandai', 'target']);
  for (const c of [ash, boss]) {
    const d = await logins(c);
    assert.deepEqual(d.stores.filter((s) => s.keep).map((s) => s.id).sort(), ['bigw', 'ebgames', 'jbhifi', 'kmart', 'pbandai', 'target']);
    assert.equal(d.prefs.dm, true);
    assert.ok(d.stores.some((s) => s.id === 'demo-ebgames' && !s.keep), 'the other stores are listed, not kept');
  }
  // The extension is told which, to look at them now and then.
  const items = (await chrome.call('GET', '/api/ext/items')).body;
  assert.deepEqual([...items.signins].sort(), ['bigw', 'ebgames', 'jbhifi', 'kmart', 'pbandai', 'target']);
});

test('🔑 signed out at EB Games, as the checkout browser saw it: told at once — the dashboard, a Discord DM with a "Sign in" button to EB Games\' own sign-in page — once; reminded after 12 hours; told again when signed back in', async () => {
  const before = dms('d-ash').length;
  await report(chrome, { ebgames: seen('in') });
  assert.equal(dms('d-ash').length, before, 'signed in: nothing to say');
  await report(chrome, { ebgames: seen('out') });
  let fresh = dms('d-ash').slice(before);
  assert.equal(fresh.length, 1, fresh.join('\n'));
  assert.match(fresh[0], /🔑 Signed out of EB Games/);
  assert.match(fresh[0], /Not signed in in Chrome on Windows/);
  assert.match(fresh[0], /Sign in at EB Games/);
  assert.match(fresh[0], /https:\/\/www\.ebgames\.com\.au/);
  assert.ok(env.app.repo.listEvents(ash.user.id, { limit: 10 }).some((e) => /Signed out of EB Games/.test(e.message)), 'on the dashboard too');
  let d = (await logins(ash)).stores.find((s) => s.id === 'ebgames');
  assert.deepEqual([d.status, d.keep, d.device], ['out', true, 'Chrome on Windows']);
  assert.ok(d.since && d.alertedAt);
  // The same again (the extension reports every few minutes): not told twice.
  await report(chrome, { ebgames: seen('out') });
  assert.equal(dms('d-ash').slice(before).length, 1);
  // Still signed out 12 hours on: reminded.
  clock.offset += REMIND_MS + 1000;
  await report(chrome, { ebgames: seen('out') });
  fresh = dms('d-ash').slice(before);
  assert.equal(fresh.length, 2);
  assert.match(fresh[1], /Still signed out of EB Games/);
  // Signed back in: said so.
  await report(chrome, { ebgames: seen('in') });
  fresh = dms('d-ash').slice(before);
  assert.equal(fresh.length, 3);
  assert.match(fresh[2], /Signed in at EB Games again/);
  d = (await logins(ash)).stores.find((s) => s.id === 'ebgames');
  assert.deepEqual([d.status, d.alertedAt], ['in', null]);
});

test("🔑 the checkout browser's reading counts: signed out in another browser of yours tells you nothing while the checkout browser is signed in; a store you don't keep never tells you; an older report arriving late changes nothing", async () => {
  const before = dms('d-ash').length;
  await report(chrome, { pbandai: seen('in') });
  await report(laptop, { pbandai: seen('out') });
  assert.equal(dms('d-ash').length, before, 'the laptop isn\'t where Mugibot checks out');
  assert.equal((await logins(ash)).stores.find((s) => s.id === 'pbandai').status, 'in');
  // Zing isn't kept by default: signed out there, nothing.
  await report(chrome, { zing: seen('out') });
  assert.equal(dms('d-ash').length, before);
  // A late report (seen before the state it would replace): ignored.
  await report(chrome, { jbhifi: seen('in') });
  await report(chrome, { jbhifi: seen('out', 10 * 60 * 1000) });
  assert.equal(dms('d-ash').length, before);
});

test('🔑 your choice (Account → Store sign-ins): which stores you keep, and no DM if you turn it off — still on the dashboard; checked like any setting', async () => {
  let r = await ash.put('/api/logins/prefs', { stores: 'ebgames' });
  assert.equal(r.status, 400);
  r = await ash.put('/api/logins/prefs', { dm: 'no' });
  assert.equal(r.status, 400);
  r = await ash.put('/api/logins/prefs', { stores: ['zing', 'kmart', 'not-a-store'], dm: false });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.prefs, { stores: ['zing', 'kmart'], dm: false });
  const before = dms('d-ash').length;
  await report(chrome, { zing: seen('out'), ebgames: seen('out') });
  assert.equal(dms('d-ash').length, before, 'no DM');
  const evs = env.app.repo.listEvents(ash.user.id, { limit: 10 }).map((e) => e.message);
  assert.ok(evs.some((m) => /Signed out of Zing/.test(m)), evs.join('\n'));
  assert.ok(!evs.slice(0, 3).some((m) => /Signed out of EB Games/.test(m)), 'EB Games no longer kept');
  const d = await logins(ash);
  assert.deepEqual(d.stores.filter((s) => s.keep).map((s) => s.id).sort(), ['kmart', 'zing']);
  assert.equal(d.prefs.dm, false);
  // (Back to the six.)
  await ash.put('/api/logins/prefs', { stores: env.app.signins.defaults(), dm: true });
});

test('🔑 admins too: signed out at Kmart in their browser — told at once by DM; a reading not refreshed for 2 hours shows as not checked lately', async () => {
  const before = dms('d-boss').length;
  await report(bossChrome, { kmart: seen('out') });
  const fresh = dms('d-boss').slice(before);
  assert.equal(fresh.length, 1);
  assert.match(fresh[0], /Signed out of Kmart/);
  clock.offset += STALE_MS + 60 * 1000;
  const d = (await logins(boss)).stores.find((s) => s.id === 'kmart');
  assert.equal(d.stale, true);
});

test('🔑 a lapsed member: the state is kept, no alert (nothing can be bought for them anyway)', async () => {
  const misty = await Client.signup(env.url, 'misty');
  env.app.repo.updateUser(misty.user.id, { discord_id: 'd-misty', discord_dm_channel: 'dm-d-misty', plan: 'none', trial_ends_at: 1 });
  const dev = await Device.pair(env.url, misty, 'Misty Chrome');
  await report(dev, { target: seen('out') });
  assert.equal(dms('d-misty').length, 0);
  assert.equal((await logins(misty)).stores.find((s) => s.id === 'target').status, 'out');
});
