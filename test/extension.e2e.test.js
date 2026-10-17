// End to end: the real Mugibot extension (built for this test server) in
// Chromium, the dashboard, and the dummy stores — one per retailer flow.
//
// Sign up → install → connect with one click → save a card in the extension
// → ⚡ Buy through the Kmart, BIG W, EB Games and JB Hi-Fi flows, each
// following that store's own steps, filled from this account's details and
// this browser's card, and each stopping at the store's final button without
// pressing it. Then: the ⚡ Buy button in a Discord DM, in-browser checks for
// a store that refuses the server, and a second account on the same browser.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { EXTENSION_VERSION, writeExtension } from '../server/extension.js';
import { RETAILER_DEFS } from '../server/retailers/index.js';
import { startMockStore } from '../devtools/mockstore.js';
import { Client, PASSWORD, discordOpts, startApp, startFakeDiscord, waitFor } from './helpers.js';

const PROFILE_A = { label: 'Home', firstName: 'Ash', lastName: 'Ketchum', email: 'ash.orders@example.com', phone: '0412345678', address1: '1 Pallet Town Rd', address2: 'Unit 2', suburb: 'Sydney', state: 'NSW', postcode: '2000' };
const PROFILE_B = { label: 'Home', firstName: 'Misty', lastName: 'Waterflower', email: 'misty@example.com', phone: '0498765432', address1: '9 Cerulean Ave', suburb: 'Brisbane', state: 'QLD', postcode: '4000' };
const KMART_ACCOUNT = { email: 'kmart-account@example.com', firstName: 'Ash', lastName: 'Ketchum', phone: '0412345678' };
const shots = process.env.MUGIBOT_SCREENSHOT_DIR;

let env;
let store;
let discord;
let ctx;
let extId;
let sw;
let dirs = [];

let extDir;
let profileDir;

// Tests never touch the real stores: this browser can't reach any store's address (the
// extension's own checks, like the store login monitor's, go to every store it knows), and
// it connects directly (a proxy from the environment would look the addresses up itself).
const NO_STORES = [`--host-resolver-rules=${[...new Set(RETAILER_DEFS.flatMap((r) => r.hosts))].map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`, '--no-proxy-server'];

/** Start Chromium with the extension (again: the same profile, like reopening the browser). */
async function launch() {
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...NO_STORES],
  });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  extId = new URL(sw.url()).host;
}

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  env = await startApp({ demoStoreUrl: store.url, allowPrivateHosts: true, hostGapSeconds: 0, ...discordOpts(discord) });
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-ext-'));
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-chrome-'));
  dirs = [extDir, profileDir];
  writeExtension(env.app.cfg, extDir);
  await launch();
});

after(async () => {
  await ctx?.close();
  await env?.close();
  await store?.close();
  await discord?.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  store.reset();
  store.state.account = KMART_ACCOUNT;
});

/** API calls as whoever is logged in to the browser (shares its cookies). */
async function browserApi(method, p, data) {
  const res = await ctx.request.fetch(env.url + p, { method, headers: { 'x-mugibot': '1', origin: env.url, 'content-type': 'application/json' }, data: data === undefined ? undefined : JSON.stringify(data) });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

async function useItems(list) {
  const { body } = await browserApi('GET', '/api/items');
  for (const p of body.items) await browserApi('DELETE', `/api/items/${p.id}`);
  for (const p of list) {
    const r = await browserApi('POST', '/api/items', p);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
}

const panel = (page) => page.locator('#mugibot-qc');
const readyFor = (label) => new RegExp(`Ready — review everything and press "${label}"`);
const ordersPlaced = () => Object.values(store.state.shops).reduce((n, s) => n + s.orders.length, 0);

async function buyFromDashboard(page, name) {
  await page.goto(`${env.url}/app#watch`);
  const row = page.locator('#w-list li', { hasText: name });
  assert.equal(await row.locator('input.qty').count(), 0, 'no quantity box (one of each for now)');
  const [shop] = await Promise.all([ctx.waitForEvent('page'), row.getByRole('button', { name: '⚡ Buy' }).click()]);
  return shop;
}

async function waitReady(shop, label) {
  await shop.waitForFunction((re) => new RegExp(re).test(document.querySelector('#mugibot-qc')?.textContent || ''), readyFor(label).source, { timeout: 40000 });
}

const cardFrame = (shop) => shop.frames().find((f) => f.url().includes('/card-frame'));

test('sign up, install, connect the extension with one click', async () => {
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
  await page.waitForSelector('#devices li .name');
  const auth = await sw.evaluate(() => chrome.storage.local.get('auth'));
  assert.equal(auth.auth.user.username, 'ash');
  assert.equal(auth.auth.server, env.url);
  // The store list with each flow's status.
  await page.waitForSelector('#stores li');
  assert.match(await page.textContent('#stores'), /Kmart.*verified flow/s);
  assert.match(await page.textContent('#stores'), /BIG W.*beta flow/s);

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => document.querySelector('#who').textContent === 'ash');
  assert.match(await popup.textContent('#plan'), /Member/);
  await popup.waitForSelector('#items li a');
  assert.equal(await popup.locator('#items li a').count(), 7, 'the starter watchlist');
  await popup.close();
  await page.close();
});

test('card: saved once in the extension (no passphrase), encrypted, tied to this account, never sent to the server', async () => {
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.waitForSelector('#card-form:not([hidden])');
  assert.equal(await opts.locator('input[type=password]:visible').count(), 0, 'nothing to choose or unlock');
  await opts.fill('#c-number', '4242 4242 4242 4242');
  await opts.fill('#c-name', 'Ash Ketchum');
  await opts.fill('#c-exp', '07/29');
  await opts.fill('#c-cvc', '123');
  await opts.click('#card-form button[type=submit]');
  await opts.waitForSelector('#card-saved:not([hidden])');
  assert.match(await opts.textContent('#card-label'), /Visa •••• 4242/);
  assert.equal(await opts.textContent('#card-state'), 'Ready for checkout');
  assert.match(await opts.textContent('#card-msg'), /⚡ Buy will fill it in at checkout from now on/);
  if (shots) await opts.screenshot({ path: path.join(shots, 'card-settings.png'), fullPage: true });
  await opts.close();

  const userId = env.app.repo.userByUsername('ash').id;
  const local = await sw.evaluate(() => chrome.storage.local.get(null));
  assert.equal(local[`vault:${userId}`].last4, '4242');
  assert.equal(local[`vault:${userId}`].v, 2);
  assert.doesNotMatch(JSON.stringify(local), /4242 ?4242 ?4242/, 'the card number is not stored in the clear');
  const session = await sw.evaluate(() => chrome.storage.session.get(null));
  assert.doesNotMatch(JSON.stringify(session), /4242 ?4242 ?4242/, 'nor kept in the clear while the browser runs');
  const dump = JSON.stringify(env.app.db.all('SELECT * FROM user_data')) + JSON.stringify(env.app.db.all('SELECT * FROM events'));
  assert.doesNotMatch(dump, /4242|Ash Ketchum/);

  // The dashboard shows the card (brand and last 4 only), straight from the extension.
  const dash = await ctx.newPage();
  await browserApi('PUT', '/api/profiles', { profiles: [PROFILE_A] });
  await dash.goto(`${env.url}/app#checkout`);
  await dash.waitForFunction(() => /Visa •••• 4242/.test(document.querySelector('#card-state').textContent));
  assert.match(await dash.textContent('#card-state'), /ready: ⚡ Buy fills it in at checkout/);
  assert.equal(await dash.textContent('#card-open'), 'Card settings');
  await dash.close();
});

test('the saved card is still ready after closing and opening the browser again', async () => {
  await ctx.close();
  await launch();
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => /Visa •••• 4242 — ready for checkout/.test(document.querySelector('#card-status').textContent));
  if (shots) await popup.screenshot({ path: path.join(shots, 'popup-card.png') });
  await popup.close();
  // The checkouts below run in this reopened browser, and each one fills the card in.
});

test('a card saved with a passphrase by an older version: entering it once keeps it ready', async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  // What version 1.2 saved: the card encrypted with a passphrase (PBKDF2 → AES-GCM).
  await sw.evaluate(async (id) => {
    const enc = new TextEncoder();
    const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const base = await crypto.subtle.importKey('raw', enc.encode('pikachu-123'), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const card = { number: '4242424242424242', name: 'Ash Ketchum', expMonth: '07', expYear: '2029', cvc: '123' };
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`mugibot-card:${id}`) }, key, enc.encode(JSON.stringify(card)));
    await chrome.storage.local.set({ [`vault:${id}`]: { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct), last4: '4242', brand: 'Visa', expMonth: '07', expYear: '2029', hasCvc: true, savedAt: Date.now() } });
  }, userId);
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.waitForSelector('#upgrade-form:not([hidden])');
  assert.match(await opts.textContent('#card-state'), /old passphrase/);
  await opts.fill('#upgrade-pass', 'wrong-pass');
  await opts.click('#upgrade-form button[type=submit]');
  await opts.waitForFunction(() => /Wrong passphrase/.test(document.querySelector('#saved-msg').textContent));
  await opts.fill('#upgrade-pass', 'pikachu-123');
  await opts.click('#upgrade-form button[type=submit]');
  await opts.waitForFunction(() => document.querySelector('#card-state').textContent === 'Ready for checkout');
  assert.equal(await opts.isHidden('#upgrade-form'), true);
  await opts.close();
  const local = await sw.evaluate((id) => chrome.storage.local.get(`vault:${id}`), userId);
  assert.equal(local[`vault:${userId}`].v, 2, 'moved over to the new kind');
});

