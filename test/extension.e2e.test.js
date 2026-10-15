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

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  env = await startApp({ demoStoreUrl: store.url, allowPrivateHosts: true, hostGapSeconds: 0, ...discordOpts(discord) });
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-ext-'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-chrome-'));
  dirs = [extDir, profileDir];
  writeExtension(env.app.cfg, extDir);
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  extId = new URL(sw.url()).host;
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

async function buyFromDashboard(page, name, qty) {
  await page.goto(`${env.url}/app#watch`);
  const row = page.locator('#w-list li', { hasText: name });
  await row.locator('input.qty').fill(String(qty));
  await row.locator('input.qty').dispatchEvent('change');
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

test('card is saved in the extension only — encrypted, tied to this account, never sent to the server', async () => {
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.waitForSelector('#card-form:not([hidden])');
  await opts.fill('#c-number', '4242 4242 4242 4242');
  await opts.fill('#c-name', 'Ash Ketchum');
  await opts.fill('#c-exp', '07/29');
  await opts.fill('#c-cvc', '123');
  await opts.fill('#c-pass', 'pikachu-123');
  await opts.fill('#c-pass2', 'pikachu-123');
  await opts.click('#card-form button[type=submit]');
  await opts.waitForSelector('#card-saved:not([hidden])');
  assert.match(await opts.textContent('#card-label'), /Visa •••• 4242/);
  await opts.fill('#unlock-pass', 'wrong-pass');
  await opts.click('#unlock-form button[type=submit]');
  await opts.waitForFunction(() => /Wrong passphrase/.test(document.querySelector('#saved-msg').textContent));
  await opts.fill('#unlock-pass', 'pikachu-123');
  await opts.click('#unlock-form button[type=submit]');
  await opts.waitForFunction(() => /Unlocked/.test(document.querySelector('#card-state').textContent));
  await opts.close();

  const userId = env.app.repo.userByUsername('ash').id;
  const local = await sw.evaluate(() => chrome.storage.local.get(null));
  assert.equal(local[`vault:${userId}`].last4, '4242');
  assert.doesNotMatch(JSON.stringify(local), /4242 ?4242 ?4242|pikachu/, 'card number and passphrase are not stored in the clear');
  const dump = JSON.stringify(env.app.db.all('SELECT * FROM user_data')) + JSON.stringify(env.app.db.all('SELECT * FROM events'));
  assert.doesNotMatch(dump, /4242|Ash Ketchum/);

  // The dashboard shows the card (brand and last 4 only), straight from the extension.
  const dash = await ctx.newPage();
  await browserApi('PUT', '/api/profiles', { profiles: [PROFILE_A] });
  await dash.goto(`${env.url}/app#checkout`);
  await dash.waitForFunction(() => /Visa •••• 4242/.test(document.querySelector('#card-state').textContent));
  assert.match(await dash.textContent('#card-state'), /unlocked, ready for checkout/);
  await dash.close();
});

test('Kmart flow (verified): ⚡ Buy ×2 → popup Checkout → details → delivery → payment → stops at "Checkout securely"', async () => {
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'Kmart ETB', price: 100 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart ETB', 2);
  await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 20000 });
  await waitReady(shop, 'Checkout securely');

  const S = store.shop('kmart');
  assert.equal(S.cart[0].qty, 2, 'quantity from the dashboard');
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
  await waitFor(() => env.app.repo.listEvents(userId).some((e) => /Kmart ETB: Clicked "Add to bag" \(quantity 2\)/.test(e.message)), { message: 'add event' });
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
  const shop = await buyFromDashboard(dash, 'Kmart ETB', 2);
  await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 40000 });
  await waitReady(shop, 'Checkout securely');
  assert.deepEqual(S.bagViews.filter((n) => n === 0), [], 'the bag was never opened while empty');
  assert.equal(S.cart.length, 1);
  assert.equal(S.cart[0].qty, 2, 'added once with quantity 2 (not twice)');
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test('Kmart with a slow "Add to bag" (4 s): waits for it, adds once, never opens the bag early', async () => {
  const S = store.shop('kmart');
  S.addDelayMs = 4000;
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'Kmart ETB', price: 100 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart ETB', 2);
  await shop.waitForURL(/\/kmart\/checkout$/, { timeout: 40000 });
  await waitReady(shop, 'Checkout securely');
  assert.deepEqual(S.bagViews, [], 'went from the "Added to bag" popup straight to checkout');
  assert.equal(S.cart[0].qty, 2, 'added once');
  await shop.close();
  await dash.close();
});

