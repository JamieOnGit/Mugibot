// Auto-checkout watches arm as they always have: a VIP watch's find has its page read at the next round, even while that
// page is backing off; a member's own find straight away; JB Hi-Fi's newest products count a drop as before; the card words an admin had already count as before through the
// quiet window after the words widened; and a VIP watch with Auto-checkout is searched every few seconds in its window,
// wherever it is.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { DUMMY_PRODUCTS, dummyProductPath } from '../server/presets.js';
import { NEWEST } from '../server/monitor/sweep.js';

let env;
let store;
let discord;
let boss;
// (A clock that only moves on, as a real one does: a page's next check is never left in its future.)
const clock = { offset: 0 };
const DAY = 24 * 3600 * 1000;
const MIN = 60 * 1000;

before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, now: () => Date.now() + clock.offset, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  makeMember(env, boss);
  for (const it of (await boss.get('/api/items')).body.items) await boss.del(`/api/items/${it.id}`);
  // Auto-checkout on, with a browser listening.
  assert.equal((await boss.put('/api/aco', { enabled: true, agree: true, mode: 'place', maxOrder: 2000, perDay: 50, spendPerDay: 200000 })).status, 200);
  env.app.repo.addDevice(boss.user.id, 'Chrome on Mac', '1.16.0');
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { 'demo-pokebox': 'server', 'demo-jbhifi': 'server', 'demo-citybeach': 'server', 'demo-gamerholic': 'server' } })).status, 200);
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const sw = () => env.app.sweeper;
const R = (id) => env.app.retailers.get(id);
const now = () => Date.now() + clock.offset;
const runsFor = (itemId) => env.app.db.all('SELECT * FROM aco_runs WHERE item_id = :i', { i: itemId });
const bought = (storeId, sku) => {
  const item = env.app.repo.itemBySku(boss.user.id, storeId, sku);
  return { armed: !!(item && item.aco), runs: item ? runsFor(item.id).length : 0, status: item ? item.status : null };
};
const prod = (shop, sku, title, n, extra = {}) => ({
  sku, aliases: [String(9100000 + n)], title, price: 49.95, inStock: false, url: `${store.url}/${shop}/products/${sku}`,
  variantId: String(9200000 + n), oneVariant: true, marketplace: false, sellers: [], ...extra,
});
const ingest = (r, term, products, url) => sw().ingest(r, term, { products, total: products.length, problem: null }, { source: 'server', url: url || sw().urlFor(r, term.keyword, term.page, { vip: !!(term.vip || term.drop) }), ms: 50 });
// A page backing off: the store turned the server's last checks away.
const backingOff = (r, url, sku, fails, ms) => {
  env.app.repo.ensurePage(url, 'product', r.id, sku);
  env.app.db.run("UPDATE page_checks SET fail_count = :f, status = 'blocked', next_check_at = :n WHERE url = :u", { u: url, f: fails, n: now() + ms });
};
const settle = async () => {
  await env.app.monitor.tick();
  await env.app.monitor.delivered();
};

test("⭐ a VIP watch with Auto-checkout finds what was on sale already when it was added, its page backing off: the page is read at the next round all the same — left alone, and never bought when it sells out and comes back", async () => {
  const r = R('demo-pokebox');
  const etb = DUMMY_PRODUCTS.pokebox.find((p) => p.status === 'in_stock');
  const url = `${store.url}${dummyProductPath('pokebox', etb)}`;
  backingOff(r, url, etb.sku, 3, 8 * MIN);
  const res = await boss.post('/api/monitor/vip', { store: r.id, words: 'celebration elite trainer', dropAt: now() + 10 * MIN, aco: true, maxPrice: 200 });
  assert.equal(res.status, 200, res.text);
  const id = res.body.watch.id;
  const s = await ingest(r, { keyword: 'celebration elite trainer', page: 1, vip: id }, [prod('pokebox', etb.sku, etb.name, 1, { url, inStock: true, price: 79.95 })]);
  assert.equal(s.ok, true, s.error);
  assert.deepEqual(sw().vip.get(id).found.map((f) => f.arm), ['pending']);
  await settle();
  assert.deepEqual(sw().vip.get(id).found.map((f) => f.arm), ['skipped'], 'its page read at once: on sale already');
  // Sold out, then back: never bought.
  store.set('pokebox', etb.sku, { status: 'out_of_stock' });
  clock.offset += 10 * MIN;
  await settle();
  store.set('pokebox', etb.sku, { status: 'in_stock' });
  clock.offset += 10 * MIN;
  await settle();
  assert.equal(bought(r.id, etb.sku).runs, 0, 'never bought');
  assert.deepEqual(sw().vip.get(id).found.map((f) => f.arm), ['skipped']);
  assert.equal((await boss.del(`/api/monitor/vip/${id}`)).status, 200);
});

