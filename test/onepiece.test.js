// One Piece drops at EB Games and Premium Bandai (Mugibot 2.0): what each product is (monitor/classify.js), how many
// Auto-checkout buys — a booster box one, a hangsell or booster pack as many as the store allows — the one-click preset,
// accessories never bought, the ⚡ Buy code telling the extension to take the store's most, and admins told within
// minutes when a store only their browsers search isn't being searched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { classify, gameOf, quantityFor, qtySetting, setCodes, typeOf } from '../server/monitor/classify.js';
import { item as checkItem } from '../server/schema.js';

test('what a product is, from the names EB Games and Premium Bandai give them: the game, the kind of product, its set codes, how many to buy, its priority', () => {
  const cases = [
    // [name, game, type, codes, quantity]
    ['One Piece TCG OP-19 Hangsell Booster', 'onepiece', 'hangsell', ['OP-19'], 'max'],
    ['One Piece TCG EB-05 Booster', 'onepiece', 'booster_pack', ['EB-05'], 'max'],
    ['One Piece TCG EB-06 Booster', 'onepiece', 'booster_pack', ['EB-06'], 'max'],
    ['One Piece Card Game OP-20 Booster Box', 'onepiece', 'booster_box', ['OP-20'], 1],
    ['One Piece TCG OP-20 Booster Display (24 Packs)', 'onepiece', 'booster_box', ['OP-20'], 1],
    ['ONE PIECE CARD GAME PREMIUM BOOSTER -THE BEST vol.2- [PRB-02] (BOX)', 'onepiece', 'booster_box', ['PRB-02'], 1],
    ['ONE PIECE CARD GAME OP-12 (PACK)', 'onepiece', 'booster_pack', ['OP-12'], 'max'],
    ['One Piece Card Game Booster Box Case (12 Boxes)', 'onepiece', 'case', [], 1],
    ['One Piece TCG ST-21 Starter Deck', 'onepiece', 'starter_deck', ['ST-21'], 1],
    ['One Piece TCG OP-11 Double Pack Set Vol.6', 'onepiece', 'booster_pack', ['OP-11'], 'max'],
    ['Pokémon TCG: Mega Evolution Elite Trainer Box', 'pokemon', 'elite_trainer_box', [], 1],
    ['Pokémon TCG 30th Celebration Ultra-Premium Collection', 'pokemon', 'premium_collection', [], 1],
    ['Pokemon TCG Destined Rivals 3-Pack Blister', 'pokemon', 'blister', [], 'max'],
    ['Pokemon TCG Scarlet & Violet SV10 Booster Bundle', 'pokemon', 'booster_bundle', ['SV10'], 1],
  ];
  for (const [name, game, type, codes, qty] of cases) {
    const c = classify(name);
    assert.deepEqual([c.game, c.type, c.codes, c.quantity], [game, type, codes, qty], name);
  }
  // An accessory with the words: not a card product (never bought by an "auto" watch).
  assert.equal(typeOf('Ultra Pro One Piece Deck Case'), 'accessory');
  assert.equal(typeOf('ONE PIECE CARD GAME Official Playmat Limited Edition vol.6'), 'accessory');
  // A set code alone, at a card shop that leaves the game's name out.
  assert.equal(gameOf('OP-20 Booster Box'), 'onepiece');
  assert.deepEqual(setCodes('op20 booster box / eb 05'), ['OP-20', 'EB-05']);
  // Priorities: a box, an ETB, every One Piece set product first in line; the rest of the two games next; anything else last.
  assert.equal(classify('One Piece TCG OP-19 Hangsell Booster').priority, 'high');
  assert.equal(classify('Pokémon TCG: Mega Evolution Elite Trainer Box').priority, 'high');
  assert.equal(classify('Pokemon TCG Tin').priority, 'normal');
  assert.equal(classify('Gundam Card Game Booster Box').priority, 'low');
});

