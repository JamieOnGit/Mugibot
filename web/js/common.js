// Helpers shared by the sign-in pages, the dashboard and admin.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Request failed (${status})`);
    this.status = status;
    this.body = body || {};
  }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-mugibot': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Build an element: h('li', {class: 'x', onclick}, 'text', child) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function toast(title, body = '', level = 'info', ms = 6000) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = h('div', { class: `toast ${level}` }, h('b', {}, title), body ? h('span', {}, body) : null);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

export function setMsg(el, text, ok = false) {
  el.textContent = text || '';
  el.className = `msg ${text ? (ok ? 'ok' : 'err') : ''}`;
}

export const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '');

export function when(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${Math.max(s, 1)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Disable a form's buttons while `fn` runs. */
export async function busy(form, fn) {
  const buttons = $$('button', form);
  buttons.forEach((b) => { b.disabled = true; });
  try {
    return await fn();
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

/** The ☀/☾ button: light or dark, remembered in this browser (see theme.js). */
export function initThemeToggle(button) {
  if (!button) return;
  const show = () => { button.textContent = document.documentElement.dataset.theme === 'light' ? '☾' : '☀'; };
  show();
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('mgb-theme2', next); } catch { /* storage blocked */ }
    show();
  });
}

/**
 * Page buttons under a table or list: ‹ Prev, the page numbers (a window around this one when there
 * are many), Next ›, and "11–20 of 48". Hidden when everything fits on one page.
 * nav: the <nav class="pager">. onPage(p): show page p.
 */
export function renderPager(nav, { page, size, total, onPage, label = '' }) {
  const pages = Math.max(1, Math.ceil(total / size));
  nav.textContent = '';
  nav.hidden = pages <= 1;
  if (pages <= 1) return;
  const at = Math.min(Math.max(1, page), pages);
  const btn = (text, p, attrs = {}) => {
    const b = h('button', { type: 'button', class: 'btn small', ...attrs }, text);
    b.addEventListener('click', () => onPage(p));
    return b;
  };
  const shown = new Set([1, pages, at - 2, at - 1, at, at + 1, at + 2].filter((p) => p >= 1 && p <= pages));
  const nums = [];
  let last = 0;
  for (const p of [...shown].sort((a, b) => a - b)) {
    if (p - last > 1) nums.push(h('span', { class: 'muted pg-gap', 'aria-hidden': 'true' }, '…'));
    nums.push(btn(String(p), p, { class: `btn small pg${p === at ? ' on' : ''}`, 'aria-label': `${label ? `${label} page` : 'Page'} ${p}`, 'aria-current': p === at ? 'page' : null }));
    last = p;
  }
  const from = (at - 1) * size + 1;
  nav.append(
    btn('‹ Prev', at - 1, { disabled: at <= 1, 'aria-label': 'Previous page' }),
    ...nums,
    btn('Next ›', at + 1, { disabled: at >= pages, 'aria-label': 'Next page' }),
    h('span', { class: 'muted small pg-sum' }, `${from}–${Math.min(from + size - 1, total)} of ${total}`),
  );
}

/**
 * A list's search, filters and order (My watchlist, Armed, Drop watches): a bar of controls above it,
 * kept in this browser for next time. filters: [{ id, label, all, options: [[value, text]] }] (all: the
 * "every one" choice's words); sorts: [[value, text]] — the first is the list's own order.
 * Returns { values(), setOptions(id, options), apply(list, { text, match, order }) }: apply searches
 * (every word, in text(x)), filters (match[id](x, value) for each one chosen) and orders the list
 * (order[sort](a, b); ties keep their places), and says "3 of 12" while it's narrowed.
 */
export function listTools(box, { key, placeholder = 'Search', filters = [], sorts = [], onChange }) {
  const name = `mgb-list:${key}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(name) || '{}') || {}; } catch { /* storage blocked */ }
  const q = h('input', { type: 'search', class: 'lt-q', placeholder, 'aria-label': placeholder, autocomplete: 'off' });
  q.value = typeof saved.q === 'string' ? saved.q : '';
  const sels = {};
  for (const f of filters) sels[f.id] = h('select', { class: 'lt-f', 'aria-label': f.label, dataset: { filter: f.id } });
  const sort = h('select', { class: 'lt-sort', 'aria-label': 'Sort by' }, ...sorts.map(([v, t]) => h('option', { value: v }, t)));
  sort.value = sorts.some(([v]) => v === saved.sort) ? saved.sort : (sorts[0] ? sorts[0][0] : '');
  const count = h('span', { class: 'lt-count muted small', 'aria-live': 'polite' });
  const clear = h('button', { type: 'button', class: 'btn small ghost lt-clear', hidden: true }, 'Clear');
  const values = () => ({ q: q.value.trim(), sort: sort.value, ...Object.fromEntries(Object.entries(sels).map(([k, s]) => [k, s.value])) });
  const keep = () => { try { localStorage.setItem(name, JSON.stringify(values())); } catch { /* storage blocked */ } };
  const changed = () => { keep(); onChange(); };
  function setOptions(id, options) {
    const s = sels[id];
    const f = filters.find((x) => x.id === id);
    if (!s || !f) return;
    const was = s.value || (typeof saved[id] === 'string' ? saved[id] : '');
    s.textContent = '';
    s.append(h('option', { value: '' }, f.all || 'All'), ...options.map(([v, t]) => h('option', { value: v }, t)));
    s.value = options.some(([v]) => v === was) ? was : '';
  }
  for (const f of filters) setOptions(f.id, f.options || []);
  let timer = null;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(changed, 150); });
  for (const s of [...Object.values(sels), sort]) s.addEventListener('change', changed);
  clear.addEventListener('click', () => {
    q.value = '';
    for (const s of Object.values(sels)) s.value = '';
    sort.value = sorts[0] ? sorts[0][0] : '';
    saved = {};
    changed();
  });
  box.append(q, ...Object.values(sels), sort, clear, count);
  return {
    values,
    setOptions,
    apply(list, { text = () => '', match = {}, order = {} } = {}) {
      const v = values();
      const words = v.q.toLowerCase().split(/\s+/).filter(Boolean);
      let out = words.length ? list.filter((x) => { const hay = String(text(x) || '').toLowerCase(); return words.every((w) => hay.includes(w)); }) : list.slice();
      for (const [id, fn] of Object.entries(match)) if (v[id]) out = out.filter((x) => fn(x, v[id]));
      const cmp = order[v.sort];
      if (cmp) out = out.map((x, i) => [x, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map(([x]) => x);
      count.textContent = out.length !== list.length ? `${out.length} of ${list.length}` : '';
      clear.hidden = !(v.q || Object.values(sels).some((s) => s.value) || (sorts[0] && v.sort !== sorts[0][0]));
      return out;
    },
  };
}
