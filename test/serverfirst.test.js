// Server first (docs/MONITORING.md): every store is searched from Mugibot's server, and an admin's
// browser stands in only while the store refuses the server (3 searches in a row; 1 at a store known
// to turn servers away) or the server can't read its products (BIG W's page draws them once it's
// open). Meanwhile the server tries again after 5 minutes, twice as long each time it's still turned
// away (30 at most), and takes back over the moment the store answers it — gently at first. What a
// store asked for (Retry-After) is waited for. Members never see where searches come from.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client, makeMember, startApp, waitFor } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { parseListing } from '../server/monitor/listing.js';

let env;
let store;
let boss;
let ash;
let sw;
let clock;
let admin;
const MIN = 60 * 1000;

before(async () => {
  store = await startMockStore();
  clock = { offset: 0 };
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, now: () => Date.now() + clock.offset });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  makeMember(env, ash);
  sw = env.app.sweeper;
  admin = env.app.repo.userByUsername('boss');
  // The real stores off (tests never touch them); the dummy ones server first.
  const off = Object.fromEntries(sw.stores().filter(({ retailer: r }) => !r.demo).map(({ retailer: r }) => [r.id, 'off']));
  const r = await boss.put('/api/monitor/sweep', { stores: { ...off, 'demo-kmart': 'auto', 'demo-amazon': 'auto', 'demo-bigw': 'auto', 'demo-jbhifi': 'auto' } });
  assert.equal(r.status, 200, r.text);
});
after(async () => {
  sw.stop();
  await env.close();
  await store.close();
});
beforeEach(() => {
  store.state.blockNonBrowsers = false;
  store.state.tooMany = {};
});

const R = (id) => env.app.retailers.get(id);
const sweep = (id, keyword = 'pokemon', page = 1) => sw.sweepTerm(R(id), { keyword, page });
const card = (id) => sw.live().stores.find((s) => s.id === id);
const due = (id) => sw.browserDue(admin, { version: '99.0.0' }).terms.find((t) => t.store === id);
const sys = (re) => sw.events.some((e) => e.type === 'sys' && re.test(e.message));
const fresh = (id) => Object.assign(sw.stat(id), { backup: null, serverMisses: 0, fails: 0, failKind: '', slowUntil: 0, refusedUntil: 0, resetAt: 0, retryAt: 0, browserNext: 0, lastError: '' });

/** What an admin's browser reads at a store (the dummy store lets browsers in): the same code the server uses. */
async function browserRead(id, keyword = 'pokemon') {
  sw.stat(id).turn = 0; // (the first keyword's first page)
  const t = due(id);
  assert.ok(t, `${id} given to the admin's browser`);
  const r = R(id);
  const text = await (await fetch(t.url, { headers: { 'user-agent': 'Mozilla/5.0 Chrome' } })).text();
  const parsed = parseListing(r.sweep.parser, text, { base: t.url, storeBase: r.base, productPath: r.productPath, skuFromPath: r.skuFromPath, storeName: r.name });
  return sw.browserResults(admin, [{ store: id, keyword: t.keyword || keyword, page: t.page, ok: true, status: 200, ms: 250, products: parsed.products }]);
}

test("every store is server first unless an admin says otherwise (BIG W: an admin's browser); the dummy stores' copies are off", () => {
  for (const id of ['target', 'kmart', 'amazon', 'ebgames', 'pbandai', 'pokemoncenter', 'jbhifi']) assert.equal(sw.defaultMode(R(id)), 'auto', id);
  // BIG W: an admin's browser (its private window) — the server can never draw its products.
  assert.equal(sw.defaultMode(R('bigw')), 'browser');
  assert.equal(sw.defaultMode(R('zing')), 'off');
  assert.equal(sw.modeFor(R('zing')), 'off', "Zing's site sends you to EB Games: never searched, whatever was saved");
  assert.equal(sw.defaultMode(R('demo-kmart')), 'off');
  assert.equal(sw.modeFor(R('demo-kmart')), 'auto');
  assert.equal(sw.sourceOf(R('demo-kmart')), 'server');
  assert.equal(due('demo-kmart'), undefined, "no admin's browser while the server's let in");
});

