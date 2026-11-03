// The owner's rules for Auto-checkout (Nov 2026), after an individual card was armed at EB Games:
// - Never an individual card (already unpacked: "… OP01-079 - NM/M") — whatever watch finds it, at any store; told, not bought.
// - At EB Games, Auto-checkout buys what a watch finds only from the 🚨 priority pages (the preset's three: One Piece
//   pre-orders; Pokémon pre-orders — boosters, collections, decks; every One Piece product, for "one piece booster").
//   A keyword watch, or an ordinary page watch, there alerts only. (A product's own link: as its member chose.)
// - What's already set up in production brought to that, once, when the server starts (Drops.upgradePresets).
// Against the dummy EB Games — tests never touch real stores.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { isSealed, isSingle, typeOf } from '../server/monitor/classify.js';
import { EB_PAGES, ebPageOf } from '../server/monitor/drops.js';
import { item as checkItem } from '../server/schema.js';

test('an individual card, from the names stores give them — and never a sealed product, nor anything that isn\'t a card game\'s', () => {
  const singles = [
    'One Piece - TCG - One Piece Promotion Cards - Ms. All Sunday (Promotion Pack 2023) Normal OP01-079 - NM/M',
    "One Piece - TCG - Adventure on Kami's Island - Borsalino Foil EB04-058 - NM/M",
    'One Piece - TCG - Booster Pack Promo Monkey D. Luffy OP05-119 - NM/M',
    'ONE PIECE CARD GAME Monkey.D.Luffy OP20-001 (Parallel)',
    'One Piece TCG Roronoa Zoro ST01-013 Super Rare',
    'Pokemon Charizard ex 199/165 - Near Mint',
    'Pokemon TCG Pikachu SVP 045',
    'Pokemon TCG Iono 237/091 - LP',
    'Pokemon TCG Umbreon VMAX TG23/TG30',
    'Pokemon TCG Mew ex PSA 10',
    'Magic the Gathering Single - Black Lotus (Lightly Played)',
  ];
  for (const n of singles) {
    assert.equal(isSingle(n), true, n);
    assert.equal(typeOf(n), 'single', n);
    assert.equal(isSealed(n), false, n);
  }
  const sealed = [
    ['One Piece TCG OP-19 Hangsell Booster', 'hangsell'], ['One Piece TCG EB-05 Booster', 'booster_pack'], ['One Piece TCG OP-10 Booster Box', 'booster_box'],
    ['One Piece TCG ST-21 Starter Deck', 'starter_deck'], ['ONE PIECE CARD GAME PREMIUM BOOSTER -THE BEST vol.2- [PRB-02] (BOX)', 'booster_box'],
    ['One Piece Card Game Double Pack Set Vol.8', 'booster_pack'], ['Pokemon TCG Scarlet & Violet Prismatic Evolutions Elite Trainer Box', 'elite_trainer_box'],
    ['Pokemon TCG Mega Evolution Booster Bundle', 'booster_bundle'], ['Pokemon TCG Mega Evolution 3 Pack Blister', 'blister'], ['Pokemon TCG Pokeball Tin', 'tin'],
    ['Pokemon TCG Mega Evolution Ex Battle Deck', 'starter_deck'], ['Pokemon TCG Build & Battle Box', 'collection'], ['Pokemon TCG Single Booster Pack', 'booster_pack'],
    ['Pokemon TCG Mega Evolution Binder Collection', 'collection'], ['Pokemon TCG 151 Poster Collection', 'collection'], ['Pokemon TCG Sleeved Booster', 'booster_pack'],
    ['One Piece Card Game Illustration Box Vol.3', 'collection'], ['Pokémon TCG: Mega Evolution Booster Box (36 Packs) 1/2 case', 'booster_box'],
  ];
  for (const [n, t] of sealed) {
    assert.equal(isSingle(n), false, n);
    assert.equal(typeOf(n), t, n);
    assert.equal(isSealed(n), true, n);
  }
  for (const n of ['One Piece Card Game Official Sleeves Pack', 'Pokemon TCG Playmat', 'Ultra Pro Pokemon Deck Box', 'One Piece Card Game 9-Pocket Binder']) assert.equal(typeOf(n), 'accessory', n);
  // Not a card game's: never taken for a card ("Single", "- HP", "3/4").
  for (const n of ['Breville Single Serve Coffee Maker', 'Omen Gaming Laptop - HP', 'Single Duvet Cover', 'Sony 3/4 Zip Hoodie', 'Graded Weight Set 10/20 kg']) assert.equal(isSingle(n), false, n);
});

