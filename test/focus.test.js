// Card boxes in payment frames (extension/fill.js): a frame asks the page above to focus it, one box
// at a time, because those boxes only keep real typing into a focused box. A frame's script can
// start before the page above is listening (Premium Bandai's Global-e checkout frame asked its
// store page 6–11 ms too early, and then waited out the 1.5 s "nobody above" fallback before
// typing the card): it asks again until it's answered, and the page above takes each ask once.
// In Chromium, with fill.js as the extension loads it — no store, no extension needed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const FILL = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'fill.js'), 'utf8');
let srv;
let base;
let browser;

before(async () => {
  srv = http.createServer((req, res) => {
    const page = (body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><meta charset="utf-8">${body}`); };
    if (req.url === '/fill.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(FILL); }
    // The store page, with its checkout's frame; and that frame, with the card's frame inside it.
    if (req.url === '/') return page('<script src="/fill.js"></script><iframe id="checkout" src="/checkout"></iframe>');
    if (req.url === '/checkout') return page('<script src="/fill.js"></script><iframe id="card" src="/card"></iframe>');
    if (req.url === '/card') return page('<script src="/fill.js"></script><input id="number">');
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
});
after(async () => {
  await browser.close();
  srv.close();
});

/** Ask for the focus from a frame; resolves to how long it took, and whether the page above answered ("go"). */
const askFrom = (frame) => frame.evaluate(() => {
  window.__gos = 0;
  window.addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data.startsWith('mugibot-focus:go:')) window.__gos += 1; });
  const t0 = performance.now();
  window.__asked = MGBFill.requestFocus().then((release) => { window.__ms = performance.now() - t0; setTimeout(release, 50); return window.__ms; });
  return true;
});

test('a page above that starts listening late still answers at once: the frame asks again, and is focused once', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  const checkout = page.frames().find((f) => f.url().endsWith('/checkout'));
  // The checkout frame asks the store page for the focus — before the store page is listening.
  await askFrom(checkout);
  await page.waitForTimeout(300);
  await page.evaluate(() => { MGBFill.startFocusBroker(); return true; });
  const ms = await checkout.evaluate(() => window.__asked);
  assert.ok(ms < 600, `focused ${Math.round(ms)} ms after asking — the page above started listening at 300 ms (not the 1.5 s fallback)`);
  await page.waitForTimeout(300);
  assert.equal(await checkout.evaluate(() => window.__gos), 1, 'focused once, however many times it asked');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'checkout', 'the store page focused the frame');
  await page.close();
});

test('a card frame two frames down: its frame asks the store page in turn, and both are answered without waiting out the fallback', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  const checkout = page.frames().find((f) => f.url().endsWith('/checkout'));
  const card = page.frames().find((f) => f.url().endsWith('/card'));
  // The checkout frame listens for its card frame; the store page starts listening late.
  await checkout.evaluate(() => { MGBFill.startFocusBroker(); return true; });
  await askFrom(card);
  await page.waitForTimeout(250);
  await page.evaluate(() => { MGBFill.startFocusBroker(); return true; });
  const ms = await card.evaluate(() => window.__asked);
  assert.ok(ms < 600, `the card frame focused ${Math.round(ms)} ms after asking`);
  assert.equal(await card.evaluate(() => window.__gos), 1);
  await page.close();
});

test('nobody above listening at all: the frame still types after the fallback (1.5 s), as before', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  const checkout = page.frames().find((f) => f.url().endsWith('/checkout'));
  await askFrom(checkout);
  const ms = await checkout.evaluate(() => window.__asked);
  assert.ok(ms >= 1400 && ms < 2500, `${Math.round(ms)} ms`);
  assert.equal(await checkout.evaluate(() => window.__gos), 0);
  await page.close();
});

test('queued behind another frame: each frame is focused in turn, once each', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  await page.evaluate(() => {
    MGBFill.startFocusBroker();
    const f = document.createElement('iframe');
    f.id = 'second';
    f.src = '/card';
    document.body.append(f);
    return new Promise((r) => { f.onload = r; });
  });
  const first = page.frames().find((f) => f.url().endsWith('/checkout'));
  const second = page.frames().find((f) => f.url().endsWith('/card') && f.parentFrame() === page.mainFrame());
  await askFrom(first);
  await askFrom(second);
  const [a, b] = await Promise.all([first.evaluate(() => window.__asked), second.evaluate(() => window.__asked)]);
  assert.ok(a < 300, `first: ${Math.round(a)} ms`);
  assert.ok(b >= a && b < 900, `second, after the first was done: ${Math.round(b)} ms`);
  await page.waitForTimeout(200);
  assert.deepEqual([await first.evaluate(() => window.__gos), await second.evaluate(() => window.__gos)], [1, 1]);
  await page.close();
});