test("refused 3 times in a row: an admin's browser stands in, the server tries again in 5, 10, 20, then every 30 minutes, and takes back over once it's let in", async () => {
  const id = 'demo-kmart';
  fresh(id);
  store.state.blockNonBrowsers = true;
  for (let i = 1; i <= 2; i++) {
    const r = await sweep(id);
    assert.equal(r.ok, false);
    assert.equal(sw.stat(id).backup, null, `still the server's after ${i}`);
    assert.equal(due(id), undefined);
  }
  assert.ok(sys(/Kmart \(dummy store\) refused a search — searching it at a third of the pace/));
  const at = sw.now();
  await sweep(id);
  const st = sw.stat(id);
  assert.ok(st.backup, 'handed over at the third');
  assert.equal(st.backup.tries, 1);
  assert.ok(Math.abs(st.backup.retryAt - (at + 5 * MIN)) < 2000, 'the server tries again in 5 minutes');
  assert.equal(st.fails, 0, "the browser starts afresh: the failures were the server's");
  assert.equal(st.slowUntil, 0);
  assert.ok(sys(/Kmart \(dummy store\): Mugibot's server is refused \(The store refused the search \(HTTP 403\)\) — an admin's browser searches it meanwhile, and the server tries again within 5 min/));
  let c = card(id);
  assert.deepEqual([c.mode, c.source, c.status], ['auto', 'browser', 'waiting'], "waiting for an admin's browser");
  assert.equal(c.backup.tries, 1);
  // (No admin's browser searching it yet: the server keeps trying at its usual backoff — 40 s here.)
  assert.ok(Math.abs(c.backup.retryAt - (at + 40 * 1000)) < 2000, `${c.backup.retryAt - at} ms`);
  // The admin's browser is given its searches, and what it reads counts.
  const [res] = await browserRead(id);
  assert.equal(res.ok, true, res.error);
  assert.ok(res.found >= 1);
  c = card(id);
  assert.equal(c.status, 'ok');
  assert.equal(c.source, 'browser');
  assert.equal(c.backup.retryAt, st.backup.retryAt, 'the browser standing in: the server tries again in 5 minutes');
  const h = sw.health().find((x) => x.store === id);
  assert.deepEqual([h.mode, h.source, h.defaultMode], ['auto', 'browser', 'off']);

  // The server's tries while it stands in: each one turned away waits twice as long (30 minutes at most);
  // the store's state stays the browser's, and members never see a try.
  const tries = [];
  for (const wait of [10, 20, 30, 30]) {
    const before = sw.now();
    const r = await sweep(id);
    assert.equal(r.ok, false);
    assert.equal(sw.stat(id).fails, 0, "a try doesn't count against the browser");
    assert.equal(card(id).status, 'ok');
    tries.push(Math.round((sw.stat(id).backup.retryAt - before) / MIN));
    assert.equal(wait, tries.at(-1));
  }
  const trial = sw.events.filter((e) => e.type === 'err' && e.store === id).at(-1);
  assert.equal(trial.trial, true);
  const live = (await ash.get('/api/monitor/live')).body;
  assert.ok(!live.events.some((e) => e.trial || (e.type === 'err' && e.store === id && e.at >= trial.at)), "members don't see the server's tries");
  assert.ok(!live.events.some((e) => e.type === 'sys' && /server|browser/i.test(e.message)), 'nor who searches what');
  const mine = live.stores.find((x) => x.id === id);
  assert.deepEqual([mine.source, mine.backup, mine.mode, mine.status], [undefined, undefined, undefined, 'ok']);

  // Let back in: the server takes over at once, gently for 10 minutes, and the browser's left be.
  store.state.blockNonBrowsers = false;
  const back = await sweep(id);
  assert.equal(back.ok, true, back.error);
  assert.equal(sw.stat(id).backup, null);
  assert.ok(sw.stat(id).slowUntil > sw.now(), 'gently at first');
  assert.ok(sys(/Kmart \(dummy store\): Mugibot's server is searching it again — the store answered \(an admin's browser stood in for \d+ min\)/));
  assert.equal(sw.events.filter((e) => e.type === 'hb' && e.store === id).at(-1).trial, true);
  c = card(id);
  assert.deepEqual([c.source, c.backup], ['server', null]);
  assert.equal(due(id), undefined, 'no more searches for the browser');
  // (A search it was given just before is still taken; later ones aren't the browser's to report.)
  const products = [{ sku: '43818648', title: 'Pokemon TCG Scarlet Violet Elite Trainer Box', price: 60, inStock: true }];
  assert.equal((await sw.browserResults(admin, [{ store: id, keyword: 'pokemon', page: 1, ok: true, products }])).length, 1);
  clock.offset += 3 * MIN;
  assert.deepEqual(await sw.browserResults(admin, [{ store: id, keyword: 'pokemon', page: 1, ok: true, products }]), []);
});

