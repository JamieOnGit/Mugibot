// The Chrome Web Store: the package admins upload (manifest at the top of the
// zip), the listing link admins set (members' extensions then move to that copy,
// which updates itself), and the GitHub job that publishes each new version
// (against a fake Chrome Web Store API and token endpoint).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import { EXTENSION_VERSION, storeZip } from '../server/extension.js';
import { accessToken, newer, publish } from '../scripts/publish-extension.js';
import { Client, startApp } from './helpers.js';

let env;
before(async () => {
  env = await startApp({ adminUsernames: 'boss', baseUrl: 'https://mugibot.example', extraOrigins: ['https://mugibot-live.fly.dev'] });
});
after(async () => {
  await env?.close();
});

/** The files in a zip written by server/zip.js. */
function unzip(buf) {
  const files = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString();
    const data = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    i += 30 + nameLen + extra + size;
  }
  return files;
}

test('the Chrome Web Store package: manifest at the top of the zip, built for every address of the site', () => {
  const files = unzip(storeZip(env.app.cfg));
  assert.ok(files['manifest.json'], 'manifest.json at the top, as the Chrome Web Store wants');
  const m = JSON.parse(files['manifest.json']);
  assert.equal(m.version, EXTENSION_VERSION);
  assert.equal(m.update_url, undefined, 'the store adds its own update address');
  assert.ok(m.host_permissions.includes('https://mugibot.example/*'));
  assert.ok(m.host_permissions.includes('https://mugibot-live.fly.dev/*'));
  assert.ok(!m.host_permissions.some((h) => /localhost|127\.0\.0\.1/.test(h)), 'nothing for a computer');
  assert.match(String(files['config.js']), /"server":"https:\/\/mugibot\.example"/);
});

test('admins set the listing link (checked), download the package, and see which copies members use', async () => {
  const boss = await Client.signup(env.url, 'boss');
  const member = await Client.signup(env.url, 'member1');
  assert.equal((await member.get('/api/admin/extension')).status, 404, 'admins only');
  assert.equal((await member.get('/api/admin/extension/webstore.zip')).status, 404);

  let r = await boss.get('/api/admin/extension');
  assert.equal(r.status, 200);
  assert.equal(r.body.version, EXTENSION_VERSION);
  assert.equal(r.body.storeUrl, null);
  r = await boss.put('/api/admin/extension', { storeUrl: 'https://evil.example/detail/x' });
  assert.equal(r.status, 400, 'only a Chrome Web Store link');
  const listing = 'https://chromewebstore.google.com/detail/mugibot/abcdefghijklmnopabcdefghijklmnop';
  r = await boss.put('/api/admin/extension', { storeUrl: listing });
  assert.equal(r.status, 200);
  assert.equal(r.body.storeUrl, listing);
  assert.equal(r.body.storeUrlFrom, 'admin');

  // Every extension (and the dashboard) hears about it.
  const app = await fetch(`${env.url}/api/ext/app`).then((x) => x.json());
  assert.equal(app.chromeStoreUrl, listing);
  assert.deepEqual(app.origins, ['https://mugibot.example', 'https://mugibot-live.fly.dev']);
  assert.equal((await member.get('/api/me')).body.app.chromeStoreUrl, listing);

  const zip = await fetch(`${env.url}/api/admin/extension/webstore.zip`, { headers: { cookie: boss.cookie } });
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get('content-disposition'), /mugibot-webstore-\d+\.\d+\.\d+\.zip/);
  assert.ok(unzip(Buffer.from(await zip.arrayBuffer()))['manifest.json']);

  r = await boss.put('/api/admin/extension', { storeUrl: '' });
  assert.equal(r.body.storeUrl, null, 'removed');
  assert.ok(env.app.repo.listAudit(10).some((a) => a.action === 'extension-store-link'));
});

