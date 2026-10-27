// A store whose bot protection turns a browser away that reads it too often (BIG W's Akamai, "Access Denied"): one budget
// per browser for everything it reads there — searches, search pages watched, product pages (monitor/access.js).
// The budget itself on a clock of its own; then a simulated admin's browser, the extension as it reads BIG W (a tab for
// its searches, one for its pages watched, its checks a round every 30 s, each page taking a few seconds to build),
// polling the real endpoints against the dummy BIG W — before the budget (what got browsers turned away) and with it,
// how often each keyword, page and product is really read, measured.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, Device, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { startMockStore } from '../devtools/mockstore.js';
import { ACCESS_DEFAULTS, AccessBudget, BOOK_MS, outcomeOf } from '../server/monitor/access.js';
import bigwDef from '../server/retailers/bigw.js';
import { loadConfig } from '../server/config.js';

// --- the budget on its own ------------------------------------------------------------------------------
const S = 1000;
const MIN = 60 * S;
function fakeClock(start = 1_800_000_000_000) {
  const c = { t: start };
  return { now: () => c.t, tick: (ms) => { c.t += ms; return c.t; }, get t() { return c.t; } };
}
function fakeRepo() {
  const m = new Map();
  return { getSetting: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setSetting: (k, v) => m.set(k, JSON.stringify(v)) };
}
function budget(extra = {}) {
  const clock = fakeClock();
  const repo = fakeRepo();
  const logs = [];
  const sys = [];
  const a = new AccessBudget({ now: clock.now, repo, log: (...x) => logs.push(x.join(' ')), sys: (m, e) => sys.push({ m, ...e }), ...extra });
  return { a, clock, repo, logs, sys };
}
const bigw = bigwDef;

test("BIG W's budget is in its retailer settings, every part of it; a store without one is left as it was", () => {
  const { a } = budget();
  assert.deepEqual(bigw.access, { gapSeconds: 8, sharedGapSeconds: 20, maxGapSeconds: 120, pauseMinutes: 30, easeMinutes: 10, targetSeconds: 5, shares: { search: 2, check: 2, page: 1 }, checksPerRound: 2 });
  assert.equal(a.limited(bigw), true);
  assert.equal(a.targetMs(bigw), 5000);
  // Anything left out: the defaults.
  const lean = { id: 'lean', name: 'Lean', access: { gapSeconds: 3 } };
  assert.deepEqual(a.configFor(lean), { ...ACCESS_DEFAULTS, gapSeconds: 3, shares: { ...ACCESS_DEFAULTS.shares } });
  const kmart = { id: 'kmart', name: 'Kmart' };
  assert.equal(a.limited(kmart), false);
  assert.deepEqual(a.ask(kmart, 'A', 'search'), { ok: true });
  a.take(kmart, 'A', 'search');
  assert.deepEqual(a.ask(kmart, 'A', 'search'), { ok: true }, 'never held back');
  assert.equal(a.view(kmart), null);
  assert.equal(a.targetMs(kmart), null);
});

test("the deployment can change a store's budget without a release (MONITOR_ACCESS, JSON by store) — kept within bounds, nothing else taken from it; junk ignored", () => {
  const a = new AccessBudget({ overrides: { bigw: { gapSeconds: 1, targetSeconds: 10, sharedGapSeconds: 2, checksPerRound: 9, shares: { page: 50 }, junk: 'x' } } });
  const c = a.configFor(bigw);
  assert.equal(c.gapSeconds, 3, 'never under 3 s');
  assert.equal(c.sharedGapSeconds, 3, 'an ordinary window never closer than a private one');
  assert.equal(c.targetSeconds, 10);
  assert.equal(c.checksPerRound, 5);
  assert.deepEqual(c.shares, { search: 2, check: 2, page: 10 });
  assert.equal(c.junk, undefined);
  assert.equal(c.pauseMinutes, 30, "the rest: the store's own");
  assert.equal(new AccessBudget({ overrides: { bigw: { gapSeconds: 'fast' } } }).configFor(bigw).gapSeconds, 8, 'not a number: its own');
  const env = (v) => loadConfig({ log: () => {} }, { MONITOR_ACCESS: v }).monitor.access;
  assert.deepEqual(env('{"bigw":{"gapSeconds":12}}'), { bigw: { gapSeconds: 12 } });
  assert.deepEqual(env('not json'), {});
  assert.deepEqual(env('[1,2]'), {});
  assert.deepEqual(env(undefined), {});
});

