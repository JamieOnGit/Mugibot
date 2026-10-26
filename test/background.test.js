// Several checkouts at once: one of them is always in a tab in the background, and Chrome runs a
// background tab's timers at most about once a second — a checkout there, whose every step waits
// a moment and looks again, would crawl. Its waits (MGBFlows.wait in extension/flows.js) are timed
// by the extension's worker instead, which runs at full speed.
//
// Chromium is started on its own here, with the real extension and two store pages in two tabs
// (the second in front): a browser driven by Playwright treats every tab as if it were in front,
// so it would never show the slowdown. Each page measures ten short waits both ways and sends back
// how long they took.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { writeExtension } from '../server/extension.js';

// Runs in each store page, after the extension's own scripts (the same isolated world).
const PROBE = `(async () => {
  if (!/[?&]probe=/.test(location.search)) return;
  const timer = (ms) => new Promise((r) => setTimeout(r, ms));
  // (Both tabs open first: the second comes to the front a moment after the first.)
  const t = Date.now();
  while (Date.now() - t < 2500) await MGBFlows.wait(100);
  const ten = async (wait) => { const t0 = performance.now(); for (let i = 0; i < 10; i++) await wait(100); return Math.round(performance.now() - t0); };
  const res = { tab: location.search, hidden: document.hidden, timer: await ten(timer), wait: await ten(MGBFlows.wait), stillHidden: document.hidden };
  await fetch('/result', { method: 'POST', body: JSON.stringify(res) });
})();`;

let srv;
let port;
let proc;
let browser;
const dirs = [];
const results = [];
const seen = [];

before(async () => {
  srv = http.createServer((req, res) => {
    if (req.url === '/result') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { results.push(JSON.parse(b)); res.end('ok'); });
      return;
    }
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    // (The pages the browser opens with first go on to the store page in a moment: the extension is loaded by then.)
    const go = req.url.match(/^\/start\?(\w+)$/);
    if (go) return res.end(`<!doctype html><title>Opening</title><script>setTimeout(() => location.replace('/?probe=${go[1]}'), ${go[1] === 'front' ? 1600 : 1000});</script>`);
    res.end('<!doctype html><title>A store page</title><h1>A store page</h1>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
  // The extension, built for a Mugibot server on this computer (nothing answers there: not connected),
  // so its store-page scripts run on pages here — with the probe after them.
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-bg-ext-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-bg-prof-'));
  dirs.push(ext, profile);
  writeExtension({ baseUrl: 'http://127.0.0.1:9', extraOrigins: [], appName: 'Mugibot', demoStoreUrl: '' }, ext);
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.content_scripts.push({ matches: ['http://127.0.0.1/*'], js: ['probe.js'], run_at: 'document_idle' });
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(ext, 'probe.js'), PROBE);
  // (The two tabs opened through the browser itself — not through either page, so neither is
  // driven or watched: each runs as it would for you.)
  proc = spawn(chromium.executablePath(), [
    '--headless=new', `--user-data-dir=${profile}`, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--no-proxy-server', '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = await new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`Chromium didn't start: ${err}`)), 20000);
    proc.stderr.on('data', (d) => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  browser = new WebSocket(ws);
  await new Promise((r) => browser.addEventListener('open', r, { once: true }));
  let id = 0;
  const send = (method, params) => browser.send(JSON.stringify({ id: ++id, method, params }));
  const page = (tab) => `http://127.0.0.1:${port}/start?${tab}`;
  send('Target.createTarget', { url: page('behind') });
  await new Promise((r) => setTimeout(r, 300));
  send('Target.createTarget', { url: page('front') });
});

after(async () => {
  try { browser?.close(); } catch { /* gone */ }
  // (Chromium writes to its profile as it closes: its folders go once it has. Still going after 10 seconds — a slow
  //  machine — it's stopped outright.)
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
  }
  srv?.close();
  // (Temporary folders: removed — and one a last Chromium helper is still writing to as it goes (ENOTEMPTY, seen on
  //  slow CI machines) is left for the system to clear: tidying up isn't what this file tests.)
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (e) {
      console.log(`# left ${d} for the system to clear (${e.code})`);
    }
  }
});

test("a checkout in a tab in the background waits at full speed: its waits are timed by the extension, not the page's slowed timers", async () => {
  const until = Date.now() + 40000;
  while (results.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  assert.equal(results.length, 2, `both tabs measured: ${JSON.stringify(results)} (pages asked for: ${seen.join(' ')})`);
  const behind = results.find((r) => r.tab.includes('behind'));
  const front = results.find((r) => r.tab.includes('front'));
  assert.ok(behind && front, JSON.stringify(results));
  assert.equal(front.hidden, false, 'the second tab is in front');
  assert.equal(behind.hidden, true, 'the first is behind it');
  assert.equal(behind.stillHidden, true);
  // Ten waits of 100 ms: about a second, in front or behind.
  assert.ok(front.wait < 2000, `in front: ${front.wait} ms`);
  assert.ok(behind.wait < 2000, `in the background: ${behind.wait} ms (the page's own timers: ${behind.timer} ms)`);
  // (And Chrome did slow the background tab's own timers — what the extension's waits get round.)
  assert.ok(behind.timer > 4000, `the background tab's own timers were slowed: ${behind.timer} ms for ten 100 ms waits`);
  assert.ok(behind.wait * 2 < behind.timer, `the extension's waits: ${behind.wait} ms vs the page's ${behind.timer} ms`);
});
