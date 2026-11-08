// 🚨 Premium Bandai drops (Nov 2026, the owner's ask): whatever drops on Premium Bandai's One Piece Card Game page
// (/au/brand/onepiececardgame) and its Bandai Card Shop (/au/shop/bandaicardshop) is bought at once through Premium
// Bandai's own checkout, for each member who's turned on Auto-checkout of these drops — and every member's DM'd.
//
// - Each page is read as the site's own search JSON for its brand's or shop's code (06-0074, 05-0004 — what the real
//   pages carry), newest first: from Mugibot's server (it answers servers, Nov 2026), an admin's browser standing in
//   while it's refused. Every 3 s — and every second from just before a pre-order's published opening time
//   (saleStartExpectedDt) till a few minutes after, so the moment it opens is seen within a second.
// - Anything new counts: no key phrases, no lowest price, no kind of product left out.
// - A window closed for good ("End") is never armed; one not open yet ("Waiting") is armed, and bought the moment it
//   opens — for a member who turns Auto-checkout on later too.
// - Set up by itself once, when the server starts, for the owner (as their EB Games pre-order drops are).
// Against the dummy Premium Bandai — tests never touch real stores.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { parsePBandai } from '../server/monitor/listing.js';
import { HOT_AFTER_MS, HOT_BEFORE_MS, PB_CODES, floorFor, nextRead, pbandaiData, planFor } from '../server/monitor/pages.js';
import { PB_PAGES, PRESETS } from '../server/monitor/drops.js';
import pbandai from '../server/retailers/pbandai.js';

let env;
let store;
let discord;
let boss;
let ash;
let misty;
let brock;
let clock;

const ONE_PIECE = PB_CODES.brand.onepiececardgame;
const CARD_SHOP = PB_CODES.shop.bandaicardshop;

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  clock = { offset: 0 };
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, now: () => Date.now() + clock.offset, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  misty = await Client.signup(env.url, 'misty');
  brock = await Client.signup(env.url, 'brock');
  for (const [c, d] of [[boss, 'd-boss'], [ash, 'd-ash'], [misty, 'd-misty'], [brock, 'd-brock']]) {
    makeMember(env, c);
    env.app.repo.updateUser(c.user.id, { discord_id: d });
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
    assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 3000, perDay: 20, spendPerDay: 20000 })).status, 200);
    env.app.repo.addDevice(c.user.id, 'Chrome on Mac', '1.43.0');
  }
  // The dummy Premium Bandai searched server first, as the real one is.
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-pbandai': 'auto' } })).status, 200);
  // What's on the pages already — their "before": a window open now (on sale), one closed for good, one opening in
  // a week (listed ahead, as Premium Bandai lists its pre-orders).
  const week = Date.now() + 7 * 86400000;
  store.addProduct('pbandai', { sku: 'N2898133002', name: 'GUNDAM CARD GAME Premium Goods Set [PB04]', price: 127, status: 'preorder', shop: CARD_SHOP });
  store.addProduct('pbandai', { sku: 'N2873815002', name: 'ONE PIECE CARD GAME Japanese 4th Anniversary Set', price: 280, status: 'out_of_stock', saleStatus: 'End', brand: ONE_PIECE, shop: CARD_SHOP });
  store.addProduct('pbandai', { sku: 'N2903432004', name: 'ONE PIECE CARD GAME Premium Card Collection -29th Anniversary Edition-', price: 18, status: 'coming_soon', opensAt: week, brand: ONE_PIECE });
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const pages = () => env.app.pages;
const admin = () => env.app.repo.userById(boss.user.id);
const dms = (id) => discord.dmsTo(id);
const runsFor = (itemId) => env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: itemId });
const itemOf = (c, sku) => env.app.repo.itemBySku(c.user.id, 'demo-pbandai', sku);
const watchOf = async (c, id) => (await c.get('/api/drops')).body.watches.find((w) => w.id === id);
const R = () => env.app.retailers.get('demo-pbandai');
const stateOf = (w) => pages().state.get(`${w.store}|${w.page}`);

