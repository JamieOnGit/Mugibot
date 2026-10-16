// Building blocks: passwords, encryption, signed links, codes, retailers and
// their flows, input checks, Whop and Discord signatures, the zip writer and
// the extension builder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { decryptJSON, encryptJSON, hashPassword, humanCode, newUserKey, normalizeHumanCode, purposeKey, signParts, unwrapUserKey, verifyParts, verifyPassword } from '../server/crypto.js';
import { extensionFiles, extensionManifest, writeExtension } from '../server/extension.js';
import { RateLimiter, parseCookies } from '../server/http.js';
import { RETAILER_DEFS, Retailers, serialize } from '../server/retailers/index.js';
import { alerts, item, profile, profiles, username } from '../server/schema.js';
import { makeZip } from '../server/zip.js';
import { loadConfig } from '../server/config.js';
import { entitlement } from '../server/entitlement.js';
import { Whop, signWebhook } from '../server/whop.js';
import { verifyDiscordSignature } from '../server/routes/discord.js';
import { interactionKeys } from './helpers.js';

const retailers = new Retailers({ demoStoreUrl: '' });

test('passwords: scrypt hashes, salted, verified', async () => {
  const h1 = await hashPassword('hunter2 hunter2');
  const h2 = await hashPassword('hunter2 hunter2');
  assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(h1, h2, 'random salt');
  assert.equal(await verifyPassword('hunter2 hunter2', h1), true);
  assert.equal(await verifyPassword('hunter2 hunter3', h1), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('per-user keys: wrapped by the server key, bound to the user', () => {
  const master = crypto.randomBytes(32);
  const wrapped = newUserKey(master, 'usr_a');
  const key = unwrapUserKey(master, wrapped, 'usr_a');
  assert.equal(key.length, 32);
  assert.throws(() => unwrapUserKey(master, wrapped, 'usr_b'), 'another user id');
  assert.throws(() => unwrapUserKey(crypto.randomBytes(32), wrapped, 'usr_a'), 'another server key');
  const sealed = encryptJSON(key, { address1: '1 Pallet Rd' }, 'usr_a:profiles');
  assert.doesNotMatch(sealed, /Pallet/);
  assert.deepEqual(decryptJSON(key, sealed, 'usr_a:profiles'), { address1: '1 Pallet Rd' });
  assert.throws(() => decryptJSON(key, sealed, 'usr_a:alerts'), 'another field');
});

test('signed ⚡ Buy links: bound to the user, item and quantity, and expire', () => {
  const key = purposeKey(crypto.randomBytes(32), 'buy-link');
  const t = signParts(key, ['usr_a', 'itm_1', '2'], Date.now() + 60000);
  assert.equal(verifyParts(key, ['usr_a', 'itm_1', '2'], t), true);
  assert.equal(verifyParts(key, ['usr_b', 'itm_1', '2'], t), false, 'another user');
  assert.equal(verifyParts(key, ['usr_a', 'itm_1', '3'], t), false, 'another quantity');
  assert.equal(verifyParts(key, ['usr_a', 'itm_1', '2'], t, Date.now() + 120000), false, 'expired');
  assert.equal(verifyParts(purposeKey(crypto.randomBytes(32), 'buy-link'), ['usr_a', 'itm_1', '2'], t), false, 'another server');
  assert.equal(verifyParts(key, ['usr_a', 'itm_1', '2'], 'garbage'), false);
});

test('connection codes are easy to type', () => {
  for (let i = 0; i < 50; i++) assert.match(humanCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normalizeHumanCode(' abcd 2345 '), 'ABCD-2345');
});

test('retailers: each store has its own flow; product codes from links; demo copies on the dummy store', () => {
  assert.deepEqual(RETAILER_DEFS.map((r) => r.id), ['kmart', 'bigw', 'target', 'ebgames', 'zing', 'jbhifi', 'toysrus', 'trainertown', 'amazon']);
  for (const r of RETAILER_DEFS) {
    assert.ok(r.flow && r.flow.product && r.flow.checkout, `${r.id} has a flow`);
    assert.ok(r.flow.checkout.final.length, `${r.id} names its final button`);
    assert.ok(['verified', 'beta', 'draft'].includes(r.flowStatus), r.id);
  }
  assert.equal(retailers.get('kmart').flowStatus, 'verified');
  const sku = (u) => retailers.skuFromUrl(u);
  assert.equal(sku('https://www.kmart.com.au/product/pokemon-tcg%3A-30th-celebration-ultra-premium-collection-day-43818648/'), '43818648');
  assert.equal(sku('https://www.ebgames.com.au/product/toys-and-collectibles/312345-one-piece-op18'), '312345');
  assert.equal(sku('https://www.jbhifi.com.au/products/pokemon-tcg-etb'), 'pokemon-tcg-etb');
  assert.equal(sku('https://www.target.com.au/p/pokemon-tcg-booster/71234567'), '71234567');
  assert.equal(sku('https://www.bigw.com.au/product/pokemon-tcg/p/6012345'), '6012345');
  assert.equal(sku('https://www.amazon.com.au/dp/B0ABCDEF12'), 'B0ABCDEF12');
  assert.equal(sku('https://shop.example.com/item/9876543'), '9876543');
  assert.equal(retailers.forUrl('https://m.kmart.com.au/product/x-43818648/').id, 'kmart', 'sub-domains');
  assert.equal(retailers.forUrl('https://www.cardshop.example/x'), null);
  assert.equal(retailers.searchUrl(retailers.get('bigw'), '6012345'), 'https://www.bigw.com.au/search?text=6012345');
  assert.equal(retailers.productUrlFromSku(retailers.get('amazon'), 'B0ABCDEF12'), 'https://www.amazon.com.au/dp/B0ABCDEF12');

  const demo = new Retailers({ demoStoreUrl: 'http://localhost:5055' });
  const dk = demo.forUrl('http://127.0.0.1:5055/kmart/product/x-43818648/');
  assert.equal(dk.id, 'demo-kmart');
  assert.equal(dk.flow, retailers.get('kmart').flow, 'the same flow as the real store');
  assert.equal(demo.forUrl('http://localhost:5055/bigw/product/x/p/1').id, 'demo-bigw');
  assert.equal(demo.forUrl('http://localhost:5055/'), null, 'the control panel is no store');
  assert.equal(demo.forUrl('https://www.kmart.com.au/product/x-43818648/').id, 'kmart');

  // Flows travel as JSON: regular expressions become { re, f } and survive the trip.
  const ext = JSON.parse(JSON.stringify(retailers.forExtension()));
  const k = ext.find((r) => r.id === 'kmart');
  assert.deepEqual(k.flow.checkout.final[0], { re: '\\bcheck ?out securely\\b', f: 'i' });
  assert.ok(new RegExp(k.flow.checkout.final[0].re, k.flow.checkout.final[0].f).test('Checkout securely'));
  assert.deepEqual(serialize({ a: [/x/g], b: 1, c: undefined }), { a: [{ re: 'x', f: 'g' }], b: 1 });
  // An admin switch hides a store.
  const off = new Retailers({ demoStoreUrl: '' }, (k2) => (k2 === 'retailer:target' ? { enabled: false } : null));
  assert.ok(!off.forExtension().some((r) => r.id === 'target'));
  assert.ok(!off.publicList().some((r) => r.id === 'target'));
});

test('input checks: usernames, SKUs by link or by store, delivery details, alerts', () => {
  assert.equal(username('  Ash.K_99 '), 'ash.k_99');
  for (const bad of ['a', 'with space', '.dot', 'admin', 'x'.repeat(30)]) assert.throws(() => username(bad), bad);
  const byLink = item({ url: 'https://www.kmart.com.au/product/x-43000001/#frag', quantity: 99, price: '12.5' }, { retailers });
  assert.deepEqual([byLink.store, byLink.sku, byLink.quantity, byLink.price, byLink.url], ['kmart', '43000001', 10, 12.5, 'https://www.kmart.com.au/product/x-43000001/']);
  const bySku = item({ store: 'bigw', sku: '6012345' }, { retailers });
  assert.deepEqual([bySku.store, bySku.sku, bySku.url], ['bigw', '6012345', ''], 'found by the monitor later');
  assert.equal(item({ store: 'jbhifi', sku: 'pokemon-etb' }, { retailers }).url, 'https://www.jbhifi.com.au/products/pokemon-etb', 'Shopify link from the handle');
  assert.throws(() => item({ store: 'bigw' }, { retailers }), /product code/i);
  assert.throws(() => item({ url: 'javascript:alert(1)', sku: '1' }, { retailers }));
  assert.throws(() => item({ url: 'https://user:pw@example.com/p/1' }, { retailers }));
  assert.equal(item({ url: 'https://shop.example.com/products/op-18-box' }, { retailers }).store, 'other');
  assert.equal(item({ url: 'https://www.kmart.com.au/product/x-1234567/', announce: true }, { retailers }).announce, false, 'members can\'t announce');
  assert.equal(item({ url: 'https://www.kmart.com.au/product/x-1234567/', announce: true }, { retailers, isAdmin: true }).announce, true);
  assert.equal(profile({ state: 'new south wales', postcode: '2000' }).state, 'NSW');
  assert.throws(() => profile({ postcode: '20000' }));
  assert.throws(() => profile({ state: 'XX' }));
  const set = profiles({ profiles: [{ label: 'Home' }, { label: 'Work' }], defaultId: 'nope' });
  assert.equal(set.defaultId, set.profiles[0].id, 'default falls back to the first');
  assert.throws(() => profiles({ profiles: [] }));
  assert.throws(() => profiles({ profiles: Array.from({ length: 6 }, () => ({})) }, 5), /up to 5/);
  assert.throws(() => alerts({ discordWebhook: 'https://discord.com.evil.example/api/webhooks/1/x' }));
  assert.equal(alerts({ discordMention: '@everyone hi' }).discordMention, 'everyone hi', 'no mass mentions');
  assert.equal(alerts({}).browserChecks, true);
});

test('membership labels', () => {
  const now = Date.now();
  assert.equal(entitlement({ plan: 'none' }, now).active, false);
  assert.equal(entitlement({ plan: 'active' }, now).label, 'Member');
  assert.match(entitlement({ plan: 'active', cancel_at_period_end: 1, current_period_end: now + 86400000 }, now).label, /Member \(ends /);
  assert.equal(entitlement({ plan: 'past_due' }, now).warning, true);
  assert.equal(entitlement({ plan: 'trial', trial_ends_at: now + 2 * 86400000 }, now).label, 'Free trial — 2 days left');
  assert.equal(entitlement({ plan: 'trial', trial_ends_at: now - 1 }, now).active, false);
  assert.equal(entitlement({ plan: 'canceled', role: 'admin' }, now).active, true);
});

test('Whop webhook signatures (Standard Webhooks): the right secret, the right body, recent, any of several signatures', () => {
  const secret = 'ws_abc123';
  const w = new Whop({ cfg: { whop: { webhookSecret: secret } }, repo: {}, notifier: {}, discord: {} });
  const body = Buffer.from('{"type":"membership.activated"}');
  const ts = Math.floor(Date.now() / 1000);
  const sig = signWebhook(secret, 'msg_1', ts, body);
  assert.equal(sig, crypto.createHmac('sha256', Buffer.from(secret)).update(`msg_1.${ts}.${body}`).digest('base64'), 'HMAC-SHA256 over id.timestamp.body, base64');
  const h = (s, t = ts, id = 'msg_1') => ({ 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': s });
  assert.equal(w.verify(body, h(`v1,${sig}`)), 'msg_1');
  assert.equal(w.verify(body, h(`v1,bm9wZQ== v1,${sig}`)), 'msg_1', 'several signatures (key rotation)');
  assert.throws(() => w.verify(Buffer.from('{"type":"x"}'), h(`v1,${sig}`)), /Bad signature/);
  assert.throws(() => w.verify(body, h(`v1,${sig}`, ts, 'msg_2')), /Bad signature/);
  assert.throws(() => w.verify(body, h(`v1,${sig}`, ts - 3600)), /too old/);
  assert.throws(() => w.verify(body, {}), /Missing signature/);
  // A "whsec_" secret (Standard Webhooks' own format) is base64-decoded.
  const std = `whsec_${Buffer.from('raw-key-bytes').toString('base64')}`;
  const w2 = new Whop({ cfg: { whop: { webhookSecret: std } }, repo: {}, notifier: {}, discord: {} });
  const sig2 = crypto.createHmac('sha256', Buffer.from('raw-key-bytes')).update(`msg_1.${ts}.${body}`).digest('base64');
  assert.equal(w2.verify(body, h(`v1,${sig2}`)), 'msg_1');
});

test('Discord interaction signatures (Ed25519)', () => {
  const keys = interactionKeys();
  const body = Buffer.from('{"type":1}');
  const ts = '1700000000';
  const sig = keys.sign(ts, body.toString());
  assert.equal(verifyDiscordSignature(keys.publicKey, sig, ts, body), true);
  assert.equal(verifyDiscordSignature(keys.publicKey, sig, '1700000001', body), false);
  assert.equal(verifyDiscordSignature(keys.publicKey, sig, ts, Buffer.from('{"type":2}')), false);
  assert.equal(verifyDiscordSignature(interactionKeys().publicKey, sig, ts, body), false, 'another app\'s key');
  assert.equal(verifyDiscordSignature('zz', sig, ts, body), false);
});

test('rate limiter and cookies', () => {
  let t = 0;
  const rl = new RateLimiter(() => t);
  assert.equal(rl.hit('k', 2, 1000), true);
  assert.equal(rl.hit('k', 2, 1000), true);
  assert.equal(rl.hit('k', 2, 1000), false);
  t = 1001;
  assert.equal(rl.hit('k', 2, 1000), true, 'new window');
  assert.deepEqual(parseCookies('a=1; b=x%20y; a=2'), { a: '1', b: 'x y' });
});

function unzip(buf) {
  const files = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const crc = buf.readUInt32LE(i + 14);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString();
    const data = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    const out = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.equal(zlib.crc32(out), crc, `crc of ${name}`);
    files[name] = out;
    i += 30 + nameLen + extra + size;
  }
  return files;
}

test('zip writer round-trips', () => {
  const zip = makeZip([{ name: 'a/hello.txt', data: 'hello world' }, { name: 'a/lib/b.bin', data: crypto.randomBytes(5000) }]);
  const files = unzip(zip);
  assert.equal(files['a/hello.txt'].toString(), 'hello world');
  assert.equal(files['a/lib/b.bin'].length, 5000);
});

test('extension built for a live server: only that server and the stores; module worker with the shared page reader', async () => {
  const cfg = loadConfig({ baseUrl: 'https://app.mugibot.example', dataKey: crypto.randomBytes(32) });
  const m = extensionManifest(cfg);
  assert.equal(m.manifest_version, 3);
  assert.equal(m.background.type, 'module');
  assert.deepEqual(m.permissions, ['storage', 'alarms'], 'no tabs/history/cookies permissions');
  assert.equal(m.host_permissions[0], 'https://app.mugibot.example/*');
  assert.ok(m.host_permissions.includes('https://www.kmart.com.au/*'), 'stores (for in-browser checks)');
  assert.ok(!JSON.stringify(m).includes('127.0.0.1'), 'no local addresses in a live build');
  const by = (f) => m.content_scripts.find((c) => c.js.includes(f));
  assert.deepEqual(by('bridge.js').matches, ['https://app.mugibot.example/*']);
  assert.equal(by('capture.js').run_at, 'document_start');
  assert.deepEqual(by('content.js').js, ['flows.js', 'core.js', 'fill.js', 'content.js']);
  assert.equal(by('frame.js').all_frames, true);

  const files = extensionFiles(cfg);
  const names = files.map((f) => f.name);
  const needed = new Set([m.background.service_worker, m.action.default_popup, m.options_page, ...Object.values(m.icons), ...m.content_scripts.flatMap((c) => c.js), 'config.js', 'vault.js', 'lib/extract.js', 'lib/html.js', 'lib/status.js']);
  for (const n of needed) assert.ok(names.includes(n), `${n} is in the package`);
  const config = files.find((f) => f.name === 'config.js').data.toString();
  const ctx = { globalThis: {} };
  vm.runInNewContext(config, ctx);
  assert.equal(ctx.globalThis.MGB_CONFIG.server, 'https://app.mugibot.example');
  const classic = files.filter((x) => x.name.endsWith('.js') && !x.name.startsWith('lib/') && x.name !== 'background.js');
  for (const f of classic) assert.doesNotThrow(() => new vm.Script(f.data.toString(), { filename: f.name }), `${f.name} parses`);
  for (const f of files.filter((x) => x.name.startsWith('lib/') || x.name === 'background.js')) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: f.data });
    assert.equal(r.status, 0, `${f.name} parses as a module: ${r.stderr}`);
  }
  // The page reader in the extension is the server's own: it reads a product page the same way.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-ext-'));
  try {
    writeExtension(cfg, dir);
    const { extractProduct } = await import(pathToFileURL(path.join(dir, 'lib', 'extract.js')).href);
    const r = extractProduct('<script type="application/ld+json">{"@type":"Product","name":"UPC","offers":{"availability":"https://schema.org/InStock","price":"360"}}</script>');
    assert.equal(r.status, 'in_stock');
    assert.equal(r.price, 360);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extension built for a server on your computer also runs on the dummy store there', () => {
  const cfg = loadConfig({ baseUrl: 'http://127.0.0.1:8080', dataKey: crypto.randomBytes(32), demoStoreUrl: 'http://localhost:5055' });
  const m = extensionManifest(cfg);
  assert.ok(m.host_permissions.includes('http://127.0.0.1/*'));
  assert.ok(m.host_permissions.includes('http://localhost/*'));
  const content = m.content_scripts.find((c) => c.js.includes('content.js'));
  assert.ok(content.matches.includes('http://localhost/*'));
  assert.deepEqual(content.exclude_matches, ['http://127.0.0.1:8080/*'], 'but not on the dashboard itself');
});

test('extension works on every address of the site (a new domain and the old fly.dev one)', () => {
  const cfg = loadConfig({ baseUrl: 'https://mugibot.example', extraOrigins: 'https://mugibot-live.fly.dev', dataKey: crypto.randomBytes(32) });
  const m = extensionManifest(cfg);
  const bridge = m.content_scripts.find((c) => c.js.includes('bridge.js'));
  assert.deepEqual(bridge.matches, ['https://mugibot.example/*', 'https://mugibot-live.fly.dev/*'], 'the dashboard sees the extension on either address');
  assert.ok(m.host_permissions.includes('https://mugibot-live.fly.dev/*'));
  const ctx = { globalThis: {} };
  vm.runInNewContext(extensionFiles(cfg).find((f) => f.name === 'config.js').data.toString(), ctx);
  assert.equal(ctx.globalThis.MGB_CONFIG.server, 'https://mugibot.example', 'talks to the main address');
  assert.deepEqual([...ctx.globalThis.MGB_CONFIG.appOrigins], ['https://mugibot.example', 'https://mugibot-live.fly.dev']);
  assert.equal(extensionManifest(cfg, { version: '0.9.0' }).version, '0.9.0', 'tests can build an older version');
});

test('production refuses to start without an encryption key', () => {
  assert.throws(() => loadConfig({ env: 'production' }, {}), /DATA_ENCRYPTION_KEY/);
  assert.throws(() => loadConfig({}, { DATA_ENCRYPTION_KEY: 'too-short' }), /32 bytes/);
  const cfg = loadConfig({}, { NODE_ENV: 'production', DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), BASE_URL: 'https://x.example' });
  assert.equal(cfg.secureCookies, true);
  assert.equal(cfg.discord.linkButtons, true, 'Discord buttons on an https address');
  assert.equal(cfg.trialDays, 0, 'no free trial unless you set TRIAL_DAYS');
  assert.equal(cfg.priceDisplay, 'A$19.99 / month');
});