test("a watch's quantity setting: 'auto' by the kind of product, 'max', or a number — and an item asked for the most the store allows keeps it", () => {
  assert.equal(qtySetting('AUTO'), 'auto');
  assert.equal(qtySetting('max'), 'max');
  assert.equal(qtySetting('3'), '3');
  assert.equal(qtySetting('11'), '1');
  assert.equal(qtySetting(undefined, 'auto'), 'auto');
  assert.equal(quantityFor('auto', 'One Piece TCG OP-19 Hangsell Booster'), 'max');
  assert.equal(quantityFor('auto', 'One Piece Card Game OP-20 Booster Box'), 1);
  assert.equal(quantityFor('2', 'One Piece TCG OP-19 Hangsell Booster'), 2);
  const retailers = { forUrl: () => ({ id: 'ebgames', flow: {} }), get: () => ({ id: 'ebgames', flow: {} }), skuFromUrl: () => '381003', enabled: () => true, settings: () => ({}) };
  const it = checkItem({ url: 'https://www.ebgames.com.au/product/toys-and-collectibles/381003-one-piece-tcg-op-19-hangsell-booster', quantity: 'max' }, { retailers });
  assert.deepEqual([it.quantity, it.qtyRule], [10, 'max']);
  // (Changing something else keeps it; a number given instead ends it.)
  assert.deepEqual([checkItem({ name: 'OP-19 hangsell' }, { retailers, existing: it }).qtyRule], ['max']);
  assert.deepEqual(['quantity', 'qtyRule'].map((k) => checkItem({ quantity: 3 }, { retailers, existing: it })[k]), [3, '']);
});