/** One round of reads from Mugibot's server: every page due read (3 s on), and what it set going let finish. */
async function serverRound(step = 3100) {
  clock.offset += step;
  const n = await pages().tick();
  await env.app.monitor.delivered();
  await env.app.drops.allTold();
  return n;
}
/** Both pages read (a round or two). */
async function readBoth() {
  let n = 0;
  for (let i = 0; i < 4 && n < 2; i++) n += await serverRound();
  return n;
}

let onePiece;
let cardShop;

test('🚨 Premium Bandai\'s data: a window closed for good ("End") says so; one not open yet ("Waiting") says when it opens — as the real site gives them', () => {
  // (Shaped as the real JSON was read, Nov 2026.)
  const text = JSON.stringify({
    productResults: {
      sortType: 'NewArrival', limit: 100, offset: 0, totalCount: 3,
      products: [
        { productCode: 'N2898133002', productName: { en: 'GUNDAM CARD GAME Premium Goods Set After War Gundam X [PB04]' }, productType: 'PreOrder', fixedListPrice: { amount: 127.0, currency: 'AUD' }, saleStatus: 'On', saleStartExpectedDt: '2026-10-26T02:00:00Z', saleEndExpectedDt: '2026-11-09T14:59:59.999Z', productImages: [{ fileUrl: 'files/x.jpg', mediaType: 'Image' }] },
        { productCode: 'N2873815002', productName: { en: 'ONE PIECE CARD GAME Japanese 4th Anniversary Set' }, productType: 'PreOrder', fixedListPrice: { amount: 280.0, currency: 'AUD' }, saleStatus: 'End', saleStartExpectedDt: '2026-09-29T02:00:00Z' },
        { productCode: 'N2999999001', productName: { en: 'ONE PIECE CARD GAME 5th Anniversary Set' }, productType: 'PreOrder', fixedListPrice: { amount: 290.0, currency: 'AUD' }, saleStatus: 'Waiting', saleStartExpectedDt: '2026-12-01T02:00:00Z' },
      ],
    },
  });
  const { products, total } = parsePBandai(text, { base: 'https://p-bandai.com/api/search', storeBase: 'https://p-bandai.com/au' });
  assert.equal(total, 3);
  const [on, end, waiting] = products;
  assert.deepEqual([on.inStock, on.ended, on.opensAt], [true, undefined, undefined], 'on sale: neither');
  assert.equal(on.url, 'https://p-bandai.com/au/item/N2898133002');
  assert.deepEqual([end.inStock, end.ended, end.opensAt], [false, true, undefined], 'closed for good');
  assert.deepEqual([waiting.inStock, waiting.ended, waiting.opensAt], [false, undefined, Date.parse('2026-12-01T02:00:00Z')], 'opens then');
  // (The browser's results keep both, as the server's read does.)
  const clean = env.app.sweeper.cleanProduct(env.app.retailers.get('pbandai'), { ...waiting });
  assert.equal(clean.opensAt, waiting.opensAt);
  assert.equal(env.app.sweeper.cleanProduct(env.app.retailers.get('pbandai'), { ...end }).ended, true);
  assert.equal(env.app.sweeper.cleanProduct(env.app.retailers.get('pbandai'), { ...on, ended: 'yes', opensAt: 'soon' }).ended, undefined, 'only as the reader gives them');
});