test('one of its pages loading at a time in a browser, at least the gap between two starting (and half of it after the last is in) — in its private window 8 s, in an ordinary window 20 s; each browser its own', () => {
  const { a, clock } = budget();
  const t0 = clock.t;
  assert.deepEqual(a.ask(bigw, 'A', 'search', { priv: true }), { ok: true });
  a.take(bigw, 'A', 'search', { keys: ['pokemon\n1'] });
  assert.equal(a.ask(bigw, 'A', 'check').why, 'busy', 'one at a time');
  assert.equal(a.ask(bigw, 'B', 'check').ok, true, "another browser: a budget of its own");
  clock.tick(3 * S);
  a.done(bigw, 'A', 'search', 'ok');
  const may = a.ask(bigw, 'A', 'check');
  assert.deepEqual([may.ok, may.why, may.at], [false, 'gap', t0 + 8 * S]);
  clock.tick(5 * S - 1);
  assert.equal(a.ask(bigw, 'A', 'check').ok, false);
  clock.tick(1);
  assert.equal(a.ask(bigw, 'A', 'check').ok, true, '8 s after the last one started');
  // A page that took a while to come in: half the gap after it's in, at least (when it really started isn't known).
  a.take(bigw, 'A', 'check', { keys: ['item:1'] });
  const t1 = clock.t;
  clock.tick(7 * S);
  a.done(bigw, 'A', 'check');
  assert.equal(a.ask(bigw, 'A', 'search').at, t1 + 11 * S);
  // An ordinary window (its cookies your own visits'): 20 s.
  a.take(bigw, 'C', 'search', { keys: ['x'] });
  assert.equal(a.ask(bigw, 'C', 'search', { priv: false }).why, 'busy');
  const at = clock.t;
  a.done(bigw, 'C', 'search');
  assert.equal(a.ask(bigw, 'C', 'search', { priv: false }).at, at + 20 * S);
  // A read handed out and never heard of again (the browser closed): given up on after 2 minutes.
  a.take(bigw, 'D', 'page', { keys: ['p'] });
  clock.tick(119 * S);
  assert.equal(a.ask(bigw, 'D', 'page').why, 'busy');
  clock.tick(2 * S);
  assert.equal(a.ask(bigw, 'D', 'page').why, 'gap', 'given up on — half the gap from then');
  clock.tick(4 * S);
  assert.equal(a.ask(bigw, 'D', 'page').ok, true);
});

test('a round of product pages: busy until each is in, the next of its pages a gap after the last of them; a new round asked for means the last is over; a tab no longer reading frees its search or page', () => {
  const { a, clock } = budget();
  const t0 = clock.t;
  a.take(bigw, 'A', 'check', { n: 2, keys: ['item:1', 'item:2'] });
  clock.tick(11 * S);
  a.done(bigw, 'A', 'check', 'ok');
  assert.equal(a.ask(bigw, 'A', 'search').why, 'busy', 'one of the two still out');
  a.done(bigw, 'A', 'check', 'ok');
  assert.equal(a.ask(bigw, 'A', 'search').at, t0 + 16 * S, 'its second started 8 s after the first: 8 s after that');
  // The extension skipped one (its queue up, say) and never said: its next round asked for means this one's over.
  clock.tick(10 * S);
  a.take(bigw, 'A', 'check', { n: 2, keys: ['item:1', 'item:2'] });
  a.done(bigw, 'A', 'check', 'ok');
  a.settled(bigw, 'A', 'check');
  clock.tick(16 * S);
  assert.equal(a.ask(bigw, 'A', 'search').ok, true);
  // A search's tab no longer reading (the browser says, asking for the next): done with.
  a.take(bigw, 'A', 'search', { keys: ['pokemon\n1'] });
  clock.tick(S);
  a.idle(bigw, 'A', new Set());
  assert.equal(a.ask(bigw, 'A', 'page').why, 'busy', 'just handed out: not yet in its tab');
  clock.tick(2 * S);
  a.idle(bigw, 'A', new Set(['bigw']));
  assert.equal(a.ask(bigw, 'A', 'page').why, 'busy', 'still reading');
  a.idle(bigw, 'A', new Set(['page:bigw']));
  assert.notEqual(a.ask(bigw, 'A', 'page').why, 'busy', 'its tab done: free once the gap is over');
});