test("⭐ …and one listed but not on sale yet, its page backing off: its page read at the next round all the same, armed — bought the moment it drops", async () => {
  const r = R('demo-pokebox');
  const box = DUMMY_PRODUCTS.pokebox.find((p) => p.status === 'out_of_stock');
  const url = `${store.url}${dummyProductPath('pokebox', box)}`;
  backingOff(r, url, box.sku, 5, 15 * MIN);
  const res = await boss.post('/api/monitor/vip', { store: r.id, words: 'op-15 adventure', dropAt: now() + 10 * MIN, aco: true, maxPrice: 400 });
  assert.equal(res.status, 200, res.text);
  const id = res.body.watch.id;
  const s = await ingest(r, { keyword: 'op-15 adventure', page: 1, vip: id }, [prod('pokebox', box.sku, box.name, 11, { url, price: 249.95 })]);
  assert.equal(s.ok, true, s.error);
  assert.deepEqual(sw().vip.get(id).found.map((f) => f.arm), ['pending']);
  await settle();
  assert.deepEqual(sw().vip.get(id).found.map((f) => f.arm), ['armed'], 'its page read at once: not on sale yet');
  // It drops.
  store.set('pokebox', box.sku, { status: 'in_stock' });
  clock.offset += MIN;
  await ingest(r, { keyword: 'op-15 adventure', page: 1, vip: id }, [prod('pokebox', box.sku, box.name, 11, { url, price: 249.95, inStock: true })]);
  await env.app.monitor.delivered();
  assert.equal(bought(r.id, box.sku).runs, 1, 'bought at the drop');
  assert.equal((await boss.del(`/api/monitor/vip/${id}`)).status, 200);
});

