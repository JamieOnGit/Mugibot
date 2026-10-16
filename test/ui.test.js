// The website, dashboard and admin console in a real browser (no extension):
// landing page, sign up, every dashboard tab, the ⚡ Buy page, every admin
// tab, phone-sized screens, and no JavaScript errors or security-policy
// violations anywhere.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { Client, PASSWORD, discordOpts, startApp, startFakeDiscord, startFakeWhop, waitFor, whopOpts, whopWebhook } from './helpers.js';
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
  browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=${stores.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`] });
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
  assert.match(text, /You press the final buy button/);
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

test('sign up with a username and land on the watchlist', async () => {
  await page.fill('#su-username', 'Owner');
  await page.fill('#su-password', PASSWORD);
  await page.check('#su-terms');
  await page.click('#signup button[type=submit]');
  await page.waitForURL(/\/app\?welcome=1/);
  await page.waitForSelector('#w-list li[data-id]');
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

test('Checkout details: several addresses, a default, validated; the card stays in the extension', async () => {
  await page.click('a[data-tab="checkout"]');
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
  // Items can deliver to a chosen address.
  await page.click('a[data-tab="watch"]');
  await page.locator('#w-list li', { hasText: 'Day UPC' }).getByRole('button', { name: 'Edit' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#w-profile option').length === 3);
  await page.selectOption('#w-profile', saved.profiles[0].id);
  await page.click('#w-save');
  await waitFor(() => env.app.repo.listItems(owner.id).find((x) => x.sku === '43818648').profileId === saved.profiles[0].id, { message: 'profile saved on the item' });
});

test('Discord tab: connect (the fake Discord sends straight back), pings, test ping, webhook check', async () => {
  discord.state.users['d-owner'] = { id: 'd-owner', username: 'owner_disc' };
  discord.state.nextUser = 'd-owner';
  await page.click('a[data-tab="discord"]');
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

test('Monitor tab: add a monitor, live alerts, product page with price history, alert rules; dark by default with a light switch', async () => {
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'dark theme by default');
  await page.click('a[data-tab="monitor"]');
  await page.waitForSelector('#m-stats .sn-stat');
  assert.match(await page.textContent('#m-stats'), /Available now\s*0\s*of 0 tracked/);
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
  await page.click('#md-close');

  // Discord alert rules.
  await page.click('#mr-new');
  await page.fill('#mr-name', 'Pokémon restocks');
  await page.fill('#mr-channel', '123456789012345678');
  await page.check('#mr-categories input[value="pokemon"]');
  await page.click('#mr-form button[type=submit]');
  await page.waitForFunction(() => /Pokémon restocks/.test(document.querySelector('#mr-list').textContent));
  assert.match(await page.textContent('#mh-loop'), /switched off|Monitor loop/);
  if (shots) await page.screenshot({ path: path.join(shots, 'monitor.png'), fullPage: true });

  await page.click('#theme-toggle');
  assert.equal(await page.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('mgb-theme')].join()), 'light,light');
  await page.click('#theme-toggle');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
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
  await page.waitForSelector('#ms-table tbody tr');
  assert.match(await page.textContent('#ms-table'), /Target\s*Server/);
  assert.match(await page.textContent('#ms-state'), /Off \(MONITOR_ENABLED=0\)/, '(tests run with the loops off)');
  // The live console: each store with its state, its search in the event log, the response-time chart.
  await page.waitForSelector('#sn-channels .sn-chan[data-store="target"]');
  assert.match(await page.textContent('#sn-channels .sn-chan[data-store="target"]'), /Target\s*Searching.*searches\s*1.*last answer\s*400 ms.*server · \/search\?sEngine=c&text=/s);
  assert.match(await page.textContent('#sn-channels .sn-chan[data-store="bigw"]'), /BIG W\s*Waiting.*admin's browser/s);
  assert.match(await page.textContent('#sn-channels .sn-chan[data-store="kmart"]'), /Kmart\s*Starting.*server · ac\.cnstrc\.com\/search\//s);
  assert.match(await page.textContent('#m-log'), /Search\s*Target · "pokemon" — 2 products · 1 count · first look \(no alerts\)\s*400 ms/);
  await page.waitForSelector('#sn-chart svg circle.end.s3');
  assert.match(await page.textContent('#sn-legend'), /Target\s*400 ms/);
  assert.match(await page.textContent('#sn-chips'), /pokemon.*one piece/s);
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
  assert.match(await page.textContent('#m-stats'), /Drops · 24 h\s*\d+/);
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

  // Keywords and tuning, right in the console.
  await page.fill('#sn-kw-input', 'Lorcana');
  await page.click('#sn-kw-form button[type=submit]');
  await page.waitForFunction(() => /lorcana/.test(document.querySelector('#sn-chips').textContent));
  assert.deepEqual(sw.settings.keywords, ['pokemon', 'one piece', 'lorcana']);
  await page.click('#sn-chips button[aria-label="Stop searching for lorcana"]');
  await page.waitForFunction(() => !/lorcana/.test(document.querySelector('#sn-chips').textContent));
  assert.deepEqual(sw.settings.keywords, ['pokemon', 'one piece']);
  await page.click('#sn-tuning button[role=switch][aria-label^="Price drops"]');
  await waitFor(() => sw.settings.priceAlerts === false, { message: 'price drop alerts off' });
  await page.click('#sn-tuning button[role=switch][aria-label^="Price drops"]');
  await waitFor(() => sw.settings.priceAlerts === true, { message: 'price drop alerts on' });
  // This browser: no pop-up when switched off, and the test alert runs only here.
  await page.click('#sn-tuning button[role=switch][aria-label="Pop-up for drops and restocks"]');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mgb-live')).popup), false);
  await page.click('#sn-tuning button[role=switch][aria-label="Pop-up for drops and restocks"]');
  await page.click('#sn-test');
  await page.waitForSelector('#sn-overlay:not([hidden])');
  assert.match(await page.textContent('#sn-ov-type'), /Test · New drop/);
  await page.click('#sn-ov-dismiss');
  await page.waitForSelector('#sn-overlay', { state: 'hidden' });
  assert.match(await page.textContent('#m-log'), /test \(this browser only\)/);
  await page.click('#sn-arm');
  await page.waitForFunction(() => /Alerts armed/.test(document.querySelector('#toasts')?.textContent || ''));

  // Settings.
  await page.fill('#ms-keywords', 'pokemon, one piece, dragon ball');
  await page.fill('#ms-every', '4');
  await page.selectOption('#ms-stores select[data-store="kmart"]', 'off');
  await page.uncheck('#ms-once');
  await page.click('#ms-form button[type=submit]');
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#ms-msg').textContent));
  assert.deepEqual(sw.settings.keywords, ['pokemon', 'one piece', 'dragon ball']);
  assert.equal(sw.settings.everySeconds, 4);
  assert.equal(sw.settings.restockOncePerDay, false);
  assert.equal(sw.modeFor(env.app.retailers.get('kmart')), 'off');
  await page.fill('#ms-keywords', ' ');
  await page.click('#ms-form button[type=submit]');
  await page.waitForFunction(() => /at least one keyword/.test(document.querySelector('#ms-msg').textContent));
  await page.click('details.ms-terms summary');
  assert.match(await page.textContent('#ms-terms'), /Target\s*pokemon\s*1/);
  if (shots) await page.screenshot({ path: path.join(shots, 'monitor-sweeps.png'), fullPage: true });
  await sw.save({ keywords: 'pokemon, one piece', stores: { kmart: 'browser' }, everySeconds: 5, restockOncePerDay: true }, null);
});

test('Extension tab: install steps, browser checks switch, stores and their flows', async () => {
  await page.click('a[data-tab="extension"]');
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
  await p2.click('a[data-tab="membership"]');
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

test('Activity and Account tabs', async () => {
  await page.goto(`${env.url}/app#activity`);
  await page.waitForFunction(() => /Welcome to Mugibot/.test(document.querySelector('#feed').textContent));
  assert.match(await page.textContent('#feed'), /Discord connected/);
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
  for (const tab of ['watch', 'monitor', 'checkout', 'discord', 'extension', 'membership', 'account']) {
    await phone.goto(`${env.url}/app#${tab}`);
    await phone.waitForSelector(`[data-panel="${tab}"]:not([hidden])`);
    await phone.waitForTimeout(150);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `#${tab} overflows by ${overflow}px`);
  }
  await phone.close();
});

test('log out', async () => {
  await page.goto(`${env.url}/app`);
  await page.click('#logout');
  await page.waitForURL(`${env.url}/`);
  await page.goto(`${env.url}/app`);
  await page.waitForURL(/\/login\?next=/);
});

test('no JavaScript errors or blocked scripts/styles on any page', () => {
  assert.deepEqual(errors, []);
});
