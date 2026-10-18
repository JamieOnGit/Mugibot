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
import { Client, PASSWORD, discordOpts, interactionKeys, startApp, startFakeDiscord, waitFor } from './helpers.js';

const PROFILE_A = { label: 'Home', firstName: 'Ash', lastName: 'Ketchum', email: 'ash.orders@example.com', phone: '0412345678', address1: '1 Pallet Town Rd', address2: 'Unit 2', suburb: 'Sydney', state: 'NSW', postcode: '2000' };
const PROFILE_B = { label: 'Home', firstName: 'Misty', lastName: 'Waterflower', email: 'misty@example.com', phone: '0498765432', address1: '9 Cerulean Ave', suburb: 'Brisbane', state: 'QLD', postcode: '4000' };
const KMART_ACCOUNT = { email: 'kmart-account@example.com', firstName: 'Ash', lastName: 'Ketchum', phone: '0412345678' };
const shots = process.env.MUGIBOT_SCREENSHOT_DIR;

let env;
let store;
let discord;
let keys; // Discord's interactions (its ⚡ Buy buttons, pressed)
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
  keys = interactionKeys();
  env = await startApp({ demoStoreUrl: store.url, allowPrivateHosts: true, hostGapSeconds: 0, ...discordOpts(discord), discordPublicKey: keys.publicKey });
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

/** Wait for the tab to reach an address (with what the panel said, if it doesn't). */
async function reach(shop, re, timeout = 30000) {
  try {
    await shop.waitForURL(re, { timeout });
  } catch (e) {
    const said = await shop.locator('#mugibot-qc').textContent().catch(() => '?');
    throw new Error(`Didn't reach ${re} (at ${shop.url()}) — the panel said: ${said}`);
  }
}

async function waitReady(shop, label) {
  try {
    await shop.waitForFunction((re) => new RegExp(re).test(document.querySelector('#mugibot-qc')?.textContent || ''), readyFor(label).source, { timeout: 40000 });
  } catch (e) {
    // (What the panel said, and where it got to: the reason in the test's output.)
    const said = await shop.locator('#mugibot-qc').textContent().catch(() => '?');
    throw new Error(`Not ready for "${label}" at ${shop.url()} — the panel said: ${said}`);
  }
}

const cardFrame = (shop) => shop.frames().find((f) => f.url().includes('/card-frame'));
// Shopify's card fields: one frame per box (checkout.pci.shopifyinc.com's, on the real stores).
const shopifyBox = (shop, field) => shop.frames().find((f) => f.url().includes(`/shopify-card?field=${field}`));
const shopifyCard = async (shop) => Object.fromEntries(await Promise.all(['number', 'expiry', 'verification_value', 'name']
  .map(async (f) => [f, shopifyBox(shop, f) ? await shopifyBox(shop, f).evaluate(() => typed) : null])));
const EXPECT_SHOPIFY_CARD = { number: '4242 4242 4242 4242', expiry: '07 / 29', verification_value: '123', name: 'Ash Ketchum' };

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

test("Kmart showing nothing after Add, and turning the first press away: Mugibot sees its cart refuse it, presses Add again once the page has loaded, then on to checkout", async () => {
  // What happened at kmart.com.au: no count on the bag link and no "Added" message — the page only
  // looked busy — and the add hadn't gone through (Kmart's cart had said no).
  const S = store.shop('kmart');
  S.quiet = true;
  S.refuseAdds = 1;
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'Kmart ETB', price: 100 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart ETB');
  await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 60000 });
  await waitReady(shop, 'Checkout securely');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['43818587', 1]], 'in the bag, once');
  assert.deepEqual(S.bagViews, [], 'no trip to an empty bag: the refusal was seen on the product page');
  const userId = env.app.repo.userByUsername('ash').id;
  assert.ok(env.app.repo.listEvents(userId).some((e) => /turned the add away \(HTTP 409\) — pressing "Add to bag" again/.test(e.message)));
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test("Kmart signed out (a guest): its cart turns the first add away until its page has started up — Add again once loaded, then the same flow as signed in: your details, delivery, card → stops at \"Checkout securely\"", async () => {
  store.state.account = null; // not signed in at Kmart: the details step is empty
  const S = store.shop('kmart');
  // Kmart's React page takes Add early (pressed then), long before the page has finished loading — and
  // its cart only takes adds once the page has started up (a moment after it loads).
  S.reactMs = 400;
  S.slowLoadMs = 2500;
  S.addNeedsLoad = 1200;
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'Kmart ETB', price: 100 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart ETB');
  await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 60000 });
  await waitReady(shop, 'Checkout securely');
  assert.ok(S.refusedEarly >= 1, 'the first add was turned away (403)');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['43818587', 1]], 'then added, once');
  assert.deepEqual(S.steps.map((x) => x.step), ['summary', 'details', 'delivery'], 'the same steps as signed in');
  assert.deepEqual([S.data.details.email, S.data.details.firstName, S.data.details.lastName, S.data.details.mobile], [PROFILE_A.email, 'Ash', 'Ketchum', PROFILE_A.phone], 'your details, typed in');
  assert.equal(S.data.delivery.method, 'home');
  assert.equal(await shop.inputValue('input[name=cardNumber]'), '4242 4242 4242 4242');
  assert.equal(await shop.inputValue('input[name=cardExpiry]'), '07/29');
  assert.equal(await shop.inputValue('input[name=cardCvv]'), '123');
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

