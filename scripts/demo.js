// Try everything on your own computer with dummy products:  npm run demo
//
// Starts the dummy store (http://localhost:5055) and Mugibot
// (http://localhost:8080) with "dummy store mode" on, so the extension and
// the monitor work against the fake Kmart, BIG W, EB Games and JB Hi-Fi
// shops. Your .env is used for everything else (Discord, Whop…).

import { openBrowser, portHelp, quietExperimentalWarnings, requireNode } from '../server/runtime.js';

requireNode();
quietExperimentalWarnings();
// Loaded only after the Node check, because they need Node's built-in SQLite.
const { startMockStore } = await import('../devtools/mockstore.js');
const { createApp } = await import('../server/app.js');
const { loadConfig, loadEnvFile } = await import('../server/config.js');

loadEnvFile();
const storePort = Number(process.env.MOCKSTORE_PORT || 5055);
const store = await startMockStore({ port: storePort, cardPort: storePort + 1, host: '0.0.0.0' })
  .catch((e) => portHelp(e, e.port || storePort));
const demoStoreUrl = `http://localhost:${storePort}`;
process.env.DEMO_STORE_URL = process.env.DEMO_STORE_URL || demoStoreUrl;
process.env.MONITOR_ALLOW_PRIVATE = '1';
const cfg = loadConfig();
const app = await createApp({ cfg });
const url = await app.listen(cfg.port, cfg.host).catch((e) => portHelp(e, cfg.port));
const admins = cfg.adminUsernames.length ? cfg.adminUsernames.join(', ') : '(nobody yet: set ADMIN_USERNAMES in .env)';
console.log(`
Mugibot (dummy store mode) is running. Leave this window open; press Ctrl+C to stop.

  Dashboard:      ${url}
  Dummy store:    ${demoStoreUrl}   (control panel: restock / sell out products)
  Admin username: ${admins}

  1. Open ${url} and sign up with the admin username above.
  2. On the Extension tab download the extension, unzip it, and load it at
     chrome://extensions (Developer mode → Load unpacked). Press "Connect this browser".
  3. On the Watchlist tab press "Add dummy-store test items".
  4. In the dummy store's control panel, restock a product: the dashboard (and Discord,
     if set up) pings you. Press ⚡ Buy and watch it go to the final button.
`);
openBrowser(url);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); await store.close(); process.exit(0); });
