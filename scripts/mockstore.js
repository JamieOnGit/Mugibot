// Start the dummy store on its own:  npm run mockstore
// (PORT=5055 by default). Then set DEMO_STORE_URL=http://localhost:5055 for
// the Mugibot server — or just use `npm run demo`, which starts both.

import { startMockStore } from '../devtools/mockstore.js';

const port = Number(process.env.MOCKSTORE_PORT || process.argv[2] || 5055);
const store = await startMockStore({ port, cardPort: port + 1, host: '0.0.0.0' });
const url = `http://localhost:${port}`;
console.log(`Dummy store running at ${url}  (control panel: ${url}/)`);
console.log(`  Kmart-style:   ${url}/kmart/`);
console.log(`  BIG W-style:   ${url}/bigw/`);
console.log(`  EB Games-style:${url}/ebgames/`);
console.log(`  JB Hi-Fi-style:${url}/jbhifi/`);
console.log(`Card frames are served from port ${port + 1}.`);
process.on('SIGINT', async () => { await store.close(); process.exit(0); });
