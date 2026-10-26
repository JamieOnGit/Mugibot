// A store's virtual queue whose page draws its words a moment after each time it opens — and refreshes itself every few
// seconds (EB Games' waiting room, as the dummy store has it). For that moment after each refresh the tab looks like
// the store, not the queue. Nothing of Mugibot's may ask the store for anything while the tab is in line: a request
// in that moment is "asked again too soon", and the place in line is lost. Here: the extension's own checks of your EB
// Games items, due again and again while you wait — none reaches EB until you're through, and the place is kept.
// (The real extension in Chromium, the dashboard, and the dummy store — like extension.e2e.test.js.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { writeExtension } from '../server/extension.js';
import { RETAILER_DEFS } from '../server/retailers/index.js';
import { startMockStore } from '../devtools/mockstore.js';
import { PASSWORD, startApp, waitFor } from './helpers.js';

let env;
let store;
let ctx;
let sw;
const dirs = [];
const NO_STORES = [`--host-resolver-rules=${[...new Set(RETAILER_DEFS.flatMap((r) => r.hosts))].map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`, '--no-proxy-server'];

before(async () => {
  store = await startMockStore();
  env = await startApp({ demoStoreUrl: store.url, allowPrivateHosts: true, hostGapSeconds: 0 });
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-q-ext-'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-q-chrome-'));
  dirs.push(extDir, profileDir);
  writeExtension(env.app.cfg, extDir);
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...NO_STORES],
  });
  const ours = (w) => /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(w.url());
  sw = ctx.serviceWorkers().find(ours) || await ctx.waitForEvent('serviceworker', { predicate: ours });
  await waitFor(async () => (await sw.evaluate(() => typeof chrome.storage).catch(() => '')) === 'object', { message: "the extension's APIs ready", timeout: 15000 });
  // Sign up and connect this browser.
  const page = await ctx.newPage();
  await page.goto(`${env.url}/signup`);
  await page.fill('#su-username', 'ash');
  await page.fill('#su-password', PASSWORD);
  await page.check('#su-terms');
  await page.click('#signup button[type=submit]');
  await page.waitForURL(/\/app/);
  env.app.repo.updateUser(env.app.repo.userByUsername('ash').id, { plan: 'active' });
  await page.goto(`${env.url}/app#extension`);
  await page.waitForFunction(() => /installed but not connected/.test(document.querySelector('#ext-status-2').textContent));
  await page.click('#pair-now');
  await page.waitForFunction(() => /Extension connected/.test(document.querySelector('#ext-status-2').textContent), null, { timeout: 10000 });
  await page.close();
});

after(async () => {
  await ctx?.close();
  await env?.close();
  await store?.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function browserApi(method, p, data) {
  const res = await ctx.request.fetch(env.url + p, { method, headers: { 'x-mugibot': '1', origin: env.url, 'content-type': 'application/json' }, data: data === undefined ? undefined : JSON.stringify(data) });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

test("🚦 in EB Games' queue — its page drawn a moment after each refresh: Mugibot's checks of your EB items, due again and again while you wait, never reach EB (the tab counts as in line through every refresh) — the place is kept, and once you're through they go on as before", async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  // (Your EB items read by this browser: the server's own checks of EB switched off here.)
  env.app.repo.setSetting('retailer:demo-ebgames', { serverChecks: false });
  for (const it of (await browserApi('GET', '/api/items')).body.items) await browserApi('DELETE', `/api/items/${it.id}`);
  assert.equal((await browserApi('POST', '/api/items', { url: store.productUrl('ebgames', '312346'), name: 'EB ETB queue checks' })).status, 200);
  const S = store.shop('ebgames');
  Object.assign(S.queue, { on: true, admitAfterMs: 14000, refreshMs: 2000, tooSoonMs: 900, wait: 7, lateMs: 1200 });
  const productPath = new URL(store.productUrl('ebgames', '312346')).pathname;
  const tab = await ctx.newPage();
  await tab.goto(store.productUrl('ebgames', '312346'));
  await tab.waitForFunction(() => /You're in the queue/.test(document.body.innerText), null, { timeout: 15000 });
  const joined = Date.now();
  // In line from the moment its words show (they're drawn a moment after the page opens).
  await waitFor(async () => (await sw.evaluate(() => globalThis.mugibotGates())).held.includes('demo-ebgames'), { timeout: 1000, interval: 50, message: 'in line as soon as the queue shows' });
  // While in line: the item's check is due again and again — the extension runs its checks about every second (as
  // often as your account lets a browser ask for them), and in between, EB's held is looked at every 150 ms — through
  // every refresh, the moment before the page draws its words included.
  let checked = 0;
  let samples = 0;
  const notHeld = [];
  let nextCheck = 0;
  while (Date.now() - joined < 11000) {
    if (Date.now() >= nextCheck) {
      nextCheck = Date.now() + 1200;
      env.app.db.run('UPDATE items SET browser_next_at = 0 WHERE user_id = :u', { u: userId });
      const r = await sw.evaluate(() => globalThis.mugibotRunChecks()).catch(() => null);
      assert.ok(r && !r.status, `checks asked for (${JSON.stringify(r)})`);
      if (r.checked) checked += r.checked;
    }
    const here = await sw.evaluate(() => globalThis.mugibotGates());
    samples += 1;
    if (!here.held.includes('demo-ebgames')) notHeld.push(`${Date.now() - joined} ms: ${JSON.stringify(here.gates['demo-ebgames'] || null)}`);
    await new Promise((res) => setTimeout(res, 150));
  }
  const log = () => S.queue.log.map((e) => `${e.at - joined} ${e.id} ${e.what} ${e.path} ${e.how}`).join(' | ');
  assert.equal(S.queue.kicks, 0, `the place in line kept — nothing asked EB in between: ${log()}`);
  assert.equal(checked, 0, 'no EB check while in line');
  assert.deepEqual(notHeld, [], `EB held at every look (${samples} looks)`);
  assert.ok(samples >= 30, `looked often (${samples})`);
  assert.ok(S.queue.shown >= 4, `it refreshed itself while waiting (${S.queue.shown} queue pages)`);
  // Through: the tab is the store's page — and the checks of EB go on as before.
  await tab.waitForFunction(() => !/You're in the queue/.test(document.body.innerText) && !!document.querySelector('#buybox'), null, { timeout: 30000 });
  assert.equal(S.queue.admitted, 1);
  assert.equal(S.queue.kicks, 0, log());
  await waitFor(async () => {
    env.app.db.run('UPDATE items SET browser_next_at = 0 WHERE user_id = :u', { u: userId });
    const r = await sw.evaluate(() => globalThis.mugibotRunChecks()).catch(() => null);
    return !!(r && r.checked);
  }, { timeout: 30000, interval: 2500, message: 'checked again once through' });
  assert.ok(store.state.requests.some((x) => x.path === productPath), 'EB asked for the item, once through');
  await tab.close();
  S.queue.on = false;
});