// --- the GitHub job --------------------------------------------------------------------------
/** A fake Chrome Web Store API + Google token endpoint. */
async function fakeGoogle({ published = [], submitted = [], uploadStates = ['SUCCEEDED'] } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const states = [...uploadStates];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: decodeURIComponent(url.pathname), query: url.search, auth: req.headers.authorization, type: req.headers['content-type'], body });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (url.pathname === '/token') {
        const assertion = new URLSearchParams(body.toString()).get('assertion');
        const [h, c, s] = assertion.split('.');
        const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'));
        const claims = JSON.parse(Buffer.from(c, 'base64url'));
        if (!ok || claims.scope !== 'https://www.googleapis.com/auth/chromewebstore' || claims.iss !== 'publisher@project.iam.gserviceaccount.com') return send(400, { error: 'invalid_grant' });
        return send(200, { access_token: 'tok-123', expires_in: 3600 });
      }
      if (req.headers.authorization !== 'Bearer tok-123') return send(401, { error: { message: 'no token' } });
      const ch = (v) => ({ distributionChannels: v.map((crxVersion) => ({ crxVersion, deployPercentage: 100 })) });
      if (url.pathname.endsWith(':fetchStatus')) {
        return send(200, {
          ...(published.length ? { publishedItemRevisionStatus: { state: 'PUBLISHED', ...ch(published) } } : {}),
          ...(submitted.length ? { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', ...ch(submitted) } } : {}),
          lastAsyncUploadState: states.length > 1 ? states.shift() : states[0],
        });
      }
      if (url.pathname.endsWith(':upload')) return send(200, { uploadState: states.length > 1 ? states.shift() : states[0] });
      if (url.pathname.endsWith(':publish')) return send(200, { state: 'PENDING_REVIEW' });
      return send(404, { error: { message: 'unknown' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const key = { client_email: 'publisher@project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${base}/token` };
  return { base, key, calls, close: () => new Promise((r) => server.close(r)) };
}

test('publishing: signs in as the service account, uploads the package and submits it when the store has an older version', async () => {
  const g = await fakeGoogle({ published: ['1.2.0'] });
  try {
    const token = await accessToken(g.key, { tokenUrl: `${g.base}/token` });
    assert.equal(token, 'tok-123');
    const zip = storeZip(env.app.cfg);
    const out = await publish({ zip, version: '1.3.1', publisherId: 'pub-1', itemId: 'abcdefghijklmnopabcdefghijklmnop', token, api: g.base, log: () => {} });
    assert.equal(out.done, 'submitted');
    const paths = g.calls.map((c) => `${c.method} ${c.path}`);
    assert.deepEqual(paths, [
      'POST /token',
      'GET /v2/publishers/pub-1/items/abcdefghijklmnopabcdefghijklmnop:fetchStatus',
      'POST /upload/v2/publishers/pub-1/items/abcdefghijklmnopabcdefghijklmnop:upload',
      'POST /v2/publishers/pub-1/items/abcdefghijklmnopabcdefghijklmnop:publish',
    ]);
    const upload = g.calls[2];
    assert.equal(upload.type, 'application/zip');
    assert.equal(upload.query, '?uploadType=media');
    assert.ok(upload.body.equals(zip), 'the package itself');
  } finally {
    await g.close();
  }
});

test('publishing: nothing to do when the store already has this version (published or in review); waits for a slow upload', async () => {
  for (const setup of [{ published: ['1.3.1'] }, { published: ['1.3.0'], submitted: ['1.3.1'] }, { published: ['1.4.0'] }]) {
    const g = await fakeGoogle(setup);
    try {
      const out = await publish({ zip: Buffer.from('zip'), version: '1.3.1', publisherId: 'p', itemId: 'i', token: 'tok-123', api: g.base, log: () => {} });
      assert.equal(out.done, 'already', JSON.stringify(setup));
      assert.ok(!g.calls.some((c) => c.path.endsWith(':upload')), 'no upload');
    } finally {
      await g.close();
    }
  }
  const g = await fakeGoogle({ published: ['1.3.0'], uploadStates: ['IN_PROGRESS', 'IN_PROGRESS', 'SUCCEEDED'] });
  try {
    const out = await publish({ zip: Buffer.from('zip'), version: '1.3.1', publisherId: 'p', itemId: 'i', token: 'tok-123', api: g.base, log: () => {}, pollMs: 10 });
    assert.equal(out.done, 'submitted');
    assert.ok(g.calls.some((c) => c.path.endsWith(':publish')));
  } finally {
    await g.close();
  }
  const bad = await fakeGoogle({ published: ['1.3.0'], uploadStates: ['FAILED'] });
  try {
    await assert.rejects(publish({ zip: Buffer.from('zip'), version: '1.3.1', publisherId: 'p', itemId: 'i', token: 'tok-123', api: bad.base, log: () => {} }), /upload didn't go through \(FAILED\)/);
    assert.ok(!bad.calls.some((c) => c.path.endsWith(':publish')), 'not submitted');
  } finally {
    await bad.close();
  }
  assert.equal(newer('1.3.10', '1.3.9'), true);
  assert.equal(newer('1.3.1', '1.3.1'), false);
});

test('the GitHub job end to end: skips until set up, then builds for the live site and submits', async () => {
  const { execFile } = await import('node:child_process');
  const run = (extra) => new Promise((resolve) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/publish-extension.js'], { env: { PATH: process.env.PATH, ...extra } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });
  let r = await run({});
  assert.equal(r.code, 0, 'not set up yet: nothing fails');
  assert.match(r.out, /Not publishing to the Chrome Web Store yet: set CWS_SERVICE_ACCOUNT_KEY, CWS_PUBLISHER_ID, CWS_ITEM_ID, SITE_URL/);

  const g = await fakeGoogle({ published: ['0.0.1'] });
  try {
    r = await run({ CWS_SERVICE_ACCOUNT_KEY: JSON.stringify(g.key), CWS_PUBLISHER_ID: 'pub-1', CWS_ITEM_ID: 'item-1', SITE_URL: env.url, CWS_API_BASE: g.base, CWS_TOKEN_URL: `${g.base}/token` });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Submitted v${EXTENSION_VERSION.replace(/\./g, '\\.')}`));
    const upload = g.calls.find((c) => c.path.endsWith(':upload'));
    const m = JSON.parse(unzip(upload.body)['manifest.json']);
    assert.ok(m.host_permissions.includes('https://mugibot.example/*') && m.host_permissions.includes('https://mugibot-live.fly.dev/*'), 'built for the addresses the live site reports');
  } finally {
    await g.close();
  }
  r = await run({ CWS_SERVICE_ACCOUNT_KEY: 'not json', CWS_PUBLISHER_ID: 'p', CWS_ITEM_ID: 'i', SITE_URL: env.url });
  assert.equal(r.code, 1);
  assert.match(r.out, /::error::CWS_SERVICE_ACCOUNT_KEY should be the whole JSON key file/);
});
