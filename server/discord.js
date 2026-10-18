// Discord: the members' server and the bot that pings people.
//
// * Connect Discord (OAuth2, scopes "identify guilds.join"): ties a Discord
//   account to a Mugibot login. With an active membership the bot adds them
//   to the server and gives them the member role; when the membership ends
//   the role is taken away again (and, if you choose, they're removed).
// * DMs: each member's own restock pings, with a ⚡ Buy button.
// * Channel posts: restocks of the SKUs admins announce, pinging a role.
// * Slash commands come in through routes/discord.js (interactions endpoint).
//
// Discord tokens are kept encrypted with the member's own key, like their address.

import { discordBotConfigured, discordOAuthConfigured } from './config.js';
import { entitlement } from './entitlement.js';
import { ENTITLED_SQL } from './repo.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Plain words for the Discord errors people hit while setting up. */
function explain(status, body, what) {
  const code = body && body.code;
  if (code === 50007) return 'Discord won\'t deliver the DM — turn on "Allow DMs from server members" for the members\' server (Privacy settings), and make sure you\'re in it';
  if (code === 30001) return 'This Discord account is in too many servers to join another';
  if (code === 10004) return 'The bot is not in that server (DISCORD_GUILD_ID), or the ID is wrong';
  if (code === 10011) return "The member role doesn't exist (DISCORD_MEMBER_ROLE_ID)";
  if (code === 10003) return "The channel doesn't exist or the bot can't see it (DISCORD_RESTOCK_CHANNEL_ID)";
  if (status === 401) return 'The bot token is wrong (DISCORD_BOT_TOKEN)';
  if (code === 50013 || status === 403) return `The bot isn't allowed to ${what}. Give its role "Create Invite" and "Manage Roles" (and "Kick Members" if you remove people), and drag it above the member role`;
  return `Discord said HTTP ${status}${body && body.message ? ` (${body.message})` : ''}`;
}

export class Discord {
  constructor({ cfg, repo, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { cfg, repo, fetch: fetchImpl, now });
    this.d = cfg.discord;
    this.active = 0;
    this.waiting = [];
  }

  get oauthReady() { return discordOAuthConfigured(this.cfg); }
  get botReady() { return discordBotConfigured(this.cfg); }
  get interactionsReady() { return !!(this.d.publicKey && this.d.clientId); }

  // -------------------------------------------------------------------------
  // REST, with Discord's rate limits respected (a few requests at a time, and
  // waiting when Discord says "slow down")
  // -------------------------------------------------------------------------
  async slot() {
    if (this.active < 4) { this.active += 1; return; }
    await new Promise((r) => this.waiting.push(r));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }

  async api(method, path, body, { bearer = null, form = null } = {}) {
    await this.slot();
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const headers = { 'user-agent': `DiscordBot (${this.cfg.baseUrl}, 1.0) ${this.cfg.appName}` };
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        else if (!form) headers.authorization = `Bot ${this.d.botToken}`;
        let payload;
        if (form) {
          headers['content-type'] = 'application/x-www-form-urlencoded';
          payload = new URLSearchParams(form).toString();
        } else if (body !== undefined) {
          headers['content-type'] = 'application/json';
          payload = JSON.stringify(body);
        }
        let res;
        try {
          res = await this.fetch(`${this.d.apiBase}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(10000) });
        } catch (e) {
          return { status: 0, body: { message: e.message } };
        }
        const data = res.status === 204 ? null : await res.json().catch(() => null);
        if (res.status === 429 && attempt < 3) {
          await wait(Math.min(10, Number(data && data.retry_after) || 1) * 1000);
          continue;
        }
        return { status: res.status, body: data };
      }
      return { status: 429, body: { message: 'rate limited' } };
    } finally {
      this.release();
    }
  }

  // -------------------------------------------------------------------------
  // Connect Discord (OAuth2)
  // -------------------------------------------------------------------------
  get redirectUri() {
    return `${this.cfg.baseUrl}/auth/discord/callback`;
  }

  authorizeUrl(state) {
    const q = new URLSearchParams({ client_id: this.d.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: 'identify guilds.join', state, prompt: 'consent' });
    return `${this.d.oauthBase}/oauth2/authorize?${q}`;
  }

  async tokenRequest(form) {
    const r = await this.api('POST', '/oauth2/token', undefined, { form: { client_id: this.d.clientId, client_secret: this.d.clientSecret, ...form } });
    if (r.status !== 200 || !r.body || !r.body.access_token) throw new Error(`Discord didn't accept the connection (${explain(r.status, r.body, 'connect')})`);
    return { access_token: r.body.access_token, refresh_token: r.body.refresh_token || null, expires_at: this.now() + (Number(r.body.expires_in) || 604800) * 1000 };
  }

  /** Finish "Connect Discord" for this user with the code Discord sent back. */
  async link(user, code) {
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri });
    const me = await this.api('GET', '/users/@me', undefined, { bearer: tokens.access_token });
    if (me.status !== 200 || !me.body || !me.body.id) throw new Error("Couldn't read your Discord account");
    const other = this.repo.userByDiscordId(me.body.id);
    if (other && other.id !== user.id) throw new Error(`That Discord account is already connected to another ${this.cfg.appName} account (${other.username})`);
    const name = me.body.global_name && me.body.global_name !== me.body.username ? `${me.body.username} (${me.body.global_name})` : me.body.username;
    if (user.discord_id && user.discord_id !== me.body.id) await this.removeMember(user).catch(() => null);
    const updated = this.repo.updateUser(user.id, { discord_id: me.body.id, discord_username: name, discord_dm_channel: null, discord_in_guild: 0, discord_role: 0, discord_error: '' });
    this.repo.setData(user.id, 'discord_oauth', tokens);
    const sync = await this.sync(updated);
    return { discordId: me.body.id, username: name, sync };
  }

