// Publishes the browser extension's new version to the Chrome Web Store, so
// members' copies update by themselves. GitHub Actions runs it after every
// merge into main, once the site is live (.github/workflows/ci.yml). It does
// nothing when the store already has this version, or until it's set up.
//
// Setup, once (docs/CHROME-WEB-STORE.md walks through it). In GitHub: your
// repository → Settings → Secrets and variables → Actions:
//   Secret   CWS_SERVICE_ACCOUNT_KEY  the service account's JSON key
//   Variable CWS_PUBLISHER_ID         Chrome Web Store Developer Dashboard → Account → Publisher ID
//   Variable CWS_ITEM_ID              the extension's ID (the end of its listing link)
//   Variable SITE_URL                 your site, e.g. https://mugibot.com
//
// The package is built for the addresses the live site reports, exactly like
// the dashboard's download.

import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../server/config.js';
import { EXTENSION_VERSION, storeZip } from '../server/extension.js';

const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** "1.3.10" > "1.3.9" */
export function newer(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** An access token for the service account (a signed JWT exchanged at Google's token endpoint). */
export async function accessToken(key, { tokenUrl = 'https://oauth2.googleapis.com/token', fetchFn = fetch } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri || tokenUrl, iat: now, exp: now + 3600 }));
  const signature = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key));
  const res = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google refused the service account key (HTTP ${res.status}: ${body.error_description || body.error || 'no token'})`);
  return body.access_token;
}

async function call(fetchFn, url, token, init = {}) {
  const res = await fetchFn(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${new URL(url).pathname} → HTTP ${res.status}: ${(body.error && body.error.message) || JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const versionsIn = (status) => ['publishedItemRevisionStatus', 'submittedItemRevisionStatus']
  .flatMap((k) => ((status[k] && status[k].distributionChannels) || []).map((c) => c.crxVersion))
  .filter(Boolean);

/**
 * Upload and submit `zip` (version `version`) unless the store already has it.
 * Returns { done: 'already' | 'submitted', version, state }.
 */
export async function publish({ zip, version, publisherId, itemId, token, api = 'https://chromewebstore.googleapis.com', fetchFn = fetch, log = console.log, pollMs = 3000 }) {
  const name = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
  const status = await call(fetchFn, `${api}/v2/${name}:fetchStatus`, token);
  const onStore = versionsIn(status);
  const highest = onStore.reduce((a, v) => (newer(v, a) ? v : a), '0');
  if (onStore.length && !newer(version, highest)) {
    log(`The Chrome Web Store already has v${highest} (this is v${version}). Nothing to publish.`);
    return { done: 'already', version: highest };
  }
  log(`Uploading v${version} (the store has ${onStore.length ? `v${highest}` : 'no version yet'})…`);
  let up = await call(fetchFn, `${api}/upload/v2/${name}:upload?uploadType=media`, token, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip });
  let state = up.uploadState;
  for (let i = 0; state === 'IN_PROGRESS' && i < 40; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    up = await call(fetchFn, `${api}/v2/${name}:fetchStatus`, token);
    state = up.lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') throw new Error(`The upload didn't go through (${state || 'unknown state'})`);
  const sub = await call(fetchFn, `${api}/v2/${name}:publish`, token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  log(`Submitted v${version}: ${sub.state || 'submitted'}. Google reviews it (usually within a day or two), then Chrome updates every member's copy by itself.`);
  return { done: 'submitted', version, state: sub.state };
}

async function main() {
  const env = process.env;
  const missing = ['CWS_SERVICE_ACCOUNT_KEY', 'CWS_PUBLISHER_ID', 'CWS_ITEM_ID', 'SITE_URL'].filter((k) => !env[k]);
  if (missing.length) {
    console.log(`::notice::Not publishing to the Chrome Web Store yet: set ${missing.join(', ')} (docs/CHROME-WEB-STORE.md).`);
    return;
  }
  let key;
  try {
    key = JSON.parse(env.CWS_SERVICE_ACCOUNT_KEY);
  } catch {
    throw new Error('CWS_SERVICE_ACCOUNT_KEY should be the whole JSON key file, pasted as it is');
  }
  // Build for the addresses the live site reports, once it runs this version.
  const site = env.SITE_URL.replace(/\/+$/, '');
  let app = null;
  for (let i = 0; i < 20; i++) { // the new version can take a minute or two to go live
    app = await fetch(`${site}/api/ext/app`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    if (app && app.extensionVersion === EXTENSION_VERSION) break;
    await new Promise((r) => setTimeout(r, Number(env.CWS_WAIT_MS) || 10000));
  }
  if (!app || app.extensionVersion !== EXTENSION_VERSION) throw new Error(`${site} runs extension v${app ? app.extensionVersion : '?'}, this is v${EXTENSION_VERSION}: run this job again once the deploy has finished`);
  const cfg = loadConfig({ baseUrl: app.url, extraOrigins: (app.origins || []).filter((o) => o !== new URL(app.url).origin), demoStoreUrl: '' });
  const token = await accessToken(key, { tokenUrl: env.CWS_TOKEN_URL || undefined });
  await publish({ zip: storeZip(cfg), version: EXTENSION_VERSION, publisherId: env.CWS_PUBLISHER_ID, itemId: env.CWS_ITEM_ID, token, api: env.CWS_API_BASE || undefined });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}
