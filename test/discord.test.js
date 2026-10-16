// Discord: connecting an account (OAuth2), joining the members' server with
// the member role (and losing it), DM pings with a signed ⚡ Buy button,
// closed DMs, rate limits, slash commands (signed by Discord), and the
// admin's setup check.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, discordOpts, interactionKeys, makeMember, startApp, startFakeDiscord, waitFor } from './helpers.js';
import { commandDefinitions } from '../server/routes/discord.js';

let env;
let discord;
let keys;
before(async () => {
  discord = await startFakeDiscord();
  keys = interactionKeys();
  env = await startApp({ ...discordOpts(discord), discordPublicKey: keys.publicKey, adminUsernames: 'boss' });
});
after(async () => {
  await env.close();
  await discord.close();
});

/** Walk through "Connect Discord" as `c`, coming back from the fake Discord as `discordId`. */
async function connect(c, discordId, name = discordId) {
  discord.state.users[discordId] = discord.state.users[discordId] || { id: discordId, username: name };
  discord.state.nextUser = discordId;
  const start = await c.get('/auth/discord');
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location'));
  assert.equal(authorize.pathname, '/oauth2/authorize');
  assert.equal(authorize.searchParams.get('scope'), 'identify guilds.join');
  assert.equal(authorize.searchParams.get('redirect_uri'), `${env.url}/auth/discord/callback`);
  const consent = await fetch(authorize, { redirect: 'manual' });
  const cb = new URL(consent.headers.get('location'));
  const done = await c.get(cb.pathname + cb.search);
  return { done, cb };
}

async function slash(discordId, name, options = []) {
  const body = JSON.stringify({ type: 2, id: 'i1', token: 't', member: { user: { id: discordId } }, data: { name, options } });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${env.url}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': keys.sign(ts, body), 'x-signature-timestamp': ts }, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('connect Discord: only the account that started it, one Discord per account, and disconnect', async () => {
  const ash = await Client.signup(env.url, 'ash');
  const { done, cb } = await connect(ash, 'd-ash', 'ash_k');
  assert.match(done.headers.get('location'), /\/app\?discord=linked#discord/);
  let d = (await ash.get('/api/discord')).body;
  assert.equal(d.linked, true);
  assert.match(d.username, /ash_k/);
  assert.equal(d.inServer, false, 'not a member yet: not added to the server');
  assert.equal(discord.state.members.has('d-ash'), false);

  // The same callback can't be replayed (state is single use) or used by someone else.
  const misty = await Client.signup(env.url, 'misty');
  const replay = await misty.get(cb.pathname + cb.search);
  assert.match(replay.headers.get('location'), /discord=expired/);
  // Misty can't connect Ash's Discord account to her login.
  const { done: stolen } = await connect(misty, 'd-ash');
  assert.match(stolen.headers.get('location'), /discord=failed/);
  assert.match(decodeURIComponent(stolen.headers.get('location')), /already connected to another Mugibot account \(ash\)/);
  assert.equal((await misty.get('/api/discord')).body.linked, false);

  // Tokens are stored encrypted.
  const raw = env.app.db.get("SELECT enc FROM user_data WHERE user_id = :u AND kind = 'discord_oauth'", { u: ash.user.id }).enc;
  assert.doesNotMatch(raw, /at-d-ash|rt-d-ash/);

  await ash.post('/api/discord/unlink');
  d = (await ash.get('/api/discord')).body;
  assert.equal(d.linked, false);
  assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM user_data WHERE user_id = :u AND kind = 'discord_oauth'", { u: ash.user.id }).n, 0);
  assert.ok(discord.calls.some((x) => x.path === '/oauth2/token/revoke'), 'token revoked');
});

test('members join the server with the member role; it goes when the membership does; sweep fixes trials ending', async () => {
  const brock = await Client.signup(env.url, 'brock');
  makeMember(env, brock, 'active');
  await connect(brock, 'd-brock');
  assert.ok(discord.state.members.get('d-brock').has('role-member'), 'added with the role');
  const d = (await brock.get('/api/discord')).body;
  assert.equal(d.inServer, true);
  assert.equal(d.hasRole, true);

  // Already in the server without the role (joined from an invite): the role is added.
  discord.state.members.set('d-gary', new Set());
  const gary = await Client.signup(env.url, 'gary');
  env.app.repo.updateUser(gary.user.id, { plan: 'trial', trial_ends_at: Date.now() + 60 * 60 * 1000 });
  await connect(gary, 'd-gary');
  assert.ok(discord.state.members.get('d-gary').has('role-member'));

  // The trial runs out; the sweep takes the role away.
  env.app.repo.updateUser(gary.user.id, { trial_ends_at: Date.now() - 1000 });
  const fixed = await env.app.discord.sweep();
  assert.ok(fixed >= 1);
  assert.equal(discord.state.members.get('d-gary').has('role-member'), false);
  assert.equal(env.app.repo.userById(gary.user.id).discord_role, 0);

  // Suspended by an admin: role removed straight away.
  const boss = await Client.signup(env.url, 'boss');
  await boss.put(`/api/admin/users/${brock.user.id}`, { disabled: true });
  assert.equal(discord.state.members.get('d-brock').has('role-member'), false);
});