  async unlink(user) {
    await this.removeMember(user).catch(() => null);
    const tokens = this.repo.getData(user.id, 'discord_oauth', null);
    if (tokens && tokens.access_token && this.oauthReady) {
      await this.api('POST', '/oauth2/token/revoke', undefined, { form: { client_id: this.d.clientId, client_secret: this.d.clientSecret, token: tokens.access_token, token_type_hint: 'access_token' } }).catch(() => null);
    }
    this.repo.deleteData(user.id, 'discord_oauth');
    return this.repo.updateUser(user.id, { discord_id: null, discord_username: null, discord_dm_channel: null, discord_in_guild: 0, discord_role: 0, discord_error: '', discord_synced_at: null });
  }

  /** A working access token for this member (refreshed if it's about to run out), or null. */
  async accessToken(user) {
    let tokens = this.repo.getData(user.id, 'discord_oauth', null);
    if (!tokens || !tokens.access_token) return null;
    if (tokens.expires_at - this.now() < 60 * 60 * 1000) {
      if (!tokens.refresh_token || !this.oauthReady) return null;
      try {
        tokens = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
        this.repo.setData(user.id, 'discord_oauth', tokens);
      } catch {
        return null;
      }
    }
    return tokens.access_token;
  }

  // -------------------------------------------------------------------------
  // Server membership and the member role
  // -------------------------------------------------------------------------
  /** Bring this member's Discord access in line with their membership. */
  async sync(user) {
    if (!this.botReady || !user || !user.discord_id) return { skipped: true };
    const g = this.d.guildId;
    const role = this.d.memberRoleId;
    const fresh = this.repo.userById(user.id) || user;
    const allowed = !fresh.disabled && entitlement(fresh, this.now()).active;
    const done = (fields) => {
      this.repo.updateUser(user.id, { discord_synced_at: this.now(), ...fields });
      return { ok: !fields.discord_error, error: fields.discord_error || '', inGuild: !!(fields.discord_in_guild ?? fresh.discord_in_guild), hasRole: !!(fields.discord_role ?? fresh.discord_role) };
    };
    const m = await this.api('GET', `/guilds/${g}/members/${fresh.discord_id}`);
    if (m.status !== 200 && m.status !== 404) return done({ discord_error: explain(m.status, m.body, 'see server members') });
    let inGuild = m.status === 200;
    let roles = inGuild && m.body && Array.isArray(m.body.roles) ? m.body.roles : [];

    if (allowed) {
      if (!inGuild) {
        const token = await this.accessToken(fresh);
        if (!token) return done({ discord_in_guild: 0, discord_role: 0, discord_error: 'Connect Discord again so the bot can add you to the server' });
        const add = await this.api('PUT', `/guilds/${g}/members/${fresh.discord_id}`, { access_token: token, ...(role ? { roles: [role] } : {}) });
        if (add.status !== 201 && add.status !== 204) return done({ discord_in_guild: 0, discord_error: explain(add.status, add.body, 'add people to the server') });
        inGuild = true;
        if (add.status === 201) roles = role ? [role] : [];
      }
      if (role && !roles.includes(role)) {
        const give = await this.api('PUT', `/guilds/${g}/members/${fresh.discord_id}/roles/${role}`);
        if (give.status !== 204) return done({ discord_in_guild: 1, discord_role: 0, discord_error: explain(give.status, give.body, 'give the member role') });
      }
      return done({ discord_in_guild: 1, discord_role: role ? 1 : 0, discord_error: '' });
    }

    // No active membership: take the role away (and remove them, if set to).
    if (inGuild && role && roles.includes(role)) {
      const take = await this.api('DELETE', `/guilds/${g}/members/${fresh.discord_id}/roles/${role}`);
      if (take.status !== 204 && take.status !== 404) return done({ discord_error: explain(take.status, take.body, 'take the member role away') });
    }
    if (inGuild && this.d.kickOnExpire && fresh.role !== 'admin') {
      const kick = await this.api('DELETE', `/guilds/${g}/members/${fresh.discord_id}`);
      if (kick.status === 204 || kick.status === 404) inGuild = false;
    }
    return done({ discord_in_guild: inGuild ? 1 : 0, discord_role: 0, discord_error: '' });
  }