test("when the store won't add it, Mugibot says so and doesn't open an empty bag", async () => {
  const S = store.shop('kmart');
  S.refuseAdds = true;
  await useItems([{ url: store.productUrl('kmart', '43818587'), name: 'Kmart ETB', price: 100 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart ETB', 1);
  await shop.waitForFunction(() => /didn't add it to your bag/.test(document.querySelector('#mugibot-qc')?.textContent || ''), null, { timeout: 40000 });
  assert.match(shop.url(), /\/kmart\/product\//, 'still on the product page');
  assert.deepEqual(S.bagViews, [], 'the bag was never opened');
  assert.equal(S.cart.length, 0);
  await shop.close();
  await dash.close();
});

test('Kmart with the card in a payment-provider frame (Adyen-style)', async () => {
  store.state.cardInIframe = true;
  await useItems([{ url: store.productUrl('kmart', '43818556'), name: 'Kmart KO' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'Kmart KO', 1);
  await waitReady(shop, 'Checkout securely');
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=encryptedCardNumber]')) === '4242 4242 4242 4242', { message: 'card in the frame' });
  assert.equal(await cardFrame(shop).inputValue('input[name=encryptedExpiryDate]'), '07 / 29');
  assert.equal(await cardFrame(shop).inputValue('input[name=encryptedSecurityCode]'), '123');
  assert.equal(ordersPlaced(), 0);
  await shop.close();
  await dash.close();
});

test('BIG W flow (beta): quantity dropdown → drawer "View cart" → "Proceed to checkout" → guest → "Home delivery" → manual address → card frame → stops at "Place order"', async () => {
  await useItems([{ url: store.productUrl('bigw', '6012346'), name: 'BIG W Bundle', price: 45 }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'BIG W Bundle', 3);
  await shop.waitForURL(/\/bigw\/checkout$/, { timeout: 25000 });
  await waitReady(shop, 'Place order');

  const S = store.shop('bigw');
  assert.equal(S.cart[0].qty, 3, 'quantity set with the dropdown on the product page');
  assert.equal(S.data.contact.email, PROFILE_A.email, 'checkout email from delivery details');
  assert.equal(S.data.method.method, 'home', 'chose "Home delivery" (a BIG W flow step)');
  assert.deepEqual({ ...S.data.address, addressSearch: undefined }, { firstName: 'Ash', lastName: 'Ketchum', phone: '0412345678', street: PROFILE_A.address1, unit: PROFILE_A.address2, suburb: 'Sydney', state: 'NSW', postcode: '2000', addressSearch: undefined });
  assert.equal(await shop.getAttribute('#b-cc', 'aria-pressed'), 'false', 'never Click & Collect');
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=cardnumber]')) === '4242 4242 4242 4242', { message: 'card in the frame' });
  assert.equal(await cardFrame(shop).inputValue('input[name=cvc]'), '123');
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
  const shop = await buyFromDashboard(dash, 'EB ETB', 1);
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

test('JB Hi-Fi flow (beta, Shopify): quantity → add → cart → "Check out" → one-page checkout → stops at "Pay now"', async () => {
  await useItems([{ store: 'demo-jbhifi', sku: 'pokemon-tcg-30th-celebration-etb', name: 'JB ETB' }]);
  const dash = await ctx.newPage();
  const shop = await buyFromDashboard(dash, 'JB ETB', 2);
  await shop.waitForURL(/\/jbhifi\/checkouts\/c\/abc123$/, { timeout: 30000 });
  await waitReady(shop, 'Pay now');
  const S = store.shop('jbhifi');
  assert.equal(S.cart[0].qty, 2);
  assert.equal(await shop.inputValue('input[name=email]'), PROFILE_A.email);
  assert.equal(await shop.inputValue('input[name=address1]'), PROFILE_A.address1);
  assert.equal(await shop.inputValue('input[name=city]'), 'Sydney');
  assert.equal(await shop.inputValue('select[name=zone]'), 'NSW');
  assert.equal(await shop.inputValue('input[name=postalCode]'), '2000');
  await waitFor(async () => (await cardFrame(shop).inputValue('input[name=number]')) === '4242 4242 4242 4242', { message: 'card in the frame' });
  assert.equal(await cardFrame(shop).inputValue('input[name=name]'), 'Ash Ketchum');
  await shop.waitForTimeout(800);
  assert.equal(ordersPlaced(), 0, '"Pay now" was NOT pressed');
  await shop.close();
  await dash.close();
});

test('the ⚡ Buy button in a Discord DM goes straight to the store and the flow runs', async () => {
  // Connect Discord for Ash (the fake Discord sends straight back).
  const page = await ctx.newPage();
  discord.state.nextUser = 'd-ash';
  await page.goto(`${env.url}/auth/discord`);
  await page.waitForURL(/discord=linked/);
  await useItems([{ url: store.productUrl('kmart', '43818648'), name: 'Kmart UPC', quantity: 2 }]);
  const userId = env.app.repo.userByUsername('ash').id;
  const row = env.app.db.get("SELECT * FROM items WHERE user_id = :u AND sku = '43818648'", { u: userId });
  store.set('kmart', '43818648', { status: 'in_stock' });
  const before = discord.dmsTo('d-ash').length;
  await env.app.monitor.applyResult({ ...row, status: 'out_of_stock' }, { status: 'in_stock', price: 360 }, 'server');
  const dm = discord.dmsTo('d-ash').slice(before)[0];
  const button = dm.body.components[0].components[0];
  assert.equal(button.label, '⚡ Buy ×2');
  await page.goto(button.url);
  await page.waitForURL(/\/kmart\/checkout$/, { timeout: 25000 });
  await waitReady(page, 'Checkout securely');
  assert.equal(store.shop('kmart').cart[0].qty, 2);
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

test("another account's ⚡ Buy link does nothing in this browser", async () => {
  const misty = await Client.signup(env.url, 'misty');
  env.app.repo.updateUser(misty.user.id, { plan: 'active' });
  await misty.post('/api/items', { url: store.productUrl('kmart', '43818556'), name: 'Misty KO' });
  const p = (await misty.get('/api/items')).body.items.find((x) => x.name === 'Misty KO');
  const go = await misty.post(`/api/items/${p.id}/go`, { quantity: 1 });
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
  const shop = await buyFromDashboard(page, 'Misty KO', 1);
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
