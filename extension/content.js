// Mugibot — runs on store pages. Shows the small panel, takes you straight to
// checkout with the product in your bag when you press a Mugibot button (the
// panel, or ⚡ Buy in your dashboard or a Discord ping), carries it across
// page changes, then fills in checkout up to the final button — which you
// press yourself. Every step follows this store's own flow from your Mugibot
// server.
//
// Auto-checkout (docs/AUTO-CHECKOUT.md): a run for an item you armed opens this tab
// with its own ⚡ Buy code. Its limits come from your account, through the
// extension (never from this page). At the final button it checks the order —
// your card is in, nothing on the page is wrong, the total is within your limits —
// then presses it once, and watches what happens: the order confirmation, a
// declined card, or your bank's or the store's check (left for you: never got past).
//
// Checkpoints and virtual queues (docs/AUTO-CHECKOUT.md): on the store's checkpoint (JB Hi-Fi's
// hCaptcha page) it waits for you to solve it — it never touches the check — and carries on to
// checkout once you have. In the store's virtual queue it waits its turn with you and never
// refreshes the page (the queue page refreshes itself; refreshing it yourself can lose your place),
// then carries on with the ⚡ Buy or Auto-checkout run as soon as you're through.
//
// Several checkouts at once: a store keeps one bag for this browser, so checkouts at the same store
// take turns (the extension keeps the line). One whose store is busy with another of yours waits on
// its page — saying so — then reloads the page (what's in the bag now) and goes. Checkouts at
// different stores go side by side.

