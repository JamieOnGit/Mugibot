// Settings come from environment variables (see .env.example). Nothing secret
// is hard-coded: in production the server refuses to start without its keys.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load KEY=value lines from a .env file without overriding real env vars. */
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function parseKey(value, name) {
  if (!value) return null;
  const buf = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes (64 hex characters or base64). Generate one with: openssl rand -hex 32`);
  return buf;
}

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

/**
 * Build the config. `overrides` is used by tests; everything else comes from env.
 */
export function loadConfig(overrides = {}, env = process.env) {
  const o = overrides;
  const production = (o.env ?? env.NODE_ENV) === 'production';
  const port = o.port ?? int(env.PORT, 8080);
  const baseUrl = trimSlash(o.baseUrl ?? env.BASE_URL ?? `http://localhost:${port}`);
  let dataKey = o.dataKey ?? parseKey(env.DATA_ENCRYPTION_KEY, 'DATA_ENCRYPTION_KEY');
  if (!dataKey) {
    if (production) throw new Error('DATA_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -hex 32');
    // Development only: a fixed throwaway key so data survives restarts on your machine.
    dataKey = crypto.createHash('sha256').update('mugibot-development-key-do-not-use-in-production').digest();
  }
  const cfg = {
    production,
    port,
    host: o.host ?? env.HOST ?? '0.0.0.0',
    baseUrl,
    // No BASE_URL given: use whatever address the server ends up listening on.
    baseUrlAuto: !(o.baseUrl ?? env.BASE_URL),
    extraOrigins: list(o.extraOrigins ?? env.EXTRA_ORIGINS).map(trimSlash),
    secureCookies: baseUrl.startsWith('https://'),
    trustProxy: o.trustProxy ?? env.TRUST_PROXY === '1',
    databasePath: o.databasePath ?? env.DATABASE_PATH ?? path.join(ROOT, 'data', 'mugibot.db'),
    dataKey,
    appName: o.appName ?? env.APP_NAME ?? 'Mugibot',
    supportEmail: o.supportEmail ?? env.SUPPORT_EMAIL ?? '',
    // Once the extension is published: its Chrome Web Store page.
    chromeStoreUrl: o.chromeStoreUrl ?? env.CHROME_STORE_URL ?? '',
    // These usernames are admins (applies when they sign up or log in).
    adminUsernames: list(o.adminUsernames ?? env.ADMIN_USERNAMES).map((s) => s.toLowerCase()),
    // 0 = no free trial: people subscribe through Whop to use the bot.
    trialDays: o.trialDays ?? int(env.TRIAL_DAYS, 0),
    priceDisplay: o.priceDisplay ?? env.PRICE_DISPLAY ?? 'A$19.99 / month',
    signupsOpen: (o.signupsOpen ?? env.SIGNUPS_OPEN ?? '1') !== '0' && o.signupsOpen !== false,
    // A store of dummy products for testing every retailer's checkout flow (npm run mockstore).
    demoStoreUrl: trimSlash(o.demoStoreUrl ?? env.DEMO_STORE_URL ?? ''),
    whop: {
      apiKey: o.whopApiKey ?? env.WHOP_API_KEY ?? '',
      webhookSecret: o.whopWebhookSecret ?? env.WHOP_WEBHOOK_SECRET ?? '',
      planId: o.whopPlanId ?? env.WHOP_PLAN_ID ?? '',
      productId: o.whopProductId ?? env.WHOP_PRODUCT_ID ?? '',
      // Your product's public Whop page, used when the API key isn't set.
      checkoutUrl: o.whopCheckoutUrl ?? env.WHOP_CHECKOUT_URL ?? '',
      apiBase: trimSlash(o.whopApiBase ?? env.WHOP_API_BASE ?? 'https://api.whop.com/api/v1'),
    },
    discord: {
      clientId: o.discordClientId ?? env.DISCORD_CLIENT_ID ?? '',
      clientSecret: o.discordClientSecret ?? env.DISCORD_CLIENT_SECRET ?? '',
      botToken: o.discordBotToken ?? env.DISCORD_BOT_TOKEN ?? '',
      publicKey: o.discordPublicKey ?? env.DISCORD_PUBLIC_KEY ?? '',
      guildId: o.discordGuildId ?? env.DISCORD_GUILD_ID ?? '',
      // Given to members with an active membership, taken away when it ends.
      memberRoleId: o.discordMemberRoleId ?? env.DISCORD_MEMBER_ROLE_ID ?? '',
      // Where restocks of the SKUs admins "announce" are posted, and who is pinged.
      restockChannelId: o.discordRestockChannelId ?? env.DISCORD_RESTOCK_CHANNEL_ID ?? '',
      restockRoleId: o.discordRestockRoleId ?? env.DISCORD_RESTOCK_ROLE_ID ?? '',
      inviteUrl: o.discordInviteUrl ?? env.DISCORD_INVITE_URL ?? '',
      kickOnExpire: (o.discordKickOnExpire ?? env.DISCORD_KICK_ON_EXPIRE) === true || (o.discordKickOnExpire ?? env.DISCORD_KICK_ON_EXPIRE) === '1',
      apiBase: trimSlash(o.discordApiBase ?? env.DISCORD_API_BASE ?? 'https://discord.com/api/v10'),
      oauthBase: trimSlash(o.discordOAuthBase ?? env.DISCORD_OAUTH_BASE ?? 'https://discord.com'),
      // Discord only accepts https links on buttons; on your own computer links go in the message text.
      linkButtons: o.discordLinkButtons ?? baseUrl.startsWith('https://'),
    },
    email: {
      resendApiKey: o.resendApiKey ?? env.RESEND_API_KEY ?? '',
      from: o.emailFrom ?? env.EMAIL_FROM ?? '',
      apiBase: trimSlash(o.resendApiBase ?? env.RESEND_API_BASE ?? 'https://api.resend.com'),
      // Tests (and local dev without an email provider) capture messages here.
      outbox: o.outbox ?? null,
    },
    limits: {
      items: o.maxItems ?? int(env.MAX_ITEMS, 50),
      profiles: o.maxProfiles ?? int(env.MAX_PROFILES, 5),
      devices: o.maxDevices ?? int(env.MAX_DEVICES, 5),
      // New accounts per hour from one IP address.
      signupsPerHour: o.signupsPerHour ?? int(env.SIGNUPS_PER_HOUR, 10),
    },
    monitor: {
      enabled: o.monitorEnabled ?? env.MONITOR_ENABLED !== '0',
      // How often one product page is checked from the server, however many people watch it.
      urlIntervalSeconds: o.urlIntervalSeconds ?? int(env.MONITOR_URL_INTERVAL, 60),
      // Gap between any two server requests to the same store.
      hostGapSeconds: o.hostGapSeconds ?? int(env.MONITOR_HOST_GAP, 5),
      // How often a member's own browser re-checks one of their own SKUs (stores that refuse server checks).
      browserIntervalSeconds: o.browserIntervalSeconds ?? int(env.BROWSER_CHECK_INTERVAL, 60),
      tickMs: o.monitorTickMs ?? 1000,
      timeoutMs: o.monitorTimeoutMs ?? 15000,
      userAgent: o.userAgent ?? `Mugibot/1.0 (restock alerts; +${baseUrl})`,
      // Only for testing with a store on your own computer: lets the monitor fetch private addresses.
      allowPrivateHosts: o.allowPrivateHosts ?? env.MONITOR_ALLOW_PRIVATE === '1',
      // The Monitor feed (docs/MONITORING.md): the shortest interval a monitor may ask for,
      // the cooldown before one product alerts the same kind again, the smallest price change
      // that counts, and how long the check log is kept.
      minIntervalSeconds: o.minIntervalSeconds ?? int(env.MONITOR_MIN_INTERVAL, 20),
      // VIP drops (monitor/vip.js): a VIP page read this often in its drop window, and otherwise;
      // a VIP keyword searched at its store this often in the window.
      vipFastSeconds: o.vipFastSeconds ?? int(env.VIP_FAST_SECONDS, 5),
      vipSlowSeconds: o.vipSlowSeconds ?? int(env.VIP_SLOW_SECONDS, 15),
      vipSweepSeconds: o.vipSweepSeconds ?? int(env.VIP_SWEEP_SECONDS, 4),
      alertCooldownSeconds: o.alertCooldownSeconds ?? int(env.MONITOR_ALERT_COOLDOWN, 600),
      priceChangePercent: o.priceChangePercent ?? Number(env.MONITOR_PRICE_CHANGE_PERCENT || 1),
      logDays: o.logDays ?? int(env.MONITOR_LOG_DAYS, 7),
    },
    // Background jobs: Discord role sync, Whop re-checks, expired trials.
    jobsEnabled: o.jobsEnabled ?? env.JOBS_ENABLED !== '0',
    sessionDays: o.sessionDays ?? int(env.SESSION_DAYS, 30),
    log: o.log ?? ((...a) => console.log(new Date().toISOString(), ...a)),
  };
  return cfg;
}

export const whopConfigured = (cfg) => !!(cfg.whop.apiKey && cfg.whop.planId);
export const discordOAuthConfigured = (cfg) => !!(cfg.discord.clientId && cfg.discord.clientSecret);
export const discordBotConfigured = (cfg) => !!(cfg.discord.botToken && cfg.discord.guildId);