test('kick-on-expire: members are removed from the server when their membership ends', async () => {
  const strict = await startApp({ ...discordOpts(discord), discordKickOnExpire: true });
  try {
    const c = await Client.signup(strict.url, 'koga');
    strict.app.repo.updateUser(c.user.id, { plan: 'active' });
    discord.state.users['d-koga'] = { id: 'd-koga', username: 'koga' };
    discord.state.nextUser = 'd-koga';
    const start = await c.get('/auth/discord');
    const consent = await fetch(start.headers.get('location'), { redirect: 'manual' });
    const cb = new URL(consent.headers.get('location'));
    await c.get(cb.pathname + cb.search);
    assert.equal(discord.state.members.has('d-koga'), true);
    strict.app.repo.updateUser(c.user.id, { plan: 'canceled' });
    await strict.app.discord.sync(strict.app.repo.userById(c.user.id));
    assert.equal(discord.state.members.has('d-koga'), false, 'removed');
  } finally {
    await strict.close();
  }
});

test('restock DMs carry a signed ⚡ Buy button that goes straight to the store; tampered links just show the buy page', async () => {
  const erika = await Client.signup(env.url, 'erika');
  makeMember(env, erika);
  await connect(erika, 'd-erika');
  const it = (await erika.get('/api/items')).body.items[0];
  const row = env.app.db.get('SELECT * FROM items WHERE id = :id', { id: it.id });
  const before = discord.dmsTo('d-erika').length;
  await env.app.monitor.applyResult(row, { status: 'in_stock', price: 360 }, 'server');
  const dm = discord.dmsTo('d-erika').slice(before);
  assert.equal(dm.length, 1, 'one DM');
  const msg = dm[0].body;
  assert.match(msg.embeds[0].title, /In stock: Day UPC/);
  assert.match(msg.embeds[0].description, /Kmart · SKU 43818648 · \$360\.00/);
  const buttons = msg.components[0].components;
  assert.equal(buttons[0].label, '⚡ Buy');
  assert.match(msg.embeds[0].description, /Press ⚡ Buy to go straight to checkout/);
  assert.doesNotMatch(msg.embeds[0].description, /Quantity/);
  assert.equal(buttons[0].style, 5, 'a link button');
  assert.equal(buttons[1].url, it.url);

  // The link: logged in as Erika → a one-time code, straight to Kmart.
  const link = new URL(buttons[0].url);
  const go = await erika.get(link.pathname + link.search);
  assert.equal(go.status, 302);
  assert.match(go.headers.get('location'), /^https:\/\/www\.kmart\.com\.au\/product\/.*-43818648\/#mgb-go=[\w-]{20,}$/);
  // Tampered link or signature: no code, just the buy page with a button.
  const tampered = new URL(link);
  tampered.searchParams.set('qty', '9');
  const t = await erika.get(tampered.pathname + tampered.search);
  assert.equal(t.status, 200);
  assert.match(t.text, /id="b-go"/);
  // Someone else opening Erika's link gets nothing of hers.
  const other = await Client.signup(env.url, 'eavesdropper');
  makeMember(env, other);
  const o = await other.get(link.pathname + link.search);
  assert.equal(o.status, 200, 'the buy page, which finds nothing to buy');
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM go_codes WHERE user_id = :u', { u: other.user.id }).n, 0);

  // Erika turns DMs off: the next restock only lands in the feed.
  await erika.put('/api/alerts', { discordDm: false });
  await env.app.monitor.applyResult({ ...row, status: 'out_of_stock' }, { status: 'preorder' }, 'server');
  assert.equal(discord.dmsTo('d-erika').length, before + 1);
  assert.ok((await erika.get('/api/events')).body.events.some((e) => /Pre-order open: Day UPC/.test(e.message) || /Pre-order/.test(e.message)));
});

test('closed DMs are reported on the Discord tab; Discord rate limits are waited out', async () => {
  const blaine = await Client.signup(env.url, 'blaine');
  makeMember(env, blaine);
  await connect(blaine, 'd-blaine');
  discord.state.dmsClosed.add('d-blaine');
  const r = await blaine.post('/api/discord/test');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Allow DMs from server members/);
  assert.match((await blaine.get('/api/discord')).body.error, /DMs/);
  discord.state.dmsClosed.delete('d-blaine');
  discord.state.rateLimitNext = 2;
  const ok = await blaine.post('/api/discord/test');
  assert.equal(ok.status, 200, 'retried after Discord said to slow down');
  assert.equal((await blaine.get('/api/discord')).body.error, '', 'cleared once a DM gets through');
});

