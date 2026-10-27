// Drop watches (docs/MONITORING.md → Drop watches): anything outside the card keywords — by its link
// or the words in its name, at a store Mugibot knows or any other website. An admin's are for
// everyone (#non-tcg-alerts, every dashboard); a member's own are theirs alone (their watchlist and
// DMs). Auto-checkout where Mugibot has a checkout; alerts only at other websites. Against the
// dummy stores and the dummy "other website" (Acme Collectibles) — tests never touch real stores.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, discordOpts, makeMember, startApp, startFakeDiscord, waitFor } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { hasWords, otherSku } from '../server/monitor/drops.js';
import { NEWEST } from '../server/monitor/sweep.js';
import { item as checkItem } from '../server/schema.js';

let env;
let store;
let discord;
let boss;
let ash;
let misty;
let clock;
const ch = {};

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  clock = { offset: 0 };
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, now: () => Date.now() + clock.offset, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  misty = await Client.signup(env.url, 'misty');
  for (const [c, d] of [[boss, 'd-boss'], [ash, 'd-ash'], [misty, 'd-misty']]) {
    makeMember(env, c);
    env.app.repo.updateUser(c.user.id, { discord_id: d });
    for (const it of (await c.get('/api/items')).body.items) await c.del(`/api/items/${it.id}`);
    // Auto-checkout on, with a browser listening.
    assert.equal((await c.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 2000, perDay: 10, spendPerDay: 20000 })).status, 200);
    env.app.repo.addDevice(c.user.id, 'Chrome on Mac', '1.16.0');
  }
  // JB Hi-Fi's dummy copy searched from the server, EB Games' from an admin's browser.
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-jbhifi': 'server', 'demo-ebgames': 'browser' } })).status, 200);
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const R = (id) => env.app.retailers.get(id);
const sw = () => env.app.sweeper;
const drops = () => env.app.drops;
const posts = (id) => discord.channelPosts(id);
const dms = (id) => discord.dmsTo(id);
// (Members' DMs go out while the monitor carries on: the ones on their way, out.)
const settle = () => env.app.monitor.delivered();
const buttons = (msg) => (msg.body.components ? msg.body.components[0].components.map((b) => b.label) : []);
const runsFor = (itemId) => env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: itemId });
const channelId = (name) => discord.state.channels.find((c) => c.name === name).id;

test('🎯 #non-tcg-alerts: made with the store channels (and on its own) — what isn\'t trading cards goes there, not a store\'s channel', async () => {
  const r = await boss.post('/api/monitor/routes/setup', {});
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body.channels.some((c) => c.name === 'non-tcg-alerts'));
  Object.assign(ch, { nontcg: channelId('non-tcg-alerts'), jbPokemon: channelId('jbhifi-pokemon'), pc: channelId('pokemon-center'), misc: channelId('misc-retailers') });
  const rule = r.body.routes.find((x) => x.channelId === ch.nontcg);
  assert.deepEqual(rule.categories, ['nontcg']);
  const to = (a) => env.app.feed.routesFor({ kind: 'restock', name: 'Something', ...a }).map((x) => x.channelId);
  assert.deepEqual(to({ store: 'jbhifi', category: 'nontcg' }), [ch.nontcg], 'not #jbhifi-pokemon');
  assert.deepEqual(to({ store: 'pokemoncenter', category: 'nontcg' }), [ch.nontcg], 'not #pokemon-center (which takes every category of its store)');
  assert.deepEqual(to({ store: 'other', category: 'nontcg' }), [ch.nontcg], 'not #misc-retailers');
  assert.deepEqual(to({ store: 'jbhifi', category: 'pokemon' }), [ch.jbPokemon], 'trading cards go where they always did');
  assert.deepEqual(to({ store: 'other', category: 'other' }), [ch.misc]);
  // One click from the drop watches: found by name, its rule kept.
  const one = await boss.post('/api/drops/channel', {});
  assert.equal(one.status, 200, one.text);
  assert.equal(one.body.channel.made, false);
  assert.equal(one.body.rule.id, rule.id);
  assert.equal(one.body.route.name, '#non-tcg-alerts');
  assert.equal((await ash.post('/api/drops/channel', {})).status, 404, 'admins only');
});

test('🎯 an admin\'s link — an Xbox at JB Hi-Fi: monitored for everyone, posted in #non-tcg-alerts with ⚡ Buy, and any member can arm Auto-checkout on it', async () => {
  const XBOX = 'xbox-series-x25-limited-edition-console-1tb';
  const url = store.addProduct('jbhifi', { sku: XBOX, name: 'Xbox Series X|25 Limited Edition Console 1TB', price: 899, status: 'out_of_stock' });
  const r = await boss.post('/api/drops', { url });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.equal(w.kind, 'link');
  assert.equal(w.shared, true, "an admin's watch is for everyone unless they say otherwise");
  assert.equal(w.canBuy, true);
  assert.equal((await boss.post('/api/drops', { url })).status, 400, 'not twice');
  const p = env.app.catalog.productFor('demo-jbhifi', XBOX);
  assert.equal(p.category, 'nontcg');
  assert.equal(env.app.catalog.monitorForProduct(p.id).drop_watch, w.id);
  // Its first check sets the scene (sold out): nothing posted.
  await env.app.monitor.checkPage(url);
  assert.equal(env.app.catalog.productById(p.id).status, 'out_of_stock');
  assert.equal(env.app.catalog.productById(p.id).name, 'Xbox Series X|25 Limited Edition Console 1TB', 'its name from its page');
  assert.equal(posts(ch.nontcg).length, 0);

  // Every member sees it: the admins' watches in their drop watches, the product in Tracked products.
  const view = (await ash.get('/api/drops')).body;
  const shared = view.watches.find((x) => x.id === w.id);
  assert.equal(shared.mine, false);
  assert.equal(shared.canChange, false);
  assert.deepEqual(shared.found.map((f) => [f.name, f.status, f.canBuy]), [['Xbox Series X|25 Limited Edition Console 1TB', 'out_of_stock', true]]);
  const listed = (await ash.get('/api/monitor/products?category=nontcg')).body.products;
  assert.ok(listed.some((x) => x.id === p.id), 'in Tracked products, under Non-TCG');
  // Ash ☆ Watches it and arms Auto-checkout (the usual way: their watchlist).
  const item = (await ash.post('/api/items', { url, sku: XBOX, name: 'Xbox 25', maxPrice: 950, aco: true })).body;
  assert.equal(item.aco, true);
  await env.app.monitor.checkPage(url);

  // In stock: 🟢 in #non-tcg-alerts only (with ⚡ Buy), Ash's own DM, and Ash's Auto-checkout starts.
  store.set('jbhifi', XBOX, { status: 'in_stock' });
  await env.app.monitor.checkPage(url);
  const post = posts(ch.nontcg).at(-1);
  assert.match(post.body.embeds[0].title, /^🟢 In stock: Xbox Series X\|25 Limited Edition Console 1TB/);
  assert.ok(buttons(post).includes('⚡ Buy with Mugibot'));
  assert.equal(post.body.embeds[0].fields.find((f) => f.name === 'Category').value, 'Non-TCG');
  assert.equal(posts(ch.jbPokemon).length, 0, 'not in the store\'s channels');
  assert.equal(posts(ch.misc).length, 0);
  await settle();
  assert.ok(dms('d-ash').some((m) => /In stock: Xbox 25/.test(m.body.embeds[0].title)), 'Ash\'s own DM');
  const runs = runsFor(item.id);
  assert.equal(runs.length, 1, 'Auto-checkout started');
  assert.equal(runs[0].price, 899);
});

