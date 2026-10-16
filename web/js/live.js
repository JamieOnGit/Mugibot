// The Monitor tab's live console (docs/MONITORING.md): every store's searches
// as they happen. A sonar that pings when a store answers, each store's state,
// the keywords and tuning, the numbers, each store's response times, and the
// event log: every search, fault and alert, with the product's picture, price
// and ⚡ Buy. New drops and restocks also pop up (on any tab of the dashboard),
// with a sound and a desktop notification once alerts are armed.
//
// Everything here is real: it comes from the server's live sweeps
// (server/monitor/sweep.js) over the dashboard's event stream.
import { $, $$, api, h, money, setMsg, toast, when } from './common.js';

// Each store keeps its colour everywhere (validated categorical palette, see site.css --s1…--s8).
// The stores with live sweeps, one colour each (the 8-colour palette in site.css). Any other store
// (Amazon, other websites: no sweeps) is grey, and always shown with its name.
const SLOT_ORDER = ['kmart', 'bigw', 'target', 'ebgames', 'zing', 'jbhifi', 'toysrus', 'trainertown'];
export const slotOf = (id) => SLOT_ORDER.indexOf(String(id || '').replace(/^demo-/, '')) + 1;
const ABBR = { kmart: 'KM', bigw: 'BW', target: 'TG', ebgames: 'EB', zing: 'ZG', jbhifi: 'JB', toysrus: 'TR', trainertown: 'TT', amazon: 'AZ' };
const abbr = (id) => ABBR[String(id || '').replace(/^demo-/, '')] || String(id || '?').slice(0, 2).toUpperCase();
const STATE = { ok: ['ok', 'Searching'], slowed: ['warn', 'Slowed'], retrying: ['err', 'Retrying'], waiting: ['warn', 'Waiting'], starting: ['', 'Starting'] };
const ALERT = { listed: ['drop', 'New drop'], restock: ['restock', 'Restock'], price_drop: ['price', 'Price ↓'], price_rise: ['price', 'Price ↑'], sold_out: ['out', 'Sold out'] };
const LOG_MAX = 300;
const ROWS_MAX = 220;
const CHART_WINDOW = 5 * 60 * 1000;
const PREFS_KEY = 'mgb-live';
const POP_MS = 10000;

