// 🎯 Drop watches (docs/MONITORING.md → Drop watches), on the Monitor page's lists: anything outside
// the card keywords — by its link, the words in its name and where to look (a store Mugibot
// searches, or any other website), or a store's search page read every few seconds for key phrases
// (📃 docs/MONITORING.md → Search pages). An admin's can be for everyone (#non-tcg-alerts, or the
// Discord channel they pick for it, pinging the role they pick, and every dashboard); anyone's own are
// theirs alone (their watchlist, their DMs).
import { $, ago, api, busy, h, listTools, looksLikeListing, money, setMsg, toast } from './common.js';

const STATUS = {
  in_stock: 'In stock', preorder: 'Pre-order', out_of_stock: 'Sold out', coming_soon: 'Coming soon', in_store: 'In store only', not_listed: 'Not listed yet',
  not_found: 'Page gone', blocked: 'Blocked by site', error: 'Check failed', unknown: 'Checking…', pending: 'Checking…', paused: 'Paused',
};
const ARM = { armed: '🤖 armed', pending: '🤖 armed if it isn\'t on sale yet', skipped: 'on sale before the watch looked — not armed' };
const OTHER = 'other';
// A key phrase looked for at every store Mugibot searches (server/monitor/drops.js: ALL_STORES).
const ALL = 'all';
/** Key phrases pasted in: one a line (or ; between them), each tidied — or [] for a link. */
const phrasesOf = (raw) => [...new Set(String(raw || '').split(/[\n;]+/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean))];

