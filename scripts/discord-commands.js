// Register Mugibot's slash commands (/watch, /watchlist, /buy, /unwatch,
// /status, /restock) in your Discord server:  npm run discord:commands
// Needs DISCORD_CLIENT_ID, DISCORD_BOT_TOKEN and DISCORD_GUILD_ID. Run it
// again whenever you add a retailer (the store list is part of the commands).

import { loadConfig, loadEnvFile } from '../server/config.js';
import { Retailers } from '../server/retailers/index.js';
import { commandDefinitions } from '../server/routes/discord.js';

loadEnvFile();
const cfg = loadConfig();
const { clientId, botToken, guildId, apiBase } = cfg.discord;
if (!clientId || !botToken || !guildId) {
  console.error('Set DISCORD_CLIENT_ID, DISCORD_BOT_TOKEN and DISCORD_GUILD_ID first (see docs/DISCORD.md).');
  process.exit(1);
}
const commands = commandDefinitions(new Retailers({ ...cfg, demoStoreUrl: '' }));
const res = await fetch(`${apiBase}/applications/${clientId}/guilds/${guildId}/commands`, {
  method: 'PUT',
  headers: { authorization: `Bot ${botToken}`, 'content-type': 'application/json' },
  body: JSON.stringify(commands),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Discord refused the commands: HTTP ${res.status}`, JSON.stringify(body, null, 2));
  process.exit(1);
}
console.log(`Registered ${body.length} commands in your server: ${body.map((c) => `/${c.name}`).join(', ')}`);
console.log(`Now set the Interactions Endpoint URL in the Discord Developer Portal to: ${cfg.baseUrl}/api/discord/interactions`);
