/* Mugibot — what Auto-checkout reads off a checkout before and after its final button
   (docs/AUTO-CHECKOUT.md): the order total, what the page says is wrong, whether the
   card went in, and how it ended (placed, declined, your bank's or a human check).

   The same checks run on the store's checkout page (content.js) and inside a checkout
   that runs in a frame of its own on that page (frame.js: Premium Bandai's Global-e,
   Amazon's quick checkout). */

var MGBChecks = (function () {
  'use strict';

  var CONFIRM_RE = /thank you for (your )?(order|purchase|shopping)|order (number|no\.?|#)\s*[:#]?\s*[A-Z0-9-]{4,}|your order (has been|is) (placed|confirmed|received)|order (confirmed|received|complete)\b/i;
  var DECLINE_RE = /declined|payment (failed|unsuccessful|was not (successful|processed)|could not be processed|didn.?t go through)|card (was|has been) (declined|rejected)|unable to (process|authori[sz]e) (your )?(payment|card)|insufficient funds|transaction (failed|was declined)|card number is (invalid|incorrect)|(expired|invalid) card/i;
  var BANK_RE = /3-?d ?secure|verify (it.?s you|your (identity|payment|purchase))|authenticat(e|ion)( your)? (payment|purchase)|one-?time (pass(code|word)|code)|enter the code (we|sent)|confirm (the )?payment in your (bank|banking) app|verified by visa|id check/i;
  var BANK_FRAME = /3ds|\/acs|acs\.|challenge|authenticat|cardinalcommerce|securecode|threeds|3dsecure/i;
  var HUMAN_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare|turnstile|captcha|arkoselabs|funcaptcha/i;
  var AMOUNT_RE = /(?:AUD\s?\$?|A\$|\$)\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
  var OURS = '#mugibot-qc, #mugibot-banner';
  // A card already saved with the store or its wallet (Shop Pay, a store account), shown instead of card boxes.
  // (EB Games shows its "...2387 08/27"; others "•••• 4242", "**** 4242", "ending in 4242".)
  var SAVED_CARD_RE = /(ending|ends) (in|with) \d{4}|(?:(?:•|\*|x|·|\.){2,}|…)\s?\d{4}\b/i;

  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  function visibleText(el) {
    return el && visible(el) && !el.closest(OURS) ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '';
  }

  /** The biggest amount of money shown on the checkout: at least the order total (each line is at most that). */
  function orderTotal(doc) {
    doc = doc || document;
    var best = null;
    var take = function (t) {
      var m;
      AMOUNT_RE.lastIndex = 0;
      while ((m = AMOUNT_RE.exec(t))) {
        var v = parseFloat(m[1].replace(/,/g, ''));
        if (isFinite(v) && (best === null || v > best)) best = v;
      }
    };
    // Amounts split over a few tags ("$<span>109.00</span>", "<span>$</span>109.00"): short bits of text, read whole.
    Array.prototype.slice.call(doc.body.querySelectorAll('*')).forEach(function (el) {
      if (el.childElementCount > 3 || el.closest(OURS + ', script, style, noscript, [class*="carousel" i], [class*="recommend" i], [class*="upsell" i]')) return;
      var t = (el.textContent || '').replace(/\s+/g, '');
      if (t.length > 24 || !/\$/.test(t) || !/\d/.test(t) || !visible(el)) return;
      take(t);
    });
    var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      var el = n.parentElement;
      if (!el || el.closest(OURS + ', script, style, noscript, [class*="carousel" i], [class*="recommend" i], [class*="upsell" i]')) continue;
      var t = n.nodeValue;
      if (!/\d/.test(t) || !/\$/.test(t)) continue;
      if (!visible(el)) continue;
      take(t);
    }
    return best;
  }

  // Good news a store shows the way it shows an error (WooCommerce's "“…” has been added to your cart."
  // is an alert too — at its checkout, after its add-to-cart link): not what's wrong.
  var GOOD_NEWS = /(^|[\s_-])(success|woocommerce-message|woocommerce-info|message-success|alert-success|notice-success)([\s_-]|$)/i;
  var ADDED_NEWS = /\b(has been |been )?added to your (shopping )?(cart|bag|basket|trolley)\b|^\W*you added\b/i;

  var ERROR_SEL = '[role="alert"], .error, .err, [class*="error" i], [class*="invalid" i]';

  /**
   * What the page says is wrong (an error message, or a box marked invalid), or ''. ignore: what the
   * store's flow says isn't a reason to stop (C.ignoreErrors: a notice about a box Mugibot ticks).
   * anew: only what it's said since markErrors() — a new message, or new words in an old one.
   */
  function pageError(doc, ignore, anew) {
    doc = doc || document;
    var els = doc.querySelectorAll(ERROR_SEL);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.matches('input, select, textarea, form, body')) continue;
      var t = visibleText(el);
      // (A message cleared or changed since it was marked: whatever it says next is new.)
      if (anew && el.hasAttribute('data-mgb-err') && el.getAttribute('data-mgb-err') !== t) el.removeAttribute('data-mgb-err');
      if (t && (GOOD_NEWS.test(el.getAttribute('class') || '') || ADDED_NEWS.test(t))) continue;
      if (t && (ignore || []).some(function (re) { return re && re.test && re.test(t); })) continue;
      if (anew && t && el.getAttribute('data-mgb-err') === t) continue;
      if (t && t.length < 300 && /[a-z]/i.test(t)) return t.slice(0, 160);
    }
    var bad = Array.prototype.slice.call(doc.querySelectorAll('[aria-invalid="true"]')).find(function (el) { return visible(el) && !(anew && el.hasAttribute('data-mgb-err')); });
    return bad ? '"' + (bad.getAttribute('aria-label') || bad.name || bad.id || 'a field').slice(0, 40) + '" needs attention' : '';
  }

  /** What the page says now, marked (just before the final button's pressed): pageError(…, true) reads only what it says after. */
  function markErrors(doc) {
    doc = doc || document;
    Array.prototype.forEach.call(doc.querySelectorAll(ERROR_SEL), function (el) {
      var t = visibleText(el);
      if (t) el.setAttribute('data-mgb-err', t);
    });
    Array.prototype.forEach.call(doc.querySelectorAll('[aria-invalid="true"]'), function (el) { el.setAttribute('data-mgb-err', '1'); });
  }

  /**
   * A box the form needs that's still empty (or a required tick box not ticked), as the form calls it —
   * or ''. Checked before Auto-checkout presses the final button: a form that's not done isn't sent.
   */
  function missingRequired(doc) {
    doc = doc || document;
    var els = Array.prototype.slice.call(doc.querySelectorAll('input[required], select[required], textarea[required], [aria-required="true"]'));
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (el.disabled || type === 'hidden' || el.closest(OURS)) continue;
      var box = type === 'checkbox' || type === 'radio' ? (el.closest('label') || el.parentElement || el) : el;
      if (!visible(box)) continue;
      var empty = type === 'checkbox' ? !el.checked
        : type === 'radio' ? !doc.querySelector('input[type="radio"][name="' + (el.name || '').replace(/"/g, '') + '"]:checked')
          : !String(el.value || '').trim();
      if (!empty) continue;
      var label = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || 'a box';
      return String(label).replace(/\s+/g, ' ').trim().slice(0, 60);
    }
    return '';
  }

  /**
   * How it went after the final button, from what the page shows (null: can't tell yet).
   * done: the store's order-placed address; name: the store's name, for the messages.
   */
  function outcome(doc, done, name) {
    doc = doc || document;
    done = done || /confirmation|thank-?you|order-?(complete|received|success)/i;
    if (done.test(doc.location.pathname)) return { status: 'placed' };
    var text = (doc.body.innerText || '').slice(0, 20000);
    if (CONFIRM_RE.test(text)) return { status: 'placed' };
    var frames = Array.prototype.slice.call(doc.querySelectorAll('iframe')).filter(visible).map(function (f) { return f.src || f.getAttribute('src') || ''; });
    if (frames.some(function (f) { return HUMAN_FRAME.test(f); })) return { status: 'needs_you', reason: 'human_check', message: name + ' wants to check you\'re human — finish it yourself in this tab (Mugibot never gets past these).' };
    if (frames.some(function (f) { return BANK_FRAME.test(f); }) || BANK_RE.test(text)) return { status: 'needs_you', reason: 'bank_check', message: 'Your bank wants you to confirm the payment — finish it in this tab.' };
    var err = pageError(doc);
    if (err && DECLINE_RE.test(err)) return { status: 'failed', reason: 'card_declined', message: name + ' said: ' + err };
    if (DECLINE_RE.test(text.slice(0, 4000))) return { status: 'failed', reason: 'card_declined', message: name + ' declined the payment.' };
    return null;
  }

  /**
   * The store says it won't sell it to you now (C.unavailable: Shop checkout links' "This Product is not
   * available for purchase"): its words, or ''.
   */
  function unavailable(doc, C) {
    var list = ((C && C.unavailable) || []).filter(function (re) { return re && re.test; });
    if (!list.length) return '';
    var main = (doc || document).querySelector('main') || (doc || document).body;
    var lines = String(main.innerText || '').slice(0, 20000).split(/\n+/);
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].replace(/\s+/g, ' ').trim();
      if (t.length < 200 && list.some(function (re) { return re.test(t); })) return t.slice(0, 160);
    }
    return '';
  }

  /**
   * The checkout pays with a card the store (or its wallet: Shop Pay) already has for you, shown as
   * "Visa •••• 4242" with no card boxes to fill. C.savedCard: the store's own wording, if it differs.
   */
  function savedCardShown(doc, C, cardBoxesShown) {
    if (cardBoxesShown) return false;
    var re = (C && C.savedCard) || SAVED_CARD_RE;
    var main = (doc || document).querySelector('main') || (doc || document).body;
    return re.test((main.innerText || '').slice(0, 20000));
  }

  // After the final button: what the store said about a box (filled in again, then pressed again) — anything
  // else it says (it's busy, something went wrong, try again, even sold out for now) is the store under load:
  // pressed again, a little later each time, up to half an hour. A decline, your bank's check or a human
  // check is never pressed through (outcome(), above).
  var FIELD_ERR_RE = /\brequired\b|\binvalid\b|\bincorrect\b|not (a )?valid|please (enter|select|choose|provide|fill|check|complete|tick|accept|agree)|must (be|accept|select|enter|agree|tick)|\bmissing\b|enter a valid|doesn.?t match|is too (short|long)|needs attention/i;
  function errorKind(text) {
    var t = String(text || '');
    if (!t) return '';
    if (DECLINE_RE.test(t)) return 'declined';
    return FIELD_ERR_RE.test(t) ? 'field' : 'busy';
  }
  // How long before pressing again: as a person would (3 s, 5 s, 8 s… then every 20 s).
  var RETRY_WAITS = [3000, 5000, 8000, 10000, 15000, 15000, 20000];
  function retryWait(n) { return RETRY_WAITS[Math.min(Math.max(n, 0), RETRY_WAITS.length - 1)]; }
  // The longest an Auto-checkout run keeps at it on the checkout: the final button turning on, and pressing
  // it again while the store's struggling (a hot drop) — then it stops, nothing bought.
  var RETRY_MS = 30 * 60 * 1000;
  // No answer at all to a press (nothing said, its button free, nothing busy): this long, then pressed again.
  // (A store still working on it shows so — its button greyed out or busy, a spinner — and is waited for.)
  var NO_ANSWER_MS = 20000;

  return { CONFIRM_RE: CONFIRM_RE, DECLINE_RE: DECLINE_RE, RETRY_MS: RETRY_MS, NO_ANSWER_MS: NO_ANSWER_MS, errorKind: errorKind, retryWait: retryWait, orderTotal: orderTotal, pageError: pageError, markErrors: markErrors, missingRequired: missingRequired, outcome: outcome, savedCardShown: savedCardShown, unavailable: unavailable, visible: visible };
})();