test('🎯 an admin\'s words at a store: searched as typed in the sweeps\' turn; what was there is the scene; what drops is posted in #non-tcg-alerts and bought for the admin', async () => {
  const before = posts(ch.nontcg).length;
  store.addProduct('jbhifi', { sku: 'playstation-5-pro-console', name: 'PlayStation 5 Pro Console', price: 1199.95, status: 'in_stock' });
  assert.equal((await boss.post('/api/drops', { store: 'demo-jbhifi', words: 'ps5', aco: true })).status, 400, 'a max price to auto-checkout');
  assert.equal((await boss.post('/api/drops', { store: 'demo-jbhifi', words: 'x' })).status, 400, 'words, not a letter');
  const r = await boss.post('/api/drops', { store: 'demo-jbhifi', words: 'PlayStation 5 Pro!', label: 'PS5 Pro', aco: true, maxPrice: 1300 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.equal(w.words, 'playstation 5 pro');
  assert.equal(w.looked, false);
  const jb = R('demo-jbhifi');

  // Its first search goes first, its words as they are (no "tcg" added, the way card searches are at JB).
  const term = sw().nextTerm(jb);
  assert.deepEqual(term, { keyword: 'playstation 5 pro', page: 1, drop: 'shared' });
  assert.doesNotMatch(sw().urlFor(jb, term.keyword, 1, { vip: true }), /tcg/);
  let s = await sw().sweepTerm(jb, term);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.kept, 1, 'the console with those words (the cards in the results don\'t count)');
  assert.equal(posts(ch.nontcg).length, before, 'listed already: the scene, not a drop');
  const ps5 = env.app.catalog.productFor('demo-jbhifi', 'playstation-5-pro-console');
  assert.equal(ps5.category, 'nontcg');
  assert.equal(env.app.catalog.monitorForProduct(ps5.id).drop_watch, w.id);
  assert.ok(!env.app.repo.itemBySku(boss.user.id, 'demo-jbhifi', 'playstation-5-pro-console'), 'on sale before the watch looked: not armed');
  let view = (await boss.get('/api/drops')).body.watches.find((x) => x.id === w.id);
  assert.equal(view.looked, true);
  assert.deepEqual(view.found.map((f) => [f.name, f.arm]), [['PlayStation 5 Pro Console', 'skipped']]);

  // A new one drops: 🆕 in #non-tcg-alerts, with ⚡ Buy — and the admin's Auto-checkout starts straight away.
  store.addProduct('jbhifi', { sku: 'playstation-5-pro-30th-anniversary', name: 'PlayStation 5 Pro 30th Anniversary Edition', price: 1249.95, status: 'in_stock' });
  s = await sw().sweepTerm(jb, { keyword: 'playstation 5 pro', page: 1, drop: 'shared' });
  assert.equal(s.new, 1, s.error);
  const post = posts(ch.nontcg).at(-1);
  assert.match(post.body.embeds[0].title, /^🆕 New drop: PlayStation 5 Pro 30th Anniversary Edition/);
  assert.ok(buttons(post).includes('⚡ Buy with Mugibot'));
  const item = env.app.repo.itemBySku(boss.user.id, 'demo-jbhifi', 'playstation-5-pro-30th-anniversary');
  assert.equal(item.aco, true);
  assert.equal(item.maxPrice, 1300);
  assert.equal(item.dropWatch, w.id);
  assert.equal(runsFor(item.id).length, 1, 'bought the moment it was found');
  view = (await boss.get('/api/drops')).body.watches.find((x) => x.id === w.id);
  assert.deepEqual(view.found.map((f) => f.arm), ['skipped', 'armed']);

  // After that, the store's searches are shared: one in three at most, each watch's words every 30 s or so.
  clock.offset += 31 * 1000;
  const turns = Array.from({ length: 9 }, () => sw().nextTerm(jb));
  assert.equal(turns.filter((t) => t.drop).length, 1, 'once its turn has come');
  // (…and JB Hi-Fi's newest products, every other search of the rest.)
  assert.ok(turns.filter((t) => !t.drop).every((t) => sw().settings.keywords.includes(t.keyword) || t.keyword === NEWEST), 'the card keywords (and the newest products) keep the rest');
  clock.offset += 31 * 1000;
  const more = Array.from({ length: 3 }, () => sw().nextTerm(jb));
  assert.equal(more.filter((t) => t.drop).length, 1);
});

test("🎯 a drop watch at JB Hi-Fi whose drop JB's newest products show first (before the watch's own search): still a drop — posted, bought for the admin (JB made it after the watch was added) — and the watch's own search doesn't post it again", async () => {
  const jb = R('demo-jbhifi');
  const before = posts(ch.nontcg).length;
  const r = await boss.post('/api/drops', { store: 'demo-jbhifi', words: 'Nintendo Switch 3', label: 'Switch 3', aco: true, maxPrice: 900 });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  // Its first search sets its scene; the newest products' first read sets theirs.
  assert.equal((await sw().sweepTerm(jb, { keyword: 'nintendo switch 3', page: 1, drop: 'shared' })).ok, true);
  assert.equal((await sw().sweepTerm(jb, { keyword: NEWEST, page: 1 })).ok, true);
  // JB makes it and publishes it: the newest products see it first. (Made after the watch was added: a drop for it. One JB
  // made before, published again — JB does that all day — may have been on sale before the watch: never bought on that.)
  store.addProduct('jbhifi', { sku: 'nintendo-switch-3-console-launch-edition', name: 'Nintendo Switch 3 Console Launch Edition', price: 799, status: 'in_stock', createdAt: Date.now() + clock.offset });
  const s = await sw().sweepTerm(jb, { keyword: NEWEST, page: 1 });
  assert.equal(s.ok, true, s.error);
  await waitFor(() => posts(ch.nontcg).length > before, { message: 'posted in #non-tcg-alerts' });
  assert.match(posts(ch.nontcg).at(-1).body.embeds[0].title, /^🆕 New drop: Nintendo Switch 3 Console Launch Edition/);
  const item = env.app.repo.itemBySku(boss.user.id, 'demo-jbhifi', 'nintendo-switch-3-console-launch-edition');
  assert.ok(item && item.aco && item.dropWatch === w.id, 'armed for the admin, as the watch says');
  assert.equal(runsFor(item.id).length, 1, 'bought the moment it was found');
  // The watch's own search finds it known: no second post.
  const n = posts(ch.nontcg).length;
  await sw().sweepTerm(jb, { keyword: 'nintendo switch 3', page: 1, drop: 'shared' });
  assert.equal(posts(ch.nontcg).length, n);
  await boss.del(`/api/drops/${w.id}`);
});

test('🎯 an admin picks the channel a watch for everyone posts in, and the role it pings: its drops and restocks go there instead of #non-tcg-alerts', async () => {
  const DROPS = '800000000000000001';
  discord.state.roles.push({ id: DROPS, name: 'Drop pings', position: 3, permissions: '0' });
  const general = channelId('general');
  // The pickers: the Discord server's text channels (by category) and the roles a post can ping — admins only.
  assert.equal((await ash.get('/api/drops/discord')).status, 404);
  const dest = (await boss.get('/api/drops/discord?fresh=1')).body;
  assert.equal(dest.ready, true);
  assert.deepEqual(dest.channels.find((c) => c.id === general), { id: general, name: 'general', parent: '' });
  assert.deepEqual(dest.channels.find((c) => c.id === ch.nontcg), { id: ch.nontcg, name: 'non-tcg-alerts', parent: 'Mugibot alerts' });
  assert.ok(!dest.channels.some((c) => c.name === 'Mugibot alerts'), 'a category is not a channel');
  assert.deepEqual(dest.roles.map((r) => r.name), ['Drop pings', 'Member'], "not @everyone, nor the bot's own role");
  assert.equal((await boss.get('/api/drops')).body.discord.ready, true);
  assert.equal((await ash.get('/api/drops')).body.discord, undefined);

  // Checked against the server's own.
  const words = { store: 'demo-jbhifi', words: 'meta quest 3', label: 'Quest 3' };
  assert.match((await boss.post('/api/drops', { ...words, channelId: '123456789012345678' })).body.error, /isn't a text channel of the Discord server/);
  assert.match((await boss.post('/api/drops', { ...words, channelId: general, roleId: '999999999999999999' })).body.error, /isn't in the Discord server/);
  assert.match((await boss.post('/api/drops', { ...words, roleId: DROPS })).body.error, /Choose a channel for it to ping that role in/);
  assert.equal((await boss.post('/api/drops', { ...words, channelId: 'general' })).status, 400);
  // A monitor an admin made before on what it'll find: taken on (its alerts go where the watch's do).
  const before = store.addProduct('jbhifi', { sku: 'meta-quest-3-512gb', name: 'Meta Quest 3 512GB', price: 799, status: 'out_of_stock' });
  const m = await boss.post('/api/monitor/monitors', { url: before, note: 'Watching the Quest 3' });
  assert.equal(m.status, 200, m.text);
  const r = await boss.post('/api/drops', { ...words, channelId: general, roleId: DROPS });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.deepEqual([w.channelId, w.roleId], [general, DROPS]);
  assert.equal((await ash.get('/api/drops')).body.watches.find((x) => x.id === w.id).channelId, undefined, 'members never see where it posts');
  const jb = R('demo-jbhifi');
  let s = await sw().sweepTerm(jb, { keyword: 'meta quest 3', page: 1, drop: 'shared' });
  assert.equal(s.ok, true, s.error);
  const console_ = env.app.catalog.productFor('demo-jbhifi', 'meta-quest-3-512gb');
  assert.equal(env.app.catalog.monitorForProduct(console_.id).drop_watch, w.id, 'taken on');

  // A new one drops: in #general, pinging @Drop pings — not #non-tcg-alerts.
  const count = () => ({ general: posts(general).length, nontcg: posts(ch.nontcg).length });
  let was = count();
  store.addProduct('jbhifi', { sku: 'meta-quest-3-asgards-wrath-bundle', name: 'Meta Quest 3 Asgard\'s Wrath Bundle', price: 849, status: 'in_stock' });
  s = await sw().sweepTerm(jb, { keyword: 'meta quest 3', page: 1, drop: 'shared' });
  assert.equal(s.new, 1, s.error);
  assert.deepEqual(count(), { general: was.general + 1, nontcg: was.nontcg });
  let post = posts(general).at(-1);
  assert.match(post.body.embeds[0].title, /^🆕 New drop: Meta Quest 3 Asgard's Wrath Bundle/);
  assert.ok(buttons(post).includes('⚡ Buy with Mugibot'));
  assert.equal(post.body.content, `<@&${DROPS}>`);
  assert.deepEqual(post.body.allowed_mentions.roles, [DROPS]);
  // The console the admin monitored comes back in stock (its page read, a while after the search): there too.
  was = count();
  clock.offset += 3 * 60 * 1000 + 1000;
  store.set('jbhifi', 'meta-quest-3-512gb', { status: 'in_stock' });
  await env.app.monitor.checkPage(before);
  assert.deepEqual(count(), { general: was.general + 1, nontcg: was.nontcg });
  assert.match(posts(general).at(-1).body.embeds[0].title, /^🟢 In stock: Meta Quest 3 512GB/);

  // Changed from the dashboard (admins only): back to the usual channel, and no one pinged.
  assert.equal((await ash.put(`/api/drops/${w.id}`, { channelId: '' })).status, 404, "a member can't");
  assert.match((await boss.put(`/api/drops/${w.id}`, { channelId: '123456789012345678' })).body.error, /isn't a text channel/);
  const u = await boss.put(`/api/drops/${w.id}`, { channelId: '', roleId: '' });
  assert.equal(u.status, 200, u.text);
  assert.deepEqual([u.body.watch.channelId, u.body.watch.roleId], ['', '']);
  assert.ok(env.app.repo.listAudit(20).some((a) => a.action === 'drop-change'));
  was = count();
  store.set('jbhifi', 'meta-quest-3-512gb', { status: 'out_of_stock' });
  await env.app.monitor.checkPage(before);
  clock.offset += 11 * 60 * 1000; // (past the alert cooldown)
  store.set('jbhifi', 'meta-quest-3-512gb', { status: 'in_stock' });
  await env.app.monitor.checkPage(before);
  assert.deepEqual(count(), { general: was.general, nontcg: was.nontcg + 1 }, 'the usual: #non-tcg-alerts');
  assert.equal(posts(ch.nontcg).at(-1).body.content, undefined);

  // Someone's own watch tells them alone: no channel to pick.
  const own = await ash.post('/api/drops', { store: 'demo-jbhifi', words: 'steam deck oled', channelId: general, roleId: DROPS });
  assert.equal(own.status, 200, own.text);
  assert.deepEqual(env.app.db.get('SELECT channel_id, role_id FROM drop_watches WHERE id = :id', { id: own.body.watch.id }), { channel_id: '', role_id: '' });
  assert.match((await ash.put(`/api/drops/${own.body.watch.id}`, { channelId: general })).body.error, /Only an admin's drop watch for everyone posts in a channel/);
  assert.equal((await ash.put(`/api/drops/${own.body.watch.id}`, { label: 'Deck' })).body.watch.label, 'Deck', 'its name, though');
  assert.equal((await ash.del(`/api/drops/${own.body.watch.id}`)).status, 200);

  // Removed: the monitor it made goes; the one the admin made before stays, as it was.
  const bundle = env.app.catalog.productFor('demo-jbhifi', 'meta-quest-3-asgards-wrath-bundle');
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
  assert.equal(env.app.catalog.monitorForProduct(bundle.id), null);
  const kept = env.app.catalog.monitorForProduct(console_.id);
  assert.ok(kept, "the admin's own monitor stays");
  assert.equal(kept.drop_watch, null);
  assert.equal(kept.note, 'Watching the Quest 3');
});

test('🎯 a member\'s own words: what has them goes on their watchlist — theirs alone, DM\'d when it comes back or drops, with Auto-checkout — never posted for everyone', async () => {
  const before = { nontcg: posts(ch.nontcg).length, dms: dms('d-ash').length };
  store.addProduct('jbhifi', { sku: 'nintendo-switch-2-console', name: 'Nintendo Switch 2 Console', price: 699, status: 'out_of_stock' });
  const r = await ash.post('/api/drops', { store: 'demo-jbhifi', words: 'nintendo switch 2', aco: true, maxPrice: 700, shared: true });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.equal(w.shared, false, 'members\' watches are their own');
  assert.equal(w.mine, true);
  const jb = R('demo-jbhifi');
  const term = sw().nextTerm(jb);
  assert.deepEqual(term, { keyword: 'nintendo switch 2', page: 1, drop: 'private' });
  const s = await sw().sweepTerm(jb, term);
  assert.equal(s.ok, true, s.error);
  // On Ash's watchlist (sold out now, so armed: its return is a drop), nobody else's — and not in the shared catalogue.
  const item = env.app.repo.itemBySku(ash.user.id, 'demo-jbhifi', 'nintendo-switch-2-console');
  assert.ok(item, 'on the watchlist');
  assert.equal(item.status, 'out_of_stock');
  assert.equal(item.aco, true);
  assert.equal(item.dropWatch, w.id);
  assert.equal(env.app.catalog.productFor('demo-jbhifi', 'nintendo-switch-2-console'), null, 'not in anyone else\'s Tracked products');
  assert.equal(posts(ch.nontcg).length, before.nontcg);
  await settle();
  assert.equal(dms('d-ash').length, before.dms, 'what was there already: no DM');
  // Others never see it — nor its words in the live searches.
  assert.ok(!(await misty.get('/api/drops')).body.watches.some((x) => x.id === w.id));
  const misLive = (await misty.get('/api/monitor/live')).body.events.filter((e) => e.drop === 'private');
  assert.ok(misLive.length && misLive.every((e) => e.keyword === 'a drop watch'));
  assert.ok((await boss.get('/api/monitor/live')).body.events.some((e) => e.keyword === 'nintendo switch 2'), 'admins see what was searched');
  assert.equal((await misty.del(`/api/drops/${w.id}`)).status, 404, 'nor remove it');

  // Back in stock: Ash's DM, and Ash's Auto-checkout starts.
  store.set('jbhifi', 'nintendo-switch-2-console', { status: 'in_stock' });
  assert.equal((await ash.post(`/api/drops/${w.id}/check`, {})).status, 200);
  assert.deepEqual(sw().nextTerm(jb), { keyword: 'nintendo switch 2', page: 1, drop: 'private' }, 'Check now: its words next');
  await sw().sweepTerm(jb, { keyword: 'nintendo switch 2', page: 1, drop: 'private' });
  await settle();
  assert.ok(dms('d-ash').some((m) => /🟢 In stock: Nintendo Switch 2 Console/.test(m.body.embeds[0].title)));
  assert.equal(runsFor(item.id).length, 1);
  // Something new with the words drops: on the watchlist, DM'd and bought at once (under the max price).
  store.addProduct('jbhifi', { sku: 'nintendo-switch-2-mario-kart-bundle', name: 'Nintendo Switch 2 Mario Kart World Bundle', price: 689, status: 'in_stock' });
  await sw().sweepTerm(jb, { keyword: 'nintendo switch 2', page: 1, drop: 'private' });
  const bundle = env.app.repo.itemBySku(ash.user.id, 'demo-jbhifi', 'nintendo-switch-2-mario-kart-bundle');
  assert.equal(bundle.aco, true);
  assert.equal(runsFor(bundle.id).length, 1, 'bought by the time the search is done');
  await settle();
  assert.ok(dms('d-ash').some((m) => /Nintendo Switch 2 Mario Kart World Bundle/.test(m.body.embeds[0].title)));
  assert.equal(runsFor(bundle.id).length, 1);
  assert.equal(posts(ch.nontcg).length, before.nontcg, 'never posted for everyone');
  // Removed: what it put on the watchlist goes with it.
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
  assert.equal(env.app.repo.getItem(ash.user.id, item.id), null);
  assert.equal(env.app.repo.getItem(ash.user.id, bundle.id), null);
});

test('🔑 key phrases pasted at once, watched at every store Mugibot searches: each store\'s own first look is its "before"; a new listing with the phrase is DM\'d — found by the phrase\'s own search or by a card search first — and bought within the max price', async () => {
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-jbhifi': 'server', 'demo-ebgames': 'browser', 'demo-pokebox': 'server' } })).status, 200);
  try {
    store.addProduct('jbhifi', { sku: 'pokemon-heavy-hitters-premium', name: 'Pokemon TCG: Heavy Hitters Premium Collection', price: 89, status: 'in_stock' });
    store.addProduct('pokebox', { sku: 'pb-heavy-hitters-premium', name: 'Pokemon TCG: Heavy Hitters Premium Collection', price: 95, status: 'out_of_stock' });
    const dmsBefore = dms('d-ash').length;
    // Two pasted at once — and one twice, and one too short: said beside it, the rest added.
    const r = await ash.post('/api/drops', { phrases: ['Heavy Hitters Premium', 'Ascended Heroes ETB', 'Heavy Hitters Premium', 'x'], store: 'all', aco: true, maxPrice: 120 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.added.map((w) => [w.words, w.store, w.storeName]), [['heavy hitters premium', 'all', 'every store'], ['ascended heroes etb', 'all', 'every store']]);
    assert.deepEqual(r.body.errors.map((x) => x.phrase), ['x']);
    const w = r.body.added[0];
    const jb = R('demo-jbhifi');
    const pb = R('demo-pokebox');
    // Each store's first look, at its own next search: what's listed there already is the "before" — on the watchlist, no DM.
    assert.deepEqual(sw().nextTerm(jb), { keyword: 'heavy hitters premium', page: 1, drop: 'private' });
    assert.equal((await sw().sweepTerm(jb, { keyword: 'heavy hitters premium', page: 1, drop: 'private' })).ok, true);
    assert.deepEqual(sw().nextTerm(pb), { keyword: 'heavy hitters premium', page: 1, drop: 'private' }, 'Pokébox has its own first look');
    assert.equal((await sw().sweepTerm(pb, { keyword: 'heavy hitters premium', page: 1, drop: 'private' })).ok, true);
    const atJb = env.app.repo.itemBySku(ash.user.id, 'demo-jbhifi', 'pokemon-heavy-hitters-premium');
    const atPb = env.app.repo.itemBySku(ash.user.id, 'demo-pokebox', 'pb-heavy-hitters-premium');
    assert.ok(atJb && atPb, 'both on the watchlist, from both stores');
    assert.equal(atJb.aco, false, 'on sale already when the watch first looked: not armed');
    assert.equal(atPb.aco, true, 'sold out when it first looked: armed for its return');
    await settle();
    assert.equal(dms('d-ash').length, dmsBefore, 'what was listed already: no DM');
    const stored = drops().get(w.id);
    assert.ok(stored.bases['demo-jbhifi'] && stored.bases['demo-pokebox'], JSON.stringify(stored.bases));
    // A new listing with the phrase at Pokébox, seen first by its card search ("pokemon" — after its own first read, which
    // sets its scene): a drop all the same — DM'd, armed, bought.
    assert.equal((await sw().sweepTerm(pb, { keyword: 'pokemon', page: 1 })).ok, true);
    await settle();
    assert.equal(dms('d-ash').length, dmsBefore, 'the card search\'s first read: nothing new');
    store.addProduct('pokebox', { sku: 'pb-heavy-hitters-premium-box', name: 'Pokemon TCG: Heavy Hitters Premium Collection Box', price: 110, status: 'in_stock' });
    assert.equal((await sw().sweepTerm(pb, { keyword: 'pokemon', page: 1 })).ok, true);
    const fresh = env.app.repo.itemBySku(ash.user.id, 'demo-pokebox', 'pb-heavy-hitters-premium-box');
    assert.ok(fresh, 'on the watchlist');
    assert.equal(fresh.aco, true);
    await settle();
    assert.ok(dms('d-ash').slice(dmsBefore).some((m) => /Heavy Hitters Premium Collection Box/.test(m.body.embeds[0].title)), 'DM\'d at once');
    assert.equal(runsFor(fresh.id).length, 1, 'Auto-checkout started');
    // The phrase's own search there next: nothing new (it's found already).
    const n = dms('d-ash').length;
    await sw().sweepTerm(pb, { keyword: 'heavy hitters premium', page: 1, drop: 'private' });
    await settle();
    assert.equal(dms('d-ash').length, n);
    // Shown as watched at every store.
    const mine = (await ash.get('/api/drops')).body.watches.find((x) => x.id === w.id);
    assert.equal(mine.storeName, 'every store');
    assert.equal(mine.canBuy, true);
    for (const x of r.body.added) assert.equal((await ash.del(`/api/drops/${x.id}`)).status, 200);
  } finally {
    assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-jbhifi': 'server', 'demo-ebgames': 'browser' } })).status, 200);
  }
});

test('🎯 a link at another website: its page read for stock, the member DM\'d when it\'s back — alerts only (no ⚡ Buy, no Auto-checkout there)', async () => {
  const url = store.acmeUrl('xbox-series-x-console-1tb');
  const no = await ash.post('/api/drops', { url, aco: true, maxPrice: 900 });
  assert.equal(no.status, 400);
  assert.match(no.body.error, /Auto-checkout works at stores Mugibot has a checkout for/);
  const r = await ash.post('/api/drops', { url, label: 'Xbox from Acme' });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.equal(w.store, 'other');
  assert.equal(w.canBuy, false);
  assert.equal(w.storeName, new URL(store.url).host);
  const item = env.app.repo.itemBySku(ash.user.id, 'other', otherSku(url));
  assert.ok(item, 'on the watchlist');
  assert.equal(item.sku, `${new URL(store.url).host}/xbox-series-x-console-1tb`, 'its code says which website');
  assert.equal(item.name, 'Xbox from Acme');
  const before = dms('d-ash').length;
  await env.app.monitor.checkPage(url);
  assert.equal(env.app.repo.getItem(ash.user.id, item.id).status, 'out_of_stock');
  await settle();
  assert.equal(dms('d-ash').length, before, 'sold out: nothing to say');
  store.setAcme('xbox-series-x-console-1tb', { status: 'in_stock' });
  await env.app.monitor.checkPage(url);
  await settle();
  const dm = dms('d-ash').at(-1);
  assert.match(dm.body.embeds[0].title, /^🟢 In stock: Xbox from Acme/);
  assert.ok(!buttons(dm).includes('⚡ Buy'), 'no ⚡ Buy at another website');
  assert.ok(buttons(dm).includes('Open product'));
  assert.match(dm.body.embeds[0].description, new RegExp(`${new URL(store.url).host.replace('.', '\\.')}`));
  assert.match(dm.body.embeds[0].description, /Open the product to buy it there/);
  assert.equal(runsFor(item.id).length, 0);
  const listed = (await ash.get('/api/items')).body.items.find((x) => x.id === item.id);
  assert.equal(listed.acoCan, false);
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test('🎯 another website (a Garmin, say): your own watch tells you when it drops, comes back, opens for pre-order — or gets cheaper (📉) — by DM, alerts only', async () => {
  // (A watch on the dummy "other website": its page's own JSON-LD says the price and the stock.)
  store.state.acme.products.push({ handle: 'garmin-forerunner-265', name: 'Garmin Forerunner 265 GPS Smartwatch', price: 649, status: 'in_stock', listed: false });
  const url = store.acmeUrl('garmin-forerunner-265');
  const r = await ash.post('/api/drops', { url, label: 'Garmin Forerunner 265' });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.equal(w.store, 'other');
  const item = env.app.repo.itemBySku(ash.user.id, 'other', otherSku(url));
  const row = () => env.app.db.get('SELECT * FROM items WHERE id = :id', { id: item.id });
  const n0 = dms('d-ash').length;
  const last = () => dms('d-ash').at(-1);
  // Not up yet (its page isn't there): nothing to say. Then it drops — the page is up, in stock: 🟢.
  await env.app.monitor.checkPage(url);
  await settle();
  assert.equal(dms('d-ash').length, n0, 'not listed yet: quiet');
  store.setAcme('garmin-forerunner-265', { listed: true });
  await env.app.monitor.checkPage(url);
  await settle();
  assert.equal(dms('d-ash').length, n0 + 1, 'it dropped: one DM');
  assert.match(last().body.embeds[0].title, /^🟢 In stock: Garmin Forerunner 265/);
  assert.equal(row().price_alert_price, 649, 'its first read notes the price — no price alert for it');
  // Cheaper: 📉, with the price it was, how much lower, and its page (no ⚡ Buy at another website).
  store.setAcme('garmin-forerunner-265', { price: 549 });
  await env.app.monitor.checkPage(url);
  await settle();
  assert.equal(dms('d-ash').length, n0 + 2, 'a price drop: a DM');
  const drop = last();
  assert.match(drop.body.embeds[0].title, /^📉 Price drop: Garmin Forerunner 265/);
  assert.match(drop.body.embeds[0].description, /Was \$649\.00 — now \$549\.00 \(15% lower\)/);
  assert.match(drop.body.embeds[0].description, /In stock/);
  assert.match(drop.body.embeds[0].description, /Open the product to buy it there/);
  assert.ok(buttons(drop).includes('Open product'));
  assert.ok(!buttons(drop).includes('⚡ Buy'));
  const ev = env.app.repo.listEvents(ash.user.id, { limit: 5 }).find((e) => /Price drop/.test(e.message));
  assert.ok(ev, 'in their activity too');
  // The same price again, a little higher, then back to it: nothing new to say (told at $549 already).
  await env.app.monitor.checkPage(url);
  await settle();
  store.setAcme('garmin-forerunner-265', { price: 559 });
  await env.app.monitor.checkPage(url);
  await settle();
  store.setAcme('garmin-forerunner-265', { price: 549 });
  await env.app.monitor.checkPage(url);
  await settle();
  assert.equal(dms('d-ash').length, n0 + 2, 'back to the price it was told about: quiet');
  // Lower than that: told again.
  store.setAcme('garmin-forerunner-265', { price: 499 });
  await env.app.monitor.checkPage(url);
  await settle();
  assert.equal(dms('d-ash').length, n0 + 3);
  assert.match(last().body.embeds[0].description, /Was \$549\.00 — now \$499\.00 \(9\.1% lower\)/);
  // Less than a dollar off (or under 1%): not a drop.
  store.setAcme('garmin-forerunner-265', { price: 498.5 });
  await env.app.monitor.checkPage(url);
  await settle();
  assert.equal(dms('d-ash').length, n0 + 3, 'fifty cents off: quiet');
  // Half a day later, the same lower price after a rise: told again.
  store.setAcme('garmin-forerunner-265', { price: 520 });
  await env.app.monitor.checkPage(url);
  await settle();
  clock.offset += 13 * 60 * 60 * 1000;
  try {
    store.setAcme('garmin-forerunner-265', { price: 499 });
    await env.app.monitor.checkPage(url);
  await settle();
    assert.equal(dms('d-ash').length, n0 + 4, 'half a day on: told again');
    // Sold out (quiet), then pre-orders open: 🟣.
    store.setAcme('garmin-forerunner-265', { status: 'out_of_stock' });
    await env.app.monitor.checkPage(url);
  await settle();
    assert.equal(dms('d-ash').length, n0 + 4, 'sold out: nothing to say');
    store.setAcme('garmin-forerunner-265', { status: 'preorder' });
    await env.app.monitor.checkPage(url);
  await settle();
    assert.equal(dms('d-ash').length, n0 + 5);
    assert.match(last().body.embeds[0].title, /^🟣 Pre-order open: Garmin Forerunner 265/);
  } finally {
    clock.offset -= 13 * 60 * 60 * 1000;
  }
  // Someone else's watchlist item (not a drop watch's): its price moving is no DM — as before.
  const plain = (await misty.post('/api/items', { url: store.acmeUrl('luffy-gear-5-figure'), name: 'Luffy figure' })).body;
  const m0 = dms('d-misty').length;
  await env.app.monitor.checkPage(store.acmeUrl('luffy-gear-5-figure'));
  store.setAcme('luffy-gear-5-figure', { price: 59.95 });
  await env.app.monitor.checkPage(store.acmeUrl('luffy-gear-5-figure'));
  assert.equal(dms('d-misty').filter((d) => /Price drop/.test(d.body.embeds[0].title)).length, 0, 'a plain watchlist item: no price DMs');
  assert.ok(dms('d-misty').length >= m0);
  await misty.del(`/api/items/${plain.id}`);
  store.setAcme('luffy-gear-5-figure', { price: 89.95 });
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("🎯 an admin's watch at another website, for everyone: its price drops are posted in #non-tcg-alerts too (📉) — its rule gets price drops once, and an admin who takes them off is left alone", async () => {
  store.state.acme.products.push({ handle: 'garmin-fenix-8', name: 'Garmin Fenix 8 Solar', price: 1499, status: 'in_stock', listed: true });
  const url = store.acmeUrl('garmin-fenix-8');
  const r = await boss.post('/api/drops', { url, label: 'Garmin Fenix 8' });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  const rule = env.app.catalog.listRoutes().find((x) => x.channelId === ch.nontcg);
  assert.ok(rule.kinds.includes('price_drop'), '#non-tcg-alerts posts price drops (made with them)');
  await env.app.monitor.checkPage(url);
  const p0 = posts(ch.nontcg).length;
  store.setAcme('garmin-fenix-8', { price: 1199 });
  await env.app.monitor.checkPage(url);
  const post = posts(ch.nontcg).at(-1);
  assert.equal(posts(ch.nontcg).length, p0 + 1, 'the price drop is posted for everyone');
  assert.match(JSON.stringify(post.body.embeds[0]), /Price drop/);
  assert.match(JSON.stringify(post.body.embeds[0]), /\$1199\.00 \(was \$1499\.00\)/);
  assert.ok(!buttons(post).some((b) => /Buy/.test(b)), 'another website: no ⚡ Buy');
  // An older #non-tcg-alerts rule without price drops gets them — once.
  env.app.catalog.saveRoute(rule.id, { ...rule, kinds: ['restock', 'listed'] });
  env.app.repo.setSetting('nontcgPriceDrops', null);
  drops().priceDropsInNonTcg();
  assert.deepEqual(env.app.catalog.listRoutes().find((x) => x.id === rule.id).kinds, ['restock', 'listed', 'price_drop']);
  env.app.catalog.saveRoute(rule.id, { ...rule, kinds: ['restock', 'listed'] });
  drops().priceDropsInNonTcg();
  assert.deepEqual(env.app.catalog.listRoutes().find((x) => x.id === rule.id).kinds, ['restock', 'listed'], 'taken off by an admin: left off');
  env.app.catalog.saveRoute(rule.id, { ...rule, kinds: ['restock', 'listed', 'price_drop'] });
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🎯 the Riot Games Store's Riftbound drops (its page streamed hidden, no buy button until it's on sale): an admin's links read as coming soon — not \"Checking…\" — then posted in #non-tcg-alerts the moment one's in stock and the other opens for pre-order, alerts only", async () => {
  // (Like merch.riotgames.com's /en-us/product/<slug>/ pages: see riotPage in the dummy store.)
  store.state.acme.products.push(
    { handle: 'riftbound-kda-couture-collection', name: 'Riftbound x K/DA: Couture Collection', price: 150, status: 'coming_soon', riot: true, listed: false },
    { handle: 'riftbound-t1-2025-worlds-signature-edition', name: 'Riftbound x T1 2025 Worlds Champion Signature Edition', price: 360, status: 'coming_soon', riot: true, preorderLater: true, listed: false },
  );
  const link = (h) => `${store.url}/acme/en-us/product/${h}/`;
  const kda = link('riftbound-kda-couture-collection');
  const t1 = link('riftbound-t1-2025-worlds-signature-edition');
  const ws = [];
  for (const url of [kda, t1]) {
    const r = await boss.post('/api/drops', { url });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.watch.store, 'other');
    ws.push(r.body.watch);
  }
  const p0 = posts(ch.nontcg).length;
  for (const url of [kda, t1]) await env.app.monitor.checkPage(url);
  const shown = async () => (await boss.get('/api/drops')).body.watches.filter((w) => ws.some((x) => x.id === w.id)).map((w) => w.found.map((f) => [f.name, f.status, f.price])).flat();
  assert.deepEqual(await shown(), [['Riftbound x K/DA: Couture Collection', 'coming_soon', 150], ['Riftbound x T1 2025 Worlds Champion Signature Edition', 'coming_soon', 360]], 'coming soon, with their prices — read, not "Checking…"');
  assert.equal(posts(ch.nontcg).length, p0, 'nothing to say yet');
  await env.app.monitor.checkPage(kda);
  assert.equal(posts(ch.nontcg).length, p0, 'still coming soon: quiet');
  // K/DA goes on sale ("Add to Cart" drawn): 🟢, at once, alerts only.
  store.setAcme('riftbound-kda-couture-collection', { status: 'in_stock' });
  await env.app.monitor.checkPage(kda);
  assert.equal(posts(ch.nontcg).length, p0 + 1);
  const on = posts(ch.nontcg).at(-1);
  assert.match(on.body.embeds[0].title, /^🟢 In stock: Riftbound x K\/DA: Couture Collection/);
  assert.ok(!buttons(on).some((b) => /Buy/.test(b)), 'another website: no ⚡ Buy');
  assert.ok(buttons(on).includes('Open product'));
  // T1's opens for pre-order: 🟣.
  store.setAcme('riftbound-t1-2025-worlds-signature-edition', { status: 'preorder' });
  await env.app.monitor.checkPage(t1);
  assert.equal(posts(ch.nontcg).length, p0 + 2);
  assert.match(posts(ch.nontcg).at(-1).body.embeds[0].title, /^🟣 Pre-order open: Riftbound x T1 2025 Worlds Champion Signature Edition/);
  assert.deepEqual((await shown()).map((x) => x[1]), ['in_stock', 'preorder']);
  for (const w of ws) assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test('🎯 drop watch words: short words and numbers are whole words ("xbox series x" isn\'t the Series S), longer ones count at a word\'s start — and Kmart\'s whole store is searched for them, not just its Trading Cards', async () => {
  assert.equal(hasWords('Xbox Series X Console 1TB', 'xbox series x'), true);
  assert.equal(hasWords('Xbox Series S 512GB Console', 'xbox series x'), false, 'not the Series S');
  assert.equal(hasWords('PlayStation 5 Slim Console Promo Bundle', 'playstation 5 pro'), false, '"pro" isn\'t "Promo"');
  assert.equal(hasWords('PlayStation®5 Pro Console', 'playstation 5 pro'), true);
  assert.equal(hasWords('Nintendo Switch 2 Console', 'switch 2'), true);
  assert.equal(hasWords('Nintendo Switch Lite 2024 Edition', 'switch 2'), false, '"2" isn\'t "2024"');
  assert.equal(hasWords('Pokémon Skateboard Deck', 'pokemon skate'), true, 'a longer word at the start of one');
  assert.equal(hasWords('Pokemon Booster Boxes', 'booster box'), true, 'a plural is fine');
  assert.equal(hasWords('Garmin Forerunner 265 GPS Smartwatch', 'garmin forerunner 265'), true);
  assert.equal(hasWords('Garmin Forerunner 2650', 'garmin forerunner 265'), false);
  assert.equal(hasWords('Anything', ''), false);
  const kmart = env.app.retailers.get('kmart');
  const cards = sw().urlFor(kmart, 'pokemon');
  const words = sw().urlFor(kmart, 'xbox series x', 1, { vip: true });
  assert.match(cards, /filters%5Bgroup_id%5D=/, 'the card keywords: Trading Cards only');
  assert.doesNotMatch(words, /group_id/, 'a watch\'s words: every department');
  assert.match(words, /\/search\/xbox%20series%20x\?/);
  assert.match(words, /filters%5BSeller%5D=Kmart&filters%5BSeller%5D=Target/, 'still Kmart\'s and Target\'s own');
  assert.match(words, /sort_by=numberOfDaysSinceStartDate/, 'newest first');
});

test('🎯 a broad watch whose first look finds plenty still hears of what drops after it (listed-already and new finds each have room) — and says so once it\'s found the most it keeps', async () => {
  const before = store.state.acme.products.length;
  for (let i = 1; i <= 12; i++) store.state.acme.products.push({ handle: `garmin-band-${i}`, name: `Garmin Watch Band ${i}`, price: 39 + i, status: 'in_stock', listed: true });
  try {
    const site = store.acmeUrl();
    const w = (await ash.post('/api/drops', { store: 'other', site, words: 'garmin watch band' })).body.watch;
    assert.ok(w);
    const look = await drops().look(drops().get(w.id));
    assert.equal(look.ok, true, look.error);
    const first = drops().get(w.id).found;
    assert.equal(first.length, 10, 'its first look keeps 10 of what was listed already');
    assert.ok(first.every((f) => f.base === true));
    assert.equal((await ash.get('/api/drops')).body.watches.find((x) => x.id === w.id).found.length, 10);
    const n0 = dms('d-ash').length;
    // A new one drops: there's room for it (before, a full first look left none).
    store.state.acme.products.push({ handle: 'garmin-watch-band-quickfit-22', name: 'Garmin Watch Band QuickFit 22', price: 79, status: 'in_stock', listed: true });
    drops().db.run('UPDATE drop_watches SET next_at = 0 WHERE id = :id', { id: w.id });
    drops().changed();
    await drops().look(drops().get(w.id));
    const found = drops().get(w.id).found;
    const fresh = found.find((f) => /quickfit-22/.test(f.sku));
    assert.ok(fresh, 'the new drop is found');
    assert.equal(fresh.base, false);
    await settle();
    assert.ok(dms('d-ash').length > n0, 'and its owner is told');
    assert.match(dms('d-ash').at(-1).body.embeds[0].title, /Garmin Watch Band QuickFit 22/);
    // Ten new ones: the most it keeps — said once in their activity.
    for (let i = 1; i <= 10; i++) store.state.acme.products.push({ handle: `garmin-watch-band-new-${i}`, name: `Garmin Watch Band New ${i}`, price: 50, status: 'out_of_stock', listed: true });
    drops().db.run('UPDATE drop_watches SET next_at = 0 WHERE id = :id', { id: w.id });
    drops().changed();
    await drops().look(drops().get(w.id));
    const after = drops().get(w.id).found;
    assert.equal(after.filter((f) => f.base === false).length, 10, 'ten new finds at most');
    const said = env.app.repo.listEvents(ash.user.id, { limit: 30 }).filter((e) => /the most one watch keeps/.test(e.message));
    assert.equal(said.length, 1, 'said once');
    // One taken off the watchlist makes room for the next.
    const one = after.find((f) => f.base === false && f.itemId);
    await ash.del(`/api/items/${one.itemId}`);
    assert.equal(drops().room(drops().get(w.id), false), true);
    assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
  } finally {
    store.state.acme.products.splice(before);
  }
});

test('🤖 one purchase per drop watch: once Auto-checkout buys one of its finds, its other finds are disarmed and what it finds next isn\'t armed', async () => {
  const w = (await ash.post('/api/drops', { store: 'demo-jbhifi', words: 'zelda tears console', aco: true, maxPrice: 900 })).body.watch;
  assert.ok(w && w.aco);
  const add = (sku, name, { maxPrice = 900, watch = w.id } = {}) => {
    const it = env.app.repo.addItem(ash.user.id, checkItem({ store: 'demo-jbhifi', sku, name, maxPrice, aco: true, monitor: true }, { retailers: env.app.retailers }));
    if (watch) env.app.db.run('UPDATE items SET drop_watch = :w WHERE id = :id', { w: watch, id: it.id });
    return it;
  };
  const a = add('zelda-tears-console-a', 'Zelda Tears Console A');
  const b = add('zelda-tears-console-b', 'Zelda Tears Console B');
  const other = add('unrelated-thing', 'Unrelated thing', { maxPrice: 50, watch: null });
  const run = env.app.aco.create({ userId: ash.user.id, item: env.app.repo.getItem(ash.user.id, a.id), price: 799, mode: 'place', trigger: 'sweep' }, 'checkout', '', 'At checkout');
  await env.app.aco.report(ash.user.id, run.id, { status: 'placing', message: 'Pressing "Pay now"' });
  await env.app.aco.report(ash.user.id, run.id, { status: 'placed', message: 'Order confirmed', total: 812 });
  assert.equal(env.app.repo.getItem(ash.user.id, a.id).aco, false, 'the one bought: disarmed');
  assert.equal(env.app.repo.getItem(ash.user.id, b.id).aco, false, 'the watch\'s other find: disarmed');
  assert.equal(env.app.repo.getItem(ash.user.id, other.id).aco, true, 'anything else of yours stays armed');
  assert.equal(drops().get(w.id).aco, false, 'and what the watch finds next isn\'t armed');
  assert.ok(env.app.repo.listEvents(ash.user.id, { limit: 10 }).some((e) => /One purchase per drop watch/.test(e.message)));
  // A run that didn't buy (failed before the final button) leaves the others armed.
  env.app.db.run('UPDATE items SET aco = 1 WHERE id = :id', { id: b.id });
  env.app.db.run('UPDATE drop_watches SET aco = 1 WHERE id = :id', { id: w.id });
  drops().changed();
  const c = add('zelda-tears-console-c', 'Zelda Tears Console C');
  const run2 = env.app.aco.create({ userId: ash.user.id, item: env.app.repo.getItem(ash.user.id, c.id), price: 799, mode: 'place', trigger: 'sweep' }, 'checkout', '', 'At checkout');
  await env.app.aco.report(ash.user.id, run2.id, { status: 'failed', reason: 'card_declined', message: 'Declined' });
  assert.equal(env.app.repo.getItem(ash.user.id, b.id).aco, true, 'not bought: the others stay armed');
  assert.equal(drops().get(w.id).aco, true);
  for (const it of [a, b, c, other]) await ash.del(`/api/items/${it.id}`);
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
});

test("🎯 an admin's link at another website that turns Mugibot's server away (Microsoft's, say): the whole link is kept and read, and it's called by its link's words — not its code — until its page answers with its own name", async () => {
  const url = `${store.url}/acme/en-au/d/xbox-series-x-console-1tb/8wg5vqp0x4h3`;
  const host = new URL(store.url).host;
  store.state.acme.refuse = true;
  const r = await boss.post('/api/drops', { url, label: 'Xbox 25th Anniversary' });
  assert.equal(r.status, 200, r.text);
  const w = r.body.watch;
  assert.equal(w.url, url, 'the watch keeps the whole link');
  const p = env.app.catalog.productFor('other', otherSku(url));
  assert.equal(p.sku, `${host}/8wg5vqp0x4h3`, "Mugibot's own code for it (the website and the link's last part)");
  assert.equal(p.url, url, 'the page read is the whole link, never the code');
  await env.app.monitor.checkPage(url);
  const log = env.app.db.get('SELECT * FROM check_log WHERE product_id = :p ORDER BY at DESC LIMIT 1', { p: p.id });
  assert.ok(log, 'the check is in the log');
  const named = (await boss.get(`/api/monitor/products/${p.id}`)).body.product;
  assert.equal(named.name, 'Xbox Series X Console 1tb', "the link's words while its page won't answer");
  assert.equal(named.sku, `${host}/8wg5vqp0x4h3`);
  const found = (await boss.get('/api/drops')).body.watches.find((x) => x.id === w.id).found;
  assert.deepEqual(found.map((f) => [f.name, f.url]), [['Xbox Series X Console 1tb', url]]);
  assert.equal(env.app.catalog.productById(p.id).name, '', 'nothing saved as its name: the page names it');
  // The website answers again: its page's own name.
  store.state.acme.refuse = false;
  await env.app.monitor.checkPage(url);
  assert.equal(env.app.catalog.productById(p.id).name, 'Xbox Series X Console 1TB');
  assert.equal((await boss.get(`/api/monitor/products/${p.id}`)).body.product.name, 'Xbox Series X Console 1TB');
  // (An admin who saved the link's words as its name: the page's title still takes over.)
  env.app.catalog.updateProduct(p.id, { name: 'Xbox Series X Console 1tb' });
  await env.app.monitor.checkPage(url);
  assert.equal(env.app.catalog.productById(p.id).name, 'Xbox Series X Console 1TB');
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test('🎯 words at another website: read as Mugibot every couple of minutes — what drops is posted for everyone (admins) or DM\'d (members), alerts only', async () => {
  const site = store.acmeUrl();
  const nope = await boss.post('/api/drops', { store: 'other', site: `${store.url}/jbhifi`, words: 'xbox' });
  assert.equal(nope.status, 400);
  assert.match(nope.body.error, /JB Hi-Fi/);
  const a = (await boss.post('/api/drops', { store: 'other', site, words: 'xbox series x' })).body.watch;
  const m = (await misty.post('/api/drops', { store: 'other', site, words: 'Xbox Series X' })).body.watch;
  assert.ok(a && m);
  assert.equal(a.shared, true);
  assert.equal(m.shared, false);
  assert.equal(m.canBuy, false);
  // Its first look: not a Shopify shop (no search suggestions), so its search page. One read for both watches.
  const asked = () => store.state.requests.filter((x) => x.path.startsWith('/acme/search'));
  const n0 = asked().length;
  const look = await drops().look(drops().get(a.id));
  assert.equal(look.ok, true, look.error);
  assert.equal(look.how, 'search');
  assert.equal(asked().length - n0, 2, 'suggestions (not there), then its search — once for both watches');
  assert.ok(store.state.requests.filter((x) => x.path.startsWith('/acme/')).every((x) => /^Mugibot\/1\.0/.test(x.ua)), 'as Mugibot');
  const ws = () => Object.fromEntries((drops().watches()).filter((x) => [a.id, m.id].includes(x.id)).map((x) => [x.id, x]));
  assert.ok(ws()[a.id].baselineAt && ws()[m.id].baselineAt, 'both have had their first look');
  assert.ok(ws()[m.id].nextAt - env.app.repo.now() > 100 * 1000, 'looked at again in a couple of minutes');
  // What was there: the boss's a monitored product (Non-TCG), Misty's on her watchlist — no posts, no DMs.
  const xbox = env.app.catalog.productFor('other', otherSku(store.acmeUrl('xbox-series-x-console-1tb')));
  assert.equal(xbox.category, 'nontcg');
  assert.ok(env.app.catalog.monitorForProduct(xbox.id));
  const mi = env.app.repo.itemBySku(misty.user.id, 'other', otherSku(store.acmeUrl('xbox-series-x-console-1tb')));
  assert.equal(mi.status, 'unknown', 'its page tells');
  const before = { nontcg: posts(ch.nontcg).length, misty: dms('d-misty').length };
  // Its page read for the first time: how it is (in stock: Ash's link test left it so), quietly.
  await env.app.monitor.checkPage(xbox.url);
  assert.equal(env.app.repo.getItem(misty.user.id, mi.id).status, 'in_stock');
  await settle();
  assert.equal(dms('d-misty').length, before.misty, 'the first read is how it is, not a restock');
  assert.equal(posts(ch.nontcg).length, before.nontcg);

  // The limited edition drops: its page read in the monitor's turn (at once here: the website's not been asked just now).
  store.setAcme('xbox-series-x-25th-anniversary-edition', { listed: true });
  await drops().look(drops().get(a.id));
  await settle();
  const post = posts(ch.nontcg).at(-1);
  assert.match(post.body.embeds[0].title, /^🟢 In stock: Xbox Series X 25th Anniversary Limited Edition Console/);
  assert.match(post.body.embeds[0].description, /Just listed/);
  assert.ok(!buttons(post).includes('⚡ Buy with Mugibot'), 'no ⚡ Buy at another website');
  assert.ok(buttons(post).includes('Open product'));
  assert.equal(post.body.embeds[0].fields.find((f) => f.name === 'Store').value, new URL(store.url).host);
  await settle();
  const dm = dms('d-misty').at(-1);
  assert.match(dm.body.embeds[0].title, /🟢 In stock: Xbox Series X 25th Anniversary Limited Edition Console/);
  assert.ok(!buttons(dm).includes('⚡ Buy'));
  assert.equal(posts(ch.nontcg).filter((x) => /25th Anniversary/.test(x.body.embeds[0].title)).length, 1, 'once');

  // A Shopify shop: its search suggestions.
  store.state.acme.shopify = true;
  const g = (await boss.post('/api/drops', { store: 'other', site, words: 'luffy figure', shared: false })).body.watch;
  assert.equal(g.shared, false, 'an admin can keep one to themselves');
  const lg = await drops().look(drops().get(g.id));
  assert.equal(lg.how, 'suggest');
  assert.ok(env.app.repo.itemBySku(boss.user.id, 'other', otherSku(store.acmeUrl('luffy-gear-5-figure'))));

  // A website that turns Mugibot away: said on the watch, and asked again later (backing off).
  store.state.acme.refuse = true;
  const lr = await drops().look(drops().get(m.id));
  assert.equal(lr.ok, false);
  const view = (await misty.get('/api/drops')).body.watches.find((x) => x.id === m.id);
  assert.match(view.error, /refused Mugibot \(HTTP 403\)/);
  assert.ok(drops().get(m.id).nextAt - env.app.repo.now() > 3 * 60 * 1000, 'backing off');
  store.state.acme.refuse = false;
  store.state.acme.shopify = false;
});

test('🎯 an admin\'s words at a store searched from an admin\'s browser (EB Games): asked for as typed, and what it finds counts (VIP words too)', async () => {
  const r = await ash.post('/api/drops', { store: 'demo-ebgames', words: 'xbox controller' });
  assert.equal(r.status, 200, r.text);
  const due = sw().browserDue(env.app.repo.userById(boss.user.id), { version: '1.16.0', who: 'boss' });
  const t = due.terms.find((x) => x.store === 'demo-ebgames');
  assert.equal(t.keyword, 'xbox controller');
  assert.doesNotMatch(t.url, /tcg/);
  const url = `${store.url}/ebgames/product/toys-and-collectibles/312399-xbox-wireless-controller`;
  const out = await sw().browserResults(env.app.repo.userById(boss.user.id), [{ store: 'demo-ebgames', keyword: 'xbox controller', page: 1, ok: true, ms: 300, products: [{ sku: '312399', title: 'Xbox Wireless Controller', price: 89, inStock: true, url }] }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, true);
  assert.ok(env.app.repo.itemBySku(ash.user.id, 'demo-ebgames', '312399'), 'on Ash\'s watchlist');
  // (A VIP watch's words there are taken too — they were left out before.)
  const vip = await boss.post('/api/monitor/vip', { store: 'demo-ebgames', words: 'halo infinite' });
  assert.equal(vip.status, 200, vip.text);
  assert.deepEqual(sw().termOf(R('demo-ebgames'), { keyword: 'halo infinite' }), { keyword: 'halo infinite', page: 1, vip: vip.body.watch.id });
  assert.equal(sw().termOf(R('demo-ebgames'), { keyword: 'anything else' }), null, 'nothing Mugibot didn\'t ask for');
  await boss.del(`/api/monitor/vip/${vip.body.watch.id}`);
  await ash.del(`/api/drops/${r.body.watch.id}`);
});

test('🎯 drop watches: what can be added, how many, who sees and changes what', async () => {
  const add = (c, body) => c.post('/api/drops', body);
  assert.equal((await add(ash, {})).status, 400);
  assert.match((await add(ash, { store: 'demo-kmart', words: 'lego set' })).body.error, /isn't searched at the moment/, 'a store whose searches are off');
  assert.match((await add(ash, { store: 'other', words: 'lego set' })).body.error, /website's address is required/);
  assert.match((await add(ash, { store: 'other', site: 'ftp://x.example', words: 'lego set' })).body.error, /https/);
  assert.match((await add(ash, { url: 'notalink' })).body.error, /valid web address/);
  // Members without a membership can't.
  const guest = await Client.signup(env.url, 'guest');
  assert.equal((await guest.get('/api/drops')).status, 402);
  // How many: 10 each (admins 30).
  const view = (await ash.get('/api/drops')).body;
  assert.equal(view.limit, 10);
  assert.equal((await boss.get('/api/drops')).body.limit, 30);
  const made = [];
  for (let i = view.used; i < 10; i++) {
    const r = await add(ash, { store: 'other', site: store.acmeUrl(), words: `figure number ${i}` });
    assert.equal(r.status, 200, r.text);
    made.push(r.body.watch.id);
  }
  assert.match((await add(ash, { store: 'other', site: store.acmeUrl(), words: 'one more figure' })).body.error, /10 drop watches is the most/);
  for (const id of made) assert.equal((await ash.del(`/api/drops/${id}`)).status, 200);
  // An admin can remove a watch for everyone (another admin's too); a member can't.
  const shared = (await ash.get('/api/drops')).body.watches.find((x) => x.shared);
  assert.equal(shared.canChange, false);
  assert.equal((await ash.del(`/api/drops/${shared.id}`)).status, 404);
  assert.equal((await ash.post(`/api/drops/${shared.id}/check`, {})).status, 404);
  // Removing an admin's link watch removes its monitor (the product's history stays).
  const link = (await boss.get('/api/drops')).body.watches.find((x) => x.kind === 'link' && x.shared);
  const pid = link.found[0].productId;
  assert.equal((await boss.del(`/api/drops/${link.id}`)).status, 200);
  assert.equal(env.app.catalog.monitorForProduct(pid), null);
  assert.ok(env.app.catalog.productById(pid));
});

test("🧭 a drop watch's page the server is refused on (BIG W's, say — the rest of the store answers): an admin's browser checks it instead; members' browsers never do", async () => {
  const url = store.addProduct('jbhifi', { sku: 'ps5-pro-console-2tb', name: 'PlayStation 5 Pro Console 2TB', price: 1199, status: 'out_of_stock' });
  const w = (await boss.post('/api/drops', { url, label: 'Series X at JB' })).body.watch;
  assert.ok(w, 'watch added');
  const p = env.app.catalog.productById(drops().get(w.id).found[0].productId);
  const bossDevice = await Device.pair(env.url, boss, 'Boss Chrome');
  const ashDevice = await Device.pair(env.url, ash, 'Ash Chrome');
  const due = async (d) => (await d.call('GET', '/api/ext/checks')).body.checks.filter((c) => c.id === `p:${p.id}`);
  env.app.db.run('UPDATE products SET browser_next_at = 0 WHERE id = :id', { id: p.id });
  assert.deepEqual(await due(bossDevice), [], 'the server reads it fine: no browser asked');
  // Its page turns the server away (the store's other pages still answer: not the whole store struggling).
  env.app.catalog.updateProduct(p.id, { status: 'blocked', fail_count: 3, error: 'The store refused the server check (HTTP 403)', browser_next_at: 0 });
  assert.equal(env.app.monitor.serverStruggles('demo-jbhifi'), false);
  assert.deepEqual(await due(ashDevice), [], "a member's browser never checks what everyone sees");
  const mine = await due(bossDevice);
  assert.equal(mine.length, 1, "the admin's browser is asked to check it");
  assert.equal(mine[0].url, url);
  assert.deepEqual(await due(bossDevice), [], 'leased: not handed out twice at once');
  await bossDevice.call('POST', '/api/ext/checks', { results: [{ id: `p:${p.id}`, status: 'out_of_stock', price: 799 }] });
  let fresh = env.app.catalog.productById(p.id);
  assert.equal(fresh.status, 'out_of_stock');
  assert.equal(fresh.status_source, 'browser');
  const view = () => (boss.get('/api/drops')).then((r) => r.body.watches.find((x) => x.id === w.id).found[0]);
  assert.equal((await view()).via, 'browser', "said on the watch (admins): checked from an admin's browser");
  assert.equal((await ash.get('/api/drops')).body.watches.find((x) => x.id === w.id).found[0].via, undefined, 'not to members');
  // The server refused again meanwhile: what the admin's browser read stands.
  await env.app.feed.applyCheck(fresh, { status: 'blocked', error: 'HTTP 403' }, { source: 'server', url });
  assert.equal(env.app.catalog.productById(p.id).status, 'out_of_stock');
  // It's the admin's browser's to check while it does: asked again at its next turn.
  env.app.db.run('UPDATE products SET browser_next_at = 0 WHERE id = :id', { id: p.id });
  assert.equal((await due(bossDevice)).length, 1);
  // The server reads it again: back to the server.
  fresh = env.app.catalog.productById(p.id);
  await env.app.feed.applyCheck(fresh, { status: 'in_stock', price: 799 }, { source: 'server', url });
  env.app.db.run('UPDATE products SET browser_next_at = 0 WHERE id = :id', { id: p.id });
  assert.deepEqual(await due(bossDevice), [], 'the server reads it again: no browser asked');
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🧭 another website refusing the server (David Jones', say): an admin's browser checks the drop watch's page — once the extension may read that website; till then the dashboard and the extension say to allow it", async () => {
  const url = store.acmeUrl('xbox-series-x-console-1tb');
  const host = new URL(url).host;
  store.state.acme.refuse = true;
  const w = (await boss.post('/api/drops', { url, label: 'Xbox at Acme' })).body.watch;
  const p = env.app.catalog.productById(drops().get(w.id).found[0].productId);
  for (let i = 0; i < 3; i++) await env.app.monitor.checkPage(url);
  assert.equal(env.app.catalog.productById(p.id).status, 'blocked', 'refused: blocked by site');
  const bossDevice = await Device.pair(env.url, boss, 'Boss Chrome 2');
  env.app.db.run('UPDATE products SET browser_next_at = 0 WHERE id = :id', { id: p.id });
  // No browser of the admin's has said what it may read (an older extension, or none open): nothing to allow on the dashboard.
  assert.equal((await boss.get('/api/drops')).body.watches.find((x) => x.id === w.id).found[0].allow, undefined);
  // Not allowed there yet: not handed out, and the extension's told which website to offer.
  let r = (await bossDevice.call('GET', '/api/ext/checks?sites=')).body;
  assert.ok(!r.checks.some((c) => c.id === `p:${p.id}`));
  assert.ok(r.sites.includes(host), 'the website to allow');
  let found = (await boss.get('/api/drops')).body.watches.find((x) => x.id === w.id).found[0];
  assert.equal(found.allow, host, 'the dashboard says to allow it in the extension');
  // (Refused in the browser too: asked again later each time.)
  r = (await bossDevice.call('GET', `/api/ext/checks?sites=${encodeURIComponent(host)}`)).body;
  assert.ok(r.checks.some((c) => c.id === `p:${p.id}`));
  await bossDevice.call('POST', '/api/ext/checks', { results: [{ id: `p:${p.id}`, status: 'blocked', error: 'HTTP 403' }] });
  const gap1 = env.app.catalog.productById(p.id).browser_next_at - env.app.repo.now();
  env.app.db.run('UPDATE products SET browser_next_at = 0 WHERE id = :id', { id: p.id });
  await bossDevice.call('GET', `/api/ext/checks?sites=${encodeURIComponent(host)}`);
  await bossDevice.call('POST', '/api/ext/checks', { results: [{ id: `p:${p.id}`, status: 'blocked', error: 'HTTP 403' }] });
  assert.ok(env.app.catalog.productById(p.id).browser_next_at - env.app.repo.now() > gap1 * 1.5, 'backing off');
  env.app.db.run('UPDATE products SET browser_next_at = 0 WHERE id = :id', { id: p.id });
  // Allowed: checked from the admin's browser.
  r = (await bossDevice.call('GET', `/api/ext/checks?sites=${encodeURIComponent(host)}`)).body;
  assert.ok(r.checks.some((c) => c.id === `p:${p.id}` && c.url === url && c.kind === 'product'));
  assert.ok(!r.sites.includes(host));
  await bossDevice.call('POST', '/api/ext/checks', { results: [{ id: `p:${p.id}`, status: 'in_stock', price: 749, title: 'Xbox Series X Console 1TB' }] });
  assert.equal(env.app.catalog.productById(p.id).status, 'in_stock');
  found = (await boss.get('/api/drops')).body.watches.find((x) => x.id === w.id).found[0];
  assert.equal(found.via, 'browser');
  assert.equal(found.allow, undefined);
  // A member's browser, allowed everywhere, still never checks it.
  const mistyDevice = await Device.pair(env.url, misty, 'Misty Chrome');
  env.app.db.run('UPDATE products SET browser_next_at = 0 WHERE id = :id', { id: p.id });
  assert.ok(!(await mistyDevice.call('GET', '/api/ext/checks?sites=*')).body.checks.some((c) => c.id === `p:${p.id}`));
  store.state.acme.refuse = false;
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🧭 words at another website that refuses the server: read from an admin's browser instead (your own watch: your browser) — only for the watches that browser reads for", async () => {
  const site = store.acmeUrl();
  const host = new URL(site).host;
  store.state.acme.refuse = true;
  const a = (await boss.post('/api/drops', { store: 'other', site, words: 'series x console' })).body.watch;
  const m = (await misty.post('/api/drops', { store: 'other', site, words: 'series x console' })).body.watch;
  await drops().look(drops().get(a.id));
  assert.equal(drops().get(a.id).fails, 1);
  assert.match(drops().get(m.id).error, /refused Mugibot/);
  const bossDevice = await Device.pair(env.url, boss, 'Boss Chrome 3');
  // (This test's two watches: other tests' watches at the same website may be due too.)
  const ours = (r) => r.body.checks.filter((c) => c.kind === 'site' && [`d:${a.id}`, `d:${m.id}`].includes(c.id));
  const mistyDevice = await Device.pair(env.url, misty, 'Misty Chrome 2');
  // Not allowed there (the admin's browser says what it may read at each check): the dashboard says so on the watch.
  // (The admin's browsers from the tests before, allowed there, put away first.)
  env.app.monitor.siteGrants.delete(boss.user.id);
  await bossDevice.call('GET', '/api/ext/checks?sites=');
  assert.match((await boss.get('/api/drops')).body.watches.find((x) => x.id === a.id).allow, new RegExp(host.replace(/[.:]/g, '\\$&')));
  const reads = ours(await bossDevice.call('GET', `/api/ext/checks?sites=${encodeURIComponent(host)}`));
  assert.deepEqual(reads.map((c) => c.id), [`d:${a.id}`], "the admin's browser: the admin's watch, never the member's own");
  assert.deepEqual(reads[0].reads.map((x) => x.way), ['suggest', 'search', 'page'], 'the ways the server reads it');
  assert.match(reads[0].reads[1].url, /\/search\?q=series%20x%20console$/);
  assert.deepEqual(ours(await bossDevice.call('GET', `/api/ext/checks?sites=${encodeURIComponent(host)}`)), [], 'not again till its turn');
  // A member's browser can't answer for the admin's watch.
  assert.equal((await mistyDevice.call('POST', '/api/ext/checks', { results: [{ id: `d:${a.id}`, ok: true, how: 'search', products: [] }] })).body.applied, 0);
  // The admin's browser read it: its finds, as the server's read would have.
  const item = { title: 'Xbox Series X Console 1TB', url: store.acmeUrl('xbox-series-x-console-1tb'), price: 749 };
  const res = await bossDevice.call('POST', '/api/ext/checks', { results: [{ id: `d:${a.id}`, ok: true, how: 'search', products: [item, { title: 'Bad', url: 'javascript:alert(1)' }] }] });
  assert.equal(res.body.applied, 1);
  const aw = drops().get(a.id);
  assert.equal(aw.fails, 0);
  assert.equal(aw.error, '');
  assert.ok(aw.baselineAt, 'its first look done');
  assert.equal(aw.found.length, 1);
  const av = (await boss.get('/api/drops')).body.watches.find((x) => x.id === a.id);
  assert.equal(av.via, 'browser');
  assert.equal(av.allow, '');
  assert.equal(drops().get(m.id).fails, 1, "the member's own watch isn't the admin's browser's to read");
  // The server's next look is refused again: the watch says nothing (an admin's browser reads it), and the server asks less often.
  assert.ok(drops().get(a.id).nextAt - env.app.repo.now() >= 7 * 60 * 1000, "a browser's read keeps the server asking less often");
  await drops().look(drops().get(a.id));
  assert.equal(drops().get(a.id).error, '');
  assert.ok(drops().get(a.id).nextAt - env.app.repo.now() >= 7 * 60 * 1000);
  // Its next read from the browser: still not the server's every couple of minutes.
  drops().browserNext.delete(a.id);
  const again = ours(await bossDevice.call('GET', `/api/ext/checks?sites=${encodeURIComponent(host)}`));
  assert.deepEqual(again.map((c) => c.id), [`d:${a.id}`], 'read from the browser again at its turn');
  await bossDevice.call('POST', '/api/ext/checks', { results: [{ id: `d:${a.id}`, ok: true, how: 'search', products: [item] }] });
  assert.ok(drops().get(a.id).nextAt - env.app.repo.now() >= 7 * 60 * 1000, 'the server still asks less often');
  assert.ok(drops().get(m.id).fails >= 2, "the member's own still says the website refused it");
  // The member's own browser reads their own watch — unless they've turned in-browser checks off.
  const own = ours(await mistyDevice.call('GET', '/api/ext/checks?sites=*'));
  assert.deepEqual(own.map((c) => c.id), [`d:${m.id}`]);
  drops().browserNext.delete(m.id);
  assert.equal((await misty.put('/api/alerts', { browserChecks: false })).status, 200);
  assert.deepEqual(ours(await mistyDevice.call('GET', '/api/ext/checks?sites=*')), []);
  assert.equal((await misty.put('/api/alerts', { browserChecks: true })).status, 200);
  // The website answers the server again: the server's to read once more — no browser asked, and the watch says so.
  store.state.acme.refuse = false;
  await drops().look(drops().get(a.id));
  assert.equal(drops().viaBrowser(drops().get(a.id)), false);
  assert.equal((await boss.get('/api/drops')).body.watches.find((x) => x.id === a.id).via, '');
  assert.deepEqual(ours(await bossDevice.call('GET', `/api/ext/checks?sites=${encodeURIComponent(host)}`)), []);
  for (const [c, id] of [[boss, a.id], [misty, m.id]]) assert.equal((await c.del(`/api/drops/${id}`)).status, 200);
});