test('a store known to turn servers away (Amazon: HTTP 503) hands over at the first refusal', async () => {
  const id = 'demo-amazon';
  fresh(id);
  assert.equal(R(id).sweep.from, 'browser');
  const r = await sweep(id);
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 503/);
  assert.ok(sw.stat(id).backup, 'straight away');
  assert.ok(due(id), "an admin's browser searches it");
  fresh(id);
});

test("BIG W's page draws its products once it's open: the server reading none hands over at once, and sets no scene (no flood of \"new\")", async () => {
  const id = 'demo-bigw';
  fresh(id);
  const shop = store.shop('bigw');
  shop.clientSearch = true; // like the real site: no products in the page until its own code fetches them
  try {
    const r = await sweep(id);
    assert.equal(r.ok, false);
    assert.match(r.error, /Mugibot's server can't read the products: they only show once the store's page has run/);
    assert.ok(sw.stat(id).backup);
    const row = env.app.db.get("SELECT * FROM sweep_terms WHERE store = :s AND keyword = 'pokemon' AND page = 1", { s: id });
    assert.equal(row.baseline_at, null, "the server's empty read isn't the first look");
    // The browser's first read is: everything already there is tracked, nothing alerts.
    const alertsBefore = env.app.catalog.recentAlerts({ kind: 'listed', limit: 100 }).filter((a) => a.store === id).length;
    shop.clientSearch = false; // (the dummy store's page, as the browser's drawn it)
    const [res] = await browserRead(id);
    assert.equal(res.ok, true, res.error);
    assert.equal(res.baseline, true);
    assert.ok(res.found >= 1);
    assert.equal(env.app.catalog.recentAlerts({ kind: 'listed', limit: 100 }).filter((a) => a.store === id).length, alertsBefore);
    // The server's next try still reads none: still the browser's.
    shop.clientSearch = true;
    assert.equal((await sweep(id)).ok, false);
    assert.ok(sw.stat(id).backup);
    assert.equal(sw.stat(id).backup.tries, 2);
    // The store starts sending its products with the page: the server takes back over.
    shop.clientSearch = false;
    assert.equal((await sweep(id)).ok, true);
    assert.equal(sw.stat(id).backup, null);
  } finally {
    shop.clientSearch = false;
    fresh(id);
  }
});

test("no products from the server where an admin's browser found some within the hour is a miss, not an empty search", async () => {
  const id = 'demo-jbhifi';
  const r = R(id);
  fresh(id);
  const url = sw.urlFor(r, 'pokemon');
  const products = [{ sku: 'pokemon-tcg-x-etb', title: 'Pokemon TCG X Elite Trainer Box', price: 80, inStock: true, url: '' }];
  env.app.db.run("DELETE FROM sweep_terms WHERE store = :s", { s: id });
  await sw.ingest(r, { keyword: 'pokemon', page: 1 }, { products, total: null, problem: null }, { source: 'browser', url, ms: 300 });
  const miss = await sw.ingest(r, { keyword: 'pokemon', page: 1 }, { products: [], total: 0, problem: 'empty' }, { source: 'server', url, ms: 80 });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /Mugibot's server got no products, where an admin's browser finds some/);
  assert.equal(sw.stat(id).serverMisses, 1);
  assert.equal(sw.stat(id).backup, null, 'one miss: still the server');
  // Another keyword with nothing found anywhere is just an empty search.
  const empty = await sw.ingest(r, { keyword: 'one piece', page: 1 }, { products: [], total: 0, problem: 'empty' }, { source: 'server', url: sw.urlFor(r, 'one piece'), ms: 80 });
  assert.equal(empty.ok, true);
  assert.equal(sw.stat(id).serverMisses, 0);
  fresh(id);
});

