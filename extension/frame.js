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
  const wait = MGBFlows.wait; // (at full speed in a tab in the background too)
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
    // (Pressed already, the store hasn't taken the order, and it's not 30 minutes yet: it may press again.)
    const retrying = (r) => !!(r && r.placing && !r.stopped && !r.done && r.placingAt && Date.now() - r.placingAt < MGBChecks.RETRY_MS);
    if (run && run.placing) {
      // Back after this run's final button was pressed (the frame moved on): how it went — and, its form back
      // without having taken the order (the store's struggling), filled in again and pressed again (below).
      // (Only when the form says the store's struggling — busy, try again, sold out just now: saying nothing,
      //  or anything else, the order may be going through, and it's only watched, for 30 s as ever.)
      let busy = false;
      for (const until = Date.now() + 30000; Date.now() < until && !busy; await wait(500)) {
        const o = MGBChecks.outcome(document, C.done, name);
        if (o) { status(o.status === 'placed' ? '🤖 Order placed.' : o.message); await acoReport(o.status, o.reason, o.status === 'placed' ? `Order confirmed at ${name}` : o.message); return; }
        busy = retrying(run) && MGBChecks.errorKind(MGBChecks.pageError(document)) === 'busy';
      }
      if (!busy) return;
    }
    let beatAt = 0;
    const beat = (text) => { if (!run || Date.now() - beatAt < 30000) return; beatAt = Date.now(); ask({ type: 'acoReport', status: 'beat', message: text }); };
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
      // (An Auto-checkout run: a store slowed right down gets up to 30 minutes.)
      patientMs: run ? MGBChecks.RETRY_MS : 0,
      onBeat: run ? beat : null,
    });
    clearInterval(watch);
    // (A ⚡ Buy at the final button, or stuck, for you: the store's next checkout goes in a few minutes. Auto-checkout's runs say so themselves.)
    if (!run && ['ready', 'final', 'needs_you', 'timeout'].includes(result)) ask({ type: 'turnEnd', parked: true });
    if (result === 'final' && run && fin) return finish(run, fin);
    if (run && (result === 'needs_you' || result === 'timeout')) await acoReport('needs_you', result === 'timeout' ? 'timeout' : 'needs_details', `Checkout got stuck at ${name} — finish it yourself in this tab.`);
    if (run && result === 'done') await acoReport('placed', '', `Order confirmed at ${name}`);

    async function stop(st, reason, message, total) {
      status(`🤖 ${message}`);
      fin.el.style.setProperty('outline', '4px solid #f59e0b', 'important');
      try { fin.el.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
      await acoReport(st, reason, message, total);
    }

    /**
     * The final button of an Auto-checkout run, in this frame: the same checks as on a checkout page (instant
     * reads), then pressed — and pressed again while the store's struggling, for up to half an hour (each
     * press asked of the extension first), never past a decline, your bank's check or a human check.
     */
    async function finish(r, f) {
      if (r.mode !== 'place') {
        f.el.style.setProperty('outline', '4px solid #22c55e', 'important');
        try { f.el.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
        status(`🤖 Filled in — review everything and press "${f.text}" yourself.`);
        await acoReport('ready', '', `Filled in at ${name} — waiting for you to press "${f.text}"`);
        return;
      }
      if (r.placing && !retrying(r)) return; // pressed already, and over: never again
      if (C.payment === 'card' && !data.card && !MGBChecks.savedCardShown(document, C, cardHere().length > 0)) return stop('needs_you', 'card_missing', 'No card is saved in the extension — add it (icon → Card settings) and finish this yourself.');
      if (C.payment === 'card' && data.card && !MGBChecks.savedCardShown(document, C, cardHere().length > 0)) {
        let ok = false;
        for (let i = 0; i < 15 && !ok; i++) { ok = await cardReady(true); if (!ok) await wait(1000); }
        if (!ok) return stop('needs_you', 'card_not_filled', "Your card didn't go into the store's card boxes — type it in and press the button yourself.");
      }
      const values = MGBFill.fieldValues(data.profile, data.card);
      if (MGBChecks.pageError(document) || MGBChecks.missingRequired(document)) MGBFill.fillFields(document, values, { flow: C });
      const err = MGBChecks.pageErrors(document).find((t) => !['busy', 'working'].includes(MGBChecks.errorKind(t)));
      if (err) return stop('needs_you', 'needs_details', `The form says: "${err}" — fix it and press the button yourself.`);
      const missing = MGBChecks.missingRequired(document);
      if (missing) return stop('needs_you', 'needs_details', `"${missing}" still needs filling in — fill it and press the button yourself.`);
      let total = MGBChecks.orderTotal(document);
      // (Other things already in the bag, bought too: your limit an order, within the day's spending.)
      const limit = r.others && typeof r.orderLimit === 'number' ? r.orderLimit : r.maxTotal;
      const within = (t) => {
        if (t === null) { stop('needs_you', 'no_total', "Couldn't read the order total to check it against your limit — check it and press the button yourself."); return false; }
        if (t > limit) { stop('needs_you', 'over_limit', `The total, $${t.toFixed(2)}, is over your limit of $${limit.toFixed(2)} — check it and press the button yourself if it's right.`, t); return false; }
        return true;
      };
      if (!within(total)) return;
      const off = (b) => !b || !b.isConnected || b.disabled || b.getAttribute('aria-disabled') === 'true' || !MGBFill.isVisible(b);
      const now = () => (f.el.isConnected && MGBFill.isVisible(f.el) ? f.el : [...document.querySelectorAll('button, input[type="submit"], a, [role="button"]')].find((el) => MGBFill.isVisible(el) && (el.innerText || el.value || '').trim() === f.text) || null);
      const pageBusy = () => typeof MGBQuick !== 'undefined' && MGBQuick.pageBusy();
      const working = () => MGBChecks.errorKind(MGBChecks.pageError(document)) === 'working';
      // (Of everything the form says, the first that isn't one of these kinds; a box marked wrong or still empty.)
      const saysOther = (ok) => MGBChecks.pageErrors(document).find((t) => !ok.includes(MGBChecks.errorKind(t))) || '';
      const fieldShown = () => !!MGBChecks.missingRequired(document) || [...document.querySelectorAll('[aria-invalid="true"]')].some((el) => MGBFill.isVisible(el));
      const stopFor = (t) => (MGBChecks.errorKind(t) === 'declined' ? stop('failed', 'card_declined', `${name} said: ${t}`, total) : stop('needs_you', 'needs_details', `${name} says: "${t}" — finish it yourself in this tab (nothing more pressed).`, total));
      const said = async (o) => {
        status(o.status === 'placed' ? '🤖 Order placed.' : o.message);
        await acoReport(o.status, o.reason, o.status === 'placed' ? `Order confirmed at ${name}` : o.message, total);
      };
      let fieldTries = 0;
      for (let n = 0; ; n++) {
        // Its button free (and, pressing again, the form done with whatever it's at).
        let btn = now();
        let waited = false;
        for (const since = Date.now(); off(btn) || working() || (n > 0 && pageBusy()); waited = true) {
          if (Date.now() - since > MGBChecks.RETRY_MS) return stop('needs_you', n > 0 ? 'unconfirmed' : 'needs_details', n > 0 ? `${name} was still busy with "${f.text}" after 30 minutes — check your email for an order confirmation before buying it again.` : `"${f.text}" didn't become available in 30 minutes — check the form and press it yourself.`, total);
          const o = MGBChecks.outcome(document, C.done, name);
          if (o) return said(o);
          status(off(btn) ? `⏳ Waiting for "${f.text}" to turn on (the store's slow)…` : `⏳ ${name} is still working on it…`);
          beat(off(btn) ? `Waiting for "${f.text}" to turn on — ${name}'s checkout is slow (up to 30 minutes)` : `Waiting for ${name} to finish what it's doing`);
          await wait(250);
          btn = now();
        }
        if (n > 0 || waited) {
          // Before pressing again (or after waiting on the form): filled in still, nothing it says that's never
          // pressed past, nothing it needs still empty, and the total — read again — within the limit.
          MGBFill.fillFields(document, values, { flow: C });
          const says = saysOther(n > 0 ? ['busy', 'working', 'field'] : ['busy', 'working']);
          if (says) return stopFor(says);
          const empty = MGBChecks.missingRequired(document);
          if (empty) return stop('needs_you', 'needs_details', `"${empty}" still needs filling in — fill it and press the button yourself.`, total);
          total = MGBChecks.orderTotal(document);
          if (!within(total)) return;
        }
        // (Asked first — and said to your account: the frame may go the moment it's pressed. Pressing again,
        //  your account is asked whether the run's still going.)
        const message = n === 0 ? `Pressing "${f.text}" — total $${total.toFixed(2)}` : `Pressing "${f.text}" again — ${name} hasn't taken the order yet`;
        const go = await ask({ type: 'acoRetry', message, total });
        if (!go || !go.ok) {
          if (go && go.over) return stop('needs_you', 'not_placed', `Pressed "${f.text}" again and again for ${Math.round((Date.now() - go.since) / 60000)} minutes and ${name} kept turning it away — nothing more pressed. Check your email before buying it again.`, total);
          if (go && go.ended) status('🤖 This checkout ended on your account meanwhile — nothing more pressed.');
          return;
        }
        status(go.n === 1 ? `🤖 Placing your order ($${total.toFixed(2)})…` : `🤖 Pressing "${f.text}" again (${go.n}) — ${name}'s struggling…`);
        report('step', `Auto-checkout pressed "${f.text}"${go.n > 1 ? ` again (${go.n})` : ''} (total $${total.toFixed(2)})`);
        // (What the form said before this press isn't its answer to it: only something it says anew.)
        MGBChecks.markErrors(document);
        btn.click();
        // The store's answer, as far as this frame shows it (the page above takes over if it moves on). No
        // answer at all is never a reason to press again: waited for, up to the half hour.
        let ans = null;
        let errSince = 0;
        for (const started = Date.now(); !ans;) {
          await wait(400);
          const o = MGBChecks.outcome(document, C.done, name);
          if (o) { await said(o); return; }
          const e = MGBChecks.pageError(document, null, true);
          errSince = e ? errSince || Date.now() : 0;
          const k = e ? MGBChecks.errorKind(e) : '';
          if (e && k !== 'working' && Date.now() - errSince > 2500 && !off(now())) {
            if (k === 'declined') { await said({ status: 'failed', reason: 'card_declined', message: `${name} said: ${e}` }); return; }
            if (k === 'busy' || (k === 'field' && fieldShown())) { ans = { kind: k === 'field' ? 'field' : 'again', text: e }; continue; }
            // (The payment, the card, your bank, a human check — or words it doesn't know: never pressed past.)
            await said({ status: 'needs_you', reason: 'needs_details', message: `${name} said: "${e}" — finish it yourself in this tab (nothing more pressed).` });
            return;
          }
          if (Date.now() - started > MGBChecks.RETRY_MS) { await said({ status: 'needs_you', reason: 'unconfirmed', message: `"${f.text}" was pressed and ${name} still hadn't answered after 30 minutes — check your email for the order confirmation before buying it again.` }); return; }
          beat(`Pressed — waiting for ${name} to answer (it's slow)`);
        }
        if (ans.kind === 'field' && ++fieldTries > 2) return stop('needs_you', 'needs_details', `${name} said: "${ans.text}" — finish it yourself in this tab.`, total);
        const w = MGBChecks.retryWait(n);
        status(`⏳ ${name} said "${ans.text.slice(0, 80)}" — pressing "${f.text}" again in ${Math.round(w / 1000)} s…`);
        for (const until = Date.now() + w; Date.now() < until;) {
          await wait(250);
          const o = MGBChecks.outcome(document, C.done, name);
          if (o) return said(o);
          const says = saysOther(['busy', 'working', 'field']);
          if (says) return stopFor(says);
        }
      }
    }
  }

  // --- a card the payment provider already has for you ------------------------------------------
  // Stripe's Link, connected: the frame shows your saved card ("•••• 4242"), no boxes to type into.
  // Said to the page (so the checkout knows the card's in), and — where the store's flow says so
  // (checkout.frameConfirm: Games World's "Confirm") — its own Confirm pressed, once. Only while a
  // checkout you started is running in this tab, at that store (the background worker checks).
  let saved = null; // { said, confirmed, words }
  async function savedCard() {
    if (cardBoxes().length || !MGBChecks.savedCardShown(document, null, false)) return;
    if (!saved) {
      const res = await ask({ type: 'fillData', part: 'confirm' });
      if (!res) return; // no checkout of yours in this tab
      saved = { said: false, confirmed: false, words: (MGBFlows.revive(res.confirm) || []).filter((re) => re && re.test) };
    }
    if (!saved.said) { saved.said = true; ask({ type: 'cardFrame', seen: 0, filled: 0, done: true, saved: true, detail: 'a card saved with the payment provider' }); }
    if (saved.confirmed || !saved.words.length) return;
    const b = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .find((el) => MGBFill.isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && saved.words.some((re) => re.test((el.innerText || el.value || '').replace(/\s+/g, ' ').trim())));
    if (b) { saved.confirmed = true; b.click(); }
  }

  // --- card boxes ---------------------------------------------------------------------------------
  // Payment frames often draw their boxes a moment after loading.
  for (let i = 0; i < 480 && !cardBoxes().length; i++) {
    if (i >= 20) break;
    await savedCard();
    await wait(500);
  }
  if (!cardBoxes().length) {
    // Drawn later still (a checkout step that opens the card form): keep a light watch for 4 minutes.
    for (let i = 0; i < 160 && !cardBoxes().length; i++) { await savedCard(); await wait(1500); }
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
      // Several checkouts at once: one tab types a card box at a time, brought forward for it.
      const turn = await ask({ type: 'typeTurn' });
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
      if (turn && turn.ok) ask({ type: 'typeDone' });
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
