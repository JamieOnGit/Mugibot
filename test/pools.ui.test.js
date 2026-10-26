// 🤝 Pools in a real browser (no extension): the admin console's Members → Pools (make one, ask members to join,
// see who checks out with the leader), and a member's own say on their dashboard — joining, checking out with the
// leader (agreed to, with the most it may cost them), skipping one of the leader's items, leaving — with the leader's
// watchlist, armed items and drop watches on theirs, kept in step live while their page is open.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { Client, makeMember, startApp, waitFor } from './helpers.js';
import { RETAILER_DEFS } from '../server/retailers/index.js';

let env;
let browser;
let boss; // an admin: leads the pool
let ash; // a member: joins it
let bossPage;
let ashPage;
const errors = [];
const shots = process.env.MUGIBOT_SCREENSHOT_DIR;
const KMART = (sku) => `https://www.kmart.com.au/product/pokemon-tcg-test-${sku}/`;

async function pageFor(c, viewport = { width: 1280, height: 900 }) {
  const p = await browser.newPage({ viewport });
  p.on('pageerror', (e) => errors.push(e.message));
  // (A 4xx answer to a mistake is expected, not an error.)
  p.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
  p.on('dialog', (d) => d.accept());
  await p.context().addCookies([{ name: 'mgb_session', value: c.cookie.split('=')[1], url: env.url }]);
  return p;
}