  /** Leaving (account deleted or Discord disconnected): take the member role away. */
  async removeMember(user) {
    if (!this.botReady || !user || !user.discord_id || !this.d.memberRoleId) return false;
    const r = await this.api('DELETE', `/guilds/${this.d.guildId}/members/${user.discord_id}/roles/${this.d.memberRoleId}`);
    return r.status === 204;
  }

  /** Fix anyone whose role doesn't match their membership (trials ending, missed webhooks). */
  async sweep(limit = 50) {
    if (!this.botReady) return 0;
    const now = this.now();
    const rows = this.repo.db.all(`SELECT u.* FROM users u WHERE u.discord_id IS NOT NULL AND (
        (u.disabled = 0 AND ${ENTITLED_SQL} AND (u.discord_role = 0 OR u.discord_in_guild = 0) AND (u.discord_synced_at IS NULL OR u.discord_synced_at < :retry))
        OR ((u.disabled = 1 OR NOT ${ENTITLED_SQL}) AND u.discord_role = 1))
      LIMIT :limit`, { now, retry: now - 60 * 60 * 1000, limit });
    for (const u of rows) await this.sync(u).catch((e) => this.cfg.log('[discord] sync failed', e.message));
    return rows.length;
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------
  /** DM a member. False if they can't be reached (DMs off, not in the server, bot not set up). */
  async dm(user, message) {
    if (!this.botReady || !user || !user.discord_id) return false;
    let channel = user.discord_dm_channel;
    if (!channel) {
      const c = await this.api('POST', '/users/@me/channels', { recipient_id: user.discord_id });
      if (c.status !== 200 || !c.body || !c.body.id) {
        this.repo.updateUser(user.id, { discord_error: explain(c.status, c.body, 'message you') });
        return false;
      }
      channel = c.body.id;
      this.repo.updateUser(user.id, { discord_dm_channel: channel });
    }
    const r = await this.api('POST', `/channels/${channel}/messages`, message);
    if (r.status === 200) {
      if (user.discord_error) this.repo.updateUser(user.id, { discord_error: '' });
      return true;
    }
    if (r.status === 404) this.repo.updateUser(user.id, { discord_dm_channel: null });
    this.repo.updateUser(user.id, { discord_error: explain(r.status, r.body, 'message you') });
    return false;
  }

  /** The server's channels (the alert channels are found by name). { status, body: [channel] } */
  guildChannels() {
    return this.api('GET', `/guilds/${this.d.guildId}/channels`);
  }

  /** The server's roles (a drop watch's channel can ping one). { status, body: [role] } */
  guildRoles() {
    return this.api('GET', `/guilds/${this.d.guildId}/roles`);
  }

  /** Make a channel in the server (needs the Manage Channels permission). { status, body: channel } */
  createChannel(body) {
    return this.api('POST', `/guilds/${this.d.guildId}/channels`, body);
  }

  /** Change the reply to a button press or slash command (its interaction token lasts 15 minutes). */
  async editReply(token, body) {
    if (!this.d.clientId || !token) return false;
    const r = await this.api('PATCH', `/webhooks/${this.d.clientId}/${encodeURIComponent(token)}/messages/@original`, body);
    return r.status === 200;
  }

  async post(channelId, message) {
    if (!this.botReady || !channelId) return false;
    const r = await this.api('POST', `/channels/${channelId}/messages`, message);
    if (r.status !== 200) this.cfg.log('[discord] channel post failed:', explain(r.status, r.body, 'post in that channel'));
    return r.status === 200;
  }

  /** Register (or replace) the slash commands in our server. */
  async registerCommands(commands) {
    if (!this.botReady || !this.d.clientId) return { ok: false, error: 'Set DISCORD_CLIENT_ID, DISCORD_BOT_TOKEN and DISCORD_GUILD_ID first' };
    const r = await this.api('PUT', `/applications/${this.d.clientId}/guilds/${this.d.guildId}/commands`, commands);
    if (r.status !== 200 || !Array.isArray(r.body)) return { ok: false, error: explain(r.status, r.body, 'add the slash commands') };
    return { ok: true, names: r.body.map((c) => `/${c.name}`) };
  }

  // -------------------------------------------------------------------------
  // Setup check (admin → Integrations)
  // -------------------------------------------------------------------------
  async check() {
    const out = [];
    const add = (ok, label, detail = '') => out.push({ ok, label, detail });
    add(this.oauthReady, 'Connect Discord (OAuth2)', this.oauthReady ? `Redirect URL to add in the Developer Portal: ${this.redirectUri}` : 'Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET');
    add(this.interactionsReady, 'Slash commands', this.interactionsReady ? `Interactions endpoint URL: ${this.cfg.baseUrl}/api/discord/interactions` : 'Set DISCORD_PUBLIC_KEY (and DISCORD_CLIENT_ID)');
    if (!this.botReady) {
      add(false, 'Bot', 'Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID');
      return out;
    }
    const me = await this.api('GET', '/users/@me');
    if (me.status !== 200) { add(false, 'Bot token', explain(me.status, me.body, 'sign in')); return out; }
    add(true, 'Bot token', `Signed in as ${me.body.username}`);
    const guild = await this.api('GET', `/guilds/${this.d.guildId}`);
    if (guild.status !== 200) { add(false, 'Server', explain(guild.status, guild.body, 'see the server')); return out; }
    add(true, 'Server', guild.body.name);
    const roles = await this.api('GET', `/guilds/${this.d.guildId}/roles`);
    const botMember = await this.api('GET', `/guilds/${this.d.guildId}/members/${me.body.id}`);
    const list = roles.status === 200 && Array.isArray(roles.body) ? roles.body : [];
    const top = Math.max(0, ...list.filter((r) => botMember.body && (botMember.body.roles || []).includes(r.id)).map((r) => r.position));
    if (this.d.memberRoleId) {
      const role = list.find((r) => r.id === this.d.memberRoleId);
      if (!role) add(false, 'Member role', "DISCORD_MEMBER_ROLE_ID isn't a role in this server");
      else add(top > role.position, 'Member role', top > role.position ? `@${role.name} — the bot can give and take it` : `@${role.name} is above the bot's own role. In Server settings → Roles, drag the bot's role above @${role.name}`);
    } else {
      add(false, 'Member role', 'Optional: set DISCORD_MEMBER_ROLE_ID so members get a role (and lose it when their membership ends)');
    }
    // Permissions come from @everyone (same ID as the server) plus the bot's own roles.
    const botRoles = list.filter((r) => r.id === this.d.guildId || (botMember.body && (botMember.body.roles || []).includes(r.id)));
    const perms = botRoles.reduce((p, r) => p | BigInt(r.permissions || '0'), 0n);
    const needed = [['Create Invite', 1n], ['Manage Roles', 1n << 28n], ['View Channels', 1n << 10n], ['Send Messages', 1n << 11n], ['Embed Links', 1n << 14n]];
    if (this.d.kickOnExpire) needed.push(['Kick Members', 1n << 1n]);
    const missing = perms & 8n ? [] : needed.filter(([, bit]) => !(perms & bit)).map(([name]) => name);
    const ownRole = botRoles.filter((r) => r.id !== this.d.guildId).sort((a, b) => b.position - a.position)[0];
    add(!missing.length, 'Bot permissions', missing.length
      ? `Missing: ${missing.join(', ')}. Server settings → Roles → @${ownRole ? ownRole.name : 'the bot\'s role'} → Permissions`
      : needed.map(([name]) => name).join(', '));
    if (this.d.restockChannelId) {
      const ch = await this.api('GET', `/channels/${this.d.restockChannelId}`);
      add(ch.status === 200, 'Restock channel', ch.status === 200 ? `#${ch.body.name}` : explain(ch.status, ch.body, 'see that channel'));
    } else {
      add(false, 'Restock channel', 'Optional: set DISCORD_RESTOCK_CHANNEL_ID for announced restocks');
    }
    return out;
  }
}
