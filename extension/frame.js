// Mugibot — runs inside frames on store pages. Two kinds:
//
// - A store's whole checkout in a frame of its own (checkout.frames in the store's flow): Global-e's,
//   which runs Premium Bandai's, and Amazon's quick checkout. It's filled in here like a checkout page
//   (fill.js): your details, the flow's choices, the terms box, your card. ⚡ Buy stops at its final
//   button for you; an Auto-checkout run in place-the-order mode presses it after the same checks as
//   on a checkout page (checks.js: the card is in, nothing on the form is wrong, the total is within
//   your limit), once.
// - Payment frames: card number / expiry / CVV boxes hosted by the store's payment provider (Kmart's
//   Adyen, Shopify's card fields, Target's Paydock). Your saved card is typed in only while a checkout
//   you started is running in this tab, on that store (checked by the background worker). Each card
//   box is focused through the page above (these boxes only keep real typing into a focused box) and
//   typed into one at a time, then checked: kept as typed, or tried again. Then it tells the page what
//   went in, box by box, so the page can say exactly why if the card didn't.

(async () => {
  'use strict';
  if (window.top === window.self) return;
  MGBFill.startFocusBroker(); // for payment frames inside this one
  const ask = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res)); } catch { resolve(null); }
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const kindOf = (el) => MGBFill.fieldKind(el, null, { hasParts: true }) || '';
  const cardBoxes = () => [...document.querySelectorAll('input, select')].filter((el) => MGBFill.CARD_KINDS.includes(kindOf(el)));
  const digits = (s) => String(s || '').replace(/\D/g, '');

  // --- a whole checkout in this frame ---------------------------------------------------------
  // (Only a frame straight on the store's page: card boxes inside it are frames of their own.)
  if (window.parent === window.top) {
    let role = null;
    for (let i = 0; i < 10 && !role; i++) {
      role = await ask({ type: 'frameRole', url: location.href });
      if (!role) await wait(i < 3 ? 300 : 1000);
      if (role === false) break; // (not a checkout frame: no need to ask again)
    }
    if (role && role.checkout) { await runCheckout(role); return; }
  }

  async function runCheckout(role) {
    const C = MGBFlows.revive(role.flow) || {};
    const name = role.store || 'The store';
    const status = (text) => ask({ type: 'frameStatus', text });
    const report = (type, message) => ask({ type: 'event', event: { type, message, url: location.href } });
    const acoReport = (st, reason, message, total) => ask({ type: 'acoReport', status: st, reason: reason || '', message: message || '', total: typeof total === 'number' ? total : undefined });
    let data = null;
    for (let i = 0; i < 20 && !(data && data.profile); i++) {
      data = await ask({ type: 'fillData', part: 'all' });
      if (!(data && data.profile)) await wait(1000);
    }
    if (!data || !data.profile) return;
    const run = data.aco || null;
    if (run && run.placing) {
      // Back after this run's final button was pressed (the frame moved on): how it went — never pressed again.
      for (const until = Date.now() + 30000; Date.now() < until; await wait(500)) {
        const o = MGBChecks.outcome(document, C.done, name);
        if (o) { status(o.status === 'placed' ? '🤖 Order placed.' : o.message); await acoReport(o.status, o.reason, o.status === 'placed' ? `Order confirmed at ${name}` : o.message); return; }
      }
      return;
    }
    const cardHere = () => [...document.querySelectorAll('input, select')]
      .filter((el) => /^card(Number|Expiry|ExpMonth|Cvc)$/.test(MGBFill.classifyField(el, C) || '') && MGBFill.isVisible(el));
    const cardReady = async (whole) => {
      const here = cardHere();
      const frames = (await ask({ type: 'cardFrames' })) || [];
      const seen = frames.filter((f) => f.seen > 0);
      const hereDone = here.every((el) => el.value || !/^card(Number|Expiry|ExpMonth)$/.test(MGBFill.classifyField(el, C) || ''));
      if (whole) return (here.length || seen.length) > 0 && hereDone && seen.every((f) => f.done);
      return here.some((el) => el.value && /^card(Number|Expiry|ExpMonth)$/.test(MGBFill.classifyField(el, C) || '')) || seen.some((f) => f.filled > 0)
        || (!here.length && !seen.length && MGBChecks.savedCardShown(document, C, false));
    };
    if (run) { status(`🤖 At ${name}'s checkout — filling it in…`); acoReport('checkout', '', `At ${name}'s checkout — filling it in`); }
    // Still this tab's checkout? (Stopped from the panel, or over: this frame stops too.)
    let active = true;
    const watch = setInterval(async () => { const r = await ask({ type: 'frameRole' }); if (!r || !r.checkout) active = false; }, 3000);
    let fin = null;
    const result = await MGBFill.assist({
      values: MGBFill.fieldValues(data.profile, data.card),
      flow: C,
      storeName: name,
      hasCard: !!data.card,
      cardIssue: data.cardIssue || null,
      setStatus: status,
      report: (type, message) => report(type === 'ready' ? 'ready' : type === 'error' ? 'error' : 'step', message),
      isActive: () => active,
      auto: !!run,
      onFinal: (f) => { fin = f; },
      cardReady: data.card ? cardReady : null,
    });
    clearInterval(watch);
    if (result === 'final' && run && fin) return finish(run, fin);
    if (run && (result === 'needs_you' || result === 'timeout')) await acoReport('needs_you', result === 'timeout' ? 'timeout' : 'needs_details', `Checkout got stuck at ${name} — finish it yourself in this tab.`);
    if (run && result === 'done') await acoReport('placed', '', `Order confirmed at ${name}`);

    async function stop(st, reason, message, total) {
      status(`🤖 ${message}`);
      fin.el.style.setProperty('outline', '4px solid #f59e0b', 'important');
      try { fin.el.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
      await acoReport(st, reason, message, total);
    }

    /** The final button of an Auto-checkout run, in this frame: the same checks as on a checkout page, then pressed once. */
    async function finish(r, f) {
      if (r.mode !== 'place') {
        f.el.style.setProperty('outline', '4px solid #22c55e', 'important');
        try { f.el.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
        status(`🤖 Filled in — review everything and press "${f.text}" yourself.`);
        await acoReport('ready', '', `Filled in at ${name} — waiting for you to press "${f.text}"`);
        return;
      }
      if (r.placing) return; // pressed already in this run: never twice
      if (C.payment === 'card' && !data.card) return stop('needs_you', 'card_missing', 'No card is saved in the extension — add it (icon → Card settings) and finish this yourself.');
      if (C.payment === 'card') {
        let ok = false;
        for (let i = 0; i < 15 && !ok; i++) { ok = await cardReady(true); if (!ok) await wait(1000); }
        if (!ok) return stop('needs_you', 'card_not_filled', "Your card didn't go into the store's card boxes — type it in and press the button yourself.");
      }
      await wait(400); // the form's own checks on the last boxes
      const err = MGBChecks.pageError(document);
      if (err) return stop('needs_you', 'needs_details', `The form says: "${err}" — fix it and press the button yourself.`);
      const missing = MGBChecks.missingRequired(document);
      if (missing) return stop('needs_you', 'needs_details', `"${missing}" still needs filling in — fill it and press the button yourself.`);
      const total = MGBChecks.orderTotal(document);
      if (total === null) return stop('needs_you', 'no_total', "Couldn't read the order total to check it against your limit — check it and press the button yourself.");
      if (total > r.maxTotal) return stop('needs_you', 'over_limit', `The total, $${total.toFixed(2)}, is over your limit of $${r.maxTotal.toFixed(2)} — check it and press the button yourself if it's right.`, total);
      let btn = f.el;
      for (let i = 0; i < 25 && (!btn.isConnected || btn.disabled || btn.getAttribute('aria-disabled') === 'true' || !MGBFill.isVisible(btn)); i++) {
        await wait(200);
        if (!btn.isConnected) btn = [...document.querySelectorAll('button, input[type="submit"], a, [role="button"]')].find((el) => MGBFill.isVisible(el) && (el.innerText || el.value || '').trim() === f.text) || btn;
      }
      if (!btn.isConnected || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return stop('needs_you', 'needs_details', `"${f.text}" didn't become available — check the form and press it yourself.`, total);
      // Said first (the frame may go the moment it's pressed): this run's final button, pressed once.
      await acoReport('placing', '', `Pressing "${f.text}" — total $${total.toFixed(2)}`, total);
      status(`🤖 Placing your order ($${total.toFixed(2)})…`);
      report('step', `Auto-checkout pressed "${f.text}" (total $${total.toFixed(2)})`);
      btn.click();
      // How it went, as far as this frame shows it (the page above takes over if it moves on).
      let said = null;
      let errSince = 0;
      for (const until = Date.now() + 45000; Date.now() < until;) {
        await wait(400);
        let o = MGBChecks.outcome(document, C.done, name);
        // The form refused the press, and still says why a few seconds on: for you.
        const err2 = o ? '' : MGBChecks.pageError(document);
        errSince = err2 ? errSince || Date.now() : 0;
        if (!o && err2 && Date.now() - errSince > 4000) o = { status: 'needs_you', reason: 'needs_details', message: `${name} said: "${err2}" — finish it yourself in this tab.` };
        if (!o || o.status === said) continue;
        said = o.status;
        status(o.status === 'placed' ? '🤖 Order placed.' : o.message);
        await acoReport(o.status, o.reason, o.status === 'placed' ? `Order confirmed at ${name}` : o.message, total);
        if (o.status !== 'needs_you') return;
      }
    }
  }

  // --- card boxes ---------------------------------------------------------------------------------
  // Payment frames often draw their boxes a moment after loading.
  for (let i = 0; i < 480 && !cardBoxes().length; i++) {
    if (i >= 20) break;
    await wait(500);
  }
  if (!cardBoxes().length) {
    // Drawn later still (a checkout step that opens the card form): keep a light watch for 4 minutes.
    for (let i = 0; i < 160 && !cardBoxes().length; i++) await wait(1500);
    if (!cardBoxes().length) return;
  }

  // The checkout may not have reached this tab yet (or the frame loaded early): keep asking for a while.
  const end = Date.now() + 4 * 60 * 1000;
  let card = null;
  while (!card && Date.now() < end) {
    const res = await ask({ type: 'fillData', part: 'card' });
    if (res && res.card) card = res.card;
    else await wait(1500);
  }
  if (!card) return;
  const values = MGBFill.fieldValues(null, card);
  const MAX_TRIES = 3; // then leave the box to you (and stop taking the focus)
  const tries = new Map();
  const how = new Map();
  let sent = '';
  let focusAsked = false;

  // Did the box keep what was typed? (Its own formatting is fine: the digits must match.)
  const kept = (el) => {
    const kind = kindOf(el);
    const want = values[kind];
    if (!el.value) return false;
    if (/^card(Number|Cvc)$/.test(kind)) return digits(el.value) === digits(want);
    if (kind === 'cardExpiry') { const d = digits(el.value); return d === digits(want) || d === digits(want).slice(0, 2) + digits(card.expYear); }
    return true;
  };

  const report = (boxes, pending) => {
    const filled = boxes.filter((el) => el.value).length;
    const detail = boxes.map((el) => `${kindOf(el)} ${el.value ? (kept(el) ? 'filled' : 'wrong') : el.readOnly ? 'read-only' : el.disabled ? 'disabled' : 'empty'}${how.has(el) ? ` (${how.get(el)})` : ''}`).join(', ');
    const done = !pending.length;
    if (`${filled}|${done}|${detail}` === sent) return;
    sent = `${filled}|${done}|${detail}`;
    ask({ type: 'cardFrame', seen: boxes.length, filled, done, detail });
  };

  while (Date.now() < end) {
    MGBFill.fillFields(document, values, { onlyCard: true, selectsOnly: true });
    const boxes = cardBoxes().filter(MGBFill.isVisible);
    for (const el of boxes) {
      const kind = kindOf(el);
      if (el.tagName === 'SELECT' || !values[kind] || el.readOnly || el.disabled) continue;
      if (el.value && kept(el)) continue;
      if ((tries.get(el) || 0) >= MAX_TRIES) continue;
      const n = (tries.get(el) || 0) + 1;
      tries.set(el, n);
      const release = await MGBFill.requestFocus();
      let focused = document.hasFocus();
      if (!focused && !focusAsked) {
        // The browser window isn't the one in front (⚡ Buy from the Discord app, say): bring this tab
        // forward once, so the box can take real typing.
        focusAsked = true;
        await ask({ type: 'focusTab' });
        await wait(300);
        focused = document.hasFocus();
      }
      if (el.value) MGBFill.typeInto(el, '', kind); // (what it wrongly kept, cleared first)
      // The expiry: as MM/YY first; a box that formats it itself may want the digits alone (MMYY).
      const value = kind === 'cardExpiry' && n > 1 ? digits(values[kind]) : values[kind];
      const result = MGBFill.typeInto(el, value, kind);
      release();
      await wait(250); // the box's own formatting, and (some) its check
      how.set(el, `${focused ? result : `${result}, no focus`}${el.value && !kept(el) ? ', kept wrong' : ''}`);
    }
    // Still to do: boxes there's something saved for that haven't kept it, unless we've given up on them.
    const pending = boxes.filter((el) => values[kindOf(el)] && el.tagName !== 'SELECT' && !(el.value && kept(el)) && (tries.get(el) || 0) < MAX_TRIES);
    report(boxes, pending);
    if (boxes.length && !pending.length) {
      // Done here — but a box can be cleared by the form a moment later (a re-check): look once more.
      await wait(2000);
      if (cardBoxes().filter(MGBFill.isVisible).every((el) => !values[kindOf(el)] || el.tagName === 'SELECT' || (el.value && kept(el)) || (tries.get(el) || 0) >= MAX_TRIES)) return;
      continue;
    }
    await wait(1500);
  }
})();