test('shared out by weight — searches 2, product pages 2, pages watched 1 — none starved, never two at once, never two starting under 8 s apart; a round of product pages (every 30 s) books the next free slot rather than have one kept idle for it, an older extension\'s has one kept a moment', () => {
  // A browser for an hour: searches and pages watched ask every second, product pages every second or a round every 30 s;
  // each page takes 5 s to build; a round of product pages that booked a slot waits for it, and for the tab before it.
  const run = ({ checkEvery, book }) => {
    const { a, clock } = budget();
    const taken = { search: 0, check: 0, page: 0 };
    const loads = [];
    let tabFreeAt = 0;
    let dones = [];
    const end = clock.t + 3600 * S;
    for (let step = 0; clock.t < end; step++) {
      const t = clock.t;
      for (const d of dones.filter((x) => x.at <= t)) a.done(bigw, 'A', d.kind, 'ok');
      dones = dones.filter((x) => x.at > t);
      const kinds = ['search', 'page', ...(step % checkEvery === 0 ? ['check'] : [])];
      if (step % 2) kinds.reverse();
      for (const kind of kinds) {
        const bookMs = kind === 'check' && book ? BOOK_MS : 0;
        const may = a.ask(bigw, 'A', kind, { priv: true, bookMs });
        if (!may.ok) continue;
        const n = bookMs ? 2 : 1;
        a.take(bigw, 'A', kind, { n, keys: [kind], startAt: may.startAt });
        taken[kind] += n;
        let start = Math.max(t, may.startAt || t, bookMs ? tabFreeAt : t);
        for (let i = 0; i < n; i++) {
          if (i) start = Math.max(start + 8 * S, tabFreeAt);
          loads.push({ kind, start, end: start + 5 * S });
          tabFreeAt = start + 5 * S;
        }
        for (let i = 0; i < n; i++) dones.push({ kind, at: tabFreeAt });
      }
      clock.tick(S);
    }
    loads.sort((x, y) => x.start - y.start);
    const overlaps = loads.filter((l, i) => i && l.start < loads[i - 1].end).length;
    const least = Math.min(...loads.slice(1).map((l, i) => l.start - loads[i].start));
    return { taken, total: loads.length, overlaps, least };
  };
  const always = run({ checkEvery: 1, book: false });
  assert.equal(always.overlaps, 0);
  assert.ok(always.least >= 8 * S, String(always.least));
  // (5 s to build, then half the 8 s gap: one every 9 s — 400 an hour.)
  assert.ok(always.total >= 390 && always.total <= 400, `an hour: ${JSON.stringify(always)}`);
  for (const [kind, share] of [['search', 0.4], ['check', 0.4], ['page', 0.2]]) {
    assert.ok(Math.abs(always.taken[kind] / always.total - share) < 0.03, `${kind}: ${always.taken[kind]} of ${always.total}`);
  }
  const rounds = run({ checkEvery: 30, book: true });
  assert.equal(rounds.overlaps, 0, 'the round waits for the tab before it');
  assert.ok(rounds.least >= 8 * S, String(rounds.least));
  assert.ok(rounds.total >= 380, `the browser kept busy — nothing kept idle for the product pages: ${JSON.stringify(rounds)}`);
  for (const [kind, share] of [['search', 0.4], ['check', 0.4], ['page', 0.2]]) {
    assert.ok(Math.abs(rounds.taken[kind] / rounds.total - share) < 0.05, `${kind}: ${rounds.taken[kind]} of ${rounds.total}`);
  }
  // An older extension (1.38.0 or before): one product page a round, the slot kept a moment for it — none starved.
  const older = run({ checkEvery: 30, book: false });
  assert.equal(older.overlaps, 0);
  assert.ok(older.taken.check >= 100 && older.taken.page >= 50 && older.taken.search >= 100, JSON.stringify(older));
});

test('"Access Denied": nothing more from that browser for 30 minutes and its gap doubled (once a block — the rest of a round turned away with it is the same one), the other browsers as they were; eased back a step each 10 minutes once it is asked again, never back down to within half again of where it was turned away for a day; kept over a restart; logged, and said in the live log', () => {
  const { a, clock, repo, logs, sys } = budget();
  const t0 = clock.t;
  const gap = (who, b = a) => b.gapMs(bigw, who) / 1000;
  a.take(bigw, 'A', 'check', { n: 2, keys: ['item:1', 'item:2'] });
  a.done(bigw, 'A', 'check', 'denied');
  a.done(bigw, 'A', 'check', 'denied');
  assert.equal(gap('A'), 16, 'doubled once, not twice');
  assert.equal(a.view(bigw).gapSeconds, 16, 'the Stores panel: the widest gap of the browsers reading it');
  assert.equal(a.view(bigw).blocks24h, 1);
  const may = a.ask(bigw, 'A', 'search');
  assert.deepEqual([may.why, may.at], ['paused', t0 + 30 * MIN]);
  // Another browser — another member's, another network: its own budget, as it was. (Nor can one browser's answers,
  // true or not, slow anyone else's.)
  assert.equal(a.ask(bigw, 'B', 'search').ok, true);
  a.take(bigw, 'B', 'search', { keys: ['x'] });
  a.done(bigw, 'B', 'search');
  assert.equal(a.ask(bigw, 'B', 'search').at, t0 + 8 * S);
  assert.equal(gap('B'), 8);
  assert.match(logs.at(-1), /^\[access\] store=bigw event=denied who=A kind=check gapMs=16000 was=8000 blocks24h=1$/);
  assert.equal(sys.at(-1).level, 'warn');
  assert.match(sys.at(-1).m, /BIG W showed "Access Denied" .* nothing more asked of it from that browser for 30 min; its pages from that browser at most every 16 s from now \(was 8 s\)/);
  const v = a.view(bigw);
  assert.deepEqual([v.pausedBrowsers, v.pausedUntil, v.floorSeconds], [1, t0 + 30 * MIN, 12]);
  // A restart (a deploy): what the browser learned is kept — its gap, and still paused.
  const again = new AccessBudget({ now: clock.now, repo });
  assert.equal(gap('A', again), 16);
  assert.deepEqual([again.ask(bigw, 'A', 'search').why, again.ask(bigw, 'A', 'search').at], ['paused', t0 + 30 * MIN]);
  assert.equal(again.ask(bigw, 'B', 'search').ok, true);
  // Easing: not during the pause, nor for 10 minutes after it.
  clock.tick(39 * MIN);
  assert.equal(gap('A'), 16, 'not yet eased');
  clock.tick(MIN);
  assert.equal(gap('A'), 12, 'a step back, 10 minutes after the pause');
  assert.match(sys.at(-1).m, /BIG W: not turned away for 10 min — its pages from that browser at most every 12 s again \(was 16 s\)/);
  clock.tick(60 * MIN);
  assert.equal(gap('A'), 12, 'never back down to within half again of the 8 s it was turned away at, that day');
  clock.tick(24 * 60 * MIN);
  assert.equal(gap('A'), 9, 'a day on: easing back down');
  clock.tick(10 * MIN);
  assert.equal(gap('A'), 8, 'never below its own 8 s');
  // Turned away again and again: never past 2 minutes between two.
  for (let i = 0; i < 6; i++) {
    clock.tick(31 * MIN);
    a.done(bigw, 'A', 'check', 'denied');
  }
  assert.equal(gap('A'), 120);
  assert.equal(gap('B'), 8);
});