test("card backup: locked in the extension with a card passphrase and kept in your account; gone from this browser (like a new install), the passphrase brings it back — a wrong one doesn't", async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.waitForSelector('#backup-form:not([hidden])');
  assert.equal(await opts.isHidden('#restore-form'), true, 'nothing to restore yet');
  // A passphrase of at least 10 characters, typed twice.
  await opts.fill('#backup-pass', 'short');
  await opts.fill('#backup-pass2', 'short');
  await opts.click('#backup-form button[type=submit]');
  await opts.waitForFunction(() => /at least 10 characters/.test(document.querySelector('#backup-msg').textContent));
  await opts.fill('#backup-pass', 'correct horse battery');
  await opts.fill('#backup-pass2', 'correct horse batterz');
  await opts.click('#backup-form button[type=submit]');
  await opts.waitForFunction(() => /don't match/.test(document.querySelector('#backup-msg').textContent));
  await opts.fill('#backup-pass', 'correct horse battery');
  await opts.fill('#backup-pass2', 'correct horse battery');
  await opts.click('#backup-form button[type=submit]');
  await opts.waitForSelector('#backup-on:not([hidden])', { timeout: 20000 });
  assert.match(await opts.textContent('#backup-msg'), /Backed up/);
  // In the account: the locked copy, and nothing the server could read the card from.
  const backup = env.app.repo.getData(userId, 'cardBackup');
  assert.deepEqual([backup.brand, backup.last4, backup.iterations], ['Visa', '4242', 600000]);
  assert.doesNotMatch(JSON.stringify(backup), /4242 ?4242 ?4242|Ash Ketchum|"123"/);
  assert.doesNotMatch(JSON.stringify(env.app.db.all('SELECT * FROM user_data')) + JSON.stringify(env.app.db.all('SELECT * FROM events')), /4242 ?4242 ?4242|Ash Ketchum/);
  // The dashboard says so.
  const dash = await ctx.newPage();
  await dash.goto(`${env.url}/app#checkout`);
  // (The backup's line comes from the account; the card's from the extension, a moment later.)
  await dash.waitForFunction(() => /Backed up/.test(document.querySelector('#card-backup').textContent));
  await dash.waitForFunction(() => !/Checking this browser/.test(document.querySelector('#card-state').textContent), null, { timeout: 20000 });
  assert.match(await dash.textContent('#card-state'), /Visa •••• 4242 · expires 07\/29 — ready/);
  // Gone from this browser (what a new install of the extension, or another browser, starts with).
  opts.once('dialog', (d) => d.accept());
  await opts.click('#remove');
  await opts.waitForSelector('#restore-form:not([hidden])');
  assert.match(await opts.textContent('#restore-label'), /Visa •••• 4242 · expires 07\/29/);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => /backed up in your account — restore it in Card settings/.test(document.querySelector('#card-status').textContent));
  assert.equal(await popup.textContent('#card-settings'), 'Restore your card');
  await popup.close();
  await dash.reload();
  await dash.waitForFunction(() => /backed up in your account, but not in this browser yet/.test(document.querySelector('#card-state').textContent));
  assert.equal(await dash.textContent('#card-open'), 'Restore your card');
  // A wrong passphrase opens nothing; the right one, and the card is ready in this browser again.
  await opts.fill('#restore-pass', 'wrong horse battery');
  await opts.click('#restore-form button[type=submit]');
  await opts.waitForFunction(() => /isn't right/.test(document.querySelector('#restore-msg').textContent), null, { timeout: 20000 });
  await opts.fill('#restore-pass', 'correct horse battery');
  await opts.click('#restore-form button[type=submit]');
  await opts.waitForSelector('#restore-form[hidden]', { state: 'attached', timeout: 20000 });
  await opts.waitForSelector('#card-saved:not([hidden])');
  assert.equal(await opts.textContent('#card-state'), 'Ready for checkout');
  assert.match(await opts.textContent('#card-label'), /Visa •••• 4242 · expires 07\/29/);
  assert.match(await opts.textContent('#saved-msg'), /Restored/);
  assert.equal(await opts.isVisible('#backup-on'), true, 'and it says it is backed up');
  const local = await sw.evaluate((id) => chrome.storage.local.get(`vault:${id}`), userId);
  assert.equal(local[`vault:${userId}`].v, 2, 'kept in this browser like any saved card');
  await dash.reload();
  await dash.waitForFunction(() => /ready: ⚡ Buy fills it in/.test(document.querySelector('#card-state').textContent));
  await dash.close();
  await opts.close();
});

test('Kmart flow (verified): ⚡ Buy → added → straight to checkout → details → delivery → payment → stops at "Checkout securely"', async () => {
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'Kmart ETB', price: 100 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart ETB');
  await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 20000 });
  await waitReady(shop, 'Checkout securely');

  const S = store.shop('kmart');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['43818587', 1]], 'one of it, in the bag');
  assert.deepEqual(S.bagViews, [], 'never opened the bag page on the way');
  assert.deepEqual(S.steps.map((x) => x.step), ['summary', 'details', 'delivery'], 'Continue to details → delivery → payment');
  assert.equal(S.data.details.email, KMART_ACCOUNT.email, 'kept what the store account already had');
  assert.equal(S.data.details.kmail, undefined, 'never ticks marketing boxes');
  assert.equal(S.data.delivery.method, 'home', 'home delivery, not click & collect');
  assert.equal(S.data.delivery.address1, PROFILE_A.address1);
  assert.equal(S.data.delivery.address2, PROFILE_A.address2);
  assert.equal(S.data.delivery.state, 'NSW');
  assert.equal(S.data.delivery.postcode, '2000');
  assert.equal(await shop.isChecked('input[name=pay][value=card]'), true);
  assert.equal(await shop.inputValue('input[name=cardNumber]'), '4242 4242 4242 4242', "card from this browser's vault");
  assert.equal(await shop.inputValue('input[name=cardExpiry]'), '07/29');
  assert.equal(await shop.inputValue('input[name=cardCvv]'), '123');
  assert.match(await panel(shop).textContent(), /Kmart \(dummy store\) · verified flow/);
  if (shots) await shop.screenshot({ path: path.join(shots, 'kmart-ready.png') });
  await shop.waitForTimeout(1200);
  assert.equal(ordersPlaced(), 0, '"Checkout securely" was NOT pressed');

  const userId = env.app.repo.userByUsername('ash').id;
  await waitFor(() => env.app.repo.listEvents(userId).some((e) => /Kmart ETB: Clicked "Add to bag"$/.test(e.message)), { message: 'add event' });
  await waitFor(() => env.app.repo.listEvents(userId).some((e) => /Kmart \(dummy store\) — waiting for you to press "Checkout securely"/.test(e.message)), { message: 'ready event' });
  await shop.close();
  await dash.close();
});

test('Kmart on a fresh, slow page: never opens the bag before the item is in it', async () => {
  // Like kmart.com.au straight after ⚡ Buy opens it: "Add to bag" shows before the
  // page's code has started (pressing it does nothing yet), and adding takes a while.
  const S = store.shop('kmart');
  S.hydrateMs = 2500;
  S.addDelayMs = 2500;
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'Kmart ETB', price: 100 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart ETB');
  await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 40000 });
  await waitReady(shop, 'Checkout securely');
  assert.deepEqual(S.bagViews.filter((n) => n === 0), [], 'the bag was never opened while empty');
  assert.equal(S.cart.length, 1);
  assert.equal(S.cart[0].qty, 1, 'added once (not twice)');
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test('Kmart with a slow "Add to bag" (4 s): waits for it, adds once, never opens the bag early', async () => {
  const S = store.shop('kmart');
  S.addDelayMs = 4000;
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'Kmart ETB', price: 100 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart ETB');
  await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 40000 });
  await waitReady(shop, 'Checkout securely');
  assert.deepEqual(S.bagViews, [], 'straight to checkout once it was in the bag');
  assert.equal(S.cart[0].qty, 1, 'added once');
  await shop.close();
  await dash.close();
});