test("🎯 a member's own drop watch with Auto-checkout at a store whose search doesn't say stock (City Beach): its new find's page is read straight away (the search's members' DMs waiting their turn) — bought the moment it's found", async () => {
  const cb = R('demo-citybeach');
  const BOARD = '20499999-01';
  const url = `${store.url}${dummyProductPath('citybeach', DUMMY_PRODUCTS.citybeach.find((p) => p.sku === BOARD))}`;
  const wr = await boss.post('/api/drops', { store: cb.id, words: 'pokemon skate', aco: true, maxPrice: 200, shared: false });
  assert.equal(wr.status, 200, wr.text);
  const w = wr.body.watch;
  const term = { keyword: 'pokemon skate', page: 1, drop: 'private' };
  let s = await sw().sweepTerm(cb, term);
  assert.equal(s.ok, true, s.error);
  assert.ok(env.app.drops.get(w.id).baselineAt);
  store.set('citybeach', BOARD, { listed: true, status: 'in_stock' });
  clock.offset += 5000;
  s = await sw().sweepTerm(cb, term);
  assert.equal(s.ok, true, s.error);
  await env.app.monitor.delivered();
  assert.deepEqual(bought(cb.id, BOARD), { armed: true, runs: 1, status: 'in_stock' });
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("🆕 JB Hi-Fi's newest products: a figure JB listed sold out before the drop watch was added, first seen on sale after it there — a drop for the watch, bought, as before", async () => {
  const r = R('demo-jbhifi');
  const NEW = { keyword: NEWEST, page: 1 };
  const nurl = sw().urlFor(r, NEWEST, 1);
  const CARD = prod('jbhifi', 'pokemon-tcg-r2-etb', 'Pokemon TCG: R2 Elite Trainer Box', 21, { inStock: true });
  const P = prod('jbhifi', 'labubu-r2-figure', 'Labubu R2 Energy Figure', 22, { createdAt: now() - 2 * DAY });
  assert.equal((await ingest(r, NEW, [CARD, P], nurl)).baseline, true);
  const wr = await boss.post('/api/drops', { store: r.id, words: 'labubu r2', aco: true, maxPrice: 100 });
  assert.equal(wr.status, 200, wr.text);
  const w = wr.body.watch;
  clock.offset += 5000;
  assert.equal((await ingest(r, { keyword: 'labubu r2', page: 1, drop: 'shared' }, [])).ok, true);
  clock.offset += 5 * MIN;
  const s = await ingest(r, NEW, [CARD, { ...P, inStock: true }], nurl);
  assert.equal(s.ok, true, s.error);
  await env.app.monitor.delivered();
  assert.deepEqual(env.app.drops.get(w.id).found.map((f) => [f.sku, f.arm]), [['labubu-r2-figure', 'armed']]);
  assert.equal(bought(r.id, P.sku).runs, 1);
  assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
});

test("⭐ a VIP watch with Auto-checkout at Gamerholic (one heavy list a search): every 4 s in its drop window, as ever — one that only alerts, every 10", async () => {
  const gh = R('demo-gamerholic');
  const a = await boss.post('/api/monitor/vip', { store: gh.id, words: 'pokemon tin', dropAt: now() + 5 * MIN });
  assert.equal(a.status, 200, a.text);
  assert.equal(sw().paceFor(gh), 10000, 'alerts only');
  const b = await boss.post('/api/monitor/vip', { store: gh.id, words: 'pokemon booster bundle', dropAt: now() + 5 * MIN, aco: true, maxPrice: 100 });
  assert.equal(b.status, 200, b.text);
  assert.equal(sw().paceFor(gh), 4000, 'with Auto-checkout');
  for (const x of [a, b]) assert.equal((await boss.del(`/api/monitor/vip/${x.body.watch.id}`)).status, 200);
});

test("🃏 the card words widened in an update: one an admin had among their own already (blister) counts as before through the quiet window — a new blister is a drop for a drop watch, bought; one only the update added (playmat) is tracked quietly at first, as before", async () => {
  const repo = env.app.repo;
  const keep = { sweep: repo.getSetting('sweep'), at: repo.getSetting('sweepWidenedAt'), had: repo.getSetting('sweepTermsHad') };
  const r = R('demo-jbhifi');
  try {
    // Saved before the update: the admin's own words, "blister" among them.
    const before = sw().settings.tcgTerms.filter((t) => !['premium collection', 'blister', 'build & battle', 'collector chest', 'portfolio', 'deck box', 'playmat'].includes(t));
    repo.setSetting('sweep', { ...(keep.sweep || {}), tcgTerms: [...before, 'blister'], termsVersion: 1 });
    repo.setSetting('sweepWidenedAt', null);
    // (A Mugibot that had tracked products already.)
    assert.equal((await ingest(r, { keyword: 'pokemon', page: 1 }, [prod('jbhifi', 'pokemon-tcg-r3-etb', 'Pokemon TCG: R3 Elite Trainer Box', 30, { inStock: true })])).ok, true);
    sw().noteWidened();
    assert.ok(sw().widenedLately(), 'the quiet window');
    assert.deepEqual(repo.getSetting('sweepTermsHad'), ['blister']);
    const wr = await boss.post('/api/drops', { store: r.id, words: 'destined r3', aco: true, maxPrice: 100 });
    assert.equal(wr.status, 200, wr.text);
    const w = wr.body.watch;
    clock.offset += 5000;
    assert.equal((await ingest(r, { keyword: 'destined r3', page: 1, drop: 'shared' }, [])).ok, true);
    clock.offset += 5000;
    const B = prod('jbhifi', 'pokemon-destined-r3-blister', 'Pokemon Destined R3 Blister', 31, { inStock: true });
    const M = prod('jbhifi', 'pokemon-destined-r3-playmat', 'Pokemon Destined R3 Playmat', 32, { inStock: true });
    const s = await ingest(r, { keyword: 'pokemon', page: 1 }, [B, M]);
    assert.equal(s.baseline, false);
    await env.app.monitor.delivered();
    assert.deepEqual(Object.fromEntries(env.app.drops.get(w.id).found.map((f) => [f.sku, f.arm])), { 'pokemon-destined-r3-blister': 'armed', 'pokemon-destined-r3-playmat': 'skipped' });
    assert.equal(bought(r.id, B.sku).runs, 1, 'the blister bought');
    assert.equal(bought(r.id, M.sku).runs, 0);
    // The quiet window over: a playmat new to the catalogue counts for alerts now — and still isn't a drop for the watch
    // by the card search alone (the catalogue never tracked one before the words widened), as before.
    clock.offset += 6 * 3600 * 1000 + MIN;
    assert.equal(sw().widenedLately(), false);
    // (Not read for 6 hours: its scene set again first.)
    assert.equal((await ingest(r, { keyword: 'pokemon', page: 1 }, [])).baseline, true);
    clock.offset += 5000;
    const M2 = prod('jbhifi', 'pokemon-destined-r3-playmat-deluxe', 'Pokemon Destined R3 Playmat Deluxe', 33, { inStock: true });
    const s2 = await ingest(r, { keyword: 'pokemon', page: 1 }, [M2]);
    assert.deepEqual([s2.ok, s2.baseline], [true, false]);
    await env.app.monitor.delivered();
    assert.equal(env.app.drops.get(w.id).found.find((f) => f.sku === M2.sku).arm, 'skipped');
    assert.equal(bought(r.id, M2.sku).runs, 0);
    assert.ok(env.app.catalog.productFor(r.id, M2.sku), 'tracked: the widened words count it');
    assert.equal((await boss.del(`/api/drops/${w.id}`)).status, 200);
  } finally {
    repo.setSetting('sweep', keep.sweep);
    repo.setSetting('sweepWidenedAt', keep.at);
    repo.setSetting('sweepTermsHad', keep.had);
    }
});

test("🔔 a store whose alerts keep coming (two lots of DMs still going out there): a search's own DMs go out while it waits for them alone — never behind another's lot", async () => {
  const mon = env.app.monitor;
  const hold = [];
  const slow = () => new Promise((r) => hold.push(r));
  mon.deliver([slow], 'demo-flapping');
  mon.deliver([slow], 'demo-flapping');
  let sent = false;
  const third = mon.deliver([async () => { sent = true; }], 'demo-flapping').then(() => 'out');
  const was = await Promise.race([third, new Promise((r) => setTimeout(() => r('waiting'), 500))]);
  assert.equal(was, 'out', 'its own DMs sent, not waiting on the others');
  assert.equal(sent, true);
  assert.equal(hold.length, 2, 'the other lots still going');
  hold.forEach((r) => r());
  await mon.delivered();
});
