// RSS 2.0 and Atom feeds (the release news: server/news.js), read without a library. Small and
// forgiving, like html.js: it copes with CDATA, entities (once or twice over), Atom's <link href>,
// namespaced elements (content:encoded, dc:date) and a feed cut short — an entry without its end tag
// is left out, the ones before it kept.

import { decodeEntities } from './html.js';

const MARK = '\u0000';
const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
const PLACE = /\u0000(\d+)\u0000/;
const MAX_ENTRIES = 200;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The elements called `name` in `block` (not nested in one another): [{ attrs, inner }]. */
function elements(block, name, max = Infinity) {
  const out = [];
  const lower = block.toLowerCase();
  const open = new RegExp(`<${esc(name)}(?=[\\s/>])([^>]*)>`, 'gi');
  const end = `</${name.toLowerCase()}`;
  let m;
  while (out.length < max && (m = open.exec(block))) {
    const attrs = m[1] || '';
    if (attrs.trimEnd().endsWith('/')) {
      out.push({ attrs: attrs.trimEnd().slice(0, -1), inner: '' });
      continue;
    }
    const close = lower.indexOf(end, open.lastIndex);
    if (close < 0) break; // (cut short: no end tag, so nothing after it either)
    out.push({ attrs, inner: block.slice(open.lastIndex, close) });
    open.lastIndex = close + end.length;
  }
  return out;
}

function attrsOf(s) {
  const out = {};
  for (const m of String(s || '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '');
  return out;
}

/**
 * An element's text: entities decoded where the XML has them and CDATA as it is; then any HTML in it
 * (summaries, Atom's type="html", a title with <b> in it) down to its words — and decoded again, since
 * HTML inside XML comes escaped twice over ("&amp;amp;", "&lt;p&gt;").
 */
function textOf(inner, raw) {
  const parts = String(inner || '').split(PLACE);
  let t = parts.map((p, i) => (i % 2 ? raw[Number(p)] ?? '' : decodeEntities(p))).join('');
  if (/<[a-z/!]/i.test(t)) {
    t = t.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ');
  }
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

const first = (block, name, raw) => {
  const [el] = elements(block, name, 1);
  return el ? textOf(el.inner, raw) : '';
};

function linkFrom(href, base) {
  if (!href) return '';
  try {
    const u = new URL(href, base || undefined);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

const when = (s) => {
  const t = Date.parse(String(s || '').trim());
  return Number.isFinite(t) ? t : null;
};

/** Atom's links: the page itself is rel="alternate" (or no rel), preferably HTML. */
function atomLink(block, base) {
  const links = elements(block, 'link').map((l) => attrsOf(l.attrs)).filter((a) => a.href && (!a.rel || a.rel === 'alternate'));
  const best = links.find((a) => !a.type || /html/i.test(a.type)) || links[0];
  return best ? linkFrom(best.href, base) : '';
}

function rssEntry(block, raw, base) {
  const [guidEl] = elements(block, 'guid', 1);
  const guid = guidEl ? textOf(guidEl.inner, raw) : '';
  const permalink = guidEl && attrsOf(guidEl.attrs).ispermalink !== 'false' && /^https?:\/\//i.test(guid);
  let link = linkFrom(first(block, 'link', raw), base);
  if (!link && permalink) link = linkFrom(guid, base);
  if (!link) link = atomLink(block, base); // (an <atom:link> or <link href> instead)
  const summary = first(block, 'description', raw) || first(block, 'content:encoded', raw);
  return {
    id: guid, title: first(block, 'title', raw), link, summary,
    published: when(first(block, 'pubDate', raw) || first(block, 'dc:date', raw)),
  };
}

function atomEntry(block, raw, base) {
  return {
    id: first(block, 'id', raw), title: first(block, 'title', raw), link: atomLink(block, base),
    summary: first(block, 'summary', raw) || first(block, 'content', raw),
    published: when(first(block, 'published', raw) || first(block, 'updated', raw)),
  };
}

/**
 * A feed: { kind: 'rss' | 'atom', title, link, entries: [{ id, title, link, summary, published }] } —
 * or null when it isn't one (a web page, a bot check's page). base: the feed's address (relative links).
 */
export function parseFeed(xml, base = '') {
  const raw = [];
  // (CDATA set aside first: what's in it is text, whatever it looks like — tags and "</item>" included.)
  let s = String(xml ?? '').replace(CDATA, (_, t) => `${MARK}${raw.push(t) - 1}${MARK}`);
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  const root = (s.match(/<([a-zA-Z][\w:.-]*)/) || [])[1] || '';
  const local = root.toLowerCase().replace(/^.*:/, '');
  const kind = local === 'rss' || local === 'rdf' ? 'rss' : local === 'feed' ? 'atom' : null;
  if (!kind) return null;
  const tag = kind === 'rss' ? 'item' : 'entry';
  const at = s.search(new RegExp(`<${tag}(?=[\\s/>])`, 'i'));
  const head = at < 0 ? s : s.slice(0, at);
  const entries = elements(s, tag, MAX_ENTRIES).map((e) => (kind === 'rss' ? rssEntry(e.inner, raw, base) : atomEntry(e.inner, raw, base)))
    .filter((e) => e.title || e.link);
  return {
    kind,
    title: first(head, 'title', raw),
    link: kind === 'rss' ? linkFrom(first(head, 'link', raw), base) : atomLink(head, base),
    entries,
  };
}