(async () => {
  'use strict';
  if (window.top !== window.self) return;

  const ASSIST_KEY = 'mgbAssist';
  const ASSIST_TTL = 15 * 60 * 1000;
  // A ⚡ Buy claimed in a store's queue (or at its checkpoint): kept for this tab until it's through.
  const HOLD_KEY = 'mgbHold';
  const HOLD_TTL = 3 * 60 * 60 * 1000;
  const holdStore = {
    read: () => { try { const h = JSON.parse(sessionStorage.getItem(HOLD_KEY) || 'null'); return h && Date.now() - h.at < HOLD_TTL ? h : null; } catch { return null; } },
    save: (h) => { try { sessionStorage.setItem(HOLD_KEY, JSON.stringify(h)); } catch { /* ignore */ } },
    clear: () => { try { sessionStorage.removeItem(HOLD_KEY); } catch { /* ignore */ } },
  };

  const ask = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res));
    } catch {
      resolve(null); // the extension was updated; refresh the page
    }
  });

  // A downloaded copy, with the Chrome Web Store copy installed too: that one does everything.
  if (!chrome.runtime.getManifest().update_url) {
    const storeCopy = document.documentElement.hasAttribute('data-mugibot-store');
    ask({ type: 'storeCopy', present: storeCopy });
    if (storeCopy) return;
  }

  // Payment frames ask the page to focus their card boxes: listening from the start, before anything is
  // asked of the extension (a checkout's frames can be ready first).
  MGBFill.startFocusBroker();

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

  // Your watchlist and the stores' flows, and the ⚡ Buy code confirmed — both at once. (A code claimed
  // already in this tab, in the store's queue, isn't claimed again: it carries on from there.)
  let held = holdStore.read();
  if (held && goCode && held.code !== goCode) { holdStore.clear(); held = null; }
  const claiming = goCode && !held ? ask({ type: 'claim', code: goCode }) : null;
  const state = await ask({ type: 'state' });
  if (state && state.sweepTab) return; // the extension's own window for live sweeps
  const items = (state && state.items) || [];
  const retailers = MGBFlows.revive((state && state.flows) || []);
  const retailer = MGBFlows.forLocation(retailers, location);
  // (A tab emptying a bag — Clear cart — sent somewhere that isn't the store: said, and left as it is.)
  if (!retailer && state && state.clear) { ask({ type: 'clearReport', id: state.clear.id, status: 'failed', removed: 0, message: `The tab went to ${location.host}${location.pathname}, not your ${state.clear.storeName || ''} bag`.slice(0, 300) }); return; }
  if (!retailer) return; // not a store Mugibot has a flow for (or a page outside it)
  const checkoutFlow = MGBFlows.part(retailer, 'checkout');

  // Clear cart (bag.js): this tab is your checkout browser emptying your bag here, pressed on your dashboard.
  if (state && state.clear) {
    const job = state.clear;
    const panel = MGBQuick.makePanel({ retailer, products: [], note: '🧹 Clear cart — from your dashboard' });
    panel.startButton.parentElement.style.display = 'none';
    // (keep: a bag it couldn't empty stays open in this tab, for you.)
    const tell = (status, removed, message, keep = true) => ask({ type: 'clearReport', id: job.id, status, removed, message: message || '', keep });
    // The store's queue (or checkpoint) where its bag should be: left alone (the tab's closed: out of line).
    const g = MGBFlows.gateHere(retailer, document, location);
    if (g) {
      panel.setStatus(`🧹 ${retailer.name}'s ${g.kind === 'queue' ? 'virtual queue' : 'checkpoint'} came up — your bag there was left alone.`);
      tell('failed', 0, `${retailer.name}'s ${g.kind === 'queue' ? 'virtual queue' : 'checkpoint'} came up instead of the bag — try again once it's down`, false);
      return;
    }
    MGBBag.run({ retailer, job, setStatus: panel.setStatus, report: tell, sayYes: () => ask({ type: 'clearSayYes' }) })
      .catch(() => tell('failed', 0, 'Something went wrong on the page — have a look in this tab'));
    return;
  }

  // The store login monitor (logins.js): are you signed in here? Read from the page as it settles
  // (headers often fill in a moment after the page loads); nothing is clicked.
  // A store that only sells to signed-in customers (Amazon: no guest checkout) says so in the panel.
  const signedOutHere = () => !!(retailer.account && retailer.account.required && globalThis.MGBLogins && MGBLogins.fromPage(document, retailer.account.check) === 'out');
  const SIGN_IN_FIRST = `${retailer.name} only sells to signed-in customers — sign in to ${retailer.name} in this browser first, then ⚡ Buy again.`;
  let lookLogin = () => {};
  if (retailer.account && globalThis.MGBLogins) {
    let said = null;
    lookLogin = () => {
      const status = MGBLogins.fromPage(document, retailer.account.check);
      // (how: read off the screen, for a store whose pages' source can't be read for it — Shop's.)
      if (status && status !== said) { said = status; ask({ type: 'login', store: retailer.id, status, how: retailer.account.check && retailer.account.check.onScreen ? 'screen' : 'page' }); }
      if (status === 'out' && retailer.account.required && !busy) { try { panel.setNote(SIGN_IN_FIRST); } catch { /* (the panel isn't up yet) */ } }
    };
    // (And just before a checkout's final button: a quick one may leave the page before these.)
    for (const ms of [300, 1200, 4000, 9000]) setTimeout(lookLogin, ms);
  }

  const store = MGBQuick.sessionStore('mgbFlow');
  // Waiting at the store's checkpoint (or in its queue) partway through a checkout: on the page after
  // it, your account hears it's through before anything else happens (endedElsewhere()).
  const gateWaitFlag = {
    on: (kind) => { try { sessionStorage.setItem('mgbGateWait', kind); } catch { /* ignore */ } },
    read: () => { try { return sessionStorage.getItem('mgbGateWait'); } catch { return null; } },
    clear: () => { try { sessionStorage.removeItem('mgbGateWait'); } catch { /* ignore */ } },
  };
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

  // ---------------------------------------------------------------------------
  // Auto-checkout
  // ---------------------------------------------------------------------------
  // The run in this tab (from its ⚡ Buy code, or — on later pages — from the tab's pass in the extension).
  let aco = null;
  const acoReport = (status, reason, message, total) => ask({ type: 'acoReport', status, reason: reason || '', message: message || '', total: typeof total === 'number' ? total : undefined });
  // Why a run stopped short of checkout (core.js): failed, unless it's something for you to do (sign in).
  // (The store's queue, drawn by its page's code after Mugibot looked: not a failure — it waits there, see go().)
  const acoWhy = (reason, message, status) => {
    if (!aco || (claimed && seenGate())) return;
    acoReport(status || 'failed', reason, message || null);
  };

  // (The checks themselves: checks.js, shared with checkouts that run in a frame.)
  const orderTotal = () => MGBChecks.orderTotal(document);
  // A checkout that says it isn't on sale until the drop's live (checkout.waitLive: Shop checkout links'
  // "This Product is not available for purchase"): that notice isn't a reason not to press its final
  // button — the store says again when it's pressed (notLiveYet).
  const waitLive = !!(checkoutFlow && checkoutFlow.waitLive);
  const liveNotices = waitLive ? (checkoutFlow.waitLive.notices || []).filter((re) => re && re.test) : [];
  const pageError = (anew) => MGBChecks.pageError(document, [].concat((checkoutFlow && checkoutFlow.ignoreErrors) || [], liveNotices), anew);
  /** The checkout's "not on sale" notices on the screen (checkout.waitLive.notices). */
  const noticeEls = () => (liveNotices.length ? [...document.querySelectorAll('[role="alert"], [aria-live], p, div, span, li')]
    .filter((el) => el.children.length <= 2 && MGBFill.isVisible(el) && !el.closest('#mugibot-qc'))
    .filter((el) => { const t = (el.innerText || '').replace(/\s+/g, ' ').trim(); return t.length < 200 && liveNotices.some((re) => re.test(t)); }) : []);
  const noticeText = (els) => (els[0] ? (els[0].innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '');
  // (Those up before the final button is pressed are marked: only one the store shows anew is its answer to the press.)
  const markNotices = () => { for (const el of noticeEls()) el.setAttribute('data-mgb-seen', '1'); };
  const freshNotice = () => noticeText(noticeEls().filter((el) => !el.closest('[data-mgb-seen]')));
  const outcome = () => MGBChecks.outcome(document, checkoutFlow && checkoutFlow.done, retailer.name);
  const cardBoxesOnPage = () => [...document.querySelectorAll('input, select')]
    .filter((el) => /^card(Number|Expiry|ExpMonth|Cvc)$/.test(MGBFill.classifyField(el, checkoutFlow) || '') && MGBFill.isVisible(el));

  /**
   * Is the card in? On the page, in the payment provider's boxes, or — where neither shows any card
   * boxes — a card the store or its wallet already has for you (Shop Pay's "•••• 4242").
   */
  async function cardReady(whole) {
    const boxes = cardBoxesOnPage();
    const frames = (await ask({ type: 'cardFrames' })) || [];
    // whole: every card box done (before a "Done" button under them), not just the first one in.
    if (whole) {
      const pageDone = boxes.length > 0 && boxes.every((el) => el.value || !/^card(Number|Expiry|ExpMonth)$/.test(MGBFill.classifyField(el, checkoutFlow) || ''));
      const seen = frames.filter((f) => f.seen > 0);
      if (seen.length) return seen.every((f) => f.done) && (!boxes.length || pageDone);
      if (boxes.length) return pageDone;
      // (A card the store, Shop Pay or the payment provider already has for you: Stripe's Link, in its frame.)
      return MGBChecks.savedCardShown(document, checkoutFlow, false) || frames.some((f) => f.saved);
    }
    if (boxes.some((el) => el.value && /^card(Number|Expiry|ExpMonth)$/.test(MGBFill.classifyField(el, checkoutFlow) || ''))) return true;
    if (frames.some((f) => f.filled > 0)) return true;
    return !frames.some((f) => f.seen > 0) && (MGBChecks.savedCardShown(document, checkoutFlow, boxes.length > 0) || (!boxes.length && frames.some((f) => f.saved)));
  }

  /**
   * A store with a last "place order" stage after its final button (flow checkout.review: City
   * Beach's ?stage=placeOrder): that stage's own final button, pressed once in the run — never again,
   * even if the page comes back.
   */
  async function pressReview(run) {
    const R = checkoutFlow && checkoutFlow.review;
    if (!R || !(R.path instanceof RegExp) || !R.path.test(location.pathname + location.search)) return false;
    const key = `mgbReview:${run.id || ''}`;
    try { if (sessionStorage.getItem(key)) return false; } catch { return false; }
    const finals = (checkoutFlow.final || []).filter((re) => re instanceof RegExp);
    const btn = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
      .find((el) => MGBFill.isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && finals.some((re) => re.test((el.innerText || el.value || '').replace(/\s+/g, ' ').trim())));
    if (!btn) return false;
    try { sessionStorage.setItem(key, '1'); } catch { return false; }
    const text = (btn.innerText || btn.value || '').trim();
    report('step', `Auto-checkout pressed "${text}" on the last step (place order)`, null);
    panel.setStatus('🤖 Placing your order…');
    markNotices();
    btn.click();
    return true;
  }

  /** After the final button: what happened (up to 45 s here; a new page carries on by itself). */
  async function watchOutcome(run, total) {
    const started = Date.now();
    const until = started + 45000;
    let said = null;
    let errSince = 0;
    while (Date.now() < until) {
      await MGBFlows.wait(400);
      let o = outcome();
      if (!o && await pressReview(run)) continue;
      // The store said no to the final button (a Shop link's "not available for purchase"): a notice shown
      // anew since the press, the page still here 8 seconds on and its button free again — so nothing was
      // bought. It waits here for the sale. (The same notice merely still up is no answer: left as it is.)
      const notLive = !o && waitLive && Date.now() - started > 8000 && !finalBusy() ? freshNotice() : '';
      if (notLive) return notLiveYet(run, notLive, total);
      // The store refused the press (a box it says is wrong), and it's still saying so a few seconds on: for you.
      const err = o ? '' : pageError();
      errSince = err ? errSince || Date.now() : 0;
      if (!o && err && Date.now() - errSince > 4000) o = { status: 'needs_you', reason: 'needs_details', message: `${retailer.name} said: "${err}" — finish it yourself in this tab.` };
      if (!o || (said && said === o.status)) continue;
      said = o.status;
      if (o.status === 'placed') {
        panel.setStatus('🤖 Order placed.');
        await acoReport('placed', '', `Order confirmed at ${retailer.name}`, total);
        assistFlag.off();
        ask({ type: 'endFill' });
        return;
      }
      panel.setStatus(o.message);
      await acoReport(o.status, o.reason, o.message, total);
      if (o.status === 'failed') return;
    }
  }

  /** The final button, still working on the press (disabled, or busy): not yet the store's answer. */
  function finalBusy() {
    const finals = (checkoutFlow && checkoutFlow.final) || [];
    const btn = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
      .find((el) => MGBFill.isVisible(el) && finals.some((re) => re.test((el.innerText || el.value || '').trim())));
    return !btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.getAttribute('aria-busy') === 'true';
  }

  /**
   * Not on sale yet (checkout.waitLive): the store said "not available for purchase" to the final button,
   * or still says it now. Nothing was bought. The run waits on this checkout, everything in, and looks
   * again every few seconds (the page reloaded, like a person refreshing it): the final button is pressed
   * again only once the notice has gone. At most checkout.waitLive.forMs, then it stops and says so.
   */
  async function notLiveYet(run, words, total) {
    const W = checkoutFlow.waitLive;
    const every = Math.max(2, Math.round((W.everyMs || 5000) / 1000));
    const res = await ask({ type: 'acoReport', status: 'not_live', reason: 'not_live', message: `${retailer.name} says "${words}" — not on sale yet. Waiting on the checkout with everything in, looking again every ${every} s, to press "Pay now" the moment it is.`, total: typeof total === 'number' ? total : undefined });
    if (!res || !res.ok || res.over) {
      panel.setStatus(res && res.over ? `🤖 ${res.text || 'This run is over.'}` : `🤖 ${retailer.name} says "${words}" — nothing was bought.`);
      return;
    }
    if (Date.now() - res.since > (W.forMs || 30 * 60 * 1000)) {
      return acoStop('failed', 'not_live', `${retailer.name} still says "${words}" after ${Math.round((Date.now() - res.since) / 60000)} minutes — nothing was bought, and it's armed again for when it's on sale.`, null, total);
    }
    panel.setNote('🤖 Auto-checkout — waiting for it to go on sale');
    panel.setStatus(`⏳ ${retailer.name} says "${words}" — not on sale yet. Waiting here with everything filled in: looking again every ${every} s, and "Pay now" is pressed the moment it is.`);
    // (This tab stays in the run while it waits: its checkout flag kept, like its pass.)
    const flag = assistFlag.read();
    assistFlag.on(flag && flag.profileId);
    setTimeout(() => location.reload(), every * 1000);
  }

  /** Stop short of the final button, say why, and leave the rest to you. */
  async function acoStop(status, reason, message, fin, total) {
    panel.setStatus(`🤖 ${message}`);
    if (fin && fin.el) {
      fin.el.style.setProperty('outline', '4px solid #f59e0b', 'important');
      try { fin.el.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
    }
    await acoReport(status, reason, message, total);
  }

  /** The card is in — every box of it: on the page, or in the payment provider's boxes (up to 15 s for those). */
  async function cardIn() {
    // (Looked at four times a second: the final button is pressed the moment the card's in. A checkout
    //  still coming in — a busy drop — gets up to a minute for its card boxes.)
    for (let started = Date.now(); Date.now() - started < 15000 || (Date.now() - started < 60000 && MGBQuick.pageBusy());) {
      if (await cardReady(true)) return true;
      await MGBFlows.wait(250);
    }
    return false;
  }

  /**
   * A checkout that goes on to another address once its final button's pressed (checkout.leaves: Shop's,
   * on to the store's own order page — where Mugibot doesn't run): where it goes says how it went. The
   * store's order page: placed. Anywhere else: for you to check. (On to another page here: that page says.)
   */
  function watchLeaving(label, total) {
    const nav = globalThis.navigation;
    if (!nav || !nav.addEventListener) return;
    let said = false;
    const done = checkoutFlow.done instanceof RegExp ? checkoutFlow.done : /thank[-_]?you/i;
    nav.addEventListener('navigate', (e) => {
      let to = null;
      try { to = new URL(e.destination.url); } catch { return; }
      // (Another page of this checkout: that page says how it went.)
      if (said || MGBFlows.forLocation(retailers, to) === retailer) return;
      said = true;
      if (done.test(to.pathname)) acoReport('placed', '', `Order placed — ${retailer.name} went on to ${to.host}'s order page`, total);
      else acoReport('needs_you', 'unconfirmed', `"${label}" was pressed and ${retailer.name} went on to ${to.host} — check your email for the order confirmation before buying it again.`, total);
    });
  }

  /** The final button of this checkout as it is now (the page may have drawn it again): fin's, by its words. */
  function finalNow(fin) {
    if (fin.el && fin.el.isConnected && MGBFill.isVisible(fin.el)) return fin.el;
    const finals = ((checkoutFlow && checkoutFlow.final) || []).filter((re) => re && re.test);
    return [...document.querySelectorAll('button, input[type="submit"], a, [role="button"]')].find((el) => {
      if (!MGBFill.isVisible(el) || el.closest('#mugibot-qc')) return false;
      const t = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
      return t === fin.text || finals.some((re) => re.test(t));
    }) || null;
  }
  const isOff = (btn) => !btn || !btn.isConnected || btn.disabled || btn.getAttribute('aria-disabled') === 'true' || !MGBFill.isVisible(btn);

  /** What the order may cost in this run: the item's max plus delivery — or, things already in the bag going too, your limit an order (both within the day's spending). */
  const limitOf = (run) => (run.others && typeof run.orderLimit === 'number' ? run.orderLimit : run.maxTotal);

  /**
   * The total, read just before pressing: within the run's limit (said and stopped if not). Over the item's
   * max plus delivery but within your order limit, with other things in your bag: said, and it goes on.
   */
  function totalOk(run, fin, total) {
    if (total === null) { acoStop('needs_you', 'no_total', "Couldn't read the order total to check it against your limit — check it and press the button yourself.", fin); return false; }
    const limit = limitOf(run);
    if (total > limit) { acoStop('needs_you', 'over_limit', `The total, $${total.toFixed(2)}, is over your limit of $${limit.toFixed(2)} — check it and press the button yourself if it's right.`, fin, total); return false; }
    return true;
  }

  /**
   * At the final button of an Auto-checkout run: the order checked (instant reads only — nothing waited for
   * before pressing), then pressed. And while the store's struggling (a hot drop: it's busy, something went
   * wrong, try again, or no answer at all) pressed again, a little later each time, for up to half an hour —
   * never while it's still working on a press, and never past a decline, your bank's check or a human check.
   */
  async function acoFinish(run, fin, data) {
    lookLogin();
    // The store says it won't sell it now (Shop checkout links: "This Product is not available for purchase"): nothing's bought.
    const refused = MGBChecks.unavailable(document, checkoutFlow);
    if (refused) return acoStop('failed', 'sold_out', `${retailer.name} says "${refused}" — nothing was bought.`, fin);
    // (Not on sale yet, a checkout that says so until the drop's live: the first time, "Pay now" is pressed
    //  anyway — the notice may only be about a box it's just ticked, and the store says again if not.
    //  Already told no by the store (run.notLive): only once the notice has gone, a moment after the boxes.)
    if (run.notLive && run.mode === 'place' && noticeEls().length) {
      await MGBFlows.wait(1500);
      const still = noticeText(noticeEls());
      if (still) return notLiveYet(run, still, orderTotal());
    }
    // A store that only takes PayPal at checkout (The Games Cube): Auto-checkout can't pay there.
    if (checkoutFlow && checkoutFlow.payment === 'paypal') {
      return acoStop('needs_you', 'paypal_only', `${retailer.name} only takes PayPal at checkout — your details are in; press "${fin.text}" and pay with PayPal yourself.`, fin);
    }
    if (run.mode !== 'place') {
      fin.el.style.setProperty('outline', '4px solid #22c55e', 'important');
      try { fin.el.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
      panel.setStatus(`🤖 Filled in — review everything and press "${fin.text}" yourself.`);
      await acoReport('ready', '', `Filled in at ${retailer.name} — waiting for you to press "${fin.text}"`);
      return;
    }
    // Pressed already in this run (the page came back): only to press it again while the store's struggling.
    if (run.placing && !retrying(run)) return;
    // (Stores that pay with the card saved in your account there — Amazon's — need none from the extension;
    // nor does a card the store or Shop Pay shows it already has for you: EB Games' "...2387".)
    const ownCard = !checkoutFlow || checkoutFlow.payment !== 'account';
    const frames = (await ask({ type: 'cardFrames' })) || [];
    const boxes = cardBoxesOnPage().length > 0 || frames.some((f) => f.seen > 0);
    const saved = ownCard && !boxes && (MGBChecks.savedCardShown(document, checkoutFlow, false) || frames.some((f) => f.saved));
    if (ownCard && !saved && !data.card) return acoStop('needs_you', 'card_missing', 'No card is saved in the extension — add it (icon → Card settings) and finish this yourself.', fin);
    if (ownCard && !saved && checkoutFlow && checkoutFlow.payment === 'card' && !(await cardIn())) return acoStop('needs_you', 'card_not_filled', "Your card didn't go into the store's card boxes — type it in and press the button yourself.", fin);
    // The page's own say on the boxes: filled in once more if it says one's wrong or empty, then checked.
    const values = MGBFill.fieldValues(data.profile, data.card);
    if (pageError() || MGBChecks.missingRequired(document)) MGBFill.fillFields(document, values, { flow: checkoutFlow });
    const err = pageError();
    // (The store saying it's struggling, or still at it, before anything's pressed: pressed all the same — it
    //  says again if it won't take it. Anything else it says is for you.)
    if (err && !['busy', 'working'].includes(MGBChecks.errorKind(err))) return acoStop('needs_you', 'needs_details', `The page says: "${err}" — fix it and press the button yourself.`, fin);
    const missing = MGBChecks.missingRequired(document);
    if (missing) return acoStop('needs_you', 'needs_details', `"${missing}" still needs filling in — fill it and press the button yourself.`, fin);
    const total = orderTotal();
    if (!totalOk(run, fin, total)) return;
    if (total > run.maxTotal) report('step', `The total, $${total.toFixed(2)}, is more than this item's max and delivery — the other things in your ${retailer.name} bag are being bought too`, null);
    return pressLoop(run, fin, values, total);
  }

  /** May this run press its final button again? (Pressed already, the store hasn't taken the order, and it's not 30 minutes yet.) */
  const retrying = (run) => !!(run && run.placing && !run.stopped && !run.done && run.placingAt && Date.now() - run.placingAt < MGBChecks.RETRY_MS);
  /** The store saying it's struggling (busy, try again, sold out just now), within ms — or an outcome first: no. */
  async function busySaid(ms) {
    for (const until = Date.now() + ms; Date.now() < until; await MGBFlows.wait(250)) {
      if (outcome()) return false;
      if (MGBChecks.errorKind(pageError()) === 'busy') return true;
    }
    return false;
  }
  /** The store saying it's still at it ("Processing…", "Please wait"): waited for, never pressed meanwhile. */
  const stillWorking = () => MGBChecks.errorKind(pageError()) === 'working';

  /**
   * The final button, ready to press (it turns on once the store's done with the last boxes — under load,
   * that can take minutes: up to 30, said to your account meanwhile), then pressed — and pressed again only
   * when the store says it's struggling (busy, try again, sold out just now), for up to half an hour. Each
   * press is asked of the extension first: it keeps count and the 30 minutes, and before pressing again it
   * asks your account whether the run's still going.
   */
  async function pressLoop(run, fin, values, total) {
    let leaving = false;
    addEventListener('beforeunload', () => { leaving = true; }, { once: true });
    let fieldTries = 0;
    let watching = false;
    for (let n = 0; ; n++) {
      // The button: free to press (the page may draw it again meanwhile) — and, pressing again, the store
      // done with whatever it's at (its page loading, a spinner, "Processing…").
      let btn = finalNow(fin);
      for (const since = Date.now(); isOff(btn) || stillWorking() || (n > 0 && (finalBusy() || MGBQuick.pageBusy()));) {
        if (leaving) return;
        if (Date.now() - since > MGBChecks.RETRY_MS) return acoStop('needs_you', n > 0 ? 'unconfirmed' : 'needs_details', n > 0 ? `${retailer.name} was still busy with "${fin.text}" after 30 minutes — check your email for an order confirmation before buying it again.` : `"${fin.text}" didn't become available in 30 minutes — check the page and press it yourself.`, fin, total);
        const o = outcome();
        if (o) return said(o, total);
        panel.setStatus(isOff(btn) ? `⏳ Waiting for ${retailer.name}'s "${fin.text}" to turn on (the store's slow)…` : `⏳ ${retailer.name} is still working on it…`);
        beat(isOff(btn) ? `Waiting for "${fin.text}" to turn on — ${retailer.name}'s checkout is slow (up to 30 minutes)` : `Waiting for ${retailer.name} to finish what it's doing`);
        await MGBFlows.wait(250);
        btn = finalNow(fin);
      }
      if (n > 0) {
        // Before pressing again: its boxes ticked and filled in still, and the total — read again — within the limit.
        MGBFill.fillFields(document, values, { flow: checkoutFlow });
        total = orderTotal();
        if (!totalOk(run, fin, total)) return;
      }
      const message = n === 0 ? `Pressing "${fin.text}" — total $${total.toFixed(2)}` : `Pressing "${fin.text}" again — ${retailer.name} hasn't taken the order yet`;
      const go = await ask({ type: 'acoRetry', message, total });
      if (!go || !go.ok) {
        if (go && go.over) return acoStop('needs_you', 'not_placed', `Pressed "${fin.text}" again and again for ${Math.round((Date.now() - go.since) / 60000)} minutes and ${retailer.name} kept turning it away — nothing more pressed. Check your email before buying it again.`, fin, total);
        panel.setStatus(`🤖 This checkout ended on your account meanwhile — nothing more pressed.`);
        return; // (the run ended meanwhile: stopped, timed out, or finished on your phone)
      }
      aco = { ...(aco || run), placing: true, placingAt: (aco && aco.placingAt) || go.since };
      panel.setStatus(go.n === 1 ? `🤖 Placing your order ($${total.toFixed(2)})…` : `🤖 Pressing "${fin.text}" again (${go.n}) — ${retailer.name}'s struggling…`);
      report('step', `Auto-checkout pressed "${fin.text}"${go.n > 1 ? ` again (${go.n})` : ''} (total $${total.toFixed(2)})`, null);
      if (checkoutFlow.leaves && !watching) { watching = true; watchLeaving(fin.text, total); }
      markNotices();
      // (What the page said before this press isn't its answer to it: only something it says anew.)
      MGBChecks.markErrors(document);
      btn.click();
      const ans = await answer(run, total, () => leaving);
      if (ans.kind === 'done' || ans.kind === 'left') return;
      if (ans.kind === 'field' && ++fieldTries > 2) return acoStop('needs_you', 'needs_details', `${retailer.name} said: "${ans.text}" — finish it yourself in this tab.`, fin, total);
      const w = MGBChecks.retryWait(n);
      panel.setStatus(`⏳ ${retailer.name} said "${ans.text.slice(0, 80)}" — pressing "${fin.text}" again in ${Math.round(w / 1000)} s…`);
      for (const until = Date.now() + w; Date.now() < until;) {
        await MGBFlows.wait(250);
        if (leaving) return;
        const o = outcome();
        if (o) return said(o, total);
      }
    }
  }

  /** How it went, said to your account (placed: the run's done here). */
  async function said(o, total) {
    if (o.status === 'placed') {
      panel.setStatus('🤖 Order placed.');
      await acoReport('placed', '', `Order confirmed at ${retailer.name}`, total);
      assistFlag.off();
      ask({ type: 'endFill' });
      return;
    }
    panel.setStatus(o.message);
    await acoReport(o.status, o.reason, o.message, total);
  }

  // Your account told how a slow checkout's going, every half a minute or so (it keeps the run going).
  let beatAt = 0;
  function beat(text) {
    if (!aco || Date.now() - beatAt < 30000) return;
    beatAt = Date.now();
    ask({ type: 'acoReport', status: 'beat', message: text });
  }

  /**
   * After a press: the store's answer. 'done' (placed, or stopped and said: a decline, your bank's or a human
   * check, anything about the payment, not on sale yet), 'left' (on to another page: it carries on there),
   * 'field' (it says a box is wrong: filled in again, then pressed again) or 'again' (it says it's
   * struggling: busy, try again, sold out just now). No answer at all is never a reason to press again: it's
   * waited for — the store may still be at it — up to the half hour, then left for you.
   * (What the page said before the press, still up word for word, isn't its answer: markErrors.)
   */
  async function answer(run, total, left) {
    const started = Date.now();
    let errSince = 0;
    for (;;) {
      await MGBFlows.wait(400);
      if (left()) return { kind: 'left' };
      const o = outcome();
      if (o) { await said(o, total); return { kind: 'done' }; }
      if (await pressReview(run)) continue;
      // The store said no to the final button (a Shop link's "not available for purchase"): a notice shown
      // anew since the press, the page still here 8 seconds on and its button free again — so nothing was
      // bought. It waits here for the sale. (The same notice merely still up is no answer: left as it is.)
      const notLive = waitLive && Date.now() - started > 8000 && !finalBusy() ? freshNotice() : '';
      if (notLive) { await notLiveYet(run, notLive, total); return { kind: 'done' }; }
      const err = pageError(true);
      errSince = err ? errSince || Date.now() : 0;
      const k = err ? MGBChecks.errorKind(err) : '';
      if (err && k !== 'working' && Date.now() - errSince > 2500 && !finalBusy()) {
        if (k === 'declined') { await said({ status: 'failed', reason: 'card_declined', message: `${retailer.name} said: ${err}` }, total); return { kind: 'done' }; }
        if (k === 'busy') return { kind: 'again', text: err };
        if (k === 'field') return { kind: 'field', text: err };
        // (The payment, the card, your bank, a human check — or words it doesn't know: never pressed past.)
        await said({ status: 'needs_you', reason: 'needs_details', message: `${retailer.name} said: "${err}" — finish it yourself in this tab (nothing more pressed).` }, total);
        return { kind: 'done' };
      }
      if (Date.now() - started > MGBChecks.RETRY_MS) {
        await said({ status: 'needs_you', reason: 'unconfirmed', message: `${retailer.name} still hadn't answered "Pay" after 30 minutes — check your email for the order confirmation before buying it again.` }, total);
        return { kind: 'done' };
      }
      // (Still at it — its button busy, the page loading, "Processing…" — or nothing said yet: waited for.)
      beat(`Pressed — waiting for ${retailer.name} to answer (it's slow)`);
    }
  }

  async function fillCheckout() {
    if (assisting || !assistFlag.active()) return;
    assisting = true;
    // (WooCommerce's add-to-cart link: out of the address, so a reload doesn't add it again.)
    if (retailer && retailer.platform === 'woocommerce') MGBQuick.dropCartParams();
    try {
      const flag = assistFlag.read();
      const data = await ask({ type: 'fillData', part: 'all', profileId: flag && flag.profileId });
      if (!data) {
        panel.setStatus('Couldn\'t get your delivery details from your account — fill in checkout yourself.');
        return;
      }
      if (data.aco && data.aco.placing) {
        // Back after the final button was pressed (here, or in the store's checkout frame): what happened —
        // and, only if the store's back at its checkout saying it's struggling (busy, try again, sold out just
        // now), within the half hour: filled in again and pressed again (below). Back at it saying nothing,
        // or anything else, it's only watched: the order may be going through. (A frame presses its own.)
        aco = data.aco;
        const o = outcome();
        if (o) await acoReport(o.status, o.reason, o.message);
        if (o && o.status === 'placed') { assistFlag.off(); ask({ type: 'endFill' }); }
        if (o) return;
        if (!retrying(data.aco) || (checkoutFlow && checkoutFlow.inFrame) || !(await busySaid(5000))) { watchOutcome(data.aco, null); return; }
      }
      if (checkoutFlow && checkoutFlow.inFrame) {
        // The whole checkout is in a frame (Global-e's, for Premium Bandai): frame.js runs it in there —
        // your details, its choices, your card and (an Auto-checkout run) its final button, after the
        // same checks as here. This page only shows how it's going.
        if (data.aco) aco = data.aco;
        if (data.aco && !(checkoutFlow.frames && checkoutFlow.frames.length)) {
          // (A store whose checkout frame Mugibot doesn't know the address of: left for you.)
          if (data.aco.mode === 'place') acoReport('needs_you', 'payment_frame', `${retailer.name}'s checkout is in a payment form Mugibot can't press — your details are going in; check them and press the final button yourself.`);
          else acoReport('ready', '', `${retailer.name}'s checkout is open with your details going in — press the final button yourself.`);
        } else if (data.aco) {
          await acoReport('checkout', '', `At ${retailer.name}'s checkout — filling it in`);
        }
        panel.setStatus(`${retailer.name}'s checkout is in the form on this page: your details and card go in there as each step shows them.`);
        report('step', `Checkout open at ${retailer.name} — your details and card go into its checkout form`, null);
        if (data.card && checkoutFlow.payment === 'card') checkCard();
        return;
      }
      const run = data.aco || null;
      if (run) aco = run;
      if (run && !run.placing) await acoReport('checkout', '', `At ${retailer.name}'s checkout — filling it in`);
      if (run && run.placing) panel.setStatus(`🤖 ${retailer.name} came back to its checkout without taking the order — filling it in again to press "Pay" again…`);
      let fin = null;
      const result = await MGBFill.assist({
        values: MGBFill.fieldValues(data.profile, data.card),
        flow: checkoutFlow,
        storeName: retailer.name,
        hasCard: !!data.card,
        cardIssue: data.cardIssue || null,
        setStatus: panel.setStatus,
        report: (type, message) => report(type === 'ready' ? 'ready' : type === 'error' ? 'error' : 'step', message, null),
        isActive: assistFlag.active,
        auto: !!run,
        onFinal: (f) => { fin = f; },
        cardReady: data.card ? cardReady : null,
        // (An Auto-checkout run: a store slowed right down gets up to 30 minutes, your account told how it's going.)
        patientMs: run ? MGBChecks.RETRY_MS : 0,
        onBeat: run ? beat : null,
      });
      if (result === 'final' && run && fin) {
        await acoFinish(run, fin, data);
        return;
      }
      if (run && result === 'done') await acoReport('placed', '', `Order confirmed at ${retailer.name}`);
      if (run && (result === 'needs_you' || result === 'timeout')) await acoReport('needs_you', result === 'timeout' ? 'timeout' : 'needs_details', `Checkout got stuck at ${retailer.name} — finish it yourself in this tab.`);
      // (A ⚡ Buy at the final button, or stuck, for you: the store's next checkout goes in a few minutes. Auto-checkout's runs say so themselves.)
      if (!run && ['ready', 'needs_you', 'timeout'].includes(result)) ask({ type: 'turnEnd', parked: true });
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
      // (A card the store or Shop Pay already has for you, and no card boxes: nothing to type.)
      if (!cardBoxesOnPage().length && MGBChecks.savedCardShown(document, checkoutFlow, false) && !((await ask({ type: 'cardFrames' })) || []).some((f) => f.seen > 0)) return;
      const frames = (await ask({ type: 'cardFrames' })) || [];
      if (frames.some((f) => f.filled > 0)) return;
      await MGBFlows.wait(1000);
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

  // Has the store's own code wired up its Add button yet? (Asked of the page itself, by the extension.)
  const probe = (add) => {
    for (const el of document.querySelectorAll('[data-mgb-add]')) if (el !== add) el.removeAttribute('data-mgb-add');
    add.setAttribute('data-mgb-add', '');
    return ask({ type: 'probe' });
  };

  // At checkout: fill it in. A checkout that opens on this page (no new page): as soon as it
  // shows. A Checkout button that opens a new page: there (this page is on its way out).
  let leaving = false;
  function atCheckout() {
    addEventListener('beforeunload', () => { leaving = true; }, { once: true });
    const until = Date.now() + 2500;
    (function look() {
      if (leaving) return;
      if (MGBQuick.onCheckoutPage(retailer) || Date.now() > until) fillCheckout();
      else MGBFlows.wait(100).then(look);
    })();
  }

  async function go(fresh, extra = {}) {
    if (busy) return;
    busy = true;
    panel.startButton.disabled = true;
    try {
      const flow = store.read();
      const product = extra.product || MGBQuick.productForPage(items, retailer) || (flow ? items.find((p) => p.sku === flow.sku) : null) || null;
      const result = await MGBQuick.run({ fresh, retailer, product, products: items, store, setStatus: panel.setStatus, report, probe, why: acoWhy, ...extra });
      // Stopped short on what turned out to be the store's queue (or checkpoint), drawn late: wait there.
      const late = (result === 'error' || result === 'timeout') && claimed ? seenGate() : null;
      if (late) {
        holdStore.save({ ...claimed, kind: late.kind, at: Date.now() });
        ask({ type: 'gate', store: retailer.id, on: true, kind: retailer.gate.kind, wait: late.wait });
        waitAtGate(late);
        return;
      }
      // (On its way: the flow's own progress carries it from here. Its page looked at again — a store's
      //  error page under load — it's kept, for the run to pick up on the new page.)
      if (fresh && result !== 'reload' && (holdStore.read() || {}).provisional) holdStore.clear();
      // Stopped short of checkout (sold out, not added…): the store's next checkout goes now. (Auto-checkout's runs say so themselves.)
      if (!aco && ['error', 'timeout', 'stopped'].includes(result)) ask({ type: 'turnEnd' });
      if (result === 'checkout') atCheckout();
      // (The store's quick checkout, in a frame on this page: frame.js fills it in and says how it goes.)
      if (result === 'checkout-frame') panel.setStatus(`At ${retailer.name}'s checkout — filling it in…`);
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
      // Your click on the panel: fill in checkout afterwards too. (A product not on your watchlist — a link
      // from another Discord — is checked out the same way: the page's own product.)
      const item = MGBQuick.productForPage(items, retailer) || MGBQuick.pageProduct(retailer);
      // (Another checkout of yours going at this store — its one bag: this one once that's done.)
      const turn = await ask({ type: 'turn', name: item && item.name });
      if (turn && turn.go === false) {
        ask({ type: 'turnEnd' });
        panel.setStatus(turn.clearing ? `Your ${retailer.name} bag is being emptied (Clear cart) — press this again in a moment.`
          : `Your checkout of ${turn.name || 'another item'} at ${retailer.name} is going — ${retailer.name} keeps one bag for this browser. Press this again once it's done.`);
        return;
      }
      const ok = await ask({ type: 'startFill', product: item ? { id: item.fromPage ? null : item.id || null, store: retailer.id, sku: item.sku, name: item.name, url: item.url || location.href.split('#')[0] } : null });
      if (ok) assistFlag.on(item && item.profileId);
      if (ok && ok.aco) {
        // (Auto-checkout set to "Place the order for me": this checkout places the order, within your limits.)
        aco = ok.aco;
        panel.setNote('🤖 Auto-checkout — places the order within your limits');
        const inBag = !retailer.cartLinks ? MGBQuick.bagCount() : null;
        if (inBag) {
          const text = `Your ${retailer.name} bag already had ${inBag} item${inBag === 1 ? '' : 's'} in it — Auto-checkout carries on, and ${inBag === 1 ? 'it' : 'they'}'ll be bought too (Clear cart before a drop to buy only this)`;
          aco = { ...aco, others: inBag };
          ask({ type: 'acoOthers', n: inBag, message: text });
          report('error', text, item);
        }
      }
      go(true);
    },
    onStop: async () => {
      store.clear();
      assistFlag.off();
      holdStore.clear();
      turnStopped = true;
      ask({ type: 'turnEnd' }); // (the store's next checkout goes)
      panel.setStatus('Stopped. You can continue yourself.');
      if (aco && !aco.placing) await acoReport('failed', 'stopped', 'You stopped it');
      // (After "Pay" was pressed the order may have gone through: for you to check.)
      else if (aco) await acoReport('needs_you', 'stopped', 'You stopped it after the final button was pressed — check your email for an order confirmation before buying it again.');
      // (A checkout running in a frame on this page stops too: this tab's checkout pass is gone.)
      if (checkoutFlow && checkoutFlow.inFrame) ask({ type: 'endFill' });
    },
  });

  /** A ⚡ Buy (or Auto-checkout run) confirmed for this tab: to checkout with it — when it's its turn at this store. */
  let claimed = null;
  let turnStopped = false;
  async function startClaimed(claim, product) {
    claimed = { code: goCode, claim, product };
    // Another checkout of yours at this store goes first (its one bag): next in line, here.
    const turn = await ask({ type: 'turn', name: product && product.name });
    if (turn && turn.go === false) { waitTurn(claim, product, turn); return; }
    // Other things in your bag already: Auto-checkout goes on all the same — they're bought with it — and
    // says so (your activity, the run's history), its total checked against your order limit instead of this
    // item's max. (Clear cart before a drop to buy only the one thing. A Shop checkout link is its own order.)
    const inBag = aco && !retailer.cartLinks ? MGBQuick.bagCount() : null;
    if (aco && inBag) {
      const text = `Your ${retailer.name} bag already had ${inBag} item${inBag === 1 ? '' : 's'} in it — Auto-checkout carries on, and ${inBag === 1 ? 'it' : 'they'}'ll be bought too (Clear cart before a drop to buy only this)`;
      aco = { ...aco, others: inBag };
      ask({ type: 'acoOthers', n: inBag, message: text });
      report('error', text, product);
    }
    // (Seen signed out at a store that only sells signed in: said, but it goes on all the same — the
    //  reading may be wrong, and the store's own sign-in page stops it, buying nothing, if it isn't.)
    if (signedOutHere()) panel.setNote(SIGN_IN_FIRST);
    assistFlag.on(claim.profileId);
    panel.setNote(aco ? `🤖 Auto-checkout${aco.mode === 'place' ? ' — places the order within your limits' : ' — stops at the final button for you'}` : 'Started from ⚡ Buy');
    // Kept for this tab until the ⚡ Buy gets going (go() clears it): a store's queue page drawn by its own
    // code, or reloading itself, before Mugibot could tell it was one — then it waits there, not lost.
    holdStore.save({ ...claimed, kind: null, provisional: true, page: location.pathname + location.search, at: Date.now() });
    // The buy box can take a few seconds to appear on a fresh page load.
    const waitMs = (MGBFlows.part(retailer, 'product').waitMs) || 12000;
    // (canReload: a store's error page under load is looked at again — this run picks up on the new page,
    //  kept by the hold above; isGate: never a queue's page.)
    go(true, { product, waitForButtonMs: waitMs, canReload: true, isGate: () => !!seenGate(), onReload: () => reloadFor(product) });
  }

  /**
   * Next in line at this store: waits here (the extension says when it's this one's turn — the one
   * before it placed its order, stopped, or was closed), then reloads the page and goes: a page
   * opened while the other checkout had its item in the bag would show the bag as it was then.
   */
  async function waitTurn(claim, product, turn) {
    holdStore.save({ code: goCode, claim, product, kind: 'turn', at: Date.now() });
    panel.setNote(`⏳ Next in line at ${retailer.name}${aco ? ' — 🤖 Auto-checkout' : ''}`);
    // (Clear cart emptying the bag here first: a moment, then this one.)
    const say = (t) => panel.setStatus(t.clearing ? `Your ${retailer.name} bag is being emptied (Clear cart) — this one goes the moment that's done.`
      : `Your checkout of ${t.name || 'another item'} at ${retailer.name} goes first — ${retailer.name} keeps one bag for this browser. This one goes the moment that's done.`);
    const tell = (t) => { if (aco) acoReport('waiting', 'turn', t.clearing ? `Next in line at ${retailer.name}: your bag there is being emptied (Clear cart)` : `Next in line at ${retailer.name}: your checkout of ${t.name || 'another item'} there goes first`); };
    say(turn);
    tell(turn);
    let beat = Date.now();
    for (;;) {
      await MGBFlows.wait(500);
      if (turnStopped) return;
      const t = await ask({ type: 'turn', name: product && product.name });
      if (!t || t.go !== false) break; // its turn (or the extension can't say: go)
      say(t);
      if (Date.now() - beat > 120 * 1000) {
        // Still in line: this tab's checkout pass, its ⚡ Buy and your account kept up to date.
        beat = Date.now();
        ask({ type: 'gateWait' });
        const h = holdStore.read();
        if (h) holdStore.save({ ...h, at: Date.now() });
        tell(t);
      }
    }
    panel.setStatus(`Its turn — opening ${retailer.name} afresh…`);
    location.reload();
  }

  /**
   * The store's error page under load, looked at again: the product's own page (the store may have sent
   * this tab to an error page of its own, "/sorry") — this run's hold kept for either address, for the
   * run to pick up on whichever comes in.
   */
  function reloadFor(product) {
    let to = null;
    try { to = product && product.url ? new URL(product.url, location.href) : null; } catch { to = null; }
    const here = location.pathname + location.search;
    if (!to || to.origin !== location.origin || to.pathname + to.search === here) { location.reload(); return; }
    const h = holdStore.read();
    if (h) holdStore.save({ ...h, page: to.pathname + to.search, also: here });
    location.replace(to.href);
  }

  // ---------------------------------------------------------------------------
  // Checkpoints and virtual queues
  // ---------------------------------------------------------------------------
  /** The store's queue (or checkpoint) on this page? (A queue page never has the store's Add button, bag or checkout.) */
  function seenGate() {
    const g = MGBFlows.gateHere(retailer, document, location);
    if (g && g.kind === 'queue' && (MGBQuick.onCheckoutPage(retailer) || MGBQuick.onBagPage(retailer) || MGBQuick.findAddToBag(retailer))) return null;
    return g;
  }
  const gate = seenGate();
  // The store's bot protection turning this browser away instead of its page (BIG W's "Access Denied"): said
  // here, and Mugibot asks that store for nothing more from this browser for half an hour, so it can lift —
  // asking more only makes it last. (A run that lands here says so, and stops: nothing to buy on this page.)
  const denied = !gate && MGBQuick.deniedPage();
  const DENIED_TEXT = `${retailer.name}'s bot protection is turning this browser away ("Access Denied"). Mugibot leaves ${retailer.name} alone from this browser for 30 minutes so it can lift. To get back in sooner: clear ${retailer.name}'s cookies (the icon left of the address → Cookies and site data → delete ${retailer.name}'s), or try another network, then open the link again.`;
  if (denied) { ask({ type: 'denied', store: retailer.id }); panel.setStatus(DENIED_TEXT); }
  // (The extension keeps track of which tabs are in a queue: it never refreshes them, and nothing
  // else of yours asks that store for anything until you're through.)
  if (retailer.gate) ask({ type: 'gate', store: retailer.id, on: !!gate, kind: retailer.gate.kind, wait: gate ? gate.wait : null });

  /** What the panel says on the gate's page. */
  function gateStatus(g, running) {
    if (g.kind === 'checkpoint') {
      return `${retailer.name} wants a human check here. Solve it yourself — Mugibot never touches it${running ? ' — and it carries on to checkout as soon as you have.' : '.'}`;
    }
    return `You're in line${g.wait !== null && g.wait !== undefined ? ` — about ${g.wait} min` : ''}. Leave this page alone: it refreshes itself, and refreshing it yourself can lose your place. Mugibot never refreshes it${running ? ', and carries on as soon as you\'re through.' : '.'}`;
  }

  /**
   * Your account ended this tab's checkout meanwhile (finished on your phone instead, while it waited
   * at the checkpoint): it stops here, and nothing on the page is pressed.
   */
  function endedElsewhere(text) {
    store.clear();
    assistFlag.off();
    holdStore.clear();
    gateWaitFlag.clear();
    ask({ type: 'turnEnd' });
    panel.setNote('📱 Stopped');
    panel.setStatus(text || 'Your account stopped this checkout — you finished it somewhere else. Nothing was pressed here.');
  }

  /**
   * On the gate's page with a ⚡ Buy or Auto-checkout run going: wait there — keeping the run, your
   * checkout pass and the flow's progress alive — and say so (the run says it's waiting). Nothing on
   * the page is pressed and the page is never reloaded: the queue page moves on by itself, and the
   * checkpoint once you've solved it.
   */
  function waitAtGate(g) {
    const queue = g.kind === 'queue';
    panel.setNote(queue ? `🚦 In ${retailer.name}'s virtual queue${aco ? ' — 🤖 Auto-checkout waits in line' : ''}` : `🛡️ ${retailer.name}'s checkpoint${aco ? ' — 🤖 Auto-checkout waits for you' : ''}`);
    let saidAt = 0;
    let said = '';
    let ended = false;
    gateWaitFlag.on(g.kind);
    const beat = (now) => {
      if (ended) return;
      const flow = store.read();
      if (flow) store.save({ ...flow, startedAt: Date.now() });
      const a = assistFlag.read();
      if (a) assistFlag.on(a.profileId);
      const h = holdStore.read();
      if (h) holdStore.save({ ...h, at: Date.now() });
      ask({ type: 'gateWait' });
      panel.setStatus(gateStatus(now, true));
      const msg = queue ? `In ${retailer.name}'s virtual queue${now.wait !== null && now.wait !== undefined ? ` — about ${now.wait} min` : ''}` : `At ${retailer.name}'s checkpoint — solve it in this tab`;
      if (aco && (msg !== said || Date.now() - saidAt > 150 * 1000)) {
        said = msg;
        saidAt = Date.now();
        // (Ended on your account's side meanwhile — finished on your phone: it stops waiting.)
        acoReport('waiting', g.kind, msg).then((r) => {
          if (r && r.over && !ended) { ended = true; endedElsewhere(r.text); }
        });
      }
    };
    beat(g);
    // A checkpoint needs you: this tab comes forward (once), and the panel keeps clear of the check.
    if (!queue) { ask({ type: 'focusTab' }); panel.moveAside(); }
    setInterval(() => {
      const now = seenGate();
      if (now) beat(now);
    }, queue ? 30000 : 15000);
  }

  if (goCode) {
    const claim = held ? held.claim : await claiming;
    // (A new ⚡ Buy in this tab: its own error-page reloads, counted from none.)
    if (!held && claim && claim.ok) MGBQuick.slowReloads(0);
    if (claim && claim.ok) {
      const listed = items.find((p) => p.id === claim.itemId) || items.find((p) => p.sku === claim.sku);
      const product = { ...(listed || {}), sku: claim.sku, name: claim.name || (listed && listed.name) || claim.sku, url: claim.url || (listed && listed.url) || null, store: retailer.id };
      aco = claim.aco || null;
      if (denied) {
        panel.setStatus(DENIED_TEXT);
        if (aco) acoReport('needs_you', 'store_denied', `${retailer.name} said "Access Denied" to this browser (its bot protection) — nothing was bought. Mugibot leaves ${retailer.name} alone from it for 30 minutes so it can lift.`);
        return;
      }
      if (gate) {
        // The store opened in its queue (or at its checkpoint): this ⚡ Buy waits here, claimed.
        holdStore.save({ code: goCode, claim, product, kind: gate.kind, at: Date.now() });
        waitAtGate(gate);
        return;
      }
      // (Reloaded for its turn at this store — after waiting for another checkout of yours here.)
      if (held && held.kind === 'turn' && aco) acoReport('started', '', `Its turn at ${retailer.name} — carrying on`);
      holdStore.clear();
      startClaimed(claim, product);
      return;
    }
    panel.setNote(!state || !state.paired ? 'This browser isn\'t connected to your account — click the Mugibot icon to connect, then press ⚡ Buy again.'
      : claim && claim.status === 402 ? (claim.error || 'Your membership isn\'t active — start it to use ⚡ Buy.')
        : claim && claim.status === 409 ? (claim.error || 'You finished this one somewhere else — nothing to do here.')
        : claim === null || (claim && claim.status === 0) ? 'Couldn\'t reach your account to confirm the ⚡ Buy — check your connection.'
          : 'That ⚡ Buy link has expired or belongs to another account — press ⚡ Buy again.');
  }

  // A checkout running in a frame on this page (frame.js) says how it's going here.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'frameStatus' && typeof msg.text === 'string' && assistFlag.active()) panel.setStatus(msg.text.slice(0, 300));
  });

  // A ⚡ Buy that waited in the store's queue (or at its checkpoint) in this tab. (One that had got going —
  // its progress kept by the flow — carries on as that, below.)
  if (!goCode && held && store.read()) { holdStore.clear(); held = null; }
  // (Kept only in case its page reloaded: anywhere else, it's not carried on — you went somewhere else.)
  if (!goCode && held && held.provisional && !gate && held.page !== location.pathname + location.search && held.also !== location.pathname + location.search) { holdStore.clear(); held = null; }
  if (!goCode && held) {
    aco = (await ask({ type: 'acoInfo' })) || held.claim.aco || null;
    if (gate) {
      // Still in line (the queue page refreshed itself) — or, kept in case, it turned out to be the queue.
      if (!held.kind) holdStore.save({ ...held, kind: gate.kind, provisional: false, at: Date.now() });
      waitAtGate(gate);
      return;
    }
    const product = held.product || { sku: held.claim.sku, name: held.claim.name };
    // Through, but somewhere other than the product (the store's front page): to the product, once.
    const elsewhere = product.url && !MGBQuick.productForPage([product], retailer) && !MGBQuick.onCheckoutPage(retailer) && !MGBQuick.onBagPage(retailer);
    if (elsewhere && !held.through) {
      holdStore.save({ ...held, through: true, at: Date.now() });
      panel.setStatus(`Through ${retailer.name}'s ${held.kind === 'checkpoint' ? 'checkpoint' : 'queue'} — opening the product…`);
      location.assign(product.url);
      return;
    }
    holdStore.clear();
    // (A ⚡ Buy only kept in case — its page reloaded before it got going — just carries on.)
    if (held.kind === 'turn') {
      // Its turn at this store (the page just reloaded for it). (Still another's turn — the line changed: it waits again.)
      if (aco) acoReport('started', '', `Its turn at ${retailer.name} — carrying on`);
    } else if (held.kind) {
      report('step', `Through ${retailer.name}'s ${held.kind === 'checkpoint' ? 'checkpoint' : 'virtual queue'} — carrying on`, product);
      gateWaitFlag.clear();
      // Your account hears it's through first: one it ended meanwhile (finished on your phone) stops here.
      if (aco) {
        const r = await acoReport('started', '', `Through ${retailer.name}'s ${held.kind === 'checkpoint' ? 'checkpoint' : 'virtual queue'} — carrying on`);
        if (r && r.over) { endedElsewhere(r.text); return; }
      }
    }
    startClaimed(held.claim, product);
    return;
  }

  // Through the store's checkpoint (or queue) partway through a checkout: your account hears it first,
  // and one it ended meanwhile (finished on your phone instead) stops here. (No run: carries on.)
  const through = gateWaitFlag.read();
  if (through && !gate) {
    gateWaitFlag.clear();
    const r = await acoReport('started', '', `Through ${retailer.name}'s ${through === 'checkpoint' ? 'checkpoint' : 'virtual queue'} — carrying on`);
    if (r && r.over) { endedElsewhere(r.text); return; }
  }
  // Carry on where we left off after the store changed page (an Auto-checkout run: still this tab's).
  if (store.read() || assistFlag.active()) aco = await ask({ type: 'acoInfo' });
  if (aco) panel.setNote('🤖 Auto-checkout');
  // The store's checkpoint (or queue) partway through: wait there, then carry on.
  if (gate && (store.read() || assistFlag.active())) { waitAtGate(gate); return; }
  if (gate) {
    // Just you, in line (or at the checkpoint): say so.
    if (gate.kind === 'checkpoint') panel.moveAside();
    panel.setNote(gate.kind === 'queue' ? `🚦 In ${retailer.name}'s virtual queue` : `🛡️ ${retailer.name}'s checkpoint`);
    panel.setStatus(gateStatus(gate, false));
    setInterval(() => { const now = seenGate(); if (now) panel.setStatus(gateStatus(now, false)); }, 30000);
    return;
  }
  if (store.read()) go(false);
  else if (assistFlag.active()) fillCheckout();
})();
