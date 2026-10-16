// The dashboard's Monitor tab (docs/MONITORING.md): the live feed of new
// drops, restocks and price changes, health numbers, every tracked product
// with filters, and a product page with its price history. Admins also run
// the live sweeps, add and change monitors, set up the Discord alert
// channels, and see health and the check log here.
import { $, $$, ago, api, busy, h, money, setMsg, toast, when } from './common.js';

const KINDS = {
  restock: { emoji: '🟢', label: 'In stock' },
  listed: { emoji: '🆕', label: 'New drop' },
  sold_out: { emoji: '🔴', label: 'Sold out' },
  price_drop: { emoji: '📉', label: 'Price drop' },
  price_rise: { emoji: '📈', label: 'Price up' },
};
const STATUS = {
  in_stock: 'In stock', preorder: 'Pre-order', out_of_stock: 'Sold out', coming_soon: 'Coming soon', not_listed: 'Not listed yet',
  not_found: 'Page gone', blocked: 'Blocked by site', error: 'Check failed', unknown: 'Unknown', pending: 'Waiting for first check',
};
const CATEGORY = { pokemon: 'Pokémon', onepiece: 'One Piece', other: 'Other' };
const MODES = { server: 'Server', browser: "Admin's browser", off: 'Off' };
const DAY = 86400000;
const SVG = 'http://www.w3.org/2000/svg';