const pad = (n) => String(n).padStart(2, '0');
const clockOf = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
const msText = (ms) => (typeof ms === 'number' ? (ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`) : '—');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function loadPrefs() {
  const def = { sound: true, notify: true, popup: true, armed: false };
  try { return { ...def, ...(JSON.parse(localStorage.getItem(PREFS_KEY)) || {}) }; } catch { return def; }
}

export function setupLive({ storeName, buyUrl, openProduct, panelOpen, sampleProduct, onSettings }) {
  const L = {
    data: null, stores: new Map(), log: [], filter: '', admin: false, settings: null, skew: 0, pings: [], pingCount: 0, audio: null,
    queue: [], showing: null, popTimer: null, flashTimer: null, renderTimer: null, frame: null, beam: 0, ttns: [], olderBefore: null, loaded: false,
  };
  const prefs = loadPrefs();
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private window: this page only */ } };
  const serverNow = () => Date.now() + L.skew;
  const swatch = (id) => h('span', { class: `sn-swatch s${slotOf(id)}`, 'aria-hidden': 'true' });
  const thumb = (src, name) => (src ? h('img', { class: 'thumb', src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    : h('div', { class: 'thumb ph', 'aria-hidden': 'true' }, String(name || '?').slice(0, 1).toUpperCase()));

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------
  async function load() {
    const d = await api('GET', '/api/monitor/live');
    L.data = d;
    L.admin = d.admin;
    L.settings = d.settings;
    L.skew = d.now - Date.now();
    L.stores = new Map(d.stores.map((s) => [s.id, s]));
    L.ttns = [];
    const known = new Set(L.log.filter((x) => x.alert && x.alert.test).map((x) => x.alert.id));
    L.log = [
      ...d.events.map((ev) => ({ at: ev.at, ev })),
      ...d.alerts.map((a) => ({ at: a.at, alert: a })),
      ...L.log.filter((x) => x.alert && known.has(x.alert.id)),
    ].sort((a, b) => a.at - b.at).slice(-LOG_MAX);
    L.olderBefore = d.alerts.length ? d.alerts.at(-1).id : null;
    $('#m-more').hidden = d.alerts.length < 40;
    L.loaded = true;
    renderAll();
    renderLog();
    start();
  }

  function renderAll() {
    renderStats();
    renderChannels();
    renderKeywords();
    renderTuning();
    renderChart();
    renderArm();
    const on = L.data && L.data.running && L.settings && L.settings.enabled;
    $('#sn-sweeping').textContent = on ? 'sweeping' : 'off';
    $('#sn-sweeping').classList.toggle('off', !on);
    $('#sn-active').textContent = String(L.stores.size);
  }

  // Many events a second → one redraw of the counters, stores and chart.
  function scheduleRender() {
    if (L.renderTimer) return;
    L.renderTimer = setTimeout(() => {
      L.renderTimer = null;
      if (!panelOpen() || !L.data) return;
      renderStats();
      renderChannels();
      renderChart();
    }, 700);
  }

  // ---------------------------------------------------------------------------
  // The numbers
  // ---------------------------------------------------------------------------
  function meanAlertMs() {
    const all = [...(L.data && typeof L.data.meanAlertMs === 'number' ? [L.data.meanAlertMs] : []), ...L.ttns];
    return all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length) : null;
  }

  function renderStats() {
    const box = $('#m-stats');
    if (!L.data) return;
    const d = L.data;
    const o = d.overview;
    const t = d.totals;
    const tile = (k, v, s = '', id = '') => h('div', { class: 'sn-stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v', id: id || null }, ...[].concat(v)), s ? h('div', { class: 's' }, s) : null);
    const mean = meanAlertMs();
    box.textContent = '';
    box.append(
      tile('Uptime', d.startedAt ? hms(serverNow() - d.startedAt) : '—', d.startedAt ? `since ${clockOf(d.startedAt)}` : 'sweeps not running here', 'sn-up'),
      tile('Searches', t.searches.toLocaleString(), `${(o.sweeps1h || 0).toLocaleString()} / hour`),
      tile('Drops · 24 h', String((o.drops24h || 0) + (o.restocks24h || 0)), `${o.drops24h || 0} new · ${o.restocks24h || 0} restocks`),
      tile('Mean alert time', mean === null ? ['—', h('small', {}, ' ms')] : [String(mean), h('small', {}, ' ms')], 'answer → screen'),
      tile('Errors / streak', [h('span', { class: 'bad' }, String(t.errors)), ' / ', h('span', { class: 'good' }, String(t.streak))], 'fails / in a row'),
      tile('Available now', String(o.available || 0), `of ${o.tracked || 0} tracked`),
    );
  }

  // ---------------------------------------------------------------------------
  // Stores
  // ---------------------------------------------------------------------------
  const sortedStores = () => [...L.stores.values()].sort((a, b) => (slotOf(a.id) || 99) - (slotOf(b.id) || 99) || a.name.localeCompare(b.name));

  function nextText(s) {
    if (!s.nextAt) return '—';
    const left = s.nextAt - serverNow();
    if (s.fails) return left > 1000 ? `backing off · ${Math.ceil(left / 1000)} s` : 'now';
    return left > 1000 ? `in ${Math.ceil(left / 1000)} s` : 'now';
  }

  function renderChannels() {
    const box = $('#sn-channels');
    box.textContent = '';
    const list = sortedStores();
    $('#sn-stores-meta').textContent = `${list.length} active`;
    if (!list.length) {
      box.append(h('p', { class: 'sn-empty' }, L.settings && !L.settings.enabled ? 'Live sweeps are switched off.' : 'No stores are being swept.'));
      return;
    }
    for (const s of list) {
      const [cls, label] = STATE[s.status] || STATE.starting;
      const waiting = s.status === 'waiting';
      box.append(h('div', { class: 'sn-chan', dataset: { store: s.id } },
        h('div', { class: 'hd' }, swatch(s.id), h('span', {}, s.name), h('span', { class: `sn-state ${cls}`, title: s.lastError || '' }, label)),
        h('div', { class: 'sn-rows' },
          h('div', { class: 'r' }, h('span', {}, 'searches'), h('b', {}, s.searches.toLocaleString())),
          h('div', { class: 'r' }, h('span', {}, 'last answer'), h('b', {}, msText(s.lastMs))),
          h('div', { class: 'r' }, h('span', {}, 'next search'), h('b', { class: 'sn-next' }, nextText(s))),
          h('div', { class: 'r' }, h('span', {}, 'from'), h('b', {}, `${s.mode === 'browser' ? "admin's browser" : 'server'} · ${s.endpoint}`)),
          s.fails || s.lastError ? h('div', { class: 'r' }, h('span', {}, s.fails ? 'problem' : 'note'), h('b', {}, s.lastError || `${s.fails} failed`)) : null,
          waiting ? h('div', { class: 'r' }, h('span', {}, ''), h('b', {}, "Keep Chrome open with the extension connected to an admin account")) : null)));
    }
  }

  // ---------------------------------------------------------------------------
  // Keywords and tuning
  // ---------------------------------------------------------------------------
  async function saveSweep(patch, msgEl = null) {
    try {
      const d = await api('PUT', '/api/monitor/sweep', patch);
      L.settings = d.settings;
      if (onSettings) onSettings(d);
      renderKeywords();
      renderTuning();
      return d;
    } catch (e) {
      if (msgEl) setMsg(msgEl, e.message);
      else toast("Couldn't change the sweeps", e.message, 'warn');
      renderKeywords();
      renderTuning();
      return null;
    }
  }

  function renderKeywords() {
    const s = L.settings;
    if (!s) return;
    const box = $('#sn-chips');
    box.textContent = '';
    for (const kw of s.keywords) {
      const chip = h('span', { class: 'sn-chip' }, kw);
      if (L.admin) {
        chip.append(h('button', {
          type: 'button', 'aria-label': `Stop searching for ${kw}`,
          onclick: () => saveSweep({ keywords: s.keywords.filter((k) => k !== kw) }),
        }, '×'));
      }
      box.append(chip);
    }
    $('#sn-kw-count').textContent = plural(s.keywords.length, 'keyword');
    $('#sn-kw-form').hidden = !L.admin;
    $('#sn-kw-note').textContent = L.admin
      ? 'Each keyword is searched at every store. A product counts when its name has every word of the keyword and a trading-card word in it. A new keyword starts by noting what is already there, without alerts.'
      : 'Every store is searched for these. Admins choose them.';
  }

  function sw(label, on, onchange, { disabled = false } = {}) {
    const b = h('button', { class: 'sn-sw', type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled });
    b.addEventListener('click', () => {
      const next = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', next ? 'true' : 'false');
      onchange(next);
    });
    return h('div', { class: 'sn-set' }, h('span', {}, label), b);
  }

  function range(label, aria, value, min, max, unit, onchange) {
    const val = h('span', { class: 'val' }, `${value} ${unit}`);
    const input = h('input', { type: 'range', min: String(min), max: String(Math.max(max, value)), step: '1', value: String(value), 'aria-label': aria });
    input.addEventListener('input', () => { val.textContent = `${input.value} ${unit}`; });
    input.addEventListener('change', () => onchange(Number(input.value)));
    return h('div', { class: 'sn-set sn-range' }, h('span', {}, label), h('div', { class: 'ctl' }, input, val));
  }

  function renderTuning() {
    const s = L.settings;
    const box = $('#sn-tuning');
    if (!s) return;
    box.textContent = '';
    if (L.admin) {
      box.append(
        h('div', { class: 'sn-set-title' }, 'Search every (admins)'),
        range('Server stores', 'Search every, stores swept from the server (seconds)', s.everySeconds, 3, 15, 's', (v) => saveSweep({ everySeconds: v })),
        range('Browser stores', "Search every, stores swept from an admin's browser (seconds)", s.browserEverySeconds, 5, 60, 's', (v) => saveSweep({ browserEverySeconds: v })),
        h('div', { class: 'sn-set-title' }, 'Alerts (everyone)'),
        sw('New drops', s.newAlerts, (v) => saveSweep({ newAlerts: v })),
        sw('Restocks', s.restockAlerts, (v) => saveSweep({ restockAlerts: v })),
        sw(`Price drops (${s.priceDropPercent}% or more)`, s.priceAlerts, (v) => saveSweep({ priceAlerts: v })),
      );
    } else {
      box.append(h('p', { class: 'sn-note' }, `Each store is searched every ${s.everySeconds} s (stores that refuse servers: every ${s.browserEverySeconds} s from an admin's browser). Alerts: ${[s.newAlerts && 'new drops', s.restockAlerts && 'restocks', s.priceAlerts && `price drops of ${s.priceDropPercent}% or more`].filter(Boolean).join(', ') || 'none'}.`));
    }
    box.append(
      h('div', { class: 'sn-set-title' }, 'This browser'),
      sw('Sound', prefs.sound, (v) => { prefs.sound = v; savePrefs(); if (v) chirp('listed'); }),
      sw('Desktop notifications', prefs.notify, async (v) => {
        prefs.notify = v;
        savePrefs();
        if (v && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission().catch(() => null);
        if (v && 'Notification' in window && Notification.permission === 'denied') toast('Desktop notifications are blocked', 'Allow them for this site in your browser (the icon next to the address).', 'warn');
      }),
      sw('Pop-up for drops and restocks', prefs.popup, (v) => { prefs.popup = v; savePrefs(); }),
    );
  }

  // ---------------------------------------------------------------------------
  // Response times: one line per store over the last 5 minutes, with a crosshair readout
  // ---------------------------------------------------------------------------
  const SVG = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

  function renderChart() {
    const box = $('#sn-chart');
    if (!box || !L.data) return;
    const stores = sortedStores();
    const now = serverNow();
    const all = stores.map((s) => ({ s, pts: (s.latency || []).filter((p) => p.at >= now - CHART_WINDOW && typeof p.ms === 'number') }));
    const series = all.filter((x) => x.pts.length);
    // The time span: the last 5 minutes, or less while there's less history (at least a minute).
    const earliest = series.length ? Math.min(...series.map((x) => x.pts[0].at)) : now;
    const span = Math.min(CHART_WINDOW, Math.max(60000, now - earliest + 5000));
    const t0 = now - span;
    box.textContent = '';
    const legend = $('#sn-legend');
    legend.textContent = '';
    renderLatencyTable(stores, now - CHART_WINDOW);
    if (!series.length) {
      box.append(h('div', { class: 'empty' }, 'No searches in the last 5 minutes yet.'));
      return;
    }
    const W = Math.max(300, Math.round(box.clientWidth - 28) || 640);
    const H = W < 500 ? 150 : 170;
    const pad = { l: 46, r: 12, t: 10, b: 22 };
    const max = Math.max(20, ...series.flatMap((x) => x.pts.map((p) => p.ms)));
    const raw = max / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= raw);
    const hi = Math.ceil(max / step) * step;
    const x = (t) => pad.l + ((t - t0) / span) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - v / hi) * (H - pad.t - pad.b);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', tabindex: '0', 'aria-label': `Response times over the last 5 minutes: ${series.map(({ s, pts }) => `${s.name} last ${msText(pts.at(-1).ms)}`).join(', ')}` });
    for (let v = 0; v <= hi + step / 2; v += step) {
      svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' }));
      const label = el('text', { x: pad.l - 6, y: y(v) + 3.5, 'text-anchor': 'end', class: 'axis' });
      label.textContent = v >= 1000 ? `${(v / 1000).toLocaleString()} s` : `${Math.round(v * 10) / 10} ms`;
      svg.append(label);
    }
    const ago = span >= CHART_WINDOW ? '5 min ago' : span >= 120000 ? `${Math.round(span / 60000)} min ago` : `${Math.round(span / 1000)} s ago`;
    for (const [t, anchor, text] of [[t0, 'start', ago], [now, 'end', 'now']]) {
      const label = el('text', { x: x(t), y: H - 6, 'text-anchor': anchor, class: 'axis' });
      label.textContent = text;
      svg.append(label);
    }
    for (const { s, pts } of series) {
      const cls = `s${slotOf(s.id)}`;
      let d = '';
      pts.forEach((p, i) => { d += `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.ms).toFixed(1)}`; });
      svg.append(el('path', { d, class: `line ${cls}` }));
      const last = pts.at(-1);
      svg.append(el('circle', { cx: x(last.at), cy: y(last.ms), r: 4, class: `end ${cls}` }));
      legend.append(h('span', {}, swatch(s.id), s.name, h('small', {}, msText(last.ms))));
    }
    const hair = el('line', { y1: pad.t, y2: H - pad.b, class: 'crosshair', visibility: 'hidden' });
    svg.append(hair);
    const tip = h('div', { class: 'sn-tip', hidden: true });
    box.append(svg, tip);
    let at = now;
    const show = (t) => {
      at = Math.max(t0, Math.min(now, t));
      const px = x(at);
      for (const [k, v] of [['x1', px], ['x2', px], ['visibility', 'visible']]) hair.setAttribute(k, v);
      tip.textContent = '';
      tip.append(h('div', { class: 'when' }, clockOf(at - L.skew)));
      for (const { s, pts } of series) {
        // The search nearest that moment (within 30 s).
        let best = null;
        for (const p of pts) if (!best || Math.abs(p.at - at) < Math.abs(best.at - at)) best = p;
        if (best && Math.abs(best.at - at) <= 30000) tip.append(h('div', { class: 'row' }, swatch(s.id), s.name, h('b', {}, msText(best.ms))));
      }
      tip.hidden = false;
      const r = svg.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max((px / W) * r.width + 14, 90), r.width - 70)}px`;
    };
    const hide = () => { hair.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      show(t0 + ((((e.clientX - r.left) / r.width) * W - pad.l) / (W - pad.l - pad.r)) * span);
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => show(now));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 10000); }
      if (e.key === 'ArrowRight') { e.preventDefault(); show(at + 10000); }
    });
  }

  function renderLatencyTable(stores, t0) {
    const body = $('#sn-lat-table tbody');
    body.textContent = '';
    for (const s of stores) {
      const pts = (s.latency || []).filter((p) => p.at >= t0 && typeof p.ms === 'number');
      const avg = pts.length ? pts.reduce((a, p) => a + p.ms, 0) / pts.length : null;
      body.append(h('tr', {}, h('td', {}, swatch(s.id), ' ', s.name), h('td', {}, msText(s.lastMs)), h('td', {}, msText(avg)),
        h('td', {}, pts.length ? msText(Math.max(...pts.map((p) => p.ms))) : '—'), h('td', {}, String(pts.length))));
    }
    if (!stores.length) body.append(h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'No stores are being swept.')));
  }

  // ---------------------------------------------------------------------------
  // The sonar: a sweeping beam; each store's blip rings when it answers
  // ---------------------------------------------------------------------------
  function sonarColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return { brand: v('--brand'), line: v('--line'), err: v('--err'), fg: v('--fg'), muted: v('--muted'), slot: (n) => v(`--s${n}`) || v('--muted') };
  }

  function blip(id, R, cx, cy) {
    const slot = slotOf(id) || 8;
    const a = -Math.PI / 2 + ((slot - 1) / 8) * Math.PI * 2 + 0.35;
    const r = slot % 2 ? 0.46 : 0.72;
    return { x: cx + Math.cos(a) * R * r, y: cy + Math.sin(a) * R * r };
  }

  function drawSonar(t) {
    const cv = $('#sn-sonar');
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(rect.width * dpr)) { cv.width = Math.round(rect.width * dpr); cv.height = Math.round(rect.height * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const hgt = rect.height;
    const cx = w / 2;
    const cy = hgt / 2;
    const R = Math.min(w, hgt) / 2 - 10;
    const c = L.colors || (L.colors = sonarColors());
    ctx.clearRect(0, 0, w, hgt);
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1;
    for (const f of [0.33, 0.66, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    ctx.globalAlpha = 1;
    if (!reduceMotion()) {
      for (let i = 0; i < 30; i++) {
        const a = L.beam - i * 0.03;
        ctx.globalAlpha = 0.45 * (1 - i / 30);
        ctx.strokeStyle = c.brand;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    for (const s of L.stores.values()) {
      const b = blip(s.id, R, cx, cy);
      ctx.fillStyle = c.slot(slotOf(s.id));
      ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = c.fg;
      ctx.font = '600 9px ui-monospace, Menlo, monospace';
      ctx.fillText(abbr(s.id), b.x + 7, b.y + 3);
    }
    L.pings = L.pings.filter((p) => t - p.t < 1000);
    for (const p of L.pings) {
      const s = L.stores.get(p.store);
      if (!s) continue;
      const k = (t - p.t) / 1000;
      const b = blip(s.id, R, cx, cy);
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.strokeStyle = p.err ? c.err : c.slot(slotOf(s.id));
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(b.x, b.y, 5 + (reduceMotion() ? 8 : k * 30), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function frame(t) {
    L.frame = null;
    if (!panelOpen() || document.hidden) return;
    L.beam += 0.02;
    drawSonar(t);
    if (!reduceMotion() || L.pings.length) L.frame = requestAnimationFrame(frame);
  }

  function animate() {
    if (!L.frame) L.frame = requestAnimationFrame(frame);
  }

  function ping(store, err) {
    L.pingCount += 1;
    $('#sn-pings').textContent = L.pingCount.toLocaleString();
    L.pings.push({ store, err, t: performance.now() });
    animate();
  }

  // Ticks once a second while the Monitor tab is open: the clock, uptime and "next search in…".
  let ticker = null;
  function start() {
    animate();
    if (ticker) return;
    ticker = setInterval(() => {
      if (!panelOpen()) return;
      $('#sn-clock').textContent = clockOf(Date.now());
      if (L.data && L.data.startedAt) {
        $('#sn-uptime').textContent = hms(serverNow() - L.data.startedAt);
        const up = $('#sn-up');
        if (up) up.textContent = hms(serverNow() - L.data.startedAt);
      }
      for (const row of $$('#sn-channels .sn-chan')) {
        const s = L.stores.get(row.dataset.store);
        const next = $('.sn-next', row);
        if (s && next) next.textContent = nextText(s);
      }
      animate();
    }, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) animate(); });
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { L.colors = null; });
    new MutationObserver(() => { L.colors = null; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ---------------------------------------------------------------------------
  // The event log
  // ---------------------------------------------------------------------------
  function passes(item) {
    const f = L.filter;
    if (!f) return true;
    const kind = item.alert ? item.alert.kind : null;
    const type = item.ev ? item.ev.type : null;
    if (f === 'alerts') return !!item.alert || type === 'out';
    if (f === 'listed') return kind === 'listed';
    if (f === 'restock') return kind === 'restock';
    if (f === 'price') return kind === 'price_drop' || kind === 'price_rise';
    if (f === 'searches') return type === 'hb';
    if (f === 'problems') return type === 'err' || (type === 'sys' && item.ev.level === 'warn');
    return true;
  }

  function row(cls, tag, at, body, extra = null, acts = null, alert = false) {
    return h('div', { class: `sn-ev k-${cls}${alert ? ' alert' : ''}` },
      h('span', { class: 't' }, h('time', { datetime: new Date(at - L.skew).toISOString(), title: when(at - L.skew) }, clockOf(at - L.skew))),
      h('span', { class: 'tag' }, tag), ...[].concat(body), extra !== null ? h('span', { class: 'x' }, extra) : null, acts);
  }

  function actions(p) {
    const out = [];
    out.push(h('a', { class: 'btn small primary', href: buyUrl(p), target: '_blank', rel: 'noopener', title: 'Adds it to your watchlist and runs your checkout with the extension' }, '⚡ Buy'));
    if (p.url) out.push(h('a', { class: 'btn small', href: p.url, target: '_blank', rel: 'noopener', 'aria-label': `Open ${p.name} at the store` }, '↗'));
    return h('div', { class: 'acts' }, ...out);
  }

  function nameButton(p) {
    return p.productId || p.id ? h('button', { class: 'link-btn name', type: 'button', onclick: () => openProduct(p.productId || p.id) }, p.name) : h('span', { class: 'name' }, p.name);
  }

  function alertRow(a) {
    const [cls, label] = ALERT[a.kind] || ALERT.restock;
    const tag = a.kind === 'restock' && a.status === 'preorder' ? 'Pre-order' : label;
    const was = typeof a.previousPrice === 'number' && a.previousPrice !== a.price ? h('s', {}, money(a.previousPrice)) : null;
    const body = [
      thumb(a.image, a.name),
      h('span', { class: 'm' }, swatch(a.store), ' ', `${storeName(a.store)} · `, nameButton(a), ' — ', h('b', {}, money(a.price) || '—'), was ? ' ' : '', was,
        a.note ? ` · ${a.note}` : '', a.manual ? ' · reported by an admin' : '', a.test ? ' · test (this browser only)' : ''),
    ];
    const extra = typeof a.ttnMs === 'number' ? `alerted in ${msText(a.ttnMs)}` : '';
    return row(cls, tag, a.at, body, extra, a.kind === 'sold_out' ? null : actions(a), true);
  }

  function eventRow(ev) {
    const store = ev.store ? [swatch(ev.store), ' '] : [];
    switch (ev.type) {
      case 'hb': {
        const bits = [];
        if (ev.found !== ev.kept) bits.push(`${ev.kept} count`);
        if (ev.new) bits.push(`${ev.new} new`);
        if (ev.restock) bits.push(plural(ev.restock, 'restock'));
        if (ev.price) bits.push(plural(ev.price, 'price drop'));
        if (ev.baseline) bits.push('first look (no alerts)');
        if (ev.error) bits.push(ev.error);
        return row('hb', 'Search', ev.at, h('span', { class: 'm' }, ...store, `${ev.storeName} · "${ev.keyword}"${ev.page > 1 ? ` page ${ev.page}` : ''} — `, h('b', {}, plural(ev.found, 'product')), bits.length ? ` · ${bits.join(' · ')}` : '',
          ev.source === 'browser' ? " · admin's browser" : ''), msText(ev.ms));
      }
      case 'err':
        return row('err', 'Fault', ev.at, h('span', { class: 'm' }, ...store, `${ev.storeName} · "${ev.keyword}" — ${ev.error || 'failed'}`), ev.ms ? msText(ev.ms) : '');
      case 'out':
        return row('out', 'Gone', ev.at, [thumb(ev.product.image, ev.product.name),
          h('span', { class: 'm' }, ...store, `${ev.storeName} · `, nameButton(ev.product), ' dropped out of the results — counted as sold out')], '');
      default:
        return row('sys', 'System', ev.at, h('span', { class: 'm' }, ev.message || ''), '');
    }
  }

  const rowFor = (item) => (item.alert ? alertRow(item.alert) : eventRow(item.ev));

  function renderLog() {
    const feed = $('#m-log');
    feed.textContent = '';
    const shown = L.log.filter(passes).slice(-ROWS_MAX).reverse();
    if (!shown.length) feed.append(h('div', { class: 'empty' }, L.filter ? 'Nothing like that yet.' : 'Waiting for the first search…'));
    for (const item of shown) feed.append(rowFor(item));
  }

  function addLog(item) {
    L.log.push(item);
    if (L.log.length > LOG_MAX) L.log.shift();
    if (!panelOpen() || !passes(item)) return;
    const feed = $('#m-log');
    $('.empty', feed)?.remove();
    const before = feed.scrollHeight;
    const r = rowFor(item);
    feed.prepend(r);
    // Someone reading further down: keep what they're reading where it is.
    if (feed.scrollTop > 0) feed.scrollTop += feed.scrollHeight - before;
    while (feed.children.length > ROWS_MAX) feed.lastChild.remove();
  }

  async function loadOlder() {
    if (!L.olderBefore) return;
    const { alerts } = await api('GET', `/api/monitor/alerts?before=${encodeURIComponent(L.olderBefore)}`);
    const feed = $('#m-log');
    for (const a of alerts) {
      const item = { at: a.at, alert: a };
      L.log.unshift(item);
      if (passes(item)) feed.append(rowFor(item));
    }
    L.olderBefore = alerts.length ? alerts.at(-1).id : null;
    $('#m-more').hidden = alerts.length < 30;
  }

  // ---------------------------------------------------------------------------
  // The alert chain: pop-up, sound, desktop notification, a flashing tab title
  // ---------------------------------------------------------------------------
  function renderArm() {
    const b = $('#sn-arm');
    const armed = !!(L.audio && L.audio.state === 'running');
    b.setAttribute('aria-pressed', armed ? 'true' : 'false');
    b.textContent = armed ? '🔔 Alerts armed' : '🔔 Arm alerts';
  }

  async function arm() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && !L.audio) L.audio = new Ctx();
      if (L.audio && L.audio.state !== 'running') await L.audio.resume();
    } catch { /* no sound in this browser */ }
    let perm = 'Notification' in window ? Notification.permission : 'denied';
    if (prefs.notify && perm === 'default') perm = await Notification.requestPermission().catch(() => 'denied');
    prefs.armed = true;
    savePrefs();
    renderArm();
    chirp('listed');
    toast('Alerts armed', perm === 'granted' ? 'A sound and a desktop notification for every new drop and restock.' : 'A sound for every new drop and restock. Desktop notifications are blocked: allow them for this site in your browser.', 'success');
  }

  function chirp(kind) {
    if (!prefs.sound || !L.audio || L.audio.state !== 'running') return;
    try {
      const t0 = L.audio.currentTime;
      const notes = kind === 'restock' ? [988, 1319, 1760] : kind === 'price_drop' ? [880] : [1244, 1864];
      notes.forEach((f, i) => {
        const o = L.audio.createOscillator();
        const g = L.audio.createGain();
        const at = t0 + i * 0.13;
        o.type = 'square';
        o.frequency.setValueAtTime(f, at);
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.12, at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
        o.connect(g).connect(L.audio.destination);
        o.start(at);
        o.stop(at + 0.24);
      });
    } catch { /* ignore */ }
  }

  function desktop(a, label) {
    if (!prefs.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(`${label}: ${a.name}`, {
        body: `${storeName(a.store)} · ${money(a.price) || 'price not shown'}${a.test ? ' (test)' : ''}`, icon: a.image || '/img/icon-192.png', tag: `mugibot-${a.id}`,
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some browsers only allow notifications from a service worker */ }
  }

  function titleFlash(text) {
    clearInterval(L.flashTimer);
    if (document.hasFocus() && !document.hidden) return;
    const base = document.title;
    let on = true;
    L.flashTimer = setInterval(() => { document.title = on ? `● ${text}` : base; on = !on; }, 800);
    const stop = () => { clearInterval(L.flashTimer); document.title = base; window.removeEventListener('focus', stop); };
    window.addEventListener('focus', stop);
    setTimeout(stop, 15000);
  }

  function alertChain(a) {
    const label = a.kind === 'restock' ? (a.status === 'preorder' ? 'Pre-order open' : 'Restock') : 'New drop';
    chirp(a.kind);
    desktop(a, label);
    titleFlash(`${label}: ${a.name}`);
    $('#sn-announce').textContent = `${label}: ${a.name}, ${money(a.price) || ''} at ${storeName(a.store)}`;
    if (prefs.popup) {
      L.queue.push(a);
      if (!L.showing) nextPop();
    }
  }

  function nextPop() {
    clearInterval(L.popTimer);
    const a = L.queue.shift();
    const ov = $('#sn-overlay');
    if (!a) { L.showing = null; ov.hidden = true; return; }
    L.showing = a;
    const card = $('.sn-dropcard', ov);
    card.classList.toggle('restock', a.kind === 'restock');
    card.classList.toggle('test', !!a.test);
    $('#sn-ov-type').textContent = `${a.test ? 'Test · ' : ''}${a.kind === 'restock' ? (a.status === 'preorder' ? 'Pre-order open' : 'Restock') : 'New drop'}`;
    const st = $('#sn-ov-store');
    st.textContent = '';
    st.append(swatch(a.store), storeName(a.store));
    $('#sn-ov-title').textContent = a.name;
    $('#sn-ov-price').textContent = money(a.price) || 'Price not shown';
    $('#sn-ov-was').textContent = typeof a.previousPrice === 'number' && a.previousPrice !== a.price ? `was ${money(a.previousPrice)}` : '';
    $('#sn-ov-sku').textContent = a.sku;
    $('#sn-ov-ttn').textContent = typeof a.ttnMs === 'number' ? `alerted ${msText(a.ttnMs)} after ${storeName(a.store)} answered` : '';
    const img = $('#sn-ov-img');
    img.hidden = !a.image;
    if (a.image) img.src = a.image;
    $('#sn-ov-buy').href = buyUrl(a);
    const open = $('#sn-ov-open');
    open.hidden = !a.url;
    if (a.url) open.href = a.url;
    ov.hidden = false;
    let left = POP_MS;
    let last = Date.now();
    const bar = $('#sn-ov-bar');
    const tick = () => {
      const now = Date.now();
      if (!card.matches(':hover') && !card.contains(document.activeElement)) left -= now - last; // paused while you're on it
      last = now;
      if (left <= 0) { dismiss(); return; }
      bar.style.width = `${(left / POP_MS) * 100}%`;
      $('#sn-ov-cnt').textContent = `${L.queue.length ? `${L.queue.length} more · ` : ''}closes in ${Math.ceil(left / 1000)} s`;
    };
    tick();
    L.popTimer = setInterval(tick, 100);
  }

  function dismiss() {
    clearInterval(L.popTimer);
    $('#sn-overlay').hidden = true;
    L.showing = null;
    setTimeout(nextPop, 200);
  }

  $('#sn-ov-dismiss').addEventListener('click', dismiss);
  $('#sn-ov-buy').addEventListener('click', () => setTimeout(dismiss, 100));
  $('#sn-overlay').addEventListener('click', (e) => { if (e.target.id === 'sn-overlay') dismiss(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && L.showing) dismiss(); });
  $('#sn-arm').addEventListener('click', () => arm().catch(() => null));
  // Armed before: the first click anywhere turns the sound back on (browsers need a click for sound).
  if (prefs.armed) {
    const resume = () => { document.removeEventListener('pointerdown', resume, true); if (!L.audio) arm().catch(() => null); };
    document.addEventListener('pointerdown', resume, true);
  }
  $('#sn-test').addEventListener('click', () => {
    const p = sampleProduct() || { id: null, store: 'kmart', sku: '43818648', name: 'Pokémon TCG: Example Elite Trainer Box', url: '', image: '', price: 89, category: 'pokemon' };
    const a = {
      id: `test-${Date.now()}`, kind: 'listed', productId: p.id, store: p.store, sku: p.sku, name: p.name, url: p.url, image: p.image, price: p.price,
      previousPrice: null, category: p.category, status: 'in_stock', note: '', at: serverNow(), ttnMs: null, test: true,
    };
    addLog({ at: a.at, alert: a });
    alertChain(a);
  });
  $('#sn-kw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#sn-kw-input');
    const kw = input.value.trim().toLowerCase();
    if (!kw || !L.settings) return;
    if (L.settings.keywords.includes(kw)) { input.value = ''; return; }
    if (await saveSweep({ keywords: [...L.settings.keywords, kw] })) {
      input.value = '';
      toast(`Searching every store for "${kw}"`, 'The first look notes what is already there; new ones after that alert.', 'success');
    }
  });

  // ---------------------------------------------------------------------------
  // Live updates (from the dashboard's event stream)
  // ---------------------------------------------------------------------------
  function onSweep(ev) {
    if (!ev || !L.data) return;
    if (ev.type === 'hb' || ev.type === 'err') {
      const s = L.stores.get(ev.store);
      if (s) {
        s.searches += 1;
        s.lastAt = ev.at;
        if (ev.type === 'hb') {
          s.fails = 0;
          s.lastOkAt = ev.at;
          if (typeof ev.ms === 'number') s.lastMs = ev.ms;
          s.lastError = ev.error || '';
          s.status = s.slowedUntil && s.slowedUntil > serverNow() ? 'slowed' : 'ok';
        } else {
          s.fails += 1;
          s.lastError = ev.error || 'Failed';
          s.status = 'retrying';
        }
        // When the next search comes: the set pace, slower after a refusal, doubling after each failure.
        const every = ((s.mode === 'browser' ? L.settings.browserEverySeconds : L.settings.everySeconds) || 5) * 1000;
        const slow = s.slowedUntil && s.slowedUntil > serverNow() ? 3 : 1;
        s.nextAt = ev.at + (ev.type === 'hb' ? every * slow : Math.min(15 * 60 * 1000, every * 2 ** Math.min(s.fails, 10)));
        s.latency = [...(s.latency || []), { at: ev.at, ms: ev.ms, ok: ev.type === 'hb' }].filter((p) => p.at >= serverNow() - 2 * CHART_WINDOW).slice(-300);
      } else {
        refreshSoon(); // a store that just started being swept
      }
      const t = L.data.totals;
      t.searches += 1;
      if (ev.type === 'hb') t.streak += 1;
      else { t.errors += 1; t.streak = 0; }
      ping(ev.store, ev.type === 'err');
    } else if (ev.type === 'sys' && /changed the sweeps|started|switched off|searching it/.test(ev.message || '')) {
      refreshSoon();
    }
    addLog({ at: ev.at, ev });
    scheduleRender();
  }

  // The next search times come with the store's state: fetch it again shortly after a burst of changes.
  let refreshTimer = null;
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (!panelOpen()) return;
      try {
        const d = await api('GET', '/api/monitor/live');
        L.data = { ...d, events: [] };
        L.settings = d.settings;
        L.skew = d.now - Date.now();
        L.stores = new Map(d.stores.map((s) => [s.id, s]));
        renderAll();
      } catch { /* the next event tries again */ }
    }, 1500);
  }
  // Every 20 s while open: the stores' next-search times and the counters from the server.
  setInterval(() => { if (panelOpen() && L.loaded && !document.hidden) refreshSoon(); }, 20000);

  function onFeed(a) {
    if (!a) return;
    if (typeof a.ttnMs === 'number') L.ttns.push(a.ttnMs);
    if (L.data) {
      const o = L.data.overview;
      if (a.kind === 'listed') o.drops24h = (o.drops24h || 0) + 1;
      if (a.kind === 'restock') o.restocks24h = (o.restocks24h || 0) + 1;
    }
    addLog({ at: a.at, alert: a });
    if (a.kind === 'listed' || a.kind === 'restock') alertChain(a);
    else if (a.kind === 'price_drop') chirp('price_drop');
    scheduleRender();
  }

  function setFilter(f) {
    L.filter = f;
    renderLog();
  }

  function setSettings(s) {
    L.settings = s;
    renderKeywords();
    renderTuning();
  }

  return { load, onSweep, onFeed, setFilter, setSettings, loadOlder, render: renderAll, renderLog };
}