export function setupDrops({ isAdmin = () => false, watching = () => null, watch = null, buyUrl }) {
  // (draft: what's chosen in an open ✎ editor — kept when the list refreshes underneath it. kinds: a pasted link → 'product'
  //  or 'page', as you chose it — else as it looks.)
  const d = { data: null, timer: null, dest: null, editing: null, draft: null, kinds: new Map() };

  // ---------------------------------------------------------------------------
  // The form: one box for a link or words; where to look appears for words
  // ---------------------------------------------------------------------------
  // A link — with its https://, or pasted without it ("www.garmin.com/en-AU/p/…", "garmin.com/…").
  const BARE_LINK = /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i;
  const isLink = (v) => /^https?:\/\/\S+$/i.test(String(v || '').trim()) || BARE_LINK.test(String(v || '').trim());
  const linkOf = (v) => { const t = String(v || '').trim(); return /^https?:\/\//i.test(t) ? t : `https://${t}`; };

  /** The store a link is at (as the extension tells: its address, and the dummy store's path), or null. */
  function storeOf(raw) {
    let u;
    try { u = new URL(linkOf(raw)); } catch { return null; }
    const host = u.host.toLowerCase();
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* as it is */ }
    return ((d.data && d.data.stores) || []).find((s) => (s.hosts || []).some((x) => host === x || host.endsWith(`.${x.replace(/^www\./, '')}`))
      && (!s.pathPrefix || path === s.pathPrefix || path.startsWith(`${s.pathPrefix}/`))) || null;
  }

  /** A pasted link: one product's page, or a page of results (a search, a category, a collection) — as you chose, else as it looks. */
  function kindOf(raw) {
    const link = linkOf(raw);
    if (d.kinds.has(link)) return d.kinds.get(link);
    let u;
    try { u = new URL(link); } catch { return 'product'; }
    const s = storeOf(raw);
    if (s && s.productPath) {
      try { if (new RegExp(s.productPath[0], s.productPath[1]).test(u.pathname)) return 'product'; } catch { /* as it looks */ }
    }
    return looksLikeListing(u) ? 'page' : 'product';
  }

  /** "EB Games' page", "BIG W's page". */
  const whose = (name) => `${name}'${/s$/i.test(name) ? '' : 's'}`;

  /** The fastest a page can be read: every 3 s — or its store's own pace, where it's slower (Pokémon Center's 30 s). */
  const floorOf = (s) => (s && s.floor) || (d.data && d.data.pageMin) || 3;

  function fillStores() {
    const sel = $('#dw-store');
    const keep = sel.value;
    sel.textContent = '';
    const searched = (d.data.stores || []).filter((x) => x.words);
    if (searched.length) sel.append(h('option', { value: ALL }, 'Every store Mugibot searches'));
    else sel.append(h('option', { value: '' }, 'Choose…'));
    if (searched.length) sel.append(h('optgroup', { label: 'One store' }, ...searched.map((s) => h('option', { value: s.id }, s.name))));
    const off = (d.data.stores || []).filter((x) => !x.words && !x.demo);
    if (off.length) sel.append(h('optgroup', { label: 'Not searched at the moment (paste a link)' }, ...off.map((s) => h('option', { value: s.id, disabled: true }, s.name))));
    sel.append(h('option', { value: OTHER }, 'Another website…'));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  /** What's typed decides the rest of the form: where to look, Auto-checkout, the hint. */
  function shape() {
    if (!d.data) return;
    const raw = $('#dw-input').value.trim();
    const link = isLink(raw);
    const where = $('#dw-store').value;
    const hint = $('#dw-hint');
    const kind = link ? kindOf(raw) : '';
    $('#dw-where').hidden = link || !raw;
    $('#dw-site-wrap').hidden = link || where !== OTHER;
    $('#dw-kind-wrap').hidden = !link;
    $('#dw-page-wrap').hidden = kind !== 'page';
    if (link) $(kind === 'page' ? '#dw-kind-page' : '#dw-kind-product').checked = true;
    $('#dw-add').textContent = kind === 'page' ? 'Watch this page' : 'Add drop watch';
    let aco = false;
    let note = '';
    if (!raw) {
      hint.textContent = 'A link watches that one product; a store\'s search or category page is read every few seconds for your key phrases. Words watch for anything whose name has every one of them.';
    } else if (kind === 'page') {
      // A page of results, read every few seconds for its key phrases.
      const s = storeOf(raw);
      const floor = floorOf(s);
      const every = $('#dw-every');
      every.min = String(floor);
      // (Its store's pace, once for each link pasted — never changed under you while you type.)
      if (d.pageLink !== linkOf(raw)) {
        d.pageLink = linkOf(raw);
        if (!every.value || Number(every.value) < floor) every.value = String(Math.max(floor, (d.data && d.data.pageSeconds) || 5));
      }
      $('#dw-every-note').textContent = floor > 3 && s ? `(${s.name}: every ${floor} s at the fastest — it turns away anything quicker)` : `(${floor} s at the fastest)`;
      const list = phrasesOf($('#dw-phrases').value);
      const words = list.length ? list.map((x) => `"${x}"`).join(', ') : 'your key phrases';
      const n = Number(every.value) || floor;
      if (s && !s.pages) {
        hint.textContent = `Mugibot doesn't read ${whose(s.name)} pages for key phrases at the moment — paste a product's link instead.`;
      } else if (s) {
        aco = s.aco;
        hint.textContent = `✓ ${whose(s.name)} page, read every ${n} seconds: anything on it whose name has ${list.length > 1 ? 'one of ' : ''}${words} — you're told the moment it's on the page (and when it comes back or gets cheaper)${s.aco ? ', and ⚡ Buy and Auto-checkout work here' : ''}.`;
      } else {
        let host = '';
        try { host = new URL(linkOf(raw)).host.replace(/^www\./, ''); } catch { /* not yet a link */ }
        hint.textContent = `Another website${host ? ` (${host})` : ''}: its page read every ${n} seconds for ${words} — alerts only there (Mugibot checks out at the stores it knows).`;
      }
      note = 'Bought only if it\'s new on the page after the watch\'s first look (or comes on sale then) — never what\'s on sale there already. One purchase per watch: once it\'s bought one it\'s disarmed — ✎ on the watch arms it again.';
    } else if (link) {
      const s = storeOf(raw);
      if (s) {
        aco = s.aco;
        hint.textContent = s.aco ? `✓ ${s.name} — you're told the moment it's in stock (or open for pre-order) and when its price drops, and ⚡ Buy and Auto-checkout work here.` : `✓ ${s.name} — you're told the moment it's in stock (or open for pre-order), and when its price drops.`;
      } else {
        let host = '';
        try { host = new URL(linkOf(raw)).host.replace(/^www\./, ''); } catch { /* not yet a link */ }
        hint.textContent = `Another website${host ? ` (${host})` : ''} — you're told when it drops, comes back in stock, opens for pre-order or gets cheaper, and buy it there yourself (Mugibot checks out at the stores it knows).`;
      }
      note = 'A link is bought as soon as it\'s on sale — now, if it already is.';
    } else {
      const list = phrasesOf(raw).map((x) => x.toLowerCase().replace(/[^a-z0-9à-ÿ ]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
      const words = list.length > 1 ? list.map((x) => `"${x}"`).join(', ') : `"${list[0] || ''}"`;
      const several = list.length > 1 ? `${list.length} key phrases, a watch each: ` : '';
      const s = (d.data.stores || []).find((x) => x.id === where);
      aco = !!(s && s.aco) || where === ALL;
      const said = list.every((x) => x.length < 3) ? 'Type a few words of its name.' : where === OTHER
        ? `${several}anything at that website whose name has ${words} — its search is read every couple of minutes, and you're told when one drops, comes back, opens for pre-order or gets cheaper. Alerts only there.`
        : where === ALL ? `${several}anything at every store Mugibot searches whose name has ${words} — each store's own search in turn (about every ${d.data.sweepSeconds} seconds), and every product its card searches read — and you're told the moment one drops, comes back or gets cheaper.`
        : s ? `${several}anything at ${s.name} whose name has ${words} — searched in turn with the card keywords (every ${d.data.sweepSeconds} seconds or so, more when ${s.name} is busy), and you're told when one drops, comes back or gets cheaper.` : 'Now choose where to look.';
      hint.textContent = said.charAt(0).toUpperCase() + said.slice(1);
      note = 'Words buy only what drops after the watch has looked — never what\'s on sale already.';
    }
    $('#dw-aco-wrap').hidden = !aco;
    $('#dw-aco-note').hidden = !aco || !$('#dw-aco').checked;
    $('#dw-aco-note').textContent = note;
    if (!aco) $('#dw-aco').checked = false;
    const admin = isAdmin();
    $('#dw-share-wrap').hidden = !admin;
    $('#dw-cat-wrap').hidden = !admin || !$('#dw-share').checked;
    $('#dw-post-wrap').hidden = !admin || !$('#dw-share').checked;
    const postNote = $('#dw-post-note');
    postNote.hidden = $('#dw-post-wrap').hidden || !(d.dest && !d.dest.ready);
    postNote.textContent = d.dest && !d.dest.ready ? d.dest.error : '';
  }

  // ---------------------------------------------------------------------------
  // Where an admin's watch for everyone posts: a channel of the Discord server, and a role it pings
  // ---------------------------------------------------------------------------
  async function loadDest() {
    if (!isAdmin() || !d.data || !d.data.discord) return;
    try { d.dest = await api('GET', '/api/drops/discord'); } catch (e) { d.dest = { ready: false, channels: [], roles: [], error: e.message }; }
    fillDest($('#dw-post'), $('#dw-ping'), { channelId: $('#dw-post').value, roleId: $('#dw-ping').value, category: $('#dw-category').value });
    shape();
  }

  // (The usual: #non-tcg-alerts — or, for a watch in a card category, that category's channels.)
  const usualName = (category = 'nontcg') => (category === 'nontcg' ? (d.data && d.data.route ? d.data.route.name : '#non-tcg-alerts') : "its category's channels");
  const usual = (category) => `The usual — ${usualName(category)}`;
  const channelName = (id) => { const c = d.dest && d.dest.channels.find((x) => x.id === id); return c ? `#${c.name}` : `#${id}`; };
  const roleName = (id) => { const r = d.dest && d.dest.roles.find((x) => x.id === id); return r ? `@${r.name}` : `@${id}`; };

  /** The two pickers: the server's text channels (by category) and its roles, with what's chosen now. */
  function fillDest(post, ping, { channelId = '', roleId = '', category = 'nontcg' } = {}) {
    const dest = d.dest || { ready: false, channels: [], roles: [] };
    post.textContent = '';
    post.append(h('option', { value: '' }, usual(category)));
    const groups = new Map();
    for (const c of dest.channels) {
      if (!groups.has(c.parent)) groups.set(c.parent, []);
      groups.get(c.parent).push(c);
    }
    for (const [parent, list] of groups) {
      const opts = list.map((c) => h('option', { value: c.id }, `#${c.name}`));
      if (parent) post.append(h('optgroup', { label: parent }, ...opts)); else post.append(...opts);
    }
    // (One chosen before that the server no longer has: kept, so saving doesn't move it silently.)
    if (channelId && !dest.channels.some((c) => c.id === channelId)) post.append(h('option', { value: channelId }, `#${channelId} (not found)`));
    post.value = channelId;
    ping.textContent = '';
    ping.append(h('option', { value: '' }, 'No one'), ...dest.roles.map((r) => h('option', { value: r.id }, `@${r.name}`)));
    if (roleId && !dest.roles.some((r) => r.id === roleId)) ping.append(h('option', { value: roleId }, `@${roleId} (not found)`));
    ping.value = roleId;
    post.disabled = !dest.ready;
    ping.disabled = !dest.ready;
  }

  /** Where it posts, in a few words: "#xbox-drops · pings @Drops", or the usual channel. */
  function postsIn(w) {
    if (!w.channelId) return `in ${usualName(w.category)}`;
    return `in ${channelName(w.channelId)}${w.roleId ? ` · pings ${roleName(w.roleId)}` : ''}`;
  }

  // ---------------------------------------------------------------------------
  // The lists: yours, and the admins' for everyone
  // ---------------------------------------------------------------------------
  async function load() {
    const first = !d.data;
    d.data = await api('GET', '/api/drops');
    fillStores();
    shape();
    render();
    // (The Discord server's channels and roles: once, for an admin — Discord's asked at most once a minute.)
    if (first || !d.dest) loadDest().then(render).catch(() => null);
  }

  function refreshSoon() {
    clearTimeout(d.timer);
    d.timer = setTimeout(() => load().catch(() => null), 500);
  }

  // Search, filter and sort the watches (kept in this browser): what's found, where, and how it's going.
  const BUYABLE = new Set(['in_stock', 'preorder']);
  const phrasesText = (w) => (w.phrases || []).map((x) => `"${x}"`).join(', ');
  const titleOf = (w) => w.label || (w.kind === 'link' ? (w.found[0] && w.found[0].name) || w.url : w.kind === 'page' ? phrasesText(w) : w.words) || '';
  const lastFind = (w) => Math.max(0, ...w.found.map((p) => p.statusAt || p.at || 0));
  const tools = listTools($('#dw-tools'), {
    key: 'drops', placeholder: 'Search drop watches (name, words, store, what they found)',
    filters: [
      { id: 'kind', label: 'Kind', all: 'Links, key phrases and pages', options: [['link', '🔗 Links'], ['words', '🔎 Key phrases'], ['page', '📃 Search pages']] },
      { id: 'store', label: 'Where', all: 'Everywhere' },
      { id: 'found', label: 'Found', all: 'Found or not', options: [['buyable', 'Something in stock or pre-order'], ['some', 'Found something'], ['none', 'Nothing found yet'], ['problem', 'A problem looking']] },
    ],
    sorts: [['', 'As listed'], ['buyable', 'In stock first'], ['recent', 'Latest finds first'], ['name', 'Name A–Z'], ['store', 'Where']],
    onChange: () => render(),
  });
  const MATCH = {
    kind: (w, v) => w.kind === v,
    store: (w, v) => w.store === v,
    found: (w, v) => (v === 'buyable' ? w.found.some((p) => BUYABLE.has(p.status)) : v === 'some' ? w.found.length > 0 : v === 'none' ? !w.found.length : !!w.error),
  };
  const ORDER = {
    buyable: (a, b) => Number(b.found.some((p) => BUYABLE.has(p.status))) - Number(a.found.some((p) => BUYABLE.has(p.status))),
    recent: (a, b) => lastFind(b) - lastFind(a),
    name: (a, b) => titleOf(a).localeCompare(titleOf(b)),
    store: (a, b) => (a.storeName || '').localeCompare(b.storeName || ''),
  };
  const watchText = (w) => [titleOf(w), w.words, w.url, w.page, ...(w.phrases || []), w.storeName, w.by, ...w.found.map((p) => `${p.name} ${p.storeName || ''}`)].filter(Boolean).join(' ');

  function render() {
    const { watches, limit, used, route } = d.data;
    const admin = isAdmin();
    tools.setOptions('store', [...new Map(watches.map((w) => [w.store, w.storeName || w.store])).entries()].sort((a, b) => a[1].localeCompare(b[1])));
    const shown = tools.apply(watches, { text: watchText, match: MATCH, order: ORDER });
    const mine = shown.filter((w) => w.mine);
    const others = shown.filter((w) => !w.mine && !w.pool);
    // (Your pool's leader's own watches: theirs, as they are — what they find is on your watchlist as their items are.)
    const pooled = shown.filter((w) => w.pool);
    const narrowed = shown.length !== watches.length;
    $('#dw-count').textContent = watches.length ? String(watches.length) : '';
    $('#dw-used').textContent = `${used} of ${limit}`;
    $('#dw-scope').textContent = admin
      ? 'Yours for everyone go in #non-tcg-alerts (or the channel you pick for each) and on every member\'s dashboard; members ☆ Watch what they find to arm Auto-checkout.'
      : 'Yours are just for you: what they find goes on your watchlist, and you get the DM.';
    const chan = $('#dw-channel');
    chan.hidden = !admin;
    if (admin) {
      chan.className = `notice ${route ? 'ok' : 'warn'}`;
      chan.textContent = '';
      if (route) chan.append(`📣 Drops for everyone are posted in ${route.name}${route.enabled ? '' : ' (its rule is off)'}, unless a watch has a channel of its own.`);
      else {
        const b = h('button', { class: 'btn small', type: 'button' }, 'Make #non-tcg-alerts');
        b.addEventListener('click', () => makeChannel(b));
        chan.append('No #non-tcg-alerts channel yet — until there is, drops for everyone go to #misc-retailers. ', b);
      }
    }
    const list = $('#dw-mine');
    list.textContent = '';
    if (!mine.length) list.append(h('li', { class: 'empty' }, narrowed && watches.some((w) => w.mine) ? 'None of yours match — change the search or press Clear.' : 'No drop watches yet — paste a product\'s link above, or type the words in its name.'));
    for (const w of mine) list.append(row(w));
    $('#dw-shared-box').hidden = !others.length;
    const sl = $('#dw-shared');
    sl.textContent = '';
    for (const w of others) sl.append(row(w));
    $('#dw-pool-box').hidden = !pooled.length;
    $('#dw-pool-h').textContent = pooled.length ? `🤝 From your pool — ${pooled[0].pool}'s` : '🤝 From your pool';
    const pl = $('#dw-pool');
    pl.textContent = '';
    for (const w of pooled) pl.append(row(w));
  }

  function whereText(w) {
    if (w.kind === 'link') return `Link · ${w.storeName}`;
    if (w.kind === 'page') return `Page · ${w.storeName} · every ${w.every} s`;
    return `Words "${w.words}" · ${w.store === OTHER ? w.storeName : `at ${w.storeName}`}`;
  }

  /** How its looking is going, in a few words. */
  function stateText(w) {
    if (w.kind === 'link') return '';
    if (w.kind === 'page') return pageState(w);
    if (w.error) return h('span', { class: 'warn-text' }, w.error, w.allow ? ` — ${allowText(w.allow)}` : '');
    if (!w.looked) return w.store === OTHER ? 'Looking in a few seconds…' : `Looking at ${w.storeName}'s next search…`;
    // (The website refusing the server: read from a browser instead.)
    if (w.via === 'browser') return `read from ${w.shared ? 'an admin\'s browser' : 'your browser'} ${ago(w.lastOkAt || w.lastAt)} (the website refuses the server)`;
    return `looked ${ago(w.lastOkAt || w.lastAt)}`;
  }

  /** A search page's reading: how often, from where (admins), and anything it's waiting on. */
  function pageState(w) {
    const warn = (...t) => h('span', { class: 'warn-text' }, ...t);
    if (w.waiting === 'off') return warn(`${w.storeName} is switched off — its page isn't read meanwhile`);
    if (w.waiting === 'unsupported') return warn(`Mugibot doesn't read ${whose(w.storeName)} pages for key phrases at the moment`);
    if (w.waiting === 'update') return warn(`Waiting for an admin's browser with Mugibot's extension ${w.needs || 'up to date'}${w.has ? ` (it has ${w.has})` : ''} — update it from Setup`);
    if (w.waiting === 'browser') return warn(isAdmin() ? `${whose(w.storeName)} page is read from an admin's browser — waiting for one (Chrome with Mugibot's extension, signed in as an admin)` : `Waiting to read ${whose(w.storeName)} page — it's read as soon as it can be`);
    if (w.error && w.fails) return warn(w.error, w.allow ? ` — ${allowText(w.allow)}` : '');
    if (!w.looked) return 'Reading the page in a moment…';
    const bits = [`read ${ago(w.lastOkAt || w.lastAt)}`, w.readEvery ? `every ~${w.readEvery} s` : '', `${w.seen} on the page`, w.via === 'browser' ? (w.mine && !isAdmin() ? 'from your browser' : "from an admin's browser") : ''];
    const text = bits.filter(Boolean).join(' · ');
    return w.error ? h('span', {}, text, ' · ', h('span', { class: 'muted' }, w.error)) : text;
  }

  /** Another website refusing the server: how to have your browser check it instead. */
  function allowText(host) {
    return `allow ${host} in the Mugibot extension (its toolbar menu → Allow checks from this browser) and your browser checks it instead`;
  }

  function row(w) {
    const title = w.label || (w.kind === 'link' ? (w.found[0] && w.found[0].name) || w.url : w.kind === 'page' ? phrasesText(w) : `"${w.words}"`);
    const admin = isAdmin();
    const meta = [
      whereText(w),
      w.pool ? `🤝 ${w.pool}'s — what it finds is on your watchlist as theirs is` : w.shared ? `📣 for everyone${admin && w.channelId !== undefined ? ` ${postsIn(w)}` : ''}` : '🔒 just for you',
      w.aco && w.maxPrice !== null ? `🤖 auto-checkout up to ${money(w.maxPrice)}` : '',
      w.by && !w.mine && !w.pool ? `by ${w.by}` : '',
      w.kind === 'page' && w.label ? `for ${phrasesText(w)}` : '',
    ].filter(Boolean).join(' · ');
    const state = stateText(w);
    const acts = [];
    if (w.canChange) {
      // (An admin's watch for everyone: where it posts, and who it pings. A search page's: its key phrases and pace too.)
      if ((admin && w.shared) || w.kind === 'page') acts.push(h('button', { class: 'btn small', type: 'button', title: w.kind === 'page' ? 'Its key phrases, how often it\'s read' + (admin && w.shared ? ', where it posts and who it pings' : '') : 'Where it posts, and who it pings', 'aria-label': w.kind === 'page' ? `Change ${title}` : `Where ${title} posts`, 'aria-expanded': d.editing === w.id ? 'true' : 'false', onclick: () => { d.editing = d.editing === w.id ? null : w.id; d.draft = null; render(); } }, '✎'));
      if (w.kind === 'page') acts.push(h('a', { class: 'btn small', href: w.page, target: '_blank', rel: 'noopener', title: 'Open the page', 'aria-label': `Open the page ${title} watches` }, '↗'));
      acts.push(h('button', { class: 'btn small', type: 'button', title: 'Look again now', 'aria-label': `Check ${title} now`, onclick: (e) => check(w, e.currentTarget) }, '↻'));
      acts.push(h('button', {
        class: 'btn small danger', type: 'button', 'aria-label': `Remove ${title}`,
        onclick: () => remove(w, title),
      }, 'Remove'));
    }
    const found = w.found.length ? h('ul', { class: 'dw-found' }, ...w.found.map((p) => foundRow(w, p)))
      : h('div', { class: 'meta dw-none' }, w.kind === 'link' ? 'Reading its page…' : w.kind === 'page' ? (w.looked ? 'Nothing with those key phrases on the page yet — you\'re told the moment something shows up.' : '')
        : w.looked ? 'Nothing with those words yet — you\'re told the moment something shows up.' : '');
    return h('li', { class: `dw-row${w.shared ? ' shared' : ''}`, dataset: { id: w.id } },
      h('div', { class: 'dw-head' },
        h('span', { class: 'dw-icon', 'aria-hidden': 'true' }, w.kind === 'link' ? '🔗' : w.kind === 'page' ? '📃' : '🔎'),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, title),
          h('div', { class: 'meta' }, meta, state ? ' · ' : '', state)),
        h('div', { class: 'acts' }, ...acts)),
      d.editing === w.id ? editor(w, title) : null,
      found);
  }

  /** An admin's watch for everyone: change where it posts, and who it pings. A search page's: its key phrases and pace too. */
  function editor(w, title) {
    const posts = isAdmin() && w.shared;
    const page = w.kind === 'page';
    const post = h('select', { 'aria-label': `${title}: post in` });
    const ping = h('select', { 'aria-label': `${title}: ping` });
    const phrases = h('textarea', { rows: '2', maxlength: '1500', 'aria-label': `${title}: key phrases, one a line` });
    // (Your own page watch's Auto-checkout: armed again after the one purchase it makes, or its max price changed.)
    const arms = page && w.mine && w.canBuy;
    const aco = h('input', { type: 'checkbox', 'aria-label': `${title}: Auto-checkout what drops` });
    const max = h('input', { type: 'number', min: '1', step: '0.01', placeholder: 'Max price $', 'aria-label': `${title}: max price for Auto-checkout` });
    const every = h('input', { type: 'number', min: String(w.floor || 3), max: '3600', step: '1', inputmode: 'numeric', 'aria-label': `${title}: read the page every (seconds)` });
    const draft = d.draft && d.draft.id === w.id ? d.draft : { id: w.id, channelId: w.channelId, roleId: w.roleId, phrases: (w.phrases || []).join('\n'), every: w.every, aco: !!w.aco, max: w.maxPrice ?? '' };
    fillDest(post, ping, { channelId: draft.channelId, roleId: draft.roleId, category: w.category });
    phrases.value = draft.phrases || '';
    every.value = String(draft.every || '');
    aco.checked = !!draft.aco;
    max.value = draft.max === null || draft.max === undefined ? '' : String(draft.max);
    const keep = () => { d.draft = { id: w.id, channelId: post.value, roleId: ping.value, phrases: phrases.value, every: every.value, aco: aco.checked, max: max.value }; };
    for (const el of [post, ping, aco]) el.addEventListener('change', keep);
    for (const el of [phrases, every, max]) el.addEventListener('input', keep);
    const save = h('button', { class: 'btn small primary', type: 'submit' }, 'Save');
    const form = h('form', { class: 'dw-edit' },
      page ? h('label', {}, 'Key phrases to look for on the page (one a line)', phrases) : null,
      page ? h('label', {}, `Read the page every (seconds — ${w.floor || 3} at the fastest)`, every) : null,
      arms ? h('div', { class: 'dw-aco' }, h('label', { class: 'check inline' }, aco, ' 🤖 Auto-checkout what drops, up to'), max) : null,
      posts ? h('label', {}, 'Post its drops and restocks in', post) : null, posts ? h('label', {}, 'Ping', ping) : null,
      h('div', { class: 'form-actions' }, save, h('button', { class: 'btn small ghost', type: 'button', onclick: () => { d.editing = null; d.draft = null; render(); } }, 'Cancel')),
      posts && d.dest && !d.dest.ready ? h('p', { class: 'small muted' }, d.dest.error) : null);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      try {
        const body = {
          ...(posts ? { channelId: post.value, roleId: ping.value } : {}),
          ...(page ? { phrases: phrasesOf(phrases.value), every: Number(every.value) || undefined } : {}),
          ...(arms ? { aco: aco.checked, maxPrice: max.value ? Number(max.value) : undefined } : {}),
        };
        const r = await api('PUT', `/api/drops/${w.id}`, body);
        d.data = { ...d.data, ...r };
        d.editing = null;
        d.draft = null;
        render();
        toast('Saved', page ? `Its page is read every ${r.watch.every} seconds for ${phrasesText(r.watch)}${posts ? `, and its drops and restocks posted ${postsIn(r.watch)}` : ''}.` : `"${title}" posts its drops and restocks ${postsIn(r.watch)}.`, 'success');
      } catch (err) {
        save.disabled = false;
        toast("Couldn't change that", err.message, 'warn');
      }
    });
    return form;
  }

  function foundRow(w, p) {
    const acts = [];
    if (p.canBuy && p.url && p.status !== 'not_found') acts.push(h('a', { class: 'btn small primary', href: buyUrl(p), target: '_blank', rel: 'noopener', title: 'Opens the store with ⚡ Buy (your checkout, filled in)' }, '⚡ Buy'));
    if (p.url) acts.push(h('a', { class: 'btn small', href: p.url, target: '_blank', rel: 'noopener', 'aria-label': `Open ${p.name} at ${p.storeName}` }, p.canBuy ? '↗' : 'Open ↗'));
    // An admin's find for everyone: ☆ puts it on your watchlist (your own DM, and Auto-checkout from there).
    if (!w.mine && p.productId && watch) {
      const on = watching(p);
      if (on) acts.push(h('a', { class: 'btn small watching', href: '#watch', title: on.aco ? 'On your watchlist, armed for Auto-checkout' : 'On your watchlist — Edit it there to arm 🤖 Auto-checkout' }, on.aco ? '★ 🤖' : '★'));
      else {
        const b = h('button', { class: 'btn small watch', type: 'button', title: 'Watch it: your own DM when it\'s in stock, and Auto-checkout from your watchlist', 'aria-label': `Watch ${p.name}` }, '☆');
        b.addEventListener('click', async () => { b.disabled = true; await watch(p); refreshSoon(); });
        acts.push(b);
      }
    }
    // (Its store refusing the server: checked from a browser — or, at another website, once you allow it there.)
    const via = p.via === 'browser' ? (p.itemId ? '🧭 checked from your browser' : '🧭 checked from an admin\'s browser') : '';
    const bits = [p.storeName, money(p.price), p.aco ? '🤖 armed' : ARM[p.arm] || '', via].filter(Boolean).join(' · ');
    return h('li', {},
      p.image ? h('img', { class: 'thumb', src: p.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div', { class: 'thumb ph', 'aria-hidden': 'true' }, String(p.name || '?').slice(0, 1).toUpperCase()),
      h('div', { class: 'info' }, h('div', { class: 'name' }, p.name), h('div', { class: 'meta' }, bits),
        p.allow ? h('div', { class: 'meta warn-text' }, `The website refuses Mugibot's server — ${allowText(p.allow)}.`) : null),
      h('span', { class: `pill ${p.status}` }, STATUS[p.status] || p.status),
      h('div', { class: 'acts' }, ...acts));
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  async function check(w, button) {
    button.disabled = true;
    try {
      await api('POST', `/api/drops/${w.id}/check`, {});
      toast('Looking again', w.kind === 'link' || w.kind === 'page' ? 'Its page is read next.' : w.store === OTHER ? 'The website is read in a few seconds.' : `At ${w.storeName}'s next search.`);
      setTimeout(refreshSoon, 4000);
    } catch (e) {
      toast("Couldn't do that", e.message, 'warn');
    } finally {
      button.disabled = false;
    }
  }

  async function remove(w, title) {
    const what = w.shared ? ' Its monitors go too (what it found stays in the history).' : ' What it put on your watchlist goes too.';
    if (!confirm(`Remove the drop watch "${title}"?${what}`)) return;
    try {
      d.data = { ...d.data, ...(await api('DELETE', `/api/drops/${w.id}`)) };
      render();
    } catch (e) {
      toast("Couldn't remove it", e.message, 'warn');
    }
  }

  async function makeChannel(button) {
    button.disabled = true;
    try {
      const r = await api('POST', '/api/drops/channel', {});
      d.data = { ...d.data, ...r };
      render();
      toast(`#${r.channel.name} ${r.channel.made ? 'made' : 'found'}`, 'Drops for everyone are posted there now.', 'success');
    } catch (e) {
      button.disabled = false;
      toast("Couldn't set it up", e.message, 'warn');
    }
  }

  $('#dw-input').addEventListener('input', shape);
  // (What a link is: chosen — kept for that link while you're typing.)
  for (const r of [$('#dw-kind-product'), $('#dw-kind-page')]) {
    r.addEventListener('change', () => {
      const raw = $('#dw-input').value.trim();
      if (isLink(raw)) d.kinds.set(linkOf(raw), r.value);
      shape();
      if (r.value === 'page') $('#dw-phrases').focus();
    });
  }
  $('#dw-phrases').addEventListener('input', shape);
  $('#dw-every').addEventListener('input', shape);
  $('#dw-store').addEventListener('change', () => { shape(); if ($('#dw-store').value === OTHER) $('#dw-site').focus(); });
  $('#dw-share').addEventListener('change', shape);
  $('#dw-category').addEventListener('change', () => { if (d.dest) $('#dw-post').options[0].textContent = usual($('#dw-category').value); });
  $('#dw-aco').addEventListener('change', () => { shape(); if ($('#dw-aco').checked) $('#dw-max').focus(); });
  $('#dw-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('#dw-input').value.trim();
    const body = { label: $('#dw-label').value.trim() };
    const list = isLink(raw) ? [] : phrasesOf(raw);
    const page = isLink(raw) && kindOf(raw) === 'page';
    // (A search page: its key phrases are one watch — the page read once for them all.)
    if (page) Object.assign(body, { page: linkOf(raw), phrases: phrasesOf($('#dw-phrases').value), every: Number($('#dw-every').value) || undefined });
    else if (isLink(raw)) body.url = linkOf(raw);
    // (Several key phrases, one a line: a watch each.)
    else if (list.length > 1) Object.assign(body, { phrases: list, store: $('#dw-store').value, site: $('#dw-store').value === OTHER ? $('#dw-site').value.trim() : '' });
    else Object.assign(body, { words: list[0] || raw, store: $('#dw-store').value, site: $('#dw-store').value === OTHER ? $('#dw-site').value.trim() : '' });
    if ($('#dw-aco').checked) Object.assign(body, { aco: true, maxPrice: $('#dw-max').value ? Number($('#dw-max').value) : null });
    if (isAdmin()) Object.assign(body, { shared: $('#dw-share').checked, category: $('#dw-category').value });
    if (isAdmin() && $('#dw-share').checked) Object.assign(body, { channelId: $('#dw-post').value, roleId: $('#dw-ping').value });
    const form = e.target;
    busy(form, async () => {
      try {
        const r = await api('POST', '/api/drops', body);
        d.data = { ...d.data, ...r };
        render();
        $('#dw-input').value = '';
        $('#dw-phrases').value = '';
        $('#dw-label').value = '';
        $('#dw-site').value = '';
        $('#dw-aco').checked = false;
        $('#dw-max').value = '';
        $('#dw-post').value = '';
        $('#dw-ping').value = '';
        shape();
        const w = r.watch || (r.added && r.added[0]);
        const next = w.kind === 'link' ? 'its page is being read now.' : w.kind === 'page' ? `its page is read in a moment, then every ${w.every} seconds.` : w.store === OTHER ? 'the website is read in a few seconds.' : w.store === ALL ? 'searched at each store\'s next search.' : `searched at ${w.storeName}'s next search.`;
        const notAdded = (r.errors || []).map((x) => `"${x.phrase}" (${x.error})`).join('; ');
        setMsg($('#dw-msg'), r.added ? `Watching ${r.added.length} key phrase${r.added.length === 1 ? '' : 's'} — ${next}${notAdded ? ` Not added: ${notAdded}` : ''}` : `Watching — ${next}`, true);
        setTimeout(refreshSoon, 4000);
      } catch (err) {
        setMsg($('#dw-msg'), err.message);
      }
    });
  });

  /** A search page from elsewhere ("Add a monitor"): in the form as a page watch, its key phrases next. */
  async function prefillPage(link) {
    if (!d.data) await load().catch(() => null);
    $('#dw-input').value = link;
    if (isLink(link)) d.kinds.set(linkOf(link), 'page');
    shape();
    $('#dw-form').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    $('#dw-phrases').focus();
  }

  return { load, refreshSoon, prefillPage };
}