test('🚨 the owner\'s two pages are read as the site\'s search JSON for their codes — One Piece Card Game 06-0074, Bandai Card Shop 05-0004 — newest first, from the server (the region header with it), an admin\'s browser asking the same from inside the page', () => {
  const real = env.app.retailers.get('pbandai');
  const brand = planFor(real, 'https://p-bandai.com/au/brand/onepiececardgame');
  assert.equal(brand.server.url, 'https://p-bandai.com/api/search?limit=100&offset=0&sortType=NewArrival&_f_brands=06-0074');
  assert.deepEqual([brand.server.parser, brand.server.json, brand.server.size], ['pbandai', true, 100]);
  assert.deepEqual([brand.browser.url, brand.browser.inPage, brand.browser.expect, brand.browser.pageUrl], [brand.server.url, true, 'json', 'https://p-bandai.com/au/brand/onepiececardgame']);
  assert.deepEqual(brand.browser.headers, { 'x-g1-area-code': 'au' });
  assert.equal(planFor(real, 'https://p-bandai.com/au/shop/bandaicardshop/').server.url, 'https://p-bandai.com/api/search?limit=100&offset=0&sortType=NewArrival&_f_shops=05-0004');
  // (Its own "View List" page, with the site's filters: the same JSON.)
  assert.equal(pbandaiData(real, 'https://p-bandai.com/au/search?limit=20&sortType=NewArrival&_f_productStatuses=Waiting,On&_f_brands=06-0074'),
    'https://p-bandai.com/api/search?limit=100&offset=0&sortType=NewArrival&_f_productStatuses=Waiting%2COn&_f_brands=06-0074');
  // A brand Mugibot has no code for: learned from its page in an admin's browser, as before.
  assert.equal(pbandaiData(real, 'https://p-bandai.com/au/brand/constructor'), '', 'its own codes only');
  const other = planFor(real, 'https://p-bandai.com/au/brand/digimoncardgame');
  assert.equal(other.server, null);
  assert.equal(other.browser.learn, true);
  // The dummy store's copy: its own address.
  assert.equal(pbandaiData(R(), `${R().base}/brand/onepiececardgame`), `${store.url}/pbandai/api/search?limit=100&offset=0&sortType=NewArrival&_f_brands=06-0074`);
  // Every 3 s at the fastest (one small JSON a read) — its keyword searches still every 30 s.
  assert.equal(floorFor(real), 3);
  assert.equal(pbandai.sweep.minSeconds, 30);
  assert.ok(env.app.sweeper.paceFor(real) >= 30000, 'its searches as before');
});

test('⏱ a pre-order opening at a published time: its page read every second from 30 s before till 3 minutes after — at its pace otherwise', () => {
  const t0 = 1_000_000_000_000;
  const every = 3000;
  assert.equal(nextRead([], t0, every), t0 + every, 'nothing opening: its pace');
  assert.equal(nextRead([t0 + 3600_000], t0, every), t0 + every, 'an hour off: its pace');
  assert.equal(nextRead([t0 + HOT_BEFORE_MS + 2000], t0, every), t0 + 2000, 'its fast reads start 30 s before, not at the next 3 s');
  assert.equal(nextRead([t0 + 10_000], t0, every), t0 + 1000, 'within 30 s: every second');
  assert.equal(nextRead([t0 - 60_000], t0, every), t0 + 1000, 'just opened: still every second');
  assert.equal(nextRead([t0 - HOT_AFTER_MS - 1000], t0, every), t0 + every, '3 minutes on: its pace again');
});