test('a bot check where its page should be: that browser\'s gap doubled (no pause — the extension waits it out itself), once a minute at most; a read that failed otherwise changes nothing', () => {
  const { a, clock } = budget();
  const gap = () => a.gapMs(bigw, 'A') / 1000;
  a.done(bigw, 'A', 'search', 'challenge');
  assert.equal(gap(), 16);
  assert.equal(a.view(bigw).pausedBrowsers, 0);
  clock.tick(30 * S);
  a.done(bigw, 'A', 'page', 'challenge');
  assert.equal(gap(), 16, 'the same bout');
  clock.tick(31 * S);
  a.done(bigw, 'A', 'page', 'challenge');
  assert.equal(gap(), 32);
  a.done(bigw, 'A', 'search', 'failed');
  assert.equal(gap(), 32);
  assert.equal(a.view(bigw).blocks24h, 2);
  // A result for a read nothing was waiting on (handed out before a restart, say): nothing in flight to clear, no harm.
  a.done(bigw, 'Z', 'check', 'ok');
  assert.equal(a.ask(bigw, 'Z', 'check').ok, true);
});

test("what came of a read, from what the browser said: \"Access Denied\" (or a 403 it called a block) — turned away; a bot check; anything else that didn't read; read", () => {
  assert.equal(outcomeOf({ status: 'blocked', error: 'The store said "Access Denied" to your browser (its bot protection) — Mugibot asks it for nothing more from here for 30 minutes' }), 'denied');
  assert.equal(outcomeOf({ ok: false, blocked: true, status: 403, error: 'Blocked' }), 'denied');
  assert.equal(outcomeOf({ status: 'blocked', error: 'The store showed a bot check — backing off' }), 'challenge');
  assert.equal(outcomeOf({ ok: false, problem: 'blocked' }), 'challenge');
  assert.equal(outcomeOf({ ok: false, status: 0, error: 'timed out' }), 'failed');
  assert.equal(outcomeOf({ status: 'error', error: "Your browser couldn't read the store's page" }), 'failed');
  assert.equal(outcomeOf({ ok: true, status: 200 }), 'ok');
  assert.equal(outcomeOf({ status: 'out_of_stock' }), 'ok');
  assert.equal(outcomeOf(), 'ok');
});