test('Retry-After while the browser stands in holds the server\'s next try (not the browser); Reset puts the server first again and keeps the wait', async () => {
  const id = 'demo-kmart';
  fresh(id);
  store.state.blockNonBrowsers = true;
  for (let i = 0; i < 3; i++) await sweep(id);
  store.state.blockNonBrowsers = false;
  const st = sw.stat(id);
  assert.ok(st.backup);
  store.state.tooMany = { kmart: 900 };
  const r = await sweep(id);
  assert.match(r.error, /HTTP 429\) — it asked to wait 900 s/);
  assert.ok(st.backup.waitUntil - sw.now() > 14 * MIN, "the server's next try waits for it");
  assert.equal(st.retryAt, 0, "the admin's browser isn't held by the server's wait");
  assert.ok(due(id), "the admin's browser carries on");
  assert.ok(card(id).backup.retryAt >= st.backup.waitUntil, 'shown as when the server tries again');
  store.state.tooMany = {};
  // Reset: server first again — what the store asked for still waited for.
  const wait = st.backup.waitUntil;
  sw.reset(id, admin);
  assert.equal(st.backup, null);
  assert.equal(st.serverMisses, 0);
  assert.equal(st.retryAt, wait);
  assert.equal(st.freshTab, true, "if the browser stands in again, its tab starts afresh");
  assert.equal(due(id), undefined);
  fresh(id);
});

test("pinned to the server only while the browser stood in: nothing stands in any more, and its failures count again", async () => {
  const id = 'demo-kmart';
  fresh(id);
  store.state.blockNonBrowsers = true;
  for (let i = 0; i < 3; i++) await sweep(id);
  assert.ok(sw.stat(id).backup);
  const stores = { ...sw.settings.stores };
  try {
    sw.save({ stores: { ...stores, [id]: 'server' } }, admin);
    assert.equal(sw.stat(id).backup, null);
    assert.equal(due(id), undefined);
    const r = await sweep(id);
    assert.equal(r.ok, false);
    assert.equal(sw.stat(id).fails, 1, "the server's own failure");
    assert.equal(card(id).status, 'retrying');
  } finally {
    store.state.blockNonBrowsers = false;
    sw.save({ stores }, admin);
    fresh(id);
  }
});

