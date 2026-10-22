// Release news (server/news.js, docs/NEWS.md). Members with an active membership see what's coming
// up and the latest news (Drops → 📰 News). Admins add their own, manage the news feeds, post to
// #news and set the channel up (Admin → News).

import { HttpError, str } from '../schema.js';

export function register(router, ctx) {
  const { news, limiter } = ctx;
  const member = { entitled: true };
  const admin = { auth: 'admin' };
  const slow = (req, key, n, minutes = 10) => {
    if (!limiter.hit(`${key}:${req.user.id}`, n, minutes * 60 * 1000)) throw new HttpError(429, 'Slow down a little — try again in a few minutes');
  };

  // --- Everyone with a membership ---------------------------------------------------
  router.get('/api/news', async () => news.forMembers(), member);

  // --- Admins: their own news -----------------------------------------------------------
  router.get('/api/admin/news', async () => news.forAdmins(), admin);

  router.post('/api/admin/news', async (req) => {
    slow(req, 'newsadd', 60);
    const out = await news.add(req.body, req.user);
    return { ...out, ...news.forAdmins() };
  }, admin);

  // --- Admins: the feeds, the channel, the digest (before ":id", which would take their names) ----
  router.post('/api/admin/news/feeds', async (req) => {
    slow(req, 'newsfeed', 30);
    const feed = news.addFeed(req.body, req.user);
    // (Read straight away: the admin sees whether it works. Its first read is kept, not posted.)
    const result = await news.checkFeed(feed.id);
    return { feed, result, ...news.forAdmins() };
  }, admin);

  // "Check feeds now": body.id for one feed, else every one that's on.
  router.post('/api/admin/news/feeds/check', async (req) => {
    slow(req, 'newscheck', 10);
    const results = await news.checkNow(str(req.body.id, 40) || null);
    await news.settled();
    return { results, ...news.forAdmins() };
  }, admin);

  router.put('/api/admin/news/feeds/:id', async (req) => ({ feed: news.updateFeed(req.params.id, req.body, req.user), ...news.forAdmins() }), admin);

  router.delete('/api/admin/news/feeds/:id', async (req) => {
    news.removeFeed(req.params.id, req.user);
    return news.forAdmins();
  }, admin);

  // "Set up #news": found by name, or made by the bot (body.roleId: a role its posts ping).
  router.post('/api/admin/news/channel', async (req) => {
    slow(req, 'newssetup', 10);
    const out = await news.setupChannel({ roleId: req.body.roleId }, req.user);
    return { ...out, ...news.forAdmins() };
  }, admin);

  // "📅 Coming up" now, whatever the time (the morning's still goes out as usual).
  router.post('/api/admin/news/digest', async (req) => {
    slow(req, 'newsdigest', 5);
    return news.digestNow(req.user);
  }, admin);

  router.put('/api/admin/news/:id', async (req) => ({ item: news.update(req.params.id, req.body, req.user), ...news.forAdmins() }), admin);

  router.delete('/api/admin/news/:id', async (req) => {
    news.remove(req.params.id, req.user);
    return news.forAdmins();
  }, admin);

  router.post('/api/admin/news/:id/post', async (req) => {
    slow(req, 'newspost', 30);
    await news.postNow(req.params.id, req.user);
    return { posted: true, ...news.forAdmins() };
  }, admin);
}