// --- against the app -------------------------------------------------------------------------------------------------
let env;
let store;
let discord;
let clock;
let boss;
let device;
before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  clock = { offset: 0 };
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, now: () => Date.now() + clock.offset, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  makeMember(env, boss);
  env.app.repo.updateUser(boss.user.id, { discord_id: 'd-boss', discord_dm_channel: 'dm-d-boss' });
  for (const it of (await boss.get('/api/items')).body.items) await boss.del(`/api/items/${it.id}`);
  device = await Device.pair(env.url, boss, 'Boss Chrome');
  await device.call('GET', '/api/ext/me?v=1.40.0');
  const off = Object.fromEntries(env.app.sweeper.stores().map((s) => [s.retailer.id, 'off']));
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { ...off, 'demo-ebgames': 'browser', 'demo-pbandai': 'browser', ebgames: 'browser', pbandai: 'browser' } })).status, 200);
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const pbTile = (sku, title, inStock = true, price = 8) => ({ sku, title, price, inStock, url: `${store.url}/pbandai/item/${sku}` });
async function pbSearch(products, keyword = 'one piece card game', { total = products.length, perPage = 60 } = {}) {
  const r = await device.call('POST', '/api/ext/sweeps', { results: [{ store: 'demo-pbandai', keyword, page: 1, ok: true, status: 200, ms: 900, total, perPage, products }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.results[0];
}
const ebTile = (sku, title, inStock = true, price = 8) => ({ sku, title, price, inStock, url: `${store.url}/ebgames/product/toys-and-collectibles/${sku}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` });
async function ebSearch(products, keyword = 'one piece') {
  const r = await device.call('POST', '/api/ext/sweeps', { results: [{ store: 'demo-ebgames', keyword, page: 1, ok: true, status: 200, ms: 900, products }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.results[0];
}

test('🏴‍☠️ the One Piece preset: watches at EB Games (alerts only — Auto-checkout at EB Games is the priority pages\' alone) and Premium Bandai (armed up to the max price, quantities by the kind of product) — each once', async () => {
  let r = await boss.post('/api/drops/presets/onepiece', { aco: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /max price/);
  r = await boss.post('/api/drops/presets/onepiece', { aco: true, maxPrice: 300 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.added.map((w) => [w.store, w.words, w.aco, w.maxPrice, w.qty]).sort(), [
    ['ebgames', 'one piece card game', false, null, 'auto'], ['ebgames', 'one piece tcg', false, null, 'auto'], ['pbandai', 'one piece card game', true, 300, 'auto'],
  ].sort());
  // (Again: nothing twice.)
  r = await boss.post('/api/drops/presets/onepiece', { aco: true, maxPrice: 300 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /already/);
  for (const w of (await boss.get('/api/drops')).body.watches) await boss.del(`/api/drops/${w.id}`);
});

test("🏴‍☠️ an \"auto\" drop watch (Premium Bandai): a new OP-20 booster box armed for one, its hangsell for as many as the store allows (its own product page, not a cart link — the ⚡ Buy code says so), a playmat with the words — and a single card — told but never bought. At EB Games a keyword watch can't Auto-checkout at all (the priority pages alone)", async () => {
  const eb = await boss.post('/api/drops', { store: 'demo-ebgames', words: 'one piece tcg', aco: true, maxPrice: 300, qty: 'auto', shared: false });
  assert.equal(eb.status, 400);
  assert.match(eb.body.error, /At EB Games, Auto-checkout buys only from the 🚨 priority pages/);
  const w = await boss.post('/api/drops', { store: 'demo-pbandai', words: 'one piece card game', aco: true, maxPrice: 300, qty: 'auto', shared: false });
  assert.equal(w.status, 200, w.text);
  assert.equal(w.body.watch.qty, 'auto');
  try {
    // Its first look: what's there already.
    await pbSearch([pbTile('N2000312345', 'ONE PIECE CARD GAME OP-18 Booster Box (24 Packs)', false, 179)]);
    clock.offset += 10 * 1000;
    // OP-20 drops: its box, its hangsell — and a playmat with the words, and a single card.
    await pbSearch([
      pbTile('N2000390001', 'ONE PIECE CARD GAME OP-20 Booster Box', true, 189),
      pbTile('N2000390002', 'ONE PIECE CARD GAME OP-20 Hangsell Booster', true, 8),
      pbTile('N2000390003', 'ONE PIECE CARD GAME Official Playmat OP-20', true, 39),
      pbTile('N2000390004', 'ONE PIECE CARD GAME Monkey.D.Luffy OP20-001 (Parallel) - NM/M', true, 45),
      pbTile('N2000312345', 'ONE PIECE CARD GAME OP-18 Booster Box (24 Packs)', false, 179),
    ]);
    const items = (await boss.get('/api/items')).body.items;
    const by = (sku) => items.find((i) => i.sku === sku.replace(/^39/, 'N200039'));
    assert.ok(by('390001') && by('390002') && by('390003') && by('390004'), JSON.stringify(items.map((i) => i.sku)));
    assert.equal(by('390004').aco, false, 'the single card: found and told, never bought');
    assert.deepEqual([by('390001').aco, by('390001').quantity, by('390001').qtyRule], [true, 1, ''], 'the box: one');
    assert.deepEqual([by('390002').aco, by('390002').quantity, by('390002').qtyRule], [true, 10, 'max'], 'the hangsell: the most the store allows');
    assert.equal(by('390003').aco, false, 'the playmat: found and told, never bought');
    // ⚡ Buy (and Auto-checkout's run): the hangsell opens its own page — the page's quantity and limits decide — and the
    // code tells the extension to take the most; the box, one.
    let go = await boss.post(`/api/items/${by('390002').id}/go`);
    assert.equal(go.status, 200, go.text);
    assert.ok(go.body.url.startsWith(by('390002').url), go.body.url);
    let claim = await device.call('POST', '/api/ext/claim', { code: go.body.url.split('#mgb-go=')[1] });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    assert.deepEqual([claim.body.qtyMax, claim.body.quantity], [true, 10]);
    go = await boss.post(`/api/items/${by('390001').id}/go`);
    claim = await device.call('POST', '/api/ext/claim', { code: go.body.url.split('#mgb-go=')[1] });
    assert.deepEqual([claim.body.qtyMax, claim.body.quantity], [false, 1]);
    // Auto-checkout's run for the most allowed: never past the member's own limits at the price seen (fewer, not skipped),
    // and one from a copy of the extension too old to read a store's limit.
    const aco = env.app.aco;
    const hang = env.app.repo.getItem(boss.user.id, by('390002').id);
    const dev = aco.checkoutDevice(boss.user.id);
    const s = { ...aco.settings(boss.user.id), enabled: true, mode: 'place', maxOrder: 30, spendPerDay: 1000 };
    assert.equal(aco.mostQty(boss.user.id, hang, s, 8, dev), 3, '$30 an order at $8: three');
    assert.equal(aco.mostQty(boss.user.id, hang, { ...s, maxOrder: 500 }, 8, dev), 10, 'room for all: the item\'s most (10)');
    assert.equal(aco.mostQty(boss.user.id, hang, { ...s, maxOrder: 5 }, 8, dev), 1, 'never none');
    assert.equal(aco.mostQty(boss.user.id, hang, { ...s, maxOrder: 500 }, 8, { ...dev, version: '1.39.0' }), 1, 'an older extension: one');
    assert.equal(aco.mostQty(boss.user.id, env.app.repo.getItem(boss.user.id, by('390001').id), s, 189, dev), null, 'the box: not "most"');
  } finally {
    await boss.del(`/api/drops/${w.body.watch.id}`);
    for (const it of (await boss.get('/api/items')).body.items) await boss.del(`/api/items/${it.id}`);
  }
});

test('⚡ Premium Bandai: a new One Piece product in a read — its newest 100 of 240 (not every result) — alerted and its Auto-checkout started in that same read: no second read, no wait', async () => {
  const w = await boss.post('/api/drops', { store: 'demo-pbandai', words: 'one piece card game', aco: true, maxPrice: 300, qty: 'auto', shared: false });
  assert.equal(w.status, 200, w.text);
  assert.equal((await boss.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 3000, perDay: 20, spendPerDay: 20000 })).status, 200);
  const older = Array.from({ length: 100 }, (_, i) => pbTile(`N3000${String(i).padStart(6, '0')}`, `ONE PIECE CARD GAME Older Set ${i} Booster Box`, i % 3 === 0, 150));
  try {
    // Its first look: the newest 100 of 240.
    await pbSearch(older, 'one piece card game', { total: 240, perPage: 100 });
    clock.offset += 30 * 1000;
    const n = env.app.db.get('SELECT COUNT(*) AS n FROM aco_runs').n;
    const dmsBefore = discord.dmsTo('d-boss').length;
    // A new booster box at the top (newest first), the oldest falling off the end.
    const t0 = Date.now();
    await pbSearch([pbTile('N3000999001', 'ONE PIECE CARD GAME OP-21 Booster Box', true, 189), ...older.slice(0, 99)], 'one piece card game', { total: 241, perPage: 100 });
    const ms = Date.now() - t0;
    const it = (await boss.get('/api/items')).body.items.find((x) => x.sku === 'N3000999001');
    assert.ok(it && it.aco, `armed in that read: ${JSON.stringify(it)} ${JSON.stringify(env.app.drops.get(w.body.watch.id).found.slice(-2))}`);
    const runs = env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: it.id });
    assert.equal(runs.length, 1, 'its Auto-checkout started in that same read');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM aco_runs').n, n + 1, 'nothing else bought (what was there already)');
    await env.app.monitor.delivered();
    assert.ok(discord.dmsTo('d-boss').slice(dmsBefore).some((m) => /OP-21 Booster Box/.test(JSON.stringify(m.body))), 'and told');
    assert.ok(ms < 1500, `${ms} ms from the read coming in to the run and the alert`);
  } finally {
    await boss.put('/api/aco', { enabled: false });
    await boss.del(`/api/drops/${w.body.watch.id}`);
    for (const x of (await boss.get('/api/items')).body.items) await boss.del(`/api/items/${x.id}`);
  }
});

test('a store only admins\' browsers search (EB Games, Premium Bandai): unsearched for 3 minutes — shown in the live log (never announced: no DM, no activity entry), and shown again when it\'s searched', async () => {
  const sw = env.app.sweeper;
  const was = { running: sw.running, startedAt: sw.startedAt };
  const dms = () => discord.dmsTo('d-boss');
  try {
    Object.assign(sw, { running: true, startedAt: env.app.repo.now() });
    for (const id of ['demo-ebgames', 'demo-pbandai', 'ebgames', 'pbandai']) Object.assign(sw.stat(id), { lastAt: null, unsearchedSince: 0, heldAt: 0 });
    assert.deepEqual(await sw.watchBlind(), [], 'not yet: 3 minutes to be searched');
    clock.offset += 4 * 60 * 1000;
    const before = dms().length;
    const told = await sw.watchBlind();
    assert.ok(told.some((x) => x.store === 'demo-ebgames' && x.unsearched === true), JSON.stringify(told));
    await env.app.monitor.delivered();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(dms().length, before, 'not announced: no DM');
    assert.ok(!env.app.repo.listEvents(boss.user.id, { limit: 20 }).some((e) => /being searched/.test(e.message)), 'nor an activity entry');
    assert.ok(sw.events.some((e) => e.type === 'sys' && /EB Games \(dummy store\)[^]*isn't being searched|aren't being searched/.test(e.message)), 'shown in the live log');
    assert.deepEqual((await sw.watchBlind()).filter((x) => x.store === 'demo-ebgames'), [], 'once, not every minute');
    // Searched again: told so.
    await ebSearch([ebTile('312345', 'One Piece TCG OP-18 Booster Box (24 Packs)', false, 179)]);
    const back = await sw.watchBlind();
    assert.ok(back.some((x) => x.store === 'demo-ebgames' && x.unsearched === false), JSON.stringify(back));
    assert.equal(dms().length, before, 'still no DM');
  } finally {
    Object.assign(sw, was);
  }
});

test('🏴‍☠️ Premium Bandai\'s keyword search: an order window closed for good ("End") is never a watch\'s find — never armed — and what a watch armed while it was open (sold out then) is disarmed once it closes; one not open yet ("Waiting") is armed', async () => {
  const w = await boss.post('/api/drops', { store: 'demo-pbandai', words: 'one piece card game', aco: true, maxPrice: 300, qty: 'auto', shared: false });
  assert.equal(w.status, 200, w.text);
  const item = async (sku) => (await boss.get('/api/items')).body.items.find((i) => i.sku === sku);
  try {
    // Its first look: a box whose window closed for good, one whose window opens next week, one open but sold out.
    await pbSearch([
      { ...pbTile('N4000000001', 'ONE PIECE CARD GAME OP-16 Booster Box', false, 179), ended: true },
      { ...pbTile('N4000000002', 'ONE PIECE CARD GAME OP-22 Booster Box', false, 189), opensAt: Date.now() + 7 * 86400000 },
      pbTile('N4000000003', 'ONE PIECE CARD GAME OP-17 Booster Box', false, 179),
    ]);
    assert.equal((await item('N4000000001')) && (await item('N4000000001')).aco, undefined, 'closed for good: never armed');
    assert.equal((await item('N4000000002')).aco, true, 'not open yet: armed');
    assert.equal((await item('N4000000003')).aco, true, 'sold out in its window: armed for its return');
    // The sold-out one\'s window closes: disarmed (it can\'t come back), the member told.
    clock.offset += 10 * 1000;
    await pbSearch([
      { ...pbTile('N4000000001', 'ONE PIECE CARD GAME OP-16 Booster Box', false, 179), ended: true },
      { ...pbTile('N4000000002', 'ONE PIECE CARD GAME OP-22 Booster Box', false, 189), opensAt: Date.now() + 7 * 86400000 },
      { ...pbTile('N4000000003', 'ONE PIECE CARD GAME OP-17 Booster Box', false, 179), ended: true },
    ]);
    assert.equal((await item('N4000000003')).aco, false, 'disarmed');
    assert.equal((await item('N4000000002')).aco, true, 'the one not open yet: still armed');
    assert.ok(env.app.repo.listEvents(boss.user.id, { limit: 10 }).some((e) => /OP-17 Booster Box.*order window has closed/.test(e.message)));
  } finally {
    await boss.del(`/api/drops/${w.body.watch.id}`);
    for (const it of (await boss.get('/api/items')).body.items) await boss.del(`/api/items/${it.id}`);
  }
});
