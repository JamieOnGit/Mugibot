// 🎯 Drop watches (docs/MONITORING.md → Drop watches), on the Monitor page's lists: anything outside
// the card keywords — by its link, or the words in its name and where to look (a store Mugibot
// searches, or any other website). An admin's can be for everyone (#non-tcg-alerts, or the Discord
// channel they pick for it, pinging the role they pick, and every dashboard); anyone's own are
// theirs alone (their watchlist, their DMs).
import { $, ago, api, busy, h, money, setMsg, toast } from './common.js';

const STATUS = {
  in_stock: 'In stock', preorder: 'Pre-order', out_of_stock: 'Sold out', coming_soon: 'Coming soon', not_listed: 'Not listed yet',
  not_found: 'Page gone', blocked: 'Blocked by site', error: 'Check failed', unknown: 'Checking…', pending: 'Checking…', paused: 'Paused',
};
const ARM = { armed: '🤖 armed', pending: '🤖 armed if it isn\'t on sale yet', skipped: 'on sale before the watch looked — not armed' };
const OTHER = 'other';

export function setupDrops({ isAdmin = () => false, watching = () => null, watch = null, buyUrl }) {
  // (draft: what's chosen in an open ✎ editor — kept when the list refreshes underneath it.)
  const d = { data: null, timer: null, dest: null, editing: null, draft: null };

  // ---------------------------------------------------------------------------
  // The form: one box for a link or words; where to look appears for words
  // ---------------------------------------------------------------------------
  const isLink = (v) => /^https?:\/\/\S+$/i.test(String(v || '').trim());

  /** The store a link is at (as the extension tells: its address, and the dummy store's path), or null. */
  function storeOf(raw) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { return null; }
    const host = u.host.toLowerCase();
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* as it is */ }
    return ((d.data && d.data.stores) || []).find((s) => (s.hosts || []).some((x) => host === x || host.endsWith(`.${x.replace(/^www\./, '')}`))
      && (!s.pathPrefix || path === s.pathPrefix || path.startsWith(`${s.pathPrefix}/`))) || null;
  }

  function fillStores() {
    const sel = $('#dw-store');
    const keep = sel.value;
    sel.textContent = '';
    sel.append(h('option', { value: '' }, 'Choose…'));
    for (const s of (d.data.stores || []).filter((x) => x.words)) sel.append(h('option', { value: s.id }, s.name));
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
    $('#dw-where').hidden = link || !raw;
    $('#dw-site-wrap').hidden = link || where !== OTHER;
    let aco = false;
    let note = '';
    if (!raw) {
      hint.textContent = 'A link watches that one product. Words watch for anything whose name has every one of them.';
    } else if (link) {
      const s = storeOf(raw);
      if (s) {
        aco = s.aco;
        hint.textContent = s.aco ? `✓ ${s.name} — you're told the moment it's in stock, and ⚡ Buy and Auto-checkout work here.` : `✓ ${s.name} — you're told the moment it's in stock.`;
      } else {
        let host = '';
        try { host = new URL(raw).host.replace(/^www\./, ''); } catch { /* not yet a link */ }
        hint.textContent = `Another website${host ? ` (${host})` : ''} — you're told the moment it's back in stock, and buy it there yourself (Mugibot checks out at the stores it knows).`;
      }
      note = 'A link is bought as soon as it\'s on sale — now, if it already is.';
    } else {
      const words = raw.toLowerCase().replace(/[^a-z0-9à-ÿ ]+/g, ' ').trim();
      const s = (d.data.stores || []).find((x) => x.id === where);
      aco = !!(s && s.aco);
      hint.textContent = words.length < 3 ? 'Type a few words of its name.' : where === OTHER
        ? `Anything at that website whose name has "${words}" — its search is read every couple of minutes. Alerts only there.`
        : s ? `Anything at ${s.name} whose name has "${words}" — searched about every ${d.data.sweepSeconds} seconds, alongside the card keywords.` : 'Now choose where to look.';
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

  function render() {
    const { watches, limit, used, route } = d.data;
    const admin = isAdmin();
    const mine = watches.filter((w) => w.mine);
    const others = watches.filter((w) => !w.mine);
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
    if (!mine.length) list.append(h('li', { class: 'empty' }, 'No drop watches yet — paste a product\'s link above, or type the words in its name.'));
    for (const w of mine) list.append(row(w));
    $('#dw-shared-box').hidden = !others.length;
    const sl = $('#dw-shared');
    sl.textContent = '';
    for (const w of others) sl.append(row(w));
  }

  function whereText(w) {
    if (w.kind === 'link') return `Link · ${w.storeName}`;
    return `Words "${w.words}" · ${w.store === OTHER ? w.storeName : `at ${w.storeName}`}`;
  }

  /** How its looking is going, in a few words. */
  function stateText(w) {
    if (w.kind === 'link') return '';
    if (w.error) return h('span', { class: 'warn-text' }, w.error);
    if (!w.looked) return w.store === OTHER ? 'Looking in a few seconds…' : `Looking at ${w.storeName}'s next search…`;
    return `looked ${ago(w.lastOkAt || w.lastAt)}`;
  }

  function row(w) {
    const title = w.label || (w.kind === 'link' ? (w.found[0] && w.found[0].name) || w.url : `"${w.words}"`);
    const admin = isAdmin();
    const meta = [
      whereText(w),
      w.shared ? `📣 for everyone${admin && w.channelId !== undefined ? ` ${postsIn(w)}` : ''}` : '🔒 just for you',
      w.aco && w.maxPrice !== null ? `🤖 auto-checkout up to ${money(w.maxPrice)}` : '',
      w.by && !w.mine ? `by ${w.by}` : '',
    ].filter(Boolean).join(' · ');
    const state = stateText(w);
    const acts = [];
    if (w.canChange) {
      // (An admin's watch for everyone: where it posts, and who it pings.)
      if (admin && w.shared) acts.push(h('button', { class: 'btn small', type: 'button', title: 'Where it posts, and who it pings', 'aria-label': `Where ${title} posts`, 'aria-expanded': d.editing === w.id ? 'true' : 'false', onclick: () => { d.editing = d.editing === w.id ? null : w.id; d.draft = null; render(); } }, '✎'));
      acts.push(h('button', { class: 'btn small', type: 'button', title: 'Look again now', 'aria-label': `Check ${title} now`, onclick: (e) => check(w, e.currentTarget) }, '↻'));
      acts.push(h('button', {
        class: 'btn small danger', type: 'button', 'aria-label': `Remove ${title}`,
        onclick: () => remove(w, title),
      }, 'Remove'));
    }
    const found = w.found.length ? h('ul', { class: 'dw-found' }, ...w.found.map((p) => foundRow(w, p)))
      : h('div', { class: 'meta dw-none' }, w.kind === 'link' ? 'Reading its page…' : w.looked ? 'Nothing with those words yet — you\'re told the moment something shows up.' : '');
    return h('li', { class: `dw-row${w.shared ? ' shared' : ''}`, dataset: { id: w.id } },
      h('div', { class: 'dw-head' },
        h('span', { class: 'dw-icon', 'aria-hidden': 'true' }, w.kind === 'link' ? '🔗' : '🔎'),
        h('div', { class: 'info' },
          h('div', { class: 'name' }, title),
          h('div', { class: 'meta' }, meta, state ? ' · ' : '', state)),
        h('div', { class: 'acts' }, ...acts)),
      d.editing === w.id ? editor(w, title) : null,
      found);
  }

  /** An admin's watch for everyone: change where it posts, and who it pings. */
  function editor(w, title) {
    const post = h('select', { 'aria-label': `${title}: post in` });
    const ping = h('select', { 'aria-label': `${title}: ping` });
    const draft = d.draft && d.draft.id === w.id ? d.draft : { id: w.id, channelId: w.channelId, roleId: w.roleId };
    fillDest(post, ping, { channelId: draft.channelId, roleId: draft.roleId, category: w.category });
    const keep = () => { d.draft = { id: w.id, channelId: post.value, roleId: ping.value }; };
    post.addEventListener('change', keep);
    ping.addEventListener('change', keep);
    const save = h('button', { class: 'btn small primary', type: 'submit' }, 'Save');
    const form = h('form', { class: 'dw-edit' },
      h('label', {}, 'Post its drops and restocks in', post), h('label', {}, 'Ping', ping),
      h('div', { class: 'form-actions' }, save, h('button', { class: 'btn small ghost', type: 'button', onclick: () => { d.editing = null; d.draft = null; render(); } }, 'Cancel')),
      d.dest && !d.dest.ready ? h('p', { class: 'small muted' }, d.dest.error) : null);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      try {
        const r = await api('PUT', `/api/drops/${w.id}`, { channelId: post.value, roleId: ping.value });
        d.data = { ...d.data, ...r };
        d.editing = null;
        d.draft = null;
        render();
        toast('Saved', `"${title}" posts its drops and restocks ${postsIn(r.watch)}.`, 'success');
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
    const bits = [p.storeName, money(p.price), p.aco ? '🤖 armed' : ARM[p.arm] || ''].filter(Boolean).join(' · ');
    return h('li', {},
      p.image ? h('img', { class: 'thumb', src: p.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div', { class: 'thumb ph', 'aria-hidden': 'true' }, String(p.name || '?').slice(0, 1).toUpperCase()),
      h('div', { class: 'info' }, h('div', { class: 'name' }, p.name), h('div', { class: 'meta' }, bits)),
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
      toast('Looking again', w.kind === 'link' ? 'Its page is read next.' : w.store === OTHER ? 'The website is read in a few seconds.' : `At ${w.storeName}'s next search.`);
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
  $('#dw-store').addEventListener('change', () => { shape(); if ($('#dw-store').value === OTHER) $('#dw-site').focus(); });
  $('#dw-share').addEventListener('change', shape);
  $('#dw-category').addEventListener('change', () => { if (d.dest) $('#dw-post').options[0].textContent = usual($('#dw-category').value); });
  $('#dw-aco').addEventListener('change', () => { shape(); if ($('#dw-aco').checked) $('#dw-max').focus(); });
  $('#dw-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('#dw-input').value.trim();
    const body = { label: $('#dw-label').value.trim() };
    if (isLink(raw)) body.url = raw;
    else Object.assign(body, { words: raw, store: $('#dw-store').value, site: $('#dw-store').value === OTHER ? $('#dw-site').value.trim() : '' });
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
        $('#dw-label').value = '';
        $('#dw-site').value = '';
        $('#dw-aco').checked = false;
        $('#dw-max').value = '';
        $('#dw-post').value = '';
        $('#dw-ping').value = '';
        shape();
        setMsg($('#dw-msg'), r.watch.kind === 'link' ? 'Watching — its page is being read now.' : r.watch.store === OTHER ? 'Watching — the website is read in a few seconds.' : `Watching — searched at ${r.watch.storeName}'s next search.`, true);
        setTimeout(refreshSoon, 4000);
      } catch (err) {
        setMsg($('#dw-msg'), err.message);
      }
    });
  });

  return { load, refreshSoon };
}
