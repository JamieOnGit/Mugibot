// Drop watches (docs/MONITORING.md → Drop watches): anything outside the card keywords — by its link
// or the words in its name, at a store Mugibot knows or any other website. An admin's are for
// everyone (#non-tcg-alerts, every dashboard); a member's own are theirs alone (their watchlist and
// DMs). Auto-checkout where Mugibot has a checkout; alerts only at other websites. Against the
// dummy stores and the dummy "other website" (Acme Collectibles) — tests never touch real stores.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { otherSku } from '../server/monitor/drops.js';

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
  assert.ok(turns.filter((t) => !t.drop).every((t) => ['pokemon', 'one piece'].includes(t.keyword)), 'the card keywords keep the rest');
  clock.offset += 31 * 1000;
  const more = Array.from({ length: 3 }, () => sw().nextTerm(jb));
  assert.equal(more.filter((t) => t.drop).length, 1);
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
  assert.ok(dms('d-ash').some((m) => /🟢 In stock: Nintendo Switch 2 Console/.test(m.body.embeds[0].title)));
  assert.equal(runsFor(item.id).length, 1);
  // Something new with the words drops: on the watchlist, DM'd and bought at once (under the max price).
  store.addProduct('jbhifi', { sku: 'nintendo-switch-2-mario-kart-bundle', name: 'Nintendo Switch 2 Mario Kart World Bundle', price: 689, status: 'in_stock' });
  await sw().sweepTerm(jb, { keyword: 'nintendo switch 2', page: 1, drop: 'private' });
  const bundle = env.app.repo.itemBySku(ash.user.id, 'demo-jbhifi', 'nintendo-switch-2-mario-kart-bundle');
  assert.equal(bundle.aco, true);
  assert.ok(dms('d-ash').some((m) => /Nintendo Switch 2 Mario Kart World Bundle/.test(m.body.embeds[0].title)));
  assert.equal(runsFor(bundle.id).length, 1);
  assert.equal(posts(ch.nontcg).length, before.nontcg, 'never posted for everyone');
  // Removed: what it put on the watchlist goes with it.
  assert.equal((await ash.del(`/api/drops/${w.id}`)).status, 200);
  assert.equal(env.app.repo.getItem(ash.user.id, item.id), null);
  assert.equal(env.app.repo.getItem(ash.user.id, bundle.id), null);
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
  assert.equal(dms('d-ash').length, before, 'sold out: nothing to say');
  store.setAcme('xbox-series-x-console-1tb', { status: 'in_stock' });
  await env.app.monitor.checkPage(url);
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
  assert.equal(dms('d-misty').length, before.misty, 'the first read is how it is, not a restock');
  assert.equal(posts(ch.nontcg).length, before.nontcg);

  // The limited edition drops.
  store.setAcme('xbox-series-x-25th-anniversary-edition', { listed: true });
  await drops().look(drops().get(a.id));
  const post = posts(ch.nontcg).at(-1);
  assert.match(post.body.embeds[0].title, /^🟢 In stock: Xbox Series X 25th Anniversary Limited Edition Console/);
  assert.match(post.body.embeds[0].description, /Just listed/);
  assert.ok(!buttons(post).includes('⚡ Buy with Mugibot'), 'no ⚡ Buy at another website');
  assert.ok(buttons(post).includes('Open product'));
  assert.equal(post.body.embeds[0].fields.find((f) => f.name === 'Store').value, new URL(store.url).host);
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