test('slash commands: only signed requests; /watch, /watchlist, /buy, /unwatch, /status for the connected account', async () => {
  const unsigned = await fetch(`${env.url}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":1}' });
  assert.equal(unsigned.status, 401);
  const bodyText = '{"type":1}';
  const ts = String(Math.floor(Date.now() / 1000));
  const forged = await fetch(`${env.url}/api/discord/interactions`, { method: 'POST', headers: { 'x-signature-ed25519': keys.sign(ts, '{"type":2}'), 'x-signature-timestamp': ts }, body: bodyText });
  assert.equal(forged.status, 401, 'signature for a different body');
  const ping = await fetch(`${env.url}/api/discord/interactions`, { method: 'POST', headers: { 'x-signature-ed25519': keys.sign(ts, bodyText), 'x-signature-timestamp': ts }, body: bodyText });
  assert.deepEqual(await ping.json(), { type: 1 }, 'PONG');

  const stranger = await slash('d-nobody', 'watchlist');
  assert.match(stranger.body.data.content, /isn't connected to a Mugibot account/);
  assert.equal(stranger.body.data.flags, 64, 'private reply');

  const sab = await Client.signup(env.url, 'sabrina');
  makeMember(env, sab);
  await connect(sab, 'd-sabrina');
  let r = await slash('d-sabrina', 'watch', [{ name: 'sku', value: '6012345' }, { name: 'store', value: 'bigw' }, { name: 'max_price', value: 380 }]);
  assert.match(r.body.data.content, /Watching \*\*6012345\*\* — BIG W · SKU 6012345\. I'll DM you/);
  assert.match(r.body.data.content, /Not listed yet/);
  const item = (await sab.get('/api/items')).body.items.find((x) => x.sku === '6012345');
  assert.equal(item.store, 'bigw');
  assert.equal(item.maxPrice, 380);
  r = await slash('d-sabrina', 'watch', [{ name: 'sku', value: 'https://www.ebgames.com.au/product/toys-and-collectibles/312345-one-piece-op-18' }]);
  assert.match(r.body.data.content, /EB Games · SKU 312345/);
  r = await slash('d-sabrina', 'watch', [{ name: 'sku', value: '12345678' }]);
  assert.match(r.body.data.content, /Which store\?/);

  r = await slash('d-sabrina', 'watchlist');
  const desc = r.body.data.embeds[0].description;
  assert.match(desc, /Day UPC.*Kmart.*43818648/);
  assert.match(desc, /\[⚡ Buy\]\(http:\/\/127\.0\.0\.1:\d+\/buy\/itm_[\w-]+\?qty=1&t=/);

  r = await slash('d-sabrina', 'buy', [{ name: 'sku', value: '43818648' }]);
  assert.equal(r.body.data.components[0].components[0].label, '⚡ Buy');
  assert.match(r.body.data.embeds[0].description, /straight to checkout with it in your bag/);

  r = await slash('d-sabrina', 'unwatch', [{ name: 'sku', value: '312345' }]);
  assert.match(r.body.data.content, /Stopped watching/);
  assert.ok(!(await sab.get('/api/items')).body.items.some((x) => x.sku === '312345'));

  r = await slash('d-sabrina', 'status');
  const fields = Object.fromEntries(r.body.data.embeds[0].fields.map((f) => [f.name, f.value]));
  assert.equal(fields.Membership, 'Free access');
  assert.match(fields["Members' server"], /In the server/);

  r = await slash('d-sabrina', 'restock', [{ name: 'store', value: 'kmart' }, { name: 'sku', value: '43818648' }]);
  assert.match(r.body.data.content, /Only admins/);
});

test('/restock (admin) and the admin restock ping: everyone watching gets a DM, and the channel gets a post with the role ping', async () => {
  const boss = await Client.signup(env.url, 'boss2', {});
  env.app.repo.updateUser(boss.user.id, { role: 'admin' });
  await connect(boss, 'd-boss');
  const watcher = await Client.signup(env.url, 'watcher');
  makeMember(env, watcher);
  await connect(watcher, 'd-watcher');
  const before = discord.dmsTo('d-watcher').length;
  const posts = discord.channelPosts('chan-restocks').length;
  const r = await slash('d-boss', 'restock', [{ name: 'store', value: 'kmart' }, { name: 'sku', value: '43818587' }, { name: 'note', value: 'online only, limit 2' }]);
  assert.match(r.body.data.content, /Pinging \d+ members? watching Kmart SKU 43818587/);
  await waitFor(() => discord.dmsTo("d-watcher").length > before, { timeout: 5000, message: "the restock DM" }); // the pings go out after the reply
  const dm = discord.dmsTo('d-watcher').slice(before);
  assert.equal(dm.length, 1);
  assert.match(dm[0].body.embeds[0].title, /In stock: Elite Trainer Box/);
  assert.match(dm[0].body.embeds[0].description, /online only, limit 2/);
  assert.match(dm[0].body.embeds[0].description, /Reported by an admin/);
  await waitFor(() => discord.channelPosts("chan-restocks").length > posts, { timeout: 5000, message: "the channel post" });
  const post = discord.channelPosts("chan-restocks").slice(posts);
  assert.equal(post.length, 1);
  assert.equal(post[0].body.content, '<@&role-restock-pings>');
  assert.deepEqual(post[0].body.allowed_mentions.roles, ['role-restock-pings']);
  assert.match(post[0].body.components[0].components[0].url, /\/buy\?store=kmart&sku=43818587/);
});

test('admin setup check reads the bot, server, role order and channel', async () => {
  const boss = new Client(env.url);
  await boss.post('/api/auth/login', { username: 'boss2', password: 'correct horse battery staple' });
  let r = await boss.post('/api/admin/integrations/discord-check');
  const byLabel = Object.fromEntries(r.body.checks.map((c) => [c.label, c]));
  assert.equal(byLabel['Bot token'].ok, true);
  assert.equal(byLabel.Server.detail, 'Mugibot Members');
  assert.equal(byLabel['Member role'].ok, true);
  assert.equal(byLabel['Restock channel'].ok, true);
  assert.equal(byLabel['Bot permissions'].ok, true, byLabel['Bot permissions'].detail);
  const saved = discord.state.roles;
  discord.state.roles = saved.map((x) => (x.id === 'role-bot' ? { ...x, permissions: String(1n << 28n | 1n << 10n | 1n << 11n | 1n << 14n) } : x));
  r = await boss.post('/api/admin/integrations/discord-check');
  const perms = r.body.checks.find((c) => c.label === 'Bot permissions');
  assert.equal(perms.ok, false);
  assert.match(perms.detail, /^Missing: Create Invite\. Server settings → Roles → @Mugibot → Permissions/);
  discord.state.roles = [{ id: 'role-member', name: 'Member', position: 9 }, { id: 'role-bot', name: 'Mugibot', position: 2 }];
  r = await boss.post('/api/admin/integrations/discord-check');
  const role = r.body.checks.find((c) => c.label === 'Member role');
  assert.equal(role.ok, false);
  assert.match(role.detail, /drag the bot's role above @Member/);
  assert.equal((await boss.post('/api/admin/integrations/discord-post')).status, 200);
});

test('admin console registers the slash commands (no command line needed)', async () => {
  const boss = new Client(env.url);
  await boss.post('/api/auth/login', { username: 'boss2', password: 'correct horse battery staple' });
  const r = await boss.post('/api/admin/integrations/discord-commands');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.commands, ['/watch', '/unwatch', '/watchlist', '/buy', '/status', '/restock', '/monitor', '/restocks']);
  const member = new Client(env.url);
  await member.post('/api/auth/signup', { username: 'not-an-admin', password: 'correct horse battery staple', acceptTerms: true });
  assert.equal((await member.post('/api/admin/integrations/discord-commands')).status, 404);
});

test('slash command definitions: store choices from the retailers, /restock admin-only', () => {
  const defs = commandDefinitions(env.app.retailers);
  const names = defs.map((d) => d.name);
  assert.deepEqual(names, ['watch', 'unwatch', 'watchlist', 'buy', 'status', 'restock', 'monitor', 'restocks']);
  const store = defs[0].options.find((o) => o.name === 'store');
  assert.ok(store.choices.some((c) => c.value === 'kmart' && c.name === 'Kmart'));
  assert.ok(store.choices.some((c) => c.value === 'bigw'));
  assert.ok(store.choices.length <= 25);
  assert.equal(defs.find((d) => d.name === 'restock').default_member_permissions, '32');
});