test('🚨 the Premium Bandai drops preset (admins): its two pages, each a priority watch for everyone — no key phrases, no lowest price, read every 3 s, as many as the store allows', async () => {
  assert.deepEqual(PRESETS.pbandaidrops.pages.map((p) => p.path), [PB_PAGES.onepiece, PB_PAGES.cardshop]);
  assert.deepEqual(Object.values(PB_PAGES), ['/brand/onepiececardgame', '/shop/bandaicardshop']);
  assert.equal((await ash.post('/api/drops/presets/pbandaidrops', { demo: true })).status, 400, 'members can\'t add watches for everyone');
  const r = await boss.post('/api/drops/presets/pbandaidrops', { demo: true, qty: 'max' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.added.length, 2);
  [onePiece, cardShop] = r.body.added;
  assert.equal(onePiece.page, `${store.url}/pbandai/brand/onepiececardgame`);
  assert.equal(cardShop.page, `${store.url}/pbandai/shop/bandaicardshop`);
  for (const w of [onePiece, cardShop]) assert.deepEqual([w.priority, w.shared, w.phrases, w.minPrice, w.every, w.qtyRule], [true, true, [], null, 3, 'max']);
  assert.deepEqual([onePiece, cardShop].map((w) => env.app.drops.get(w.id).category), ['onepiece', 'other']);
  const again = await boss.post('/api/drops/presets/pbandaidrops', { demo: true });
  assert.equal(again.status, 400);
  assert.match(again.text, /watching that page already/);
  // Ash turns on Auto-checkout of both (his max, as many as allowed); Misty's told only; Brock mutes the card shop.
  for (const w of [onePiece, cardShop]) assert.equal((await ash.put(`/api/drops/${w.id}/follow`, { aco: true, maxPrice: 300, qty: 'max' })).status, 200);
  assert.equal((await brock.put(`/api/drops/${cardShop.id}/follow`, { dm: false })).status, 200);
});

test('🚨 the first read is how things are: on sale already — not bought; closed for good ("End") — never armed; listed ahead of its window ("Waiting") — armed, to be bought the moment it opens', async () => {
  const before = dms('d-misty').length;
  assert.equal(await readBoth(), 2);
  for (const w of [onePiece, cardShop]) {
    const v = await watchOf(boss, w.id);
    assert.equal(v.looked, true);
    assert.equal(stateOf(w).via, 'server', 'read from Mugibot\'s server');
  }
  assert.equal(itemOf(ash, 'N2898133002'), null, 'on sale when the watch first looked: there before it, not bought');
  assert.equal(itemOf(ash, 'N2873815002'), null, 'its window closed for good: never armed');
  const waiting = itemOf(ash, 'N2903432004');
  assert.ok(waiting && waiting.aco, 'not open yet: armed for Ash');
  assert.equal(runsFor(waiting.id).length, 0, 'nothing bought yet');
  assert.equal(itemOf(misty, 'N2903432004'), null, 'Misty didn\'t turn Auto-checkout on');
  assert.equal(dms('d-misty').length, before, 'nothing told: nothing dropped');
  // The page knows when its next window opens (a week off: at its pace till then).
  const v = await watchOf(boss, onePiece.id);
  assert.ok(Math.abs(v.opensAt - (Date.now() + 7 * 86400000)) < 5 * 60 * 1000, 'when it opens');
  assert.equal(v.hot, false);
});

test('🚨 something new on the page: bought straight away for Ash (as many as the store allows, up to his max), every member DM\'d once (not Brock where he muted it) — whatever it is, an accessory too', async () => {
  const n = { ash: dms('d-ash').length, misty: dms('d-misty').length };
  store.addProduct('pbandai', { sku: 'N2999990001', name: 'ONE PIECE CARD GAME Premium Booster -THE BEST vol.3- [PRB-03] (BOX)', price: 165, status: 'preorder', brand: ONE_PIECE, shop: CARD_SHOP });
  store.addProduct('pbandai', { sku: 'N2999990002', name: 'ONE PIECE CARD GAME Official Card Sleeves -Straw Hat Crew-', price: 19, status: 'preorder', shop: CARD_SHOP });
  await readBoth();
  for (const sku of ['N2999990001', 'N2999990002']) {
    const it = itemOf(ash, sku);
    assert.ok(it && it.aco, `${sku} armed for Ash`);
    assert.deepEqual([it.maxPrice, it.qtyRule], [300, 'max']);
    assert.equal(runsFor(it.id).length, 1, `${sku}: his Auto-checkout started at once`);
  }
  assert.equal(itemOf(misty, 'N2999990001'), null);
  const titles = (id, from) => dms(id).slice(from).map((m) => m.body.embeds[0].title);
  const mt = titles('d-misty', n.misty);
  assert.equal(mt.filter((t) => /THE BEST vol\.3/.test(t)).length, 1, 'once — though both pages list it');
  assert.ok(mt.some((t) => /Card Sleeves/.test(t)), 'an accessory is a drop too');
  const box = dms('d-misty').slice(n.misty).find((m) => /THE BEST vol\.3/.test(m.body.embeds[0].title)).body;
  assert.equal(box.embeds[0].author.name, '🚨 PRIORITY DROP — buy it now');
  assert.ok(box.components[0].components.some((b) => b.label === '⚡ Buy with Mugibot'));
  assert.ok(dms('d-ash').slice(n.ash).some((m) => /THE BEST vol\.3/.test(m.body.embeds[0].title) && /Your Auto-checkout is buying it/.test(m.body.embeds[0].description)));
  // Read again: nothing twice.
  const count = dms('d-misty').length;
  await readBoth();
  assert.equal(runsFor(itemOf(ash, 'N2999990001').id).length, 1);
  assert.equal(dms('d-misty').length, count);
});

test('🚨 a member who turns Auto-checkout on later: what\'s listed ahead of its window is armed for them too (up to their max) — and a window that opens is bought for everyone armed', async () => {
  // Brock turns it on for the One Piece page now, after its first look — the 29th Anniversary collection, still not open, is his too.
  const r = await brock.put(`/api/drops/${onePiece.id}/follow`, { aco: true, maxPrice: 50, qty: 'min' });
  assert.equal(r.status, 200, r.text);
  const his = itemOf(brock, 'N2903432004');
  assert.ok(his && his.aco, 'armed for Brock');
  assert.deepEqual([his.maxPrice, his.qtyRule], [50, ''], 'one (Min)');
  assert.equal(itemOf(brock, 'N2898133002'), null, 'nothing on sale already');
  assert.equal(itemOf(brock, 'N2999990001'), null, 'nor what dropped before he turned it on (bought or not, it was on sale)');
  // Misty, with a max under its price: not armed.
  store.addProduct('pbandai', { sku: 'N2999990003', name: 'ONE PIECE CARD GAME 5th Anniversary Set', price: 290, status: 'coming_soon', opensAt: Date.now() + clock.offset + 3 * 86400000, brand: ONE_PIECE });
  await readBoth();
  assert.ok(itemOf(ash, 'N2999990003')?.aco, 'new, not open yet: armed for Ash');
  assert.equal(runsFor(itemOf(ash, 'N2999990003').id).length, 0, 'not bought before it opens');
  await misty.put(`/api/drops/${onePiece.id}/follow`, { aco: true, maxPrice: 100 });
  assert.equal(itemOf(misty, 'N2999990003'), null, 'over her max: not armed');
  assert.ok(itemOf(misty, 'N2903432004')?.aco, 'under it: armed');
  // The collection's window opens: bought for each of them.
  store.set('pbandai', 'N2903432004', { status: 'preorder', opensAt: null });
  await readBoth();
  for (const c of [ash, brock, misty]) {
    const it = itemOf(c, 'N2903432004');
    assert.equal(runsFor(it.id).length, 1, `${c.user.username}'s Auto-checkout started the moment it opened`);
  }
  await misty.put(`/api/drops/${onePiece.id}/follow`, { aco: false });
});

test('🚨 sold out within its window: armed in case it comes back (cancellations) — and once its window closes for good, disarmed (it can\'t come back), each member told', async () => {
  store.addProduct('pbandai', { sku: 'N2999990006', name: 'ONE PIECE CARD GAME Premium Card Collection -Film Red-', price: 45, status: 'out_of_stock', brand: ONE_PIECE });
  await readBoth();
  const it = itemOf(ash, 'N2999990006');
  assert.ok(it && it.aco, 'armed for Ash, sold out as it is');
  assert.equal(runsFor(it.id).length, 0, 'nothing to buy yet');
  store.set('pbandai', 'N2999990006', { saleStatus: 'End' });
  await readBoth();
  assert.equal(itemOf(ash, 'N2999990006').aco, false, 'disarmed: its window is closed');
  assert.ok(env.app.repo.listEvents(ash.user.id, { limit: 5 }).some((e) => /Film Red.*order window has closed/.test(e.message)));
  // (Another window of it is another code — a drop of its own.)
  store.addProduct('pbandai', { sku: 'N2999990007', name: 'ONE PIECE CARD GAME Premium Card Collection -Film Red-', price: 45, status: 'preorder', brand: ONE_PIECE });
  await readBoth();
  assert.equal(runsFor(itemOf(ash, 'N2999990007').id).length, 1, 'its next window: bought');
});

test('⏱ a window opening within 30 s: its page read every second (and the dashboard says so) — at its pace again once it\'s a few minutes open', async () => {
  const opens = Date.now() + clock.offset + 20_000;
  store.addProduct('pbandai', { sku: 'N2999990004', name: 'ONE PIECE CARD GAME Double Pack Set vol.9 [DP-09]', price: 24, status: 'coming_soon', opensAt: opens, brand: ONE_PIECE });
  await readBoth();
  const st = stateOf(onePiece);
  assert.equal(st.nextAt - st.startedAt, 1000, 'next read in a second');
  const v = await watchOf(ash, onePiece.id);
  assert.equal(v.hot, true);
  assert.equal(v.opensAt, opens);
  // Every second: read again a second on.
  assert.equal(await serverRound(1000) >= 1, true, 'read again after a second');
  // It opens: bought within that second's read.
  store.set('pbandai', 'N2999990004', { status: 'preorder', opensAt: null });
  clock.offset = opens - Date.now() + 500;
  await serverRound(600);
  const it = itemOf(ash, 'N2999990004');
  assert.ok(it, 'armed for Ash when it was listed');
  assert.equal(runsFor(it.id).length, 1, 'bought the second it opened');
  // Long after: its pace again.
  clock.offset += HOT_AFTER_MS + 5000;
  await readBoth();
  const after = stateOf(onePiece);
  assert.equal(after.nextAt - after.startedAt, 3000, 'every 3 s again');
});

test('🚨 refused at the server: an admin\'s browser asks for the same JSON from inside a Premium Bandai page (the region header with it), and what it reads counts the same', async () => {
  // (An admin's browser around: it asked for its pages lately.)
  pages().browserDue(admin(), { version: '1.43.0' });
  store.shop('pbandai').refuseApi = true;
  try {
    await readBoth();
    clock.offset += 3100;
    const due = pages().browserDue(admin(), { version: '1.43.0' });
    const t = due.pages.find((x) => x.url.includes('_f_brands=06-0074') || x.url.includes('_f_shops=05-0004'));
    assert.ok(t, JSON.stringify(due));
    assert.equal(t.inPage, true);
    assert.equal(t.render, false);
    assert.equal(t.expect, 'json');
    assert.deepEqual(t.headers, { 'x-g1-area-code': 'au' });
    assert.ok([onePiece.page, cardShop.page].includes(t.pageUrl), 'asked from inside the page itself');
    store.shop('pbandai').refuseApi = false;
    store.addProduct('pbandai', { sku: 'N2999990005', name: 'DIGIMON CARD GAME Premium Heroes Set', price: 99, status: 'preorder', brand: ONE_PIECE, shop: CARD_SHOP });
    const res = await fetch(t.url, { headers: { ...t.headers, 'user-agent': 'Mozilla/5.0 Chrome/130' } });
    const parsed = parsePBandai(await res.text(), { base: t.url, storeBase: R().base });
    await pages().browserResults(admin(), [{ id: t.id, ok: true, how: 'page', products: parsed.products, total: parsed.total, perPage: parsed.perPage }]);
    await env.app.monitor.delivered();
    await env.app.drops.allTold();
    const it = itemOf(ash, 'N2999990005');
    assert.ok(it && it.aco, 'new, read by the admin\'s browser: armed for Ash');
    assert.equal(runsFor(it.id).length, 1, 'and bought');
  } finally {
    store.shop('pbandai').refuseApi = false;
  }
});

test('🚨 set up by itself once when the server starts: for the admin whose EB Games pre-order drops these are (their own Auto-checkout and how many as theirs) — never twice, never for members, nobody\'s Auto-checkout turned on for them', async () => {
  const drops = env.app.drops;
  // (This server started with no admin yet: done, nothing added — the preset's button is how.)
  assert.equal(Number(env.app.repo.getSetting('pbandaiPresetVersion')), 1);
  // Boss's EB Games pre-order drops, his own Auto-checkout of them up to $250 for Min.
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-ebgames': 'browser' } })).status, 200);
  const eb = await boss.post('/api/drops/presets/ebpreorders', { demo: true, qty: 'min', aco: true, maxPrice: 250 });
  assert.equal(eb.status, 200, eb.text);
  for (const w of [onePiece, cardShop]) await boss.del(`/api/drops/${w.id}`);
  env.app.repo.setSetting('pbandaiPresetVersion', 0);
  drops.setUpPBandai();
  const mine = () => drops.watches().filter((w) => w.userId === boss.user.id && /pbandai/.test(w.store));
  const added = mine();
  assert.deepEqual(added.map((w) => w.page).sort(), [`${store.url}/pbandai/brand/onepiececardgame`, `${store.url}/pbandai/shop/bandaicardshop`]);
  for (const w of added) {
    assert.deepEqual([w.store, w.shared, w.priority, w.aco, w.maxPrice, w.qty, w.minPrice, w.phrases, w.every, w.channelId, w.roleId], ['demo-pbandai', true, true, true, 250, '1', null, [], 3, '', '']);
  }
  assert.ok(env.app.repo.listEvents(boss.user.id, { limit: 5 }).some((e) => /Premium Bandai drops: watching/.test(e.message) && /up to \$250\.00 each/.test(e.message)));
  assert.equal(drops.followers(added[0].id, { aco: true }).length, 0, 'no member\'s Auto-checkout turned on for them');
  // Never twice: once done; and a page watched already is left as it is.
  drops.setUpPBandai();
  assert.equal(mine().length, 2);
  env.app.repo.setSetting('pbandaiPresetVersion', 0);
  drops.setUpPBandai();
  assert.equal(mine().length, 2);
  // Without EB Games pre-order drops: the first of ADMIN_USERNAMES, their own Auto-checkout off till they set their max.
  for (const w of drops.watches().filter((x) => x.userId === boss.user.id && x.priority)) await boss.del(`/api/drops/${w.id}`);
  // (The real store's pages would be read: switched off first — tests never touch real stores.)
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { pbandai: 'off' } })).status, 200);
  env.app.repo.setSetting('pbandaiPresetVersion', 0);
  drops.setUpPBandai();
  const real = mine();
  assert.deepEqual(real.map((w) => w.page).sort(), ['https://p-bandai.com/au/brand/onepiececardgame', 'https://p-bandai.com/au/shop/bandaicardshop']);
  for (const w of real) assert.deepEqual([w.store, w.priority, w.aco, w.maxPrice, w.qty], ['pbandai', true, false, null, 'max']);
  assert.ok(env.app.repo.listEvents(boss.user.id, { limit: 5 }).some((e) => /Turn on your own Auto-checkout of them/.test(e.message)));
  for (const w of real) await boss.del(`/api/drops/${w.id}`);
});

test('🚨 Premium Bandai\'s priority pages buy whatever drops; EB Games\' still never an accessory nor a single card', () => {
  const d = env.app.drops;
  const pb = { priority: true, store: 'pbandai', url: '' };
  const ebw = { priority: true, store: 'ebgames', url: '' };
  for (const name of ['ONE PIECE CARD GAME Official Card Sleeves', 'ONE PIECE CARD GAME Official Playmat', 'GUNDAM CARD GAME Premium Goods Set [PB04]']) {
    assert.equal(d.mayBuy(pb, name, 'pbandai'), true, name);
  }
  assert.equal(d.mayBuy(ebw, 'One Piece TCG Official Sleeves', 'ebgames'), false);
  assert.equal(d.mayBuy(ebw, 'One Piece - TCG - Roronoa Zoro OP01-025 - NM/M', 'ebgames'), false);
  // An ordinary (not priority) Premium Bandai watch: as before.
  assert.equal(d.mayBuy({ priority: false, store: 'pbandai', url: '', qty: 'auto' }, 'ONE PIECE CARD GAME Official Playmat', 'pbandai'), false);
});
