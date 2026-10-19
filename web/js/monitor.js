// The dashboard's Monitor tab (docs/MONITORING.md): the live feed of new
// drops, restocks and price changes, health numbers, every tracked product
// with filters, and a product page with its price history. Admins also run
// the live sweeps, add and change monitors, set up the Discord alert
// channels, and see health and the check log here.
import { $, $$, ago, api, busy, h, money, renderPager, setMsg, toast, when } from './common.js';
import { setupLive, slotOf } from './live.js';

const KINDS = {
  restock: { emoji: '🟢', label: 'In stock' },
  listed: { emoji: '🆕', label: 'New drop' },
  sold_out: { emoji: '🔴', label: 'Sold out' },
  price_drop: { emoji: '📉', label: 'Price drop' },
  price_rise: { emoji: '📈', label: 'Price up' },
};
const STATUS = {
  in_stock: 'In stock', preorder: 'Pre-order', out_of_stock: 'Sold out', coming_soon: 'Coming soon', in_store: 'In store only', not_listed: 'Not listed yet',
  not_found: 'Page gone', blocked: 'Blocked by site', error: 'Check failed', unknown: 'Unknown', pending: 'Waiting for first check',
};
const CATEGORY = { pokemon: 'Pokémon', onepiece: 'One Piece', other: 'Other', nontcg: 'Non-TCG' };
// Server first (every store's default): Mugibot's server searches it; an admin's browser stands in only while it's refused.
const MODES = { auto: 'Server first', server: 'Server only', browser: "Admin's browser", off: 'Off' };
const DAY = 86400000;
const SVG = 'http://www.w3.org/2000/svg';

