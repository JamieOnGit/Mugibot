// Mugibot — runs on store pages. Shows the small panel, runs Add to bag →
// Checkout when you press a Mugibot button (the panel, or ⚡ Buy in your
// dashboard or a Discord ping), carries it across page changes, then fills
// in checkout up to the final button — which you press yourself. Every step
// follows this store's own flow from your Mugibot server.

(async () => {
  'use strict';
  if (window.top !== window.self) return;

  const ASSIST_KEY = 'mgbAssist';
  const ASSIST_TTL = 15 * 60 * 1000;

  const ask = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res));
    } catch {
      resolve(null); // the extension was updated; refresh the page
    }
  });

  const state = await ask({ type: 'state' });
  const items = (state && state.items) || [];
  const retailers = MGBFlows.revive((state && state.flows) || []);
  const retailer = MGBFlows.forLocation(retailers, location);
  if (!retailer) return; // not a store Mugibot has a flow for (or a page outside it)
  const checkoutFlow = MGBFlows.part(retailer, 'checkout');
  MGBFill.startFocusBroker(); // payment frames ask the page to focus their card boxes

  // The ⚡ Buy code: grabbed by capture.js as the page started loading (or still in the address).
  let goCode = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem('mgbGoCode') || 'null');
    sessionStorage.removeItem('mgbGoCode');
    if (saved && Date.now() - saved.at < 2 * 60 * 1000) goCode = saved.code;
  } catch { /* ignore */ }
  if (!goCode) {
    const m = location.hash.match(/mgb-go=([A-Za-z0-9_-]{8,64})/);
    if (m) goCode = m[1];
  }

  const store = MGBQuick.sessionStore('mgbFlow');
  const assistFlag = {
    on: (profileId) => { try { sessionStorage.setItem(ASSIST_KEY, JSON.stringify({ until: Date.now() + ASSIST_TTL, profileId: profileId || null })); } catch { /* ignore */ } },
    off: () => { try { sessionStorage.removeItem(ASSIST_KEY); } catch { /* ignore */ } },
    read: () => { try { const a = JSON.parse(sessionStorage.getItem(ASSIST_KEY) || 'null'); return a && Date.now() < a.until ? a : null; } catch { return null; } },
    active: () => !!assistFlag.read(),
  };
  let busy = false;
  let assisting = false;
  const report = (type, message, product) => ask({
    type: 'event',
    event: { type, message, sku: product ? product.sku : null, name: product ? product.name : null, url: location.href },
  });

  async function fillCheckout() {
    if (assisting || !assistFlag.active()) return;
    assisting = true;
    try {
      const flag = assistFlag.read();
      const data = await ask({ type: 'fillData', part: 'all', profileId: flag && flag.profileId });
      if (!data) {
        panel.setStatus('Couldn\'t get your delivery details from your account — fill in checkout yourself.');
        return;
      }
      const result = await MGBFill.assist({
        values: MGBFill.fieldValues(data.profile, data.card),
        flow: checkoutFlow,
        storeName: retailer.name,
        hasCard: !!data.card,
        cardIssue: data.cardIssue || null,
        setStatus: panel.setStatus,
        report: (type, message) => report(type === 'ready' ? 'ready' : type === 'error' ? 'error' : 'step', message, null),
        isActive: assistFlag.active,
      });
      if (result !== 'ready' && result !== 'stopped') assistFlag.off();
      if (result === 'done') ask({ type: 'endFill' });
      if (result === 'ready' && data.card && checkoutFlow && checkoutFlow.payment === 'card') checkCard();
    } finally {
      assisting = false;
    }
  }

  // The card goes into boxes on the page (fill.js) or into the payment provider's
  // frames (frame.js). If it went in nowhere, say so, and where the payment form came from.
  async function checkCard() {
    const onPage = () => [...document.querySelectorAll('input, select')]
      .some((el) => /^card(Number|Expiry|ExpMonth)$/.test(MGBFill.classifyField(el, checkoutFlow) || '') && MGBFill.isVisible(el) && el.value);
    // Payment frames type one box at a time (and try each box a few times), so give them a while.
    for (let i = 0; i < 20; i++) {
      if (!assistFlag.active()) return;
      if (onPage()) return;
      const frames = (await ask({ type: 'cardFrames' })) || [];
      if (frames.some((f) => f.filled > 0)) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const reached = ((await ask({ type: 'cardFrames' })) || []).filter((f) => f.seen > 0);
    const hostOf = (src) => { try { return new URL(src, location.href).host; } catch { return ''; } };
    const others = [...new Set([...document.querySelectorAll('iframe')].map((f) => hostOf(f.src)))].filter((h) => h && h !== location.host);
    const msg = reached.length
      ? `Your card didn't go into the card boxes (from ${reached[0].host}). Type it in yourself.`
      : `Mugibot couldn't reach the card boxes on this page${others.length ? ` (the payment form may be in a frame from ${others.slice(0, 3).join(', ')})` : ''}. Type your card in yourself.`;
    panel.setNote(msg);
    // What happened in each box (no card details), for fixing the store's flow.
    const detail = reached.map((f) => `${f.host}: ${f.detail || 'no detail'}`).join('; ');
    report('error', `Card not filled in at ${retailer.name}: ${msg}${detail ? ` [${detail}; page focused: ${document.hasFocus() ? 'yes' : 'no'}; extension ${chrome.runtime.getManifest().version}]` : ''}`, null);
  }

  async function go(fresh, extra = {}) {
    if (busy) return;
    busy = true;
    panel.startButton.disabled = true;
    try {
      const flow = store.read();
      const product = extra.product || MGBQuick.productForPage(items, retailer) || (flow ? items.find((p) => p.sku === flow.sku) : null) || null;
      const result = await MGBQuick.run({ fresh, retailer, product, products: items, store, setStatus: panel.setStatus, report, ...extra });
      // Same-page checkouts (no reload): carry straight on with the form.
      if (result === 'checkout') setTimeout(fillCheckout, 800);
    } catch {
      store.clear();
      panel.setStatus('Interrupted — please continue yourself.');
    } finally {
      busy = false;
      panel.startButton.disabled = false;
    }
  }

  const note = !state || !state.paired ? 'Not connected — click the Mugibot icon in your toolbar to connect your account.'
    : !state.online ? (items.length ? 'Offline — using your last saved list.' : 'Can\'t reach your account right now.')
      : state.active === false ? 'Your membership isn\'t active — start it in your dashboard to use ⚡ Buy and autofill.'
        : retailer.flowStatus === 'draft' ? `The ${retailer.name} flow hasn't been tested yet — watch each step.` : '';

  const panel = MGBQuick.makePanel({
    retailer,
    products: items,
    note,
    onStart: async () => {
      // Your click on the panel: fill in checkout afterwards too.
      const item = MGBQuick.productForPage(items, retailer);
      const ok = await ask({ type: 'startFill' });
      if (ok) assistFlag.on(item && item.profileId);
      go(true);
    },
    onStop: () => { store.clear(); assistFlag.off(); panel.setStatus('Stopped. You can continue yourself.'); },
  });

  if (goCode) {
    const claim = await ask({ type: 'claim', code: goCode });
    if (claim && claim.ok) {
      const listed = items.find((p) => p.id === claim.itemId) || items.find((p) => p.sku === claim.sku);
      const product = { ...(listed || {}), sku: claim.sku, name: claim.name || (listed && listed.name) || claim.sku, quantity: claim.quantity };
      assistFlag.on(claim.profileId);
      panel.setNote(`Started from ⚡ Buy · Qty ${claim.quantity}`);
      // The buy box can take a few seconds to appear on a fresh page load.
      const waitMs = (MGBFlows.part(retailer, 'product').waitMs) || 12000;
      go(true, { product, quantity: claim.quantity, waitForButtonMs: waitMs });
      return;
    }
    panel.setNote(!state || !state.paired ? 'This browser isn\'t connected to your account — click the Mugibot icon to connect, then press ⚡ Buy again.'
      : claim && claim.status === 402 ? (claim.error || 'Your membership isn\'t active — start it to use ⚡ Buy.')
        : claim === null || (claim && claim.status === 0) ? 'Couldn\'t reach your account to confirm the ⚡ Buy — check your connection.'
          : 'That ⚡ Buy link has expired or belongs to another account — press ⚡ Buy again.');
  }

  // Carry on where we left off after the store changed page.
  if (store.read()) go(false);
  else if (assistFlag.active()) fillCheckout();
})();
