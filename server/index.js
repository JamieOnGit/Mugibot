// Start the Mugibot server:  npm start
import { createApp } from './app.js';
import { loadConfig, loadEnvFile } from './config.js';

loadEnvFile();
const cfg = loadConfig();
const app = await createApp({ cfg });
const url = await app.listen(cfg.port, cfg.host);
cfg.log(`${cfg.appName} is running on ${url} (public address: ${cfg.baseUrl})`);
if (!app.whop.configured) cfg.log(cfg.whop.checkoutUrl ? 'Whop API key / plan not set: members are sent to WHOP_CHECKOUT_URL and an admin links their membership.' : 'Whop is not set up (WHOP_API_KEY / WHOP_PLAN_ID). Nobody can subscribe until you add them — admins can still give free access.');
if (!app.whop.configured && !cfg.whop.webhookSecret) cfg.log('WHOP_WEBHOOK_SECRET is not set: memberships won\'t update automatically.');
if (!app.discord.oauthReady) cfg.log('Discord sign-in is not set up (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET): members can\'t connect Discord yet.');
if (!app.discord.botReady) cfg.log('The Discord bot is not set up (DISCORD_BOT_TOKEN / DISCORD_GUILD_ID): no DMs, server roles or channel posts yet.');
if (!app.ctx.mailer.configured) cfg.log('Email is not set up (RESEND_API_KEY / EMAIL_FROM). Optional — password resets also go by Discord DM.');
if (!cfg.adminUsernames.length) cfg.log('No ADMIN_USERNAMES set — nobody can open /admin. Set ADMIN_USERNAMES=yourname, or run: npm run make-admin -- yourname');
if (cfg.demoStoreUrl) cfg.log(`Dummy store mode: ${cfg.demoStoreUrl}`);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    cfg.log('Shutting down…');
    await app.close();
    process.exit(0);
  });
}