test("which of the preset's EB Games pages a link is, its filters in any order", () => {
  const base = 'https://www.ebgames.com.au';
  assert.equal(ebPageOf(`${base}${EB_PAGES.onepiece}`), 'onepiece');
  assert.equal(ebPageOf(`${base}${EB_PAGES.pokemon}`), 'pokemon');
  assert.equal(ebPageOf(`${base}${EB_PAGES.boosters}`), 'boosters');
  assert.equal(ebPageOf(`${base}/search?category=trading-cards&subcategory=trading-cards-one-piece&condition=preorder`), 'onepiece');
  assert.equal(ebPageOf(`${base}/search?condition=preorder&attributes=trading-card-type%3Aboosters&subcategory=trading-cards-pokemon&category=trading-cards`), 'pokemon-old');
  assert.equal(ebPageOf(`${base}/search?q=one+piece&category=trading-cards`), '');
  assert.equal(ebPageOf('not a link'), '');
});

// --- against the app -------------------------------------------------------------------------------------------------
let env;
let store;
let discord;
let boss;
let ash;
before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  for (const c of [boss, ash]) {
    makeMember(env, c);
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
    assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 3000, perDay: 20, spendPerDay: 20000 })).status, 200);
    env.app.repo.addDevice(c.user.id, 'Chrome on Mac', '1.42.0');
  }
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-ebgames': 'browser', 'demo-jbhifi': 'auto' } })).status, 200);
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const drops = () => env.app.drops;
const EB = () => env.app.retailers.get('demo-ebgames');
const events = (c) => env.app.repo.listEvents(c.user.id, { limit: 30 }).map((e) => e.message);