test("⚡ a store only struggling at a drop (502s, timeouts, a page without its list) isn't turning the server away: searched again soon, not backed off for minutes — three misses in a row hand it to an admin's browser as ever, the server tries again a minute later and is straight back at its pace; a refusal still backs off", async () => {
  const id = 'demo-kmart';
  fresh(id);
  const st = sw.stat(id);
  const every = sw.paceFor(R(id));
  const seq = sw.seq;
  const since = (re) => sw.events.some((e) => e.id > seq && e.type === 'sys' && re.test(e.message));
  const real = sw.fetch;
  let answer = '502';
  sw.fetch = async (url, init) => {
    if (answer === '502') return new Response('<html><title>502 Bad Gateway</title></html>', { status: 502 });
    if (answer === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (answer === 'layout') return new Response('<html><title>Please wait</title><body>We are busy</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (answer === '403') return new Response('Forbidden', { status: 403 });
    return real(url, init);
  };
  try {
    for (const [i, a] of ['502', 'timeout'].entries()) {
      answer = a;
      const r = await sweep(id);
      assert.deepEqual([r.ok, r.blocked], [false, false], `${a}: ${r.error}`);
      if (a === 'timeout') assert.equal(r.error, 'The store took too long to answer');
      assert.equal(st.backup, null, `still the server's after ${i + 1} (${a})`);
      assert.equal(st.failKind, 'transient', a);
      assert.equal(sw.waitFor(st, every), every * 2, `at half its pace after ${i + 1}`);
    }
    // (A search that took long to fail spaced itself already: the next one isn't held back for it as well.)
    assert.equal(sw.waitFor(st, every, { spent: 2 * MIN }), 500);
    assert.equal(st.slowUntil, 0, 'not slowed: it turned nobody away');
    assert.ok(!since(/refused a search/), "not said to have refused anything");
    assert.equal(card(id).status, 'retrying');

    // The third miss in a row (a page without its list): an admin's browser stands in, as ever — and the server tries
    // again within a minute.
    answer = 'layout';
    let at = sw.now();
    await sweep(id);
    // (From when the search was in: its waits start then — however long the store took to answer.)
    const done = sw.now();
    assert.ok(st.backup, 'handed over at the third miss');
    assert.equal(st.backup.transient, true);
    assert.ok(Math.abs(st.backup.retryAt - (at + MIN)) < 2000, `the server tries again in a minute (${st.backup.retryAt - at} ms)`);
    assert.ok(st.backup.idleAt - done <= Math.max(every * 2, MIN), `no admin's browser searching yet: a minute at most too (${st.backup.idleAt - done} ms)`);
    assert.ok(since(/Kmart \(dummy store\): Mugibot's server gets no answer from it \(.+\) — an admin's browser searches it meanwhile, and the server tries again within a minute/));
    answer = '502';
    // Still struggling at its try: twice as long (2 minutes), not 10.
    at = sw.now();
    await sweep(id);
    assert.equal(st.backup.tries, 2);
    assert.ok(Math.abs(st.backup.retryAt - (at + 2 * MIN)) < 2000, `${st.backup.retryAt - at} ms`);
    // Answering again: the server's straight back, at its own pace (not a third of it).
    answer = 'ok';
    const back = await sweep(id);
    assert.equal(back.ok, true, back.error);
    assert.equal(st.backup, null);
    assert.equal(st.slowUntil, 0, 'straight back at its pace: it never turned the server away');
    assert.equal(sw.waitFor(st, every), every);

    // A refusal is one, as ever: three misses in a row hand over — a timeout while it's in force is one of them — and its
    // backoff stands.
    fresh(id);
    answer = '403';
    await sweep(id);
    assert.ok(st.slowUntil > sw.now(), 'a refusal: searched gently');
    answer = 'timeout';
    await sweep(id);
    assert.equal(sw.waitFor(st, every), every * 4, "the refusal's backoff stands");
    assert.equal(st.serverMisses, 2, 'a timeout after a refusal: a miss');
    answer = '403';
    await sweep(id);
    assert.ok(st.backup, 'three misses: handed over');
    assert.equal(st.backup.transient, false);
    assert.ok(Math.abs(st.backup.retryAt - (sw.now() + 5 * MIN)) < 2000);

    // …and a refusal followed by minutes of timeouts (bot protection that turns away, then stalls) is no "struggling"
    // store: handed over as refused — the server back in 5 minutes, gently at first — never at once at full pace.
    fresh(id);
    answer = '403';
    await sweep(id);
    answer = 'timeout';
    for (let i = 0; i < 3 && !st.backup; i++) {
      clock.offset += MIN;
      await sweep(id);
    }
    assert.ok(st.backup, 'handed over');
    assert.equal(st.backup.transient, false, "a refusal's: not a struggling store's");
    assert.ok(Math.abs(st.backup.retryAt - (sw.now() + 5 * MIN)) < 2000, `${st.backup.retryAt - sw.now()} ms`);
    answer = 'ok';
    assert.equal((await sweep(id)).ok, true);
    assert.equal(st.backup, null);
    assert.ok(st.slowUntil > sw.now(), 'taken back gently, as after any refusal');

    // ↻ Reset (searched gently after it, though nobody was turned away), then a struggling store: still only struggling —
    // no "refused", no 5-minute wait for the server.
    fresh(id);
    sw.reset(id, admin);
    assert.ok(st.slowUntil > sw.now(), "Reset's gentle start");
    answer = '502';
    for (let i = 0; i < 3; i++) {
      clock.offset += 20 * 1000;
      at = sw.now();
      await sweep(id);
    }
    assert.ok(st.backup, 'three misses: handed over');
    assert.equal(st.backup.transient, true, 'only struggling');
    assert.ok(Math.abs(st.backup.retryAt - (at + MIN)) < 2000, `the server tries again in a minute (${st.backup.retryAt - at} ms)`);
  } finally {
    sw.fetch = real;
    fresh(id);
  }
});

test("the loop: while the browser stands in, the server only tries when it's time (Sweep now: straight away); let back in, it searches as before", async () => {
  const id = 'demo-kmart';
  // (Its searches: the server's tries are a keyword's; back in, its whole range in one list — both from Constructor.io.)
  const searches = () => store.state.requests.filter((x) => x.path.startsWith('/kmart/cnstrc/')).length;
  const others = Object.fromEntries(['demo-amazon', 'demo-bigw', 'demo-jbhifi'].map((x) => [x, 'off']));
  await boss.put('/api/monitor/sweep', { stores: { ...sw.settings.stores, ...others } });
  fresh(id);
  store.state.blockNonBrowsers = true;
  for (let i = 0; i < 3; i++) await sweep(id);
  assert.ok(sw.stat(id).backup);
  sw.running = false;
  sw.cfg.monitor.enabled = true;
  sw.start();
  try {
    assert.ok(sys(/Live sweeps started — Kmart \(dummy store\) from Mugibot's server first/));
    assert.ok(sw.loops.has(id), 'a server loop for a server-first store');
    assert.equal((await boss.get('/api/monitor/sweep')).body.stores.find((s) => s.store === id).running, true);
    const n = searches();
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(searches(), n, 'no try before its time');
    // Its time comes: one try (still refused), then it waits again (10 minutes).
    clock.offset += 5 * MIN + 1000;
    sw.restart();
    await waitFor(() => searches() === n + 1, { timeout: 5000, message: "the server's try" });
    await waitFor(() => sw.stat(id).backup && sw.stat(id).backup.tries === 2, { timeout: 5000, message: 'the try counted' });
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(searches(), n + 1);
    // Sweep now: the server tries straight away — and, let in, takes back over and carries on.
    store.state.blockNonBrowsers = false;
    sw.sweepNow();
    await waitFor(() => !sw.stat(id).backup, { timeout: 5000, message: 'the server back' });
    sw.stat(id).slowUntil = 0;
    sw.restart();
    await waitFor(() => searches() >= n + 3, { timeout: 15000, message: 'searching as before' });
  } finally {
    sw.stop();
    sw.cfg.monitor.enabled = false;
    fresh(id);
  }
});

test("The Gamesmen (its Cloudflare turns servers away): refused once, an admin's browser stands in — it opens Magento's search page and reads its tiles; Pokébox and Games World answer the server", async () => {
  const id = 'demo-gamesmen';
  sw.save({ stores: { ...sw.settings.stores, [id]: 'auto', 'demo-pokebox': 'auto', 'demo-gamesworld': 'auto' } }, null);
  fresh(id);
  store.shop('gamesmen').refuseServers = true;
  try {
    const r = await sweep(id);
    assert.equal(r.ok, false);
    assert.ok(sw.stat(id).backup, 'handed over at the first refusal (a store known to turn servers away)');
    assert.ok(sys(/The Gamesmen \(dummy store\): Mugibot's server is refused \(The store refused the search \(HTTP 403\)\)/));
    const t = due(id);
    assert.deepEqual([t.render, t.parser], [true, 'magento'], 'its search page opened in the browser and read');
    assert.equal(t.url, `${store.url}/gamesmen/catalogsearch/result/?q=${encodeURIComponent(t.keyword)}&product_list_order=recently-listed`);
    sw.stat(id).browserNext = 0; // (given out just now: given again for the read below)
    const [res] = await browserRead(id);
    assert.equal(res.ok, true, res.error);
    const etb = env.app.catalog.productFor(id, 'pokemon-tcg-mega-evolution-perfect-order-elite-trainer-box');
    assert.deepEqual([etb.status, etb.price], ['in_stock', 119.95]);
    assert.match(etb.url, /\/gamesmen\/pokemon-tcg-mega-evolution-perfect-order-elite-trainer-box$/);
    assert.equal(env.app.catalog.productFor(id, 'pokemon-tcg-mega-evolution-pitch-black-elite-trainer-box').status, 'out_of_stock');
    assert.equal(card(id).source, 'browser');
  } finally {
    store.shop('gamesmen').refuseServers = false;
    fresh(id);
  }
  // The others answer Mugibot's server: nothing for the browser.
  for (const other of ['demo-pokebox', 'demo-gamesworld']) {
    fresh(other);
    const r = await sweep(other);
    assert.equal(r.ok, true, `${other}: ${r.error}`);
    assert.equal(due(other), undefined, `${other}: no admin's browser while the server's let in`);
  }
  sw.save({ stores: { ...sw.settings.stores, [id]: 'off', 'demo-pokebox': 'off', 'demo-gamesworld': 'off' } }, null);
});

test("⚡ an admin's browser, searching each store on its own: a store it's still searching (busy) isn't handed out again until that search is in — no two at once there, no keyword's turn lost — and its pace can be as quick as 2 s", async () => {
  fresh('demo-bigw');
  const mode = sw.settings.stores['demo-bigw'] || 'auto';
  sw.save({ stores: { ...sw.settings.stores, 'demo-bigw': 'browser' } }, null);
  let r = await boss.put('/api/monitor/sweep', { browserEverySeconds: 2 });
  assert.equal(r.status, 200, r.text);
  assert.equal(sw.settings.browserEverySeconds, 2);
  assert.equal(sw.paceFor(R('demo-gamesmen'), true), 2000, 'a store with no floor of its own: the set pace');
  assert.equal(sw.paceFor(R('demo-bigw'), true), 20000, "BIG W's own floor: one search every 20 s");
  r = await boss.put('/api/monitor/sweep', { browserEverySeconds: 1 });
  assert.equal(sw.settings.browserEverySeconds, 2, '2 s at the quickest');
  const turn = sw.stat('demo-bigw').turn;
  const held = sw.browserDue(admin, { version: '99.0.0', busy: new Set(['demo-bigw']) });
  assert.ok(!held.terms.some((t) => t.store === 'demo-bigw'), 'not given while its search is going');
  assert.equal(sw.stat('demo-bigw').turn, turn, "its keyword's turn kept for the next one");
  assert.equal(held.waitMs, null, 'nothing else due: the browser asks again the moment its search is in');
  assert.ok(due('demo-bigw'), 'given again once its search is in');
  await boss.put('/api/monitor/sweep', { browserEverySeconds: 15 });
  sw.save({ stores: { ...sw.settings.stores, 'demo-bigw': mode } }, null);
  fresh('demo-bigw');
});
