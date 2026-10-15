// Mugibot — runs inside payment frames (card number / expiry / CVV boxes
// hosted by the store's payment provider, like Kmart's). Fills your saved card
// only while a checkout you started is running in this tab, on that store
// (checked by the background worker). Each box is focused through the page
// above (these boxes only keep real typing into a focused box) and typed into
// one at a time. Then it tells the page what went in, box by box, so the page
// can say exactly why if the card didn't.

(async () => {
  'use strict';
  if (window.top === window.self) return;
  MGBFill.startFocusBroker(); // for payment frames inside this one
  const ask = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res)); } catch { resolve(null); }
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const kindOf = (el) => MGBFill.classifyField(el) || '';
  const cardBoxes = () => [...document.querySelectorAll('input, select')].filter((el) => MGBFill.CARD_KINDS.includes(kindOf(el)));
  // Payment frames often draw their boxes a moment after loading.
  for (let i = 0; i < 20 && !cardBoxes().length; i++) await wait(500);
  if (!cardBoxes().length) return;

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

  const report = (boxes) => {
    const filled = boxes.filter((el) => el.value).length;
    const detail = boxes.map((el) => `${kindOf(el)} ${el.value ? 'filled' : el.readOnly ? 'read-only' : el.disabled ? 'disabled' : 'empty'}${how.has(el) ? ` (${how.get(el)})` : ''}`).join(', ');
    if (`${filled}|${detail}` === sent) return;
    sent = `${filled}|${detail}`;
    ask({ type: 'cardFrame', seen: boxes.length, filled, detail });
  };

  while (Date.now() < end) {
    MGBFill.fillFields(document, values, { onlyCard: true, selectsOnly: true });
    const boxes = cardBoxes().filter(MGBFill.isVisible);
    for (const el of boxes) {
      const kind = kindOf(el);
      if (el.tagName === 'SELECT' || el.value || !values[kind] || el.readOnly || el.disabled) continue;
      if ((tries.get(el) || 0) >= MAX_TRIES) continue;
      tries.set(el, (tries.get(el) || 0) + 1);
      const release = await MGBFill.requestFocus();
      const focused = document.hasFocus();
      const result = MGBFill.typeInto(el, values[kind], kind);
      release();
      how.set(el, focused ? result : `${result}, no focus`);
      await wait(200);
    }
    report(boxes);
    // Still to do: empty boxes there's something saved for, unless we've given up on them.
    const pending = boxes.filter((el) => !el.value && values[kindOf(el)] && (tries.get(el) || 0) < MAX_TRIES);
    if (boxes.length && !pending.length) return;
    await wait(1500);
  }
})();