test('🛑 at EB Games a keyword watch, or an ordinary page watch, can\'t Auto-checkout (alerts only — the priority pages buy); elsewhere it can; and a keyword watch at every store never buys at EB Games', async () => {
  let r = await ash.post('/api/drops', { store: 'demo-ebgames', words: 'one piece tcg', aco: true, maxPrice: 100 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /^At EB Games, Auto-checkout buys only from the 🚨 priority pages/);
  r = await ash.post('/api/drops', { page: `${EB().base}/search?category=trading-cards&condition=new`, phrases: ['one piece'], aco: true, maxPrice: 100 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /priority pages/);
  // Alerts only: fine — and its Auto-checkout can't be turned on later.
  r = await ash.post('/api/drops', { store: 'demo-ebgames', words: 'one piece tcg' });
  assert.equal(r.status, 200, r.text);
  const own = r.body.watch;
  r = await ash.put(`/api/drops/${own.id}`, { aco: true, maxPrice: 100 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /priority pages/);
  await ash.del(`/api/drops/${own.id}`);
  // A keyword watch at every store: may buy elsewhere, never at EB Games — and never a single card anywhere.
  const all = { id: 'x', store: 'all', words: 'one piece', url: '', priority: false, qty: '1', aco: true, maxPrice: 100 };
  assert.equal(drops().mayBuy(all, 'One Piece TCG OP-15 Booster Box', 'demo-ebgames'), false);
  assert.equal(drops().mayBuy(all, 'One Piece TCG OP-15 Booster Box', 'demo-jbhifi'), true);
  assert.equal(drops().mayBuy(all, 'One Piece - TCG - Ms. All Sunday OP01-079 - NM/M', 'demo-jbhifi'), false);
  // A priority page: anything but a single card or an accessory. A link watch's own product: as chosen.
  const prio = { ...all, store: 'demo-ebgames', priority: true };
  assert.equal(drops().mayBuy(prio, 'One Piece Card Game Illustration Box Vol.3'), true);
  assert.equal(drops().mayBuy(prio, 'One Piece TCG Official Playmat'), false);
  assert.equal(drops().mayBuy(prio, 'One Piece - TCG - Ms. All Sunday OP01-079 - NM/M'), false);
  assert.equal(drops().mayBuy({ ...all, store: 'demo-ebgames', url: 'https://x' }, 'One Piece - TCG - Ms. All Sunday OP01-079 - NM/M'), true);
});

/** An item on someone's watchlist, armed — by this drop watch's find (null: by the member). */
function armed(c, sku, name, watchId = null, store = 'demo-ebgames') {
  const r = env.app.retailers.get(store);
  const url = store === 'demo-ebgames' ? `${r.base}/product/toys-and-collectibles/${sku}-x` : `${r.base}/products/${sku}`;
  const it = env.app.repo.addItem(c.user.id, checkItem({ url, sku, name, maxPrice: 300, aco: true, monitor: true }, { retailers: env.app.retailers, isAdmin: false }));
  if (watchId) env.app.db.run('UPDATE items SET drop_watch = :w WHERE id = :id', { w: watchId, id: it.id });
  return env.app.db.get('SELECT * FROM items WHERE id = :i', { i: it.id });
}

test('🛑 Auto-checkout, at the last step, never starts on a watch\'s find it may not buy — a single card (any store), or at EB Games anything but a priority page\'s: disarmed, and the member told why. Their own arming, a link watch\'s, or ⚡ Buy: as they chose', async () => {
  // (Old watches, as production had them before: an EB Games keyword watch with Auto-checkout on, and a JB Hi-Fi one.)
  const t = Date.now();
  for (const [id, store, wds] of [['drp_oldeb', 'demo-ebgames', 'one piece tcg'], ['drp_oldjb', 'demo-jbhifi', 'one piece']]) {
    env.app.db.run(`INSERT INTO drop_watches (id, user_id, shared, store, words, label, aco, max_price, qty, created_at) VALUES (:id, :u, 0, :s, :w, 'old', 1, 300, 'auto', :t)`, { id, u: ash.user.id, s: store, w: wds, t });
  }
  drops().changed();
  const aco = env.app.aco;
  const single = armed(ash, '381001', 'One Piece - TCG - One Piece Promotion Cards - Ms. All Sunday (Promotion Pack 2023) Normal OP01-079 - NM/M', 'drp_oldjb', 'demo-jbhifi');
  let run = await aco.trigger(single, { status: 'in_stock', price: 17 });
  assert.deepEqual([run.status, run.reason], ['skipped', 'single']);
  assert.equal(env.app.repo.getItem(ash.user.id, single.id).aco, false, 'disarmed');
  const box = armed(ash, '381002', 'One Piece TCG OP-15 Booster Box', 'drp_oldeb');
  run = await aco.trigger(box, { status: 'preorder', price: 239 });
  assert.deepEqual([run.status, run.reason], ['skipped', 'eb_priority']);
  assert.equal(env.app.repo.getItem(ash.user.id, box.id).aco, false, 'disarmed');
  // His own arming of the same kind of product (no watch): as he chose — its run is made.
  const mine = armed(ash, '381003', 'One Piece TCG OP-16 Booster Box');
  run = await aco.trigger(mine, { status: 'preorder', price: 239 });
  assert.notEqual(run && run.reason, 'eb_priority');
  assert.ok(run && run.status !== 'skipped', JSON.stringify(run));
  // An EB Games keyword watch's find he armed himself, later (not the find's own arming): as he chose — its run is made.
  const later = armed(ash, '381005', 'One Piece TCG OP-17 Booster Box', 'drp_oldeb');
  env.app.db.run('UPDATE items SET aco_at = created_at + 60000 WHERE id = :i', { i: later.id });
  run = await aco.trigger(env.app.db.get('SELECT * FROM items WHERE id = :i', { i: later.id }), { status: 'preorder', price: 239 });
  assert.ok(run && run.status !== 'skipped', `his own arming: ${JSON.stringify(run)}`);
  // ⚡ Buy on a single (pressed by the member): as they chose.
  const pressed = armed(ash, '381004', 'One Piece - TCG - Borsalino Foil EB04-058 - NM/M', 'drp_oldeb');
  run = await aco.trigger(pressed, { status: 'in_stock', price: 30, manual: true });
  assert.ok(run && run.reason !== 'single' && run.reason !== 'eb_priority', JSON.stringify(run));
  await env.app.monitor.delivered();
  for (const id of ['drp_oldeb', 'drp_oldjb']) env.app.db.run('DELETE FROM drop_watches WHERE id = :id', { id });
  for (const it of (await ash.get('/api/items')).body.items) await ash.del(`/api/items/${it.id}`);
  env.app.db.run("DELETE FROM aco_runs WHERE user_id = :u", { u: ash.user.id });
  drops().changed();
});

test('⬆️ what production has set up, brought to the owner\'s rules when the server starts — once: the preset\'s pages to the new links (newest first; Pokémon boosters, collections and decks, every product), the One Piece boosters page added (as the admin\'s One Piece page is set, with its members\' Auto-checkout), the old EB Games keyword watches\' Auto-checkout off and what they armed disarmed, any single card armed by a search disarmed — each told', async () => {
  const base = EB().base;
  const t = Date.now();
  const ins = (row) => env.app.db.run(`INSERT INTO drop_watches (id, user_id, shared, store, words, url, label, category, aco, max_price, qty, channel_id, role_id, page, phrases, every_seconds, min_price, priority, created_at)
    VALUES (:id, :u, :shared, :store, :words, '', :label, :cat, :aco, :max, :qty, :ch, :role, :page, :phrases, :every, :min, :prio, :t)`, {
    shared: 0, words: '', cat: 'nontcg', aco: 0, max: null, qty: '1', ch: '', role: '', page: '', phrases: '[]', every: 0, min: null, prio: 0, t, ...row,
  });
  // As 2.2 set them up.
  ins({ id: 'drp_op', u: boss.user.id, shared: 1, store: 'demo-ebgames', label: 'EB Games One Piece pre-orders', cat: 'onepiece', aco: 1, max: 280, qty: 'max', ch: 'c-1', role: 'r-1', page: `${base}/search?category=trading-cards&subcategory=trading-cards-one-piece&condition=preorder`, every: 3, min: 20, prio: 1 });
  ins({ id: 'drp_pk', u: boss.user.id, shared: 1, store: 'demo-ebgames', label: 'EB Games Pokémon booster pre-orders', cat: 'pokemon', qty: 'max', page: `${base}/search?category=trading-cards&subcategory=trading-cards-pokemon&attributes=trading-card-type%3Aboosters&condition=preorder`, phrases: '["booster","blister"]', every: 3, min: 20, prio: 1 });
  // The old One Piece preset's EB Games keyword watch, Auto-checkout on — and its Premium Bandai one.
  ins({ id: 'drp_kw', u: boss.user.id, store: 'demo-ebgames', words: 'one piece tcg', label: 'One Piece drops — EB Games (dummy store)', aco: 1, max: 300, qty: 'auto' });
  ins({ id: 'drp_pb', u: boss.user.id, store: 'demo-pbandai', words: 'one piece card game', label: 'One Piece drops — Premium Bandai (dummy store)', aco: 1, max: 300, qty: 'auto' });
  // Ash's Auto-checkout of the One Piece page.
  env.app.db.run(`INSERT INTO watch_follows (watch_id, user_id, aco, max_price, qty, mute, agreed_at, updated_at) VALUES ('drp_op', :u, 1, 250, 'max', 0, :t, :t)`, { u: ash.user.id, t });
  drops().changed();
  // What the keyword watch armed (a sealed product, at EB Games), and the single card it armed.
  const sealed = armed(boss, '382001', 'One Piece TCG OP-14 Booster Box', 'drp_kw');
  const single = armed(boss, '382002', 'One Piece - TCG - One Piece Promotion Cards - Ms. All Sunday (Promotion Pack 2023) Normal OP01-079 - NM/M', 'drp_kw');
  const pbFind = armed(boss, 'N2000382003', 'ONE PIECE CARD GAME OP-15 Booster Box', 'drp_pb', 'demo-pbandai');
  const own = armed(boss, '382004', 'One Piece TCG OP-13 Booster Box');
  // (Found by the keyword watch, armed by him later: his.)
  const later = armed(boss, '382005', 'One Piece TCG OP-12 Booster Box', 'drp_kw');
  env.app.db.run('UPDATE items SET aco_at = created_at + 60000 WHERE id = :i', { i: later.id });

  env.app.repo.setSetting('ebPresetsVersion', 0);
  drops().upgradePresets();
  const w = (id) => drops().get(id);
  assert.equal(w('drp_op').page, `${base}${EB_PAGES.onepiece}`);
  assert.equal(w('drp_pk').page, `${base}${EB_PAGES.pokemon}`);
  assert.deepEqual([w('drp_pk').phrases, w('drp_pk').label], [[], 'EB Games Pokémon pre-orders (boosters, collections, decks)']);
  const added = drops().watches().filter((x) => x.userId === boss.user.id && x.page === `${base}${EB_PAGES.boosters}`);
  assert.equal(added.length, 1, 'the One Piece boosters page added');
  const b = added[0];
  assert.deepEqual([b.priority, b.shared, b.phrases, b.minPrice, b.qty, b.channelId, b.roleId, b.every, b.category, b.aco, b.maxPrice], [true, true, ['one piece booster'], 20, 'max', 'c-1', 'r-1', 3, 'onepiece', true, 280], "as his One Piece page is set — his own Auto-checkout of it too");
  const f = env.app.db.get('SELECT * FROM watch_follows WHERE watch_id = :w AND user_id = :u', { w: b.id, u: ash.user.id });
  assert.deepEqual([f.aco, f.max_price, f.qty], [1, 250, 'max'], "Ash's Auto-checkout of it: as he has it for One Piece pre-orders");
  assert.ok(events(ash).some((m) => /EB Games One Piece boosters: your Auto-checkout of One Piece pre-orders covers EB Games' new One Piece boosters too \(up to \$250\.00 each\)/.test(m)));
  // The keyword watch: alerts only; what it armed at EB Games, disarmed; the single card too. Premium Bandai's: as it was.
  assert.equal(w('drp_kw').aco, false);
  assert.equal(w('drp_pb').aco, true, "Premium Bandai's keyword watch keeps its Auto-checkout");
  const item = (it) => env.app.repo.getItem(boss.user.id, it.id);
  assert.equal(item(sealed).aco, false);
  assert.equal(item(single).aco, false);
  assert.equal(item(pbFind).aco, true, "Premium Bandai's find: still armed");
  assert.equal(item(own).aco, true, 'his own arming: untouched');
  assert.equal(item(later).aco, true, 'a find he armed himself later: untouched');
  const said = events(boss);
  assert.ok(said.some((m) => /Drop watch "One Piece drops — EB Games \(dummy store\)": its Auto-checkout is off/.test(m)), JSON.stringify(said));
  assert.ok(said.some((m) => /Ms\. All Sunday.*Auto-checkout disarmed — it's an individual card/.test(m)));
  assert.ok(said.some((m) => /OP-14 Booster Box: Auto-checkout disarmed — at EB Games, Auto-checkout now buys only from the 🚨 priority pages/.test(m)));
  // Once: started again, nothing changes — and even asked again, no second page.
  const n = drops().watches().length;
  drops().upgradePresets();
  env.app.repo.setSetting('ebPresetsVersion', 0);
  drops().upgradePresets();
  assert.equal(drops().watches().length, n);
  assert.equal(env.app.db.all('SELECT * FROM watch_follows WHERE watch_id = :w', { w: b.id }).length, 1);
});