export function setupMonitor({ showError, watching = () => null, watch: addToWatchlist = null }) {
  const m = { admin: false, stores: [], alerts: [], products: [], current: null, loaded: false, timer: null, sweep: null, page: 1, member: false };
  // The Monitor's pages: Live (everyone), Settings and Check log (admins).
  const panelOpen = () => !$('[data-panel="monitor"]').hidden;
  const settingsOpen = () => !$('[data-panel="monitor-settings"]').hidden;
  // (Another website's product — a drop watch's: monitor/drops.js — goes by its address, with no ⚡ Buy.)
  const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };
  const storeName = (id, url = '') => (id === 'other' && hostOf(url)) || (m.stores.find((s) => s.id === id) || {}).name || (id === 'other' ? 'Another website' : id);
  const canBuy = (id) => !!(m.stores.find((s) => s.id === id) || {}).buy;
  const filters = () => ({ q: $('#m-q').value.trim(), category: $('#m-category').value, store: $('#m-store').value, status: $('#m-status').value });
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();
  const buyUrl = (a) => `/buy?${qs({ store: a.store, sku: a.sku, url: a.url, name: a.name })}`;
  const live = setupLive({
    storeName, buyUrl, canBuy, panelOpen: () => panelOpen() || settingsOpen(), openProduct: (id) => openProduct(id),
    sampleProduct: () => m.products.find((p) => p.image && p.price) || m.products[0] || null,
    onSettings: (d) => { fillSweepForm(d); renderSweep(d); },
    resetStore: (id, button) => resetStore(id, button),
    setMode: (id, mode) => setMode(id, mode),
    // A store switched off (for you, or for everyone): the products list follows.
    onStores: () => { if (m.loaded) loadProducts().catch(() => null); },
  });

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------
  /** What every Monitor page needs: the stores, and whether you're an admin. False: not a member yet. */
  async function base() {
    let data;
    try {
      data = await api('GET', '/api/monitor');
    } catch (e) {
      if (e.status !== 402) throw e;
      const box = $('#m-paywall');
      box.textContent = '';
      box.append(h('div', { class: 'notice warn' }, h('b', {}, 'The live monitor is for members. '), h('a', { href: '#membership' }, 'Start your membership'), ' to see every store\'s searches, new drops and restocks as they happen. Your watchlist and activity are below.'));
      // (Your own lists stay: only the live parts are for members.)
      $('#sn-shell').classList.add('locked');
      $('[data-panel="monitor"]').classList.add('locked');
      m.member = false;
      return false;
    }
    $('#m-paywall').textContent = '';
    $('#sn-shell').classList.remove('locked');
    $('[data-panel="monitor"]').classList.remove('locked');
    m.member = true;
    m.admin = data.admin;
    m.stores = data.stores;
    if (!m.loaded) fillChoices();
    m.loaded = true;
    $('#m-add-toggle').hidden = !m.admin;
    $('#ms-now').hidden = !m.admin;
    $$('.mon-tabs').forEach((n) => { n.hidden = !m.admin; });
    return true;
  }

  // Live: the sonar, the stores, the feed and the products.
  async function load() {
    if (!(await base())) return;
    // (The stores you've switched off come with the live view: the products list leaves them out.)
    await live.load();
    await loadProducts();
  }

  // Settings (admins): the stores and where they're searched from, keywords, alerts, Discord channels.
  async function loadSettings() {
    if (!(await base())) return;
    if (!m.admin) { location.hash = '#monitor'; return; }
    await Promise.all([live.load(), loadSweep(), loadRoutes(), loadVip()]);
  }

  // Check log (admins): page checks and how each store answered.
  async function loadChecks() {
    if (!(await base())) return;
    if (!m.admin) { location.hash = '#monitor'; return; }
    await Promise.all([loadHealth(), loadLog()]);
  }

  // Tracked products: 25 to a page, asked for a page at a time, with the real total (all of them, not
  // only what one page shows). Stores you've switched off are left out by the server (unless you pick one).
  const PRODUCTS_PAGE_SIZE = 25;
  async function loadProducts() {
    const f = filters();
    const key = JSON.stringify(f);
    if (key !== m.filterKey) m.page = 1;
    const ask = async (page) => api('GET', `/api/monitor/products?${qs({ ...f, page, size: PRODUCTS_PAGE_SIZE })}`);
    let d = await ask(Math.max(1, m.page || 1));
    const pages = Math.max(1, Math.ceil((d.total || 0) / PRODUCTS_PAGE_SIZE));
    // (Fewer than before — a page past the end now: the last one.)
    if ((m.page || 1) > pages) { m.page = pages; d = await ask(pages); }
    // (The same page again — a live update: what wasn't on it before flashes.)
    const same = key === m.filterKey && m.shownPage === m.page;
    const seen = new Set(m.products.map((p) => p.id));
    m.fresh = same && m.products.length ? new Set(d.products.filter((p) => !seen.has(p.id)).map((p) => p.id)) : new Set();
    m.products = d.products;
    m.total = d.total || 0;
    m.filterKey = key;
    m.shownPage = m.page;
    $('#m-count').textContent = m.total.toLocaleString();
    renderProducts();
  }

  function renderProducts() {
    const list = $('#m-products');
    const products = m.products;
    list.textContent = '';
    renderPager($('#m-pager'), {
      page: m.page || 1, size: PRODUCTS_PAGE_SIZE, total: m.total || 0, label: 'Tracked products',
      onPage: (p) => { m.page = p; loadProducts().then(() => $('#m-lists').scrollIntoView({ block: 'start', behavior: 'smooth' })).catch(showError); },
    });
    if (!products.length) {
      const f = filters();
      list.append(h('li', { class: 'empty' }, f.q || f.category || f.store || f.status
        ? 'Nothing matches those filters.' : m.admin ? 'Nothing tracked yet — the live sweeps fill this in within a minute (or press + Add monitor).' : 'No products are being tracked yet.'));
    }
    for (const p of products) {
      const r = productRow(p);
      if (m.fresh && m.fresh.has(p.id)) r.classList.add('flash');
      list.append(r);
    }
  }

  /** Your watchlist changed: the ☆ Watch buttons follow. */
  function refreshWatched() {
    if (m.loaded && m.products.length) renderProducts();
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
    if (p.kind !== 'sold_out' && canBuy(p.store)) out.push(h('a', { class: 'btn small primary', href: buyUrl(p), title: 'Adds it to your watchlist and opens the store with ⚡ Buy' }, '⚡ Buy'));
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
        h('div', { class: 'meta' }, `${storeName(a.store, a.url)} · `, money(a.price) || '—', ' ', was, ` · ${CATEGORY[a.category] || ''} · `, h('time', { datetime: new Date(a.at).toISOString(), title: when(a.at) }, ago(a.at)), a.note ? ` · ${a.note}` : '')),
      actions(a, { compact: true }));
  }

  function statusPill(p) {
    const label = STATUS[p.status] || p.status;
    const unsure = !p.confirmed && p.status !== 'pending' ? ' (unconfirmed)' : '';
    return h('span', { class: `pill ${p.status}`, title: p.error || (p.checkedAt ? `Checked ${ago(p.checkedAt)}` : '') }, label + unsure);
  }

  const isNewProduct = (p) => !!(p.sweep && p.sweep.firstAt && Date.now() - p.sweep.firstAt < DAY);

  // One tracked product: picture, name, store, price (and the old one), stock, the last change, ⚡ Buy.
  function productRow(p) {
    const was = typeof p.previousPrice === 'number' && p.previousPrice !== p.price ? h('s', { class: 'muted small' }, money(p.previousPrice)) : null;
    const diff = typeof p.previousPrice === 'number' && typeof p.price === 'number' ? Math.round((p.price - p.previousPrice) * 100) / 100 : 0;
    const acts = [];
    if (p.status !== 'not_found' && canBuy(p.store)) acts.push(h('a', { class: 'btn small primary', href: buyUrl(p), target: '_blank', rel: 'noopener', title: 'Adds it to your watchlist and runs your checkout with the extension' }, '⚡ Buy'));
    if (p.url) acts.push(h('a', { class: 'btn small', href: p.url, target: '_blank', rel: 'noopener', 'aria-label': `Open ${p.name || p.sku} at the store` }, '↗'));
    // On your watchlist (its own checks and DMs, and Auto-checkout) — or one click away.
    const mine = watching(p);
    if (mine) {
      acts.push(h('a', { class: 'btn small watching', href: '#watch', title: mine.aco ? 'On your watchlist, armed for Auto-checkout' : 'On your watchlist', 'aria-label': `${p.name || p.sku} is on your watchlist` }, mine.aco ? '★ 🤖' : '★'));
    } else if (addToWatchlist && p.status !== 'not_found') {
      const b = h('button', { class: 'btn small watch', type: 'button', title: 'Watch it: on your watchlist, with your own checks, a DM when it\'s in stock, and Auto-checkout', 'aria-label': `Watch ${p.name || p.sku}` }, '☆');
      b.addEventListener('click', async () => { b.disabled = true; await addToWatchlist(p); });
      acts.push(b);
    }
    return h('li', { class: `product ${p.monitor && p.monitor.paused ? 'paused' : ''}`, dataset: { id: p.id } },
      thumb(p.image, p.name || p.sku),
      h('div', { class: 'info' },
        h('button', { class: 'link-btn name', type: 'button', onclick: () => openProduct(p.id), title: p.name || p.sku }, p.name || p.sku),
        h('div', { class: 'meta' }, isNewProduct(p) ? h('span', { class: 'pill info new-tag', title: `Found ${ago(p.sweep.firstAt)}` }, '🆕 New') : null,
          ` SKU ${p.sku}${p.monitor && p.monitor.paused ? ' · ⏸ paused' : ''}${p.sweep && p.sweep.seenAt ? ` · seen ${ago(p.sweep.seenAt)}` : ''}`)),
      h('div', { class: 'store' }, h('span', { class: `sn-swatch s${slotOf(p.store)}`, 'aria-hidden': 'true' }), storeName(p.store, p.url)),
      h('div', { class: 'price' }, h('b', {}, money(p.price) || '—'), ' ', was),
      h('div', { class: 'state' }, statusPill(p), h('div', { class: 'muted small' }, p.statusAt ? `since ${ago(p.statusAt)}` : '')),
      h('div', { class: `delta ${diff < 0 ? 'down' : diff > 0 ? 'up' : ''}`, title: diff ? `Was ${money(p.previousPrice)}` : 'No price change' }, diff < 0 ? `▼ ${money(-diff)}` : diff > 0 ? `▲ ${money(diff)}` : '—'),
      h('div', { class: 'acts' }, ...acts));
  }

  // ---------------------------------------------------------------------------
  // One product: details, price history, alerts; admins: settings and check log
  // ---------------------------------------------------------------------------
  /** Admins: this product never pings again (it goes on the blacklist, and its monitor is removed). */
  async function blacklist(p) {
    if (!confirm(`Put ${p.name || p.sku} (${storeName(p.store)}) on the blacklist? It won't ping or show here again, and its monitor is removed. You can take it off in Admin → Blacklist.`)) return;
    try {
      await api('POST', '/api/admin/blacklist', { store: p.store, sku: p.sku, name: p.name || '' });
      toast('On the blacklist', `${p.name || p.sku} won't ping again.`, 'success');
      $('#m-detail').close();
      await loadProducts();
    } catch (e) {
      toast("Couldn't do that", e.message, 'warn');
    }
  }

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
    // (Not on sale before: no old price — append() would write a missing one as "null".)
    state.append(statusPill(p), ' ', h('b', { class: 'big-price' }, money(p.price) || '—'), ...(was ? [' ', was] : []));
    const acts = $('#md-actions');
    acts.textContent = '';
    acts.append(actions({ ...p, kind: p.status === 'out_of_stock' ? 'sold_out' : 'restock' }));
    if (d.cartUrl) $('.acts', acts).append(h('a', { class: 'btn small', href: d.cartUrl, target: '_blank', rel: 'noopener', title: "The store's own add-to-cart link" }, '🛒 Add to cart'));
    if (m.admin) $('.acts', acts).append(h('button', { class: 'btn small', type: 'button', title: 'Never ping for this product again (Admin → Blacklist)', onclick: () => blacklist(p) }, '🚫 Blacklist'));

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
  // --- The live sweeps ---------------------------------------------------------
  function fillSweepForm(d) {
    const s = d.settings;
    m.sweepDefaults = d.defaults;
    $('#ms-enabled').checked = s.enabled;
    $('#ms-every').value = s.everySeconds;
    $('#ms-bevery').value = s.browserEverySeconds;
    $('#ms-drop').value = s.priceDropPercent;
    $('#ms-new').checked = s.newAlerts;
    $('#ms-restock').checked = s.restockAlerts;
    $('#ms-price').checked = s.priceAlerts;
    $('#ms-once').checked = s.restockOncePerDay;
    $('#ms-market').checked = s.skipMarketplace;
    $('#ms-tcg').checked = s.tcgOnly;
    $('#ms-terms-input').value = s.tcgTerms.join(', ');
    $('#ms-notcard-input').value = (s.notCardTerms || []).join(', ');
  }

  const retryIn = (at) => {
    const secs = Math.round((at - Date.now()) / 1000);
    return secs <= 1 ? 'trying again now' : secs < 90 ? `trying again in ${secs} s` : `trying again in ${Math.round(secs / 60)} min`;
  };

  function renderSweep(d) {
    m.sweep = d;
    const live = d.stores.filter((s) => s.mode !== 'off');
    const state = $('#ms-state');
    state.className = `pill ${!d.monitorEnabled || !d.settings.enabled ? '' : live.some((s) => s.fails > 2) ? 'warn' : 'ok'}`;
    state.textContent = !d.monitorEnabled ? 'Off (MONITOR_ENABLED=0)' : !d.settings.enabled ? 'Off' : `On · ${live.length} store${live.length === 1 ? '' : 's'}`;
    const body = $('#ms-table tbody');
    body.textContent = '';
    for (const s of d.stores) {
      const rate = s.requests1h ? Math.round((s.ok1h / s.requests1h) * 100) : null;
      const status = s.mode === 'off' ? h('span', { class: 'muted' }, '—')
        : s.fails ? h('span', { class: `pill ${s.fails > 2 ? 'err' : 'warn'}`, title: s.lastError }, `${s.lastError || 'Failing'}${s.nextAt ? ` · ${retryIn(s.nextAt)}` : ''}`)
          : s.backup ? h('span', { class: 'pill warn', title: `Mugibot's server: ${s.backup.why || 'refused'}` }, `Admin's browser standing in · server ${s.backup.retryAt ? `tries again ${new Date(s.backup.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'trying again now'}`)
          : s.slowedUntil ? h('span', { class: 'pill warn', title: 'Searched at a third of the pace for a while (after a refusal, or a reset)' }, `Gentle until ${new Date(s.slowedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)
            : s.lastOkAt ? h('span', { class: 'pill ok', title: s.lastError || '' }, s.lastError || 'OK')
            : h('span', { class: 'pill' }, s.source === 'browser' ? "Waiting for an admin's browser" : 'Starting');
      const id = s.id || s.store;
      // Where it's searched from: changes straight away.
      const sel = h('select', { 'aria-label': `${s.name}: searched from`, dataset: { store: id } },
        ...Object.entries(MODES).map(([v, label]) => h('option', { value: v, selected: s.mode === v }, `${label}${v === s.defaultMode ? ' (default)' : ''}`)));
      sel.addEventListener('change', () => setMode(id, sel.value));
      body.append(h('tr', { class: s.mode === 'off' ? 'muted' : '', dataset: { store: id } },
        h('td', {}, h('b', {}, s.name), s.avgMs ? h('div', { class: 'muted small' }, `answers in ${(s.avgMs / 1000).toFixed(1)} s`) : null),
        h('td', {}, sel),
        h('td', {}, status),
        h('td', {}, s.lastAt ? h('time', { title: when(s.lastAt) }, ago(s.lastAt)) : '—'),
        h('td', {}, String(s.products24h)),
        h('td', {}, s.requests1h ? `${s.requests1h}${rate !== null ? ` · ${rate}% OK` : ''}` : '—'),
        h('td', {}, s.mode === 'off' ? '' : h('button', { class: 'btn small', type: 'button', title: `Start ${s.name}'s searches again`, onclick: (e) => resetStore(id, e.currentTarget) }, '↻ Reset'))));
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

  // Reset a store (or every store: id null) that keeps failing: see Sweeper.reset on the server.
  async function resetStore(id, button) {
    if (button) button.disabled = true;
    try {
      await api('POST', '/api/monitor/sweep/reset', id ? { store: id } : {});
      toast(id ? `Reset ${storeName(id)}` : 'Reset every store', 'Searching again now, gently for 10 minutes. Anything the store asked to wait for is still waited for.', 'success');
      setTimeout(() => { if (settingsOpen()) loadSweep({ form: false }).catch(() => null); }, 1500);
    } catch (err) {
      toast("Couldn't reset", err.message, 'warn');
    } finally {
      if (button) button.disabled = false;
    }
  }

  // Where a store is searched from (server first, the server only, an admin's browser, or off): saved straight away.
  async function setMode(id, mode) {
    try {
      const current = m.sweep ? m.sweep.settings.stores : (await api('GET', '/api/monitor/sweep')).settings.stores;
      const d = await api('PUT', '/api/monitor/sweep', { stores: { ...current, [id]: mode } });
      renderSweep(d);
      live.setSettings(d.settings);
      toast(`${storeName(id)}: ${MODES[mode].toLowerCase()}`, mode === 'browser' ? "Searched from an admin's browser with the extension from now on." : mode === 'off' ? 'No more searches there.'
        : mode === 'auto' ? "Searched from Mugibot's server; an admin's browser stands in only while the store refuses it." : "Searched from Mugibot's server only, from now on.", 'success');
    } catch (err) {
      toast("Couldn't change that", err.message, 'warn');
      if (m.sweep) renderSweep(m.sweep);
    }
  }

  // Each search: the live console straight away; the admins' table at most every 2 seconds.
  function onSweep(ev) {
    live.onSweep(ev);
    if (!m.admin || !settingsOpen() || m.sweepTimer) return;
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
      const scope = r.fallback ? 'Whatever no other rule takes' : [r.categories.length ? r.categories.map((c) => CATEGORY[c]).join(', ') : 'All categories', r.stores.length ? r.stores.map(storeName).join(', ') : 'all stores'].join(' · ');
      list.append(h('li', { class: r.enabled ? '' : 'off' },
        h('div', { class: 'info' },
          h('div', { class: 'name' }, r.name, r.fallback ? h('span', { class: 'pill info' }, 'catch-all') : null, r.enabled ? '' : ' (off)'),
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

  // ⭐ VIP drops: admins' watches (a store and words, or a product page), posted in #vip-drop.
  async function loadVip() {
    renderVip(await api('GET', '/api/monitor/vip'));
  }

  function renderVip(d) {
    const sel = $('#vip-store');
    if (sel.options.length <= 1) for (const s of d.stores) sel.append(h('option', { value: s.id }, `${s.name}${s.mode === 'off' ? ' (sweeps off)' : ''}`));
    $('#vip-meta').textContent = d.watches.length ? `${d.watches.length} watch${d.watches.length === 1 ? '' : 'es'}` : 'None yet';
    $('#vip-channel').textContent = d.route ? `Posting in ${d.route.name}${d.route.enabled ? '' : ' (its rule is off)'} ✓` : 'No #vip-drop channel yet — until there is, VIP drops go to the store channels.';
    $('#vip-setup').textContent = d.route ? 'Set up #vip-drop again' : 'Make the #vip-drop channel';
    const list = $('#vip-list');
    list.textContent = '';
    for (const w of d.watches) {
      const what = w.url ? 'Product page' : `${w.storeName || w.store}: every word of "${w.words}"`;
      const bits = [
        w.url ? w.url : '',
        w.dropAt ? `drops ${new Date(w.dropAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : 'no drop time',
        w.maxPrice !== null ? `🤖 auto-checkout for ${w.acoUserName || 'you'} up to ${money(w.maxPrice)}` : '',
      ].filter(Boolean).join(' · ');
      const ARM = { armed: ' · 🤖 armed', pending: ' · checking whether it\'s on sale yet', skipped: ' · on sale before the watch: not armed' };
      const found = w.found.length ? h('div', { class: 'meta' }, 'Found: ', ...w.found.map((p, i) => h('span', {}, i ? ', ' : '', h('a', { href: p.url || '#', target: '_blank', rel: 'noopener' }, p.name || p.id), ` (${STATUS[p.status] || p.status}${typeof p.price === 'number' ? `, ${money(p.price)}` : ''}${ARM[p.arm] || ''})`)))
        : h('div', { class: 'meta' }, w.url ? 'Reading the page…' : 'Nothing with those words yet — it alerts the moment something shows up.');
      list.append(h('li', {},
        h('div', { class: 'info' },
          h('div', { class: 'name' }, w.label || what, w.fastNow ? h('span', { class: 'pill info' }, `⚡ every ${w.url ? d.fastSeconds : d.sweepSeconds} s`) : null),
          h('div', { class: 'meta' }, w.label ? `${what} · ${bits}` : bits), found),
        h('div', { class: 'acts' }, h('button', {
          class: 'btn small danger', type: 'button',
          onclick: async () => { if (!confirm(`Remove the VIP watch "${w.label || what}"?${w.maxPrice !== null ? ' What it armed for Auto-checkout is disarmed.' : ''}`)) return; renderVip(await api('DELETE', `/api/monitor/vip/${w.id}`)); },
        }, 'Remove'))));
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
    $('#mr-catchall').checked = !!(r && r.fallback);
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
  const refilter = () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => { m.page = 1; loadProducts().catch(showError); }, 200); };
  $('#m-q').addEventListener('input', refilter);
  for (const id of ['#m-category', '#m-store', '#m-status']) $(id).addEventListener('change', refilter);
  $('#m-kind').addEventListener('change', () => live.setFilter($('#m-kind').value));
  $('#m-more').addEventListener('click', () => live.loadOlder().catch(showError));
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
        fallback: $('#mr-catchall').checked,
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
      try {
        const d = await api('PUT', '/api/monitor/sweep', {
          enabled: $('#ms-enabled').checked, everySeconds: $('#ms-every').value, browserEverySeconds: $('#ms-bevery').value,
          priceDropPercent: $('#ms-drop').value, newAlerts: $('#ms-new').checked, restockAlerts: $('#ms-restock').checked, priceAlerts: $('#ms-price').checked, restockOncePerDay: $('#ms-once').checked,
          skipMarketplace: $('#ms-market').checked, tcgOnly: $('#ms-tcg').checked, tcgTerms: $('#ms-terms-input').value, notCardTerms: $('#ms-notcard-input').value,
        });
        fillSweepForm(d);
        renderSweep(d);
        live.setSettings(d.settings);
        setMsg($('#ms-msg'), 'Saved. New filters start by noting what\'s already there, so the first search after doesn\'t alert.', true);
      } catch (err) {
        setMsg($('#ms-msg'), err.message);
      }
    });
  });
  $('#ms-reset-terms').addEventListener('click', () => {
    if (!m.sweepDefaults) return;
    $('#ms-terms-input').value = m.sweepDefaults.tcgTerms.join(', ');
    $('#ms-notcard-input').value = m.sweepDefaults.notCardTerms.join(', ');
  });
  $('#ms-reset-all').addEventListener('click', (e) => resetStore(null, e.currentTarget));
  $('#vip-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const drop = $('#vip-drop').value;
    const body = {
      store: $('#vip-store').value, words: $('#vip-words').value.trim(), url: $('#vip-url').value.trim(), label: $('#vip-label').value.trim(),
      dropAt: drop ? new Date(drop).getTime() : null, aco: $('#vip-aco').checked, maxPrice: $('#vip-max').value ? Number($('#vip-max').value) : null,
    };
    const form = e.target;
    busy(form, async () => {
      try {
        const d = await api('POST', '/api/monitor/vip', body);
        renderVip(d);
        form.reset();
        setMsg($('#vip-msg'), d.watch.url ? 'Added — its page is being read now.' : 'Added — searching for it now.', true);
        setTimeout(() => loadVip().catch(() => {}), 4000);
      } catch (err) {
        setMsg($('#vip-msg'), err.message);
      }
    });
  });
  $('#vip-setup').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    setMsg($('#vip-setup-msg'), 'Setting up…', true);
    try {
      const d = await api('POST', '/api/monitor/vip/channel', { roleId: $('#vip-role').value.trim() });
      setMsg($('#vip-setup-msg'), `Done: #${d.channel.name} ${d.channel.made ? 'made (in a "VIP" category)' : 'found'} — VIP drops are posted there now, and only there.`, true);
      renderVip(d);
      await loadRoutes();
    } catch (err) {
      setMsg($('#vip-setup-msg'), err.message);
    } finally {
      button.disabled = false;
    }
  });
  // "Set up store channels": the bot finds or makes a channel per store and game, with a rule each.
  $('#mr-setup').addEventListener('click', async (e) => {
    const replace = $('#mr-setup-replace').checked;
    if (replace && !confirm('Remove your other Discord alert rules, so only the store channels get alerts?')) return;
    const button = e.currentTarget;
    button.disabled = true;
    setMsg($('#mr-setup-msg'), 'Setting up…', true);
    try {
      const r = await api('POST', '/api/monitor/routes/setup', { roleId: $('#mr-setup-role').value.trim(), replace });
      setMsg($('#mr-setup-msg'), `Done: ${r.channels.length} channels (${r.made} made, ${r.channels.length - r.made} already there), ${r.added} new rule${r.added === 1 ? '' : 's'}${r.removed ? `, ${r.removed} removed` : ''}. Alerts go to each store's channel now; everything else to #misc-retailers.`, true);
      await loadRoutes();
    } catch (err) {
      setMsg($('#mr-setup-msg'), err.message);
    } finally {
      button.disabled = false;
    }
  });
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
    live.onFeed(a);
    if (panelOpen()) schedule(); // the product it's about has changed too
  }

  // A product changed: its row updates in place; a product that isn't listed yet brings a refresh.
  function onProduct(p) {
    if (!panelOpen()) return;
    const row = p && $(`#m-products li[data-id="${CSS.escape(p.id)}"]`);
    const known = p && m.products.find((x) => x.id === p.id);
    if (known) {
      const merged = { ...known, ...p, monitor: known.monitor };
      m.products[m.products.indexOf(known)] = merged;
      if (row) row.replaceWith(productRow(merged));
      if (m.current && m.current.product.id === p.id) openProduct(p.id).catch(() => null);
      return;
    }
    schedule();
  }

  // Several changes at once (a round of checks) → one refresh.
  function schedule() {
    clearTimeout(m.timer);
    m.timer = setTimeout(async () => {
      try {
        await loadProducts();
        if (m.current) await openProduct(m.current.product.id);
      } catch { /* the next update will try again */ }
    }, 600);
  }

  return { load, loadSettings, loadChecks, openProduct, onFeed, onProduct, onSweep, refreshWatched };
}
