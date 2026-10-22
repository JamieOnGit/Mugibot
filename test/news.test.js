// Release news (server/news.js, docs/NEWS.md): admins' own and the news feeds' (RSS and Atom) —
// what's being released, when and at which stores — posted in the Discord server's #news, on the
// dashboard, and in the morning's "📅 Coming up". The feeds are fixtures on a server on this
// computer: tests never read a real website.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { Client, discordOpts, makeMember, startApp, startFakeDiscord } from './helpers.js';
import { parseFeed } from '../server/monitor/rss.js';
import { DEFAULT_FEEDS, categoryOf, findDate, hypeLists, isReleaseNews, isNewsChannel, sydneyMidnight, sydneyParts } from '../server/news.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let env;
let discord;
let site;
let boss;
let ash;
let misty;

// --- The news websites: feeds served with an ETag (304 when it hasn't changed) -----------------
function startSite() {
  const state = { files: {}, requests: [] };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    state.requests.push({ path, ua: req.headers['user-agent'] || '', inm: req.headers['if-none-match'] || '', ims: req.headers['if-modified-since'] || '' });
    const f = state.files[path];
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
    if (f.status && f.status !== 200) { res.writeHead(f.status, { 'content-type': 'text/plain' }); res.end('Something went wrong'); return; }
    const etag = `"${crypto.createHash('sha1').update(f.body).digest('hex').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); res.end(); return; }
    res.writeHead(200, { 'content-type': f.type || 'application/rss+xml; charset=utf-8', etag, 'last-modified': new Date().toUTCString() });
    res.end(f.body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    serve(path, body, extra = {}) { state.files[path] = { body, ...extra }; },
    asked: (path) => state.requests.filter((r) => r.path === path),
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  })));
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** An RSS 2.0 feed: items { guid, title, link, description, at (ms) }. */
const rss = (items, title = 'Card News') => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${esc(title)}</title><link>https://cards.example/</link>
${items.map((i) => `<item><title>${esc(i.title)}</title><link>${esc(i.link)}</link>${i.guid ? `<guid isPermaLink="false">${esc(i.guid)}</guid>` : ''}
<pubDate>${new Date(i.at ?? Date.now() - HOUR).toUTCString()}</pubDate><description>${esc(i.description || '')}</description></item>`).join('\n')}
</channel></rss>`;
/** An Atom feed: entries { id, title, link, summary, at }. */
const atom = (entries) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Console News</title><link href="https://consoles.example/"/>
${entries.map((e) => `<entry><title>${esc(e.title)}</title><link rel="alternate" href="${esc(e.link)}"/><id>${esc(e.id)}</id>
<updated>${new Date(e.at ?? Date.now() - HOUR).toISOString()}</updated><summary type="html">${esc(`<p>${e.summary || ''}</p>`)}</summary></entry>`).join('\n')}
</feed>`;

const news = () => env.app.news;
const newsChannel = () => discord.state.channels.find((c) => c.name === 'news');
const newsPosts = () => (newsChannel() ? discord.channelPosts(newsChannel().id) : []);
const titled = (re) => newsPosts().filter((m) => m.body.embeds && re.test(m.body.embeds[0].title));
const feedRow = (id) => news().data.feedRow(id);
/** A day in Sydney `days` from now, as the date box sends it ('YYYY-MM-DD'). */
const sydneyDay = (days) => {
  const p = sydneyParts(Date.now());
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return d.toISOString().slice(0, 10);
};
/** That time of day in Sydney, on the day `days` from now. */
const sydneyAt = (days, hour, minute) => {
  const [y, m, d] = sydneyDay(days).split('-').map(Number);
  const want = hour * 60 + minute;
  const t = sydneyMidnight(y, m, d) + want * MIN;
  const p = sydneyParts(t);
  return t - ((p.hour * 60 + p.minute) - want) * MIN; // (a day the clocks change on)
};

before(async () => {
  discord = await startFakeDiscord();
  site = await startSite();
  env = await startApp({ allowPrivateHosts: true, adminUsernames: 'boss', hostGapSeconds: 0, ...discordOpts(discord) });
  boss = await Client.signup(env.url, 'boss');
  ash = await Client.signup(env.url, 'ash');
  misty = await Client.signup(env.url, 'misty');
  makeMember(env, ash);
});
after(async () => {
  await env.close();
  await site.close();
  await discord.close();
});

test('📰 parsing: RSS 2.0 and Atom — CDATA, entities (once or twice over), Atom\'s <link href>, guid and id, relative links, a feed cut short; a web page isn\'t a feed', () => {
  const r = parseFeed(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Card News &amp; More</title>
  <link>https://cards.example/</link>
  <atom:link href="https://cards.example/feed" rel="self" type="application/rss+xml"/>
  <!-- <item><title>Not an item</title></item> -->
  <item>
    <title><![CDATA[Pokémon TCG: "Ascended Heroes" <b>pre-orders</b> & more]]></title>
    <link>https://cards.example/ascended-heroes?a=1&amp;b=2</link>
    <guid isPermaLink="false">post-101</guid>
    <pubDate>Thu, 22 Oct 2026 05:02:42 +0000</pubDate>
    <description>&lt;p&gt;Pre-orders open at EB Games &amp;amp; BIG W on 14 November.&lt;/p&gt;</description>
  </item>
  <item>
    <title>Mario &#038; Luigi&#8217;s day &amp;amp; night</title>
    <link>/relative/path</link>
    <guid>https://cards.example/p/2</guid>
    <content:encoded><![CDATA[<p>Body with </item> inside CDATA</p>]]></content:encoded>
    <dc:date>2026-10-21T10:00:00Z</dc:date>
  </item>
  <item>
    <title>Cut short`, 'https://cards.example/feed');
  assert.equal(r.kind, 'rss');
  assert.equal(r.title, 'Card News & More');
  assert.equal(r.link, 'https://cards.example/');
  assert.equal(r.entries.length, 2, 'the comment isn\'t an item, and the one cut short is left out');
  const [a, b] = r.entries;
  assert.equal(a.title, 'Pokémon TCG: "Ascended Heroes" pre-orders & more');
  assert.equal(a.link, 'https://cards.example/ascended-heroes?a=1&b=2');
  assert.equal(a.id, 'post-101');
  assert.equal(a.published, Date.parse('2026-10-22T05:02:42Z'));
  assert.equal(a.summary, 'Pre-orders open at EB Games & BIG W on 14 November.');
  assert.equal(b.title, 'Mario & Luigi’s day & night');
  assert.equal(b.link, 'https://cards.example/relative/path');
  // (The "</item>" in its CDATA didn't end it: its date comes after. It's HTML, so a tag, left out.)
  assert.equal(b.published, Date.parse('2026-10-21T10:00:00Z'));
  assert.equal(b.summary, 'Body with inside CDATA');

  const f = parseFeed(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Console News</title>
  <link href="https://consoles.example/" rel="alternate"/>
  <link href="https://consoles.example/atom.xml" rel="self"/>
  <entry>
    <title type="html">Switch 2 restock &lt;em&gt;coming&lt;/em&gt; to JB Hi-Fi</title>
    <link rel="replies" href="https://consoles.example/1#comments"/>
    <link rel="alternate" type="text/html" href="https://consoles.example/switch-2-restock"/>
    <id>tag:consoles.example,2026:1</id>
    <updated>2026-10-22T01:00:00Z</updated>
    <summary type="html">&lt;p&gt;Back in stock on 30/10/2026.&lt;/p&gt;</summary>
  </entry>
  <entry>
    <title>Second</title>
    <link href="/second"/>
    <id>tag:2</id>
    <published>2026-10-21T01:00:00Z</published>
    <content type="html"><![CDATA[<p>Content &amp; more</p>]]></content>
  </entry>
</feed>`, 'https://consoles.example/atom.xml');
  assert.equal(f.kind, 'atom');
  assert.equal(f.title, 'Console News');
  assert.equal(f.link, 'https://consoles.example/');
  assert.deepEqual(f.entries[0], {
    id: 'tag:consoles.example,2026:1', title: 'Switch 2 restock coming to JB Hi-Fi', link: 'https://consoles.example/switch-2-restock',
    summary: 'Back in stock on 30/10/2026.', published: Date.parse('2026-10-22T01:00:00Z'),
  });
  assert.equal(f.entries[1].link, 'https://consoles.example/second');
  assert.equal(f.entries[1].summary, 'Content & more');

  assert.equal(parseFeed('<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>'), null);
  assert.equal(parseFeed(''), null);
});

test('📰 what counts: a hyped product (or the feed\'s own words) and a title that reads like a release — not digital things, not trailers or price drops', () => {
  const yes = (title, summary = '', words = '') => assert.equal(isReleaseNews({ title, summary }, hypeLists(words)), true, title);
  const no = (title, summary = '', words = '') => assert.equal(isReleaseNews({ title, summary }, hypeLists(words)), false, title);
  yes('Pokémon TCG: Ascended Heroes pre-orders open 14 November');
  yes('Pokemon TCG: Ascended Heroes Preorders Now Live');
  yes('Pre-orders open for the Ascended Heroes Elite Trainer Box', 'The next Pokémon TCG set.');
  yes('Switch 2 restock coming to EB Games this Friday');
  yes('Magic: The Gathering Final Fantasy reprint announced');
  yes('One Piece OP-15 release date confirmed');
  yes('Riftbound Origins launches in Australia');
  yes('PS5 Pro back in stock at JB Hi-Fi');
  yes('The LEGO PlayStation set is up for pre-order');
  no('Pokémon TCG: Ascended Heroes reviewed');
  no('Cyberpunk 2 release date announced', 'A new game.');
  no('Pokémon TCG Pocket expansion launches next week');
  no('Xbox drops a new trailer for Fable');
  no('PS5 Pro drops to its lowest price ever');
  no('New patch notes for Nintendo Switch Sports', 'The update launches today and is out now.');
  // A console's name alone: only when it's the console itself or its stock — not one of its games.
  yes('Nintendo Switch 2 pre-orders open in Australia');
  yes('Xbox Series X restock coming to EB Games');
  yes('Nintendo Switch 2 Mario Kart World bundle restock at Big W');
  yes('PlayStation 5 Pro Limited Edition console pre-orders open');
  no('Mario Kart World launches on Nintendo Switch 2');
  no('The Legend of Zelda pre-orders open for Switch 2');
  no('Halo arrives on PS5 next month', "Xbox's shooter comes to PlayStation.");
  yes("GTA 6 Collector's Edition pre-orders open at EB Games", 'On PS5 and Xbox Series X.');
  // A feed's own words: more products, and "-word" to leave some out.
  no('Funko Pop Marvel wave pre-orders open');
  yes('Funko Pop Marvel wave pre-orders open', '', 'funko, labubu');
  yes('Pokémon plush pre-orders open');
  no('Pokémon plush pre-orders open', '', '-plush');

  assert.equal(categoryOf('Pokémon TCG Elite Trainer Box pre-orders'), 'tcg');
  assert.equal(categoryOf('One Piece booster box release date'), 'tcg');
  assert.equal(categoryOf('Nintendo Switch 2 Mario Kart bundle restock'), 'console');
  assert.equal(categoryOf('LEGO Pokémon Pikachu set pre-orders'), 'collectible');
  assert.equal(categoryOf("GTA 6 Collector's Edition pre-orders"), 'collectible');
  assert.equal(categoryOf('One Piece film release date'), 'other');
});

test('📰 dates (Australian order, midnight in Sydney) and the stores it names', () => {
  const base = Date.parse('2026-10-22T02:00:00Z');
  const nov14 = Date.UTC(2026, 10, 13, 13); // midnight on the 14th in Sydney (AEDT, +11)
  assert.equal(sydneyMidnight(2026, 11, 14), nov14);
  assert.equal(sydneyMidnight(2026, 7, 1), Date.UTC(2026, 5, 30, 14), 'AEST (+10) in winter');
  for (const [text, written] of [['Pre-orders open November 14', 'November 14'], ['Out on 14 Nov 2026 at 10am', '14 Nov 2026'], ['Releases 14/11/2026', '14/11/2026'],
    ['Due 2026-11-14', '2026-11-14'], ['Launching Saturday, November 14th, 2026', 'November 14th, 2026'], ['In stores on the 14th of November', '14th of November']]) {
    assert.deepEqual(findDate(text, base), { at: nov14, text: written }, text);
  }
  assert.equal(findDate('Releasing January 5', base).at, sydneyMidnight(2027, 1, 5), 'no year: the next one');
  assert.equal(findDate('Released October 1', base).at, sydneyMidnight(2026, 10, 1), 'a few weeks back is this year');
  for (const text of ['Nintendo Switch 2 October update launches', 'Coming November 2026', 'you may 5 times', 'Out 31 February', 'Top 10 May releases', '13/25/2026']) {
    assert.equal(findDate(text, base), null, text);
  }

  const s = (text) => news().storesIn(text);
  assert.deepEqual(s('Pre-orders at EB Games, BIG W and Target — JB Hi-Fi too'), ['ebgames', 'bigw', 'target', 'jbhifi']);
  assert.deepEqual(s('Sales hit their Target for the year'), [], 'Target the word isn\'t Target the store');
  assert.deepEqual(s('At Pokémon Center and Toys"R"Us, then Kmart'), ['pokemoncenter', 'toysrus', 'kmart']);
  assert.deepEqual(s('Available at Myer, Harvey Norman and Amazon'), ['myer', 'harveynorman', 'amazon']);
  assert.deepEqual(s('Zing Pop Culture exclusive'), ['zing']);
  assert.ok(news().stores().some((x) => x.id === 'costco'), 'the other big Australian stores, by name');
  assert.ok(!news().stores().some((x) => x.id === 'shoplink' || /^demo-/.test(x.id)), 'not Shop checkout links or the dummy store');

  assert.equal(isNewsChannel({ type: 0, name: 'news' }), true);
  assert.equal(isNewsChannel({ type: 5, name: '📰┃news' }), true, 'an announcement channel, with an emoji');
  assert.equal(isNewsChannel({ type: 0, name: 'news-and-chat' }), false);
  assert.equal(isNewsChannel({ type: 4, name: 'news' }), false, 'a category isn\'t a channel');
});

test('📰 who can do what: members read /api/news; only admins write (and the dashboard\'s header is needed)', async () => {
  assert.equal((await new Client(env.url).get('/api/news')).status, 401);
  assert.equal((await misty.get('/api/news')).status, 402, 'needs a membership');
  assert.equal((await ash.get('/api/news')).status, 200);
  for (const [method, path] of [['GET', '/api/admin/news'], ['POST', '/api/admin/news'], ['PUT', '/api/admin/news/x'], ['DELETE', '/api/admin/news/x'], ['POST', '/api/admin/news/x/post'],
    ['POST', '/api/admin/news/feeds'], ['PUT', '/api/admin/news/feeds/x'], ['DELETE', '/api/admin/news/feeds/x'], ['POST', '/api/admin/news/feeds/check'],
    ['POST', '/api/admin/news/channel'], ['POST', '/api/admin/news/digest']]) {
    assert.equal((await ash.call(method, path, method === 'GET' ? undefined : { title: 'Pokémon pre-orders', url: `${site.url}/x.xml` })).status, 404, `${method} ${path}`);
  }
  assert.equal((await boss.post('/api/admin/news', { title: 'Pokémon pre-orders' }, { 'x-mugibot': '' })).status, 403, 'cross-site');
  // What admins send is checked.
  for (const body of [{ title: 'x' }, { title: 'Pokémon pre-orders', url: 'javascript:alert(1)' }, { title: 'Pokémon pre-orders', releaseAt: '1999-01-01' },
    { title: 'Pokémon pre-orders', category: 'shoes' }]) {
    assert.equal((await boss.post('/api/admin/news', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await boss.post('/api/admin/news/feeds', { url: 'not a link' })).status, 400);
});

test('📰 the default feeds are there, switched on — admins switch them off (none is read in tests)', async () => {
  const r = await boss.get('/api/admin/news');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.feeds.map((f) => f.url).sort(), DEFAULT_FEEDS.map((f) => f.url).sort());
  assert.ok(r.body.feeds.every((f) => f.enabled && !f.lastFetchAt));
  assert.equal(r.body.running, false, 'the loop is off in tests');
  for (const f of r.body.feeds) {
    const off = await boss.put(`/api/admin/news/feeds/${f.id}`, { enabled: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.body.feed.enabled, false);
  }
  // Off in tests unless started on purpose (like the monitor), and stopped again.
  news().start();
  assert.equal(news().running, false);
  news().start({ force: true });
  assert.equal(news().running, true);
  news().stop();
  assert.equal(news().running, false);
});

test('📰 #news: "Set up #news" finds it by name or makes it (under "Mugibot alerts"), with a role to ping; "Set up store channels" sets it up too', async () => {
  discord.state.canManageChannels = false;
  let r = await boss.post('/api/admin/news/channel', {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Manage Channels permission/);
  discord.state.canManageChannels = true;
  assert.equal((await boss.post('/api/admin/news/channel', { roleId: 'everyone' })).status, 400, 'a role ID, not a name');
  r = await boss.post('/api/admin/news/channel', {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.channel.name, 'news');
  assert.equal(r.body.channel.made, true);
  const ch = newsChannel();
  const category = discord.state.channels.find((c) => c.type === 4 && c.name === 'Mugibot alerts');
  assert.equal(ch.parent_id, category.id);
  assert.match(ch.topic, /Release news/);
  r = await boss.post('/api/admin/news/channel', { roleId: '123456789012345678' });
  assert.deepEqual([r.body.channel.made, r.body.channel.id, r.body.roleId], [false, ch.id, '123456789012345678'], 'found by name, not made twice');
  assert.deepEqual(r.body.channel, { name: 'news', id: ch.id, made: false });
  assert.deepEqual(env.app.repo.getSetting('newsChannel'), { channelId: ch.id, roleId: '123456789012345678' });
  // Its posts ping that role — and only it.
  r = await boss.post('/api/admin/news', { title: 'Steam Deck OLED restock at JB Hi-Fi', post: true });
  assert.equal(r.body.posted, true, r.body.postError);
  const pinged = titled(/Steam Deck OLED/).at(-1).body;
  assert.equal(pinged.content, '<@&123456789012345678>');
  assert.deepEqual(pinged.allowed_mentions, { parse: [], roles: ['123456789012345678'], users: [] });
  await boss.del(`/api/admin/news/${r.body.item.id}`);
  // The store channels' set-up: the same #news (found by name), its role kept.
  r = await boss.post('/api/monitor/routes/setup', {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.channels.at(-1).name, 'news');
  assert.equal(r.body.channels.at(-1).id, ch.id);
  assert.equal(discord.state.channels.filter((c) => c.name === 'news').length, 1);
  assert.deepEqual(env.app.repo.getSetting('newsChannel'), { channelId: ch.id, roleId: '123456789012345678' });
  r = await boss.post('/api/admin/news/channel', {});
  assert.equal(r.body.roleId, '123456789012345678', 'no role sent: the one it had');
  r = await boss.post('/api/admin/news/channel', { roleId: '' });
  assert.deepEqual(env.app.repo.getSetting('newsChannel'), { channelId: ch.id, roleId: '' }, 'an empty one: pings no one');
});

test('📰 an admin\'s news: added (and posted in #news when asked), on the dashboard, edited, posted again, deleted', async () => {
  const day = sydneyDay(3);
  let r = await boss.post('/api/admin/news', {
    title: 'Pokémon TCG: Ascended Heroes — pre-orders', url: 'https://cards.example/ascended-heroes', releaseAt: day, stores: ['ebgames', 'bigw', 'nowhere'],
    summary: 'Elite Trainer Box and booster bundles, limit 2.', post: true,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.posted, true, r.body.postError);
  const item = r.body.item;
  const [y, m, d] = day.split('-').map(Number);
  assert.equal(item.releaseAt, sydneyMidnight(y, m, d));
  assert.deepEqual(item.stores, ['ebgames', 'bigw'], 'only stores it knows');
  assert.equal(item.category, 'tcg', 'guessed from the title');
  assert.equal(item.source, 'admin');
  // The post: its title, link, date, stores — and nobody pinged.
  const posts = titled(/Ascended Heroes/);
  assert.equal(posts.length, 1);
  const msg = posts[0].body;
  const short = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short' }).format(new Date(item.releaseAt)).replace(/,/g, '');
  assert.equal(msg.embeds[0].title, `📰 Pokémon TCG: Ascended Heroes — pre-orders ${short} at EB Games, BIG W`);
  assert.equal(msg.embeds[0].url, 'https://cards.example/ascended-heroes');
  assert.deepEqual(msg.embeds[0].fields.map((f) => f.name), ['📅 Release', '🏬 Stores', 'Category', 'Source']);
  assert.equal(msg.embeds[0].fields[1].value, 'EB Games, BIG W');
  assert.match(msg.embeds[0].description, /limit 2/);
  assert.deepEqual(msg.allowed_mentions.parse, []);
  assert.equal(msg.content, undefined);
  assert.equal(env.app.news.data.item(item.id).postedChannel, newsChannel().id);

  // Members: coming up, with the stores' names.
  r = await ash.get('/api/news');
  const up = r.body.upcoming.find((x) => x.id === item.id);
  assert.ok(up, 'coming up');
  assert.deepEqual(up.stores, [{ id: 'ebgames', name: 'EB Games' }, { id: 'bigw', name: 'BIG W' }]);
  assert.equal(up.createdBy, undefined, 'members don\'t see who added it');
  assert.equal(r.body.categories.tcg, 'Trading cards');

  // Edited (fields not sent stay as they were), posted again, deleted.
  r = await boss.put(`/api/admin/news/${item.id}`, { title: 'Pokémon TCG: Ascended Heroes — pre-orders open', stores: ['jbhifi'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.item.title, r.body.item.stores, r.body.item.releaseAt, r.body.item.url], ['Pokémon TCG: Ascended Heroes — pre-orders open', ['jbhifi'], item.releaseAt, item.url]);
  r = await boss.post(`/api/admin/news/${item.id}/post`, {});
  assert.equal(r.status, 200, r.text);
  assert.match(titled(/Ascended Heroes/).at(-1).body.embeds[0].title, /pre-orders open \d+ \w+ at JB Hi-Fi$/);
  // "📅 Coming up" now, whatever the time.
  r = await boss.post('/api/admin/news/digest', {});
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body.count >= 1);
  assert.match(titled(/^📅 Coming up$/).at(-1).body.embeds[0].description, /Ascended Heroes — pre-orders open\]\(https:\/\/cards\.example\/ascended-heroes\) · JB Hi-Fi/);
  r = await boss.put(`/api/admin/news/${item.id}`, { releaseAt: null });
  assert.equal(r.body.item.releaseAt, null, 'the date taken off');
  assert.equal((await boss.del(`/api/admin/news/${item.id}`)).status, 200);
  assert.equal((await boss.del(`/api/admin/news/${item.id}`)).status, 404);
  assert.equal((await boss.post(`/api/admin/news/${item.id}/post`, {})).status, 404);
  assert.ok(!(await ash.get('/api/news')).body.recent.some((x) => x.id === item.id));
  const audit = env.app.repo.listAudit(50).map((a) => a.action);
  for (const a of ['news-add', 'news-post', 'news-edit', 'news-remove', 'news-channel-setup', 'news-digest']) assert.ok(audit.includes(a), a);
});

test('📰 a feed: its first read sets the scene (kept, not posted); what\'s new after it is posted — once; read as Mugibot, conditionally (304: nothing new)', async () => {
  const items = [
    { guid: 'a1', title: 'Pokémon TCG: Mega Evolution pre-orders open November 14 at EB Games', link: 'https://cards.example/a1', description: 'Booster boxes and ETBs.' },
    { guid: 'a2', title: 'One Piece OP-14 release date confirmed', link: 'https://cards.example/a2', description: 'Out 5 December at Kmart and Target stores.' },
    { guid: 'a3', title: 'Our favourite card sleeves of the year', link: 'https://cards.example/a3', description: 'Not news about a release.' },
  ];
  site.serve('/tcg.xml', rss(items));
  let r = await boss.post('/api/admin/news/feeds', { url: `${site.url}/tcg.xml`, name: 'Card News' });
  assert.equal(r.status, 200, r.text);
  const feed = r.body.feed;
  assert.deepEqual([r.body.result.ok, r.body.result.entries, r.body.result.matched, r.body.result.added, r.body.result.posted, r.body.result.baseline], [true, 3, 2, 2, 0, true]);
  assert.match(r.body.feeds.find((f) => f.id === feed.id).lastResult, /first read: kept, not posted/);
  assert.equal(r.body.feeds.find((f) => f.id === feed.id).found, 2);
  assert.equal(titled(/Mega Evolution|OP-14/).length, 0, 'the backlog isn\'t posted');
  assert.equal((await boss.post('/api/admin/news/feeds', { url: `${site.url}/tcg.xml` })).status, 400, 'on the list already');
  // Read honestly, as Mugibot.
  assert.match(site.asked('/tcg.xml')[0].ua, /^Mugibot\/1\.0 /);
  // On the dashboard: its date and stores read out of it.
  const op14 = (await ash.get('/api/news')).body.recent.find((x) => x.url === 'https://cards.example/a2');
  assert.ok(op14);
  assert.deepEqual(op14.stores.map((s) => s.id), ['kmart', 'target']);
  assert.equal(op14.releaseText, '5 December');
  assert.equal(op14.category, 'tcg');
  assert.equal(op14.sourceName, 'Card News');

  // Nothing changed: the website says so (304), and nothing happens.
  r = await boss.post('/api/admin/news/feeds/check', { id: feed.id });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.results[0].notModified, true);
  const asked = site.asked('/tcg.xml').at(-1);
  assert.ok(asked.inm && asked.ims, 'asked with If-None-Match and If-Modified-Since');
  assert.match(feedRow(feed.id).last_result, /304/);

  // Something new (and something that isn't release news, and an entry published days ago).
  site.serve('/tcg.xml', rss([
    { guid: 'a4', title: 'Lorcana: Winterspell restock coming to BIG W @everyone', link: 'https://cards.example/a4', description: 'In stores 20/11/2026.' },
    { guid: 'a5', title: 'Meet the artists behind the cards', link: 'https://cards.example/a5' },
    { guid: 'a6', title: 'Dragon Ball Fusion World set launches', link: 'https://cards.example/a6', at: Date.now() - 5 * DAY },
    ...items,
  ]));
  r = await boss.post('/api/admin/news/feeds/check', { id: feed.id });
  assert.deepEqual([r.body.results[0].added, r.body.results[0].posted], [2, 1], 'the old one is kept, not posted');
  const post = titled(/Winterspell/);
  assert.equal(post.length, 1);
  const e = post[0].body.embeds[0];
  assert.equal(e.title, '📰 Lorcana: Winterspell restock coming to BIG W @\u200beveryone — 20 Nov', 'the date added, BIG W said already — and @everyone defused');
  assert.equal(e.url, 'https://cards.example/a4');
  assert.deepEqual(post[0].body.allowed_mentions.parse, [], 'never pings anyone');
  assert.equal(e.fields.find((f) => f.name === 'Source').value, 'Card News');
  assert.equal(titled(/Fusion World/).length, 0);
  // Read again: already news — not again.
  site.serve('/tcg.xml', `${site.state.files['/tcg.xml'].body}\n`);
  r = await boss.post('/api/admin/news/feeds/check', { id: feed.id });
  assert.deepEqual([r.body.results[0].notModified, r.body.results[0].matched, r.body.results[0].added], [false, 4, 0]);
  assert.equal(titled(/Winterspell/).length, 1);
});

test('📰 an Atom feed with its own words; a story another feed brought already isn\'t news again; new words set the scene again', async () => {
  site.serve('/consoles.atom', atom([
    { id: 'tag:c1', title: 'Funko Pop! Marvel wave pre-orders open', link: 'https://consoles.example/c1', summary: 'At Zing Pop Culture from 1 December.' },
    { id: 'tag:c2', title: 'Pokémon plush pre-orders open', link: 'https://consoles.example/c2' },
    { id: 'tag:c3', title: 'Lorcana restock coming to BIG W', link: 'https://cards.example/a4', summary: 'The same story as Card News\'s.' },
  ]));
  let r = await boss.post('/api/admin/news/feeds', { url: `${site.url}/consoles.atom`, name: 'Console News', keywords: ' funko ,-plush, funko' });
  assert.equal(r.status, 200, r.text);
  const feed = r.body.feed;
  assert.equal(feed.keywords, 'funko, -plush', 'tidied');
  assert.deepEqual([r.body.result.matched, r.body.result.added], [2, 1], 'Funko counts here; plush is left out; the Lorcana story is known already');
  const funko = (await ash.get('/api/news')).body.recent.find((x) => x.url === 'https://consoles.example/c1');
  assert.deepEqual([funko.category, funko.stores.map((s) => s.id), funko.releaseText], ['collectible', ['zing'], '1 December']);

  // New words: the next read is like the first (nothing in it posted), read in full.
  site.serve('/consoles.atom', atom([
    { id: 'tag:c4', title: 'Labubu Big Into Energy restock launches', link: 'https://consoles.example/c4' },
    { id: 'tag:c1', title: 'Funko Pop! Marvel wave pre-orders open', link: 'https://consoles.example/c1' },
  ]));
  r = await boss.put(`/api/admin/news/feeds/${feed.id}`, { keywords: 'funko, labubu' });
  assert.equal(r.status, 200, r.text);
  assert.equal(feedRow(feed.id).baseline_at, null);
  assert.equal(feedRow(feed.id).etag, '');
  r = await boss.post('/api/admin/news/feeds/check', { id: feed.id });
  assert.deepEqual([r.body.results[0].added, r.body.results[0].posted, r.body.results[0].baseline], [1, 0, true]);
  assert.equal(titled(/Labubu/).length, 0);
  // Switched off: not read by "Check feeds now" (every feed that's on)…
  await boss.put(`/api/admin/news/feeds/${feed.id}`, { enabled: false });
  r = await boss.post('/api/admin/news/feeds/check', {});
  assert.ok(!r.body.results.some((x) => x.id === feed.id));
  // …and removed: the news it found stays.
  assert.equal((await boss.del(`/api/admin/news/feeds/${feed.id}`)).status, 200);
  assert.equal((await boss.del(`/api/admin/news/feeds/${feed.id}`)).status, 404);
  assert.ok((await ash.get('/api/news')).body.recent.some((x) => x.url === 'https://consoles.example/c1'));
});

test('📰 a feed that goes wrong: the error is kept and it backs off (30 min, 1 h, 2 h…) — and comes back to every 15 minutes when it works', async () => {
  site.serve('/flaky.xml', '', { status: 500 });
  let r = await boss.post('/api/admin/news/feeds', { url: `${site.url}/flaky.xml`, name: 'Flaky' });
  assert.equal(r.status, 200, r.text);
  const id = r.body.feed.id;
  assert.deepEqual([r.body.result.ok, r.body.result.error], [false, 'The website answered HTTP 500']);
  const gap = () => feedRow(id).next_at - Date.now();
  let row = feedRow(id);
  assert.deepEqual([row.fails, row.last_error, row.last_ok_at], [1, 'The website answered HTTP 500', null]);
  assert.ok(Math.abs(gap() - 30 * MIN) < MIN, 'half an hour');
  await boss.post('/api/admin/news/feeds/check', { id });
  assert.equal(feedRow(id).fails, 2);
  assert.ok(Math.abs(gap() - 60 * MIN) < MIN, 'an hour');
  site.serve('/flaky.xml', '<!doctype html><html><title>Just a moment...</title></html>', { type: 'text/html' });
  r = await boss.post('/api/admin/news/feeds/check', { id });
  assert.match(r.body.results[0].error, /isn't an RSS or Atom feed/);
  assert.equal(feedRow(id).fails, 3);
  assert.ok(Math.abs(gap() - 120 * MIN) < MIN, 'two hours');
  site.serve('/flaky.xml', '', { status: 403 });
  r = await boss.post('/api/admin/news/feeds/check', { id });
  assert.match(r.body.results[0].error, /turned Mugibot away \(HTTP 403\)/);
  assert.ok(gap() <= 4 * HOUR + MIN, 'four hours at most');
  // Working again.
  site.serve('/flaky.xml', rss([{ guid: 'f1', title: 'Xbox Series X restock coming to EB Games', link: 'https://consoles.example/f1' }]));
  r = await boss.post('/api/admin/news/feeds/check', { id });
  assert.equal(r.body.results[0].ok, true);
  row = feedRow(id);
  assert.deepEqual([row.fails, row.last_error], [0, '']);
  assert.ok(Math.abs(gap() - 15 * MIN) <= MIN + 1000, 'every 15 minutes, give or take a minute');
  assert.ok((await boss.get('/api/admin/news')).body.feeds.find((f) => f.id === id).lastOkAt);
});

test('📰 the loop reads feeds that are due — never two at once from one website', async () => {
  const on = news().data.feedRows().filter((r) => r.enabled);
  assert.ok(on.length >= 2, 'Card News and Flaky, on this computer');
  for (const r of on) news().data.updateFeed(r.id, { next_at: 0 });
  const before = site.state.requests.length;
  assert.equal(await news().tick(), 1, 'one website: one feed this time');
  assert.equal(await news().tick(), 1, 'the next one the time after');
  assert.equal(await news().tick(), 0, 'nothing due now');
  assert.equal(site.state.requests.length - before, 2);
  assert.ok(news().data.feedRows().filter((r) => r.enabled).every((r) => r.next_at > Date.now() + 10 * MIN));
});

test('📅 Coming up: each morning in Sydney (from 8:31), once a day, only when something comes out in the next 14 days', async () => {
  const days = 400; // (well clear of the other tests' news)
  const at = (d, h, mi) => sydneyAt(days + d, h, mi);
  assert.equal(await news().digestTick({ at: at(0, 8, 40) }), false, 'nothing coming up: no post');
  let r = await boss.post('/api/admin/news', { title: 'One Piece OP-20 booster box release', releaseAt: sydneyDay(days + 3), stores: ['kmart', 'bigw'], url: 'https://cards.example/op20' });
  assert.equal(r.status, 200, r.text);
  await boss.post('/api/admin/news', { title: 'Pokémon 31st anniversary set release', releaseAt: sydneyDay(days + 30), url: 'https://cards.example/later' });
  const count = () => titled(/^📅 Coming up$/).length;
  const n = count();
  assert.equal(await news().digestTick({ at: at(0, 8, 20) }), false, 'too early');
  assert.equal(await news().digestTick({ at: at(0, 8, 40) }), true);
  assert.equal(count(), n + 1);
  const e = titled(/^📅 Coming up$/).at(-1).body.embeds[0];
  assert.match(e.description, /\*\*\w{3} \d{1,2} \w{3,4}\*\* — \[One Piece OP-20 booster box release\]\(https:\/\/cards\.example\/op20\) · Kmart, BIG W/);
  assert.doesNotMatch(e.description, /31st anniversary/, 'more than 14 days away');
  assert.equal(await news().digestTick({ at: at(0, 9, 30) }), false, 'once a day');
  assert.equal(await news().digestTick({ at: at(1, 12, 30) }), false, 'not after noon');
  assert.equal(await news().digestTick({ at: at(2, 8, 31) }), true, 'the next morning');
  assert.equal(count(), n + 2);
  assert.equal(env.app.repo.getSetting('newsDigest').day, sydneyDay(days + 2));
});
