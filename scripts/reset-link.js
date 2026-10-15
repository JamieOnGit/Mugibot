// Make a password-reset link for someone who can't get one by email or
// Discord:  npm run reset-link -- theirname
// The link works once, for 1 hour. (Admins can also do this on /admin.)

import { loadConfig, loadEnvFile } from '../server/config.js';
import { Db } from '../server/db.js';
import { Repo } from '../server/repo.js';

loadEnvFile();
const username = String(process.argv[2] || '').toLowerCase();
if (!username) {
  console.error('Usage: npm run reset-link -- theirname');
  process.exit(1);
}
const cfg = loadConfig();
const db = new Db(cfg.databasePath);
const repo = new Repo(db, cfg);
const user = repo.userByUsername(username);
if (!user) {
  console.error(`No account called "${username}".`);
  process.exit(1);
}
const token = repo.createReset(user.id);
repo.audit(null, user.id, 'reset-link', `${username} (command line)`);
db.close();
console.log(`Password-reset link for ${username} (works once, for 1 hour):\n${cfg.baseUrl}/reset?token=${token}`);
