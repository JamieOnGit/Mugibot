// Building blocks: passwords, encryption, signed links, codes, retailers and
// their flows, input checks, Whop and Discord signatures, the zip writer and
// the extension builder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { decryptJSON, encryptJSON, hashPassword, humanCode, newUserKey, normalizeHumanCode, purposeKey, signParts, unwrapUserKey, verifyParts, verifyPassword } from '../server/crypto.js';
import { extensionFiles, extensionManifest, writeExtension } from '../server/extension.js';
import { RateLimiter, parseCookies } from '../server/http.js';
import { RETAILER_DEFS, Retailers, serialize } from '../server/retailers/index.js';
import { DEFAULT_ACO, acoSettings, alerts, item, profile, profiles, username } from '../server/schema.js';
import { makeZip } from '../server/zip.js';
import { extractProduct } from '../server/monitor/extract.js';
import { siteAnswer, siteUrl } from '../server/monitor/listing.js';
import { loadConfig } from '../server/config.js';
import { entitlement } from '../server/entitlement.js';
import { Whop, signWebhook } from '../server/whop.js';
import { verifyDiscordSignature } from '../server/routes/discord.js';
import { interactionKeys } from './helpers.js';

const retailers = new Retailers({ demoStoreUrl: '' });

test('passwords: scrypt hashes, salted, verified', async () => {
  const h1 = await hashPassword('hunter2 hunter2');
  const h2 = await hashPassword('hunter2 hunter2');
  assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(h1, h2, 'random salt');
  assert.equal(await verifyPassword('hunter2 hunter2', h1), true);
  assert.equal(await verifyPassword('hunter2 hunter3', h1), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('per-user keys: wrapped by the server key, bound to the user', () => {
  const master = crypto.randomBytes(32);
  const wrapped = newUserKey(master, 'usr_a');
  const key = unwrapUserKey(master, wrapped, 'usr_a');
  assert.equal(key.length, 32);
  assert.throws(() => unwrapUserKey(master, wrapped, 'usr_b'), 'another user id');
  assert.throws(() => unwrapUserKey(crypto.randomBytes(32), wrapped, 'usr_a'), 'another server key');
  const sealed = encryptJSON(key, { address1: '1 Pallet Rd' }, 'usr_a:profiles');
  assert.doesNotMatch(sealed, /Pallet/);
  assert.deepEqual(decryptJSON(key, sealed, 'usr_a:profiles'), { address1: '1 Pallet Rd' });
  assert.throws(() => decryptJSON(key, sealed, 'usr_a:alerts'), 'another field');
});

test('signed ⚡ Buy links: bound to the user, item and quantity, and expire', () => {
  const key = purposeKey(crypto.randomBytes(32), 'buy-link');
  const t = signParts(key, ['usr_a', 'itm_1', '2'], Date.now() + 60000);
  assert.equal(verifyParts(key, ['usr_a', 'itm_1', '2'], t), true);
  assert.equal(verifyParts(key, ['usr_b', 'itm_1', '2'], t), false, 'another user');
  assert.equal(verifyParts(key, ['usr_a', 'itm_1', '3'], t), false, 'another quantity');
  assert.equal(verifyParts(key, ['usr_a', 'itm_1', '2'], t, Date.now() + 120000), false, 'expired');
  assert.equal(verifyParts(purposeKey(crypto.randomBytes(32), 'buy-link'), ['usr_a', 'itm_1', '2'], t), false, 'another server');
  assert.equal(verifyParts(key, ['usr_a', 'itm_1', '2'], 'garbage'), false);
});

test('connection codes are easy to type', () => {
  for (let i = 0; i < 50; i++) assert.match(humanCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normalizeHumanCode(' abcd 2345 '), 'ABCD-2345');
});

test('retailers: each store has its own flow; product codes from links; demo copies on the dummy store', () => {
  assert.deepEqual(RETAILER_DEFS.map((r) => r.id), ['kmart', 'bigw', 'target', 'ebgames', 'zing', 'jbhifi', 'toysrus', 'trainertown', 'amazon', 'thegamescube', 'gamerholic', 'pokemoncenter', 'pbandai', 'citybeach',
    'pokebox', 'goodgames', 'collectiblemadness', 'cherrycollectables', 'gamesmen', 'gamesworld', 'gameology', 'fromthedeep', 'shoplink']);
  for (const r of RETAILER_DEFS) {
    // (A Shop checkout link has no product page to add from: the link is the order, straight to Shop's checkout.)
    assert.ok(r.flow && (r.flow.product || r.cartLinks) && r.flow.checkout, `${r.id} has a flow`);
    assert.ok(r.flow.checkout.final.length, `${r.id} names its final button`);
    assert.ok(['verified', 'beta', 'draft'].includes(r.flowStatus), r.id);
  }
  assert.equal(retailers.get('kmart').flowStatus, 'verified');
  const sku = (u) => retailers.skuFromUrl(u);
  assert.equal(sku('https://www.kmart.com.au/product/pokemon-tcg%3A-30th-celebration-ultra-premium-collection-day-43818648/'), '43818648');
  assert.equal(sku('https://www.ebgames.com.au/product/toys-and-collectibles/312345-one-piece-op18'), '312345');
  assert.equal(sku('https://www.jbhifi.com.au/products/pokemon-tcg-etb'), 'pokemon-tcg-etb');
  assert.equal(sku('https://www.target.com.au/p/pokemon-tcg-booster/71234567'), '71234567');
  // The four added in 1.8.0. Pokémon Center and Premium Bandai: only their Australian stores.
  assert.equal(retailers.forUrl('https://www.thegamescube.com/catalog/one_piece_tcg-one_piece_booster_boxes/one_piece_two_legends_booster_box_op08/695722').id, 'thegamescube');
  assert.equal(sku('https://www.thegamescube.com/catalog/one_piece_tcg-one_piece_booster_boxes/one_piece_two_legends_booster_box_op08/695722'), '695722');
  assert.equal(retailers.forUrl('https://gamerholic.com.au/products/pokemon-tcg-etb').id, 'gamerholic');
  assert.equal(retailers.forUrl('https://www.pokemoncenter.com/en-au/product/10-10447-108/pokemon-tcg-etb').id, 'pokemoncenter');
  assert.equal(sku('https://www.pokemoncenter.com/en-au/product/10-10447-108/pokemon-tcg-etb'), '10-10447-108');
  assert.equal(retailers.forUrl('https://www.pokemoncenter.com/product/10-10447-108/pokemon-tcg-etb'), null, "the US store isn't Pokémon Center Australia");
  assert.equal(retailers.forUrl('https://www.pokemoncenter.com/en-gb/product/10-10447-108/pokemon-tcg-etb'), null, "nor is the UK one");
  const pc = retailers.get('pokemoncenter');
  assert.equal(pc.base, 'https://www.pokemoncenter.com/en-au');
  assert.equal(retailers.searchUrl(pc, '43818648'), 'https://www.pokemoncenter.com/en-au/search/43818648');
  assert.ok(pc.productPath.test('/en-au/product/10-10447-108/pokemon-tcg-etb'));
  assert.ok(!pc.productPath.test('/en-gb/product/10-10447-108/pokemon-tcg-etb') && !pc.productPath.test('/product/10-10447-108/pokemon-tcg-etb'), 'only Australian product pages count in its search results');
  assert.equal(retailers.forUrl('https://p-bandai.com/au/item/N2863373001').id, 'pbandai');
  assert.equal(sku('https://p-bandai.com/au/item/N2863373001'), 'N2863373001');
  assert.equal(retailers.forUrl('https://p-bandai.com/us/item/N2863373001'), null);
  assert.equal(retailers.productUrlFromSku(retailers.get('pbandai'), 'N2863373001'), 'https://p-bandai.com/au/item/N2863373001');
  assert.equal(sku('https://www.bigw.com.au/product/pokemon-tcg/p/6012345'), '6012345');
  assert.equal(sku('https://www.amazon.com.au/dp/B0ABCDEF12'), 'B0ABCDEF12');
  assert.equal(sku('https://shop.example.com/item/9876543'), '9876543');
  assert.equal(retailers.forUrl('https://m.kmart.com.au/product/x-43818648/').id, 'kmart', 'sub-domains');
  assert.equal(retailers.forUrl('https://www.cardshop.example/x'), null);
  assert.equal(retailers.searchUrl(retailers.get('bigw'), '6012345'), 'https://www.bigw.com.au/search?text=6012345');
  assert.equal(retailers.productUrlFromSku(retailers.get('amazon'), 'B0ABCDEF12'), 'https://www.amazon.com.au/dp/B0ABCDEF12');
  // The six added in 1.19.0: four card shops on Shopify, The Gamesmen (Magento), Games World (WooCommerce).
  for (const [id, url, code] of [['pokebox', 'https://www.pokebox.com.au/products/pokemon-tcg-30th-celebration-elite-trainer-box-etb', 'pokemon-tcg-30th-celebration-elite-trainer-box-etb'],
    ['pokebox', 'https://pokebox.com.au/products/x-y', 'x-y'], ['goodgames', 'https://www.goodgames.com.au/products/pokemon-tcg-deck', 'pokemon-tcg-deck'],
    ['collectiblemadness', 'https://collectiblemadness.com.au/products/pokemon-tcg-delta-reign-booster-box', 'pokemon-tcg-delta-reign-booster-box'],
    ['cherrycollectables', 'https://www.cherrycollectables.com.au/products/pokemon-tcg-30th-celebration-elite-trainer-box', 'pokemon-tcg-30th-celebration-elite-trainer-box'],
    ['gamesmen', 'https://www.gamesmen.com.au/pokemon-tcg-mega-evolution-pitch-black-elite-trainer-box', 'pokemon-tcg-mega-evolution-pitch-black-elite-trainer-box'],
    ['gamesworld', 'https://www.gamesworld.com.au/product/one-piece-starter-deck-sabo-st35/', 'one-piece-starter-deck-sabo-st35'],
    // Gameology (1.28.0): its links as its collection pages give them (a member's), and as Shopify's own.
    ['gameology', 'https://www.gameology.com.au/collections/one-piece-booster-boxs/products/one-piece-card-game-op-15-booster-box', 'one-piece-card-game-op-15-booster-box'],
    ['gameology', 'https://gameology.com.au/products/one-piece-card-game-op-15-booster-box?variant=43938378907763', 'one-piece-card-game-op-15-booster-box'],
    // From The Deep Games (1.29.0): its links, with a collection on the way (as its collection pages give them) or not.
    ['fromthedeep', 'https://fromthedeepgames.com.au/products/pokemon-tcg-pitch-black-booster-box-in-store-only-preorder', 'pokemon-tcg-pitch-black-booster-box-in-store-only-preorder'],
    ['fromthedeep', 'https://www.fromthedeepgames.com.au/collections/pokemon-tcg/products/pokemon-tcg-pitch-black-booster-box-in-store-only-preorder?variant=1', 'pokemon-tcg-pitch-black-booster-box-in-store-only-preorder']]) {
    assert.equal(retailers.forUrl(url).id, id, url);
    assert.equal(sku(url), code, url);
  }
  for (const id of ['pokebox', 'goodgames', 'collectiblemadness', 'cherrycollectables', 'gameology', 'fromthedeep']) {
    const r = retailers.get(id);
    assert.equal(r.platform, 'shopify', id);
    assert.equal(r.flow, retailers.get('jbhifi').flow, `${id}: the Shopify flow`);
    assert.equal(retailers.cartUrl(id, { variantId: '123' }), `${r.base}/cart/123:1`);
    // (How many, in Shopify's own cart link: /cart/<variant>:<quantity>.)
    assert.equal(retailers.cartUrl(id, { variantId: '123', qty: 3 }), `${r.base}/cart/123:3`);
  }
  // Every store's quick way to checkout carries how many: Amazon's add link, Games World's add-to-cart link.
  assert.equal(retailers.cartUrl('amazon', { sku: 'B0ABCDEF12', qty: 2 }), 'https://www.amazon.com.au/gp/aws/cart/add.html?ASIN.1=B0ABCDEF12&Quantity.1=2');
  assert.equal(retailers.cartUrl('gamesworld', { variantId: '687010', qty: 4 }), 'https://www.gamesworld.com.au/checkout/?add-to-cart=687010&quantity=4');
  // From The Deep Games: its own address, Shopify's search, its collections read whole (never its singles'), and
  // its Preorders collection as every keyword's second page. Its pages are new to the extension in 1.29.0.
  const ftd = retailers.get('fromthedeep');
  assert.equal(ftd.base, 'https://fromthedeepgames.com.au');
  assert.equal(ftd.acoVersion, '1.29.0');
  assert.equal(retailers.productUrlFromSku(ftd, 'riftbound-vendetta-booster-box'), 'https://fromthedeepgames.com.au/products/riftbound-vendetta-booster-box');
  for (const path of ['/collections/pokemon-tcg/products/x-y', '/products/x-y']) assert.ok(ftd.productPath.test(path), path);
  assert.equal(ftd.productPath.test('/collections/pokemon-tcg'), false, 'a collection page is no product');
  assert.ok(ftd.sweep.collectionSkip.test('Pokemon Singles (All)') && !ftd.sweep.collectionSkip.test('Pokemon TCG Sealed'));
  assert.ok(ftd.sweep.collectionPrefer.test('Pokemon TCG Sealed') && !ftd.sweep.collectionPrefer.test('Pokemon TCG Preorders'));
  assert.equal(ftd.sweep.feedPath, '/collections/preorders/products.json?limit=250');
  // Gameology: a product page with a collection on the way or without; a collection page isn't one. Its pages
  // are new to the extension in 1.28.0, so an older copy is never sent there.
  for (const path of ['/collections/one-piece-booster-boxs/products/one-piece-card-game-op-15-booster-box', '/products/one-piece-card-game-op-15-booster-box']) assert.ok(retailers.get('gameology').productPath.test(path), path);
  assert.equal(retailers.get('gameology').productPath.test('/collections/one-piece-booster-boxs'), false);
  assert.equal(retailers.get('gameology').acoVersion, '1.28.0');
  assert.equal(retailers.productUrlFromSku(retailers.get('gameology'), 'one-piece-card-game-op-15-booster-box'), 'https://www.gameology.com.au/products/one-piece-card-game-op-15-booster-box');
  assert.ok(retailers.get('gamesmen').productPath.test('/pokemon-tcg-scarlet-violet-151-elite-trainer-box'));
  assert.ok(!retailers.get('gamesmen').productPath.test('/checkout/cart/') && !retailers.get('gamesmen').productPath.test('/pokemon'), "Magento's other pages aren't products");
  assert.equal(retailers.productUrlFromSku(retailers.get('gamesmen'), 'pokemon-tcg-etb-box'), 'https://www.gamesmen.com.au/pokemon-tcg-etb-box');
  assert.equal(retailers.cartUrl('gamesworld', { variantId: '687010' }), 'https://www.gamesworld.com.au/checkout/?add-to-cart=687010&quantity=1', "WooCommerce's add-to-cart link, straight to checkout");
  assert.equal(retailers.cartUrl('gamesworld', {}), null, 'none without the product\'s id');
  const gm = retailers.get('gamesmen').flow.checkout;
  assert.ok(gm.path.test('/checkout/') && gm.path.test('/onestepcheckout/') && !gm.path.test('/checkout/cart/'), "its checkout, not its cart");

  const demo = new Retailers({ demoStoreUrl: 'http://localhost:5055' });
  const dk = demo.forUrl('http://127.0.0.1:5055/kmart/product/x-43818648/');
  assert.equal(dk.id, 'demo-kmart');
  assert.equal(dk.flow, retailers.get('kmart').flow, 'the same flow as the real store');
  assert.equal(demo.forUrl('http://localhost:5055/bigw/product/x/p/1').id, 'demo-bigw');
  assert.equal(demo.forUrl('http://localhost:5055/'), null, 'the control panel is no store');
  assert.equal(demo.forUrl('https://www.kmart.com.au/product/x-43818648/').id, 'kmart');

  // Flows travel as JSON: regular expressions become { re, f } and survive the trip.
  const ext = JSON.parse(JSON.stringify(retailers.forExtension()));
  const k = ext.find((r) => r.id === 'kmart');
  assert.deepEqual(k.flow.checkout.final[0], { re: '\\bcheck ?out securely\\b', f: 'i' });
  assert.ok(new RegExp(k.flow.checkout.final[0].re, k.flow.checkout.final[0].f).test('Checkout securely'));
  assert.deepEqual(serialize({ a: [/x/g], b: 1, c: undefined }), { a: [{ re: 'x', f: 'g' }], b: 1 });
  // An admin switch hides a store.
  const off = new Retailers({ demoStoreUrl: '' }, (k2) => (k2 === 'retailer:target' ? { enabled: false } : null));
  assert.ok(!off.forExtension().some((r) => r.id === 'target'));
  assert.ok(!off.publicList().some((r) => r.id === 'target'));
});

test('input checks: usernames, SKUs by link or by store, delivery details, alerts', () => {
  assert.equal(username('  Ash.K_99 '), 'ash.k_99');
  for (const bad of ['a', 'with space', '.dot', 'admin', 'x'.repeat(30)]) assert.throws(() => username(bad), bad);
  const byLink = item({ url: 'https://www.kmart.com.au/product/x-43000001/#frag', quantity: 99, price: '12.5' }, { retailers });
  assert.deepEqual([byLink.store, byLink.sku, byLink.quantity, byLink.price, byLink.url], ['kmart', '43000001', 10, 12.5, 'https://www.kmart.com.au/product/x-43000001/']);
  // How many: 1 unless you say (a whole number, 1 to 10).
  assert.equal(item({ url: 'https://www.kmart.com.au/product/x-43000001/' }, { retailers }).quantity, 1, 'one unless you say');
  for (const [q, want] of [[3, 3], ['2', 2], [0, 1], [-4, 1], [2.4, 2], ['', 1], [null, 1], [10, 10], [11, 10]]) {
    assert.equal(item({ url: 'https://www.kmart.com.au/product/x-43000001/', quantity: q }, { retailers }).quantity, want, `quantity ${JSON.stringify(q)}`);
  }
  assert.equal(item({ name: 'Renamed' }, { retailers, existing: { ...byLink, quantity: 4 } }).quantity, 4, 'an edit that doesn\'t say keeps it');
  // A Shop checkout link with one product in it: the link's own number, unless you say — then the link says it too.
  const shopLink = (url, extra = {}) => item({ url, ...extra }, { retailers });
  const one = shopLink('https://creations.mattel.com/cart/48835830579405:2');
  assert.deepEqual([one.quantity, one.url, one.sku], [2, 'https://creations.mattel.com/cart/48835830579405:2', '48835830579405:2'], 'the link\'s own 2');
  const three = shopLink('https://creations.mattel.com/cart/48835830579405:2', { quantity: 3 });
  assert.deepEqual([three.quantity, three.url, three.sku], [3, 'https://creations.mattel.com/cart/48835830579405:3', '48835830579405:3'], 'you said 3: the link changed to it');
  assert.equal(shopLink('https://creations.mattel.com/cart/48835830579405:1', { quantity: '' }).quantity, 1, 'an empty box: the link\'s');
  // (Several products: each as the link has it — the item's quantity 1, the link left alone.)
  const two = shopLink('https://creations.mattel.com/cart/48835830579405:2,40653613531341:1', { quantity: 5 });
  assert.deepEqual([two.quantity, two.url], [1, 'https://creations.mattel.com/cart/48835830579405:2,40653613531341:1']);
  const bySku = item({ store: 'bigw', sku: '6012345' }, { retailers });
  assert.deepEqual([bySku.store, bySku.sku, bySku.url], ['bigw', '6012345', ''], 'found by the monitor later');
  assert.equal(item({ store: 'jbhifi', sku: 'pokemon-etb' }, { retailers }).url, 'https://www.jbhifi.com.au/products/pokemon-etb', 'Shopify link from the handle');
  assert.throws(() => item({ store: 'bigw' }, { retailers }), /product code/i);
  assert.throws(() => item({ url: 'javascript:alert(1)', sku: '1' }, { retailers }));
  assert.throws(() => item({ url: 'https://user:pw@example.com/p/1' }, { retailers }));
  assert.equal(item({ url: 'https://shop.example.com/products/op-18-box' }, { retailers }).store, 'other');
  assert.equal(item({ url: 'https://www.kmart.com.au/product/x-1234567/', announce: true }, { retailers }).announce, false, 'members can\'t announce');
  assert.equal(item({ url: 'https://www.kmart.com.au/product/x-1234567/', announce: true }, { retailers, isAdmin: true }).announce, true);
  assert.equal(profile({ state: 'new south wales', postcode: '2000' }).state, 'NSW');
  assert.throws(() => profile({ postcode: '20000' }));
  assert.throws(() => profile({ state: 'XX' }));
  const set = profiles({ profiles: [{ label: 'Home' }, { label: 'Work' }], defaultId: 'nope' });
  assert.equal(set.defaultId, set.profiles[0].id, 'default falls back to the first');
  assert.throws(() => profiles({ profiles: [] }));
  assert.throws(() => profiles({ profiles: Array.from({ length: 6 }, () => ({})) }, 5), /up to 5/);
  assert.throws(() => alerts({ discordWebhook: 'https://discord.com.evil.example/api/webhooks/1/x' }));
  assert.equal(alerts({ discordMention: '@everyone hi' }).discordMention, 'everyone hi', 'no mass mentions');
  assert.equal(alerts({}).browserChecks, true);
});

test('Auto-checkout: switched on only once agreed, limits within bounds; an armed item needs a max price and a store with a checkout', () => {
  assert.equal(acoSettings({}, DEFAULT_ACO).enabled, false, 'off until switched on');
  assert.throws(() => acoSettings({ enabled: true }, DEFAULT_ACO), /agree/i);
  const on = acoSettings({ enabled: true, agree: true, mode: 'fill', maxOrder: 'lots', perDay: 0, spendPerDay: 1e9 }, DEFAULT_ACO, 1000);
  assert.deepEqual(on, { enabled: true, agreedAt: 1000, mode: 'fill', maxOrder: 400, perDay: 1, spendPerDay: 20000, signedInOnly: false, remoteBuy: true, deviceId: '' });
  // Discord's ⚡ Buy on your computer: on unless switched off; the checkout browser, an ID or none.
  assert.equal(acoSettings({ remoteBuy: false }, on).remoteBuy, false);
  assert.equal(acoSettings({ deviceId: 'dev_abc-123' }, on).deviceId, 'dev_abc-123');
  assert.equal(acoSettings({ deviceId: '"><script>' }, on).deviceId, '', 'only an ID');
  assert.equal(acoSettings({ enabled: true }, { ...on, enabled: false }, 2000).agreedAt, 1000, 'agreed once is enough');
  assert.equal(acoSettings({ mode: 'buy everything', agreedAt: 5 }, on).mode, 'place', 'only place or fill');
  assert.equal(acoSettings({ agreedAt: 5 }, DEFAULT_ACO).agreedAt, null, "the agreement isn't taken from the request");
  const url = 'https://www.kmart.com.au/product/x-43000001/';
  assert.equal(item({ url }, { retailers }).aco, false);
  assert.throws(() => item({ url, aco: true }, { retailers }), /max price/i);
  assert.deepEqual([item({ url, aco: true, maxPrice: '99' }, { retailers }).aco, item({ url, aco: true, maxPrice: '99' }, { retailers }).maxPrice], [true, 99]);
  assert.throws(() => item({ url: 'https://shop.example.com/products/op-18-box', aco: true, maxPrice: 5 }, { retailers }), /checkout for/i);
  const armed = item({ url, aco: true, maxPrice: 99 }, { retailers });
  assert.equal(item({ name: 'Renamed' }, { retailers, existing: armed }).aco, true, 'an edit keeps it armed');
  assert.throws(() => item({ maxPrice: null }, { retailers, existing: armed }), /max price/i, "an armed item's max can't be cleared");
});

test('membership labels', () => {
  const now = Date.now();
  assert.equal(entitlement({ plan: 'none' }, now).active, false);
  assert.equal(entitlement({ plan: 'active' }, now).label, 'Member');
  assert.match(entitlement({ plan: 'active', cancel_at_period_end: 1, current_period_end: now + 86400000 }, now).label, /Member \(ends /);
  assert.equal(entitlement({ plan: 'past_due' }, now).warning, true);
  assert.equal(entitlement({ plan: 'trial', trial_ends_at: now + 2 * 86400000 }, now).label, 'Free trial — 2 days left');
  assert.equal(entitlement({ plan: 'trial', trial_ends_at: now - 1 }, now).active, false);
  assert.equal(entitlement({ plan: 'canceled', role: 'admin' }, now).active, true);
});

test('Whop webhook signatures (Standard Webhooks): the right secret, the right body, recent, any of several signatures', () => {
  const secret = 'ws_abc123';
  const w = new Whop({ cfg: { whop: { webhookSecret: secret } }, repo: {}, notifier: {}, discord: {} });
  const body = Buffer.from('{"type":"membership.activated"}');
  const ts = Math.floor(Date.now() / 1000);
  const sig = signWebhook(secret, 'msg_1', ts, body);
  assert.equal(sig, crypto.createHmac('sha256', Buffer.from(secret)).update(`msg_1.${ts}.${body}`).digest('base64'), 'HMAC-SHA256 over id.timestamp.body, base64');
  const h = (s, t = ts, id = 'msg_1') => ({ 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': s });
  assert.equal(w.verify(body, h(`v1,${sig}`)), 'msg_1');
  assert.equal(w.verify(body, h(`v1,bm9wZQ== v1,${sig}`)), 'msg_1', 'several signatures (key rotation)');
  assert.throws(() => w.verify(Buffer.from('{"type":"x"}'), h(`v1,${sig}`)), /Bad signature/);
  assert.throws(() => w.verify(body, h(`v1,${sig}`, ts, 'msg_2')), /Bad signature/);
  assert.throws(() => w.verify(body, h(`v1,${sig}`, ts - 3600)), /too old/);
  assert.throws(() => w.verify(body, {}), /Missing signature/);
  // A "whsec_" secret (Standard Webhooks' own format) is base64-decoded.
  const std = `whsec_${Buffer.from('raw-key-bytes').toString('base64')}`;
  const w2 = new Whop({ cfg: { whop: { webhookSecret: std } }, repo: {}, notifier: {}, discord: {} });
  const sig2 = crypto.createHmac('sha256', Buffer.from('raw-key-bytes')).update(`msg_1.${ts}.${body}`).digest('base64');
  assert.equal(w2.verify(body, h(`v1,${sig2}`)), 'msg_1');
});

test('Discord interaction signatures (Ed25519)', () => {
  const keys = interactionKeys();
  const body = Buffer.from('{"type":1}');
  const ts = '1700000000';
  const sig = keys.sign(ts, body.toString());
  assert.equal(verifyDiscordSignature(keys.publicKey, sig, ts, body), true);
  assert.equal(verifyDiscordSignature(keys.publicKey, sig, '1700000001', body), false);
  assert.equal(verifyDiscordSignature(keys.publicKey, sig, ts, Buffer.from('{"type":2}')), false);
  assert.equal(verifyDiscordSignature(interactionKeys().publicKey, sig, ts, body), false, 'another app\'s key');
  assert.equal(verifyDiscordSignature('zz', sig, ts, body), false);
});

test('rate limiter and cookies', () => {
  let t = 0;
  const rl = new RateLimiter(() => t);
  assert.equal(rl.hit('k', 2, 1000), true);
  assert.equal(rl.hit('k', 2, 1000), true);
  assert.equal(rl.hit('k', 2, 1000), false);
  t = 1001;
  assert.equal(rl.hit('k', 2, 1000), true, 'new window');
  assert.deepEqual(parseCookies('a=1; b=x%20y; a=2'), { a: '1', b: 'x y' });
});

function unzip(buf) {
  const files = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const crc = buf.readUInt32LE(i + 14);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString();
    const data = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    const out = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.equal(zlib.crc32(out), crc, `crc of ${name}`);
    files[name] = out;
    i += 30 + nameLen + extra + size;
  }
  return files;
}

test('zip writer round-trips', () => {
  const zip = makeZip([{ name: 'a/hello.txt', data: 'hello world' }, { name: 'a/lib/b.bin', data: crypto.randomBytes(5000) }]);
  const files = unzip(zip);
  assert.equal(files['a/hello.txt'].toString(), 'hello world');
  assert.equal(files['a/lib/b.bin'].length, 5000);
});

test('extension built for a live server: only that server and the stores; module worker with the shared page reader', async () => {
  const cfg = loadConfig({ baseUrl: 'https://app.mugibot.example', dataKey: crypto.randomBytes(32) });
  const m = extensionManifest(cfg);
  assert.equal(m.manifest_version, 3);
  assert.equal(m.background.type, 'module');
  assert.deepEqual(m.permissions, ['storage', 'alarms', 'scripting'], 'no tabs/history/cookies permissions (scripting: reading the page an admin\'s browser opens for a live sweep)');
  assert.ok(m.host_permissions.includes('https://ac.cnstrc.com/*'), "Kmart's search provider, for an admin's browser sweeping Kmart");
  assert.equal(m.host_permissions[0], 'https://app.mugibot.example/*');
  assert.ok(m.host_permissions.includes('https://www.kmart.com.au/*'), 'stores (for in-browser checks)');
  assert.deepEqual(m.optional_host_permissions, ['https://*/*'], "other websites: only asked for (one website at a time, by its owner pressing Allow) when a drop watch there refuses the server");
  for (const h of ['https://www.thegamescube.com/*', 'https://gamerholic.com.au/*', 'https://www.pokemoncenter.com/*', 'https://p-bandai.com/*']) assert.ok(m.host_permissions.includes(h), h);
  assert.ok(m.content_scripts.some((cs) => cs.all_frames && cs.matches.includes('https://*.global-e.com/*') && cs.js.includes('frame.js')), "Premium Bandai's checkout, in Global-e's frame");
  assert.ok(!JSON.stringify(m).includes('127.0.0.1'), 'no local addresses in a live build');
  const by = (f) => m.content_scripts.find((c) => c.js.includes(f));
  assert.deepEqual(by('bridge.js').matches, ['https://app.mugibot.example/*']);
  assert.equal(by('capture.js').run_at, 'document_start');
  assert.deepEqual(by('content.js').js, ['flows.js', 'core.js', 'fill.js', 'checks.js', 'logins.js', 'bag.js', 'content.js']);
  assert.equal(by('frame.js').all_frames, true);
  assert.deepEqual(by('frame.js').js, ['flows.js', 'fill.js', 'checks.js', 'frame.js'], 'the same Auto-checkout checks in a checkout frame');
  // The card boxes' hosts: Shopify's card fields (JB Hi-Fi, Toys"R"Us…), Target's Paydock and its gateway.
  for (const h of ['https://checkout.pci.shopifyinc.com/*', 'https://*.paydock.com/*', 'https://ap-gateway.mastercard.com/*']) assert.ok(by('frame.js').matches.includes(h), h);
  // Toys"R"Us lives at toysrus.com.au (www. sends you there).
  assert.ok(m.host_permissions.includes('https://toysrus.com.au/*') && by('content.js').matches.includes('https://toysrus.com.au/*'), 'Toys"R"Us without www');

  const files = extensionFiles(cfg);
  const names = files.map((f) => f.name);
  const needed = new Set([m.background.service_worker, m.action.default_popup, m.options_page, ...Object.values(m.icons), ...m.content_scripts.flatMap((c) => c.js), 'config.js', 'vault.js', 'lib/extract.js', 'lib/html.js', 'lib/status.js']);
  for (const n of needed) assert.ok(names.includes(n), `${n} is in the package`);
  const config = files.find((f) => f.name === 'config.js').data.toString();
  const ctx = { globalThis: {} };
  vm.runInNewContext(config, ctx);
  assert.equal(ctx.globalThis.MGB_CONFIG.server, 'https://app.mugibot.example');
  const classic = files.filter((x) => x.name.endsWith('.js') && !x.name.startsWith('lib/') && x.name !== 'background.js');
  for (const f of classic) assert.doesNotThrow(() => new vm.Script(f.data.toString(), { filename: f.name }), `${f.name} parses`);
  for (const f of files.filter((x) => x.name.startsWith('lib/') || x.name === 'background.js')) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: f.data });
    assert.equal(r.status, 0, `${f.name} parses as a module: ${r.stderr}`);
  }
  // The page reader in the extension is the server's own: it reads a product page the same way.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-ext-'));
  try {
    writeExtension(cfg, dir);
    const { extractProduct } = await import(pathToFileURL(path.join(dir, 'lib', 'extract.js')).href);
    const r = extractProduct('<script type="application/ld+json">{"@type":"Product","name":"UPC","offers":{"availability":"https://schema.org/InStock","price":"360"}}</script>');
    assert.equal(r.status, 'in_stock');
    assert.equal(r.price, 360);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("store login monitor: each store's page says whether you're signed in (Shopify, CrystalCommerce, Premium Bandai, Amazon)", () => {
  const ctx = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../extension/logins.js', import.meta.url), 'utf8'), ctx);
  const { fromHtml } = ctx.globalThis.MGBLogins;
  // As the extension gets them: through JSON, the RegExps as { re, f }.
  const check = (id) => JSON.parse(JSON.stringify(serialize(RETAILER_DEFS.find((r) => r.id === id).account.check)));
  const shopify = (cid) => `<script>var __st={"a":1,"offset":36000,"u":"x","p":"home"${cid ? ',"cid":12345' : ''}};</script>`;
  for (const id of ['jbhifi', 'trainertown', 'gamerholic', 'toysrus', 'pokebox', 'goodgames', 'collectiblemadness', 'cherrycollectables', 'gameology']) {
    assert.equal(fromHtml(shopify(true), 'https://x/', check(id)), 'in', id);
    assert.equal(fromHtml(shopify(false), 'https://x/', check(id)), 'out', id);
  }
  assert.equal(fromHtml('<html>nothing to go on</html>', 'https://x/', check('jbhifi')), null, "can't tell: says nothing");
  assert.equal(fromHtml('<body class="front not-logged-in"><a href="/user/login">Login</a>', '', check('thegamescube')), 'out');
  assert.equal(fromHtml('<body class="front logged-in"><a href="/user/logout">Logout</a>', '', check('thegamescube')), 'in');
  assert.equal(fromHtml('<script>USER_DATA = {"csrfToken":"x","loggedInMember":{"memberNo":"1"}}</script>', '', check('pbandai')), 'in');
  assert.equal(fromHtml('<script>USER_DATA = {"csrfToken":"x","loggedInMember":null}</script>', '', check('pbandai')), 'out');
  assert.equal(fromHtml('<form name="signIn">', 'https://www.amazon.com.au/ap/signin?openid.return_to=x', check('amazon')), 'out', 'sent to the sign-in page');
  assert.equal(fromHtml('<span id="nav-link-accountList-nav-line-1" class="nav-line-1">Hello, Jamie</span>', 'https://www.amazon.com.au/gp/css/homepage.html', check('amazon')), 'in');
  assert.equal(fromHtml('<span id="nav-link-accountList-nav-line-1" class="nav-line-1">Hello, sign in</span>', 'https://www.amazon.com.au/gp/css/homepage.html', check('amazon')), null);
  // Magento's "who's signed in" (The Gamesmen), WordPress's "logged-in" (Games World).
  assert.equal(fromHtml('{"customer":{"fullname":"Ash Ketchum","firstname":"Ash","data_id":1}}', '', check('gamesmen')), 'in');
  assert.equal(fromHtml('{"customer":{"data_id":1}}', '', check('gamesmen')), 'out');
  assert.equal(fromHtml('<body class="page woocommerce-account logged-in">', '', check('gamesworld')), 'in');
  assert.equal(fromHtml('<body class="page woocommerce-account">', '', check('gamesworld')), 'out');
  // Stores whose pages don't say so: the page you open (its header) instead.
  for (const id of ['kmart', 'bigw', 'target', 'ebgames', 'zing', 'pokemoncenter']) {
    const r = RETAILER_DEFS.find((x) => x.id === id);
    assert.ok(r.account && !r.account.check, `${id}: from the page`);
  }
});

test('extension built for a server on your computer also runs on the dummy store there', () => {
  const cfg = loadConfig({ baseUrl: 'http://127.0.0.1:8080', dataKey: crypto.randomBytes(32), demoStoreUrl: 'http://localhost:5055' });
  const m = extensionManifest(cfg);
  assert.ok(m.host_permissions.includes('http://127.0.0.1/*'));
  assert.ok(m.host_permissions.includes('http://localhost/*'));
  const content = m.content_scripts.find((c) => c.js.includes('content.js'));
  assert.ok(content.matches.includes('http://localhost/*'));
  assert.deepEqual(content.exclude_matches, ['http://127.0.0.1:8080/*'], 'but not on the dashboard itself');
});

test('extension works on every address of the site (a new domain and the old fly.dev one)', () => {
  const cfg = loadConfig({ baseUrl: 'https://mugibot.example', extraOrigins: 'https://mugibot-live.fly.dev', dataKey: crypto.randomBytes(32) });
  const m = extensionManifest(cfg);
  const bridge = m.content_scripts.find((c) => c.js.includes('bridge.js'));
  assert.deepEqual(bridge.matches, ['https://mugibot.example/*', 'https://mugibot-live.fly.dev/*'], 'the dashboard sees the extension on either address');
  assert.ok(m.host_permissions.includes('https://mugibot-live.fly.dev/*'));
  const ctx = { globalThis: {} };
  vm.runInNewContext(extensionFiles(cfg).find((f) => f.name === 'config.js').data.toString(), ctx);
  assert.equal(ctx.globalThis.MGB_CONFIG.server, 'https://mugibot.example', 'talks to the main address');
  assert.deepEqual([...ctx.globalThis.MGB_CONFIG.appOrigins], ['https://mugibot.example', 'https://mugibot-live.fly.dev']);
  assert.equal(extensionManifest(cfg, { version: '0.9.0' }).version, '0.9.0', 'tests can build an older version');
});

test('production refuses to start without an encryption key', () => {
  assert.throws(() => loadConfig({ env: 'production' }, {}), /DATA_ENCRYPTION_KEY/);
  assert.throws(() => loadConfig({}, { DATA_ENCRYPTION_KEY: 'too-short' }), /32 bytes/);
  const cfg = loadConfig({}, { NODE_ENV: 'production', DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), BASE_URL: 'https://x.example' });
  assert.equal(cfg.secureCookies, true);
  assert.equal(cfg.discord.linkButtons, true, 'Discord buttons on an https address');
  assert.equal(cfg.trialDays, 0, 'no free trial unless you set TRIAL_DAYS');
  assert.equal(cfg.priceDisplay, 'A$19.99 / month');
});

test('the buy button by its words, the same at every store: "Add to cart", "Add to basket", "Pre-order", "Buy now", "Buy"… — never a wish list, paying later or a wallet; the extension keeps the same list', async () => {
  const { ADD_WORDS, NOT_ADD, isAddLabel } = await import('../server/monitor/words.js');
  const { classifyActionText } = await import('../server/monitor/extract.js');
  for (const t of ['Add to cart', 'ADD TO CART', 'Add to Basket', 'Add To Bag', 'Add to trolley', 'Add to my cart', 'Add to shopping cart', 'Pre-order', 'Pre-order now', 'PLACE PRE-ORDER', 'Pre Order', 'Preorder', 'Buy now', 'Buy it now', 'BUY', 'Order now', 'Purchase now', 'Add']) {
    assert.ok(isAddLabel(t), t);
  }
  for (const t of ['Add to wishlist', 'Add to wish list', 'Add to compare', 'Buy now, pay later', 'Buy with Shop Pay', 'Buy with PayPal', 'Buy now with Afterpay', 'Notify me', 'Reserve in store', 'Click & Collect', 'Buy a gift card', 'Checkout', 'Pay now', 'Add a protection plan']) {
    assert.ok(!isAddLabel(t), t);
  }
  assert.equal(classifyActionText('Add to Basket'), 'in_stock');
  assert.equal(classifyActionText('Buy'), 'in_stock');
  assert.equal(classifyActionText('Pre Order'), 'preorder');
  // Every store's flow: the same words, in the same order (Amazon's "Buy Now" is its own straight-to-checkout button too).
  for (const r of RETAILER_DEFS.filter((x) => !x.cartLinks)) assert.equal(r.flow.product.addSelector || r.flow.product.add === ADD_WORDS ? true : r.flow.product.add, true, `${r.id}: the shared add words`);
  // extension/core.js has its own copy (a classic script): the same words, in the same order.
  const core = fs.readFileSync(new URL('../extension/core.js', import.meta.url), 'utf8');
  const list = core.match(/var ADD_WORDS = \[([\s\S]*?)\];/)[1].trim().split(/,\s*\n\s*/).map((x) => x.replace(/,$/, '').trim());
  assert.deepEqual(list, ADD_WORDS.map(String));
  assert.equal(core.match(/var NOT_ADD = (\/.*\/i);/)[1], String(NOT_ADD));
});


test("Target's own page data beats its JSON-LD: a pre-order with neither home delivery nor click & collect (\"Add To Basket\" greyed out) is out of stock, though its JSON-LD says InStock; one with them is in stock; the greyed-out button Target draws on every page counts for nothing", () => {
  // (As Target's real pages are, Oct 2026: every Add To Basket drawn greyed out, and turned on by Target's
  //  own code from product.deliveryModes in __NEXT_DATA__.)
  const page = (modes, name) => `<html><head><script type="application/ld+json">{"@context":"https://schema.org/","@type":"Product","name":"${name}","sku":"73528173","offers":{"@type":"Offer","price":"360","availability":"https://schema.org/InStock","priceCurrency":"AUD"}}</script></head><body>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { product: { code: '73528173', name, deliveryModes: modes } } } })}</script>
    <h1>${name}</h1><button cursor="select" aria-disabled="true" data-visual-disabled="true" data-testid="add-to-cart-button"><style>.css-x{color:#fff}</style><p>Add To Basket</p></button></body></html>`;
  const off = { clickAndCollect: { available: false }, homeDelivery: { available: false }, expressDelivery: { available: true } };
  const on = { clickAndCollect: { available: true }, homeDelivery: { available: true }, expressDelivery: { available: true } };
  const greyed = extractProduct(page(off, 'Pre-Order Pokemon TCG: 30th Celebration Ultra-Premium Collection - Night'));
  assert.deepEqual([greyed.status, greyed.decidedBy, greyed.price], ['out_of_stock', 'store-data', 360]);
  const buyable = extractProduct(page(on, 'Pokemon 30th Anniversary Battle Figure Multipack'));
  assert.deepEqual([buyable.status, buyable.decidedBy], ['in_stock', 'json-ld']);
  // Click & collect only (or home delivery only): it can be ordered.
  assert.equal(extractProduct(page({ ...off, clickAndCollect: { available: true } }, 'C&C only')).status, 'in_stock');
});

test("the Riot Games Store's page (Next.js, its page streamed hidden and its buy button drawn by its code): read from its own page data — coming soon, then in stock or a pre-order the moment it's on sale, sold out once it's gone", () => {
  // (As merch.riotgames.com's pages were, Oct 2026: the page in <div hidden id="S:0">, a "Notify Me" in an overlay its
  //  code shows, no "Add to Cart" in the HTML; the data in self.__next_f.push([1, "…"]) — another product's first.)
  const page = ({ availability, isPreorder = false, labels = [{ label: 'Coming Soon', showOnlyWhenUnavailable: null }], variants = '$undefined', dropAt = null, slug = 'riftbound-kda-couture-collection' }) => {
    const rows = [
      `5:["$","$L19",null,${JSON.stringify({ product: { title: 'Riftbound: Origins Booster Display', slug: 'riftbound-origins-booster-display', isPreorder: false }, trackingEvent: { event: 'view_item', product: { availability: 'inStock' } } })}]\n`,
      `7:["$","$L1b",null,{"children":[["$","$L1d",null,{"id":"page-tracker","trackingEvent":{"event":"pageview","product":${JSON.stringify({ name: 'Riftbound: K/DA Premium Collection', sku: 'RB3865-00-00', price: { amount: 150, currencyCode: 'USD' }, availability, category: '' })}}}],`,
      `["$","$L1e",null,{"product":${JSON.stringify({ title: 'Riftbound x K/DA: Couture Collection', sku: 'RB3865-00-00', slug, productType: 'simple', dropAt, isPreorder, variants, productDisplayMessages: labels.map((l) => ({ color: 'blue', displayType: 'above-title', showOnProductDetails: true, ...l })) })}}]]}]\n`,
    ];
    return `<html><head><title>Riftbound x K/DA: Couture Collection | Riot Games Store</title></head><body><div hidden id="S:0"><h1>Riftbound x K/DA: Couture Collection</h1>
      <div class="add-to-cart-panel_overlay" aria-hidden="true"><button type="button">Notify Me</button></div></div>
      ${rows.map((r) => `<script>self.__next_f.push([1,${JSON.stringify(r).replace(/</g, '\\u003c')}])</script>`).join('')}</body></html>`;
  };
  const url = 'https://merch.riotgames.com/en-us/product/riftbound-kda-couture-collection/';
  const read = (o) => extractProduct(page(o), { url });
  // Not on sale yet, labelled "Coming Soon": coming soon (not "Checking…" for ever), with its price.
  const soon = read({ availability: 'outOfStock' });
  assert.deepEqual([soon.status, soon.decidedBy, soon.price, soon.currency], ['coming_soon', 'store-data', 150, 'USD']);
  assert.match(soon.signals[0].detail, /"outOfStock".*"Coming Soon"/);
  // On sale: in stock — or a pre-order (T1's Signature Edition: isPreorder), however its tracking says it.
  assert.equal(read({ availability: 'inStock' }).status, 'in_stock');
  assert.equal(read({ availability: 'inStock', isPreorder: true }).status, 'preorder');
  assert.equal(read({ availability: 'preOrder' }).status, 'preorder');
  // Not on sale with no "Coming Soon" label (its "Retired", shown only while it's unavailable): sold out.
  assert.equal(read({ availability: 'outOfStock', labels: [{ label: 'Retired', showOnlyWhenUnavailable: true }] }).status, 'out_of_stock');
  // …and a drop time ahead: coming soon.
  assert.equal(read({ availability: 'outOfStock', labels: [], dropAt: new Date(Date.now() + 86400000).toISOString() }).status, 'coming_soon');
  // In stock, its "Retired" label (shown only when it's unavailable) isn't what it says.
  assert.doesNotMatch(read({ availability: 'inStock', labels: [{ label: 'Retired', showOnlyWhenUnavailable: true }] }).signals[0].detail, /Retired/);
  // No page view's availability: its options' availableForSale (Shopify's) instead.
  const noTracker = (av) => page({ availability: 'x', variants: [{ availableForSale: av }] }).replace('"availability":"x"', '"avail":"x"');
  assert.deepEqual([extractProduct(noTracker(true), { url }).status, extractProduct(noTracker(false), { url }).status], ['in_stock', 'coming_soon']);
  // Another page of the store (its product's not there by its link): the page view's still the page's own.
  assert.equal(extractProduct(page({ availability: 'inStock', slug: 'something-else' }), { url }).status, 'in_stock');
  // The other product on the page (in stock) never counts for this one.
  assert.equal(read({ availability: 'outOfStock' }).status, 'coming_soon');
});

test("another website's answer for a drop watch is read the same from the server and from a browser", () => {
  assert.equal(siteUrl('https://shop.example/', 'xbox series x', 'search'), 'https://shop.example/search?q=xbox%20series%20x');
  assert.match(siteUrl('https://shop.example', 'xbox', 'suggest'), /^https:\/\/shop\.example\/search\/suggest\.json\?q=xbox&resources%5Btype%5D=product/);
  assert.equal(siteUrl('https://shop.example/new?x=1', 'xbox', 'page'), 'https://shop.example/new?x=1');
  const refused = siteAnswer({ way: 'search', status: 403, by: 'your browser' });
  assert.deepEqual([refused.ok, refused.refused], [false, true]);
  assert.match(refused.error, /refused your browser \(HTTP 403\)/);
  assert.match(siteAnswer({ way: 'search', status: 429 }).error, /refused Mugibot/);
  assert.equal(siteAnswer({ way: 'search', status: 500 }).refused, undefined);
  assert.equal(siteAnswer({ way: 'suggest', status: 200, type: 'text/html', text: '<html></html>' }).error, 'Not a Shopify shop');
  const suggest = siteAnswer({ way: 'suggest', status: 200, type: 'application/json', url: 'https://shop.example/search/suggest.json', text: JSON.stringify({ resources: { results: { products: [{ handle: 'xbox-x', title: 'Xbox Series X', url: '/products/xbox-x', price: '799.00', available: true }] } } }) });
  assert.equal(suggest.ok, true);
  assert.deepEqual(suggest.products.map((p) => [p.title, p.url]), [['Xbox Series X', 'https://shop.example/products/xbox-x']]);
  const page = siteAnswer({ way: 'search', status: 200, type: 'text/html', url: 'https://shop.example/search?q=xbox', text: '<html><body><main><ul><li class="product-card"><a href="/products/xbox-x">Xbox Series X</a> <span class="price">$799.00</span></li></ul></main></body></html>' });
  assert.equal(page.ok, true);
  assert.equal(page.products[0].title, 'Xbox Series X');
  assert.deepEqual(siteAnswer({ way: 'search', status: 200, type: 'text/html', text: '<html><body><p>No results</p></body></html>' }), { ok: true, products: [] }, 'nothing with those words yet: fine');
  const bot = siteAnswer({ way: 'page', status: 200, type: 'text/html', text: '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing. Verify you are human.</body></html>' });
  assert.equal(bot.refused, true, 'a bot check instead of the page');
});

test("Auto-checkout's read of a store's answer to its final button (extension/checks.js): a decline, anything about the payment or a human check, or words it doesn't know — never pressed past; still at it — waited for; a box it says is wrong — filled in again; the store plainly struggling — pressed again, a little later each time, for up to 30 minutes; a card the store has for you, as EB Games shows it (and not a \"Loading...\" next to a year)", () => {
  const ctx = {};
  vm.runInNewContext(`${fs.readFileSync(new URL('../extension/checks.js', import.meta.url), 'utf8')}\nthis.MGBChecks = MGBChecks;`, ctx);
  const C = ctx.MGBChecks;
  const kinds = {
    'Your card was declined. Please try another card.': 'declined',
    'Payment failed. Please use a different payment method.': 'declined',
    'Insufficient funds': 'declined',
    // Never pressed past: the payment, the card, your bank, a human check.
    'Your payment could not be authenticated': 'stop',
    "We couldn't process your payment": 'stop',
    'Payment was refused by your bank': 'stop',
    'Transaction not approved': 'stop',
    "Your card's security code is incorrect": 'stop',
    'Please verify you are human': 'stop',
    'Captcha verification failed. Try again.': 'stop',
    'Something went wrong with your payment. Please try again.': 'stop',
    '"Card number" needs attention': 'stop',
    // Still at it: waited for.
    'Please wait while we process your payment': 'working',
    'Processing your order…': 'working',
    'Processing your order — please do not refresh or try again': 'working',
    'There was a problem processing your payment': 'stop',
    // A box it says is wrong: filled in again.
    'Please enter a valid postcode': 'field',
    'Phone number is invalid': 'field',
    'You must accept membership agreement before checking out': 'field',
    // The store struggling (or sold out just now): pressed again.
    "We're experiencing high demand right now. Something went wrong — please try again.": 'busy',
    'Something went wrong on our end. Please try again.': 'busy',
    'Too many requests': 'busy',
    'Service unavailable': 'busy',
    'Error 503': 'busy',
    'Request timed out': 'busy',
    'Sorry, this item is out of stock': 'busy',
    // Anything else: for you.
    'Your order could not be completed': 'other',
    '': '',
  };
  for (const [text, kind] of Object.entries(kinds)) assert.equal(C.errorKind(text), kind, text);
  assert.deepEqual([0, 1, 2, 3, 6, 50].map(C.retryWait), [3000, 5000, 8000, 10000, 20000, 20000], '3 s, 5 s, 8 s… then every 20 s');
  assert.equal(C.RETRY_MS, 30 * 60 * 1000);
  const doc = (text) => ({ querySelector: () => ({ innerText: text }), body: { innerText: text } });
  for (const shown of ['...2387 08/27', '...2387\n08/27', '...238708/27', '...2387 08/2027', 'Visa ending in 4242', '•••• 4242', '**** 4242', 'Mastercard …2387']) assert.equal(C.savedCardShown(doc(`Payment ${shown}`), null, false), true, shown);
  for (const not of ['Order total $109.95 · 2 items · Pickup 2387 Main Rd', 'Loading...\n2026', 'Super-Premium Coll…\n2025', 'Collection... 2025']) assert.equal(C.savedCardShown(doc(not), null, false), false, `no card shown: ${not}`);
  assert.equal(C.savedCardShown(doc('...2387 08/27'), null, true), false, 'card boxes on the page: they need filling, whatever else shows');
  // Words about approving a payment, as a checkout's pop-up or the bank puts them after the final button (only new
  // ones count: checks.js bankAfterPress) — and not what a checkout says anyway.
  // (Whatever the bank — its name is never needed: any bank's words for it.)
  for (const said of ['Approve this payment in your CommBank app', 'Open your banking app to approve the payment', 'Check your NAB app to confirm', 'Payment authentication', 'Verify your purchase',
    'Waiting for your bank', 'Enter your NetCode', 'Use the Westpac app to approve', 'Visa Secure', 'Mastercard Identity Check', 'Approve it in the ANZ app', 'Check your Up app',
    "We've sent a code to your phone", 'We sent a 6-digit code to 04•• ••• 123', 'Enter the verification code', 'Check your phone for a notification', 'Confirm it’s you',
    'Approve the request in your app', 'Continue the verification with your bank', 'We texted you a one-time code', 'American Express SafeKey', 'Banco Santander: confirma it in the app? Approve it with the Santander app',
    'Monzo: check your mobile', 'Authorise this payment', 'Confirm the transaction']) assert.ok(C.bankWords(said).length, said);
  for (const not of ['CONFIRM & PAY', 'Pay now $239.00', 'Secure checkout', 'Your payment details are encrypted', 'Approved retailer', 'Download our shopping app', 'Order summary', 'Card verification code (CVV)',
    // (The check gone wrong is what the store says, for you as it is — not the bank asking.)
    'Payment authentication failed. Please try again.', "We couldn't verify your payment", 'Your bank declined to approve the payment']) assert.deepEqual([...C.bankWords(not)], [], not);
  for (const not of ['Enter the security code on the back of your card', 'Download the Shop app', 'Code: SAVE10 applied', 'Text me with news and offers']) assert.deepEqual([...C.bankWords(not)], [], not);
  assert.deepEqual([...C.bankWords('Order summary\nApprove this payment in your CommBank app\nPayment authentication failed')], ['approve this payment'], 'line by line');
  assert.match(C.bankMessage('EB Games', null), /^Your bank wants you to approve this payment: approve it in your bank's app .* once EB Games confirms the order\.$/);
  assert.match(C.bankMessage('Shop', { how: 'popup', host: 'acs.example.com' }), /^A pop-up came up on the checkout after paying \(acs\.example\.com\) — most likely your bank/);
  assert.ok(C.bankMessage('Premium Bandai', { how: 'popup', host: 'acs1.sbs.netcode.commbank.com.au' }).length <= 300, 'within what the run keeps');
});
