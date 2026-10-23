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
  // After the final button, the bank's check as stores and payment providers really show it (Oct 2026: two
  // runs sat waiting on one Mugibot didn't see) — whatever the store, whatever the bank. Its frame often has no
  // address to go by (the bank's page is posted into it), but its name, title or the box it's in say what it is
  // (the 3-D Secure names payment providers give it: Adyen's "threeDSIframe", Cardinal's, Stripe's, Checkout.com's,
  // "challenge", "step-up", "acsFrame") — or the words the press brought up beside it, in any bank's terms
  // ("Approve this payment in your banking app", "We've sent a code to your phone", "Verify your purchase").
  // Never a bank's name alone: no list of banks to keep up.
  var BANK_HINT = /3ds|3-?d.?secure|three.?d.?s|threeds|\bacs\b|acs.?frame|challenge|authenticat|cardinal|songbird|secure.?code|safekey|identity.?check|visa.?secure|step.?up|verif(y|ication)|\botp\b|one.?time.?pass/i;
  var BANK_SAID = new RegExp([
    // approving it: in an app, by a notification, on a device
    "approve (it|this|the|your) (payment|purchase|transaction|request|order)",
    "approve (it |this |the payment |the purchase )?(in|with|on) (your|the) [\\w' .-]{0,30}app\\b",
    "(check|open|use|go to) (your|the) [\\w' .-]{0,30}app to (approve|confirm|verify|authori[sz]e)", "(check|open) your [\\w' .-]{0,30}app\\b",
    "(approve|confirm|accept) (the )?(request|notification|prompt) (in|on|from|we)",
    "check your (phone|mobile|device)", "push notification", "\\bbanking app\\b",
    // a code it sends
    "(we('ve| have)? )?(sent|texted) (a |an |you a |you an )?(\\d-digit |one.?time |verification |security )?(code|passcode|sms)",
    "(enter|type|input) (the |your )?(\\d-digit )?(verification|one.?time|sms) (code|passcode|password)", "verification code (was |has been )?sent",
    "one.?time (pass(code|word)|code)", "enter the code (we|sent)", "\\bnetcode\\b",
    // checking it's you, the payment
    "(payment|purchase|transaction) (authentication|verification|approval)",
    "(verify|authori[sz]e) (this|the|your) (payment|purchase|transaction)", "confirm (this|the) (payment|purchase|transaction)",
    "(confirm|verify) (it.?s|it is) you", "(continue|complete) (the )?(verification|authentication)",
    "wait(ing)? for (your )?(bank|approval|authori[sz]ation)",
    // the card schemes' own names for it
    "visa secure", "\\bsafekey\\b", "mastercard (identity check|securecode)", "strong customer authentication",
  ].join('|'), 'i');
  // Frames that come and go on a checkout for other reasons (chat, reviews, ads, video, other ways to pay) — or
  // that are a store's whole checkout (Global-e's, Amazon's): never the bank's.
  var NOT_BANK_FRAME = /intercom|zendesk|zopim|livechat|tawk|crisp\.chat|drift|gorgias|tidio|freshchat|hubspot|facebook|doubleclick|googletagmanager|google-analytics|googlesyndication|youtube|vimeo|klaviyo|privy|justuno|attentive|yotpo|trustpilot|okendo|judge\.me|hotjar|clarity\.ms|tiktok|pinterest|paypal|afterpay|klarna|zip\.co|pay\.google|global-e|amazon\./i;
  var AMOUNT_RE = /(?:AUD\s?\$?|A\$|\$)\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
  var OURS = '#mugibot-qc, #mugibot-banner';
  // A card already saved with the store or its wallet (Shop Pay, a store account), shown instead of card boxes.
  // (EB Games shows its "...2387 08/27"; others "•••• 4242", "**** 4242", "ending in 4242".)
  // (Dots or "…" before the digits only with an expiry after them, or a card's name before: "Loading...\n2026" isn't a card.)
  var SAVED_CARD_RE = /(ending|ends) (in|with) \d{4}|(?:•|\*|x|·){2,}[ \t\u00a0]?\d{4}\b|(?:\.{2,}|…)[ \t\u00a0]?\d{4}\s{0,3}\d{2}[ \t]?\/[ \t]?(?:\d{4}|\d{2})\b|\b(?:visa|mastercard|master card|amex|american express|card)\b[^\n]{0,24}(?:\.{2,}|…)[ \t\u00a0]?\d{4}\b/i;

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

  /** Everything the page says is wrong just now (each message's words), for a check that mustn't miss one behind another. */
  function pageErrors(doc, ignore) {
    doc = doc || document;
    var out = [];
    Array.prototype.forEach.call(doc.querySelectorAll(ERROR_SEL), function (el) {
      if (el.matches('input, select, textarea, form, body')) return;
      var t = visibleText(el);
      if (!t || t.length >= 300 || !/[a-z]/i.test(t)) return;
      if (GOOD_NEWS.test(el.getAttribute('class') || '') || ADDED_NEWS.test(t)) return;
      if ((ignore || []).some(function (re) { return re && re.test && re.test(t); })) return;
      if (out.indexOf(t.slice(0, 160)) === -1) out.push(t.slice(0, 160));
    });
    return out;
  }

  /**
   * What the page says now, marked (just before the final button's pressed): pageError(…, true) reads only what
   * it says after. A message the page draws again — cleared and put back, word for word, quicker than it's looked
   * at (a store's "please try again" after each press) — is said anew: watched for, and its mark taken off.
   */
  var errWatch = null;
  function markErrors(doc) {
    doc = doc || document;
    markPress(doc, false);
    Array.prototype.forEach.call(doc.querySelectorAll(ERROR_SEL), function (el) {
      var t = visibleText(el);
      if (t) el.setAttribute('data-mgb-err', t);
    });
    Array.prototype.forEach.call(doc.querySelectorAll('[aria-invalid="true"]'), function (el) { el.setAttribute('data-mgb-err', '1'); });
    if (errWatch) errWatch.disconnect();
    if (typeof MutationObserver === 'undefined' || !doc.body) return;
    errWatch = new MutationObserver(function (list) {
      list.forEach(function (m) {
        var el = m.target && (m.target.nodeType === 1 ? m.target : m.target.parentElement);
        var marked = el && el.closest ? el.closest('[data-mgb-err]') : null;
        // (Cleared, or other words: whatever it says next is new. The same words left as they were — an icon
        //  changing, a re-render — aren't.)
        if (marked && visibleText(marked) !== marked.getAttribute('data-mgb-err')) marked.removeAttribute('data-mgb-err');
      });
    });
    errWatch.observe(doc.body, { subtree: true, childList: true, characterData: true });
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

  // --- after the final button: what the press brought up ----------------------------------------
  // Marked just before the press (markErrors), or as a page that came after one loads (markAfter): the frames
  // on the page then, and the words about approving a payment it said then — so only what the press brought
  // up counts.
  var pressMark = null; // { doc, frames: [iframe], said: { words: true }, fresh }

  // (A line that says the check went wrong — "Payment authentication failed" — isn't the bank asking: what the
  //  store said is for you as it is: answer() / pageError.)
  var BANK_FAILED = /fail|unsuccessful|unable|could ?n.?t|cannot|declin|error|expired|timed? ?out|try again/i;
  function saidIn(text) {
    var re = new RegExp(BANK_SAID.source, 'gi');
    var out = [];
    String(text || '').split(/\n+/).forEach(function (line) {
      if (BANK_FAILED.test(line)) return;
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(line))) out.push(m[0].toLowerCase());
    });
    return out;
  }

  function markPress(doc, fresh, away) {
    var said = {};
    if (!away) saidIn((doc.body.innerText || '').slice(0, 20000)).forEach(function (t) { said[t] = true; });
    pressMark = { doc: doc, frames: Array.prototype.slice.call(doc.querySelectorAll('iframe')), said: said, fresh: !!fresh, away: !!away, at: Date.now() };
  }

  /**
   * This page came after the final button was pressed (the store moved on to it): a frame named, titled or boxed
   * for the bank's check counts whether it was up as the page loaded or not. away: a page that isn't the checkout
   * itself — what it says about approving a payment, and a frame in front of it, count from the start too (else
   * only what it shows from now on: the checkout back again shows what it showed before).
   */
  function markAfter(doc, away) { markPress(doc || document, true, !!away); }

  function hostOf(src, doc) {
    if (!src) return '';
    try { return new URL(src, doc.location.href).host; } catch (e) { return ''; }
  }

  /** What a frame is, by the frame and the boxes it sits in: its address, name, title, class and label. */
  function frameWords(f) {
    var parts = [f.getAttribute('src') || '', f.getAttribute('name') || '', f.id || '', f.getAttribute('title') || '', f.getAttribute('class') || '', f.getAttribute('aria-label') || ''];
    for (var p = f.parentElement, i = 0; p && i < 5 && p !== f.ownerDocument.body; p = p.parentElement, i++) {
      parts.push(p.id || '', p.getAttribute('class') || '', p.getAttribute('aria-label') || '', p.getAttribute('data-testid') || '');
    }
    return parts.join(' ');
  }

  function sized(f, w, h) {
    var r = f.getBoundingClientRect();
    return r.width >= w && r.height >= h;
  }

  /** In front of the checkout: in a pop-up box, or nothing over its middle — and big enough to answer in. */
  function inFront(f) {
    if (!sized(f, 250, 250)) return false;
    if (f.closest('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="modal" i], [class*="overlay" i], [class*="popup" i], [class*="lightbox" i]')) return true;
    var r = f.getBoundingClientRect();
    var win = f.ownerDocument.defaultView;
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    if (!win || x < 0 || y < 0 || x > win.innerWidth || y > win.innerHeight) return false;
    return f.ownerDocument.elementFromPoint(x, y) === f;
  }

  /**
   * The bank's check, as the final button's press brought it up on this page (null: nothing like it):
   * - a frame named, titled or boxed for it — Adyen's "threeDSIframe", Cardinal's, Stripe's: its address is no
   *   help, the bank's page is posted into it (new since the press; on a page after the press, any);
   * - a frame new since the press, in front of the checkout and big enough to answer in — not chat, ads, video,
   *   PayPal, Afterpay: most likely the bank's (the one way to tell a frame the bank's posted into with no name)
   *   (on a page after the press that isn't the checkout, any);
   * - words new since the press about approving the payment ("Approve this payment in your CommBank app") — on a
   *   page after the press that isn't the checkout, any; never a line saying it went wrong (saidIn);
   * - a page after the press whose address says it's the bank's check (…/3ds, …/authentication).
   * { how: 'frame' | 'popup' | 'words' | 'page', host }
   */
  function bankAfterPress(doc, text, inFrame) {
    var m = pressMark;
    if (!m || m.doc !== doc) return null;
    var frames = Array.prototype.slice.call(doc.querySelectorAll('iframe')).filter(function (f) { return visible(f) && !f.closest(OURS); });
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var src = f.getAttribute('src') || '';
      var host = hostOf(src, doc);
      if (HUMAN_FRAME.test(src) || NOT_BANK_FRAME.test(host)) continue;
      var fresh = m.frames.indexOf(f) === -1;
      // (Card boxes are a line high, and up before the press: never these.)
      if ((fresh || m.fresh) && sized(f, 100, 100) && BANK_HINT.test(frameWords(f))) return { how: 'frame', host: host };
      // (Inside a payment provider's frame — its card boxes, its form: a frame of a size to answer in that the
      //  press brought up there is the bank's, wherever it sits in that frame.)
      if ((fresh || m.away) && (inFront(f) || (inFrame && sized(f, 200, 200)))) return { how: 'popup', host: host };
    }
    if (saidIn(text).some(function (t) { return !m.said[t]; })) return { how: 'words', host: '' };
    if (m.fresh && /3ds|three.?d.?s|threeds|\/acs\b|authenticat|challenge/i.test(doc.location.pathname + doc.location.search)) return { how: 'page', host: '' };
    return null;
  }

  /**
   * Every frame on the checkout marked as the final button's pressed (the background asks each: bankMark — not
   * waited for, so the press isn't held up). A frame that marked itself for its own press a moment ago (a checkout
   * in a frame: frame.js) keeps that mark: the background's may come after what the press brought up.
   */
  function markPressed(doc) {
    doc = doc || document;
    if (pressMark && pressMark.doc === doc && !pressMark.fresh && Date.now() - pressMark.at < 3000) return;
    markPress(doc, false, false);
  }

  /**
   * In a frame on the checkout — a payment provider's (its card boxes, its form), or one inside one — asked from
   * the background after the final button (bankFrames): the bank's check the press brought up in it, as on the
   * page (bankAfterPress). A frame that came after the press counts what it shows from the start. (Its own
   * frames the extension may not open — the bank's — are looked at from here, the frame they're in.)
   */
  function bankShown(doc) {
    doc = doc || document;
    if (!doc.body) return null;
    // (Not marked at the press: it came after it — what it shows counts, words too, if it's a frame of a size to
    //  answer in. A card box's frame that's drawn again shows only its labels, never words of this kind, but a
    //  provider's "Visa Secure" badge isn't an ask: only what's new since the press, or in a new frame, counts.)
    var win = doc.defaultView;
    if (!pressMark || pressMark.doc !== doc) markPress(doc, true, !!(win && win.innerWidth >= 200 && win.innerHeight >= 150));
    return bankAfterPress(doc, (doc.body.innerText || '').slice(0, 20000), true);
  }

  /** What your account's told when the bank's check comes up (it DMs you at once). */
  function bankMessage(name, b) {
    var what = b && b.how === 'popup'
      ? 'A pop-up came up on the checkout after paying' + (b.host ? ' (' + b.host.slice(0, 60) + ')' : '') + ' — most likely your bank wanting you to approve it'
      : 'Your bank wants you to approve this payment';
    return what + ": approve it in your bank's app (or with the code it sent you), or in the checkout tab. It's marked placed once " + name + ' confirms the order.';
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
    if (frames.some(function (f) { return BANK_FRAME.test(f); }) || BANK_RE.test(text)) return { status: 'needs_you', reason: 'bank_check', message: bankMessage(name, null) };
    var err = pageError(doc);
    if (err && DECLINE_RE.test(err)) return { status: 'failed', reason: 'card_declined', message: name + ' said: ' + err };
    if (DECLINE_RE.test(text.slice(0, 4000))) return { status: 'failed', reason: 'card_declined', message: name + ' declined the payment.' };
    var b = bankAfterPress(doc, text);
    if (b) return { status: 'needs_you', reason: 'bank_check', message: bankMessage(name, b), how: b.how };
    return null;
  }

  /**
   * What's on the checkout while the store hasn't answered the press (for your account's run history, so a run
   * that's waiting shows why): a pop-up box's words, a frame the press brought up — numbers left out. '' for none.
   */
  function showing(doc) {
    doc = doc || document;
    var out = [];
    var box = Array.prototype.slice.call(doc.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'))
      .filter(function (el) { return visible(el) && !el.closest(OURS); })[0];
    var t = box ? (box.innerText || '').replace(/\s+/g, ' ').trim() : '';
    if (t) out.push('"' + t.replace(/\d{3,}/g, '•••').slice(0, 100) + '"');
    var m = pressMark && pressMark.doc === doc ? pressMark : null;
    var fresh = Array.prototype.slice.call(doc.querySelectorAll('iframe')).filter(function (f) { return visible(f) && sized(f, 100, 100) && !f.closest(OURS) && (!m || m.frames.indexOf(f) === -1); });
    if (fresh.length) out.push(fresh.length === 1 ? 'a new frame' + (hostOf(fresh[0].getAttribute('src'), doc) ? ' from ' + hostOf(fresh[0].getAttribute('src'), doc) : '') : fresh.length + ' new frames');
    return out.join(' and ');
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

  // After the final button, what the store said:
  // - 'declined': the payment didn't go through — never pressed again;
  // - 'stop': anything about the payment, the card, your bank, a human check or being blocked — never pressed
  //   past (for you, with what it said);
  // - 'working': it's still at it ("Processing…", "Please wait") — waited for, never pressed again meanwhile;
  // - 'field': a box it says is wrong (not the card's) — filled in again, then pressed again (twice at most);
  // - 'busy': the store plainly struggling (high demand, try again, too many requests, a 503, something went
  //   wrong — or sold out just now: under a drop's load stock comes back) — pressed again, a little later each
  //   time, up to half an hour;
  // - 'other': anything else — not a reason to press again (for you, with what it said).
  var STOP_RE = /payment|card|bank|authenticat|verif|captcha|human|robot|blocked|denied|refused|not approved|fraud|security code|\bcvv\b|\bcvc\b|expir/i;
  var WORKING_RE = /processing|please wait|placing your order|submitting|one moment|hang tight|\bloading\b/i;
  var NOT_WORKING_RE = /problem|error|fail|unable|could ?n.?t|cannot|can.?t|sorry|wrong|invalid|declin|try again/i;
  // ("Processing your order — please do not refresh or try again": still at it, whatever else it says.)
  var DONT_PRESS_RE = /(do not|don.?t) (refresh|reload|press|click|close|go back|leave|submit|try again)/i;
  var FIELD_ERR_RE = /\brequired\b|\binvalid\b|\bincorrect\b|not (a )?valid|please (enter|select|choose|provide|fill|check|complete|tick|accept|agree)|must (be|accept|select|enter|agree|tick)|\bmissing\b|enter a valid|doesn.?t match|is too (short|long)|needs attention/i;
  var BUSY_RE = /high (demand|traffic|volume)|try again|too many requests|(service|temporarily) unavailable|\b50[234]\b|something went wrong|server (error|is busy|busy)|timed? ?out|\bbusy\b|overloaded|experiencing (issues|difficulties|delays|high)|unable to (complete|process) (your )?(request|order)|out of stock|sold out|no longer available|not enough stock|insufficient (stock|inventory|quantity)|\bunavailable\b/i;
  function errorKind(text) {
    var t = String(text || '');
    if (!t) return '';
    if (DECLINE_RE.test(t)) return 'declined';
    // ("Please wait while we process your payment" is it still at it; "a problem processing your payment" isn't.)
    if (WORKING_RE.test(t) && (DONT_PRESS_RE.test(t) || !NOT_WORKING_RE.test(t))) return 'working';
    if (STOP_RE.test(t)) return 'stop';
    if (FIELD_ERR_RE.test(t)) return 'field';
    if (BUSY_RE.test(t)) return 'busy';
    return 'other';
  }
  // How long before pressing again: as a person would (3 s, 5 s, 8 s… then every 20 s).
  var RETRY_WAITS = [3000, 5000, 8000, 10000, 15000, 15000, 20000];
  function retryWait(n) { return RETRY_WAITS[Math.min(Math.max(n, 0), RETRY_WAITS.length - 1)]; }
  // The longest an Auto-checkout run keeps at it on the checkout: the final button turning on, and pressing
  // it again while the store's struggling (a hot drop) — then it stops, nothing bought.
  var RETRY_MS = 30 * 60 * 1000;

  return { CONFIRM_RE: CONFIRM_RE, DECLINE_RE: DECLINE_RE, RETRY_MS: RETRY_MS, errorKind: errorKind, retryWait: retryWait, orderTotal: orderTotal, pageError: pageError, pageErrors: pageErrors, markErrors: markErrors, markAfter: markAfter, markPressed: markPressed, bankShown: bankShown, missingRequired: missingRequired, outcome: outcome, showing: showing, bankMessage: bankMessage, bankWords: saidIn, savedCardShown: savedCardShown, unavailable: unavailable, visible: visible };
})();
