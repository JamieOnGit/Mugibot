// The website, dashboard and admin console in a real browser (no extension):
// landing page, sign up, every dashboard tab, the ⚡ Buy page, every admin
// tab, phone-sized screens, and no JavaScript errors or security-policy
// violations anywhere.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { Client, Device, PASSWORD, discordOpts, startApp, startFakeDiscord, startFakeWhop, waitFor, whopOpts, whopWebhook } from './helpers.js';
import { RETAILER_DEFS } from '../server/retailers/index.js';

let env;
let whop;
let discord;
let browser;
let page;
const errors = [];
const shots = process.env.MUGIBOT_SCREENSHOT_DIR;

before(async () => {
  whop = await startFakeWhop();
  discord = await startFakeDiscord();
  env = await startApp({ adminUsernames: 'owner', ...whopOpts(whop), ...discordOpts(discord) });
  // Never touch the real stores from tests — not even when Mugibot redirects there (⚡ Buy), which
  // the stubs below don't catch: this browser can't reach any store's address at all.
  const stores = [...new Set(RETAILER_DEFS.flatMap((r) => r.hosts))];
  browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=${stores.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`, '--no-proxy-server'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  // (A 4xx answer to a form with a mistake in it is expected, not an error.)
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
  // Never touch the real stores or Whop from tests.
  await page.context().route(/^https:\/\/(www\.kmart\.com\.au|whop\.test|www\.ebgames\.com\.au)\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }));
});
after(async () => {
  await browser?.close();
  await env.close();
  await whop.close();
  await discord.close();
});

test('landing page: pitch, membership price, honest guardrails', async () => {
  await page.goto(env.url);
  assert.match(await page.title(), /Mugibot/);
  const text = await page.textContent('body');
  assert.match(text, /Pinged on restock\. At checkout in one press\./);
  assert.match(text, /A\$19\.99 \/ month/);
  assert.match(text, /You choose who presses the final buy button/);
  assert.match(text, /Auto-checkout \(optional\)/);
  assert.match(text, /members-only Discord server/);
  assert.match(text, /Not affiliated with any retailer/);
  // The logo (the straw-hat robot) in the header, and the browser tab's icon.
  await page.waitForFunction(() => document.querySelector('.logo img').naturalWidth === 128);
  assert.equal(await page.getAttribute('link[rel="icon"]', 'href'), '/img/favicon.png');
  for (const [p, type] of [['/favicon.ico', 'image/x-icon'], ['/img/favicon.png', 'image/png'], ['/apple-touch-icon.png', 'image/png'], ['/img/logo-512.png', 'image/png']]) {
    const res = await fetch(`${env.url}${p}`);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get('content-type'), type, p);
  }
  if (shots) await page.screenshot({ path: path.join(shots, 'landing.png'), fullPage: true });
  await page.click('text=Join now');
  await page.waitForURL(/\/signup$/);
});

test('sign up with a username and land on the Monitor page, with your watchlist a tab away', async () => {
  await page.fill('#su-username', 'Owner');
  await page.fill('#su-password', PASSWORD);
  await page.check('#su-terms');
  await page.click('#signup button[type=submit]');
  await page.waitForURL(/\/app\?welcome=1/);
  await page.waitForSelector('[data-panel="monitor"]:not([hidden]) #pp-tracked:not([hidden])');
  assert.equal(await page.isVisible('a[data-tab="watch"]'), false, 'no Watchlist tab of its own');
  assert.match(await page.textContent('#pt-watch'), /My watchlist\s*7/);
  await page.click('#pt-watch');
  await page.waitForSelector('#w-list li[data-id]');
  assert.equal(await page.evaluate(() => location.hash), '#watch', 'the address follows (a reload comes back here)');
  assert.equal(await page.locator('#w-list li[data-id]').count(), 7);
  assert.match(await page.textContent('#w-list li:first-child'), /Day UPC.*Kmart · SKU 43818648 · \$360\.00.*verified flow/s);
  assert.match(await page.textContent('#ext-status'), /isn't in this browser/);
  assert.match(await page.textContent('#plan-pill'), /Admin/, 'ADMIN_USERNAMES account');
  assert.equal(await page.isVisible('#admin-link'), true);
  if (shots) await page.screenshot({ path: path.join(shots, 'dashboard.png'), fullPage: true });
});

test('Watchlist: add by link, add by store + SKU, edit, reorder, pause, announce, delete — and no quantity boxes', async () => {
  await page.click('#w-add-toggle');
  await page.fill('#w-url', 'https://www.ebgames.com.au/product/toys-and-collectibles/312345-one-piece-card-game-op-18-booster-box');
  await page.fill('#w-name', 'OP-18 Box');
  await page.fill('#w-price', '159');
  await page.click('#w-save');
  await page.waitForFunction(() => document.querySelectorAll('#w-list li[data-id]').length === 8);
  assert.match(await page.locator('#w-list li[data-id]').last().textContent(), /OP-18 Box.*EB Games · SKU 312345 · \$159\.00/s);

  await page.click('#w-add-toggle');
  await page.selectOption('#w-store', 'bigw');
  await page.waitForFunction(() => /\/p\//.test(document.querySelector('#w-store-note').textContent));
  await page.fill('#w-sku', '6012345');
  await page.fill('#w-name', 'BIG W UPC');
  assert.equal(await page.locator('#w-qty').count(), 0, 'no quantity in the form (one of each for now)');
  await page.fill('#w-max', '380');
  await page.click('#w-save');
  await page.waitForFunction(() => document.querySelectorAll('#w-list li[data-id]').length === 9);
  const bigw = page.locator('#w-list li', { hasText: 'BIG W UPC' });
  assert.match(await bigw.textContent(), /BIG W · SKU 6012345 · ping at ≤ \$380\.00/);
  assert.match(await bigw.textContent(), /Waiting for the product page to be listed/);
  assert.equal(await bigw.getByRole('button', { name: '⚡ Buy' }).isDisabled(), true, 'no ⚡ Buy until the page is found');

  const last = page.locator('#w-list li[data-id]', { hasText: 'OP-18 Box' });
  await last.getByRole('button', { name: 'Move up' }).click();
  await page.waitForFunction(() => /OP-18 Box/.test(document.querySelector('#w-list li:nth-child(7)').textContent));
  const row = page.locator('#w-list li', { hasText: 'OP-18 Box' });
  assert.equal(await row.locator('input.qty').count(), 0, 'no quantity box next to ⚡ Buy');
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.fill('#w-name', 'OP-18 Booster Box');
  await page.click('#w-save');
  await page.waitForSelector('#w-list li:has-text("OP-18 Booster Box")');
  const renamed = page.locator('#w-list li', { hasText: 'OP-18 Booster Box' });
  await renamed.getByRole('button', { name: 'Pause' }).click();
  await page.waitForSelector('#w-list li.off:has-text("OP-18 Booster Box")');
  await page.locator('#w-list li', { hasText: 'Elite Trainer Box' }).getByRole('button', { name: '📣 Announce' }).click();
  await page.waitForFunction(() => /Stop announcing/.test(document.querySelector('#w-list').textContent));
  page.once('dialog', (d) => d.accept());
  await page.locator('#w-list li', { hasText: 'OP-18 Booster Box' }).getByRole('button', { name: 'Delete OP-18 Booster Box' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#w-list li[data-id]').length === 8);
});

test('⚡ Buy without the extension still opens the product (with a one-time code)', async () => {
  const opened = [];
  page.context().on('request', (r) => { if (r.url().startsWith('https://www.kmart.com.au/')) opened.push(r.url()); });
  const row = page.locator('#w-list li', { hasText: 'Knock Out Collection' });
  const [tab] = await Promise.all([page.context().waitForEvent('page'), row.getByRole('button', { name: '⚡ Buy' }).click()]);
  await waitFor(() => opened.length > 0, { message: 'the product page opens' });
  assert.match(opened[0], /^https:\/\/www\.kmart\.com\.au\/product\/.*43818556\/$/);
  await waitFor(() => /#mgb-go=[\w-]{20,}$/.test(tab.url()), { message: 'one-time code in the address' });
  await page.waitForSelector('.toast.warn');
  assert.match(await page.textContent('#toasts'), /extension isn't connected/);
  await tab.close();
});

test('Checkout → Delivery & card: several addresses, a default, validated; the card stays in the extension', async () => {
  await page.click('a[data-tab="aco"]');
  await page.waitForSelector('#p-list fieldset.profile');
  await page.fill('#p-0-label', 'Home');
  await page.fill('#p-0-firstName', 'Jamie');
  await page.fill('#p-0-address1', '1 George St');
  await page.fill('#p-0-suburb', 'Sydney');
  await page.selectOption('#p-0-state', 'NSW');
  await page.fill('#p-0-postcode', '200');
  await page.click('#p-form button[type=submit]');
  await page.waitForFunction(() => /4 digits/.test(document.querySelector('#p-msg').textContent));
  await page.fill('#p-0-postcode', '2000');
  await page.click('#p-add');
  await page.fill('#p-1-label', 'Work');
  await page.fill('#p-1-address1', '9 Pitt St');
  await page.fill('#p-1-postcode', '2001');
  await page.check('#p-list fieldset.profile:nth-of-type(2) input[name=defaultProfile]');
  await page.click('#p-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#p-msg').textContent === 'Saved.');
  const owner = env.app.repo.userByUsername('owner');
  const saved = env.app.repo.getProfiles(owner.id);
  assert.equal(saved.profiles.length, 2);
  assert.equal(saved.profiles[0].address1, '1 George St');
  assert.equal(saved.defaultId, saved.profiles[1].id, 'Work is the default');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#p-1-address1') && document.querySelector('#p-1-address1').value === '9 Pitt St');
  assert.match(await page.textContent('[data-panel="checkout"]'), /never sent to our servers/);
  assert.match(await page.textContent('#card-state'), /Install the extension/);
  // Items can deliver to a chosen address (your watchlist: on the Monitor page).
  await page.click('a[data-tab="monitor"]');
  await page.click('#pt-watch');
  await page.locator('#w-list li', { hasText: 'Day UPC' }).getByRole('button', { name: 'Edit' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#w-profile option').length === 3);
  await page.selectOption('#w-profile', saved.profiles[0].id);
  await page.click('#w-save');
  await waitFor(() => env.app.repo.listItems(owner.id).find((x) => x.sku === '43818648').profileId === saved.profiles[0].id, { message: 'profile saved on the item' });
});

test('Discord tab: connect (the fake Discord sends straight back), pings, test ping, webhook check', async () => {
  discord.state.users['d-owner'] = { id: 'd-owner', username: 'owner_disc' };
  discord.state.nextUser = 'd-owner';
  await page.click('a[data-tab="setup"]');
  await page.waitForSelector('#d-actions a[href="/auth/discord"]');
  await page.click('#d-actions a[href="/auth/discord"]');
  await page.waitForURL(/discord=linked/);
  await page.waitForFunction(() => /Connected as owner_disc/.test(document.querySelector('#d-status').textContent));
  assert.match(await page.textContent('#banner'), /Discord connected/);
  assert.match(await page.textContent('#d-status'), /in the members' server/i, 'admins have access, so the bot added them');
  await page.click('summary:has-text("my own Discord server")');
  await page.fill('#a-hook', 'https://example.com/not-discord');
  await page.click('#a-form button[type=submit]');
  await page.waitForFunction(() => /Discord webhook must look like/.test(document.querySelector('#a-msg').textContent));
  await page.fill('#a-hook', '');
  await page.uncheck('#a-dm-listed');
  await page.click('#a-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#a-msg').textContent === 'Saved.');
  await page.click('#a-test');
  await page.waitForFunction(() => /Test ping sent \(Discord DM\)/.test(document.querySelector('#a-msg').textContent));
  assert.ok(discord.dmsTo('d-owner').length >= 1);
  if (shots) await page.screenshot({ path: path.join(shots, 'discord.png'), fullPage: true });
});

test('Drops (the monitor): add a monitor, live alerts, product page with price history, alert rules; light by default with a dark switch', async () => {
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'the light look by default');
  await page.click('a[data-tab="monitor"]');
  await page.waitForSelector('#m-stats .sn-stat');
  assert.match(await page.textContent('#m-stats'), /Available now\s*0\s*of 0 tracked/);
  // (The page remembers the list you were on: your watchlist, from the tests before.)
  assert.equal(await page.getAttribute('#pt-watch', 'aria-selected'), 'true');
  await page.click('#pt-tracked');
  await page.click('#m-add-toggle');
  await page.fill('#ma-url', 'https://www.kmart.com.au/product/pokemon-tcg-30th-celebration-ultra-premium-collection-43818648/');
  await page.selectOption('#ma-category', 'pokemon');
  await page.click('#m-add button[type=submit]');
  await page.waitForSelector('#m-products li.product');
  assert.match(await page.textContent('#m-products'), /Waiting for first check/);

  // A check and an alert while the page is open: the feed updates by itself.
  const ownerId = env.app.repo.userByUsername('owner').id;
  await waitFor(() => env.app.hub.userIds().includes(ownerId), { message: 'the page is connected for live updates' });
  const cat = env.app.catalog;
  const p = cat.productFor('kmart', '43818648');
  cat.addPrice(p.id, 379);
  cat.updateProduct(p.id, { name: 'Day UPC', status: 'in_stock', confirmed: 1, price: 360, previous_price: 379, status_at: Date.now() });
  cat.addPrice(p.id, 360);
  await env.app.feed.alert(cat.productById(p.id), 'restock');
  // It pops up (on any tab) with the price and ⚡ Buy, and goes into the event log.
  await page.waitForSelector('#sn-overlay:not([hidden])');
  assert.match(await page.textContent('#sn-overlay'), /Restock.*Day UPC.*\$360\.00.*was \$379\.00/s);
  assert.match(await page.getAttribute('#sn-ov-buy', 'href'), /^\/buy\?store=kmart&sku=43818648/);
  await page.click('#sn-ov-dismiss');
  await page.waitForSelector('#sn-overlay', { state: 'hidden' });
  await page.waitForSelector('#m-log .sn-ev.k-restock');
  assert.match(await page.textContent('#m-log .sn-ev.k-restock'), /Restock.*Day UPC.*\$360\.00/s);
  assert.match(await page.getAttribute('#m-log .sn-ev.k-restock a.btn.primary', 'href'), /^\/buy\?store=kmart&sku=43818648/);
  await page.waitForFunction(() => /Day UPC/.test(document.querySelector('#m-products').textContent));

  // The product page: price history (chart + table), alerts, and (admins) settings and the check log.
  await page.click('#m-products li.product .name');
  await page.waitForSelector('#m-detail[open] #md-chart svg path.series');
  assert.equal(await page.evaluate(() => location.hash), `#monitor/${p.id}`);
  assert.equal(await page.locator('#md-history tbody tr').count(), 2);
  assert.equal(await page.isVisible('#md-settings'), true);
  await page.focus('#md-chart svg');
  assert.match(await page.textContent('.chart-tip'), /\$360\.00/, 'keyboard focus shows the readout');
  await page.click('#md-pause');
  await page.waitForFunction(() => /Resume/.test(document.querySelector('#md-pause').textContent));
  assert.equal(cat.monitorForProduct(p.id).paused, 1);
  if (shots) await page.screenshot({ path: path.join(shots, 'monitor-product.png') });
  await page.click('#md-close');
  // The dialog's close event (which puts the address back) fires just after the click.
  await page.waitForFunction(() => location.hash === '#monitor');
  await page.goto(`${env.url}/app#monitor/${p.id}`);
  await page.waitForSelector('#m-detail[open]');
  assert.match(await page.textContent('#md-state'), /\$360\.00\s*\$379\.00/, 'the price, and the old one struck through');
  await page.click('#md-close');
  // No old price (never on sale before), or a page that hasn't answered yet: nothing written as "null".
  const once = cat.upsertProduct({ store: 'other', sku: 'microsoft.com/8wg5vqp0x4h3', url: 'https://www.microsoft.com/en-au/d/xbox-series-x25-limited-edition/8wg5vqp0x4h3', category: 'nontcg' });
  cat.updateProduct(once.id, { status: 'error', error: 'The store took too long to answer' });
  await page.goto(`${env.url}/app#monitor/${once.id}`);
  await page.waitForSelector('#m-detail[open]');
  assert.equal(await page.textContent('#md-name'), 'Xbox Series X25 Limited Edition', "its link's words, not Mugibot's code for it");
  assert.match(await page.textContent('#md-meta'), /SKU microsoft\.com\/8wg5vqp0x4h3/);
  assert.doesNotMatch(await page.textContent('#md-state'), /null/);
  assert.match(await page.textContent('#md-state'), /—$/);
  await page.click('#md-close');
  cat.db.run('DELETE FROM products WHERE id = :id', { id: once.id });

  // Settings and the Check log are pages of their own (admins): Live · Settings · Check log.
  assert.equal(await page.isVisible('[data-panel="monitor"] .mon-tabs'), true);
  assert.equal(await page.isVisible('#mh-table'), false, 'no check log on the Live page');
  await page.click('[data-panel="monitor"] .mon-tabs a[data-mtab="monitor-settings"]');
  await page.waitForSelector('[data-panel="monitor-settings"]:not([hidden]) #ms-table tbody tr');
  assert.equal(await page.evaluate(() => location.hash), '#monitor-settings');
  assert.equal(await page.getAttribute('[data-panel="monitor-settings"] .mon-tabs a[aria-current="page"]', 'data-mtab'), 'monitor-settings');
  assert.equal(await page.getAttribute('.side a.active', 'data-tab'), 'monitor', 'the sidebar keeps Monitor lit');
  assert.equal(await page.isVisible('#m-log'), false, 'the live feed stays on the Live page');

  // Discord alert rules.
  await page.click('#mr-new');
  await page.fill('#mr-name', 'Pokémon restocks');
  await page.fill('#mr-channel', '123456789012345678');
  await page.check('#mr-categories input[value="pokemon"]');
  await page.click('#mr-form button[type=submit]');
  await page.waitForFunction(() => /Pokémon restocks/.test(document.querySelector('#mr-list').textContent));

  // The store channels, in one go: kmart-pokemon, bigw-one-piece… premium-bandai, pokemon-center and the misc-retailers catch-all.
  discord.state.canManageChannels = false;
  await page.click('#mr-setup');
  await page.waitForFunction(() => /Manage Channels/.test(document.querySelector('#mr-setup-msg').textContent));
  discord.state.canManageChannels = true;
  await page.fill('#mr-setup-role', '555000111222333444');
  await page.click('#mr-setup');
  await page.waitForFunction(() => /Done: \d+ channels \(\d+ made/.test(document.querySelector('#mr-setup-msg').textContent), null, { timeout: 15000 });
  await page.waitForFunction(() => /kmart-pokemon/.test(document.querySelector('#mr-list').textContent));
  const list = await page.textContent('#mr-list');
  for (const name of ['bigw-one-piece', 'premium-bandai', 'pokemon-center', 'misc-retailers', 'Pokémon restocks']) assert.match(list, new RegExp(name));
  assert.equal(await page.locator('#mr-list li', { hasText: 'misc-retailers' }).locator('.pill', { hasText: 'catch-all' }).count(), 1);
  assert.ok(discord.state.channels.some((c) => c.name === 'zing-pokemon' && c.type === 0 && c.parent_id), 'made in a "Mugibot alerts" category');

  // ⭐ VIP drops: the #vip-drop channel, and a watch (City Beach, "pokemon skate", its drop time, Auto-checkout for me).
  await page.waitForSelector('#vip-store option[value="citybeach"]', { state: 'attached' });
  assert.match(await page.textContent('#vip-channel'), /No #vip-drop channel yet/);
  await page.click('#vip-setup');
  await page.waitForFunction(() => /Done: #vip-drop made/.test(document.querySelector('#vip-setup-msg').textContent), null, { timeout: 15000 });
  assert.match(await page.textContent('#vip-channel'), /Posting in #vip-drop/);
  await page.waitForFunction(() => /#vip-drop/.test(document.querySelector('#mr-list').textContent));
  const tomorrow = new Date(Date.now() + 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  await page.selectOption('#vip-store', 'citybeach');
  await page.fill('#vip-words', 'Pokemon Skate');
  await page.fill('#vip-drop', `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T00:00`);
  await page.fill('#vip-label', 'Pokémon skateboard');
  await page.check('#vip-aco');
  await page.click('#vip-form button[type=submit]');
  await page.waitForFunction(() => /max price/.test(document.querySelector('#vip-msg').textContent), null, { timeout: 5000 });
  await page.fill('#vip-max', '150');
  await page.click('#vip-form button[type=submit]');
  await page.waitForFunction(() => /Pokémon skateboard/.test(document.querySelector('#vip-list').textContent));
  const vipList = await page.textContent('#vip-list');
  assert.match(vipList, /City Beach: every word of "pokemon skate"/);
  assert.match(vipList, /auto-checkout for owner up to \$150/);
  assert.match(vipList, /Nothing with those words yet/);
  if (shots) await page.screenshot({ path: path.join(shots, 'monitor-settings-vip.png'), fullPage: false });

  // The check log.
  await page.click('[data-panel="monitor-settings"] .mon-tabs a[data-mtab="monitor-log"]');
  await page.waitForFunction(() => /switched off|Monitor loop/.test(document.querySelector('#mh-loop').textContent));
  assert.equal(await page.isVisible('#ml-table'), true);
  if (shots) await page.screenshot({ path: path.join(shots, 'monitor-log.png'), fullPage: true });
  await page.click('[data-panel="monitor-log"] .mon-tabs a[data-mtab="monitor"]');
  await page.waitForSelector('[data-panel="monitor"]:not([hidden]) #m-stats .sn-stat');
  if (shots) await page.screenshot({ path: path.join(shots, 'monitor.png'), fullPage: true });

  await page.click('#theme-toggle');
  assert.equal(await page.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('mgb-theme2')].join()), 'dark,dark');
  await page.click('#theme-toggle');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
});

test('Monitor tab: live sweeps — each store\'s health and settings; new drops, restocks and stock changes show up by themselves', async () => {
  const sw = env.app.sweeper;
  const target = env.app.retailers.get('target');
  const term = { keyword: 'pokemon', page: 1 };
  const url = sw.urlFor(target, 'pokemon');
  const found = (sku, title, inStock, price) => ({ sku, aliases: [], title, price, wasPrice: null, inStock, preorder: false, url: `https://www.target.com.au/p/x/${sku}`, image: '', marketplace: false });
  // What a first sweep of Target found (no network here: the results are handed in).
  await sw.ingest(target, term, { products: [found('70000001', 'Pokemon TCG: Test Booster Bundle', false, 50), found('70000002', 'Pokemon Plush Pikachu', true, 20)] }, { source: 'server', url, ms: 400 });
  await page.goto(`${env.url}/app#monitor`);
  await page.reload();
  await page.click('#pt-tracked');
  // The live page: each store with its state and what it's doing; a click shows the details.
  await page.waitForSelector('#sn-channels .sn-chan[data-store="target"]');
  assert.match(await page.textContent('#mon-sub'), /Searching \d+ stores every few seconds for pokemon and one piece/);
  const targetRow = page.locator('#sn-channels .sn-chan[data-store="target"]');
  assert.match(await targetRow.locator('.hd').textContent(), /Target\s*Searching/);
  assert.match(await targetRow.locator('.st-sub').textContent(), /Answered in 400 ms/);
  assert.equal(await targetRow.locator('.sn-rows').isVisible(), false, 'details folded away');
  await targetRow.locator('.st-toggle').click();
  await page.waitForSelector('#sn-channels .sn-chan[data-store="target"].open .sn-rows:not([hidden])');
  assert.match(await page.textContent('#sn-channels .sn-chan[data-store="target"] .sn-rows'), /searches\s*1.*last answer\s*400 ms.*server first · \/search\?sEngine=c&text=/s);
  assert.equal(await page.getAttribute('#sn-channels .sn-chan[data-store="target"] .st-toggle', 'aria-expanded'), 'true');
  assert.match(await page.textContent('#sn-channels .sn-chan[data-store="kmart"]'), /Kmart\s*Starting.*server first · ac\.cnstrc\.com\/search\//s);
  // Server first: BIG W's page draws its products once it's open, so the server reads none — an
  // admin's browser stands in, and the server tries again in 5 minutes.
  const bigw = env.app.retailers.get('bigw');
  await sw.ingest(bigw, term, { products: [], total: 0, problem: 'empty' }, { source: 'server', url: sw.urlFor(bigw, 'pokemon'), ms: 350 });
  await page.waitForFunction(() => /BIG W\s*Waiting/.test(document.querySelector('#sn-channels .sn-chan[data-store="bigw"]').textContent));
  assert.match(await page.textContent('#sn-channels .sn-chan[data-store="bigw"] .st-sub'), /Mugibot's server can't read it .* an admin's browser searches it meanwhile, and the server tries again within 5 min/);
  await page.click('#sn-channels .sn-chan[data-store="bigw"] .st-toggle');
  assert.match(await page.textContent('#sn-channels .sn-chan[data-store="bigw"] .sn-rows'), /from\s*admin's browser, while the server's refused · \/search\?text=.*server\s*refused since \d\d:\d\d:\d\d · tries again at \d\d:\d\d:\d\d/s);
  await page.click('#sn-channels .sn-chan[data-store="bigw"] .st-toggle');
  // The live feed shows drops and restocks; "Everything" adds each search.
  assert.equal(await page.inputValue('#m-kind'), 'alerts');
  assert.doesNotMatch(await page.textContent('#m-log'), /Target · "pokemon" — 2 products/);
  await page.selectOption('#m-kind', '');
  assert.match(await page.textContent('#m-log'), /Search\s*Target · "pokemon" — 2 products · 1 count · first look \(no alerts\)\s*400 ms/);
  await page.waitForFunction(() => /Test Booster Bundle/.test(document.querySelector('#m-products').textContent));
  assert.doesNotMatch(await page.textContent('#m-products'), /Plush/, 'not a trading-card product');
  const ownerId = env.app.repo.userByUsername('owner').id;
  await waitFor(() => env.app.hub.userIds().includes(ownerId), { message: 'the page is connected for live updates' });

  // The next sweep: a new product and a restock, shown the moment they're seen.
  await sw.ingest(target, term, { products: [found('70000001', 'Pokemon TCG: Test Booster Bundle', true, 50), found('70000003', 'Pokemon TCG: Brand New ETB', true, 89)] }, { source: 'server', url, ms: 380 });
  // Two alerts: they pop up one after the other.
  await page.waitForSelector('#sn-overlay:not([hidden])');
  await page.waitForFunction(() => /1 more/.test(document.querySelector('#sn-ov-cnt').textContent));
  assert.match(await page.textContent('#sn-overlay'), /Restock.*Test Booster Bundle.*\$50\.00.*alerted \d+ ms after Target answered/s);
  await page.click('#sn-ov-dismiss');
  await page.waitForFunction(() => /New drop.*Brand New ETB.*\$89\.00/s.test(document.querySelector('#sn-overlay').textContent) && !document.querySelector('#sn-overlay').hidden);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#sn-overlay', { state: 'hidden' });
  await page.waitForFunction(() => /New drop.*Brand New ETB/s.test(document.querySelector('#m-log').textContent));
  assert.match(await page.textContent('#m-log'), /Restock.*Test Booster Bundle.*alerted in \d+ ms/s);
  assert.match(await page.textContent('#m-log'), /Target · "pokemon" — 2 products · 1 new · 1 restock\s*380 ms/);
  // The numbers keep up by themselves: today's drops and restocks.
  await page.waitForFunction(() => /Drops today\s*\d+\s*[1-9]\d* new · [2-9]\d* restocks · 24 h/.test(document.querySelector('#m-stats').textContent));
  // The event log's filter.
  await page.selectOption('#m-kind', 'alerts');
  assert.equal(await page.locator('#m-log .sn-ev.k-hb').count(), 0);
  assert.ok(await page.locator('#m-log .sn-ev.k-drop').count() >= 1);
  await page.selectOption('#m-kind', '');
  await page.waitForFunction(() => [...document.querySelectorAll('#m-products li')].some((li) => /Test Booster Bundle/.test(li.textContent) && /In stock/.test(li.textContent)));
  await page.waitForFunction(() => [...document.querySelectorAll('#m-products li')].some((li) => /Brand New ETB/.test(li.textContent) && /🆕 New/.test(li.textContent)));
  await page.selectOption('#m-status', 'new');
  await page.waitForFunction(() => document.querySelectorAll('#m-products li.product').length === 2);
  await page.selectOption('#m-status', '');

  // ↻ Reset (admins): one store, from its row on the live page.
  await page.click('#sn-channels .sn-chan[data-store="target"] .st-reset');
  await page.waitForFunction(() => /Reset Target/.test(document.querySelector('#toasts')?.textContent || ''));
  assert.ok(sw.stat('target').resetAt > 0);
  assert.ok(sw.stat('target').slowUntil > sw.now(), 'gently for a while');
  // A store that keeps failing: a banner above everything says so, with Reset all.
  const amazon = env.app.retailers.get('amazon');
  for (let i = 0; i < 3; i += 1) sw.record(amazon, term, { ok: false, blocked: true, error: 'The store refused the search (HTTP 503)', source: 'server', url: sw.urlFor(amazon, 'pokemon'), ms: 300 });
  // (BIG W too: waiting for an admin's browser to stand in.)
  await page.waitForFunction(() => /BIG W and Amazon AU need attention/.test(document.querySelector('#sn-attention:not([hidden])')?.textContent || ''));
  assert.match(await page.textContent('#sn-channels .sn-chan[data-store="amazon"] .st-sub'), /HTTP 503/);
  await page.click('#sn-attention button');
  await page.waitForFunction(() => /Reset every store/.test(document.querySelector('#toasts')?.textContent || ''));
  assert.equal(sw.stat('amazon').fails, 0);
  await page.waitForSelector('#sn-attention', { state: 'hidden' });

  // Alerts in this browser: the ⚙ menu. No pop-up when switched off, and the test alert runs only here.
  await page.click('#sn-prefs-menu > summary');
  await page.click('#sn-prefs button[role=switch][aria-label="Pop-up for drops and restocks"]');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mgb-live')).popup), false);
  await page.click('#sn-prefs button[role=switch][aria-label="Pop-up for drops and restocks"]');
  await page.click('#sn-test');
  await page.waitForSelector('#sn-overlay:not([hidden])');
  assert.match(await page.textContent('#sn-ov-type'), /Test · New drop/);
  await page.click('#sn-ov-dismiss');
  await page.waitForSelector('#sn-overlay', { state: 'hidden' });
  assert.match(await page.textContent('#m-log'), /test \(this browser only\)/);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.querySelector('#sn-prefs-menu').open), false, 'Escape closes the menu');
  await page.click('#sn-arm');
  await page.waitForFunction(() => /Alerts armed/.test(document.querySelector('#toasts')?.textContent || ''));

  // Settings: where each store is searched from, keywords, alerts and what counts, the response times.
  // (BIG W's server read again, after Reset all: the browser stands in once more.)
  await sw.ingest(bigw, term, { products: [], total: 0, problem: 'empty' }, { source: 'server', url: sw.urlFor(bigw, 'pokemon'), ms: 350 });
  await page.click('[data-panel="monitor"] .mon-tabs a[data-mtab="monitor-settings"]');
  await page.waitForSelector('#ms-table tbody tr');
  assert.equal(await page.inputValue('#ms-table select[data-store="target"]'), 'auto');
  assert.match(await page.textContent('#ms-table select[data-store="target"]'), /Server first \(default\).*Server only.*Admin's browser.*Off/s);
  assert.match(await page.textContent('#ms-table tr[data-store="bigw"]'), /Admin's browser standing in · server tries again/);
  assert.match(await page.textContent('#ms-table tr[data-store="target"]'), /Gentle until/, 'reset a moment ago: searched gently for a while');
  assert.match(await page.textContent('#ms-state'), /Off \(MONITOR_ENABLED=0\)/, '(tests run with the loops off)');
  await page.waitForSelector('#sn-chart svg circle.end.s3');
  assert.match(await page.textContent('#sn-legend'), /Target\s*\d+ ms/);
  assert.match(await page.textContent('#sn-chips'), /pokemon.*one piece/s);
  // Reset from the table, a store at a time.
  sw.stat('target').resetAt = 0;
  await page.click('#ms-table tr[data-store="target"] button');
  await waitFor(() => sw.stat('target').resetAt > 0, { message: 'Target reset from Settings' });

  // Keywords.
  await page.fill('#sn-kw-input', 'Lorcana');
  await page.click('#sn-kw-form button[type=submit]');
  await page.waitForFunction(() => /lorcana/.test(document.querySelector('#sn-chips').textContent));
  assert.deepEqual(sw.settings.keywords, ['pokemon', 'one piece', 'lorcana']);
  await page.click('#sn-chips button[aria-label="Stop searching for lorcana"]');
  await page.waitForFunction(() => !/lorcana/.test(document.querySelector('#sn-chips').textContent));
  assert.deepEqual(sw.settings.keywords, ['pokemon', 'one piece']);
  // The last keyword can't go while sweeps are on.
  await page.click('#sn-chips button[aria-label="Stop searching for one piece"]');
  await page.waitForFunction(() => !/one piece/.test(document.querySelector('#sn-chips').textContent));
  await page.click('#sn-chips button[aria-label="Stop searching for pokemon"]');
  await page.waitForFunction(() => /at least one keyword/.test(document.querySelector('#toasts')?.textContent || ''));
  assert.deepEqual(sw.settings.keywords, ['pokemon']);

  // Where a store is searched from changes straight away; the rest saves with the form.
  await page.selectOption('#ms-table select[data-store="kmart"]', 'off');
  await waitFor(() => sw.modeFor(env.app.retailers.get('kmart')) === 'off', { message: 'Kmart switched off' });
  await page.fill('#ms-every', '4');
  await page.uncheck('#ms-once');
  await page.uncheck('#ms-price');
  await page.click('#ms-form button[type=submit]');
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#ms-msg').textContent));
  assert.equal(sw.settings.everySeconds, 4);
  assert.equal(sw.settings.restockOncePerDay, false);
  assert.equal(sw.settings.priceAlerts, false);
  assert.deepEqual(sw.settings.keywords, ['pokemon'], 'the form leaves the keywords alone');
  await page.click('details.ms-terms summary');
  assert.match(await page.textContent('#ms-terms'), /Target\s*pokemon\s*1/);
  if (shots) await page.screenshot({ path: path.join(shots, 'monitor-sweeps.png'), fullPage: true });
  await sw.save({ keywords: 'pokemon, one piece', stores: { kmart: 'browser' }, everySeconds: 5, restockOncePerDay: true, priceAlerts: true }, null);
});

test('Setup → Extension: install steps, browser checks switch, stores and their flows', async () => {
  await page.click('a[data-tab="setup"]');
  await page.waitForSelector('#stores li');
  const stores = await page.textContent('#stores');
  assert.match(stores, /Kmart.*verified flow/s);
  assert.match(stores, /BIG W.*beta flow/s);
  assert.match(stores, /Target.*draft flow/s);
  assert.equal(await page.isChecked('#b-checks'), true);
  await page.uncheck('#b-checks');
  await page.waitForFunction(() => /Off/.test(document.querySelector('#b-msg').textContent));
  const owner = env.app.repo.userByUsername('owner');
  assert.equal(env.app.repo.getData(owner.id, 'alerts').browserChecks, false);
  await page.check('#b-checks');
  await page.waitForFunction(() => /On/.test(document.querySelector('#b-msg').textContent));
  // The store sign-ins: with no browser connected yet, each store with where to sign in.
  await page.waitForSelector('#logins li.login');
  assert.match(await page.textContent('#logins-sum'), /Connect the extension \(step 2\)/);
  const bigw = page.locator('#logins li.login[data-store="bigw"]');
  assert.match(await bigw.textContent(), /BIG W.*Not seen yet: open the store once/s);
  assert.equal(await bigw.locator('a').getAttribute('href'), 'https://www.bigw.com.au');
  assert.match(await page.textContent('#logins li.login[data-store="jbhifi"]'), /Not checked yet/);
  assert.equal(await page.getAttribute('#logins li.login[data-store="jbhifi"] a', 'href'), 'https://www.jbhifi.com.au/account');
  await page.click('#logins-check');
  await page.waitForFunction(() => /Install the extension and connect it/.test(document.querySelector('#logins-msg').textContent));
});

test('an extension downloaded for the old address: the dashboard says so and links to the update steps', async () => {
  // Connect an extension that talks to another of the site's addresses (like mugibot-live.fly.dev after moving to mugibot.com).
  const code = await page.evaluate(async () => (await (await fetch('/api/devices/pair-code', { method: 'POST', headers: { 'x-mugibot': '1' } })).json()).code);
  const old = env.url.replace('127.0.0.1', 'localhost');
  const paired = await fetch(`${old}/api/ext/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Chrome on Mac', version: '1.0.0' }) }).then((r) => r.json());
  await fetch(`${old}/api/ext/me?v=1.0.0`, { headers: { authorization: `Bearer ${paired.token}` } });
  await page.goto(`${env.url}/app#extension`);
  await page.waitForFunction(() => /was downloaded for/.test(document.querySelector('#ext-status-2').textContent));
  assert.match(await page.textContent('#ext-status-2'), /Your extension \(Chrome on Mac, v1\.0\.0\) was downloaded for localhost:\d+, so it can't work with this page/);
  await page.click('#ext-status-2 a[href="#update"]');
  await page.locator('#ext-update').waitFor({ state: 'visible' });
  assert.match(await page.textContent('#ext-update'), /Download the latest version/);
  await page.evaluate(async (id) => fetch(`/api/devices/${id}`, { method: 'DELETE', headers: { 'x-mugibot': '1' } }), paired.device.id);
});

test('Membership tab: become a member through Whop, then it shows the membership', async () => {
  // A plain member account for this (admins are always active).
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.context().route(/^https:\/\/whop\.test\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Whop checkout (stub)</title>' }));
  await p2.goto(`${env.url}/signup`);
  await p2.fill('#su-username', 'member1');
  await p2.fill('#su-password', PASSWORD);
  await p2.check('#su-terms');
  await p2.click('#signup button[type=submit]');
  await p2.waitForURL(/\/app/);
  assert.match(await p2.textContent('#banner'), /Start your membership \(A\$19\.99 \/ month\)/);
  await p2.click('a[data-tab="account"]');
  await p2.waitForSelector('#m-subscribe:not([hidden])');
  await p2.click('#m-subscribe');
  await p2.waitForURL(/^https:\/\/whop\.test\/checkout\/ch_\d+\/$/);
  const user = env.app.repo.userByUsername('member1');
  assert.equal(whop.state.checkouts.at(-1).metadata.mugibot_user_id, user.id);
  // Whop says it's paid.
  whop.membership('mem_member1', { metadata: { mugibot_user_id: user.id } });
  await whopWebhook(env.url, 'membership.activated', { id: 'mem_member1' });
  await p2.goto(`${env.url}/app?membership=success#membership`);
  await p2.waitForFunction(() => /mem_member1/.test(document.querySelector('#m-info').textContent));
  assert.match(await p2.textContent('#m-info'), /Member/);
  assert.match(await p2.textContent('#banner'), /Thanks for joining/);
  assert.equal(await p2.isVisible('#m-manage'), true);
  assert.equal(await p2.isVisible('#m-subscribe'), false);
  if (shots) await p2.screenshot({ path: path.join(shots, 'membership.png'), fullPage: true });
  await p2.close();
});

test('⚡ Buy is one click: a Monitor alert\'s ⚡ Buy from Discord, and ⚡ Buy on the Monitor tab, go straight to the store', async () => {
  const owner = env.app.repo.userByUsername('owner');
  // Where ⚡ Buy sends the browser, caught instead of followed (a stub page in the store's place):
  // the request goes to Mugibot as the browser made it (its cookie and Referer).
  const sentTo = [];
  const catchBuy = async (route) => {
    const req = route.request();
    const headers = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => !k.startsWith(':') && !/^(host|connection|content-length)$/i.test(k)));
    const r = await fetch(req.url(), { headers, redirect: 'manual' });
    if (r.status === 302) {
      sentTo.push(r.headers.get('location'));
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>the store (stub)</title>' });
    }
    return route.fulfill({ status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'text/html' }, body: Buffer.from(await r.arrayBuffer()) });
  };
  await page.context().route(/\/buy\?/, catchBuy);
  try {
    // The ⚡ Buy in a Discord channel's alert (a link Mugibot signed): no buy page in between, and
    // the product goes on the watchlist.
    await page.goto(env.app.notifier.alertBuyLink({ store: 'ebgames', sku: '313001', url: 'https://www.ebgames.com.au/product/toys-and-collectibles/313001-booster', name: 'One Click Booster' }));
    assert.match(sentTo.at(-1) || '', /^https:\/\/www\.ebgames\.com\.au\/product\/toys-and-collectibles\/313001-booster#mgb-go=[\w-]+$/);
    assert.equal(await page.title(), 'the store (stub)');
    assert.ok(env.app.repo.listItems(owner.id).some((x) => x.sku === '313001' && x.name === 'One Click Booster'));
    // ⚡ Buy on an alert in the Monitor tab's event log: straight to the store, in a new tab.
    await page.goto(`${env.url}/app#monitor`);
    const buy = page.locator('#m-log .sn-ev.k-restock', { hasText: 'Day UPC' }).locator('a.btn.primary').first();
    await buy.waitFor();
    const n = sentTo.length;
    const [tab] = await Promise.all([page.context().waitForEvent('page'), buy.click()]);
    await waitFor(() => sentTo.length > n, { message: 'the new tab sent straight to the store' });
    assert.match(sentTo.at(-1), /^https:\/\/www\.kmart\.com\.au\/product\/.*43818648\/#mgb-go=[\w-]+$/);
    await tab.close();
  } finally {
    await page.context().unroute(/\/buy\?/, catchBuy);
  }
});

test('the ⚡ Buy page from a Discord channel post: adds the SKU and goes', async () => {
  // (An old post's link, from before they were signed, or an expired one: the buy page asks once.)
  await page.goto(`${env.url}/buy?store=ebgames&sku=312999&name=${encodeURIComponent('Channel ETB')}&url=${encodeURIComponent('https://www.ebgames.com.au/product/toys-and-collectibles/312999-etb')}`);
  await page.waitForFunction(() => /Not on your watchlist yet/.test(document.querySelector('#b-meta').textContent));
  await page.click('#b-go');
  await page.waitForURL(/^https:\/\/www\.ebgames\.com\.au\/product\/toys-and-collectibles\/312999-etb#mgb-go=/);
  const owner = env.app.repo.userByUsername('owner');
  assert.ok(env.app.repo.listItems(owner.id).some((x) => x.sku === '312999' && x.name === 'Channel ETB'));
});

test('Activity (on the Monitor page, in pages) and Account tabs', async () => {
  const owner = env.app.repo.userByUsername('owner');
  for (let i = 1; i <= 25; i++) env.app.repo.addEvent(owner.id, { type: 'info', message: `Something that happened (${i})` });
  // #activity (the old tab's address) opens your activity on the Monitor page.
  await page.goto(`${env.url}/app#activity`);
  await page.waitForSelector('[data-panel="monitor"]:not([hidden]) #pp-activity:not([hidden]) #feed li');
  assert.equal(await page.getAttribute('#pt-activity', 'aria-selected'), 'true');
  assert.equal(await page.isVisible('a[data-tab="activity"]'), false, 'no Activity tab of its own');
  // 20 to a page, newest first — no endless list: the first thing that happened is on the last page.
  assert.match(await page.textContent('#feed li:first-child'), /Something that happened \(25\)/);
  const total = env.app.repo.countEvents(owner.id);
  assert.ok(total > 20, `enough activity for pages (${total})`);
  assert.equal(await page.locator('#feed li').count(), 20);
  assert.match(await page.textContent('#feed-pager'), new RegExp(`1–20 of ${total}`));
  const pages = Math.ceil(total / 20);
  await page.click(`#feed-pager button[aria-label="Activity page ${pages}"]`);
  await page.waitForFunction(() => /Welcome to Mugibot/.test(document.querySelector('#feed').textContent));
  assert.match(await page.textContent('#feed-pager'), new RegExp(`${(pages - 1) * 20 + 1}–${total} of ${total}`));
  await page.click('#feed-pager button[aria-label="Activity page 1"]');
  await page.waitForFunction(() => !/Welcome to Mugibot/.test(document.querySelector('#feed').textContent));
  assert.equal(await page.locator('#feed li').count(), 20);
  // A reload stays on the same list.
  await page.reload();
  await page.waitForSelector('#pp-activity:not([hidden]) #feed li');
  await page.click('a[data-tab="account"]');
  assert.equal(await page.inputValue('#acct-username'), 'owner');
  await page.fill('#acct-email', 'owner@example.com');
  await page.fill('#acct-name', 'Jamie Owner');
  await page.click('#acct-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#acct-msg').textContent === 'Saved.');
  assert.equal(env.app.repo.userByUsername('owner').email, 'owner@example.com');
});

test('admin console: members and memberships, not personal details; SKU totals and a restock ping; stores; setup check; Whop; audit', async () => {
  const other = await Client.signup(env.url, 'customer');
  await other.put('/api/profiles', { profiles: [{ label: 'Home', address1: '42 Secret St' }] });
  await page.goto(`${env.url}/admin#members`);
  await page.waitForSelector('#users tr[data-id]');
  const text = await page.textContent('#admin');
  assert.match(text, /customer/);
  assert.match(text, /mem_member1/);
  assert.doesNotMatch(text, /Secret St/);
  const row = page.locator('#users tr', { hasText: 'customer' });
  await row.locator('select').selectOption('comped');
  await page.waitForFunction(() => /Free access/.test(document.querySelector('#users').textContent));
  page.once('dialog', async (d) => { assert.match(d.message(), /Password-reset link for customer/); assert.match(d.defaultValue(), /\/reset\?token=/); await d.accept(); });
  await row.getByRole('button', { name: 'Reset link' }).click();
  await waitFor(() => env.app.repo.listAudit().some((a) => a.action === 'reset-link'), { message: 'reset link audited' });
  if (shots) await page.screenshot({ path: path.join(shots, 'admin-members.png'), fullPage: true });

  await page.click('a[data-tab="skus"]');
  await page.waitForSelector('#skus tr');
  assert.match(await page.textContent('#skus'), /Day UPC.*Kmart · 43818648/s);
  assert.doesNotMatch(await page.textContent('#skus'), /customer|owner|member1/, 'totals, not who');
  await page.selectOption('#r-store', 'kmart');
  await page.fill('#r-sku', '43818648');
  await page.fill('#r-note', 'online only');
  page.once('dialog', (d) => d.accept());
  await page.click('#restock-form button[type=submit]');
  await page.waitForFunction(() => /Pinged \d+ of \d+ watchers and posted in the restock channel/.test(document.querySelector('#r-msg').textContent));

  // The blacklist: the Kmart bookcase that kept pinging is already on it; add a SKU and a whole store, then take one off.
  await page.click('a[data-tab="blacklist"]');
  await page.waitForFunction(() => /Wave Book Storage - Oak - One Size/.test(document.querySelector('#blacklist').textContent));
  assert.match(await page.textContent('#blacklist'), /SKU 43746880\s*Kmart/);
  await page.selectOption('#bl-store', 'kmart');
  await page.fill('#bl-sku', '43834044');
  await page.fill('#bl-note', 'not wanted');
  await page.click('#bl-form button[type=submit]');
  await page.waitForFunction(() => /Added/.test(document.querySelector('#bl-msg').textContent));
  await page.waitForFunction(() => /SKU 43834044/.test(document.querySelector('#blacklist').textContent));
  await page.selectOption('#bl-store', 'amazon');
  page.once('dialog', (d) => { assert.match(d.message(), /every product at Amazon AU/); d.accept(); });
  await page.click('#bl-form button[type=submit]');
  await page.waitForFunction(() => /Every product\s*Amazon AU/.test(document.querySelector('#blacklist').textContent));
  assert.ok(env.app.catalog.isBlocked('amazon', 'B0ANYTHING1'), 'the whole store');
  await page.locator('#blacklist tr', { hasText: '43834044' }).getByRole('button', { name: /Take SKU 43834044 at Kmart off the blacklist/ }).click();
  await page.waitForFunction(() => !/43834044/.test(document.querySelector('#blacklist').textContent));
  assert.ok(!env.app.catalog.isBlocked('kmart', '43834044'));
  if (shots) await page.screenshot({ path: path.join(shots, 'admin-blacklist.png'), fullPage: true });

  await page.click('a[data-tab="retailers"]');
  await page.waitForSelector('#retailers tr');
  assert.match(await page.textContent('#retailers'), /Kmart.*verified/s);
  await page.locator('#retailers tr', { hasText: 'Target' }).getByRole('button', { name: 'View flow' }).click();
  await page.waitForFunction(() => /server\/retailers\/target\.js/.test(document.querySelector('#flow-json').textContent));
  await page.locator('#retailers tr', { hasText: 'Amazon' }).locator('input[aria-label="Amazon AU enabled"]').uncheck();
  await waitFor(() => env.app.repo.getSetting('retailer:amazon')?.enabled === false, { message: 'retailer switched off' });

  await page.click('a[data-tab="integrations"]');
  await page.waitForFunction(() => /Webhook URL to add in Whop: http/.test(document.querySelector('#integrations').textContent));
  await page.click('#d-check');
  await page.waitForFunction(() => /Mugibot Members/.test(document.querySelector('#d-checks').textContent));

  await page.click('a[data-tab="whop"]');
  await page.waitForFunction(() => /mem_member1/.test(document.querySelector('#memberships').textContent));

  await page.click('a[data-tab="audit"]');
  await page.waitForFunction(() => /plan none → comped/.test(document.querySelector('#audit').textContent));
  assert.match(await page.textContent('#audit'), /restock-ping/);

  await page.click('a[data-tab="overview"]');
  await page.waitForSelector('#stats .stat');
  assert.match(await page.textContent('#stats'), /Paying members/);
  if (shots) await page.screenshot({ path: path.join(shots, 'admin.png'), fullPage: true });
});

test('Auto-checkout tab: switched on only with the agreement; limits; arming needs a max price; every attempt shows up with why', async () => {
  const owner = env.app.repo.userByUsername('owner');
  // More than a page of items (10 to a page).
  for (let i = 0; i < 6; i += 1) env.app.repo.addItem(owner.id, { store: 'kmart', sku: `4390000${i}`, name: `Extra box ${i + 1}`, url: `https://www.kmart.com.au/product/extra-box-${i + 1}-4390000${i}/`, price: 30, maxPrice: null, quantity: 1, profileId: null, monitor: true, announce: false, aco: false });
  const total = env.app.repo.listItems(owner.id).length;
  assert.ok(total > 10, `${total} items`);
  await page.goto(`${env.url}/app#aco`);
  await page.waitForSelector('[data-panel="aco"]:not([hidden]) #aco-items tr.aco-item');
  // A table of 10, and pages.
  assert.equal(await page.locator('#aco-items tr.aco-item').count(), 10);
  assert.match(await page.textContent('#aco-pager'), new RegExp(`1–10 of ${total}`));
  await page.click('#aco-pager button[aria-label="Next page"]');
  assert.equal(await page.locator('#aco-items tr.aco-item').count(), total - 10);
  assert.match(await page.textContent('#aco-items'), /Extra box 6/);
  await page.click('#aco-pager button[aria-label="Armed items page 1"]');
  assert.equal(await page.getAttribute('#aco-pager button[aria-label="Armed items page 1"]', 'aria-current'), 'page');
  // Trigger ACO needs Auto-checkout switched on.
  assert.equal(await page.isDisabled('#aco-items tr.aco-item >> nth=0 >> .aco-test'), true);
  assert.match(await page.textContent('#aco-state'), /^Off$/);
  assert.match(await page.textContent('#aco-runs'), /Nothing yet/);
  // The switch asks for the agreement first.
  await page.click('#aco-enabled');
  await page.waitForFunction(() => /agree first/.test(document.querySelector('#aco-msg').textContent));
  assert.equal(env.app.aco.settings(owner.id).enabled, false);
  await page.check('#aco-agree');
  await page.click('#aco-enabled');
  await page.waitForFunction(() => document.querySelector('#aco-enabled').getAttribute('aria-checked') === 'true');
  assert.match(await page.textContent('#aco-state'), /On — places orders/);
  assert.equal(await page.isVisible('#aco-agree-wrap'), false, 'agreed once');
  assert.equal(typeof env.app.aco.settings(owner.id).agreedAt, 'number');
  // The limits.
  await page.check('input[name="aco-mode"][value="fill"]');
  await page.fill('#aco-max', '250');
  await page.fill('#aco-perday', '3');
  await page.click('#aco-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#aco-msg').textContent === 'Saved.');
  const s = env.app.aco.settings(owner.id);
  assert.deepEqual([s.mode, s.maxOrder, s.perDay], ['fill', 250, 3]);
  assert.match(await page.textContent('#aco-state'), /stops at the final button/);
  // Ready to check out? No extension in this browser.
  await page.waitForFunction(() => /Install the extension/.test(document.querySelector('#aco-checks').textContent));

  // Arming: not without a max price.
  const day = page.locator('#aco-items tr.aco-item', { hasText: 'Day UPC' });
  await day.locator('.sn-sw').click();
  await page.waitForFunction(() => /Set a max price/.test(document.querySelector('#toasts')?.textContent || ''));
  const dayItem = env.app.db.get("SELECT * FROM items WHERE user_id = :u AND name = 'Day UPC'", { u: owner.id });
  assert.equal(dayItem.aco, 0);
  await day.locator('input.aco-max').fill('380');
  await day.locator('.sn-sw').click();
  await page.waitForSelector('#aco-items tr.aco-item.armed');
  assert.match(await page.textContent('#aco-armed-count'), /1 armed/);
  // Armed only.
  await page.selectOption('#aco-show', 'armed');
  assert.equal(await page.locator('#aco-items tr.aco-item').count(), 1);
  assert.equal(await page.isHidden('#aco-pager'), true, 'one page');
  await page.selectOption('#aco-show', '');
  assert.equal(env.app.db.get('SELECT aco, max_price FROM items WHERE id = :id', { id: dayItem.id }).max_price, 380);

  // It drops at $360, over the $250 an order limit: kept as "didn't start", with why — live.
  await env.app.monitor.alertRestock(env.app.db.get('SELECT * FROM items WHERE id = :id', { id: dayItem.id }), { status: 'in_stock', price: 360, source: 'sweep' });
  await page.waitForSelector('#aco-runs li.aco-run.st-skipped');
  assert.match(await page.textContent('#aco-runs li.aco-run.st-skipped'), /Day UPC.*Kmart · \$360\.00 · seen by the live monitor.*Skipped.*\$360\.00 is over your limit of \$250\.00 an order/s);
  // An order placed for another item (as the extension reports it).
  const etb = env.app.repo.getItem(owner.id, env.app.db.get("SELECT id FROM items WHERE user_id = :u AND name = 'Elite Trainer Box'", { u: owner.id }).id);
  const run = env.app.aco.create({ userId: owner.id, item: etb, price: 100, mode: 'place', trigger: 'sweep' }, 'queued', '', 'Dropped at Kmart for $100.00');
  env.app.db.run("UPDATE aco_runs SET status = 'started' WHERE id = :id", { id: run.id });
  await env.app.aco.report(owner.id, run.id, { status: 'placing', total: 110, message: 'Pressing "Checkout securely" — total $110.00' });
  await env.app.aco.report(owner.id, run.id, { status: 'placed', message: 'Order confirmed at Kmart' });
  await page.waitForSelector('#aco-runs li.aco-run.st-placed');
  assert.match(await page.textContent('#aco-runs li.aco-run.st-placed'), /Elite Trainer Box.*\$110\.00 total.*Order placed.*Order confirmed at Kmart/s);
  await page.click('#aco-runs li.aco-run.st-placed summary');
  assert.match(await page.textContent('#aco-runs li.aco-run.st-placed .aco-steps'), /Final button pressed — Pressing "Checkout securely".*Order placed — Order confirmed at Kmart/s);
  assert.match(await page.textContent('#aco-stats'), /Orders placed\s*1\s*\$110\.00 spent/);
  // The filter.
  await page.selectOption('#aco-filter', 'placed');
  assert.equal(await page.locator('#aco-runs li.aco-run').count(), 1);
  await page.selectOption('#aco-filter', 'skipped');
  assert.match(await page.textContent('#aco-runs'), /Day UPC/);
  assert.doesNotMatch(await page.textContent('#aco-runs'), /Elite Trainer Box/);
  await page.selectOption('#aco-filter', 'failed');
  assert.match(await page.textContent('#aco-runs'), /Nothing here/);
  await page.selectOption('#aco-filter', '');

  // Trigger ACO: a test run now, as if it had dropped — it says what it will do first. (A browser
  // with the extension is connected to the account, to pick it up.)
  const { device } = env.app.repo.addDevice(owner.id, 'Chrome on Mac', '1.11.0');
  const ko = page.locator('#aco-items tr.aco-item', { hasText: 'Knock Out Collection' });
  await ko.locator('input.aco-max').fill('30');
  page.once('dialog', (d) => { assert.match(d.message(), /Trigger ACO for Knock Out Collection\?.*checks out as if it had just dropped.*stops at the final button/s); d.accept(); });
  await ko.locator('.aco-test').click();
  await page.waitForFunction(() => /Auto-checkout test started/.test(document.querySelector('#toasts')?.textContent || ''));
  const koItem = env.app.db.get("SELECT * FROM items WHERE user_id = :u AND name = 'Knock Out Collection'", { u: owner.id });
  assert.equal(koItem.max_price, 30, 'the max price typed in was saved first');
  assert.equal(koItem.aco, 0, "a test doesn't arm it");
  await page.waitForFunction(() => /test run \(Trigger ACO\)/.test(document.querySelector('#aco-runs').textContent));
  assert.match(await page.textContent('#aco-runs li.aco-run.active'), /Knock Out Collection.*test run \(Trigger ACO\).*Waiting for your browser/s);
  // …and when it can't start, why: Day UPC at $360 is over the $250 an order limit.
  page.once('dialog', (d) => d.accept());
  await day.locator('.aco-test').click();
  // (Its own words: an earlier "didn't start" — this test's Day UPC drop, above — can still be showing.)
  await page.waitForFunction(() => /over your limit of \$250\.00 an order/.test(document.querySelector('#toasts')?.textContent || ''));
  // A test run already going: not twice.
  page.once('dialog', (d) => d.accept());
  await ko.locator('.aco-test').click();
  await page.waitForFunction(() => /already checking out/.test(document.querySelector('#toasts')?.textContent || ''));
  env.app.repo.deleteDevice(owner.id, device.id);
  // On the watchlist (the Monitor page), an armed item says so.
  await page.click('a[data-tab="monitor"]');
  await page.click('#pt-watch');
  await page.waitForSelector('#w-list li[data-id]');
  assert.match(await page.textContent(`#w-list li[data-id="${dayItem.id}"]`), /Armed/);
  if (shots) {
    await page.goto(`${env.url}/app#aco`);
    await page.waitForSelector('#aco-runs li.aco-run');
    await page.screenshot({ path: path.join(shots, 'auto-checkout.png'), fullPage: true });
  }
  // Off again, for the rest of the tests.
  await env.app.aco.disarm(owner.id, dayItem.id);
  env.app.repo.setData(owner.id, 'aco', { ...env.app.aco.settings(owner.id), enabled: false });
});

test("Auto-checkout tab: ⚡ Buy from your phone — its switch, and the checkout browser (the one runs go to) with which of your browsers are open", async () => {
  const owner = env.app.repo.userByUsername('owner');
  await page.goto(`${env.url}/app#aco`);
  await page.waitForSelector('[data-panel="aco"]:not([hidden]) #aco-remote');
  // No browser connected yet.
  await page.waitForFunction(() => /No browser connected/.test(document.querySelector('#aco-remote-state').textContent));
  assert.match(await page.textContent('#aco-device-note'), /Connect the extension in the browser on the computer you keep on/);
  // Two browsers: the newest checks out; the other can be picked.
  const me = new Client(env.url);
  await me.post('/api/auth/login', { username: 'owner', password: PASSWORD });
  const work = await Device.pair(env.url, me, 'Chrome on Work PC');
  const home = await Device.pair(env.url, me, 'Chrome on Home PC');
  await home.call('GET', '/api/ext/aco/next'); // the home one is open (asking for runs)
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#aco-device option').length === 2);
  assert.equal(await page.locator('#aco-device option').count(), 2);
  assert.match(await page.textContent('#aco-device option:checked'), /^Chrome on Home PC \(open now\)$/);
  assert.match(await page.textContent('#aco-remote-state'), /^Ready$/);
  assert.match(await page.textContent('#aco-device-note'), /go to this one browser — never to all of them/);
  // Pick the work one: it checks out from now on (and isn't open, so the card says so).
  const workId = (await me.get('/api/devices')).body.devices.find((d) => d.name === 'Chrome on Work PC').id;
  await page.selectOption('#aco-device', workId);
  await page.waitForFunction(() => /Checkout browser changed/.test(document.querySelector('#toasts')?.textContent || ''));
  assert.equal(env.app.aco.settings(owner.id).deviceId, workId);
  await page.waitForFunction(() => /Checkout browser not open/.test(document.querySelector('#aco-remote-state').textContent));
  assert.match(await page.textContent('#aco-device-note'), /Chrome on Work PC isn't open right now: a ⚡ Buy waits 2 minutes for it/);
  if (shots) await page.locator('#aco-remote').screenshot({ path: path.join(shots, 'aco-remote.png') });
  assert.equal((await work.call('GET', '/api/ext/items')).body.aco.listen, true);
  // The switch.
  await page.click('#aco-remote-on');
  await page.waitForFunction(() => document.querySelector('#aco-remote-on').getAttribute('aria-checked') === 'false');
  assert.equal(env.app.aco.settings(owner.id).remoteBuy, false);
  assert.match(await page.textContent('#aco-remote-state'), /^Off$/);
  await page.click('#aco-remote-on');
  await page.waitForFunction(() => document.querySelector('#aco-remote-on').getAttribute('aria-checked') === 'true');
  // (Leave it as it was: no browsers.)
  for (const d of (await me.get('/api/devices')).body.devices) await me.del(`/api/devices/${d.id}`);
  await me.put('/api/aco', { deviceId: '' });
});

test('Auto-checkout tab: 🧹 your bags at each store — Clear cart and Clear all, sent to your checkout browser (asked first), each store saying how it went; an old extension there: update it first', async () => {
  const me = new Client(env.url);
  await me.post('/api/auth/login', { username: 'owner', password: PASSWORD });
  await page.goto(`${env.url}/app#aco`);
  await page.reload(); // (already on this tab: what it shows now, not what it loaded then)
  await page.waitForSelector('[data-panel="aco"]:not([hidden]) #bags li[data-store="kmart"]');
  // No browser connected yet.
  assert.match(await page.textContent('#bags-sum'), /Connect the extension in the browser you check out with/);
  assert.equal(await page.locator('#bags li[data-store="kmart"] button').isDisabled(), true);
  assert.equal(await page.isDisabled('#bags-all'), true);
  assert.match(await page.textContent('#bags li[data-store="kmart"]'), /Not emptied from here yet/);
  // An extension too old to do it there.
  const pc = await Device.pair(env.url, me, 'Chrome on Home PC');
  await pc.call('GET', '/api/ext/me?v=1.17.0');
  await page.reload();
  await page.waitForFunction(() => /Update the extension in Chrome on Home PC to 1\.18\.0 or newer to empty its bags from here \(it has 1\.17\.0\)/.test(document.querySelector('#bags-sum').textContent));
  assert.equal(await page.locator('#bags li[data-store="kmart"] button').isDisabled(), true);
  // Up to date, and open.
  await pc.call('GET', '/api/ext/me?v=1.18.0');
  await pc.call('GET', '/api/ext/aco/next');
  await page.reload();
  await page.waitForFunction(() => /Emptied in Chrome on Home PC, your checkout browser \(open now\)/.test(document.querySelector('#bags-sum').textContent));
  // Clear cart at one store: asked first — "no" asks nothing of the browser…
  page.once('dialog', (d) => d.dismiss());
  await page.click('#bags li[data-store="kmart"] button');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await pc.call('GET', '/api/ext/aco/next')).body.clears.length, 0);
  // …"yes" sends it there, and the card follows how it goes by itself.
  page.once('dialog', (d) => { assert.match(d.message(), /Empty your Kmart bag in Chrome on Home PC\?/); d.accept(); });
  await page.click('#bags li[data-store="kmart"] button');
  await page.waitForFunction(() => /Waiting for Chrome on Home PC/.test(document.querySelector('#bags li[data-store="kmart"]').textContent));
  assert.match(await page.textContent('#bags-msg'), /Chrome on Home PC is emptying it\./);
  assert.equal(await page.locator('#bags li[data-store="kmart"] button').isDisabled(), true, 'once at a time');
  const job = (await pc.call('GET', '/api/ext/aco/next')).body.clears[0];
  await pc.call('POST', `/api/ext/bags/${job.id}`, { status: 'clearing', removed: 1 });
  await page.waitForFunction(() => /Emptying it… 1 removed so far/.test(document.querySelector('#bags li[data-store="kmart"]').textContent));
  await pc.call('POST', `/api/ext/bags/${job.id}`, { status: 'cleared', removed: 2 });
  await page.waitForFunction(() => /✓ Emptied — 2 items removed/.test(document.querySelector('#bags li[data-store="kmart"]').textContent));
  // Clear all: every store, one at a time — each one's end shows on its own.
  page.once('dialog', (d) => { assert.match(d.message(), /Empty your bags at all \d+ stores in Chrome on Home PC\?/); d.accept(); });
  await page.click('#bags-all');
  await page.waitForFunction(() => document.querySelectorAll('#bags li.active').length > 5);
  assert.match(await page.textContent('#bags-msg'), /emptying your bags, one store at a time/);
  for (const j of (await pc.call('GET', '/api/ext/aco/next')).body.clears) {
    await pc.call('POST', `/api/ext/bags/${j.id}`, j.store === 'target' ? { status: 'failed', message: "Target didn't take it out when its Remove button was pressed" }
      : j.store === 'bigw' ? { status: 'busy', message: 'Your checkout of ETB at BIG W is going in this browser — its bag was left alone.' } : { status: 'empty' });
  }
  await page.waitForFunction(() => !document.querySelector('#bags li.active'));
  assert.match(await page.textContent('#bags li[data-store="target"]'), /✗ Couldn't empty it: Target didn't take it out/);
  assert.match(await page.getAttribute('#bags li[data-store="target"]', 'class'), /\berr\b/);
  assert.match(await page.textContent('#bags li[data-store="bigw"]'), /Left alone: Your checkout of ETB at BIG W is going/);
  assert.match(await page.textContent('#bags li[data-store="ebgames"]'), /✓ Already empty/);
  if (shots) await page.locator('#bags-card').screenshot({ path: path.join(shots, 'bags.png') });
  // (Leave it as it was: no browsers.)
  for (const d of (await me.get('/api/devices')).body.devices) await me.del(`/api/devices/${d.id}`);
});

test("Monitor page for a member: each store's switch (hidden just for them), ☆ Watch on a tracked product, and never where the searches come from", async () => {
  const c = await Client.signup(env.url, 'storefan');
  env.app.repo.updateUser(c.user.id, { plan: 'comped' });
  for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
  const kp = env.app.catalog.upsertProduct({ store: 'kmart', sku: '43899001', url: 'https://www.kmart.com.au/product/switch-test-43899001/', name: 'Pokémon TCG Switch Test Tin' });
  env.app.catalog.updateProduct(kp.id, { status: 'in_stock', price: 25, sweep_seen_at: Date.now(), sweep_first_at: Date.now(), status_source: 'sweep' });
  const tp = env.app.catalog.upsertProduct({ store: 'target', sku: '71899002', url: 'https://www.target.com.au/p/switch-test/71899002', name: 'Pokémon TCG Switch Test Box' });
  env.app.catalog.updateProduct(tp.id, { status: 'in_stock', price: 59, sweep_seen_at: Date.now(), sweep_first_at: Date.now(), status_source: 'sweep' });
  const fan = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  fan.on('pageerror', (e) => errors.push(e.message));
  await fan.context().addCookies([{ name: 'mgb_session', value: c.cookie.split('=')[1], url: env.url }]);
  await fan.goto(`${env.url}/app#monitor`);
  await fan.waitForSelector('#sn-channels .sn-chan[data-store="kmart"]');
  // Where each store is searched from (server, an admin's browser) is for admins: not in the page at all.
  assert.doesNotMatch(await fan.textContent('#sn-channels'), /admin's browser|server/i);
  // A store that keeps failing: members see it too — no Reset button (admins'), and nothing in its place.
  const jb = env.app.retailers.get('jbhifi');
  const term = { keyword: 'pokemon', page: 1 };
  // (Twice: a third would hand it to an admin's browser, which members aren't told about.)
  for (let i = 0; i < 2; i += 1) env.app.sweeper.record(jb, term, { ok: false, blocked: true, error: 'The store refused the search (HTTP 503)', source: 'server', url: env.app.sweeper.urlFor(jb, 'pokemon'), ms: 300 });
  await fan.reload();
  await fan.waitForFunction(() => /JB Hi-Fi needs attention/.test(document.querySelector('#sn-attention:not([hidden])')?.textContent || ''));
  const said = await fan.textContent('#sn-attention');
  assert.match(said, /Mugibot keeps trying, waiting a little longer each time\.$/, said);
  assert.equal(await fan.locator('#sn-attention button').count(), 0);
  env.app.sweeper.reset('jbhifi');
  await fan.click('#sn-channels .sn-chan[data-store="kmart"] .st-toggle');
  assert.doesNotMatch(await fan.textContent('#sn-channels .sn-chan[data-store="kmart"]'), /\bfrom\b/);
  // Members start at Tracked products: both test products, each with ☆ Watch.
  await fan.waitForFunction(() => /Switch Test Tin/.test(document.querySelector('#m-products').textContent) && /Switch Test Box/.test(document.querySelector('#m-products').textContent));
  assert.equal(await fan.getAttribute('#pt-tracked', 'aria-selected'), 'true');
  // ☆ Watch: on your watchlist (its own checks, DMs and Auto-checkout) — then a ★.
  await fan.locator('#m-products li.product', { hasText: 'Switch Test Box' }).getByRole('button', { name: 'Watch Pokémon TCG Switch Test Box' }).click();
  await waitFor(() => env.app.repo.listItems(c.user.id).some((x) => x.store === 'target' && x.sku === '71899002'), { message: 'on the watchlist' });
  await fan.waitForSelector('#m-products li.product:has-text("Switch Test Box") a.watching');
  assert.match(await fan.textContent('#pt-watch'), /My watchlist\s*1/);
  // Kmart off for this member: its switch, its products, and a toast — the monitor carries on for everyone.
  const sw = fan.locator('#sn-channels .sn-chan[data-store="kmart"] .st-sw');
  assert.equal(await sw.getAttribute('aria-checked'), 'true');
  await sw.click();
  await fan.waitForFunction(() => document.querySelector('#sn-channels .sn-chan[data-store="kmart"] .st-sw').getAttribute('aria-checked') === 'false');
  assert.match(await fan.textContent('#sn-channels .sn-chan[data-store="kmart"]'), /Off for you/);
  await fan.waitForFunction(() => !/Switch Test Tin/.test(document.querySelector('#m-products').textContent));
  assert.match(await fan.textContent('#m-products'), /Switch Test Box/);
  assert.deepEqual(env.app.repo.getData(c.user.id, 'monitorPrefs').hiddenStores, ['kmart']);
  // Picking the store in the filter still shows it.
  await fan.selectOption('#m-store', 'kmart');
  await fan.waitForFunction(() => /Switch Test Tin/.test(document.querySelector('#m-products').textContent));
  await fan.selectOption('#m-store', '');
  // Kept: after a reload it's still off for them; then back on.
  await fan.reload();
  await fan.waitForSelector('#sn-channels .sn-chan[data-store="kmart"] .st-sw[aria-checked="false"]');
  await fan.click('#sn-channels .sn-chan[data-store="kmart"] .st-sw');
  await fan.waitForSelector('#sn-channels .sn-chan[data-store="kmart"] .st-sw[aria-checked="true"]');
  await fan.waitForFunction(() => /Switch Test Tin/.test(document.querySelector('#m-products').textContent));
  assert.deepEqual(env.app.repo.getData(c.user.id, 'monitorPrefs').hiddenStores, []);
  await fan.close();
  // An admin's switch: the store's monitoring off for everyone (asked first), and on again.
  await page.goto(`${env.url}/app#monitor`);
  await page.waitForSelector('#sn-channels .sn-chan[data-store="target"] .st-sw[aria-checked="true"]');
  page.once('dialog', (d) => d.accept());
  await page.click('#sn-channels .sn-chan[data-store="target"] .st-sw');
  await waitFor(() => env.app.sweeper.modeFor(env.app.retailers.get('target')) === 'off', { message: 'Target off for everyone' });
  await page.waitForSelector('#sn-channels .sn-chan[data-store="target"] .st-sw[aria-checked="false"]', { timeout: 10000 });
  assert.match(await page.textContent('#sn-channels .sn-chan[data-store="target"]'), /Switched off: not searched/);
  await page.click('#sn-channels .sn-chan[data-store="target"] .st-sw');
  await waitFor(() => env.app.sweeper.modeFor(env.app.retailers.get('target')) === 'auto', { message: 'Target back on, server first (its default)' });
  await page.waitForSelector('#sn-channels .sn-chan[data-store="target"] .st-sw[aria-checked="true"]', { timeout: 10000 });
});

test('🚦 a checkpoint or virtual queue going up shows on every dashboard straight away — what to do, and a link — and goes when it comes down', async () => {
  const c = await Client.signup(env.url, 'queuefan');
  env.app.repo.updateUser(c.user.id, { plan: 'comped' });
  const g = env.app.gates;
  g.flip(env.app.retailers.get('ebgames'), 'up', { source: 'probe', wait: 23 });
  const fan = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  fan.on('pageerror', (e) => errors.push(e.message));
  await fan.context().addCookies([{ name: 'mgb_session', value: c.cookie.split('=')[1], url: env.url }]);
  await fan.goto(`${env.url}/app#monitor`);
  await fan.waitForSelector('#gates-banner .gate-notice[data-store="ebgames"]');
  assert.match(await fan.textContent('#gates-banner'), /EB Games's virtual queue is up — about 23 min\. Get in line in your browser and leave the queue page alone: it refreshes itself/);
  assert.equal(await fan.getAttribute('#gates-banner .gate-notice[data-store="ebgames"] a', 'href'), 'https://www.ebgames.com.au/');
  // Live: JB Hi-Fi's checkpoint goes up — there without a reload.
  g.flip(env.app.retailers.get('jbhifi'), 'up', { source: 'server' });
  await fan.waitForSelector('#gates-banner .gate-notice[data-store="jbhifi"]');
  assert.match(await fan.textContent('#gates-banner .gate-notice[data-store="jbhifi"]'), /JB Hi-Fi's checkpoint is up\. Solve it once in your browser before the drop/);
  assert.equal(await fan.getAttribute('#gates-banner .gate-notice[data-store="jbhifi"] a', 'href'), 'https://www.jbhifi.com.au/checkpoint');
  // Down: gone.
  g.flip(env.app.retailers.get('ebgames'), 'down', { source: 'probe' });
  await fan.waitForFunction(() => !document.querySelector('#gates-banner .gate-notice[data-store="ebgames"]'));
  g.flip(env.app.retailers.get('jbhifi'), 'down', { source: 'server' });
  await fan.waitForFunction(() => !document.querySelector('#gates-banner .gate-notice'));
  await g.settled();
  await fan.close();
});

test('🎯 Drop watches: one box for a link or words — the form shows where to look, Auto-checkout only where Mugibot checks out; for everyone (admins) or just for you', async () => {
  const XBOX = 'https://www.jbhifi.com.au/products/xbox-series-x25-limited-edition-console-1tb';
  const PINGS = '800000000000000002';
  discord.state.roles.push({ id: PINGS, name: 'Drop pings', position: 3, permissions: '0' });
  await page.goto(`${env.url}/app#drops`);
  await page.waitForSelector('#pp-drops:not([hidden]) #dw-form');
  assert.equal(await page.getAttribute('#pt-drops', 'aria-selected'), 'true');
  assert.match(await page.textContent('#dw-mine'), /No drop watches yet/);
  // An admin: where drops for everyone go (#non-tcg-alerts: made with the store channels, earlier) —
  // and, without it, one click makes it.
  assert.match(await page.textContent('#dw-channel'), /Drops for everyone are posted in #non-tcg-alerts/);
  const rule = env.app.catalog.listRoutes().find((r) => r.categories.includes('nontcg'));
  env.app.catalog.deleteRoute(rule.id);
  await page.reload();
  await page.waitForFunction(() => /No #non-tcg-alerts channel yet/.test(document.querySelector('#dw-channel').textContent));
  await page.click('#dw-channel button');
  await page.waitForFunction(() => /posted in #non-tcg-alerts/.test(document.querySelector('#dw-channel').textContent));
  assert.equal(discord.state.channels.filter((c) => c.name === 'non-tcg-alerts').length, 1, 'found by name, not made twice');
  assert.deepEqual(env.app.catalog.listRoutes().find((r) => r.categories.includes('nontcg')).channelId, rule.channelId);

  // A link at a store Mugibot knows: ⚡ Buy and Auto-checkout there; for everyone, with its category.
  await page.fill('#dw-input', XBOX);
  await page.waitForFunction(() => /JB Hi-Fi — .*⚡ Buy and Auto-checkout work here/.test(document.querySelector('#dw-hint').textContent));
  assert.equal(await page.isVisible('#dw-where'), false, 'no "where to look" for a link');
  assert.equal(await page.isVisible('#dw-aco-wrap'), true);
  assert.equal(await page.isChecked('#dw-share'), true, 'an admin\'s is for everyone unless they say');
  assert.equal(await page.inputValue('#dw-category'), 'nontcg');
  // Where it posts (admins): a channel of the Discord server, and a role to ping — the usual to start with.
  await page.waitForSelector('#dw-post-wrap:not([hidden]) #dw-post:not([disabled])');
  assert.equal(await page.inputValue('#dw-post'), '');
  const chans = await page.locator('#dw-post option').allTextContents();
  assert.equal(chans[0], 'The usual — #non-tcg-alerts');
  assert.ok(chans.includes('#general') && chans.includes('#non-tcg-alerts'), chans.join('|'));
  assert.equal(await page.locator('#dw-post optgroup[label="Mugibot alerts"] option', { hasText: '#non-tcg-alerts' }).count(), 1, 'by category');
  assert.deepEqual(await page.locator('#dw-ping option').allTextContents(), ['No one', '@Drop pings', '@Member'], "not @everyone, nor the bot's role");
  const general = discord.state.channels.find((x) => x.name === 'general').id;
  await page.selectOption('#dw-post', general);
  await page.selectOption('#dw-ping', PINGS);
  await page.click('#dw-add');
  await page.waitForSelector('#dw-mine .dw-row.shared');
  assert.match(await page.textContent('#dw-mine .dw-row.shared'), /Link · JB Hi-Fi · 📣 for everyone in #general · pings @Drop pings/);
  const linkWatch = env.app.drops.watches().find((x) => x.url === XBOX);
  assert.deepEqual([linkWatch.channelId, linkWatch.roleId], [general, PINGS]);
  assert.equal(await page.inputValue('#dw-post'), '', 'the pickers are ready for the next one');
  // Changed on its row (✎): back to the usual channel, no one pinged.
  await page.click('#dw-mine .dw-row.shared button[aria-label^="Where "]');
  await page.waitForSelector('#dw-mine .dw-row.shared form.dw-edit');
  assert.equal(await page.inputValue('#dw-mine .dw-row.shared form.dw-edit select[aria-label$="post in"]'), general);
  await page.selectOption('#dw-mine .dw-row.shared form.dw-edit select[aria-label$="post in"]', '');
  await page.selectOption('#dw-mine .dw-row.shared form.dw-edit select[aria-label$="ping"]', '');
  // (The list refreshing underneath — a live update — keeps what's chosen in the open editor.)
  const reloaded = page.waitForResponse((res) => res.url().endsWith('/api/drops') && res.request().method() === 'GET');
  env.app.hub.publish(env.app.repo.userByUsername('owner').id, 'drop', { id: linkWatch.id });
  await reloaded;
  await page.waitForTimeout(200);
  assert.deepEqual(await page.$$eval('#dw-mine .dw-row.shared form.dw-edit select', (els) => els.map((x) => x.value)), ['', '']);
  await page.click('#dw-mine .dw-row.shared form.dw-edit button[type=submit]');
  await page.waitForFunction(() => /Link · JB Hi-Fi · 📣 for everyone in #non-tcg-alerts/.test(document.querySelector('#dw-mine .dw-row.shared').textContent) && !document.querySelector('#dw-mine form.dw-edit'));
  assert.deepEqual([env.app.drops.get(linkWatch.id).channelId, env.app.drops.get(linkWatch.id).roleId], ['', '']);
  assert.match(await page.textContent('#dw-msg'), /Watching — its page is being read now/);
  const p = env.app.catalog.productFor('jbhifi', 'xbox-series-x25-limited-edition-console-1tb');
  assert.equal(p.category, 'nontcg');
  assert.ok(env.app.catalog.monitorForProduct(p.id).drop_watch);
  assert.equal(await page.inputValue('#dw-input'), '', 'the box is ready for the next one');

  // Words at another website: where to look, then its address; alerts only (no Auto-checkout); just for me.
  await page.fill('#dw-input', 'Nintendo Switch 2');
  await page.waitForSelector('#dw-where:not([hidden])');
  assert.match(await page.textContent('#dw-hint'), /choose where to look/);
  const options = await page.locator('#dw-store option').allTextContents();
  assert.ok(options.includes('JB Hi-Fi') && options.includes('Another website…'), options.join('|'));
  await page.selectOption('#dw-store', 'other');
  await page.waitForSelector('#dw-site-wrap:not([hidden])');
  assert.equal(await page.isVisible('#dw-aco-wrap'), false, 'no Auto-checkout at another website');
  await page.fill('#dw-site', 'https://shop.example.com');
  await page.uncheck('#dw-share');
  assert.equal(await page.isVisible('#dw-cat-wrap'), false);
  await page.click('#dw-add');
  await page.waitForFunction(() => /"nintendo switch 2"/.test(document.querySelector('#dw-mine').textContent));
  const own = page.locator('#dw-mine .dw-row', { hasText: '"nintendo switch 2"' });
  assert.match(await own.textContent(), /Words "nintendo switch 2" · shop\.example\.com · 🔒 just for you · Looking in a few seconds/);
  // Words at a store it searches: Auto-checkout's offered there.
  await page.fill('#dw-input', 'playstation 5 pro');
  await page.selectOption('#dw-store', 'jbhifi');
  await page.waitForSelector('#dw-aco-wrap:not([hidden])');
  assert.match(await page.textContent('#dw-hint'), /Anything at JB Hi-Fi whose name has "playstation 5 pro"/);
  await page.check('#dw-aco');
  await page.waitForSelector('#dw-aco-note:not([hidden])');
  assert.match(await page.textContent('#dw-aco-note'), /only what drops/);
  await page.click('#dw-add');
  await page.waitForFunction(() => /max price/.test(document.querySelector('#dw-msg').textContent), null, { timeout: 5000 }); // (Auto-checkout needs one)
  await page.fill('#dw-max', '1300');
  await page.click('#dw-add');
  await page.waitForFunction(() => /"playstation 5 pro"/.test(document.querySelector('#dw-mine').textContent));
  assert.match(await page.textContent('#dw-mine'), /🤖 auto-checkout up to \$1300\.00/);

  // A member: the admins' watches for everyone (with ☆ Watch), never an admin's own.
  const c = await Client.signup(env.url, 'dropfan');
  env.app.repo.updateUser(c.user.id, { plan: 'comped' });
  const fan = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  fan.on('pageerror', (e) => errors.push(e.message));
  await fan.context().addCookies([{ name: 'mgb_session', value: c.cookie.split('=')[1], url: env.url }]);
  await fan.goto(`${env.url}/app#drops`);
  await fan.waitForSelector('#dw-shared-box:not([hidden]) .dw-row');
  assert.match(await fan.textContent('#dw-shared'), /Link · JB Hi-Fi · 📣 for everyone · by owner/);
  assert.equal(await fan.isVisible('#dw-post-wrap'), false, 'where it posts is for admins');
  assert.equal(await fan.locator('#dw-shared button[aria-label^="Where "]').count(), 0);
  assert.doesNotMatch(await fan.textContent('#pp-drops'), /nintendo switch 2/, 'an admin\'s own watch is theirs');
  assert.equal(await fan.locator('#dw-shared .dw-row button', { hasText: 'Remove' }).count(), 0, 'not theirs to remove');
  assert.equal(await fan.isVisible('#dw-share-wrap'), false, 'members\' watches are their own');
  assert.equal(await fan.isVisible('#dw-channel'), false);
  await fan.locator('#dw-shared .dw-found li').first().getByRole('button', { name: /Watch/ }).click();
  await waitFor(() => env.app.repo.listItems(c.user.id).some((x) => x.sku === 'xbox-series-x25-limited-edition-console-1tb'), { message: 'on their watchlist' });
  // Their own link at another website.
  await fan.fill('#dw-input', 'https://shop.example.com/products/luffy-figure');
  await fan.waitForFunction(() => /Another website \(shop\.example\.com\)/.test(document.querySelector('#dw-hint').textContent));
  assert.equal(await fan.isVisible('#dw-aco-wrap'), false);
  await fan.click('#dw-add');
  await fan.waitForSelector('#dw-mine .dw-row');
  assert.match(await fan.textContent('#dw-mine'), /Luffy Figure.*Link · shop\.example\.com · 🔒 just for you/s);
  const it = env.app.repo.listItems(c.user.id).find((x) => x.store === 'other');
  assert.equal(it.sku, 'shop.example.com/luffy-figure');
  // Its find on the watchlist: no ⚡ Buy (another website), Open instead.
  await fan.click('#pt-watch');
  const wrow = fan.locator('#w-list li', { hasText: 'Luffy Figure' });
  await wrow.waitFor();
  assert.equal(await wrow.getByRole('button', { name: '⚡ Buy' }).count(), 0);
  assert.match(await wrow.textContent(), /Luffy Figure🎯shop\.example\.com alerts only/, 'found by a drop watch; its website, no SKU');
  await fan.close();

  // Removed (asked first): gone, and what it put on the watchlist with it.
  await page.reload();
  await page.waitForSelector('#pp-drops:not([hidden]) #dw-mine .dw-row');
  page.once('dialog', (d) => d.accept());
  await page.locator('#dw-mine .dw-row', { hasText: '"nintendo switch 2"' }).getByRole('button', { name: /Remove/ }).click();
  await page.waitForFunction(() => !/"nintendo switch 2"/.test(document.querySelector('#dw-mine').textContent));
  for (const w of (await page.evaluate(() => fetch('/api/drops').then((r) => r.json()))).watches.filter((x) => x.mine)) {
    await env.app.drops.remove(w.id, env.app.repo.userByUsername('owner'));
  }
});

test('Auto-checkout run history in pages; the card backup on Checkout details', async () => {
  const owner = env.app.repo.userByUsername('owner');
  const it = env.app.repo.listItems(owner.id)[0];
  const t = Date.now();
  for (let i = 1; i <= 13; i++) {
    env.app.db.run(`INSERT INTO aco_runs (id, user_id, item_id, store, sku, name, url, price, max_price, mode, trigger, status, reason, message, steps, created_at, updated_at)
      VALUES (:id, :u, :i, 'kmart', :sku, :name, '', 10, 20, 'place', 'test', 'skipped', 'over_max', '', '[]', :t, :t)`, { id: `acr_page${i}`, u: owner.id, i: it.id, sku: it.sku, name: `Paged run ${i}`, t: t - (13 - i) * 1000 });
  }
  const runs = env.app.db.get('SELECT COUNT(*) AS n FROM aco_runs WHERE user_id = :u', { u: owner.id }).n;
  await page.goto(`${env.url}/app#aco`);
  // (The dashboard's already open: the list it had shows first, then the one with these runs.)
  await page.waitForFunction((n) => new RegExp(`of ${n}\\b`).test(document.querySelector('#aco-runs-pager')?.textContent || ''), runs);
  assert.equal(await page.locator('#aco-runs li.aco-run').count(), 10, '10 to a page, no endless list');
  assert.match(await page.textContent('#aco-runs-pager'), new RegExp(`1–10 of ${runs}`));
  assert.match(await page.textContent('#aco-runs li.aco-run:first-child'), /Paged run 13/);
  await page.click('#aco-runs-pager button[aria-label="Next page"]');
  assert.match(await page.textContent('#aco-runs-pager'), new RegExp(`11–${Math.min(20, runs)} of ${runs}`));
  assert.doesNotMatch(await page.textContent('#aco-runs'), /Paged run 13/);
  assert.match(await page.textContent('[data-panel="aco"]'), /Run history/);
  // Checkout details: a card backed up in the account (locked in the extension) shows, and can be deleted.
  env.app.repo.setData(owner.id, 'cardBackup', { v: 1, kdf: 'PBKDF2-SHA256', iterations: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(48), last4: '4242', brand: 'Visa', expMonth: '12', expYear: '2031', hasCvc: true, savedAt: Date.now() });
  await page.goto(`${env.url}/app#checkout`);
  await page.waitForFunction(() => /Backed up/.test(document.querySelector('#card-backup').textContent));
  assert.match(await page.textContent('#card-backup'), /Visa •••• 4242 · expires 12\/31 is backed up in your account, locked with your card passphrase/);
  page.once('dialog', (d) => d.accept());
  await page.click('#card-unbackup');
  await page.waitForFunction(() => /Not backed up/.test(document.querySelector('#card-backup').textContent));
  assert.equal(env.app.repo.getData(owner.id, 'cardBackup', null), null);
  env.app.db.run("DELETE FROM aco_runs WHERE id LIKE 'acr_page%'");
});

test('four pages, not seven: Drops, Checkout (Auto-checkout and your delivery details and card), Setup (the extension and Discord), Account (membership and your account) — every old address still lands on its part; your loadout on Drops; on a phone, a tab bar at the bottom', async () => {
  await page.goto(`${env.url}/app#monitor`);
  assert.deepEqual(await page.$$eval('.side a', (as) => as.map((a) => [a.dataset.tab, a.querySelector('.lb').textContent])),
    [['monitor', 'Drops'], ['aco', 'Checkout'], ['setup', 'Setup'], ['account', 'Account']]);
  // Drops: your loadout first — membership, Auto-checkout, the extension in this browser, your card.
  await page.waitForSelector('#loadout:not([hidden]) .lo-chip');
  assert.equal(await page.locator('#loadout .lo-chip').count(), 4);
  assert.match(await page.textContent('#loadout'), /Auto-checkout (on|off)/);
  // Each page, the parts it's made of; the old addresses open the page their part is on now, there.
  const shown = () => page.$$eval('[data-panel]', (ps) => ps.filter((p) => !p.hidden).map((p) => p.dataset.panel));
  for (const [hash, page_, panels] of [['aco', 'aco', ['aco', 'checkout']], ['checkout', 'aco', ['aco', 'checkout']], ['setup', 'setup', ['extension', 'discord']],
    ['extension', 'setup', ['extension', 'discord']], ['discord', 'setup', ['extension', 'discord']], ['update', 'setup', ['extension', 'discord']],
    ['account', 'account', ['membership', 'account']], ['membership', 'account', ['membership', 'account']], ['watch', 'monitor', ['monitor']]]) {
    await page.goto(`${env.url}/app#${hash}`);
    await page.waitForFunction((want) => document.querySelector('.side a.active')?.dataset.tab === want, page_);
    assert.deepEqual(await shown(), panels, `#${hash}`);
    assert.equal(await page.getAttribute('.side a.active', 'aria-current'), 'page');
    assert.equal(await page.isVisible(`.jump[data-for="${page_}"]`), page_ !== 'monitor', `#${hash}: the row of its parts`);
  }
  // #discord lands on Discord, part way down Setup; the row's chips go to each part.
  await page.goto(`${env.url}/app#discord`);
  await page.waitForFunction(() => window.scrollY > 200);
  await page.goto(`${env.url}/app#aco`);
  await page.waitForSelector('[data-panel="aco"]:not([hidden]) #aco-items-card');
  await page.click('.jump[data-for="aco"] [data-jump="#bags-card"]');
  await page.waitForFunction(() => Math.abs(document.querySelector('#bags-card').getBoundingClientRect().top - 120) < 80);
  // A phone: the four pages along the bottom, in reach of a thumb.
  const phone = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await phone.context().addCookies(await page.context().cookies(env.url));
  await phone.goto(`${env.url}/app#aco`);
  await phone.waitForSelector('[data-panel="aco"]:not([hidden])');
  const bar = await phone.locator('.side').boundingBox();
  assert.ok(bar.y + bar.height >= 795 && bar.width >= 380, `the tab bar sits along the bottom: ${JSON.stringify(bar)}`);
  await phone.click('.side a[data-tab="setup"]');
  await phone.waitForSelector('[data-panel="extension"]:not([hidden])');
  await phone.close();
});

test('phone-sized screens: no sideways scrolling', async () => {
  const phone = await browser.newPage({ viewport: { width: 375, height: 800 } });
  phone.on('pageerror', (e) => errors.push(e.message));
  for (const p of ['/', '/signup', '/login', '/terms', '/privacy']) {
    await phone.goto(env.url + p);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `${p} overflows by ${overflow}px`);
  }
  const c = await Client.signup(env.url, 'phoneuser');
  await phone.context().addCookies([{ name: 'mgb_session', value: c.cookie.split('=')[1], url: env.url }]);
  for (const tab of ['watch', 'drops', 'activity', 'monitor', 'checkout', 'aco', 'discord', 'extension', 'membership', 'account']) {
    await phone.goto(`${env.url}/app#${tab}`);
    // (#watch, #drops and #activity: lists on Drops.)
    await phone.waitForSelector(`[data-panel="${['watch', 'drops', 'activity'].includes(tab) ? 'monitor' : tab}"]:not([hidden])`);
    await phone.waitForTimeout(150);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `#${tab} overflows by ${overflow}px`);
  }
  await phone.close();
  // The admin's Monitor pages: Live, Settings and the Check log.
  const admin = await browser.newPage({ viewport: { width: 375, height: 800 } });
  admin.on('pageerror', (e) => errors.push(e.message));
  await admin.context().addCookies(await page.context().cookies(env.url));
  await admin.addInitScript(() => localStorage.setItem('mgb-live', JSON.stringify({ sound: false, notify: false, popup: false })));
  for (const tab of ['monitor', 'monitor-settings', 'monitor-log']) {
    await admin.goto(`${env.url}/app#${tab}`);
    await admin.waitForSelector(`[data-panel="${tab}"]:not([hidden]) .mon-tabs:not([hidden])`);
    await admin.waitForTimeout(300);
    const overflow = await admin.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `#${tab} (admin) overflows by ${overflow}px`);
  }
  // The ⚙ menu fits too.
  await admin.goto(`${env.url}/app#monitor`);
  await admin.click('#sn-prefs-menu > summary');
  const box = await admin.locator('#sn-prefs').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375, `the menu fits: ${JSON.stringify(box)}`);
  await admin.close();
});

test('log out', async () => {
  await page.goto(`${env.url}/app`);
  await page.click('#logout');
  await page.waitForURL(`${env.url}/`);
  await page.goto(`${env.url}/app`);
  await page.waitForURL(/\/login\?next=/);
});

test("store login monitor: a store page's header — \"Sign in\" (signed out), \"Hi, Ash\" or \"Sign out\" (signed in)", async () => {
  const p = await browser.newPage();
  try {
    await p.setContent('<header><a href="/account">Sign in / Register</a></header>');
    await p.addScriptTag({ path: path.join(import.meta.dirname, '..', 'extension', 'logins.js') });
    const read = (html) => p.evaluate((h) => { document.body.innerHTML = h; return globalThis.MGBLogins.fromPage(document, null); }, html);
    assert.equal(await read('<header><a href="/account">Sign in / Register</a></header>'), 'out');
    assert.equal(await read('<header><button>Hello, sign in</button></header>'), 'out', "Amazon-style");
    assert.equal(await read('<header><a href="/account">Hi, Ash</a></header>'), 'in');
    assert.equal(await read('<header><a href="/account">Hi, there</a></header>'), null, 'a greeting without a name says nothing');
    assert.equal(await read('<header><a href="/account">Account</a><div hidden><a href="/logout">Sign out</a></div></header>'), 'in', 'a sign-out link in a closed account menu');
    assert.equal(await read('<header><a href="/login">Log in</a><a href="/logout" style="display:none">Log out</a></header>'), 'out', 'a page carrying both, with "Log in" showing');
    assert.equal(await read('<header><a href="/stores">Stores</a><a href="/help">Help</a></header>'), null, "can't tell");
    assert.equal(await read('<main><p>Sign in to see your orders.</p></main>'), null, 'only the header and account links count');
  } finally {
    await p.close();
  }
});

test('no JavaScript errors or blocked scripts/styles on any page', () => {
  assert.deepEqual(errors, []);
});