before(async () => {
  env = await startApp({ adminUsernames: 'boss' });
  // Never touch the real stores from tests.
  const stores = [...new Set(RETAILER_DEFS.flatMap((r) => r.hosts))];
  browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=${stores.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`, '--no-proxy-server'] });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  for (const c of [boss, ash]) {
    makeMember(env, c);
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
    assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 2000, perDay: 10, spendPerDay: 20000 })).status, 200);
  }
  bossPage = await pageFor(boss);
  ashPage = await pageFor(ash);
});
after(async () => {
  await browser?.close();
  await env.close();
});

const ashItems = async () => (await ash.get('/api/items')).body.items;

test('admin console → Members → Pools: make a pool, ask a member to join (a name that isn\'t anyone\'s is said so), see them asked', async () => {
  await bossPage.goto(`${env.url}/admin#members`);
  await bossPage.waitForSelector('#pools-card:visible');
  assert.match(await bossPage.textContent('#pools'), /No pools yet/);
  assert.match(await bossPage.textContent('#pools-card'), /only they can switch on checking out with the leader/);
  await bossPage.fill('#pool-name', 'Boss crew');
  await bossPage.click('#pool-new button[type=submit]');
  await bossPage.waitForSelector('#pools section.pool');
  assert.match(await bossPage.textContent('#pools section.pool'), /🤝 Boss crew.*Led by boss · 0 joined · 0 check out with the leader.*Nobody asked yet\./s);
  assert.equal(await bossPage.inputValue('#pool-name'), '');

  const ask = async (who) => {
    await bossPage.fill('#pools section.pool .pool-invite input[name=username]', who);
    await bossPage.click('#pools section.pool .pool-invite button[type=submit]');
  };
  await ask('nobody');
  await bossPage.waitForFunction(() => /no member called/i.test(document.querySelector('#toasts')?.textContent || ''));
  await ask('ash');
  await bossPage.waitForSelector('#pools tr[data-user="ash"]');
  assert.match(await bossPage.textContent('#pools tr[data-user="ash"]'), /ash.*Asked — not answered yet.*Cancel ask/s);
  if (shots) await bossPage.locator('#pools-card').screenshot({ path: path.join(shots, 'pools-admin.png') });
});

test('the member\'s 🤝 Pool card (Checkout page, #pool from the DM): the invitation, said plainly — Join puts the leader\'s watchlist on theirs', async () => {
  await boss.post('/api/items', { url: KMART('43818648'), name: 'Day UPC', maxPrice: 380 });
  await ashPage.goto(`${env.url}/app#pool`);
  await ashPage.waitForSelector('[data-panel="aco"]:not([hidden]) #pool-card:not([hidden]) .pool-invite');
  assert.equal(await ashPage.isVisible('#pool-jump'), true, 'the jump row has 🤝 Pool');
  const inv = await ashPage.textContent('#pool-invites');
  assert.match(inv, /boss asks you to join their pool "Boss crew"/);
  assert.match(inv, /Nothing is bought for you unless you switch on checking out with them/);
  assert.equal(await ashPage.isVisible('#pool-mine'), false);
  assert.equal((await ashItems()).length, 0, 'asked, not in: nothing of boss\'s yet');
  if (shots) await ashPage.locator('#pool-card').screenshot({ path: path.join(shots, 'pool-invite.png') });

  await ashPage.click('#pool-invites button:has-text("Join")');
  await ashPage.waitForSelector('#pool-mine:not([hidden])');
  assert.equal(await ashPage.textContent('#pool-state'), 'Watchlist shared');
  assert.match(await ashPage.textContent('#pool-line'), /boss's pool "Boss crew" — you joined .* · 1 member\. 1 of their items is on your watchlist \(🤝\), and their drop watches are on yours\./);
  assert.equal(await ashPage.getAttribute('#pool-follow', 'aria-checked'), 'false');
  assert.match(await ashPage.textContent('#pool-follow-label'), /Checking out with boss is off/);
  assert.match(await ashPage.textContent('#pool-follow-note'), /nothing is bought for you/);
  assert.equal(await ashPage.isVisible('#pool-invites .pool-invite'), false);
  // (The admin console says so.)
  await bossPage.reload();
  await bossPage.waitForSelector('#pools tr[data-user="ash"]');
  assert.match(await bossPage.textContent('#pools tr[data-user="ash"]'), /Joined.*Watchlist only.*Take out/s);
});

test('🤝 on the member\'s watchlist, live: what the leader adds, renames and removes shows up while the page is open — no Edit, Pause or ✕ on theirs, just 🤝 Skip', async () => {
  await ashPage.goto(`${env.url}/app#watch`);
  await ashPage.waitForSelector('#w-list li.pooled');
  const row = ashPage.locator('#w-list li.pooled', { hasText: 'Day UPC' });
  assert.match(await row.textContent(), /🤝 boss's/);
  for (const b of ['Edit', 'Pause', '✕']) assert.equal(await row.locator(`button:text-is("${b}")`).count(), 0, `no ${b}`);
  assert.equal(await row.locator('button:has-text("🤝 Skip")').count(), 1);
  assert.equal(await row.locator('button:has-text("⚡ Buy")').count(), 1, 'their own ⚡ Buy, as on any item');
  if (shots) await ashPage.locator('#w-list').screenshot({ path: path.join(shots, 'pool-watchlist.png') });

  // The leader adds one: it's on ash's page by itself.
  const b = (await boss.post('/api/items', { url: KMART('43818649'), name: 'Elite Trainer Box', maxPrice: 120 })).body;
  await ashPage.waitForSelector('#w-list li.pooled:has-text("Elite Trainer Box")', { timeout: 5000 });
  // …renames it: renamed there too.
  await boss.put(`/api/items/${b.id}`, { name: 'Elite Trainer Box (Prismatic)' });
  await ashPage.waitForSelector('#w-list li.pooled:has-text("Elite Trainer Box (Prismatic)")', { timeout: 5000 });
  // …and removes it: gone.
  await boss.del(`/api/items/${b.id}`);
  await ashPage.waitForFunction(() => !/Elite Trainer Box/.test(document.querySelector('#w-list').textContent), null, { timeout: 5000 });
  assert.equal(await ashPage.locator('#w-list li.pooled').count(), 1);
});

test('checking out with the leader: only with the agreement ticked and the most it may cost an item — then the leader\'s armed items are armed on theirs (as the leader\'s are), and the console says so', async () => {
  await ashPage.goto(`${env.url}/app#pool`);
  await ashPage.waitForSelector('#pool-mine:not([hidden])');
  assert.equal(await ashPage.isVisible('#pool-agree-wrap'), true, 'the agreement, the first time');
  assert.match(await ashPage.textContent('#pool-agree-text'), /when boss starts an Auto-checkout — or one of their armed items drops — Mugibot checks out the same item for me, by itself, in my checkout browser, with my saved card and delivery details/);
  assert.equal(await ashPage.isDisabled('#pool-save'), true, 'the most an item is saved once it\'s on');

  await ashPage.click('#pool-follow');
  assert.match(await ashPage.textContent('#pool-msg'), /Tick the box to agree first/);
  await ashPage.check('#pool-agree');
  await ashPage.click('#pool-follow');
  assert.match(await ashPage.textContent('#pool-msg'), /Set the most it may cost you an item first/);
  assert.equal((await ash.get('/api/pool')).body.pool.followAco, false, 'still off');
  await ashPage.fill('#pool-cap', '300');
  await ashPage.click('#pool-follow');
  await ashPage.waitForSelector('#pool-follow[aria-checked="true"]');
  assert.equal(await ashPage.textContent('#pool-state'), 'Checking out with boss');
  assert.match(await ashPage.textContent('#pool-follow-note'), /When boss's Auto-checkout starts — their ⚡ Buy \(here or in Discord\), Trigger ACO, or one of their armed items dropping — yours starts for the same item at once, in your checkout browser, with your card and details, up to \$300\.00 an item/);
  assert.equal(await ashPage.isVisible('#pool-agree-wrap'), false, 'agreed once');
  assert.equal(await ashPage.isDisabled('#pool-save'), false);
  const p = (await ash.get('/api/pool')).body.pool;
  assert.deepEqual([p.followAco, p.cap, p.agreed], [true, 300, true]);
  if (shots) await ashPage.locator('#pool-card').screenshot({ path: path.join(shots, 'pool-following.png') });

  // The most an item, changed and saved.
  await ashPage.fill('#pool-cap', '250');
  await ashPage.click('#pool-save');
  await waitFor(async () => (await ash.get('/api/pool')).body.pool.cap === 250, { message: 'cap saved' });

  // The leader arms theirs: armed on ash's — at boss's max, never over ash's most for the pool.
  const day = (await boss.get('/api/items')).body.items.find((it) => it.name === 'Day UPC');
  await boss.put(`/api/items/${day.id}`, { aco: true, maxPrice: 380 });
  await waitFor(async () => (await ashItems()).find((it) => it.pool && it.aco), { message: 'armed on ash\'s' });
  assert.equal((await ashItems()).find((it) => it.pool).maxPrice, 250);

  await bossPage.reload();
  await bossPage.waitForSelector('#pools tr[data-user="ash"]');
  assert.match(await bossPage.textContent('#pools tr[data-user="ash"]'), /🤖 Checks out with the leader/);
  assert.match(await bossPage.textContent('#pools section.pool'), /1 joined · 1 checks out with the leader/);
});

test('🎯 Armed: the leader\'s armed item is armed on theirs — its switch and max are the leader\'s (not theirs to change); 🤝 Skip disarms it, Follow again arms it again', async () => {
  await ashPage.goto(`${env.url}/app#armed`);
  const row = ashPage.locator('#aco-items li.ar-row', { hasText: 'Day UPC' });
  await row.waitFor();
  assert.match(await row.textContent(), /🤝 boss's/);
  assert.equal(await row.locator('.sn-sw').getAttribute('aria-checked'), 'true');
  assert.equal(await row.locator('.sn-sw').isDisabled(), true);
  assert.equal(await row.locator('input.aco-max').isDisabled(), true);
  assert.equal(await row.locator('input.aco-max').inputValue(), '250');
  if (shots) await ashPage.locator('#aco-items').screenshot({ path: path.join(shots, 'pool-armed.png') });

  await row.locator('button:has-text("🤝 Skip")').click();
  await ashPage.waitForSelector('#aco-items li.ar-row:has-text("Day UPC") button:has-text("🤝 Follow again")');
  assert.equal(await ashPage.locator('#aco-items li.ar-row:has-text("Day UPC") .sn-sw').getAttribute('aria-checked'), 'false');
  assert.match(await ashPage.textContent('#aco-items li.ar-row:has-text("Day UPC")'), /🤝 boss's · skipped/);
  assert.equal((await ashItems()).find((it) => it.pool).aco, false);

  await ashPage.click('#aco-items li.ar-row:has-text("Day UPC") button:has-text("🤝 Follow again")');
  await ashPage.waitForSelector('#aco-items li.ar-row:has-text("Day UPC") .sn-sw[aria-checked="true"]');
  assert.equal((await ashItems()).find((it) => it.pool).aco, true);
});

test('the leader\'s Trigger ACO starts the member\'s too: it\'s in their run history as "🤝 with your pool"', async () => {
  const day = (await boss.get('/api/items')).body.items.find((it) => it.name === 'Day UPC');
  assert.equal((await boss.post(`/api/aco/test/${day.id}`, {})).status, 200);
  await waitFor(() => env.app.db.get("SELECT 1 AS y FROM aco_runs WHERE user_id = :u AND trigger = 'pool'", { u: ash.user.id }), { message: 'ash\'s run' });
  await ashPage.goto(`${env.url}/app#aco`);
  await ashPage.waitForFunction(() => /🤝 with your pool/.test(document.querySelector('#aco-runs')?.textContent || ''), null, { timeout: 5000 });
  assert.match(await ashPage.textContent('#aco-runs'), /Day UPC/);
  // (Nobody's browser is connected here: both runs are ended.)
  for (const r of env.app.db.all("SELECT id, user_id FROM aco_runs WHERE status IN ('queued', 'sent', 'started')")) await env.app.aco.finish(r.user_id, env.app.aco.get(r.user_id, r.id), 'failed', 'stopped', 'stopped');
});

test('🎯 Drop watches: the leader\'s own watches in a list of their own ("🤝 From your pool — boss\'s"), live — not the member\'s to change or remove', async () => {
  await ashPage.goto(`${env.url}/app#drops`);
  await ashPage.waitForSelector('[data-panel="monitor"]:not([hidden]) #pp-drops:not([hidden])');
  assert.equal(await ashPage.isVisible('#dw-pool-box'), false);
  const w = await boss.post('/api/drops', { store: 'kmart', words: 'charizard premium', shared: false });
  assert.equal(w.status, 200, w.text);
  await ashPage.waitForSelector('#dw-pool-box:not([hidden]) #dw-pool li.dw-row', { timeout: 5000 });
  assert.equal(await ashPage.textContent('#dw-pool-h'), "🤝 From your pool — boss's");
  const row = ashPage.locator('#dw-pool li.dw-row');
  assert.match(await row.textContent(), /"charizard premium".*🤝 boss's — what it finds is on your watchlist as theirs is/s);
  assert.equal(await row.locator('button:has-text("Remove")').count(), 0);
  assert.equal(await ashPage.locator('#dw-mine li.dw-row').count(), 0, 'not among theirs');
  if (shots) await ashPage.locator('#dw-pool-box').screenshot({ path: path.join(shots, 'pool-drops.png') });
  await boss.del(`/api/drops/${w.body.watch.id}`);
  await ashPage.waitForSelector('#dw-pool-box[hidden]', { state: 'attached', timeout: 5000 });
});

test('the leader\'s own 🤝 Pool card: who\'s in, who checks out with them; a phone-sized screen has no sideways scrolling', async () => {
  await bossPage.goto(`${env.url}/app#pool`);
  await bossPage.waitForSelector('#pool-card:not([hidden]) .pool-lead');
  assert.equal(await bossPage.textContent('#pool-state'), 'You lead');
  assert.match(await bossPage.textContent('.pool-lead'), /You lead "Boss crew" — 1 member, 1 checking out with you\..*ash 🤖 checks out with you/s);
  assert.equal(await bossPage.isVisible('#pool-mine'), false);
  if (shots) await bossPage.locator('#pool-card').screenshot({ path: path.join(shots, 'pool-leader.png') });
  for (const [c, hash] of [[ash, 'pool'], [ash, 'watch'], [ash, 'armed'], [boss, 'pool']]) {
    const phone = await pageFor(c, { width: 375, height: 800 });
    await phone.goto(`${env.url}/app#${hash}`);
    await phone.waitForSelector(hash === 'pool' ? '#pool-card:not([hidden])' : '[data-panel="monitor"]:not([hidden])');
    await phone.waitForTimeout(300);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `#${hash} (${c.user.username}) overflows by ${overflow}px`);
    await phone.close();
  }
});

test('Leave the pool (asked first): the leader\'s items come off the watchlist, and the card goes', async () => {
  await ashPage.goto(`${env.url}/app#pool`);
  await ashPage.waitForSelector('#pool-mine:not([hidden])');
  await ashPage.click('#pool-leave');
  await ashPage.waitForSelector('#pool-card[hidden]', { state: 'attached' });
  assert.equal(await ashPage.isVisible('#pool-jump'), false);
  await waitFor(async () => !(await ashItems()).some((it) => it.pool), { message: 'copies gone' });
  assert.equal((await ash.get('/api/pool')).body.pool, null);
  await bossPage.goto(`${env.url}/admin#members`);
  await bossPage.waitForSelector('#pools section.pool');
  assert.match(await bossPage.textContent('#pools section.pool'), /Nobody asked yet/);
});

test('no JavaScript errors on any pool page', () => {
  assert.deepEqual(errors, []);
});
