// Mugibot — runs inside payment frames (card number / expiry / CVV boxes
// hosted by the store's payment provider, like Kmart's Adyen boxes). Fills
// your saved card only while a checkout you started is running in this tab,
// on that store (checked by the background worker), and tells the page what
// it filled, so the page can say when the card didn't go in.

(async () => {
  'use strict';
  if (window.top === window.self) return;
  const ask = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res)); } catch { resolve(null); }
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const cardBoxes = () => [...document.querySelectorAll('input, select')].filter((el) => MGBFill.CARD_KINDS.includes(MGBFill.classifyField(el) || ''));
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
  let last = -1;
  while (Date.now() < end) {
    MGBFill.fillFields(document, values, { onlyCard: true });
    const boxes = cardBoxes().filter(MGBFill.isVisible);
    const filled = boxes.filter((el) => el.value).length;
    if (filled !== last) {
      last = filled;
      ask({ type: 'cardFrame', seen: boxes.length, filled });
    }
    // Done when every box has something in it, apart from ones there's nothing saved for (e.g. no CVV).
    const left = boxes.filter((el) => !el.value && values[MGBFill.classifyField(el)]).length;
    if (boxes.length && !left) return;
    await wait(600);
  }
})();