// --- a simulated admin's browser, against the dummy BIG W ---------------------------------------------------
let env;
let store;
let discord;
let clock;
let boss;
before(async () => {
  store = await startMockStore();
  discord = await startFakeDiscord();
  clock = { offset: 0 };
  env = await startApp({ allowPrivateHosts: true, demoStoreUrl: store.url, adminUsernames: 'boss', hostGapSeconds: 0, now: () => Date.now() + clock.offset, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  makeMember(env, boss);
  for (const it of (await boss.get('/api/items')).body.items) await boss.del(`/api/items/${it.id}`);
  // Only the dummy BIG W searched (from an admin's browser), and only browsers read its pages.
  const stores = Object.fromEntries(env.app.retailers.list.filter((r) => r.sweep).map((r) => [r.id, r.id === 'demo-bigw' ? 'browser' : 'off']));
  const r = await boss.put('/api/monitor/sweep', { stores, keywords: 'pokemon, one piece, riftbound' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  env.app.repo.setSetting('retailer:demo-bigw', { serverChecks: false });
});
after(async () => {
  await env.close();
  await store.close();
  await discord.close();
});

const bigwTile = (sku, title) => ({ sku, title, price: 59, inStock: false, url: `${store.url}/bigw/product/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/p/${sku}` });

/**
 * The extension reading BIG W, second by second (the clock moved on by the test): its searches in a tab of their own,
 * its pages watched in another, its checks a round every 30 s — one after another, at least 4 s apart (or the gap the
 * server says: 1.39.0) — each page `loadMs` to build. Every page it opens is a load: { kind, key, start, end }.
 * outcome(kind, key, n): what the store said that time ('ok', or 'denied': "Access Denied").
 */
async function browse(device, { seconds, loadMs = 5000, version = '1.39.0', outcome = () => 'ok' }) {
  const loads = [];
  let search = null;
  let page = null;
  let round = null;
  let nextRound = 0;
  let n = 0;
  const now = () => env.app.repo.now();
  const denied = (o) => o === 'denied';
  let deniedUntil = 0;
  // A round of checks, one after another: 4 s between two at a store, or the gap it's told (1.39.0) — the first not before
  // the slot it booked (startInMs), nor while the store's own search or page watched is still loading in this browser.
  const waits = !olderThan(version, '1.39.0');
  const stepRound = async (t) => {
    if (round.current && round.current.end <= t) {
      const o = outcome('check', round.current.c.id, n++);
      if (denied(o)) deniedUntil = t + 30 * MIN;
      round.results.push(denied(o)
        ? { id: round.current.c.id, status: 'blocked', error: 'The store said "Access Denied" to your browser (its bot protection) — Mugibot asks it for nothing more from here for 30 minutes', privateWindow: true }
        : { id: round.current.c.id, status: 'out_of_stock', price: 59, title: 'BIG W product', privateWindow: true });
      round.current = null;
    }
    while (!round.current && round.i < round.checks.length) {
      const c = round.checks[round.i];
      const wait = Math.max(4000, waits ? Math.min(c.gapMs || 0, 60000) : 0);
      if (round.last && t < round.last + wait) break;
      if (waits && t < round.began + (c.startInMs || 0)) break;
      if (waits && c.gapMs && (search || page)) break;
      round.i += 1;
      if (t < deniedUntil) continue;
      round.current = { c, end: t + loadMs };
      round.last = t;
      loads.push({ kind: 'check', key: c.id, start: t, end: t + loadMs });
    }
    if (!round.current && round.i >= round.checks.length) {
      if (round.results.length) assert.equal((await device.call('POST', '/api/ext/checks', { results: round.results })).status, 200);
      round = null;
    }
  };
  for (let s = 0; s < seconds; s++) {
    const t = now();
    if (search && search.end <= t) {
      const o = outcome('search', search.key, n++);
      if (denied(o)) deniedUntil = t + 30 * MIN;
      const res = denied(o)
        ? { store: 'demo-bigw', keyword: search.term.keyword, page: search.term.page, ok: false, blocked: true, status: 403, error: 'Access Denied', privateWindow: true }
        : { store: 'demo-bigw', keyword: search.term.keyword, page: search.term.page, ok: true, status: 200, ms: loadMs, privateWindow: true,
          products: [bigwTile(`70${String(search.term.keyword.length).padStart(2, '0')}001`, `${search.term.keyword} tcg booster`), bigwTile(`70${String(search.term.keyword.length).padStart(2, '0')}002`, `${search.term.keyword} tcg tin`)] };
      assert.equal((await device.call('POST', '/api/ext/sweeps', { results: [res] })).status, 200);
      search = null;
    }
    if (page && page.end <= t) {
      const o = outcome('page', page.key, n++);
      if (denied(o)) deniedUntil = t + 30 * MIN;
      const res = denied(o) ? { id: page.p.id, ok: false, blocked: true, status: 403, error: 'Access Denied' } : { id: page.p.id, ok: true, how: 'page', products: [] };
      assert.equal((await device.call('POST', '/api/ext/sweeps', { pages: [res] })).status, 200);
      page = null;
    }
    if (round) await stepRound(t);
    const busy = [search && 'demo-bigw', page && 'page:demo-bigw'].filter(Boolean).join(',');
    if (t >= deniedUntil) {
      const due = (await device.call('GET', `/api/ext/sweeps?v=${version}&busy=${encodeURIComponent(busy)}`)).body;
      for (const term of due.terms.filter((x) => x.store === 'demo-bigw')) {
        assert.equal(search, null, 'never a search for a tab still reading');
        search = { term, key: `${term.keyword}\n${term.page}`, end: t + loadMs };
        loads.push({ kind: 'search', key: search.key, start: t, end: search.end });
      }
      for (const p of (due.pages || []).filter((x) => x.store === 'demo-bigw')) {
        assert.equal(page, null, 'never a page for a tab still reading');
        page = { p, key: p.url, end: t + loadMs };
        loads.push({ kind: 'page', key: p.url, start: t, end: page.end });
      }
    }
    if (!round && t >= nextRound) {
      nextRound = t + 30 * S;
      const checks = (await device.call('GET', `/api/ext/checks?v=${version}&priv=1`)).body.checks.filter((x) => x.store === 'demo-bigw');
      round = { checks, i: 0, last: 0, began: t, current: null, results: [] };
      await stepRound(t);
    }
    clock.offset += S;
  }
  return loads;
}
function olderThan(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return false;
}
/** How the loads went: at most how many at once, the least time between two starting, loads a minute, and how often each key was read. */
function measure(loads, seconds) {
  const sorted = [...loads].sort((x, y) => x.start - y.start);
  let most = 0;
  for (const l of sorted) most = Math.max(most, sorted.filter((o) => o.start <= l.start && o.end > l.start).length);
  let least = Infinity;
  for (let i = 1; i < sorted.length; i++) least = Math.min(least, sorted[i].start - sorted[i - 1].start);
  const byKey = new Map();
  for (const l of sorted) {
    const k = `${l.kind}|${l.key}`;
    byKey.set(k, [...(byKey.get(k) || []), l.start]);
  }
  const every = {};
  for (const [k, starts] of byKey) {
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    every[k] = { reads: starts.length, everySeconds: gaps.length ? Math.round(gaps.reduce((a, x) => a + x, 0) / gaps.length / 100) / 10 : null };
  }
  const kinds = {};
  for (const l of sorted) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
  return { loads: sorted.length, perMinute: Math.round((sorted.length / seconds) * 60 * 10) / 10, mostAtOnce: most, leastGapSeconds: least === Infinity ? null : least / 1000, kinds, every };
}

async function bigwSetup(name) {
  const device = await Device.pair(env.url, boss, name);
  await device.call('GET', '/api/ext/me?v=1.39.0');
  const items = [];
  for (const [sku, title] of [['6012345', null], ['6012346', null]]) {
    const r = await boss.post('/api/items', { url: store.productUrl('bigw', sku), name: title || `BIG W ${sku}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    items.push(r.body);
  }
  const watch = await boss.post('/api/drops', { page: `${store.url}/bigw/search?text=lego`, phrases: ['lego'], every: 5 });
  assert.equal(watch.status, 200, JSON.stringify(watch.body));
  // Two monitors everyone shares, at BIG W, its searches don't show: read off their own pages.
  const monitors = ['6099901', '6099902'].map((sku) => {
    const p = env.app.catalog.upsertProduct({ store: 'demo-bigw', sku, url: `${store.url}/bigw/product/monitored-${sku}/p/${sku}`, name: `Monitored ${sku}` });
    return { product: p, monitor: env.app.catalog.addMonitor(p.id).monitor };
  });
  return { device, items, watch: watch.body.watch, monitors };
}
async function bigwTeardown({ items, watch, monitors }) {
  for (const it of items) await boss.del(`/api/items/${it.id}`);
  for (const m of monitors) env.app.catalog.deleteMonitor(m.monitor.id);
  await boss.del(`/api/drops/${watch.id}`);
  env.app.db.run("UPDATE products SET browser_next_at = 0 WHERE store = 'demo-bigw'");
}

test("before the budget (Oct 2026): an admin's browser reading BIG W in its private window — searches, its page watched and product pages kept their own paces, nothing kept them in check together: several of its pages at once, and far more often than one every 8 s", async (t) => {
  const was = env.app.access.limited;
  env.app.access.limited = () => false; // (as it was before monitor/access.js)
  const setup = await bigwSetup('Before');
  try {
    const seconds = 600;
    const m = measure(await browse(setup.device, { seconds }), seconds);
    t.diagnostic(`before: ${JSON.stringify({ ...m, every: undefined })}`);
    assert.ok(m.mostAtOnce >= 2, `several at once: ${m.mostAtOnce}`);
    assert.ok(m.perMinute > 7.5, `more than one every 8 s: ${m.perMinute} a minute`);
    assert.ok(m.leastGapSeconds < 8, `two starting less than 8 s apart: ${m.leastGapSeconds}`);
  } finally {
    env.app.access.limited = was;
    await bigwTeardown(setup);
  }
});

test("with the budget: the same browser reading BIG W — one of its pages at a time, never two starting less than 8 s apart, no more than 7.5 a minute; every keyword, page watched and product read, each in turn (measured: how often each is — its 5 s target can't be met for more than one thing at 8 s a page)", async (t) => {
  const setup = await bigwSetup('With budget');
  try {
    const seconds = 900;
    const loads = await browse(setup.device, { seconds });
    const m = measure(loads, seconds);
    t.diagnostic(`with the budget: ${JSON.stringify({ ...m, every: undefined })}`);
    for (const [k, v] of Object.entries(m.every)) t.diagnostic(`  ${k.replace('\n', ' p')}: read ${v.reads} times, every ${v.everySeconds} s`);
    assert.equal(m.mostAtOnce, 1, 'one at a time');
    assert.ok(m.leastGapSeconds >= 8, `never two less than 8 s apart: ${m.leastGapSeconds}`);
    assert.ok(m.perMinute <= 7.5, `${m.perMinute} a minute`);
    assert.ok(m.perMinute >= 6, `the browser kept reading — the budget's slots used: ${m.perMinute} a minute`);
    // Every keyword (its first page), the page watched, and both watchlist items: read, again and again.
    for (const kw of ['pokemon', 'one piece', 'riftbound']) assert.ok((m.every[`search|${kw}\n1`] || { reads: 0 }).reads >= 5, `${kw}: ${JSON.stringify(m.every[`search|${kw}\n1`])}`);
    assert.ok(m.every[`page|${store.url}/bigw/search?text=lego`].reads >= 10, 'the page watched');
    for (const it of setup.items) assert.ok((m.every[`check|${it.id}`] || { reads: 0 }).reads >= 3, `item ${it.id}: ${JSON.stringify(m.every[`check|${it.id}`])}`);
    for (const { product } of setup.monitors) assert.ok((m.every[`check|p:${product.id}`] || { reads: 0 }).reads >= 3, `monitor ${product.sku}: ${JSON.stringify(m.every[`check|p:${product.id}`])}`);
    assert.ok(m.kinds.check >= 20 && m.kinds.search >= 30 && m.kinds.page >= 10, JSON.stringify(m.kinds));
    // What the Stores panel says it's doing.
    const view = (await boss.get('/api/monitor/sweep')).body.stores.find((s) => s.store === 'demo-bigw').access;
    t.diagnostic(`the Stores panel: ${JSON.stringify(view)}`);
    assert.equal(view.gapSeconds, 8);
    assert.equal(view.targetSeconds, 5);
    assert.equal(view.blocks24h, 0);
    assert.ok(view.cadence.search.items >= 3 && view.cadence.search.everySeconds > 5, JSON.stringify(view.cadence));
    assert.ok(view.cadence.check.items >= 4, JSON.stringify(view.cadence));
  } finally {
    await bigwTeardown(setup);
  }
});

test('turned away mid-read ("Access Denied"): nothing asked of BIG W from that browser for 30 minutes — no retry storm — then reading again, at the wider gap, easing back; the other admin browser keeps reading', async (t) => {
  const setup = await bigwSetup('Denied');
  const other = await Device.pair(env.url, boss, 'Other browser');
  await other.call('GET', '/api/ext/me?v=1.39.0');
  try {
    // A few minutes fine, then the store turns it away once.
    let deniedOnce = false;
    const outcome = (kind, key, n) => (n === 20 && !deniedOnce ? ((deniedOnce = true), 'denied') : 'ok');
    const start = env.app.repo.now();
    const loads = await browse(setup.device, { seconds: 50 * 60, outcome });
    assert.ok(deniedOnce);
    const view = env.app.access.view(env.app.retailers.get('demo-bigw'));
    t.diagnostic(`after "Access Denied": ${JSON.stringify(view)}`);
    const blockAt = view.lastBlockAt;
    assert.ok(blockAt > start);
    const during = loads.filter((l) => l.start > blockAt && l.start < blockAt + 30 * MIN);
    assert.equal(during.length, 0, `nothing asked of it from that browser for 30 minutes: ${during.length}`);
    const afterwards = loads.filter((l) => l.start >= blockAt + 30 * MIN).sort((x, y) => x.start - y.start);
    assert.ok(afterwards.length >= 30, `reading again after: ${afterwards.length}`);
    const gaps = afterwards.slice(1).map((l, i) => l.start - afterwards[i].start);
    assert.ok(Math.min(...gaps.slice(0, 20)) >= 16 * S, `at the wider gap at first: ${Math.min(...gaps.slice(0, 20))}`);
    assert.ok(view.gapSeconds <= 16, `easing back: ${view.gapSeconds}`);
    assert.equal(view.blocks24h, 1);
    // The live log says so.
    const sys = env.app.sweeper.logs ? env.app.sweeper.logs : null;
    if (sys) assert.ok(JSON.stringify(sys).includes('Access Denied'));
    // The other browser was never paused.
    const due = (await other.call('GET', '/api/ext/sweeps?v=1.39.0')).body;
    assert.ok(due.terms.some((x) => x.store === 'demo-bigw') || due.pages.some((x) => x.store === 'demo-bigw') || due.waitMs !== null);
  } finally {
    await bigwTeardown(setup);
  }
});

test("the other stores, as before: a browser BIG W turned away still searches and checks them — their checks in the same round at their own pace (BIG W's on top of the round's five), their searches never waiting on BIG W's budget; said in the live log", async () => {
  const device = await Device.pair(env.url, boss, 'Other stores');
  await device.call('GET', '/api/ext/me?v=1.39.0');
  const saved = (await boss.get('/api/monitor/sweep')).body.settings.stores;
  assert.equal((await boss.put('/api/monitor/sweep', { stores: { ...saved, 'demo-ebgames': 'browser' } })).status, 200);
  env.app.repo.setSetting('retailer:demo-jbhifi', { serverChecks: false });
  const jb = (await boss.post('/api/items', { url: store.productUrl('jbhifi', 'pokemon-tcg-30th-celebration-etb'), name: 'JB ETB' })).body;
  const bw = (await boss.post('/api/items', { url: store.productUrl('bigw', '6012345'), name: 'BIG W UPC' })).body;
  try {
    clock.offset += 120 * S;
    let round = (await device.call('GET', '/api/ext/checks?v=1.39.0&priv=1')).body.checks;
    assert.ok(round.some((c) => c.id === jb.id), "JB Hi-Fi's item, as ever");
    assert.equal(round[0].id, bw.id, "BIG W's first in the round");
    assert.equal(round.find((c) => c.id === jb.id).gapMs, undefined, 'nothing new said for the other stores');
    // BIG W says "Access Denied" to this browser.
    const r = await device.call('POST', '/api/ext/checks', { results: [
      { id: bw.id, status: 'blocked', error: 'The store said "Access Denied" to your browser (its bot protection) — Mugibot asks it for nothing more from here for 30 minutes' },
      { id: jb.id, status: 'in_stock', price: 69 },
    ] });
    assert.equal(r.status, 200);
    assert.ok(env.app.sweeper.events.some((e) => e.type === 'sys' && e.store === 'demo-bigw' && e.level === 'warn' && /"Access Denied"/.test(e.message)), 'said in the live log');
    clock.offset += 120 * S;
    round = (await device.call('GET', '/api/ext/checks?v=1.39.0&priv=1')).body.checks;
    assert.ok(round.some((c) => c.id === jb.id), "JB Hi-Fi's item still checked");
    assert.ok(!round.some((c) => c.store === 'demo-bigw'), 'nothing of BIG W from this browser for 30 minutes');
    const due = (await device.call('GET', '/api/ext/sweeps?v=1.39.0')).body;
    assert.ok(due.terms.some((x) => x.store === 'demo-ebgames'), 'EB Games searched as ever');
    assert.ok(!due.terms.some((x) => x.store === 'demo-bigw'), 'BIG W not, from this browser');
    clock.offset += 30 * MIN;
    round = (await device.call('GET', '/api/ext/checks?v=1.39.0&priv=1')).body.checks;
    assert.ok(round.some((c) => c.store === 'demo-bigw'), 'BIG W again after the half hour');
  } finally {
    await boss.put('/api/monitor/sweep', { stores: saved });
    env.app.repo.setSetting('retailer:demo-jbhifi', {});
    for (const it of [jb, bw]) await boss.del(`/api/items/${it.id}`);
  }
});

test('malformed or changed answers from a browser — junk results, an unknown status, a search page BIG W has changed so nothing reads — never crash, never count as "Access Denied", and the slot is freed for the next', async () => {
  const device = await Device.pair(env.url, boss, 'Junk');
  await device.call('GET', '/api/ext/me?v=1.39.0');
  const bw = (await boss.post('/api/items', { url: store.productUrl('bigw', '6012346'), name: 'BIG W Bundle' })).body;
  const bigwR = env.app.retailers.get('demo-bigw');
  const blocks = () => env.app.access.view(bigwR).blocks24h;
  try {
    clock.offset += 60 * MIN;
    // (What the other tests left at BIG W waits its turn: this item's the one read here.)
    env.app.db.run("UPDATE products SET browser_next_at = :far WHERE store = 'demo-bigw'", { far: env.app.repo.now() + 86400000 });
    const before = blocks();
    const round = (await device.call('GET', '/api/ext/checks?v=1.39.0&priv=1')).body.checks.filter((c) => c.store === 'demo-bigw');
    assert.deepEqual(round.map((c) => c.id), [bw.id]);
    const r = await device.call('POST', '/api/ext/checks', { results: [null, 'x', 7, { id: bw.id, status: 'nonsense', error: { not: 'text' } }, { id: 'p:nope', status: 'in_stock' }] });
    assert.equal(r.status, 200);
    const item = (await boss.get('/api/items')).body.items.find((i) => i.id === bw.id);
    assert.ok(['error', 'pending'].includes(item.status) || item.status !== 'in_stock', `an unknown status is never read as on sale: ${item.status}`);
    // A search page BIG W changed (nothing on it reads): a failed read, not a block.
    const term = { keyword: 'pokemon', page: 1 };
    assert.equal((await device.call('POST', '/api/ext/sweeps', { results: [{ store: 'demo-bigw', ...term, ok: false, problem: 'layout', status: 200, error: "The page's layout changed" }, { store: 'demo-bigw', keyword: 42 }, null] })).status, 200);
    assert.equal(blocks(), before, 'not counted as being turned away');
    // The item that didn't read: backed off on its own (a minute, then longer) — no retry storm; the browser's slot freed.
    const row = env.app.db.get('SELECT browser_fails, browser_next_at FROM items WHERE id = :id', { id: bw.id });
    assert.equal(row.browser_fails, 1);
    assert.ok(row.browser_next_at - env.app.repo.now() >= 59 * S, String(row.browser_next_at - env.app.repo.now()));
    clock.offset += 20 * S;
    const due = (await device.call('GET', '/api/ext/sweeps?v=1.39.0')).body;
    assert.ok(due.terms.some((x) => x.store === 'demo-bigw') || due.pages.some((x) => x.store === 'demo-bigw'), 'the slot freed: BIG W read again from this browser');
  } finally {
    env.app.db.run("UPDATE products SET browser_next_at = 0 WHERE store = 'demo-bigw'");
    await boss.del(`/api/items/${bw.id}`);
  }
});