test("Kmart's React page, slow to finish loading: Add is pressed the moment Kmart's code is ready, not when the page has loaded", async () => {
  // Like kmart.com.au: its code wires up "Add to bag" well before the page has finished
  // loading (pictures, adverts), and a press before that does nothing.
  const S = store.shop('kmart');
  S.reactMs = 700;
  S.slowLoadMs = 9000;
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'Kmart ETB', price: 100 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart ETB');
  await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 20000 });
  assert.ok(S.addedAt - S.servedAt < 4000, `pressed ${S.addedAt - S.servedAt} ms after the page arrived — well before it finished loading (${S.slowLoadMs} ms)`);
  assert.ok(S.addedAt - S.servedAt >= S.reactMs, 'and not before the page could take it');
  assert.deepEqual(S.cart.map((c) => c.qty), [1], 'pressed once');
  await waitReady(shop, 'Checkout securely');
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test("when the store won't add it, Mugibot says so and doesn't open an empty bag", async () => {
  const S = store.shop('kmart');
  S.refuseAdds = true;
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'Kmart ETB', price: 100 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart ETB');
  await shop.waitForFunction(() => /didn't add it to your bag/.test(document.querySelector('#mugibot-qc')?.textContent || ''), null, { timeout: 40000 });
  assert.match(shop.url(), /\/kmart\/product\//, 'still on the product page');
  assert.deepEqual(S.bagViews, [], 'the bag was never opened');
  assert.equal(S.cart.length, 0);
  await shop.close();
  await dash.close();
});

test("Kmart showing nothing after Add, and not taking the first press: checkout sends the empty bag back, so Add is pressed again, then on to checkout", async () => {
  // What happened at kmart.com.au: no count on the bag link and no "Added" message — the page only
  // looked busy — and the add hadn't gone through, so Kmart's checkout opened the bag, empty.
  const S = store.shop('kmart');
  S.quiet = true;
  S.refuseAdds = 1;
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'Kmart ETB', price: 100 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart ETB');
  await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 60000 });
  await waitReady(shop, 'Checkout securely');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['43818587', 1]], 'in the bag, once');
  assert.deepEqual(S.bagViews, [0], 'the empty bag Kmart showed, once — then back to the product');
  const userId = env.app.repo.userByUsername('ash').id;
  assert.ok(env.app.repo.listEvents(userId).some((e) => /the bag was empty — pressing Add again/.test(e.message)));
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test('Kmart with the card in a payment-provider frame (Adyen-style)', async () => {
  store.state.cardInIframe = true;
  await useItems([{ url: store.productUrl('kmart', '43818556'), name: 'Kmart KO' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart KO');
  await waitReady(shop, 'Checkout securely');
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=encryptedCardNumber]')) === '4242 4242 4242 4242', { message: 'card in the frame' });
  // One box at a time: wait for the last one.
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=encryptedSecurityCode]')) === '123', { message: 'CVV in the frame' });
  assert.equal(await cardFrame(shop).inputValue('input[name=encryptedExpiryDate]'), '07 / 29');
  assert.equal(ordersPlaced(), 0);
  await shop.waitForTimeout(11000);
  assert.doesNotMatch(await panel(shop).textContent(), /couldn't reach the card boxes/, 'no false alarm when the frame took the card');
  await shop.close();
  await dash.close();
});

test('Kmart with Adyen-style secured fields (one frame per box, real typing only): the card still goes in', async () => {
  store.state.cardInIframe = 'strict';
  await useItems([{ url: store.productUrl('kmart', '43818556'), name: 'Kmart KO' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart KO');
  await waitReady(shop, 'Checkout securely');
  const box = (field) => shop.frames().find((f) => f.url().includes(`field=${field}`));
  await waitFor(async () => (await box('number').inputValue('input')) === '4242 4242 4242 4242', { timeout: 20000, message: 'card number typed into its box' });
  await waitFor(async () => (await box('cvc').inputValue('input')) === '123', { timeout: 10000, message: 'CVV typed into its box' });
  assert.equal(await box('expiry').inputValue('input'), '07/29');
  // Each box kept what was typed (it undoes anything that isn't real typing).
  for (const [field, want] of [['number', '4242 4242 4242 4242'], ['expiry', '07/29'], ['cvc', '123']]) {
    assert.equal(await box(field).evaluate(() => typed), want, `${field} accepted as typing`);
  }
  await shop.waitForTimeout(11000);
  assert.doesNotMatch(await panel(shop).textContent(), /card boxes/, 'no "didn\'t go in" message');
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test('Kmart with card boxes that only take key presses: typed key by key', async () => {
  store.state.cardInIframe = 'keys';
  await useItems([{ url: store.productUrl('kmart', '43818556'), name: 'Kmart KO' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart KO');
  await waitReady(shop, 'Checkout securely');
  const box = (field) => shop.frames().find((f) => f.url().includes(`field=${field}`));
  await waitFor(async () => (await box('number').evaluate(() => typed)) === '4242 4242 4242 4242', { timeout: 20000, message: 'card number typed key by key' });
  await waitFor(async () => (await box('cvc').evaluate(() => typed)) === '123', { timeout: 10000, message: 'CVV typed key by key' });
  assert.equal(await box('expiry').evaluate(() => typed), '07/29');
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test("Kmart with card boxes that won't take the card: tries each box 3 times, then says so, with what happened in each box", async () => {
  store.state.cardInIframe = 'never';
  await useItems([{ url: store.productUrl('kmart', '43818556'), name: 'Kmart KO' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart KO');
  await waitReady(shop, 'Checkout securely');
  await shop.waitForFunction(() => /Your card didn't go into the card boxes \(from [\w.-]+:\d+\)\. Type it in yourself/.test(document.querySelector('#mugibot-qc')?.textContent || ''), null, { timeout: 40000 });
  const userId = env.app.repo.userByUsername('ash').id;
  const ev = await waitFor(() => env.app.repo.listEvents(userId).find((e) => /Card not filled in at Kmart/.test(e.message)), { message: 'reported in Activity' });
  assert.match(ev.message, /cardNumber empty \(rejected\)/);
  assert.match(ev.message, /extension \d+\.\d+\.\d+/);
  assert.doesNotMatch(ev.message, /4242/, 'no card details in the report');
  const box = shop.frames().find((f) => f.url().includes('field=number'));
  await shop.waitForTimeout(4000);
  assert.ok(await box.evaluate(() => attempts) <= 3, 'stops taking the focus after 3 tries');
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test("Kmart: when the card boxes can't be reached, the panel says so and where the payment form came from", async () => {
  store.state.cardInIframe = 'mystery'; // a payment frame Mugibot doesn't recognise
  await useItems([{ url: store.productUrl('kmart', '43818556'), name: 'Kmart KO' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart KO');
  await waitReady(shop, 'Checkout securely');
  await shop.waitForFunction(() => /couldn't reach the card boxes on this page \(the payment form may be in a frame from [\w.-]+:\d+\)\. Type your card in yourself/.test(document.querySelector('#mugibot-qc')?.textContent || ''), null, { timeout: 30000 });
  const userId = env.app.repo.userByUsername('ash').id;
  await waitFor(() => env.app.repo.listEvents(userId).some((e) => /Card not filled in at Kmart/.test(e.message)), { message: 'reported in Activity' });
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test('BIG W flow (beta): add → drawer "View cart" → "Proceed to checkout" → guest → "Home delivery" → manual address → card frame → stops at "Place order"', async () => {
  await useItems([{ url: store.productUrl('bigw', '6012346'), name: 'BIG W Bundle', price: 45 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'BIG W Bundle');
  await shop.waitForURL(/\/bigw\/checkout$/, { timeout: 25000 });
  await waitReady(shop, 'Place order');

  const S = store.shop('bigw');
  assert.equal(S.cart[0].qty, 1, 'one of it (the quantity dropdown left alone)');
  assert.equal(S.data.contact.email, PROFILE_A.email, 'checkout email from delivery details');
  assert.equal(S.data.method.method, 'home', 'chose "Home delivery" (a BIG W flow step)');
  assert.deepEqual({ ...S.data.address, addressSearch: undefined }, { firstName: 'Ash', lastName: 'Ketchum', phone: '0412345678', street: PROFILE_A.address1, unit: PROFILE_A.address2, suburb: 'Sydney', state: 'NSW', postcode: '2000', addressSearch: undefined });
  assert.equal(await shop.getAttribute('#b-cc', 'aria-pressed'), 'false', 'never Click & Collect');
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=cardnumber]')) === '4242 4242 4242 4242', { message: 'card in the frame' });
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=cvc]')) === '123', { message: 'CVV in the frame' });
  assert.match(await panel(shop).textContent(), /BIG W \(dummy store\) · beta flow/);
  if (shots) await shop.screenshot({ path: path.join(shots, 'bigw-ready.png') });
  await shop.waitForTimeout(1000);
  assert.equal(ordersPlaced(), 0, '"Place order" was NOT pressed');
  await shop.close();
  await dash.close();
});

test('EB Games flow (beta): mini-cart Checkout → "Continue as Guest" → address lookup → manual → delivery → payment + terms → stops at "Place Order"', async () => {
  await useItems([{ url: store.productUrl('ebgames', '312346'), name: 'EB ETB' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'EB ETB');
  await shop.waitForURL(/\/ebgames\/checkout\/payment$/, { timeout: 30000 });
  await waitReady(shop, 'Place Order');
  const S = store.shop('ebgames');
  assert.equal(S.data.shipping.email, PROFILE_A.email);
  assert.equal(S.data.shipping.street, PROFILE_A.address1);
  assert.equal(S.data.shipping.state, 'NSW');
  assert.equal(S.data.shipping.news, undefined, 'never ticks "news and offers"');
  assert.equal(S.data.delivery, 'standard', 'home delivery, not click & collect');
  assert.equal(await shop.isChecked('input[name=method][value=card]'), true);
  assert.equal(await shop.isChecked('input[name=terms]'), true, 'terms ticked');
  assert.equal(await shop.isChecked('input[name=marketing]'), false, 'newsletter not ticked');
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=cardnumber]')) === '4242 4242 4242 4242', { message: 'card in the frame' });
  await shop.waitForTimeout(800);
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test('JB Hi-Fi flow (beta, Shopify): the product page → Shopify\'s cart link → one-page checkout → stops at "Pay now"', async () => {
  const handle = 'pokemon-tcg-30th-celebration-etb';
  await useItems([{ store: 'demo-jbhifi', sku: handle, name: 'JB ETB' }]);
  // Mugibot doesn't know the product's Shopify option yet: the store page looks it up.
  const known = env.app.catalog.productFor('demo-jbhifi', handle);
  if (known) env.app.catalog.updateProduct(known.id, { variant_id: '' });
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'JB ETB');
  await shop.waitForURL(/\/jbhifi\/checkouts\/c\/abc123$/, { timeout: 30000 });
  await waitReady(shop, 'Pay now');
  const S = store.shop('jbhifi');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [[handle, 1]]);
  assert.ok(store.state.requests.some((r) => r.path === `/jbhifi/products/${handle}.js`), 'looked up the option to buy');
  assert.ok(!store.state.requests.some((r) => r.path === '/jbhifi/cart' || r.path === '/jbhifi/cart/add'), 'no Add to cart press, no cart page');
  assert.equal(await shop.inputValue('input[name=email]'), PROFILE_A.email);
  assert.equal(await shop.inputValue('input[name=address1]'), PROFILE_A.address1);
  assert.equal(await shop.inputValue('input[name=city]'), 'Sydney');
  assert.equal(await shop.inputValue('select[name=zone]'), 'NSW');
  assert.equal(await shop.inputValue('input[name=postalCode]'), '2000');
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=number]')) === '4242 4242 4242 4242', { message: 'card in the frame' });
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=name]')) === 'Ash Ketchum', { message: 'name on card in the frame' });
  await shop.waitForTimeout(800);
  assert.equal(ordersPlaced(), 0, '"Pay now" was NOT pressed');
  await shop.close();
  await dash.close();
});

test('Trainer Town flow (draft, Shopify): ⚡ Buy opens Shopify\'s cart link straight away (no product page) → one-page checkout → stops at "Pay now"', async () => {
  const handle = 'pokemon-tcg-ascended-heroes-elite-trainer-box';
  await useItems([{ store: 'demo-trainertown', sku: handle, name: 'TT ETB' }]);
  // The monitor has seen the product, so Mugibot knows its Shopify option to buy.
  const item = (await browserApi('GET', '/api/items')).body.items.find((x) => x.name === 'TT ETB');
  const p = env.app.catalog.upsertProduct({ store: 'demo-trainertown', sku: handle, url: item.url, name: 'TT ETB' });
  env.app.catalog.updateProduct(p.id, { variant_id: String(store.shop('trainertown').products.find((x) => x.sku === handle).id) });
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'TT ETB');
  await shop.waitForURL(/\/trainertown\/checkouts\/c\/abc123$/, { timeout: 30000 });
  await waitReady(shop, 'Pay now');
  assert.deepEqual(store.shop('trainertown').cart.map((c) => [c.sku, c.qty]), [[handle, 1]]);
  assert.ok(!store.state.requests.some((r) => r.path === `/trainertown/products/${handle}`), 'the product page was never opened');
  assert.equal(await shop.inputValue('input[name=email]'), PROFILE_A.email);
  assert.equal(await shop.inputValue('input[name=postalCode]'), '2000');
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=number]')) === '4242 4242 4242 4242', { message: 'card in the frame' });
  await shop.waitForTimeout(800);
  assert.equal(ordersPlaced(), 0, '"Pay now" was NOT pressed');
  await shop.close();
  await dash.close();
});

test('The Games Cube (draft, CrystalCommerce): its icon-only cart button → straight to checkout → "Checkout as a guest" → address → delivery and card → stops at "Place Order"', async () => {
  await useItems([{ url: store.productUrl('thegamescube', '729233'), name: 'GC OP-17' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'GC OP-17');
  await waitReady(shop, 'Place Order');
  const S = store.shop('thegamescube');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['729233', 1]], 'one of it, in the cart');
  assert.deepEqual(S.bagViews, [], 'straight to checkout, never the cart page');
  assert.deepEqual(S.data.contact, { name: 'Ash Ketchum', email: PROFILE_A.email }, 'a guest, with your name and email');
  assert.equal(S.data.address['address[street]'], PROFILE_A.address1);
  assert.equal(S.data.address['address[city]'], 'Sydney');
  assert.equal(S.data.address['address[state]'], 'NSW');
  assert.equal(S.data.address['address[postcode]'], '2000');
  assert.equal(await shop.isChecked('input[name=shipping][value=auspost]'), true, 'delivery, not pick up in store');
  assert.match(await shop.inputValue('input[name=cc_number]'), /^4242 ?4242 ?4242 ?4242$/);
  assert.equal(await shop.inputValue('input[name=cc_cvv]'), '123');
  await shop.waitForTimeout(800);
  assert.equal(ordersPlaced(), 0, '"Place Order" was NOT pressed');
  await shop.close();
  await dash.close();
});

test('Gamerholic (draft, Shopify): ⚡ Buy → Shopify\'s cart link → one-page checkout → stops at "Pay now"', async () => {
  const handle = 'pokemon-tcg-mega-evolution-elite-trainer-box';
  await useItems([{ store: 'demo-gamerholic', sku: handle, name: 'GH ETB' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'GH ETB');
  await shop.waitForURL(/\/gamerholic\/checkouts\/c\/abc123$/, { timeout: 30000 });
  await waitReady(shop, 'Pay now');
  assert.deepEqual(store.shop('gamerholic').cart.map((c) => [c.sku, c.qty]), [[handle, 1]]);
  assert.equal(await shop.inputValue('input[name=email]'), PROFILE_A.email);
  assert.equal(await shop.inputValue('input[name=postalCode]'), '2000');
  await shop.waitForTimeout(500);
  assert.equal(ordersPlaced(), 0, '"Pay now" was NOT pressed');
  await shop.close();
  await dash.close();
});

test('Pokémon Center (draft): "Add to Cart" → "View Cart" → "Checkout" → "Continue as Guest" → shipping → card frame → stops at "Place Order"', async () => {
  await useItems([{ url: store.productUrl('pokemoncenter', '10-10447-108'), name: 'PC ETB' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'PC ETB');
  await waitReady(shop, 'Place Order');
  const S = store.shop('pokemoncenter');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['10-10447-108', 1]]);
  assert.equal(S.data.guest.email, PROFILE_A.email);
  assert.deepEqual([S.data.shipping.firstName, S.data.shipping.lastName, S.data.shipping.address1, S.data.shipping.city, S.data.shipping.state, S.data.shipping.postcode], ['Ash', 'Ketchum', PROFILE_A.address1, 'Sydney', 'NSW', '2000']);
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=cardnumber]')) === '4242 4242 4242 4242', { message: 'card in the frame' });
  await shop.waitForTimeout(500);
  assert.equal(ordersPlaced(), 0, '"Place Order" was NOT pressed');
  await shop.close();
  await dash.close();
});

test('Target (draft): "Add to basket" → the "Often Bought Together" pop-up closed with its ✕ → "Checkout" → guest → home delivery → card → stops at "Place order"', async () => {
  await useItems([{ url: store.productUrl('target', '71234568'), name: 'Target Bundle' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Target Bundle');
  await waitReady(shop, 'Place order');
  const S = store.shop('target');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['71234568', 1]], 'none of the pop-up\'s clothes');
  assert.deepEqual(S.steps.map((x) => x.step), ['contact', 'delivery']);
  assert.equal(S.data.contact.email, PROFILE_A.email);
  assert.equal(S.data.delivery.method, 'home', 'never Click & Collect');
  assert.deepEqual([S.data.delivery.firstName, S.data.delivery.address1, S.data.delivery.postcode], ['Ash', PROFILE_A.address1, '2000']);
  assert.match(await shop.inputValue('input[name=cardNumber]'), /^4242 ?4242 ?4242 ?4242$/);
  const userId = env.app.repo.userByUsername('ash').id;
  assert.ok(env.app.repo.listEvents(userId).some((e) => /Closed the "Often Bought Together" pop-up/.test(e.message)), 'the pop-up closed');
  await shop.waitForTimeout(800);
  assert.equal(ordersPlaced(), 0, '"Place order" was NOT pressed');
  await shop.close();
  await dash.close();
});

// City Beach's checkout fields (Salesforce Commerce Cloud's names).
const cbField = (S, n) => S.data.shipping[`dwfrm_shipping_shippingAddress_addressFields_${n}`];

test('City Beach (draft): "Add To Bag" with its newsletter pop-up over the page → straight to checkout → email → "Continue as guest" → "Delivery" → delivery to my address → "Submit shipping" → card frame → stops at "Confirm & pay"', async () => {
  await useItems([{ url: store.productUrl('citybeach', '20424049-01'), name: 'CB Ninja Spinner' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'CB Ninja Spinner');
  await waitReady(shop, 'Confirm & pay');
  const S = store.shop('citybeach');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['20424049-01', 1]]);
  assert.deepEqual(S.steps.map((x) => x.step), ['customer', 'shipping']);
  assert.equal(S.data.customer.dwfrm_coCustomer_email, PROFILE_A.email);
  assert.equal(S.data.shipping.deliveryType, 'home', 'delivery to my address (not a PO box, not Click & Collect)');
  assert.deepEqual(['firstName', 'lastName', 'phone', 'address1', 'address2', 'city', 'states_stateCode', 'postalCode'].map((n) => cbField(S, n)),
    ['Ash', 'Ketchum', PROFILE_A.phone, PROFILE_A.address1, 'Unit 2', 'Sydney', 'NSW', '2000']);
  assert.match(shop.url(), /\/citybeach\/checkout\?stage=payment/);
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=cardnumber]')) === '4242 4242 4242 4242', { message: 'card in the frame' });
  await shop.waitForTimeout(500);
  assert.equal(ordersPlaced(), 0, '"Confirm & pay" was NOT pressed');
  await shop.close();
  await dash.close();
});

test("Premium Bandai (draft): Add pressed once its Vue page has wired it up → \"Go to Cart\" → \"Proceed to checkout\" → the whole checkout in a Global-e-style frame: your details and card go in there, and it's left for you to place", async () => {
  await useItems([{ url: store.productUrl('pbandai', 'N2903432001'), name: 'PB PCC' }]);
  const S = store.shop('pbandai');
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'PB PCC');
  await shop.waitForURL(/\/pbandai\/checkout$/, { timeout: 30000 });
  assert.ok(S.addedAt - S.servedAt >= S.vueMs, 'not pressed before the page could take it');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['N2903432001', 1]], 'pressed once');
  const ge = () => shop.frames().find((f) => f.url().includes('/ge-checkout'));
  await waitFor(async () => !!ge() && (await ge().inputValue('input[name=address1]')) === PROFILE_A.address1, { timeout: 20000, message: 'delivery details in the checkout frame' });
  assert.equal(await ge().inputValue('input[name=email]'), PROFILE_A.email);
  assert.equal(await ge().inputValue('input[name=firstName]'), 'Ash');
  assert.equal(await ge().inputValue('input[name=city]'), 'Sydney');
  assert.equal(await ge().inputValue('select[name=state]'), 'NSW');
  assert.equal(await ge().inputValue('input[name=zip]'), '2000');
  await waitFor(async () => (await ge().inputValue('input[name=cardNumber]')).replace(/\s/g, '') === '4242424242424242', { timeout: 20000, message: 'card in the checkout frame' });
  assert.match(await panel(shop).textContent(), /checkout is in the form on this page/);
  await shop.waitForTimeout(800);
  assert.notEqual(await ge().title(), 'placed', '"Place Order" in the frame was NOT pressed');
  await shop.close();
  await dash.close();
});

test('the ⚡ Buy button in a Discord DM goes straight to the store and the flow runs', async () => {
  // Connect Discord for Ash (the fake Discord sends straight back).
  const page = await ctx.newPage();
  discord.state.nextUser = 'd-ash';
  await page.goto(`${env.url}/auth/discord`);
  await page.waitForURL(/discord=linked/);
  await useItems([{ url: store.productUrl('kmart', '43818648'), name: 'Kmart UPC' }]);
  const userId = env.app.repo.userByUsername('ash').id;
  const row = env.app.db.get("SELECT * FROM items WHERE user_id = :u AND sku = '43818648'", { u: userId });
  store.set('kmart', '43818648', { status: 'in_stock' });
  const before = discord.dmsTo('d-ash').length;
  await env.app.monitor.applyResult({ ...row, status: 'out_of_stock' }, { status: 'in_stock', price: 360 }, 'server');
  const dm = discord.dmsTo('d-ash').slice(before)[0];
  const button = dm.body.components[0].components[0];
  assert.equal(button.label, '⚡ Buy');
  await page.goto(button.url);
  await page.waitForURL(/\/kmart\/checkout$/, { timeout: 25000 });
  await waitReady(page, 'Checkout securely');
  assert.equal(store.shop('kmart').cart[0].qty, 1);
  assert.equal(ordersPlaced(), 0);
  await page.close();
});

test('in-browser checks: a store that refuses the server is checked by your browser, and the restock pings you', async () => {
  await useItems([{ url: store.productUrl('kmart', '43818648'), name: 'Blocked UPC' }]);
  const userId = env.app.repo.userByUsername('ash').id;
  store.set('kmart', '43818648', { status: 'out_of_stock' });
  store.state.blockNonBrowsers = true; // like Kmart's bot protection for servers
  await env.app.monitor.tick();
  let item = env.app.repo.listItems(userId)[0];
  assert.match(item.error, /refused the server check/);

  // This browser checks it (the alarm does this every 30 s; run it now).
  let r = await sw.evaluate(() => globalThis.mugibotRunChecks());
  assert.equal(r.checked, 1, JSON.stringify(r));
  item = env.app.repo.listItems(userId)[0];
  assert.equal(item.status, 'out_of_stock');
  assert.equal(item.statusSource, 'browser');
  assert.ok(store.state.requests.some((x) => x.path.includes('43818648') && /Chrome|Mozilla/.test(x.ua)), 'a normal browser request');

  store.set('kmart', '43818648', { status: 'in_stock' });
  env.app.db.run('UPDATE items SET browser_next_at = 0 WHERE user_id = :u', { u: userId });
  const dmsBefore = discord.dmsTo('d-ash').length;
  r = await sw.evaluate(() => globalThis.mugibotRunChecks());
  assert.equal(r.checked, 1);
  item = env.app.repo.listItems(userId)[0];
  assert.equal(item.status, 'in_stock');
  await waitFor(() => discord.dmsTo('d-ash').length > dmsBefore, { message: 'restock DM' });
  assert.match(discord.dmsTo('d-ash').at(-1).body.embeds[0].description, /Seen by your browser/);
});

test("live sweeps from an admin's browser: a store that refuses the server is searched from here, and a new drop alerts", async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  const sweeper = env.app.sweeper;
  const off = Object.fromEntries(sweeper.stores().map((s) => [s.retailer.id, 'off']));
  sweeper.save({ browserEverySeconds: 5, stores: { ...off, 'demo-kmart': 'browser' } }, null);
  store.state.blockNonBrowsers = true; // like Kmart's bot protection for servers
  store.set('kmart', '43818648', { listed: false });
  // A member's browser gets no searches…
  assert.deepEqual(await sw.evaluate(() => globalThis.mugibotSweepLoop()), undefined);
  assert.ok(!store.state.requests.some((x) => x.path.startsWith('/kmart/cnstrc/search')));
  // …an admin's does (the alarm starts it every 30 s; start it now).
  env.app.repo.updateUser(userId, { role: 'admin' });
  try {
    await sw.evaluate(() => { globalThis.mugibotSweepLoop(); return true; });
    await waitFor(() => env.app.catalog.productFor('demo-kmart', '43818587'), { timeout: 20000, message: 'the first sweep from this browser' });
    const h = sweeper.health().find((s) => s.store === 'demo-kmart');
    assert.equal(h.terms[0].source, 'browser');
    assert.equal(h.terms[0].baselineAt > 0, true);
    assert.ok(store.state.requests.some((x) => x.path.startsWith('/kmart/cnstrc/search') && /Chrome|Mozilla/.test(x.ua)), "a normal browser request to Kmart's search provider");
    assert.equal(env.app.catalog.productFor('demo-kmart', '43818587').status, 'in_stock');

    // The store adds a product: the next sweep from this browser alerts it.
    store.set('kmart', '43818648', { listed: true, status: 'in_stock' });
    await waitFor(() => env.app.catalog.recentAlerts({ kind: 'listed' }).some((a) => a.sku === '43818648'), { timeout: 30000, message: 'a new drop from the browser sweep' });

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('#sweeps:not([hidden])');
    assert.match(await popup.textContent('#sweeps-list'), /Kmart \(dummy store\): \d+ products/);
    await popup.close();
  } finally {
    env.app.repo.updateUser(userId, { role: 'user' });
    sweeper.save({ stores: { 'demo-kmart': 'off' } }, null);
  }
});

test("BIG W's search page builds its products once it's open: an admin's browser opens it in a window of its own, waits, and reads them; ↻ Reset opens it afresh", async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  const sweeper = env.app.sweeper;
  const off = Object.fromEntries(sweeper.stores().map((s) => [s.retailer.id, 'off']));
  sweeper.save({ browserEverySeconds: 5, stores: { ...off, 'demo-bigw': 'browser' } }, null);
  store.shop('bigw').clientSearch = true; // like the real BIG W
  env.app.repo.updateUser(userId, { role: 'admin' });
  try {
    // Reading the page as it arrives finds nothing: its products aren't in it yet.
    const raw = await (await fetch(`${store.url}/bigw/search?text=pokemon`)).text();
    assert.ok(!raw.includes('/bigw/product/'));
    await sw.evaluate(() => { globalThis.mugibotSweepLoop(); return true; });
    await waitFor(() => env.app.catalog.productFor('demo-bigw', '6012346'), { timeout: 30000, message: 'products read from the opened page' });
    const bundle = env.app.catalog.productFor('demo-bigw', '6012346');
    assert.equal(bundle.status, 'in_stock');
    assert.equal(bundle.price, 45);
    assert.match(bundle.url, /\/bigw\/product\/.+\/p\/6012346$/);
    await waitFor(() => env.app.catalog.productFor('demo-bigw', '6012345'), { timeout: 10000, message: 'the sold-out one too' });
    assert.equal(env.app.catalog.productFor('demo-bigw', '6012345').status, 'out_of_stock');
    assert.ok(store.state.requests.some((x) => x.path.startsWith('/bigw/api/search')), "the page's own code fetched its products");
    assert.equal(sweeper.health().find((s) => s.store === 'demo-bigw').terms[0].source, 'browser');
    // The sweep window: one tab, reused, without Mugibot's store panel.
    const tabs = ctx.pages().filter((pg) => pg.url().includes('/bigw/search'));
    assert.equal(tabs.length, 1);
    await tabs[0].waitForTimeout(1500);
    assert.equal(await tabs[0].evaluate((id) => !!document.getElementById(id), 'mugibot-qc'), false);

    // ↻ Reset: the store's tab is closed and opened again at its front page, then searched as before.
    const fronts = () => store.state.requests.filter((x) => x.path === '/bigw' || x.path === '/bigw/').length;
    const frontsBefore = fronts();
    sweeper.reset('demo-bigw');
    await sw.evaluate(() => { globalThis.mugibotSweepLoop(); return true; });
    await waitFor(() => tabs[0].isClosed(), { timeout: 20000, message: 'the old tab closed' });
    await waitFor(() => fronts() > frontsBefore, { timeout: 20000, message: 'opened again at the front page' });
    await waitFor(() => ctx.pages().some((pg) => pg.url().includes('/bigw/search')), { timeout: 30000, message: 'searched again in the new tab' });
    await waitFor(() => sweeper.stat('demo-bigw').lastOkAt > sweeper.stat('demo-bigw').resetAt, { timeout: 30000, message: 'a search after the reset' });
    assert.equal(ctx.pages().filter((pg) => pg.url().includes('/bigw/')).length, 1, 'still one tab for the store');
  } finally {
    env.app.repo.updateUser(userId, { role: 'user' });
    store.shop('bigw').clientSearch = false;
    sweeper.save({ stores: off }, null);
    Object.assign(sweeper.stat('demo-bigw'), { slowUntil: 0 });
  }
});

test("EB Games: its search JSON, asked for from inside an EB Games page in the sweep window (servers refused, like its Cloudflare)", async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  const sweeper = env.app.sweeper;
  const off = Object.fromEntries(sweeper.stores().map((s) => [s.retailer.id, 'off']));
  sweeper.save({ browserEverySeconds: 5, stores: { ...off, 'demo-ebgames': 'browser' } }, null);
  store.state.blockNonBrowsers = true;
  env.app.repo.updateUser(userId, { role: 'admin' });
  try {
    await sw.evaluate(() => { globalThis.mugibotSweepLoop(); return true; });
    await waitFor(() => env.app.catalog.productFor('demo-ebgames', '312346'), { timeout: 30000, message: 'EB Games products from its search JSON' });
    const etb = env.app.catalog.productFor('demo-ebgames', '312346');
    assert.equal(etb.status, 'in_stock');
    assert.match(etb.url, /\/ebgames\/product\/toys-and-collectibles\/312346-/);
    const asked = store.state.requests.filter((x) => x.path === '/ebgames/search/query');
    assert.ok(asked.length >= 1 && asked.every((x) => /Chrome|Mozilla/.test(x.ua)), "asked by the browser, from EB Games' page");
    assert.equal(sweeper.health().find((s) => s.store === 'demo-ebgames').terms[0].source, 'browser');
    // A second search asks again from the same page: no page load in between.
    const pages = () => store.state.requests.filter((x) => x.path === '/ebgames/search').length;
    const before = pages();
    const n = asked.length;
    sweeper.sweepNow();
    await waitFor(() => store.state.requests.filter((x) => x.path === '/ebgames/search/query').length > n, { timeout: 30000, message: 'the next search' });
    assert.equal(pages(), before, 'the EB Games page stays open');
  } finally {
    env.app.repo.updateUser(userId, { role: 'user' });
    store.state.blockNonBrowsers = false;
    sweeper.save({ stores: off }, null);
  }
});

test("Amazon: its search page, asked for from inside an Amazon page in the sweep window (Amazon turns servers away with HTTP 503)", async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  const sweeper = env.app.sweeper;
  const off = Object.fromEntries(sweeper.stores().map((s) => [s.retailer.id, 'off']));
  sweeper.save({ browserEverySeconds: 5, stores: { ...off, 'demo-amazon': 'browser' } }, null);
  env.app.repo.updateUser(userId, { role: 'admin' });
  try {
    // What Mugibot's server gets from Amazon's search.
    const server = await fetch(`${store.url}/amazon/s?k=pokemon`, { headers: { 'user-agent': 'Mugibot/1.0' } });
    assert.equal(server.status, 503);
    await sw.evaluate(() => { globalThis.mugibotSweepLoop(); return true; });
    await waitFor(() => env.app.catalog.productFor('demo-amazon', 'B0MGBTEST1'), { timeout: 30000, message: 'Amazon products from its search page, read in the browser' });
    const bundle = env.app.catalog.productFor('demo-amazon', 'B0MGBTEST1');
    assert.equal(bundle.status, 'in_stock');
    assert.equal(bundle.price, 59);
    assert.match(bundle.url, /\/amazon\/dp\/B0MGBTEST1$/);
    await waitFor(() => env.app.catalog.productFor('demo-amazon', 'B0MGBTEST2'), { message: 'the unavailable one too' });
    assert.equal(env.app.catalog.productFor('demo-amazon', 'B0MGBTEST2').status, 'out_of_stock');
    const searches = () => store.state.requests.filter((x) => x.path === '/amazon/s' && /Chrome|Mozilla/.test(x.ua));
    const asked = searches();
    assert.ok(asked.length >= 1, "asked by the browser, from Amazon's page");
    assert.equal(sweeper.health().find((s) => s.store === 'demo-amazon').terms[0].source, 'browser');
    // A search page (not JSON) isn't mistaken for a bot check: the next search asks again from the same page.
    const fronts = () => store.state.requests.filter((x) => /^\/amazon\/?$/.test(x.path)).length;
    const before = fronts();
    const n = asked.length;
    sweeper.sweepNow();
    await waitFor(() => searches().length > n, { timeout: 30000, message: 'the next search' });
    assert.equal(fronts(), before, "Amazon's page stays open — no reload for each search");
  } finally {
    env.app.repo.updateUser(userId, { role: 'user' });
    sweeper.save({ stores: off }, null);
  }
});

test("BIG W: products the page downloaded but hasn't drawn (a page in a hidden window) still count", async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  const sweeper = env.app.sweeper;
  const off = Object.fromEntries(sweeper.stores().map((s) => [s.retailer.id, 'off']));
  sweeper.save({ browserEverySeconds: 5, stores: { ...off, 'demo-bigw': 'browser' } }, null);
  store.shop('bigw').clientSearch = 'data';
  store.shop('bigw').products.push({ sku: '6012399', name: 'Pokémon TCG: Hidden Window Booster Bundle', price: 49, status: 'in_stock', listed: true, maxQty: 0, qtyStyle: 'select', lateMs: 0, id: 4412399 });
  env.app.repo.updateUser(userId, { role: 'admin' });
  try {
    await sw.evaluate(() => { globalThis.mugibotSweepLoop(); return true; });
    await waitFor(() => env.app.catalog.productFor('demo-bigw', '6012399'), { timeout: 40000, message: "products from the data BIG W's page downloaded" });
    const p = env.app.catalog.productFor('demo-bigw', '6012399');
    assert.equal(p.status, 'in_stock');
    assert.equal(p.price, 49);
    assert.match(p.url, /\/bigw\/product\/.+\/p\/6012399$/);
  } finally {
    env.app.repo.updateUser(userId, { role: 'user' });
    store.shop('bigw').clientSearch = false;
    sweeper.save({ stores: off }, null);
  }
});

// The admin's browser searches each store at most every 30 s (Pokémon Center, Premium Bandai), one
// keyword at a time: skip the wait until what the test needs has turned up.
async function browserSweepsUntil(found, message) {
  for (let round = 0; ; round++) {
    env.app.sweeper.sweepNow();
    await sw.evaluate(() => { globalThis.mugibotSweepLoop(); return true; });
    try {
      await waitFor(found, { timeout: 25000, message });
      return;
    } catch (e) {
      if (round === 2) throw e;
    }
  }
}

test("Premium Bandai: its own search JSON, asked for from inside a Premium Bandai page with the region its code sends (servers refused)", async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  const sweeper = env.app.sweeper;
  const off = Object.fromEntries(sweeper.stores().map((s) => [s.retailer.id, 'off']));
  sweeper.save({ browserEverySeconds: 5, stores: { ...off, 'demo-pbandai': 'browser' } }, null);
  store.state.blockNonBrowsers = true;
  env.app.repo.updateUser(userId, { role: 'admin' });
  try {
    // Like the real site: without its region header (x-g1-area-code), an error.
    assert.equal((await fetch(`${store.url}/pbandai/api/search?keyword=one%20piece`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome' } })).status, 500);
    await browserSweepsUntil(() => env.app.catalog.productFor('demo-pbandai', 'N2903432001'), 'Premium Bandai products from its search JSON');
    const pcc = env.app.catalog.productFor('demo-pbandai', 'N2903432001');
    assert.equal(pcc.status, 'in_stock');
    assert.equal(pcc.price, 25);
    assert.match(pcc.url, /\/pbandai\/item\/N2903432001$/);
    await waitFor(() => env.app.catalog.productFor('demo-pbandai', 'N2863373001'), { timeout: 10000, message: 'the sold-out one too' });
    assert.equal(env.app.catalog.productFor('demo-pbandai', 'N2863373001').status, 'out_of_stock');
    const asked = store.state.requests.filter((x) => x.path === '/pbandai/api/search');
    assert.ok(asked.length >= 1 && asked.every((x) => /Chrome|Mozilla/.test(x.ua)), "asked by the browser, from Premium Bandai's page");
    assert.ok(store.state.requests.some((x) => x.path === '/pbandai'), 'its front page, opened in the sweep window');
    const h = sweeper.health().find((s) => s.store === 'demo-pbandai');
    assert.equal(h.fails, 0, h.lastError);
    assert.ok(h.terms.every((t) => t.source === 'browser'));
  } finally {
    env.app.repo.updateUser(userId, { role: 'user' });
    store.state.blockNonBrowsers = false;
    sweeper.save({ stores: off }, null);
  }
});

test("Pokémon Center: its bot check's page comes first and reloads the search page; the admin's browser waits it out and reads the products", async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  const sweeper = env.app.sweeper;
  const off = Object.fromEntries(sweeper.stores().map((s) => [s.retailer.id, 'off']));
  sweeper.save({ browserEverySeconds: 5, stores: { ...off, 'demo-pokemoncenter': 'browser' } }, null);
  store.shop('pokemoncenter').botCheck = 1200; // like Imperva's: its page, then a reload a moment later
  env.app.repo.updateUser(userId, { role: 'admin' });
  try {
    await browserSweepsUntil(() => env.app.catalog.productFor('demo-pokemoncenter', '10-10447-108'), 'products read once the bot check let the page through');
    const etb = env.app.catalog.productFor('demo-pokemoncenter', '10-10447-108');
    assert.equal(etb.status, 'in_stock');
    assert.equal(etb.price, 129.95);
    assert.match(etb.url, /\/pokemoncenter\/product\/10-10447-108\/[^/]+$/);
    const searches = store.state.requests.filter((x) => x.path.startsWith('/pokemoncenter/search/'));
    assert.ok(searches.length >= 2, "the bot check's page, then the search page after its reload");
    const h = sweeper.health().find((s) => s.store === 'demo-pokemoncenter');
    assert.equal(h.fails, 0, h.lastError);
    assert.equal(h.terms[0].source, 'browser');
  } finally {
    env.app.repo.updateUser(userId, { role: 'user' });
    store.shop('pokemoncenter').botCheck = false;
    sweeper.save({ stores: off }, null);
  }
});

test("store login monitor: the extension sees where you're signed in (its checks and the store pages you open), and the dashboard and popup show it", async () => {
  const loginsNow = async () => {
    const { body } = await browserApi('GET', '/api/logins');
    return Object.fromEntries(body.stores.map((x) => [x.id, x]));
  };
  // Signed in at the dummy JB Hi-Fi (Shopify) and The Games Cube; not at Trainer Town or Premium Bandai.
  store.state.signedIn = { jbhifi: true, thegamescube: true };
  await sw.evaluate(() => chrome.storage.local.remove(['logins', 'loginsCheckedAt']));
  const checked = await sw.evaluate(() => globalThis.mugibotCheckLogins({ force: true }));
  assert.ok(checked >= 4, `stores whose pages say so, checked: ${checked}`);
  await waitFor(async () => {
    const l = await loginsNow();
    return l['demo-jbhifi'].status === 'in' && l['demo-thegamescube'].status === 'in' && l['demo-trainertown'].status === 'out' && l['demo-pbandai'].status === 'out';
  }, { message: 'the checked stores reach the account' });
  let l = await loginsNow();
  assert.equal(l['demo-jbhifi'].how, 'check');
  assert.equal(l['demo-kmart'].checked, false, "Kmart's pages don't say, so it isn't checked in the background");
  assert.notEqual(l['demo-kmart'].how, 'check');
  // Within 10 minutes it doesn't ask again (the alarm runs every 30 s).
  assert.equal(await sw.evaluate(() => globalThis.mugibotCheckLogins()), 0);

  // A store whose pages don't say so: read from the page you open (the ⚡ Buy tests before this one
  // opened Kmart already, so look for a fresh reading). The header's "Sign in"…
  const seenSince = async (status, since) => { const k = (await loginsNow())['demo-kmart']; return k.status === status && k.at >= since; };
  const page = await ctx.newPage();
  let since = Date.now();
  await page.goto(store.productUrl('kmart', '43818648'));
  await waitFor(() => seenSince('out', since), { message: 'Kmart: signed out' });
  // …and "Hi, Ash" / "Sign out" once you're in.
  store.state.signedIn.kmart = true;
  since = Date.now();
  await page.reload();
  await waitFor(() => seenSince('in', since), { message: 'Kmart: signed in' });
  l = await loginsNow();
  assert.equal(l['demo-kmart'].how, 'page');
  assert.ok(l['demo-kmart'].device, 'which browser saw it');

  // The dashboard's Extension tab: signed out first, with where to sign in.
  await page.goto(`${env.url}/app#extension`);
  await page.waitForSelector('#logins li.login');
  assert.equal(await page.locator('#logins li.login.in[data-store="demo-kmart"]').count(), 1);
  const pb = page.locator('#logins li.login.out[data-store="demo-pbandai"]');
  assert.equal(await pb.count(), 1);
  assert.equal(await pb.locator('a', { hasText: 'Sign in' }).getAttribute('href'), `${store.url}/pbandai`);
  assert.equal(await page.locator('#logins li.login.in a', { hasText: 'Sign in' }).count(), 0, 'no Sign in where you are signed in');
  assert.match(await page.textContent('#logins-sum'), /^Signed in at 3 of \d+ stores\. Signed out at .*Trainer Town \(dummy store\)/);
  assert.doesNotMatch(await page.textContent('#logins-sum'), /JB Hi-Fi,|JB Hi-Fi\.$/, 'the real stores were never reached');
  assert.equal(await page.getAttribute('#logins li.login:first-child', 'class'), 'login out', 'signed out first');
  // "Check now" asks the extension to look again now.
  store.state.signedIn.trainertown = true;
  await sw.evaluate(() => chrome.storage.local.remove('loginsCheckedAt'));
  await page.click('#logins-check');
  await page.waitForFunction(() => /Checked \d+ stores?/.test(document.querySelector('#logins-msg').textContent), null, { timeout: 20000 });
  await page.waitForSelector('#logins li.login.in[data-store="demo-trainertown"]');

  // The watchlist nudges you about a store you watch where you're signed out.
  store.state.signedIn.kmart = false;
  const shop = await ctx.newPage();
  since = Date.now();
  await shop.goto(store.productUrl('kmart', '43818648'));
  await waitFor(() => seenSince('out', since), { message: 'Kmart: signed out again' });
  await shop.close();
  await useItems([{ url: store.productUrl('kmart', '43818648'), name: 'Login nudge UPC' }]);
  await page.goto(`${env.url}/app#watch`);
  const nudge = page.locator('#w-list li.login-nudge');
  await nudge.waitFor();
  assert.match(await nudge.textContent(), /signed out at Kmart \(dummy store\)/);
  assert.equal(await nudge.locator('a').first().getAttribute('href'), `${store.url}/kmart`);

  // The extension's popup lists them too.
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => /Trainer Town/.test(document.querySelector('#logins')?.textContent || ''));
  assert.match(await popup.locator('#logins-list li', { hasText: 'JB Hi-Fi (dummy store)' }).textContent(), /✓ Signed in/);
  assert.match(await popup.locator('#logins-list li', { hasText: 'Premium Bandai (dummy store)' }).textContent(), /Not signed in/);
  await popup.close();
  await page.close();
  store.state.signedIn = {};
});

// ---------------------------------------------------------------------------
// 🤖 Auto-checkout (docs/AUTO-CHECKOUT.md)
// ---------------------------------------------------------------------------
/** The extension starts listening for Auto-checkout runs now (instead of at its next alarm). */
async function acoListen() {
  await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('state:')));
    globalThis.mugibotAcoLoop();
    return true;
  });
  await waitFor(() => [...env.app.aco.waiters.values()].some((set) => set.size > 0), { message: 'the browser listening for Auto-checkout runs' });
}

/** The store sells out, then it's back: the monitor's page checks see both. */
async function drop(shop, sku, { price } = {}) {
  // The product's page checked by the server straight away, sold out then in stock. (Not through the
  // monitor's schedule: it skips pages a live sweep saw lately — an earlier test's sweep of the dummy Kmart.)
  const pages = () => env.app.db.all("SELECT url FROM page_checks WHERE kind = 'product' AND sku = :sku", { sku }).map((r) => r.url);
  store.set(shop, sku, { status: 'out_of_stock' });
  for (const url of pages()) await env.app.monitor.checkPage(url);
  store.set(shop, sku, { status: 'in_stock', ...(price ? { price } : {}) });
  for (const url of pages()) await env.app.monitor.checkPage(url);
}

const acoRuns = async () => (await browserApi('GET', '/api/aco')).body.runs;
const lastRun = async () => (await acoRuns())[0];
const closeStorePages = async (host) => { for (const pg of ctx.pages()) if (pg.url().startsWith(`${store.url}/${host}`)) await pg.close(); };

test('🤖 Auto-checkout: switched on with your agreement and limits; an item is armed with a max price', async () => {
  if (!env.app.repo.userByUsername('ash').discord_id) {
    // (Running on its own: connect Discord for the DMs, like the ⚡ Buy DM test does.)
    const page = await ctx.newPage();
    discord.state.nextUser = 'd-ash';
    await page.goto(`${env.url}/auth/discord`);
    await page.waitForURL(/discord=linked/);
    await page.close();
  }
  let r = await browserApi('PUT', '/api/aco', { enabled: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /agree/);
  r = await browserApi('PUT', '/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 200, perDay: 6, spendPerDay: 900 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.enabled, true);
  assert.ok(r.body.settings.agreedAt > 0);
  await useItems([]);
  let res = await browserApi('POST', '/api/items', { url: store.productUrl('kmart', '43818587'), name: 'ACO ETB', aco: true });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /max price/);
  res = await browserApi('POST', '/api/items', { url: store.productUrl('kmart', '43818587'), name: 'ACO ETB', aco: true, maxPrice: 120 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.aco, true);
  assert.equal(res.body.acoPlaces, true);
});

test('🤖 Auto-checkout at Kmart: it drops → your browser opens the store by itself, adds it, fills checkout in and places the order — once; armed again only by you', async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  const dmsBefore = discord.dmsTo('d-ash').length;
  await acoListen();
  await drop('kmart', '43818587');
  await waitFor(() => store.shop('kmart').orders.length === 1, { timeout: 45000, message: 'the order placed at the dummy Kmart' });
  const order = store.shop('kmart').orders[0];
  assert.deepEqual(order.cart.map((c) => [c.sku, c.qty]), [['43818587', 1]], 'one of it');
  assert.equal(order.data.delivery.address1, PROFILE_A.address1);
  assert.equal(order.form.cardNumber, '4242 4242 4242 4242', "the card from this browser's vault");
  await waitFor(async () => (await lastRun()).status === 'placed', { message: 'the run says placed' });
  const run = await lastRun();
  assert.equal(run.name, 'ACO ETB');
  assert.equal(run.total, 110, 'the order total read at checkout');
  assert.equal(run.trigger, 'server');
  assert.deepEqual(run.steps.map((x) => x.status), ['queued', 'sent', 'started', 'checkout', 'placing', 'placed']);
  // One purchase per arming: it waits to be armed again.
  const item = (await browserApi('GET', '/api/items')).body.items.find((x) => x.name === 'ACO ETB');
  assert.equal(item.aco, false);
  await waitFor(() => discord.dmsTo('d-ash').slice(dmsBefore).some((m) => /Auto-checkout placed your order: ACO ETB/.test(m.body.embeds[0].title)), { message: 'the "order placed" DM' });
  assert.ok(discord.dmsTo('d-ash').slice(dmsBefore).some((m) => /Auto-checkout started: ACO ETB/.test(m.body.embeds[0].title)), 'the "started" DM');
  assert.ok(env.app.repo.listEvents(userId).some((e) => /Auto-checkout pressed "Checkout securely" \(total \$110\.00\)/.test(e.message)));
  // It drops again: nothing is bought (not armed).
  const runsBefore = (await acoRuns()).length;
  await drop('kmart', '43818587');
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(store.shop('kmart').orders.length, 1, 'not bought again');
  assert.equal((await acoRuns()).length, runsBefore, 'no new run');
  await closeStorePages('kmart');
});

test('🤖 Auto-checkout stops short — and buys nothing — when the total is over your limit, or the bag already has other things in it', async () => {
  // Over the limit: the store wants more than you allowed (the server saw $100; checkout says $110).
  await browserApi('PUT', '/api/aco', { maxOrder: 105 });
  const it = (await browserApi('GET', '/api/items')).body.items.find((x) => x.name === 'ACO ETB');
  await browserApi('PUT', `/api/items/${it.id}`, { aco: true });
  await acoListen();
  await drop('kmart', '43818587');
  await waitFor(async () => (await lastRun()).status === 'needs_you', { timeout: 45000, message: 'stopped at the final button' });
  let run = await lastRun();
  assert.equal(run.reason, 'over_limit');
  assert.match(run.message, /\$110\.00, is over your limit of \$105\.00/);
  assert.equal(store.shop('kmart').orders.length, 0, 'nothing bought');
  assert.equal((await browserApi('GET', '/api/items')).body.items.find((x) => x.name === 'ACO ETB').aco, true, 'never pressed: still armed');
  await closeStorePages('kmart');
  await browserApi('PUT', '/api/aco', { maxOrder: 200 });

  // Something else already in the bag: Auto-checkout only ever buys the one item.
  store.shop('kmart').cart.push({ sku: '43818556', qty: 1, price: 20, name: 'Knock Out Collection' });
  await acoListen();
  await drop('kmart', '43818587');
  await waitFor(async () => (await lastRun()).reason === 'wrong_item', { timeout: 45000, message: 'stopped: the bag had other things' });
  assert.equal(store.shop('kmart').orders.length, 0);
  run = await lastRun();
  assert.equal(run.status, 'needs_you');
  await closeStorePages('kmart');
});

test("🤖 Auto-checkout when the card is declined, or your bank wants you to confirm: it says so, and never tries again by itself", async () => {
  store.shop('kmart').decline = true;
  const it = (await browserApi('GET', '/api/items')).body.items.find((x) => x.name === 'ACO ETB');
  await browserApi('PUT', `/api/items/${it.id}`, { aco: true });
  await acoListen();
  await drop('kmart', '43818587');
  await waitFor(async () => (await lastRun()).reason === 'card_declined', { timeout: 45000, message: 'the declined card noticed' });
  let run = await lastRun();
  assert.equal(run.status, 'failed');
  assert.equal(store.shop('kmart').declined, 1, 'pressed once');
  assert.equal((await browserApi('GET', '/api/items')).body.items.find((x) => x.name === 'ACO ETB').aco, false, 'the final button was pressed: armed again only by you');
  await closeStorePages('kmart');

  store.reset();
  store.state.account = KMART_ACCOUNT;
  store.shop('kmart').threeDS = true;
  await browserApi('PUT', `/api/items/${it.id}`, { aco: true });
  await acoListen();
  await drop('kmart', '43818587');
  await waitFor(async () => (await lastRun()).reason === 'bank_check', { timeout: 45000, message: "the bank's check noticed" });
  run = await lastRun();
  assert.equal(run.status, 'needs_you');
  assert.match(run.message, /bank/);
  assert.equal(store.shop('kmart').challenged, 1);
  await closeStorePages('kmart');
});

test("🤖 Auto-checkout at a Kmart that won't add it: no blind trip to checkout — it tries Add twice, then says so (with what the page said) and buys nothing", async () => {
  const S = store.shop('kmart');
  S.quiet = true;
  S.refuseAdds = true;
  const it = (await browserApi('GET', '/api/items')).body.items.find((x) => x.name === 'ACO ETB');
  await browserApi('PUT', `/api/items/${it.id}`, { aco: true });
  await acoListen();
  await drop('kmart', '43818587');
  await waitFor(async () => ['failed', 'needs_you', 'placed'].includes((await lastRun()).status), { timeout: 60000, message: 'the run over' });
  const run = await lastRun();
  assert.equal(run.status, 'failed');
  assert.equal(run.reason, 'not_added');
  assert.match(run.message, /Something went wrong/, "what Kmart's page said");
  assert.equal(S.orders.length, 0);
  assert.equal(S.cart.length, 0);
  assert.equal((await browserApi('GET', '/api/items')).body.items.find((x) => x.name === 'ACO ETB').aco, true, 'never got to the final button: still armed');
  await closeStorePages('kmart');
  await browserApi('PUT', `/api/items/${it.id}`, { aco: false });
});

test('🤖 Auto-checkout at Target: the "Often Bought Together" pop-up is closed with its ✕ (nothing else added), then the order is placed', async () => {
  await useItems([{ url: store.productUrl('target', '71234567'), name: 'ACO Target ETB', aco: true, maxPrice: 90 }]);
  await acoListen();
  await drop('target', '71234567');
  await waitFor(() => store.shop('target').orders.length === 1, { timeout: 45000, message: 'the order placed at the dummy Target' });
  const order = store.shop('target').orders[0];
  assert.deepEqual(order.cart.map((c) => [c.sku, c.qty]), [['71234567', 1]], 'one of the item — none of the "Often Bought Together" clothes');
  assert.deepEqual(store.shop('target').steps.map((x) => x.step), ['contact', 'delivery']);
  assert.equal(store.shop('target').data.delivery.method, 'home');
  const userId = env.app.repo.userByUsername('ash').id;
  assert.ok(env.app.repo.listEvents(userId).some((e) => /Closed the "Often Bought Together" pop-up/.test(e.message)), 'the pop-up closed');
  await waitFor(async () => (await lastRun()).status === 'placed', { message: 'placed' });
  assert.equal((await lastRun()).total, 88, '$79 + $9 delivery');
  await closeStorePages('target');
});

test('🤖 Auto-checkout at City Beach: it drops → added (the newsletter pop-up over the page) → checkout → guest → delivery → card → the total checked → "Confirm & pay" — the order placed', async () => {
  await useItems([{ url: store.productUrl('citybeach', '20424049-01'), name: 'ACO CB Ninja', aco: true, maxPrice: 30 }]);
  await acoListen();
  await drop('citybeach', '20424049-01');
  await waitFor(() => store.shop('citybeach').orders.length === 1, { timeout: 45000, message: 'the order placed at the dummy City Beach' });
  const order = store.shop('citybeach').orders[0];
  assert.deepEqual(order.cart.map((c) => [c.sku, c.qty]), [['20424049-01', 1]], 'one of it');
  assert.equal(cbField(store.shop('citybeach'), 'address1'), PROFILE_A.address1);
  await waitFor(async () => (await lastRun()).status === 'placed', { message: 'the run says placed' });
  const run = await lastRun();
  assert.equal(run.total, 19.94, '$9.99 + $9.95 delivery, read from the checkout');
  assert.deepEqual(run.steps.map((x) => x.status), ['queued', 'sent', 'started', 'checkout', 'placing', 'placed']);
  await closeStorePages('citybeach');
});

test('🤖 Auto-checkout at City Beach with a last "place order" stage (?stage=placeOrder, its own "Confirm & pay"): pressed once there, and the order placed — the Pokémon skateboard drop', async () => {
  store.set('citybeach', '20499999-01', { listed: true });
  store.shop('citybeach').reviewStage = true;
  await useItems([{ url: store.productUrl('citybeach', '20499999-01'), name: 'ACO CB Skateboard', aco: true, maxPrice: 150 }]);
  await acoListen();
  await drop('citybeach', '20499999-01');
  await waitFor(() => store.shop('citybeach').orders.length === 1, { timeout: 45000, message: 'the order placed at the dummy City Beach' });
  assert.deepEqual(store.shop('citybeach').orders[0].cart.map((c) => [c.sku, c.qty]), [['20499999-01', 1]]);
  assert.deepEqual(store.shop('citybeach').steps.map((x) => x.step), ['customer', 'shipping', 'payment']);
  await waitFor(async () => (await lastRun()).status === 'placed', { message: 'the run says placed' });
  assert.equal((await lastRun()).total, 139.94);
  const userId = env.app.repo.userByUsername('ash').id;
  assert.ok(env.app.repo.listEvents(userId).some((e) => /pressed "Confirm & pay" on the last step/.test(e.message)), 'the place-order stage\'s button, pressed');
  assert.equal(store.shop('citybeach').orders.length, 1, 'once');
  await closeStorePages('citybeach');
});

test('🤖 Auto-checkout set to stop at the final button: fills checkout in and leaves the button to you', async () => {
  await browserApi('PUT', '/api/aco', { mode: 'fill' });
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'ACO fill', aco: true, maxPrice: 120 }]);
  await acoListen();
  await drop('kmart', '43818587');
  await waitFor(async () => (await lastRun()).status === 'ready', { timeout: 45000, message: 'filled in, waiting for you' });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(store.shop('kmart').orders.length, 0, 'not pressed');
  const page = ctx.pages().find((pg) => /\/kmart\/checkout$/.test(pg.url()));
  assert.ok(page, 'the checkout left open for you');
  assert.match(await panel(page).textContent(), /review everything and press "Checkout securely" yourself/);
  assert.equal((await browserApi('GET', '/api/items')).body.items.find((x) => x.name === 'ACO fill').aco, false, 'filled in once: armed again only by you');
  await closeStorePages('kmart');
  await browserApi('PUT', '/api/aco', { enabled: false, mode: 'place' });
  await useItems([]);
});

test("🤖 Trigger ACO on the Auto-checkout page: a test run now, for an item that isn't armed — this browser opens the store and checks out (here, stopping at the final button)", async () => {
  await browserApi('PUT', '/api/aco', { enabled: true, mode: 'fill' });
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'ACO test run', maxPrice: 120 }]);
  const dash = await ctx.newPage();
  await dash.goto(`${env.url}/app#aco`);
  const row = dash.locator('#aco-items tr.aco-item', { hasText: 'ACO test run' });
  await row.waitFor();
  dash.once('dialog', (d) => d.accept());
  await row.locator('.aco-test').click();
  await waitFor(async () => (await lastRun()).status === 'ready', { timeout: 45000, message: 'the test run filled in, waiting for you' });
  const run = await lastRun();
  assert.equal(run.trigger, 'test');
  assert.deepEqual(run.steps.map((x) => x.status), ['queued', 'sent', 'started', 'checkout', 'ready']);
  assert.equal(store.shop('kmart').orders.length, 0, 'not pressed (stop at the final button)');
  assert.ok(ctx.pages().some((pg) => /\/kmart\/checkout$/.test(pg.url())), 'the checkout left open');
  assert.equal((await browserApi('GET', '/api/items')).body.items.find((x) => x.name === 'ACO test run').aco, false, 'still not armed');
  await dash.waitForFunction(() => /test run \(Trigger ACO\)/.test(document.querySelector('#aco-runs').textContent));
  await closeStorePages('kmart');
  await dash.close();
  await browserApi('PUT', '/api/aco', { enabled: false, mode: 'place' });
  await useItems([]);
});

test("another account's ⚡ Buy link does nothing in this browser", async () => {
  const misty = await Client.signup(env.url, 'misty');
  env.app.repo.updateUser(misty.user.id, { plan: 'active' });
  await misty.post('/api/items', { url: store.productUrl('kmart', '43818556'), name: 'Misty KO' });
  const p = (await misty.get('/api/items')).body.items.find((x) => x.name === 'Misty KO');
  const go = await misty.post(`/api/items/${p.id}/go`, {});
  const page = await ctx.newPage();
  await page.goto(go.body.url);
  await panel(page).waitFor();
  await page.waitForFunction(() => /expired or belongs to another account/.test(document.querySelector('#mugibot-qc').textContent), null, { timeout: 10000 });
  await page.waitForTimeout(800);
  assert.equal(store.shop('kmart').cart.length, 0, 'nothing added');
  assert.ok(!page.url().includes('mgb-go='), 'code removed from the address straight away');
  await page.close();
});

test("switching this browser to another account: their own details, the first account's card isn't used, and disconnecting signs it out", async () => {
  const page = await ctx.newPage();
  await browserApi('POST', '/api/auth/logout');
  await page.goto(`${env.url}/login`);
  await page.fill('#li-username', 'misty');
  await page.fill('#li-password', PASSWORD);
  await page.click('#login button[type=submit]');
  await page.waitForURL(/\/app/);
  await page.goto(`${env.url}/app#extension`);
  await page.waitForFunction(() => /connected to another account \(ash\)/.test(document.querySelector('#ext-status-2').textContent));
  await page.locator('#ext-status-2 button').click();
  await page.waitForFunction(() => /Extension connected/.test(document.querySelector('#ext-status-2').textContent), null, { timeout: 10000 });

  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.waitForFunction(() => document.querySelector('#who').textContent === 'misty');
  assert.equal(await opts.isHidden('#card-saved'), true, "Ash's card isn't shown for Misty");
  await opts.close();

  await browserApi('PUT', '/api/profiles', { profiles: [PROFILE_B] });
  store.state.account = null; // a guest checkout this time
  const shop = await buyFromDashboard(page, 'Misty KO');
  await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 20000 });
  await waitReady(shop, 'Checkout securely');
  const S = store.shop('kmart');
  assert.equal(S.data.details.email, 'misty@example.com', "Misty's checkout email");
  assert.equal(S.data.details.firstName, 'Misty');
  assert.equal(S.data.delivery.address1, '9 Cerulean Ave');
  assert.equal(S.data.delivery.state, 'QLD');
  assert.equal(await shop.inputValue('input[name=cardNumber]'), '', "Ash's card is not used for Misty");
  assert.equal(ordersPlaced(), 0);
  await shop.close();

  // Disconnect from the dashboard: the extension is signed out.
  await page.goto(`${env.url}/app#extension`);
  page.once('dialog', (d) => d.accept());
  await page.locator('#devices li', { hasText: 'Chrome' }).getByRole('button', { name: 'Disconnect' }).click();
  await waitFor(async () => (await env.app.repo.listDevices(env.app.repo.userByUsername('misty').id)).length === 0, { message: 'device removed' });
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('#signed-out:not([hidden])');
  await popup.close();
  await page.close();
});

test('the extension shows an Update button when there is a newer version, or the site has moved address', async () => {
  // Two copies: an older version for this site, and the current one downloaded for another address of it.
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-old-'));
  const movedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-moved-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-chrome2-'));
  writeExtension(env.app.cfg, oldDir, { version: '1.0.0' });
  const elsewhere = env.url.replace('127.0.0.1', 'localhost');
  writeExtension({ ...env.app.cfg, baseUrl: elsewhere, extraOrigins: [] }, movedDir);
  const ctx2 = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${oldDir},${movedDir}`, `--load-extension=${oldDir},${movedDir}`],
  });
  try {
    const extIds = () => [...new Set(ctx2.serviceWorkers().map((w) => w.url()).filter((u) => u.startsWith('chrome-extension://')).map((u) => new URL(u).host))];
    await waitFor(() => extIds().length >= 2, { message: 'both extensions started' });
    // Tell them apart by the version in the popup's footer: the older copy is 1.0.0.
    const ids = {};
    const popup = await ctx2.newPage();
    for (const id of extIds()) {
      await popup.goto(`chrome-extension://${id}/popup.html`);
      await popup.waitForFunction(() => document.getElementById('foot').textContent.length > 0);
      ids[/^v1\.0\.0 /.test(await popup.textContent('#foot')) ? env.url : elsewhere] = id;
    }

    await popup.goto(`chrome-extension://${ids[env.url]}/popup.html`);
    await popup.locator('#update').waitFor({ state: 'visible' });
    assert.equal(await popup.textContent('#update-title'), `Update available: v${EXTENSION_VERSION}`);
    assert.match(await popup.textContent('#update-text'), /You have v1\.0\.0/);
    assert.equal(await popup.getAttribute('#update-go', 'href'), `${env.url}/app#update`, 'Update opens the update steps on the dashboard');

    await popup.goto(`chrome-extension://${ids[elsewhere]}/popup.html`);
    await popup.locator('#update').waitFor({ state: 'visible' });
    assert.equal(await popup.textContent('#update-title'), `Mugibot has moved to ${new URL(env.url).host}`);
    assert.match(await popup.textContent('#update-text'), new RegExp(`downloaded for ${new URL(elsewhere).host.replace('.', '\\.')}`));
    assert.equal(await popup.getAttribute('#update-go', 'href'), `${env.url}/app#update`);

    // Update opens the update steps on the dashboard (signed in, in the main browser).
    const dash = await ctx.newPage();
    await dash.goto(`${env.url}/app#update`);
    await dash.locator('#ext-update').waitFor({ state: 'visible' });
    assert.equal(await dash.locator('[data-panel="extension"]').isVisible(), true, 'on the Extension tab');
    await dash.close();
  } finally {
    await ctx2.close();
    for (const d of [oldDir, movedDir, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('Chrome Web Store copy: downloaded copies are asked to move to it, and with both installed only the store copy acts', async () => {
  const listing = 'https://chromewebstore.google.com/detail/mugibot/abcdefghijklmnopabcdefghijklmnop';
  env.app.repo.setSetting('chrome_store_url', listing);
  // Two copies in one browser: one downloaded from the dashboard, and one "from the Chrome Web Store"
  // (Chrome adds update_url to the manifest of store copies).
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-dl-'));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-store-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-chrome3-'));
  writeExtension(env.app.cfg, dlDir);
  writeExtension(env.app.cfg, storeDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(storeDir, 'manifest.json'), 'utf8'));
  manifest.update_url = 'https://clients2.google.com/service/update2/crx';
  fs.writeFileSync(path.join(storeDir, 'manifest.json'), JSON.stringify(manifest));
  const ctx3 = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${dlDir},${storeDir}`, `--load-extension=${dlDir},${storeDir}`],
  });
  try {
    const extIds = () => [...new Set(ctx3.serviceWorkers().map((w) => w.url()).filter((u) => u.startsWith('chrome-extension://')).map((u) => new URL(u).host))];
    await waitFor(() => extIds().length >= 2, { message: 'both extensions started' });
    const ids = {};
    const popup = await ctx3.newPage();
    for (const id of extIds()) {
      await popup.goto(`chrome-extension://${id}/popup.html`);
      await popup.waitForFunction(() => document.getElementById('foot').textContent.length > 0);
      ids[/updates itself/.test(await popup.textContent('#foot')) ? 'store' : 'download'] = id;
    }
    assert.ok(ids.store && ids.download, 'told the two copies apart');

    // The downloaded copy asks to move to the Chrome Web Store copy.
    await popup.goto(`chrome-extension://${ids.download}/popup.html`);
    await popup.locator('#update').waitFor({ state: 'visible' });
    assert.equal(await popup.textContent('#update-title'), 'Get Mugibot from the Chrome Web Store');
    assert.equal(await popup.getAttribute('#update-go', 'href'), listing);
    assert.equal(await popup.isVisible('#remove-copy'), true);
    assert.equal(await popup.isVisible('#reload'), false);
    // The store copy: nothing to update by hand.
    await popup.goto(`chrome-extension://${ids.store}/popup.html`);
    await popup.waitForFunction(() => /updates itself/.test(document.getElementById('foot').textContent));
    assert.equal(await popup.isVisible('#update'), false);
    assert.equal(await popup.isVisible('#reload2'), false, 'no Reload for the store copy');

    // Misty connected the downloaded copy before installing the store copy.
    const page = await ctx3.newPage();
    await page.goto(`${env.url}/login`);
    await page.fill('#li-username', 'misty');
    await page.fill('#li-password', PASSWORD);
    await page.click('#login button[type=submit]');
    await page.waitForURL(/\/app/);
    const code = await page.evaluate(async () => (await (await fetch('/api/devices/pair-code', { method: 'POST', headers: { 'x-mugibot': '1' } })).json()).code);
    const opts = await ctx3.newPage();
    await opts.goto(`chrome-extension://${ids.download}/options.html`);
    await opts.waitForSelector('#acct-out:not([hidden])');
    await opts.fill('#pair-code', code);
    await opts.click('#pair-form button[type=submit]');
    await opts.waitForFunction(() => document.querySelector('#who').textContent === 'misty');
    await opts.close();

    // The dashboard talks to the store copy; the downloaded copy stays quiet and is pointed out.
    await page.goto(`${env.url}/app#extension`);
    await page.waitForFunction(() => /installed but not connected/.test(document.querySelector('#ext-status-2').textContent));
    assert.equal(await page.evaluate(() => !!document.documentElement.dataset.mugibotStore), true);
    assert.equal(await page.isVisible('#store-link'), true, '"Add to Chrome" from the Chrome Web Store');
    assert.equal(await page.getAttribute('#store-link', 'href'), listing);
    await page.click('#pair-now');
    await page.waitForFunction(() => /Extension connected/.test(document.querySelector('#ext-status-2').textContent), null, { timeout: 10000 });
    assert.match(await page.textContent('#ext-status-2'), /from the Chrome Web Store \(it updates itself\)/);
    assert.match(await page.textContent('#ext-status-2'), /The old downloaded copy is still installed/);
    const devices = env.app.repo.listDevices(env.app.repo.userByUsername('misty').id);
    assert.deepEqual(devices.map((d) => d.source).sort(), ['download', 'store']);

    // The downloaded copy knows it's the old one now.
    await waitFor(async () => {
      await popup.goto(`chrome-extension://${ids.download}/popup.html`);
      await popup.waitForFunction(() => document.getElementById('foot').textContent.length > 0);
      return (await popup.textContent('#update-title')) === 'This is an old copy';
    }, { message: 'the downloaded copy retired' });
    assert.equal(await popup.isVisible('#remove-copy'), true);

    // ⚡ Buy with both copies installed: one panel, added once.
    await page.goto(`${env.url}/app#watch`);
    const row = page.locator('#w-list li', { hasText: 'Misty KO' });
    const [shop] = await Promise.all([ctx3.waitForEvent('page'), row.getByRole('button', { name: '⚡ Buy' }).click()]);
    await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 30000 });
    await shop.waitForFunction(() => /Ready — review everything/.test(document.querySelector('#mugibot-qc')?.textContent || ''), null, { timeout: 40000 });
    assert.equal(await shop.locator('#mugibot-qc').count(), 1, 'one Mugibot panel');
    const S = store.shop('kmart');
    assert.equal(S.cart.length, 1);
    assert.equal(S.cart[0].qty, 1, 'added once (two copies would have added two)');
    assert.equal(ordersPlaced(), 0);
  } finally {
    env.app.repo.setSetting('chrome_store_url', null);
    await ctx3.close();
    for (const d of [dlDir, storeDir, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});
