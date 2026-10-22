// 📰 News (docs/NEWS.md), on the Drops page's lists: what's being released, when and at which
// stores — soonest first — and the latest release news, from the admins and the news sites Mugibot
// reads. The same news is posted in the Discord server's #news.
import { $, api, h, when } from './common.js';

// (Release days are days in Sydney, like the stores'.)
const DAY = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', day: 'numeric', month: 'short' });
const day = (ms) => DAY.format(new Date(ms)).replace(/,/g, '');

export function setupNews({ isAdmin = () => false } = {}) {
  const n = { data: null };

  function row(x) {
    const stores = x.stores.map((s) => s.name).join(', ');
    const date = x.releaseAt ? day(x.releaseAt) : x.releaseText;
    return h('li', { class: `feed-item ${x.releaseAt ? 'kind-listed' : ''}` },
      h('div', { class: 'info' },
        h('div', { class: 'kind' }, date ? `📅 ${date}` : '🗞 News', h('span', { class: 'pill' }, n.data.categories[x.category] || 'Other')),
        x.url ? h('a', { class: 'name', href: x.url, target: '_blank', rel: 'noopener', title: x.title }, x.title) : h('span', { class: 'name', title: x.title }, x.title),
        h('div', { class: 'meta' }, [stores ? `🏬 ${stores}` : '', x.summary ? x.summary.slice(0, 160) + (x.summary.length > 160 ? '…' : '') : ''].filter(Boolean).join(' · ')),
        h('div', { class: 'meta' }, `${x.sourceName || 'Mugibot'} · ${when(x.at)}`)));
  }

  function render() {
    const d = n.data;
    const sel = $('#nm-show');
    if (sel.options.length < 2) for (const [k, v] of Object.entries(d.categories)) sel.append(h('option', { value: k }, v));
    const wanted = (x) => !sel.value || x.category === sel.value;
    const upcoming = d.upcoming.filter(wanted);
    // (Latest news: what isn't in "Coming up" already.)
    const soon = new Set(d.upcoming.map((x) => x.id));
    const recent = d.recent.filter((x) => wanted(x) && !soon.has(x.id));
    $('#nm-upcoming').replaceChildren(...(upcoming.length ? upcoming.map(row) : [h('li', { class: 'empty' }, 'Nothing with a release date coming up yet.')]));
    $('#nm-recent').replaceChildren(...(recent.length ? recent.map(row) : [h('li', { class: 'empty' }, upcoming.length ? 'Nothing else yet.' : 'No news yet.')]));
    $('#nm-count').textContent = d.upcoming.length ? String(d.upcoming.length) : '';
    $('#nm-admin').hidden = !isAdmin();
  }

  $('#nm-show').addEventListener('change', () => { if (n.data) render(); });

  return {
    async load() {
      n.data = await api('GET', '/api/news');
      render();
    },
  };
}
