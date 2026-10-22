// The release news's data (server/news.js, docs/NEWS.md): the news items — an admin's, or found in
// a news feed — and the feeds Mugibot reads. Shared by everyone, like the Monitor's catalogue
// (catalog.js); nothing in it belongs to a member.

const json = (s, fallback) => { try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; } };

export function toNewsItem(r) {
  return r && {
    id: r.id, title: r.title, summary: r.summary, url: r.url, source: r.source, sourceName: r.source_name, feedId: r.feed_id || null,
    category: r.category, stores: json(r.stores, []), releaseAt: r.release_at ?? null, releaseText: r.release_text,
    publishedAt: r.published_at ?? null, postedAt: r.posted_at ?? null, postedChannel: r.posted_channel || '',
    createdBy: r.created_by || null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** A feed as admins see it (not its ETag and Last-Modified: those are for the next read only). */
export function toFeed(r) {
  return r && {
    id: r.id, url: r.url, name: r.name, enabled: !!r.enabled, keywords: r.keywords, baselineAt: r.baseline_at ?? null,
    nextAt: r.next_at || null, fails: r.fails, lastFetchAt: r.last_fetch_at ?? null, lastOkAt: r.last_ok_at ?? null,
    lastError: r.last_error, lastResult: r.last_result, createdAt: r.created_at,
  };
}

const ITEM_COLS = ['title', 'summary', 'url', 'source', 'source_name', 'feed_id', 'category', 'stores', 'release_at', 'release_text', 'published_at', 'posted_at', 'posted_channel'];
const FEED_COLS = ['url', 'name', 'enabled', 'keywords', 'baseline_at', 'next_at', 'fails', 'last_fetch_at', 'last_ok_at', 'last_error', 'last_result', 'etag', 'last_modified'];

export class NewsData {
  constructor({ db, now = () => Date.now() }) {
    Object.assign(this, { db, now });
  }

  // ---------------------------------------------------------------------------
  // News items
  // ---------------------------------------------------------------------------
  item(id) {
    return toNewsItem(this.db.get('SELECT * FROM news_items WHERE id = :id', { id: String(id || '') }));
  }

  /** Is this entry (its dedupe key, or its link) in the news already? */
  known(key, url = '') {
    return !!this.db.get('SELECT 1 AS x FROM news_items WHERE dedupe_key = :k OR (:u <> \'\' AND url = :u) LIMIT 1', { k: key, u: url });
  }

  /** row: the news_items columns (stores as a list). Returns whether it went in (false: its dedupe key was there already). */
  insert(row) {
    const t = this.now();
    const r = this.db.run(`INSERT INTO news_items (id, title, summary, url, source, source_name, feed_id, category, stores, release_at, release_text, dedupe_key, published_at, created_by, created_at, updated_at)
      VALUES (:id, :title, :summary, :url, :source, :sourceName, :feedId, :category, :stores, :releaseAt, :releaseText, :key, :publishedAt, :by, :t, :t)
      ON CONFLICT (dedupe_key) DO NOTHING`, {
      id: row.id, title: row.title, summary: row.summary || '', url: row.url || '', source: row.source, sourceName: row.sourceName || '', feedId: row.feedId || null,
      category: row.category || 'other', stores: JSON.stringify(row.stores || []), releaseAt: row.releaseAt ?? null, releaseText: row.releaseText || '',
      key: row.key, publishedAt: row.publishedAt ?? null, by: row.createdBy || null, t,
    });
    return r.changes > 0;
  }

  /** set: news_items columns (stores as a list). */
  update(id, set) {
    const s = { ...set };
    if (s.stores !== undefined) s.stores = JSON.stringify(s.stores);
    const cols = Object.keys(s).filter((c) => ITEM_COLS.includes(c));
    if (cols.length) this.db.run(`UPDATE news_items SET ${cols.map((c) => `${c} = :${c}`).join(', ')}, updated_at = :t WHERE id = :id`, { ...s, t: this.now(), id });
    return this.item(id);
  }

  remove(id) {
    return this.db.run('DELETE FROM news_items WHERE id = :id', { id: String(id || '') }).changes > 0;
  }

  markPosted(id, channelId) {
    this.db.run('UPDATE news_items SET posted_at = :t, posted_channel = :c WHERE id = :id', { t: this.now(), c: String(channelId || ''), id });
  }

  /** The newest first (by when it was published, else added). */
  recent(limit = 30) {
    return this.db.all('SELECT * FROM news_items ORDER BY COALESCE(published_at, created_at) DESC, created_at DESC LIMIT :n', { n: limit }).map(toNewsItem);
  }

  /** What's released from `from` on (and before `until`), soonest first. */
  releases(from, until = null, limit = 50) {
    return this.db.all(`SELECT * FROM news_items WHERE release_at >= :from AND (:until IS NULL OR release_at < :until)
      ORDER BY release_at, created_at LIMIT :n`, { from, until, n: limit }).map(toNewsItem);
  }

  count() {
    return this.db.get('SELECT COUNT(*) AS n FROM news_items').n;
  }

  /**
   * Old feed news goes: added more than `addedBefore` ago, and released (if it said when) before
   * `releasedBefore`. An admin's own news stays until they delete it.
   */
  prune(addedBefore, releasedBefore) {
    return this.db.run(`DELETE FROM news_items WHERE source = 'feed' AND created_at < :a AND (release_at IS NULL OR release_at < :r)`,
      { a: addedBefore, r: releasedBefore }).changes;
  }

  // ---------------------------------------------------------------------------
  // Feeds
  // ---------------------------------------------------------------------------
  feedRow(id) {
    return this.db.get('SELECT * FROM news_feeds WHERE id = :id', { id: String(id || '') });
  }

  feedByUrl(url) {
    return this.db.get('SELECT * FROM news_feeds WHERE url = :u', { u: url });
  }

  feedRows() {
    return this.db.all('SELECT * FROM news_feeds ORDER BY created_at, rowid');
  }

  /** Switched on and due a read, the longest-waiting first. */
  dueFeeds(now) {
    return this.db.all('SELECT * FROM news_feeds WHERE enabled = 1 AND next_at <= :now ORDER BY next_at', { now });
  }

  /** How many news items each feed found: { feedId: n }. */
  feedCounts() {
    return Object.fromEntries(this.db.all('SELECT feed_id, COUNT(*) AS n FROM news_items WHERE feed_id IS NOT NULL GROUP BY feed_id').map((r) => [r.feed_id, r.n]));
  }

  insertFeed({ id, url, name = '', enabled = true, keywords = '', nextAt = 0 }) {
    const r = this.db.run(`INSERT INTO news_feeds (id, url, name, enabled, keywords, next_at, created_at) VALUES (:id, :url, :name, :on, :kw, :next, :t)
      ON CONFLICT (url) DO NOTHING`, { id, url, name, on: enabled ? 1 : 0, kw: keywords, next: nextAt, t: this.now() });
    return r.changes > 0;
  }

  /** set: news_feeds columns. */
  updateFeed(id, set) {
    const cols = Object.keys(set).filter((c) => FEED_COLS.includes(c));
    if (cols.length) this.db.run(`UPDATE news_feeds SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id`, { ...set, id });
    return this.feedRow(id);
  }

  /** Gone: the news it found stays (it's still news), no longer tied to it. */
  removeFeed(id) {
    const ok = this.db.run('DELETE FROM news_feeds WHERE id = :id', { id: String(id || '') }).changes > 0;
    if (ok) this.db.run('UPDATE news_items SET feed_id = NULL WHERE feed_id = :id', { id });
    return ok;
  }
}