export function setupMonitor({ showError }) {
  const m = { admin: false, stores: [], alerts: [], products: [], current: null, loaded: false, timer: null };
  const panelOpen = () => !$('[data-panel="monitor"]').hidden;
  const storeName = (id) => (m.stores.find((s) => s.id === id) || {}).name || id;
  const filters = () => ({ q: $('#m-q').value.trim(), category: $('#m-category').value, store: $('#m-store').value, status: $('#m-status').value });
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();
  const buyUrl = (a) => `/buy?${qs({ store: a.store, sku: a.sku, url: a.url, name: a.name })}`;

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------
  async function load() {
    let data;
    try {
      data = await api('GET', '/api/monitor');
    } catch (e) {
      if (e.status !== 402) throw e;
      $('#m-stats').textContent = '';
      $('#m-stats').append(h('div', { class: 'notice warn' }, h('b', {}, 'The Monitor feed is for members. '), h('a', { href: '#membership' }, 'Start your membership'), ' to see live restocks and price changes.'));
      return;
    }
    m.admin = data.admin;
    m.stores = data.stores;
    if (!m.loaded) fillChoices();
    m.loaded = true;
    renderStats(data.overview);
    $('#m-add-toggle').hidden = !m.admin;
    $('#m-admin').hidden = !m.admin;
    await Promise.all([loadFeed(), loadProducts(), m.admin ? loadAdmin() : null]);
  }

  async function loadFeed(more = false) {
    const f = filters();
    const before = more && m.alerts.length ? m.alerts.at(-1).id : '';
    const { alerts } = await api('GET', `/api/monitor/alerts?${qs({ kind: $('#m-kind').value, category: f.category, store: f.store, before })}`);
    m.alerts = more ? [...m.alerts, ...alerts] : alerts;
    const list = $('#m-feed');
    if (!more) list.textContent = '';
    if (!m.alerts.length) list.append(h('li', { class: 'empty' }, 'No alerts yet. They appear here the moment a product drops, restocks or changes price.'));
    for (const a of alerts) list.append(feedItem(a));
    $('#m-more').hidden = alerts.length < 30;
  }

  async function loadProducts() {
    const { products } = await api('GET', `/api/monitor/products?${qs(filters())}`);
    m.products = products;
    const list = $('#m-products');
    list.textContent = '';
    $('#m-count').textContent = `(${products.length})`;
    if (!products.length) {
      list.append(h('li', { class: 'empty' }, filters().q || filters().category || filters().store || filters().status
        ? 'Nothing matches those filters.' : m.admin ? 'Nothing tracked yet — the live sweeps fill this in within a minute (or press + Add monitor).' : 'No products are being tracked yet.'));
    }
    for (const p of products) list.append(productRow(p));
  }

  function fillChoices() {
    for (const s of m.stores) {
      $('#m-store').append(h('option', { value: s.id }, s.name));
      $('#ma-store').append(h('option', { value: s.id }, s.name));
    }
    kindBoxes($('#ma-kinds'), 'ma-k', ['restock', 'listed', 'price_drop']);
    kindBoxes($('#md-kinds'), 'md-k', []);
    kindBoxes($('#mr-kinds'), 'mr-k', ['restock', 'listed']);
    for (const [v, label] of Object.entries(CATEGORY)) $('#mr-categories').append(h('label', { class: 'check inline' }, h('input', { type: 'checkbox', value: v }), label));
    for (const s of m.stores) $('#mr-stores').append(h('label', { class: 'check inline' }, h('input', { type: 'checkbox', value: s.id }), s.name));
  }

  function kindBoxes(box, prefix, checked) {
    for (const [k, v] of Object.entries(KINDS)) {
      box.append(h('label', { class: 'check inline' }, h('input', { type: 'checkbox', value: k, id: `${prefix}-${k}`, checked: checked.includes(k) }), `${v.emoji} ${v.label}`));
    }
  }
  const ticked = (box) => $$('input:checked', box).map((i) => i.value);
  const tick = (box, values) => $$('input', box).forEach((i) => { i.checked = values.includes(i.value); });

  // ---------------------------------------------------------------------------
  // Health numbers
  // ---------------------------------------------------------------------------
  function renderStats(o) {
    const health = o.okRate1h === null ? { cls: '', icon: '…', label: 'No checks yet' }
      : o.okRate1h >= 90 ? { cls: 'good', icon: '✓', label: 'Healthy' }
        : o.okRate1h >= 60 ? { cls: 'warning', icon: '!', label: 'Some failing' } : { cls: 'critical', icon: '✕', label: 'Mostly failing' };
    const tile = (label, value, sub = '', cls = '') => h('div', { class: `stat ${cls}` }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, String(value)), sub ? h('div', { class: 'stat-sub' }, sub) : null);
    const box = $('#m-stats');
    box.textContent = '';
    box.append(
      tile('Tracked', o.tracked + o.monitors, `${o.tracked} from sweeps · ${o.monitors} monitor${o.monitors === 1 ? '' : 's'}`),
      tile('Available now', o.available, 'in stock or pre-order'),
      tile('New drops', o.drops24h, 'last 24 hours'),
      tile('Restocks', o.restocks24h, 'last 24 hours'),
      tile('Price changes', o.priceChanges24h, 'last 24 hours'),
      tile('Checks OK', o.okRate1h === null ? '—' : `${o.okRate1h}%`, `${health.icon} ${health.label}${o.checks1h ? ` · ${o.checks1h.toLocaleString()} / hour` : ''}`, health.cls),
    );
  }

  // ---------------------------------------------------------------------------
  // The feed and the products
  // ---------------------------------------------------------------------------
  function thumb(src, name) {
    return src ? h('img', { class: 'thumb', src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('div', { class: 'thumb ph', 'aria-hidden': 'true' }, String(name || '?').slice(0, 1).toUpperCase());
  }

  async function watch(p, button) {
    button.disabled = true;
    try {
      await api('POST', '/api/items', p.url ? { url: p.url, name: p.name } : { store: p.store, sku: p.sku, name: p.name });
      toast('Added to your watchlist', `${p.name} — you'll get your own DM when it restocks.`, 'success');
      button.textContent = '✓ Watching';
    } catch (e) {
      button.disabled = false;
      toast("Couldn't add it", e.message, 'warn');
    }
  }

  function actions(p, { compact = false } = {}) {
    const out = [];
    if (p.kind !== 'sold_out') out.push(h('a', { class: 'btn small primary', href: buyUrl(p), title: 'Adds it to your watchlist and opens the store with ⚡ Buy' }, '⚡ Buy'));
    if (p.url) out.push(h('a', { class: 'btn small', href: p.url, target: '_blank', rel: 'noopener' }, compact ? '↗' : 'Open ↗'));
    if (!compact) {
      const b = h('button', { class: 'btn small', type: 'button' }, '+ Watch');
      b.addEventListener('click', () => watch(p, b));
      out.push(b);
    }
    return h('div', { class: 'acts' }, ...out);
  }

  function feedItem(a) {
    const k = KINDS[a.kind] || KINDS.restock;
    const label = a.kind === 'restock' && a.status === 'preorder' ? 'Pre-order open' : k.label;
    const was = typeof a.previousPrice === 'number' && a.previousPrice !== a.price ? h('s', { class: 'muted' }, money(a.previousPrice)) : null;
    const name = a.productId ? h('button', { class: 'link-btn', type: 'button', onclick: () => openProduct(a.productId) }, a.name) : h('span', {}, a.name);
    return h('li', { class: `feed-item kind-${a.kind}`, dataset: { id: String(a.id) } },
      thumb(a.image, a.name),
      h('div', { class: 'info' },
        h('div', { class: 'kind' }, `${k.emoji} ${label}`, a.manual ? h('span', { class: 'pill' }, 'reported by an admin') : null),
        h('div', { class: 'name' }, name),
        h('div', { class: 'meta' }, `${storeName(a.store)} · `, money(a.price) || '—', ' ', was, ` · ${CATEGORY[a.category] || ''} · `, h('time', { datetime: new Date(a.at).toISOString(), title: when(a.at) }, ago(a.at)), a.note ? ` · ${a.note}` : '')),
      actions(a, { compact: true }));
  }

  function statusPill(p) {
    const label = STATUS[p.status] || p.status;
    const unsure = !p.confirmed && p.status !== 'pending' ? ' (unconfirmed)' : '';
    return h('span', { class: `pill ${p.status}`, title: p.error || (p.checkedAt ? `Checked ${ago(p.checkedAt)}` : '') }, label + unsure);
  }

  const isNewProduct = (p) => !!(p.sweep && p.sweep.firstAt && Date.now() - p.sweep.firstAt < DAY);

  function productRow(p) {
    const was = typeof p.previousPrice === 'number' && p.previousPrice !== p.price ? h('s', { class: 'muted small' }, money(p.previousPrice)) : null;
    return h('li', { class: `product ${p.monitor && p.monitor.paused ? 'paused' : ''}`, dataset: { id: p.id } },
      thumb(p.image, p.name || p.sku),
      h('div', { class: 'info' },
        h('button', { class: 'link-btn name', type: 'button', onclick: () => openProduct(p.id) }, p.name || p.sku),
        isNewProduct(p) ? h('span', { class: 'pill info new-tag', title: `Found ${ago(p.sweep.firstAt)}` }, '🆕 New') : null,
        h('div', { class: 'meta' }, `${storeName(p.store)} · ${CATEGORY[p.category]} · SKU ${p.sku}${p.monitor && p.monitor.paused ? ' · ⏸ paused' : ''}${p.sweep && p.sweep.seenAt ? ` · seen ${ago(p.sweep.seenAt)}` : ''}`)),
      h('div', { class: 'price' }, h('b', {}, money(p.price) || '—'), ' ', was),
      h('div', { class: 'state' }, statusPill(p), h('div', { class: 'muted small' }, p.statusAt ? `since ${ago(p.statusAt)}` : '')));
  }

  // ---------------------------------------------------------------------------
  // One product: details, price history, alerts; admins: settings and check log
  // ---------------------------------------------------------------------------
  async function openProduct(id) {
    let d;
    try {
      d = await api('GET', `/api/monitor/products/${encodeURIComponent(id)}`);
    } catch (e) {
      toast("Couldn't open that product", e.message, 'warn');
      return;
    }
    m.current = d;
    const p = d.product;
    const dlg = $('#m-detail');
    const img = $('#md-img');
    img.hidden = !p.image;
    if (p.image) img.src = p.image;
    $('#md-name').textContent = p.name || p.sku;
    $('#md-meta').textContent = `${storeName(p.store)} · ${CATEGORY[p.category]} · SKU ${p.sku}${p.checkedAt ? ` · checked ${ago(p.checkedAt)}` : ''}${p.sweep ? ` · found ${ago(p.sweep.firstAt)} searching "${p.sweep.keyword}"` : ''}`;
    const state = $('#md-state');
    state.textContent = '';
    const was = typeof p.previousPrice === 'number' && p.previousPrice !== p.price ? h('s', { class: 'muted' }, money(p.previousPrice)) : null;
    state.append(statusPill(p), ' ', h('b', { class: 'big-price' }, money(p.price) || '—'), ' ', was);
    const acts = $('#md-actions');
    acts.textContent = '';
    acts.append(actions({ ...p, kind: p.status === 'out_of_stock' ? 'sold_out' : 'restock' }));
    if (d.cartUrl) $('.acts', acts).append(h('a', { class: 'btn small', href: d.cartUrl, target: '_blank', rel: 'noopener', title: "The store's own add-to-cart link" }, '🛒 Add to cart'));

    const chartBox = $('#md-chart');
    chartBox.textContent = '';
    chartBox.append(priceChart(d.history));
    const rows = $('#md-history tbody');
    rows.textContent = '';
    for (const pt of [...d.history].reverse()) rows.append(h('tr', {}, h('td', {}, when(pt.at)), h('td', {}, money(pt.price))));
    if (!d.history.length) rows.append(h('tr', {}, h('td', { colspan: '2', class: 'muted' }, 'No prices yet.')));

    const al = $('#md-alerts');
    al.textContent = '';
    if (!d.alerts.length) al.append(h('li', { class: 'empty' }, 'No alerts for this product yet.'));
    for (const a of d.alerts) al.append(feedItem(a));

    const form = $('#md-settings');
    form.hidden = !m.admin || !d.monitor;
    $('#md-log-box').hidden = !m.admin || !d.log;
    if (m.admin && d.monitor) {
      $('#md-sname').value = p.name || '';
      $('#md-category').value = p.category;
      $('#md-interval').value = d.monitor.intervalSeconds || '';
      $('#md-note').value = d.monitor.note || '';
      tick($('#md-kinds'), d.monitor.kinds);
      $('#md-pause').textContent = d.monitor.paused ? '▶ Resume' : '⏸ Pause';
      setMsg($('#md-msg'), '');
    }
    if (m.admin && d.log) {
      const lb = $('#md-log tbody');
      lb.textContent = '';
      for (const l of d.log) lb.append(logRow(l, false));
      if (!d.log.length) lb.append(h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'Not checked yet.')));
    }
    if (location.hash !== `#monitor/${p.id}`) history.replaceState(null, '', `#monitor/${p.id}`);
    if (!dlg.open) dlg.showModal();
  }

  /**
   * Price over time: one series, a step line (a price holds until it changes), a marker on
   * each change, recessive gridlines, and a crosshair readout on hover and arrow keys.
   */
  function priceChart(points) {
    if (!points.length) return h('p', { class: 'muted small' }, 'No prices recorded yet.');
    // Drawn at roughly the size it's shown, so the labels stay readable on a phone.
    const W = window.innerWidth < 600 ? 360 : 640;
    const H = window.innerWidth < 600 ? 190 : 210;
    const pad = { l: 52, r: 12, t: 14, b: 30 };
    const now = Date.now();
    const t0 = points[0].at;
    const t1 = Math.max(now, points.at(-1).at + 1);
    // Round-number gridlines (1, 2 or 5 × a power of ten) that cover every price.
    const min = Math.min(...points.map((p) => p.price));
    const max = Math.max(...points.map((p) => p.price));
    const span = max - min || max * 0.2 || 1;
    const raw = span / 3;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const lo = Math.max(0, Math.floor((min - (max === min ? step : 0)) / step) * step);
    const hi = Math.ceil((max + (max === min ? step : 0)) / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
    const x = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
    const el = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Price history: ${points.length} price${points.length === 1 ? '' : 's'}, from ${money(points[0].price)} to ${money(points.at(-1).price)}`, tabindex: '0' });
    for (const v of ticks) {
      svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' }));
      const label = el('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' });
      label.textContent = step >= 1 ? `$${v.toLocaleString()}` : money(v);
      svg.append(label);
    }
    const day = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
    for (const [t, anchor] of [[t0, 'start'], [t1, 'end']]) {
      const label = el('text', { x: x(t), y: H - 8, 'text-anchor': anchor, class: 'axis' });
      label.textContent = t === t1 ? 'now' : day(t);
      svg.append(label);
    }
    let d = `M${x(points[0].at)},${y(points[0].price)}`;
    for (let i = 1; i < points.length; i++) d += ` H${x(points[i].at)} V${y(points[i].price)}`;
    d += ` H${x(t1)}`;
    svg.append(el('path', { d, class: 'series' }));
    for (const p of points) svg.append(el('circle', { cx: x(p.at), cy: y(p.price), r: 4, class: 'marker' }));
    const hair = el('line', { y1: pad.t, y2: H - pad.b, class: 'crosshair', visibility: 'hidden' });
    const dot = el('circle', { r: 5, class: 'marker focus', visibility: 'hidden' });
    svg.append(hair, dot);

    const box = h('div', { class: 'chart-box' });
    const tip = h('div', { class: 'chart-tip', hidden: true });
    box.append(svg, tip);
    let idx = points.length - 1;
    const show = (i) => {
      idx = Math.max(0, Math.min(points.length - 1, i));
      const p = points[idx];
      const px = x(p.at);
      for (const [k, v] of [['x1', px], ['x2', px], ['visibility', 'visible']]) hair.setAttribute(k, v);
      for (const [k, v] of [['cx', px], ['cy', y(p.price)], ['visibility', 'visible']]) dot.setAttribute(k, v);
      tip.textContent = '';
      tip.append(h('b', {}, money(p.price)), h('span', {}, `from ${when(p.at)}`));
      tip.hidden = false;
      const r = svg.getBoundingClientRect();
      const left = (px / W) * r.width;
      tip.style.left = `${Math.min(Math.max(left, 60), r.width - 60)}px`;
    };
    const hide = () => { hair.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const t = t0 + (((e.clientX - r.left) / r.width) * W - pad.l) / (W - pad.l - pad.r) * (t1 - t0);
      // The price showing at that time: the last change at or before it.
      let i = 0;
      for (let j = 0; j < points.length; j++) if (points[j].at <= t) i = j;
      show(i);
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => show(idx));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); show(idx - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); show(idx + 1); }
    });
    return box;
  }

  // ---------------------------------------------------------------------------
  // Admins
  // ---------------------------------------------------------------------------
  async function loadAdmin() {
    await Promise.all([loadSweep(), loadRoutes(), loadHealth(), loadLog()]);
  }

  // --- The live sweeps ---------------------------------------------------------
  function fillSweepForm(d) {
    const s = d.settings;
    m.sweepDefaults = d.defaults;
    $('#ms-enabled').checked = s.enabled;
    $('#ms-keywords').value = s.keywords.join(', ');
    $('#ms-every').value = s.everySeconds;
    $('#ms-bevery').value = s.browserEverySeconds;
    $('#ms-drop').value = s.priceDropPercent;
    $('#ms-new').checked = s.newAlerts;
    $('#ms-restock').checked = s.restockAlerts;
    $('#ms-once').checked = s.restockOncePerDay;
    $('#ms-market').checked = s.skipMarketplace;
    $('#ms-tcg').checked = s.tcgOnly;
    $('#ms-terms-input').value = s.tcgTerms.join(', ');
    const box = $('#ms-stores');
    $$('.store-mode', box).forEach((e) => e.remove());
    for (const st of d.stores) {
      const sel = h('select', { 'aria-label': `${st.name}: searched from`, dataset: { store: st.id || st.store } },
        ...Object.entries(MODES).map(([v, label]) => h('option', { value: v, selected: st.mode === v }, `${label}${v === st.defaultMode ? ' (default)' : ''}`)));
      box.append(h('label', { class: 'store-mode' }, `${st.name}`, sel));
    }
  }

  function renderSweep(d) {
    const live = d.stores.filter((s) => s.mode !== 'off');
    const state = $('#ms-state');
    state.className = `pill ${!d.monitorEnabled || !d.settings.enabled ? '' : live.some((s) => s.fails > 2) ? 'warn' : 'ok'}`;
    state.textContent = !d.monitorEnabled ? 'Off (MONITOR_ENABLED=0)' : !d.settings.enabled ? 'Off' : `On · ${live.length} store${live.length === 1 ? '' : 's'}`;
    const body = $('#ms-table tbody');
    body.textContent = '';
    for (const s of d.stores) {
      const rate = s.requests1h ? Math.round((s.ok1h / s.requests1h) * 100) : null;
      const status = s.mode === 'off' ? h('span', { class: 'muted' }, '—')
        : s.fails ? h('span', { class: `pill ${s.fails > 2 ? 'err' : 'warn'}`, title: s.lastError }, `${s.lastError || 'Failing'}${s.nextAt ? ` · retry ${ago(s.nextAt)}` : ''}`)
          : s.slowedUntil ? h('span', { class: 'pill warn', title: 'The store refused a search lately, so it is searched at a third of the pace for a while' }, `Slowed after a refusal · until ${new Date(s.slowedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)
            : s.lastOkAt ? h('span', { class: 'pill ok', title: s.lastError || '' }, s.lastError || 'OK')
            : h('span', { class: 'pill' }, s.mode === 'browser' ? "Waiting for an admin's browser" : 'Starting');
      body.append(h('tr', { class: s.mode === 'off' ? 'muted' : '' },
        h('td', {}, s.name),
        h('td', {}, MODES[s.mode]),
        h('td', {}, s.lastAt ? h('time', { title: when(s.lastAt) }, ago(s.lastAt)) : '—'),
        h('td', {}, String(s.products24h)),
        h('td', {}, s.requests1h ? `${s.requests1h}${rate !== null ? ` · ${rate}% OK` : ''}` : '—'),
        h('td', {}, s.avgMs ? `${(s.avgMs / 1000).toFixed(1)} s` : '—'),
        h('td', {}, status)));
    }
    const terms = $('#ms-terms tbody');
    terms.textContent = '';
    for (const s of d.stores) {
      for (const t of s.terms) {
        terms.append(h('tr', {},
          h('td', {}, s.name), h('td', {}, t.url ? h('a', { href: t.url, target: '_blank', rel: 'noopener' }, t.keyword) : t.keyword), h('td', {}, String(t.page)),
          h('td', {}, t.total !== null && t.total !== undefined ? `${t.found} of ${t.total}` : String(t.found)), h('td', {}, String(t.kept)),
          h('td', {}, t.lastOkAt ? ago(t.lastOkAt) : 'never'), h('td', {}, t.error ? h('span', { class: `pill ${t.fails ? 'err' : 'warn'}` }, t.error) : '')));
      }
    }
    if (!terms.children.length) terms.append(h('tr', {}, h('td', { colspan: '7', class: 'muted' }, 'No searches yet.')));
  }

  async function loadSweep({ form = true } = {}) {
    const d = await api('GET', '/api/monitor/sweep');
    if (form) fillSweepForm(d);
    renderSweep(d);
  }

  // Each sweep tells open admin dashboards straight away; the table refreshes at most every 2 seconds.
  function onSweep() {
    if (!m.admin || !panelOpen() || m.sweepTimer) return;
    m.sweepTimer = setTimeout(() => { m.sweepTimer = null; loadSweep({ form: false }).catch(() => null); }, 2000);
  }

  async function loadRoutes() {
    const { routes, fallback, bot } = await api('GET', '/api/monitor/routes');
    const fb = $('#mr-fallback');
    fb.hidden = routes.length > 0 && bot;
    fb.className = `notice ${bot ? '' : 'warn'}`;
    fb.textContent = !bot ? "The Discord bot isn't set up yet (Admin → Setup check), so alerts only show here."
      : fallback && fallback.channelId ? `No rules yet: restocks and new listings go to the restock channel (${fallback.channelId}). Add rules to split them by category, store or kind.`
        : 'No rules yet and no restock channel set, so alerts only show here. Add a rule to post them in Discord.';
    const list = $('#mr-list');
    list.textContent = '';
    for (const r of routes) {
      const scope = [r.categories.length ? r.categories.map((c) => CATEGORY[c]).join(', ') : 'All categories', r.stores.length ? r.stores.map(storeName).join(', ') : 'all stores'].join(' · ');
      list.append(h('li', { class: r.enabled ? '' : 'off' },
        h('div', { class: 'info' },
          h('div', { class: 'name' }, r.name, r.enabled ? '' : ' (off)'),
          h('div', { class: 'meta' }, `#${r.channelId}${r.roleId ? ` · pings @${r.roleId}` : ''} · ${r.kinds.map((k) => KINDS[k].emoji).join(' ')} · ${scope}${r.keywords ? ` · names with: ${r.keywords}` : ''}`)),
        h('div', { class: 'acts' },
          h('button', { class: 'btn small', type: 'button', onclick: (e) => testRoute(r, e.target) }, 'Test'),
          h('button', { class: 'btn small', type: 'button', onclick: () => editRoute(r) }, 'Edit'),
          h('button', {
            class: 'btn small danger', type: 'button',
            onclick: async () => { if (!confirm(`Delete the rule "${r.name}"?`)) return; await api('DELETE', `/api/monitor/routes/${r.id}`); loadRoutes().catch(showError); },
          }, 'Delete'))));
    }
  }

  async function testRoute(r, button) {
    button.disabled = true;
    try {
      await api('POST', `/api/monitor/routes/${r.id}/test`, {});
      toast('Test alert posted', `Check the channel for "${r.name}".`, 'success');
    } catch (e) {
      toast("Couldn't post the test", e.message, 'warn');
    } finally {
      button.disabled = false;
    }
  }

  function editRoute(r) {
    const form = $('#mr-form');
    form.hidden = false;
    $('#mr-id').value = r ? r.id : '';
    $('#mr-name').value = r ? r.name : '';
    $('#mr-channel').value = r ? r.channelId : '';
    $('#mr-role').value = r ? r.roleId : '';
    $('#mr-keywords').value = r ? r.keywords : '';
    $('#mr-enabled').checked = r ? r.enabled : true;
    tick($('#mr-kinds'), r ? r.kinds : ['restock', 'listed']);
    tick($('#mr-categories'), r ? r.categories : []);
    tick($('#mr-stores'), r ? r.stores : []);
    setMsg($('#mr-msg'), '');
    $('#mr-name').focus();
  }

  async function loadHealth() {
    const { loop, stores } = await api('GET', '/api/monitor/health');
    $('#mh-loop').textContent = !loop.enabled ? 'The monitor is switched off (MONITOR_ENABLED=0).'
      : `Monitor loop: ${loop.lastTickAt ? `last ran ${ago(loop.lastTickAt)}` : 'not started yet'} · ${loop.inFlight} checking now · ${loop.due} page${loop.due === 1 ? '' : 's'} due · default every ${loop.intervalSeconds}s, ${loop.hostGapSeconds}s between requests to one store`;
    const body = $('#mh-table tbody');
    body.textContent = '';
    if (!stores.length) body.append(h('tr', {}, h('td', { colspan: '8', class: 'muted' }, 'No checks in the last hour.')));
    for (const s of stores) {
      const rate = s.checks ? Math.round((s.ok / s.checks) * 100) : 0;
      const cls = rate >= 90 ? 'ok' : rate >= 60 ? 'warn' : 'err';
      body.append(h('tr', {},
        h('td', {}, s.name), h('td', {}, String(s.checks)), h('td', {}, h('span', { class: `pill ${cls}` }, `${rate >= 90 ? '✓' : rate >= 60 ? '!' : '✕'} ${rate}%`)),
        h('td', {}, String(s.blocked)), h('td', {}, String(s.errors)), h('td', {}, s.avgMs ? `${(s.avgMs / 1000).toFixed(1)} s` : '—'),
        h('td', {}, s.lastOkAt ? ago(s.lastOkAt) : 'none'), h('td', {}, s.serverChecks ? 'On' : 'Off (admins\' browsers)')));
    }
  }

  function logRow(l, withProduct = true) {
    const ok = !['blocked', 'error'].includes(l.status) && !l.error;
    return h('tr', {},
      h('td', { title: new Date(l.at).toISOString() }, when(l.at)),
      withProduct ? h('td', {}, l.productId ? h('button', { class: 'link-btn', type: 'button', onclick: () => openProduct(l.productId) }, l.name || l.sku || '—') : '—') : null,
      withProduct ? h('td', {}, storeName(l.store)) : null,
      h('td', {}, l.source === 'browser' ? "Admin's browser" : 'Server'),
      h('td', {}, h('span', { class: `pill ${ok ? l.status : 'err'}` }, STATUS[l.status] || l.status), l.error ? h('div', { class: 'muted small' }, l.error) : null),
      h('td', {}, money(l.price) || '—'),
      h('td', {}, l.ms ? `${(l.ms / 1000).toFixed(1)} s` : '—'));
  }

  async function loadLog() {
    const { log } = await api('GET', `/api/monitor/log?${qs({ errors: $('#ml-errors').checked ? '1' : '' })}`);
    const body = $('#ml-table tbody');
    body.textContent = '';
    if (!log.length) body.append(h('tr', {}, h('td', { colspan: '7', class: 'muted' }, $('#ml-errors').checked ? 'No problems. 🎉' : 'No checks yet.')));
    for (const l of log.slice(0, 100)) body.append(logRow(l));
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  let filterTimer = null;
  const refilter = () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => Promise.all([loadProducts(), loadFeed()]).catch(showError), 200); };
  $('#m-q').addEventListener('input', refilter);
  for (const id of ['#m-category', '#m-store', '#m-status']) $(id).addEventListener('change', refilter);
  $('#m-kind').addEventListener('change', () => loadFeed().catch(showError));
  $('#m-more').addEventListener('click', () => loadFeed(true).catch(showError));
  $('#m-add-toggle').addEventListener('click', () => { const f = $('#m-add'); f.hidden = !f.hidden; if (!f.hidden) $('#ma-url').focus(); });

  $('#m-add').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.target, async () => {
      const url = $('#ma-url').value.trim();
      const body = url ? { url } : { store: $('#ma-store').value, sku: $('#ma-sku').value.trim() };
      Object.assign(body, { category: $('#ma-category').value || undefined, intervalSeconds: $('#ma-interval').value || undefined, kinds: ticked($('#ma-kinds')) });
      try {
        const r = await api('POST', '/api/monitor/monitors', body);
        setMsg($('#ma-msg'), r.created ? `Monitoring ${r.product.name || r.product.sku} — first check in a moment.` : 'That product is already monitored.', true);
        $('#ma-url').value = '';
        $('#ma-sku').value = '';
        await loadProducts();
      } catch (err) {
        setMsg($('#ma-msg'), err.message);
      }
    });
  });

  $('#mr-new').addEventListener('click', () => editRoute(null));
  $('#mr-cancel').addEventListener('click', () => { $('#mr-form').hidden = true; });
  $('#mr-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.target, async () => {
      const id = $('#mr-id').value;
      const body = {
        name: $('#mr-name').value, channelId: $('#mr-channel').value.trim(), roleId: $('#mr-role').value.trim(), keywords: $('#mr-keywords').value,
        enabled: $('#mr-enabled').checked, kinds: ticked($('#mr-kinds')), categories: ticked($('#mr-categories')), stores: ticked($('#mr-stores')),
      };
      try {
        await api(id ? 'PUT' : 'POST', id ? `/api/monitor/routes/${id}` : '/api/monitor/routes', body);
        $('#mr-form').hidden = true;
        await loadRoutes();
      } catch (err) {
        setMsg($('#mr-msg'), err.message);
      }
    });
  });
  $('#mh-refresh').addEventListener('click', () => Promise.all([loadHealth(), loadLog()]).catch(showError));

  $('#ms-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.target, async () => {
      const stores = Object.fromEntries($$('#ms-stores select').map((sel) => [sel.dataset.store, sel.value]));
      try {
        const d = await api('PUT', '/api/monitor/sweep', {
          enabled: $('#ms-enabled').checked, keywords: $('#ms-keywords').value, everySeconds: $('#ms-every').value, browserEverySeconds: $('#ms-bevery').value,
          priceDropPercent: $('#ms-drop').value, newAlerts: $('#ms-new').checked, restockAlerts: $('#ms-restock').checked, restockOncePerDay: $('#ms-once').checked,
          skipMarketplace: $('#ms-market').checked, tcgOnly: $('#ms-tcg').checked, tcgTerms: $('#ms-terms-input').value, stores,
        });
        fillSweepForm(d);
        renderSweep(d);
        setMsg($('#ms-msg'), 'Saved. New keywords and filters start by noting what\'s already there, so the first search of each doesn\'t alert.', true);
      } catch (err) {
        setMsg($('#ms-msg'), err.message);
      }
    });
  });
  $('#ms-reset-terms').addEventListener('click', () => { if (m.sweepDefaults) $('#ms-terms-input').value = m.sweepDefaults.tcgTerms.join(', '); });
  $('#ms-now').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('POST', '/api/monitor/sweep/now', {});
      toast('Sweeping now', 'Every store is searched again straight away.', 'success');
      setTimeout(() => loadSweep({ form: false }).catch(() => null), 3000);
    } catch (err) {
      toast("Couldn't start a sweep", err.message, 'warn');
    } finally {
      e.target.disabled = false;
    }
  });
  $('#ml-errors').addEventListener('change', () => loadLog().catch(showError));

  const dlg = $('#m-detail');
  $('#md-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { if (location.hash.startsWith('#monitor/')) history.replaceState(null, '', '#monitor'); m.current = null; });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // click outside the box

  const monitorId = () => m.current && m.current.monitor && m.current.monitor.id;
  const afterChange = async () => { await openProduct(m.current.product.id); await loadProducts(); };
  $('#md-settings').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.target, async () => {
      try {
        await api('PUT', `/api/monitor/monitors/${monitorId()}`, {
          name: $('#md-sname').value, category: $('#md-category').value, intervalSeconds: $('#md-interval').value || null, note: $('#md-note').value, kinds: ticked($('#md-kinds')),
        });
        await afterChange();
        setMsg($('#md-msg'), 'Saved.', true);
      } catch (err) {
        setMsg($('#md-msg'), err.message);
      }
    });
  });
  $('#md-pause').addEventListener('click', async () => {
    try {
      await api('PUT', `/api/monitor/monitors/${monitorId()}`, { paused: !m.current.monitor.paused });
      await afterChange();
    } catch (err) { setMsg($('#md-msg'), err.message); }
  });
  $('#md-check').addEventListener('click', async () => {
    try {
      await api('POST', `/api/monitor/monitors/${monitorId()}/check`, {});
      setMsg($('#md-msg'), 'Checking — results in a few seconds.', true);
      setTimeout(() => { if (m.current) openProduct(m.current.product.id).catch(() => null); }, 5000);
    } catch (err) { setMsg($('#md-msg'), err.message); }
  });
  $('#md-remove').addEventListener('click', async () => {
    if (!confirm(`Stop monitoring ${m.current.product.name || m.current.product.sku}? Its history is kept.`)) return;
    try {
      await api('DELETE', `/api/monitor/monitors/${monitorId()}`);
      dlg.close();
      await loadProducts();
    } catch (err) { setMsg($('#md-msg'), err.message); }
  });

  // ---------------------------------------------------------------------------
  // Live updates (from the dashboard's event stream)
  // ---------------------------------------------------------------------------
  function onFeed(a) {
    if (a.kind === 'restock') toast(`${KINDS.restock.emoji} ${a.status === 'preorder' ? 'Pre-order open' : 'In stock'}: ${a.name}`, `${storeName(a.store)} · ${money(a.price)} — see the Monitor tab`, 'urgent', 15000);
    if (!panelOpen()) return;
    const list = $('#m-feed');
    $('.empty', list)?.remove();
    const kind = $('#m-kind').value;
    const f = filters();
    const fits = (!kind || kind === a.kind || (kind === 'price' && a.kind.startsWith('price'))) && (!f.category || f.category === a.category) && (!f.store || f.store === a.store);
    if (fits) {
      const li = feedItem(a);
      li.classList.add('new');
      list.prepend(li);
    }
    schedule();
  }

  // A product changed: its row updates in place; a product that isn't listed yet brings a refresh.
  function onProduct(p) {
    if (!panelOpen()) return;
    const row = p && $(`#m-products li[data-id="${CSS.escape(p.id)}"]`);
    const known = p && m.products.find((x) => x.id === p.id);
    if (row && known) {
      const merged = { ...known, ...p, monitor: known.monitor };
      m.products[m.products.indexOf(known)] = merged;
      row.replaceWith(productRow(merged));
      if (m.current && m.current.product.id === p.id) openProduct(p.id).catch(() => null);
      clearTimeout(m.statsTimer);
      m.statsTimer = setTimeout(() => api('GET', '/api/monitor').then((d) => renderStats(d.overview)).catch(() => null), 1500);
      return;
    }
    schedule();
  }

  // Several changes at once (a round of checks) → one refresh.
  function schedule() {
    clearTimeout(m.timer);
    m.timer = setTimeout(async () => {
      try {
        const data = await api('GET', '/api/monitor');
        renderStats(data.overview);
        await loadProducts();
        if (m.current) await openProduct(m.current.product.id);
      } catch { /* the next update will try again */ }
    }, 600);
  }

  return { load, openProduct, onFeed, onProduct, onSweep };
}