test("Kmart with Adyen-style boxes that are slow to take what's typed: each waits its turn for the focus (none typed without it), and every box keeps the card", async () => {
  store.state.cardInIframe = 'slow';
  await useItems([{ url: store.productUrl('kmart', '43818556'), name: 'Kmart KO' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart KO');
  await waitReady(shop, 'Checkout securely');
  const box = (field) => shop.frames().find((f) => f.url().includes(`field=${field}`));
  await waitFor(async () => (await box('cvc').evaluate(() => typed)) === '123', { timeout: 30000, message: 'CVV typed (the last in the queue)' });
  for (const [field, want] of [['number', '4242 4242 4242 4242'], ['expiry', '07/29'], ['cvc', '123']]) {
    assert.equal(await box(field).evaluate(() => typed), want, `${field}: real typing, kept`);
  }
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

test('EB Games (beta, as its real checkout goes): fast to checkout → Click & Collect switched to "Home Delivery" → Australia → the address picked from EB\'s suggestions → its shipping method → Pay Now: "Credit / Debit card" → card number, MM/YY, CVV, name on card → "Done" → stops at "CONFIRM & PAY"', async () => {
  await useItems([{ url: store.productUrl('ebgames', '312346'), name: 'EB ETB' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'EB ETB');
  await shop.waitForURL(/\/ebgames\/checkout$/, { timeout: 30000 });
  await waitReady(shop, 'CONFIRM & PAY');
  const S = store.shop('ebgames');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['312346', 1]]);
  assert.equal(S.data.fulfilment.fulfilment, 'home', 'Home Delivery, not the Click & Collect EB chose');
  assert.equal(S.data.country.country, 'AU');
  assert.equal(S.data.address.address, '1 Pallet Town Rd, SYDNEY NSW 2000', 'your address, picked from the suggestions (not the QLD one)');
  assert.deepEqual([S.data.address.email, S.data.address.firstName, S.data.address.lastName, S.data.address.phone], [PROFILE_A.email, 'Ash', 'Ketchum', PROFILE_A.phone]);
  assert.equal(await shop.isChecked('input[name=shipping][value=standard]'), true, "EB's shipping method, left as it was");
  assert.equal(S.data.payment.method, 'card', '"Credit / Debit card"');
  assert.deepEqual(S.data.card, { last4: '4242', expiry: '07 / 29', name: 'Ash Ketchum' }, 'the card went in, then "Done"');
  assert.equal(await shop.isChecked('input[name=billingSame]'), true, 'billing address left as the delivery one');
  assert.equal(await shop.isChecked('input[name=news]'), false, 'never ticks "news and offers"');
  assert.equal(await shop.isChecked('input[name=marketing]'), false);
  await shop.waitForTimeout(800);
  assert.equal(ordersPlaced(), 0, '"CONFIRM & PAY" was NOT pressed');
  await shop.close();
  await dash.close();
});

test('EB Games signed in: everything already in (delivery, address, your saved card) — straight to "CONFIRM & PAY", nothing changed', async () => {
  store.state.signedIn.ebgames = true;
  await useItems([{ url: store.productUrl('ebgames', '312346'), name: 'EB ETB' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'EB ETB');
  await waitReady(shop, 'CONFIRM & PAY');
  const S = store.shop('ebgames');
  assert.equal(S.data.fulfilment, undefined, 'delivery left as EB had it');
  assert.equal(S.data.address, undefined, 'your EB address left as it was');
  assert.equal(await shop.inputValue('#eb-addr'), '1 Pallet Town Rd, Sydney NSW 2000');
  assert.equal(await shop.inputValue('input[name=email]'), 'ash.eb@example.com', "your EB account's email, not overwritten");
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test('JB Hi-Fi flow (beta, Shopify): the product page → Shopify\'s cart link → one-page checkout → your card typed into Shopify\'s card fields (a frame per box) → stops at "Pay now"', async () => {
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
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [[handle, 1]], 'one of it (the cart link\'s :1)');
  assert.ok(store.state.requests.some((r) => r.path === `/jbhifi/products/${handle}.js`), 'looked up the option to buy');
  assert.ok(store.state.requests.some((r) => /^\/jbhifi\/cart\/\d+:1$/.test(r.path)), "Shopify's cart link, quantity 1");
  assert.ok(!store.state.requests.some((r) => r.path === '/jbhifi/cart' || r.path === '/jbhifi/cart/add'), 'no Add to cart press, no cart page');
  assert.equal(await shop.inputValue('input[name=email]'), PROFILE_A.email);
  assert.equal(await shop.inputValue('input[name=address1]'), PROFILE_A.address1, 'the street box (with suburb and postcode boxes next to it), typed — not a one-line lookup');
  assert.equal(await shop.inputValue('input[name=city]'), 'Sydney');
  assert.equal(await shop.inputValue('select[name=zone]'), 'NSW');
  assert.equal(await shop.inputValue('input[name=postalCode]'), '2000');
  await waitFor(async () => JSON.stringify(await shopifyCard(shop)) === JSON.stringify(EXPECT_SHOPIFY_CARD), { timeout: 20000, message: 'card number, expiry, security code and name on card, each in its own frame (real typing)' });
  assert.equal(await shop.inputValue('input[name=card_number]'), '4242 4242 4242 4242', 'and Shopify has it');
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
  await waitFor(async () => (await shopifyCard(shop)).number === '4242 4242 4242 4242', { message: "card in Shopify's card fields" });
  await shop.waitForTimeout(800);
  assert.equal(ordersPlaced(), 0, '"Pay now" was NOT pressed');
  await shop.close();
  await dash.close();
});

test('The Games Cube (CrystalCommerce, as its real checkout goes): its icon-only cart button → straight to checkout → "Checkout as a guest" → shipping address (first and last name, lines 1 and 2, city, state, zip, country, phone) → the first "Parcel Post" option → stops at "Checkout with PayPal" (its only payment)', async () => {
  await useItems([{ url: store.productUrl('thegamescube', '729233'), name: 'GC OP-17' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'GC OP-17');
  await waitReady(shop, 'Checkout with PayPal');
  const S = store.shop('thegamescube');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['729233', 1]], 'one of it, in the cart');
  assert.deepEqual(S.bagViews, [], 'straight to checkout, never the cart page');
  assert.deepEqual(S.data.contact, { name: 'Ash Ketchum', email: PROFILE_A.email }, 'a guest, with your name and email');
  const A = (k) => S.data.address[`address[${k}]`];
  assert.deepEqual(['first_name', 'last_name', 'street', 'street2', 'city', 'state', 'postcode', 'country', 'phone'].map(A),
    ['Ash', 'Ketchum', PROFILE_A.address1, 'Unit 2', 'Sydney', 'NSW', '2000', 'AU', PROFILE_A.phone], 'every box in its place (the state abbreviated)');
  assert.equal(await shop.isChecked('input[name=shipping][value=parcel]'), true, 'the first option under "Parcel Post"');
  assert.notEqual(await shop.title(), 'paypal', '"Checkout with PayPal" was NOT pressed');
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test('Gamerholic (Shopify, as its real checkout goes): ⚡ Buy → Shopify\'s cart link → your details → "Standard Shipping" chosen → card number, expiry and security code (no name box) → stops at "Pay now"', async () => {
  const handle = 'pokemon-tcg-mega-evolution-elite-trainer-box';
  await useItems([{ store: 'demo-gamerholic', sku: handle, name: 'GH ETB' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'GH ETB');
  await shop.waitForURL(/\/gamerholic\/checkouts\/c\/abc123$/, { timeout: 30000 });
  await waitReady(shop, 'Pay now');
  assert.deepEqual(store.shop('gamerholic').cart.map((c) => [c.sku, c.qty]), [[handle, 1]]);
  assert.equal(await shop.inputValue('input[name=email]'), PROFILE_A.email);
  assert.equal(await shop.inputValue('input[name=postalCode]'), '2000');
  assert.equal(await shop.isChecked('input[name=shipping][value=standard]'), true, '"Standard Shipping" (nothing was chosen)');
  await waitFor(async () => { const c = await shopifyCard(shop); return c.number === '4242 4242 4242 4242' && c.expiry === '07 / 29' && c.verification_value === '123'; }, { timeout: 20000, message: 'the card in its boxes' });
  assert.equal(shopifyBox(shop, 'name'), undefined, 'no name box at Gamerholic');
  await shop.waitForTimeout(500);
  assert.equal(ordersPlaced(), 0, '"Pay now" was NOT pressed');
  await shop.close();
  await dash.close();
});

test('Toys"R"Us (Shopify, at toysrus.com.au): ⚡ Buy → its cart link → your details → "Standard Shipping - AusPost" → Authority to leave and "use shipping address as billing" left ticked → card in Shopify\'s card fields → stops at "Pay now"', async () => {
  const handle = 'pokemon-tcg-scarlet-violet-151-ultra-premium-collection';
  await useItems([{ store: 'demo-toysrus', sku: handle, name: 'TRU UPC' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'TRU UPC');
  await shop.waitForURL(/\/toysrus\/checkouts\/c\/abc123$/, { timeout: 30000 });
  await waitReady(shop, 'Pay now');
  assert.deepEqual(store.shop('toysrus').cart.map((c) => [c.sku, c.qty]), [[handle, 1]]);
  assert.deepEqual(await Promise.all(['email', 'firstName', 'lastName', 'address1', 'city', 'postalCode', 'phone'].map((n) => shop.inputValue(`input[name=${n}]`))),
    [PROFILE_A.email, 'Ash', 'Ketchum', PROFILE_A.address1, 'Sydney', '2000', PROFILE_A.phone]);
  assert.equal(await shop.inputValue('select[name=countryCode]'), 'AU');
  assert.equal(await shop.inputValue('select[name=zone]'), 'NSW');
  assert.equal(await shop.isChecked('input[name=shipping][value=standard]'), true, '"Standard Shipping - AusPost"');
  assert.equal(await shop.isChecked('input[name=atl]'), true, 'Authority to leave: still ticked');
  assert.equal(await shop.isChecked('input[name=billingSame]'), true, 'shipping address as billing address: still ticked');
  await waitFor(async () => JSON.stringify(await shopifyCard(shop)) === JSON.stringify(EXPECT_SHOPIFY_CARD), { timeout: 20000, message: 'card number, expiry, security code, name on card' });
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

test('Target (beta, as its real checkout goes): "Add to basket" → the "Often Bought Together" pop-up closed with its ✕ → checkout → "Home Delivery" (a tile) → your details → your address picked from Target\'s suggestions → "Credit Card" (a tile) → card holder\'s name, number, MM/YY, CVV in Paydock\'s form → stops at "Place order"', async () => {
  await useItems([{ url: store.productUrl('target', '71234568'), name: 'Target Bundle' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Target Bundle');
  await waitReady(shop, 'Place order');
  const S = store.shop('target');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['71234568', 1]], 'none of the pop-up\'s clothes');
  assert.equal(await shop.getAttribute('.DeliveryOption[data-mode=home]', 'aria-checked'), 'true', '"Home Delivery"');
  assert.equal(await shop.getAttribute('.DeliveryOption[data-mode=cnc]', 'aria-checked'), 'false', 'never Click & Collect');
  const d = S.data.delivery;
  assert.deepEqual([d.mode, d.firstName, d.lastName, d.contactNumber, d.email], ['home', 'Ash', 'Ketchum', PROFILE_A.phone, PROFILE_A.email], 'your details');
  assert.equal(d.address, '1 Pallet Town Rd, SYDNEY NSW 2000', "your address, picked from Target's suggestions (not the look-alikes)");
  assert.equal(await shop.getAttribute('.PaymentTile[data-pay=card]', 'aria-checked'), 'true', '"Credit Card"');
  const pd = () => shop.frames().find((f) => f.url().includes('/paydock-widget'));
  await waitFor(async () => !!pd() && (await pd().inputValue('input[name=card_ccv]')) === '123', { timeout: 20000, message: "the card in Paydock's form" });
  assert.deepEqual(await Promise.all(['card_name', 'card_number', 'expire'].map((n) => pd().inputValue(`input[name=${n}]`))), ['Ash Ketchum', '4242 4242 4242 4242', '07/29']);
  assert.equal(await shop.isEnabled('#t-place'), true, '"Place order" ready to press');
  const userId = env.app.repo.userByUsername('ash').id;
  assert.ok(env.app.repo.listEvents(userId).some((e) => /Closed the "Often Bought Together" pop-up/.test(e.message)), 'the pop-up closed');
  await shop.waitForTimeout(800);
  assert.equal(ordersPlaced(), 0, '"Place order" was NOT pressed');
  await shop.close();
  await dash.close();
});

test('Target signed in: your details already there (left as they are) — the rest the same: "Home Delivery", your address from the suggestions, "Credit Card", the card → stops at "Place order"', async () => {
  store.state.signedIn.target = true;
  await useItems([{ url: store.productUrl('target', '71234568'), name: 'Target Bundle' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Target Bundle');
  await waitReady(shop, 'Place order');
  const d = store.shop('target').data.delivery;
  assert.equal(d.email, 'ash.target@example.com', "your Target account's email, not overwritten");
  assert.equal(d.address, '1 Pallet Town Rd, SYDNEY NSW 2000');
  assert.equal(await shop.isEnabled('#t-place'), true);
  assert.equal(ordersPlaced(), 0);
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

test('Premium Bandai (as its real checkout goes): "PLACE PRE-ORDER" once its Vue page has wired it up → "View Cart" → "Proceed to Checkout" → Global-e\'s checkout in a frame: your details (area Australia, state, phone after its +61), CREDIT CARD with the expiry month and year drop-downs, the purchase agreement ticked → stops at "Pay and Place Order"', async () => {
  store.set('pbandai', 'N2903432001', { status: 'preorder' });
  await useItems([{ url: store.productUrl('pbandai', 'N2903432001'), name: 'PB PCC' }]);
  const S = store.shop('pbandai');
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'PB PCC');
  await reach(shop, /\/pbandai\/checkout$/);
  assert.ok(S.addedAt - S.servedAt >= S.vueMs, 'not pressed before the page could take it');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['N2903432001', 1]], 'pressed once');
  assert.ok(S.bagViews.length >= 1, '"View Cart" → the cart → "Proceed to Checkout"');
  const ge = () => shop.frames().find((f) => f.url().includes('/ge-checkout'));
  const card = () => shop.frames().find((f) => f.url().includes('/ge-card'));
  await waitFor(async () => !!ge() && (await ge().inputValue('input[name=Address1]')) === PROFILE_A.address1, { timeout: 20000, message: 'delivery details in the checkout frame' });
  assert.deepEqual(await Promise.all(['FirstName', 'LastName', 'Email', 'Address2', 'City', 'Zip'].map((n) => ge().inputValue(`input[name=${n}]`))),
    ['Ash', 'Ketchum', PROFILE_A.email, 'Unit 2', 'Sydney', '2000']);
  assert.equal(await ge().inputValue('select[name=CountryID]'), '12', 'Area: Australia');
  assert.equal(await ge().inputValue('select[name=StateOrProvinceID]'), 'NSW');
  assert.equal(await ge().inputValue('input[name=Phone1]'), '412345678', 'the number after the +61 already shown');
  await waitFor(async () => !!card() && (await card().inputValue('input[name=cvv]')) === '123', { timeout: 20000, message: 'the card in its frame' });
  assert.deepEqual(await Promise.all(['input[name=cardNumber]', 'select[name=expMonth]', 'select[name=expYear]'].map((q) => card().inputValue(q))), ['4242 4242 4242 4242', '07', '2029'], 'card number, and the expiry month and year from their drop-downs');
  assert.equal(await ge().isChecked('input[name=PaymentMethod][value=cc]'), true, 'CREDIT CARD');
  await waitFor(() => ge().isChecked('input[name=Terms]'), { message: 'the purchase agreement ticked' });
  assert.equal(await ge().isChecked('input[name=Newsletter]'), false, 'never the newsletter');
  await shop.waitForFunction(() => /Ready — review everything and press "Pay and Place Order" yourself/.test(document.querySelector('#mugibot-qc')?.textContent || ''), null, { timeout: 30000 });
  await shop.waitForTimeout(800);
  assert.equal(S.orders.length, 0, '"Pay and Place Order" was NOT pressed');
  await shop.close();
  await dash.close();
});

test('Amazon signed out: ⚡ Buy says to sign in first (Amazon has no guest checkout) and presses nothing', async () => {
  await useItems([{ url: store.productUrl('amazon', 'B0MGBTEST1'), name: 'AMZ Bundle' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'AMZ Bundle');
  await shop.waitForFunction(() => /only sells to signed-in customers — sign in to Amazon AU \(dummy store\) in this browser first/.test(document.querySelector('#mugibot-qc')?.textContent || ''), null, { timeout: 20000 });
  await shop.waitForTimeout(1500);
  assert.deepEqual(store.shop('amazon').steps, [], '"Buy Now" was not pressed');
  assert.match(shop.url(), /\/amazon\/dp\//, 'still on the product page');
  await shop.close();
  await dash.close();
});

test('Amazon signed in: "Buy Now" → Amazon\'s "Try Prime FREE" offer: "No thanks" → checkout with your Amazon address and card → stops at "Place your order"', async () => {
  store.state.signedIn.amazon = true;
  const S = store.shop('amazon');
  S.primeOffer = true;
  await useItems([{ url: store.productUrl('amazon', 'B0MGBTEST1'), name: 'AMZ Bundle' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'AMZ Bundle');
  await shop.waitForURL(/\/amazon\/checkout\/p\/p-123\/spc$/, { timeout: 30000 });
  await waitReady(shop, 'Place your order');
  assert.deepEqual(S.steps.map((x) => x.step), ['buynow', 'prime-declined'], '"Buy Now", then "No thanks" to Prime');
  assert.notEqual(S.joinedPrime, true, 'never "Start your free trial"');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['B0MGBTEST1', 1]]);
  const userId = env.app.repo.userByUsername('ash').id;
  assert.ok(env.app.repo.listEvents(userId).some((e) => /AMZ Bundle: Clicked "Buy Now"/.test(e.message)));
  await shop.waitForTimeout(800);
  assert.equal(S.orders.length, 0, '"Place your order" was NOT pressed');
  await shop.close();
  await dash.close();
});

/** A ⚡ Buy button pressed in Discord — on a phone, say: Discord tells Mugibot who pressed it. */
async function pressInDiscord(discordId, customId) {
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify({ type: 3, id: `i-${token}`, token, member: { user: { id: discordId } }, data: { custom_id: customId, component_type: 2 } });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${env.url}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': keys.sign(ts, body), 'x-signature-timestamp': ts }, body });
  const out = await res.json();
  return { token, content: out.data && out.data.content };
}

test("the ⚡ Buy button in a Discord DM, pressed on a phone: this browser (your checkout browser) opens the store and checks out by itself — nothing armed, nothing signed in where it was pressed — and Discord's reply follows it", async () => {
  // Connect Discord for Ash (the fake Discord sends straight back).
  const page = await ctx.newPage();
  discord.state.nextUser = 'd-ash';
  await page.goto(`${env.url}/auth/discord`);
  await page.waitForURL(/discord=linked/);
  await page.close();
  await useItems([{ url: store.productUrl('kmart', '43818648'), name: 'Kmart UPC' }]);
  const userId = env.app.repo.userByUsername('ash').id;
  const row = env.app.db.get("SELECT * FROM items WHERE user_id = :u AND sku = '43818648'", { u: userId });
  store.set('kmart', '43818648', { status: 'in_stock' });
  const before = discord.dmsTo('d-ash').length;
  await env.app.monitor.applyResult({ ...row, status: 'out_of_stock' }, { status: 'in_stock', price: 360 }, 'server');
  const dm = discord.dmsTo('d-ash').slice(before)[0];
  const button = dm.body.components[0].components[0];
  assert.equal(button.label, '⚡ Buy');
  assert.equal(button.custom_id, `buy:i:${row.id}`, 'a button Discord tells Mugibot about, not a link to open');
  // This browser is Ash's checkout browser (the only one), and listens for runs with nothing armed.
  await waitFor(async () => (await browserApi('GET', '/api/aco')).body.browsers.some((b) => b.checkout && b.listening), { timeout: 40000, message: 'this browser listening for runs' });
  assert.equal(env.app.aco.armedCount(userId), 0);

  const opened = ctx.waitForEvent('page', { predicate: (p) => p.url().startsWith(`${store.url}/kmart`), timeout: 20000 });
  const reply = await pressInDiscord('d-ash', button.custom_id);
  assert.match(reply.content, /Sent to \*\*.+\*\* — waiting for it to open Kmart \(dummy store\)/);
  assert.match(reply.content, /stops at the final button — Auto-checkout is off/);
  const shop = await opened;
  await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 25000 });
  await shop.waitForFunction(() => /review everything and press "Checkout securely" yourself/.test(document.querySelector('#mugibot-qc')?.textContent || ''), null, { timeout: 40000 });
  assert.deepEqual(store.shop('kmart').cart.map((c) => [c.sku, c.qty]), [['43818648', 1]]);
  assert.equal(await shop.inputValue('input[name=cardNumber]'), '4242 4242 4242 4242', 'the card in, from this browser');
  await waitFor(() => /Checkout's ready/.test(discord.repliesFor(reply.token).at(-1) || ''), { timeout: 15000, message: 'Discord\'s reply: checkout ready' });
  assert.match(discord.repliesFor(reply.token).at(-1), /press Kmart \(dummy store\)'s final button there to buy/);
  await shop.waitForTimeout(800);
  assert.equal(ordersPlaced(), 0, 'Auto-checkout off: the final button is left to Ash');
  await shop.close();
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
  // (The ⚡ Buy tests before this one were signed in at some stores too — Target's page said so — so count these.)
  for (const id of ['demo-jbhifi', 'demo-thegamescube']) assert.equal(await page.locator(`#logins li.login.in[data-store="${id}"]`).count(), 1, id);
  assert.match(await page.textContent('#logins-sum'), /^Signed in at \d+ of \d+ stores\. Signed out at .*Trainer Town \(dummy store\)/);
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
  assert.equal(store.shop('target').data.delivery.mode, 'home', '"Home Delivery"');
  assert.equal(store.shop('target').data.delivery.address, '1 Pallet Town Rd, SYDNEY NSW 2000', 'the address from the suggestions');
  assert.deepEqual([order.form.cardName, order.form.cardNumber, order.form.cardExpiry, order.form.cardCvv], ['Ash Ketchum', '4242 4242 4242 4242', '07/29', '123'], "the card, from Paydock's form");
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

/** Trigger ACO (a test run now) for one of your items: this browser checks it out like a drop. */
async function testRun(name) {
  // (Each of these tests a day of its own: the orders the tests before it placed count as yesterday's.)
  env.app.db.run('UPDATE aco_runs SET created_at = created_at - 2 * 86400000 WHERE user_id = :u', { u: env.app.repo.userByUsername('ash').id });
  const it = (await browserApi('GET', '/api/items')).body.items.find((x) => x.name === name);
  let r = await browserApi('POST', `/api/aco/test/${it.id}`);
  // (A few test runs a minute at most: the suite's many runs wait their turn.)
  for (let i = 0; i < 8 && r.status === 429; i++) {
    await new Promise((res) => setTimeout(res, 10000));
    r = await browserApi('POST', `/api/aco/test/${it.id}`);
  }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // (The browser picks the run up as it asks: nothing's armed, so it asks once, now — with what your account
  // says now, as the dashboard's Trigger ACO has it do, not what it last heard: it'd wait for its next alarm.)
  await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('state:')));
    globalThis.mugibotAcoLoop();
    return true;
  });
  return r.body.run;
}
/** Signed in at a store, and the extension has seen it (its 10-minute check, now): the account knows. */
async function seenSignedIn(shop) {
  store.state.signedIn[shop] = true;
  await sw.evaluate(() => globalThis.mugibotCheckLogins({ force: true }));
  await waitFor(async () => (await browserApi('GET', '/api/logins')).body.stores.find((x) => x.id === `demo-${shop}`).status === 'in', { message: `signed in at ${shop}, seen by the extension` });
}
const runOver = async (message) => {
  try {
    await waitFor(async () => ['placed', 'needs_you', 'failed', 'ready', 'skipped', 'expired'].includes((await lastRun()).status), { timeout: 60000, message });
  } catch (e) {
    // (Where it got to: the run's last step, and what each store tab's panel said.)
    const run = await lastRun();
    const said = await Promise.all(ctx.pages().filter((pg) => pg.url().startsWith(store.url)).map(async (pg) => `${pg.url()}: ${await pg.locator('#mugibot-qc').textContent().catch(() => '-')}`));
    throw new Error(`${message}: the run is "${run.status}" (${JSON.stringify(run.steps.at(-1))}) — ${said.join(' | ')}`);
  }
  return lastRun();
};

test('🤖 Auto-checkout at EB Games: Home Delivery (not the Click & Collect EB chose), your address from its suggestions, Credit / Debit card, "Done" once the card is in, the total checked → "CONFIRM & PAY" — placed', async () => {
  await useItems([{ url: store.productUrl('ebgames', '312346'), name: 'ACO EB ETB', maxPrice: 120 }]);
  await testRun('ACO EB ETB');
  const run = await runOver('the EB Games run over');
  assert.equal(run.status, 'placed', JSON.stringify(run));
  const S = store.shop('ebgames');
  assert.equal(S.orders.length, 1, 'placed once');
  assert.deepEqual(S.orders[0].cart.map((c) => [c.sku, c.qty]), [['312346', 1]]);
  assert.equal(S.orders[0].form.fulfilment, 'home');
  assert.equal(S.orders[0].form.address, '1 Pallet Town Rd, SYDNEY NSW 2000');
  assert.equal(S.orders[0].form.cardDone, '4242', 'the card went in, then "Done"');
  assert.equal(run.total, 109.9, '$99.95 + $9.95 delivery, read from the checkout');
  const userId = env.app.repo.userByUsername('ash').id;
  assert.ok(env.app.repo.listEvents(userId).some((e) => /Auto-checkout pressed "CONFIRM & PAY"/.test(e.message)));
  await closeStorePages('ebgames');
});

test('🤖 Auto-checkout at EB Games signed in: it\'s all in already (your saved card included) — straight to "CONFIRM & PAY", placed', async () => {
  store.state.signedIn.ebgames = true;
  await useItems([{ url: store.productUrl('ebgames', '312346'), name: 'ACO EB ETB', maxPrice: 120 }]);
  await testRun('ACO EB ETB');
  const run = await runOver('the EB Games run over');
  assert.equal(run.status, 'placed', JSON.stringify(run));
  assert.equal(store.shop('ebgames').orders[0].form.cardDone, 'saved', "EB's saved card");
  assert.equal(store.shop('ebgames').data.card, undefined, 'no card typed (EB had it)');
  await closeStorePages('ebgames');
});

test('🤖 Auto-checkout at JB Hi-Fi: Shopify\'s cart link → your details → the card typed into Shopify\'s card fields → "Pay now" — placed', async () => {
  const handle = 'pokemon-tcg-30th-celebration-etb';
  await useItems([{ store: 'demo-jbhifi', sku: handle, name: 'ACO JB ETB', maxPrice: 120 }]);
  await testRun('ACO JB ETB');
  const run = await runOver('the JB Hi-Fi run over');
  assert.equal(run.status, 'placed', JSON.stringify(run));
  const o = store.shop('jbhifi').orders[0];
  assert.deepEqual(o.cart.map((c) => [c.sku, c.qty]), [[handle, 1]]);
  assert.deepEqual([o.form.card_number, o.form.card_expiry, o.form.card_cvv, o.form.card_name], ['4242 4242 4242 4242', '07 / 29', '123', 'Ash Ketchum']);
  assert.equal(o.form.shipping, 'standard');
  assert.equal(run.total, 109, '$99 + $10 shipping');
  await closeStorePages('jbhifi');
});

test('🤖 Auto-checkout at Toys"R"Us signed in with Shop: Shop Pay has your details and card (no card boxes) → "Pay now" — placed', async () => {
  store.state.signedIn.toysrus = 'shop';
  const handle = 'pokemon-tcg-scarlet-violet-151-ultra-premium-collection';
  await useItems([{ store: 'demo-toysrus', sku: handle, name: 'ACO TRU UPC', maxPrice: 200 }]);
  await testRun('ACO TRU UPC');
  const run = await runOver('the Toys"R"Us run over');
  assert.equal(run.status, 'placed', JSON.stringify(run));
  const o = store.shop('toysrus').orders[0];
  assert.equal(o.shopPay, true, 'paid with Shop Pay\'s saved card');
  assert.equal(o.form.shipping, 'standard', '"Standard Shipping - AusPost"');
  assert.equal(o.form.atl, 'on', 'Authority to leave, still ticked');
  assert.equal(o.form.email, 'ash.shop@example.com', 'your Shop details, not overwritten');
  await closeStorePages('toysrus');
});

test('🤖 Auto-checkout at Amazon (signed in): "Buy Now" → "No thanks" to Prime → your Amazon address and card → the total checked → "Place your order" — placed', async () => {
  // (Amazon only sells signed in: a browser last seen signed out there — the login monitor's test — is skipped.)
  await seenSignedIn('amazon');
  store.shop('amazon').primeOffer = true;
  await useItems([{ url: store.productUrl('amazon', 'B0MGBTEST1'), name: 'ACO AMZ Bundle', maxPrice: 70 }]);
  await testRun('ACO AMZ Bundle');
  const run = await runOver('the Amazon run over');
  assert.equal(run.status, 'placed', JSON.stringify(run));
  const S = store.shop('amazon');
  assert.deepEqual(S.steps.map((x) => x.step), ['buynow', 'prime-declined']);
  assert.notEqual(S.joinedPrime, true, 'never joined Prime');
  assert.equal(S.orders.length, 1);
  assert.equal(run.total, 59);
  await closeStorePages('amazon');
});

test("🤖 Auto-checkout at Amazon's quick checkout (a window over the product page): filled in and placed in its frame", async () => {
  await seenSignedIn('amazon');
  store.shop('amazon').turbo = true;
  await useItems([{ url: store.productUrl('amazon', 'B0MGBTEST1'), name: 'ACO AMZ Bundle', maxPrice: 70 }]);
  await testRun('ACO AMZ Bundle');
  const run = await runOver('the Amazon quick-checkout run over');
  assert.equal(run.status, 'placed', JSON.stringify(run));
  const S = store.shop('amazon');
  assert.equal(S.orders.length, 1);
  assert.equal(S.orders[0].turbo, true, 'placed in the quick checkout');
  assert.equal(run.total, 59);
  await closeStorePages('amazon');
});

test('🤖 Auto-checkout at Premium Bandai (signed in): "PLACE PRE-ORDER" → "View Cart" → "Proceed to Checkout" → Global-e\'s frame: "Default (same as billing address)", the card, the agreement ticked, the total checked → "Pay and Place Order" — placed', async () => {
  store.state.signedIn.pbandai = true;
  store.set('pbandai', 'N2903432001', { status: 'preorder' });
  await useItems([{ url: store.productUrl('pbandai', 'N2903432001'), name: 'ACO PB PCC', maxPrice: 40 }]);
  await testRun('ACO PB PCC');
  const run = await runOver('the Premium Bandai run over');
  assert.equal(run.status, 'placed', JSON.stringify(run));
  const o = store.shop('pbandai').orders[0];
  assert.deepEqual(o.cart.map((c) => [c.sku, c.qty]), [['N2903432001', 1]]);
  assert.equal(o.form.DeliveryAddress, 'default', '"Default (same as billing address)"');
  assert.equal(o.form.Terms, true, 'the purchase agreement ticked');
  assert.equal(o.form.Newsletter, undefined, 'never the newsletter');
  assert.deepEqual([o.form.card.cardNumber, o.form.card.expMonth, o.form.card.expYear, o.form.card.cvv], ['4242 4242 4242 4242', '07', '2029', '123']);
  assert.equal(o.form.Email, 'ash.bandai@example.com', 'your Bandai billing details, not overwritten');
  assert.equal(run.total, 40, '$25 + $15 shipping, read in the frame');
  await waitFor(() => ctx.pages().some((pg) => /\/pbandai\/checkout\/confirmation$/.test(pg.url())), { message: 'Premium Bandai\'s confirmation' });
  await closeStorePages('pbandai');
});

test('🤖 Auto-checkout at The Games Cube: fills everything in, then stops at "Checkout with PayPal" (it only takes PayPal) and says so — nothing paid', async () => {
  await useItems([{ url: store.productUrl('thegamescube', '729233'), name: 'ACO GC OP-17', maxPrice: 200 }]);
  await testRun('ACO GC OP-17');
  const run = await runOver('the Games Cube run over');
  assert.equal(run.status, 'needs_you');
  assert.equal(run.reason, 'paypal_only');
  assert.match(run.message, /only takes PayPal/);
  const page = ctx.pages().find((pg) => /\/thegamescube\/checkout\/index$/.test(pg.url()));
  assert.ok(page, 'the checkout left open for you');
  assert.notEqual(await page.title(), 'paypal', 'PayPal not pressed');
  assert.equal(await page.isChecked('input[name=shipping][value=parcel]'), true);
  await closeStorePages('thegamescube');
});

test('🤖 ⚡ Buy with Mugibot on a channel alert, pressed on a phone with Auto-checkout on: this browser checks out by itself and places the order — up to the price the alert showed — and Discord\'s reply says so', async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  await useItems([]);
  const alert = env.app.catalog.addAlert({ product_id: null, kind: 'restock', store: 'demo-kmart', sku: '43818587', name: 'Kmart ETB drop', url: store.productUrl('kmart', '43818587'), category: 'pokemon', status: 'in_stock', price: 100 });
  // (A day of its own, like the Trigger ACO tests: the orders before it count as yesterday's.)
  env.app.db.run('UPDATE aco_runs SET created_at = created_at - 2 * 86400000 WHERE user_id = :u', { u: userId });
  const reply = await pressInDiscord('d-ash', `buy:a:${alert.id}`);
  assert.match(reply.content, /It places the order by itself, within your Auto-checkout limits \(up to \$100\.00 for it, plus delivery\)/);
  const run = await runOver('the ⚡ Buy from Discord over');
  assert.equal(run.status, 'placed', JSON.stringify(run));
  assert.equal(run.trigger, 'remote');
  const S = store.shop('kmart');
  assert.equal(S.orders.length, 1, 'placed once');
  assert.deepEqual(S.orders[0].cart.map((c) => [c.sku, c.qty]), [['43818587', 1]]);
  assert.ok((await browserApi('GET', '/api/items')).body.items.some((x) => x.sku === '43818587'), 'on the watchlist now');
  await waitFor(() => /Order placed/.test(discord.repliesFor(reply.token).at(-1) || ''), { timeout: 15000, message: "Discord's reply: order placed" });
  await closeStorePages('kmart');
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

// --- Checkpoints and virtual queues (server/monitor/gates.js) -------------------------------------
/** The gaps between each visitor's requests while they were in the queue: nothing but the queue page's own refreshes. */
function queueGaps(q) {
  const by = {};
  for (const e of q.log) if (e.id && e.what !== 'redirect') (by[e.id] = by[e.id] || []).push(e.at);
  return Object.values(by).flatMap((ts) => ts.slice(1).map((t, i) => t - ts[i]));
}
/** The extension's own record of a store's queue in this browser (its tabs in line, through or not). */
const gatesHere = () => sw.evaluate(() => globalThis.mugibotGates());

test("🛡️ JB Hi-Fi's checkpoint: ⚡ Buy runs into it and waits for you there — never touching the hCaptcha; you solve it, and it carries on to checkout", async () => {
  const handle = 'pokemon-tcg-30th-celebration-etb';
  await useItems([{ store: 'demo-jbhifi', sku: handle, name: 'JB ETB checkpoint' }]);
  const S = store.shop('jbhifi');
  S.checkpoint.on = true;
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'JB ETB checkpoint');
  await reach(shop, /\/jbhifi\/checkpoint\?return_to=/);
  await shop.waitForFunction(() => /checkpoint/.test(document.querySelector('#mugibot-qc')?.textContent || '')
    && /wants a human check here\. Solve it yourself — Mugibot never touches it — and it carries on to checkout as soon as you have/.test(document.querySelector('#mugibot-qc').textContent), null, { timeout: 15000 });
  // However long you take: the ⚡ Buy (90 seconds to reach checkout) is kept going while you're at the check.
  await shop.evaluate(() => { const f = JSON.parse(sessionStorage.getItem('mgbFlow')); f.startedAt = Date.now() - 85000; sessionStorage.setItem('mgbFlow', JSON.stringify(f)); });
  await shop.waitForFunction(() => { const f = JSON.parse(sessionStorage.getItem('mgbFlow') || 'null'); return !!f && Date.now() - f.startedAt < 20000; }, null, { timeout: 25000 });
  assert.equal(S.checkpoint.botClicks, 0, 'the check is never touched');
  assert.equal(S.checkpoint.solved, 0);
  assert.equal(S.checkpoint.shown, 1, 'and the page never reloaded');
  // Seen: the account hears it (a member's browser — one member alone doesn't make it "up" for everyone).
  await waitFor(() => env.app.db.get("SELECT 1 FROM gates WHERE store = 'demo-jbhifi'"), { message: 'the sighting reported' });
  // You solve it (a person's click) → straight on to checkout, filled in, stopping at "Pay now".
  await shop.click('#hcaptcha-box');
  await shop.click('#checkpoint-submit');
  await reach(shop, /\/jbhifi\/checkouts\/c\/abc123$/);
  await waitReady(shop, 'Pay now');
  assert.equal(S.checkpoint.solved, 1);
  assert.equal(S.checkpoint.botClicks, 0);
  await waitFor(async () => JSON.stringify(await shopifyCard(shop)) === JSON.stringify(EXPECT_SHOPIFY_CARD), { timeout: 20000, message: 'the card typed in' });
  assert.equal(ordersPlaced(), 0, '"Pay now" was NOT pressed');
  await shop.close();
  await dash.close();
});

test("🛡️ Auto-checkout at JB Hi-Fi's checkpoint: the run waits for you (it says so, and brings the tab forward), you solve it, and the order is placed", async () => {
  await browserApi('PUT', '/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 200, perDay: 6, spendPerDay: 900 });
  const handle = 'pokemon-tcg-30th-celebration-etb';
  await useItems([{ store: 'demo-jbhifi', sku: handle, name: 'ACO JB checkpoint', maxPrice: 120 }]);
  const S = store.shop('jbhifi');
  S.checkpoint.on = true;
  await testRun('ACO JB checkpoint');
  await waitFor(async () => (await lastRun()).status === 'waiting', { timeout: 30000, message: 'the run waiting at the checkpoint' });
  const waiting = await lastRun();
  assert.equal(waiting.reason, 'checkpoint');
  assert.equal(waiting.statusText, 'Waiting for you at the checkpoint');
  await waitFor(() => discord.dmsTo('d-ash').some((m) => /checkpoint needs you: ACO JB checkpoint/.test(m.body.embeds[0].title)), { message: 'the "checkpoint needs you" DM' });
  const shop = ctx.pages().find((pg) => /\/jbhifi\/checkpoint/.test(pg.url()));
  assert.ok(shop, 'the checkpoint, open in its tab');
  assert.equal(S.checkpoint.botClicks, 0);
  await shop.click('#hcaptcha-box');
  await shop.click('#checkpoint-submit');
  const run = await runOver('the JB Hi-Fi run past the checkpoint');
  assert.equal(run.status, 'placed', JSON.stringify(run));
  assert.deepEqual(run.steps.map((x) => x.status).filter((x, i, a) => a.indexOf(x) === i), ['queued', 'sent', 'started', 'waiting', 'checkout', 'placing', 'placed']);
  assert.equal(S.orders.length, 1, 'placed once');
  assert.equal(S.checkpoint.botClicks, 0, 'the check was yours alone');
  await closeStorePages('jbhifi');
  await browserApi('PUT', '/api/aco', { enabled: false });
});

test("🚦 EB Games' virtual queue: an Auto-checkout run opens the store into the queue, waits its turn — never refreshing the page, nothing else asking EB for anything — and places the order once it's through", async () => {
  await browserApi('PUT', '/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 200, perDay: 6, spendPerDay: 900 });
  await useItems([{ url: store.productUrl('ebgames', '312346'), name: 'ACO EB queue', maxPrice: 120 }]);
  const S = store.shop('ebgames');
  Object.assign(S.queue, { on: true, admitAfterMs: 9000, refreshMs: 1500, tooSoonMs: 900, wait: 23 });
  await testRun('ACO EB queue');
  await waitFor(async () => (await lastRun()).status === 'waiting', { timeout: 30000, message: 'the run waiting in the queue' });
  const waiting = await lastRun();
  assert.equal(waiting.reason, 'queue');
  assert.equal(waiting.statusText, 'Waiting in line');
  assert.match(waiting.message, /virtual queue — about 23 min/);
  const tab = ctx.pages().find((pg) => pg.url().startsWith(`${store.url}/ebgames/product/`));
  assert.ok(tab);
  await tab.waitForFunction(() => /In EB Games \(dummy store\)'s virtual queue/.test(document.querySelector('#mugibot-qc')?.textContent || '')
    && /never refreshes it/.test(document.querySelector('#mugibot-qc').textContent), null, { timeout: 10000 });
  // While it's in line: the extension knows this browser is in EB's queue, and holds everything else there.
  const here = await gatesHere();
  assert.ok(here.held.includes('demo-ebgames'), JSON.stringify(here));
  assert.equal(Object.keys(here.gates['demo-ebgames'].line).length, 1, 'one tab in line');
  // Your browser's own checks of your SKUs there, and its sign-in checks: none while it's in line (the
  // server doesn't know the queue's up yet — one member's browser isn't enough — so this browser holds them itself).
  env.app.repo.setSetting('retailer:demo-ebgames', { serverChecks: false });
  env.app.db.run('UPDATE items SET browser_next_at = 0');
  const eb = () => store.state.requests.filter((x) => x.path.startsWith('/ebgames/product/')).length;
  const asked = eb();
  await sw.evaluate(() => globalThis.mugibotRunChecks());
  await sw.evaluate(() => globalThis.mugibotCheckLogins({ force: true }));
  env.app.repo.setSetting('retailer:demo-ebgames', {});
  assert.ok(eb() - asked <= 2, 'no check of it (only the queue page refreshing itself) — the gaps below prove it');
  // Through (the queue page moved on by itself), then checked out and placed.
  const run = await runOver('the EB Games run through the queue');
  assert.equal(run.status, 'placed', JSON.stringify(run));
  assert.equal(S.orders.length, 1);
  assert.deepEqual(S.orders[0].cart.map((c) => [c.sku, c.qty]), [['312346', 1]]);
  assert.ok(run.steps.some((x) => x.status === 'waiting'));
  assert.ok(run.steps.some((x) => x.status === 'started' && /Through EB Games \(dummy store\)'s virtual queue/.test(x.message)), JSON.stringify(run.steps));
  // Never lost its place: the only requests while it waited were the queue page's own refreshes.
  assert.equal(S.queue.kicks, 0, 'nothing asked again too soon');
  assert.ok(S.queue.shown >= 3, `it waited (${S.queue.shown} queue pages)`);
  assert.equal(S.queue.admitted, 1);
  const gaps = queueGaps(S.queue);
  assert.ok(gaps.length >= 2 && Math.min(...gaps) >= 1200, `only the page's own refreshes: ${gaps.join(', ')} ms`);
  const after = await gatesHere();
  assert.ok(after.through.includes('demo-ebgames'), 'through it now');
  await closeStorePages('ebgames');
  S.queue.on = false;
  await browserApi('PUT', '/api/aco', { enabled: false });
});

test("🚦 ⚡ Buy into Pokémon Center's queue (/?queue): it waits in line with you, then — through, on the store's front page — opens the product and checks out (stopping at the final button)", async () => {
  await useItems([{ url: store.productUrl('pokemoncenter', '10-10447-108'), name: 'PC ETB queue' }]);
  const S = store.shop('pokemoncenter');
  Object.assign(S.queue, { on: true, admitAfterMs: 6000, refreshMs: 1500, tooSoonMs: 900, wait: 12 });
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'PC ETB queue');
  await reach(shop, /\/pokemoncenter\/\?queue$/);
  await shop.waitForFunction(() => /In Pokémon Center \(dummy store\)'s virtual queue/.test(document.querySelector('#mugibot-qc')?.textContent || ''), null, { timeout: 10000 });
  assert.equal(S.cart.length, 0, 'nothing added while in line');
  await waitReady(shop, 'Place Order');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['10-10447-108', 1]]);
  assert.equal(S.queue.kicks, 0);
  const gaps = queueGaps(S.queue);
  assert.ok(Math.min(...gaps) >= 1200, `only the page's own refreshes: ${gaps.join(', ')} ms`);
  assert.equal(ordersPlaced(), 0, '"Place Order" was NOT pressed');
  await shop.close();
  await dash.close();
  S.queue.on = false;
});

test("🚦 a queue page drawn by its own code after it opens (and reloading itself before Mugibot can tell): the ⚡ Buy isn't lost — it waits in line, then checks out", async () => {
  await useItems([{ url: store.productUrl('ebgames', '312346'), name: 'EB ETB late queue' }]);
  const S = store.shop('ebgames');
  Object.assign(S.queue, { on: true, admitAfterMs: 10000, refreshMs: 2500, tooSoonMs: 900, wait: 7, lateMs: 1200 });
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'EB ETB late queue');
  await shop.waitForFunction(() => /You're in the queue/.test(document.body.innerText), null, { timeout: 15000 });
  await waitReady(shop, 'CONFIRM & PAY');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['312346', 1]], 'one of it, once');
  assert.equal(S.queue.kicks, 0);
  assert.ok(S.queue.shown >= 3, `it waited (${S.queue.shown} queue pages)`);
  assert.equal(ordersPlaced(), 0, 'stopped at the final button');
  await shop.close();
  await dash.close();
  S.queue.on = false;
});

test("🚦 a store page that only mentions its queue (a launch banner) is the store: ⚡ Buy goes straight through, as fast as ever", async () => {
  await useItems([{ url: store.productUrl('pokemoncenter', '10-10447-108'), name: 'PC ETB banner' }]);
  const S = store.shop('pokemoncenter');
  S.banner = "Big launches use a virtual queue: you're in the queue when you see our waiting room page. Thanks for your patience!";
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'PC ETB banner');
  await waitReady(shop, 'Place Order');
  assert.deepEqual(S.cart.map((c) => [c.sku, c.qty]), [['10-10447-108', 1]]);
  assert.doesNotMatch(await panel(shop).textContent(), /virtual queue|in line/);
  assert.ok(!env.app.db.get("SELECT 1 FROM gates WHERE store = 'demo-pokemoncenter' AND status = 'up'"), 'no queue reported');
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test("🚦 a queue goes up where you're armed: your checkout browser gets in line by itself (one tab, in the background); a drop meanwhile waits for it — no second tab into the queue — then opens the store from there and places the order", async () => {
  await browserApi('PUT', '/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 200, perDay: 6, spendPerDay: 900 });
  await useItems([{ url: store.productUrl('ebgames', '312346'), name: 'ACO EB lobby', aco: true, maxPrice: 120 }]);
  env.app.db.run('UPDATE aco_runs SET created_at = created_at - 2 * 86400000 WHERE user_id = :u', { u: env.app.repo.userByUsername('ash').id });
  const S = store.shop('ebgames');
  Object.assign(S.queue, { on: true, admitAfterMs: 12000, refreshMs: 1500, tooSoonMs: 900, wait: 30 });
  await acoListen();
  const r = env.app.retailers.get('demo-ebgames');
  const pagesBefore = ctx.pages().length;
  env.app.gates.flip(r, 'up', { source: 'probe', wait: 30 });
  await waitFor(() => ctx.pages().some((pg) => pg.url() === `${store.url}/ebgames/`), { timeout: 30000, message: 'a tab in line at EB Games' });
  const lobby = ctx.pages().find((pg) => pg.url() === `${store.url}/ebgames/`);
  await waitFor(async () => Object.keys(((await gatesHere()).gates['demo-ebgames'] || {}).line || {}).length === 1, { message: 'in line' });
  // It drops while the lobby's in line: the run waits for it (no second tab knocking on the queue).
  const run0 = await env.app.aco.trigger(env.app.db.get("SELECT * FROM items WHERE name = 'ACO EB lobby'"), { price: 99.95, source: 'browser' });
  assert.ok(run0);
  await waitFor(async () => (await lastRun()).status === 'waiting', { timeout: 20000, message: 'the run waiting for the tab in line' });
  assert.match((await lastRun()).message, /In EB Games \(dummy store\)'s virtual queue in this browser — about 30 min — it checks out once it's through/);
  assert.equal(ctx.pages().filter((pg) => pg.url().startsWith(`${store.url}/ebgames`)).length, 1, 'still only the one tab at EB Games');
  // Through: the run opens the store (a fresh link) and places the order.
  const run = await runOver('the run after the lobby got through');
  assert.equal(run.status, 'placed', JSON.stringify(run));
  assert.equal(S.orders.length, 1);
  assert.equal(S.queue.kicks, 0, 'nobody lost their place');
  assert.equal(S.queue.admitted, 1, 'one place in line, for the whole browser');
  assert.ok(ctx.pages().length > pagesBefore);
  await lobby.close().catch(() => null);
  await closeStorePages('ebgames');
  env.app.gates.flip(r, 'down', { source: 'probe' });
  S.queue.on = false;
  await browserApi('PUT', '/api/aco', { enabled: false });
  await useItems([]);
});

test("🚦 an admin's browser: a search that runs into EB's queue waits (its tab never reloaded); a look as a new visitor (no cookies) sees the queue go up and come down; #virtual-queue-detection gets both", async () => {
  const userId = env.app.repo.userByUsername('ash').id;
  const sweeper = env.app.sweeper;
  const off = Object.fromEntries(sweeper.stores().map((s) => [s.retailer.id, 'off']));
  sweeper.save({ browserEverySeconds: 5, stores: { ...off, 'demo-ebgames': 'browser' } }, null);
  Object.assign(env.app.cfg.monitor, { gateCheckSeconds: 2, gateDownGapSeconds: 2 });
  env.app.repo.updateUser(userId, { role: 'admin' });
  const S = store.shop('ebgames');
  const posts = () => { const ch = discord.state.channels.find((c) => c.name === 'virtual-queue-detection'); return ch ? discord.channelPosts(ch.id) : []; };
  const before = posts().length;
  try {
    // A search first (its tab open at EB Games), then the queue goes up.
    await sw.evaluate(() => { globalThis.mugibotSweepLoop(); return true; });
    await waitFor(() => store.state.requests.some((x) => x.path === '/ebgames/search/query'), { timeout: 30000, message: 'a search from the sweep window' });
    Object.assign(S.queue, { on: true, admitAfterMs: 600000, refreshMs: 1500, tooSoonMs: 900, wait: 45 });
    await waitFor(() => env.app.gates.get('demo-ebgames').status === 'up', { timeout: 30000, message: 'the queue seen up' });
    await waitFor(() => posts().length === before + 1, { message: 'posted' });
    assert.equal(posts().at(-1).body.embeds[0].description.split('\n')[0], `🟢 Virtual queue up for EB Games (dummy store) | ${store.url}/ebgames/`);
    // The sweep tab: never sent anywhere while the queue's up (the server holds its searches; the extension does too).
    await new Promise((res) => setTimeout(res, 7000));
    assert.equal(S.queue.kicks, 0, `no place in line lost (${S.queue.log.map((e) => `${e.at % 100000} ${e.id} ${e.what} ${e.path}`).join(' | ')})`);
    assert.equal(sweeper.live().stores.find((s) => s.id === 'demo-ebgames').status, 'held');
    assert.ok(S.queue.cookieless >= 2, 'looked at as a new visitor (no cookies), again and again');
    // (If the sweep tab was opening EB's page just as the queue went up, it's in line now: only its own refreshes.)
    const gaps = queueGaps(S.queue);
    assert.ok(!gaps.length || Math.min(...gaps) >= 1200, `nothing asked again from a place in line — no tab reloaded, no search repeated: ${gaps.join(', ')} ms`);
    // Down: the looks as a new visitor get the store, twice.
    S.queue.on = false;
    await waitFor(() => env.app.gates.get('demo-ebgames').status === 'down', { timeout: 30000, message: 'the queue seen down' });
    await waitFor(() => posts().length === before + 2, { message: 'posted again' });
    assert.equal(posts().at(-1).body.embeds[0].description, `🔴 Virtual queue down for EB Games (dummy store) | ${store.url}/ebgames/`);
    // Searched again.
    const m = store.state.requests.filter((x) => x.path === '/ebgames/search/query').length;
    sweeper.sweepNow();
    await waitFor(() => store.state.requests.filter((x) => x.path === '/ebgames/search/query').length > m, { timeout: 30000, message: 'searched again once it was down' });
  } finally {
    env.app.repo.updateUser(userId, { role: 'user' });
    Object.assign(env.app.cfg.monitor, { gateCheckSeconds: 0, gateDownGapSeconds: 45 });
    S.queue.on = false;
    sweeper.save({ stores: off }, null);
  }
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
