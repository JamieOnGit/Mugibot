/* Mugibot — checkout autofill (runs in the page, and in card iframes). Fills
   empty fields from your delivery details/card, presses the store's
   "Continue to …" step buttons in order, picks home delivery and card
   payment, and STOPS at the final button ("Checkout securely", "Place
   order", "Pay now"…) — that one is never pressed.

   The store's flow (server/retailers/<store>.js → checkout) says which step,
   guest, choice and final buttons that store uses; the general rules below
   cover the rest. */

var MGBFill = (function () {
  'use strict';

  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var toArray = function (l) { return Array.prototype.slice.call(l); };
  var any = function (list, t) { return typeof MGBFlows !== 'undefined' && MGBFlows.any(list, t); };

  var AU_STATES = { NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland', WA: 'Western Australia', SA: 'South Australia', TAS: 'Tasmania', ACT: 'Australian Capital Territory', NT: 'Northern Territory' };
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  var AUTOCOMPLETE = {
    email: 'email', tel: 'phone', 'tel-national': 'phone', 'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName',
    'address-line1': 'address1', 'street-address': 'address1', 'address-line2': 'address2', 'address-level2': 'suburb', 'address-level1': 'state',
    'postal-code': 'postcode', country: 'country', 'country-name': 'country', 'cc-number': 'cardNumber', 'cc-name': 'cardName',
    'cc-exp': 'cardExpiry', 'cc-exp-month': 'cardExpMonth', 'cc-exp-year': 'cardExpYear', 'cc-csc': 'cardCvc',
  };
  // First match wins (same rules as TCGBot's checkout assist).
  var RULES = [
    ['addressLookup', /(start typing|search|find|look ?up|lookup|enter).{0,25}address|address.{0,15}(search|finder|lookup|look ?up|autocomplete|autofill)/],
    [null, /company|business|organi[sz]ation|\babn\b|gift|message|instruction|comment|\bnote|coupon|promo|voucher|discount|referral|username|date of birth|\bdob\b|birthday|po number|reference|password/],
    ['cardNumber', /card.?number|cardnumber|cc.?num|encryptedcardnumber|credit.?card.?(no|num)|\bpan\b|card no\b/],
    ['cardCvc', /\bcvv|\bcvc|\bcsc\b|security.?code|verification.?value|encryptedsecuritycode|card.?code|\bcvn\b/],
    ['cardExpMonth', /exp\w*.?month|cc.?month|expirymonth|encryptedexpirymonth|card.?month/],
    ['cardExpYear', /exp\w*.?year|cc.?year|expiryyear|encryptedexpiryyear|card.?year/],
    ['cardExpiry', /expir|exp.?date|mm\s*\/\s*yy|encryptedexpirydate|valid.?(thru|until)|\bexp\b/],
    ['cardName', /name.?on.?card|card.?holder|cardholder|holder.?name|cc.?name|card.?name|nameoncard/],
    ['email', /e-?mail/],
    ['phone', /phone|mobile|\btel\b|telephone|contact.?number/],
    ['firstName', /first.?name|given.?name|\bfname\b|firstname/],
    ['lastName', /last.?name|surname|family.?name|\blname\b|lastname/],
    ['address2', /address.?(line)?.?2|addr(ess)?2|apartment|\bunit\b|suite|\bapt\b|line ?2/],
    ['address1', /address.?(line)?.?1|addr(ess)?1|street|\baddress\b|line ?1/],
    ['suburb', /suburb|city|town|locality/],
    ['postcode', /post.?code|postal|\bzip\b/],
    ['country', /country/],
    ['state', /\bstate\b|province|region|territory/],
    ['fullName', /full.?name|\bname\b|recipient/],
  ];
  var CARD_KINDS = ['cardNumber', 'cardCvc', 'cardExpMonth', 'cardExpYear', 'cardExpiry', 'cardName'];
  // Why the card wasn't filled in (from the background worker).
  var CARD_ISSUE = {
    none: ' No card saved in Mugibot: type it in yourself, or save it in the extension (icon → Card settings) for next time.',
    passphrase: ' Your card was saved by an older version of Mugibot: open the extension (icon → Card settings) once to keep it ready, or type it in yourself.',
    unreadable: " Your saved card couldn't be read: save it again in the extension (icon → Card settings), or type it in yourself.",
  };

  // Buttons
  var FINAL_RE = /^(check ?out securely|place (my |your )?order( (and|&) pay| now)?|place your order|pay now|pay securely( now)?|complete (my |your )?(order|purchase|payment)|submit (my )?(order|payment)|confirm (and|&) pay|confirm (my )?(order|purchase|payment)|pay \$?\s?[\d,.]+( now)?|buy now( and pay)?|buy now and pay|complete checkout)$/;
  var STEP_RE = /^(continue to (details|delivery|shipping|payment|review|checkout)|continue|next|next step|proceed( to (delivery|shipping|payment|checkout))?|save (and|&) continue|use this address|deliver (here|to this address)|ship to this address|confirm (address|delivery|details)|review (my |your )?order)$/;
  var GUEST_RE = /^(continue as (a )?guest|guest checkout|check ?out as (a )?guest)$/;
  var MANUAL_RE = /enter (your |the |an )?address manually|enter (it )?manually|manual(ly)? (address|entry)|can.?t find (your |my )?address|add (an )?address manually|type (your )?address/;
  var EXCLUDE_RE = /paypal|afterpay|\bzip\b|klarna|humm|latitude|apple ?pay|google ?pay|shop ?pay|sign ?in|log ?in|register|create (an )?account|continue shopping|keep shopping|\bback\b|\bedit\b|\bchange\b|remove|delete|cancel|apply|gift ?card|voucher|promo|coupon|newsletter|subscribe|\+ ?add\b|click (&|and) collect|pick ?up/;

  // ------------------------------------------------------------------------
  function isVisible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }
  function inPanel(el) {
    return !!el.closest('#mugibot-qc, #mugibot-banner, #tcgcopbot-qc, #tcgcopbot-banner, #tcgbot-qc, #tcgbot-quick-checkout, #kmart-upc-quick-checkout, #tcgbot-banner');
  }
  function textOf(el) {
    return (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
  }
  function norm(t) {
    return String(t || '').toLowerCase().replace(/[›»→>←‹«]/g, ' ').replace(/[^a-z0-9$.,&/' +-]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** 'final' | 'step' | 'guest' | 'choose' | 'manual' | null. C = the store's checkout flow. */
  function classifyButton(label, C) {
    C = C || {};
    var t = norm(label);
    if (!t || t.length > 60) return null;
    if (MANUAL_RE.test(t) || any(C.manual, t)) return 'manual';
    if (FINAL_RE.test(t) || any(C.final, t) || any(C.final, label)) return 'final';
    if (any(C.choose, t)) return 'choose';
    if (EXCLUDE_RE.test(t)) return null;
    if (GUEST_RE.test(t) || any(C.guest, t)) return 'guest';
    if (STEP_RE.test(t) || any(C.steps, t)) return 'step';
    return null;
  }

  function labelText(el) {
    var parts = [];
    if (el.id) {
      try { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) parts.push(l.innerText); } catch (e) { /* ignore */ }
    }
    var wrap = el.closest('label');
    if (wrap) parts.push(wrap.innerText);
    var lb = el.getAttribute('aria-labelledby');
    if (lb) lb.split(/\s+/).forEach(function (id) { var x = document.getElementById(id); if (x) parts.push(x.innerText); });
    if (!parts.length && el.parentElement) {
      // Floating-label designs: the label is a sibling.
      var sib = el.parentElement.querySelector('label, legend, span');
      if (sib && sib !== el && (sib.innerText || '').length < 60) parts.push(sib.innerText);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function describe(el) {
    return [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'),
      el.getAttribute('data-fieldtype'), el.getAttribute('data-testid'), labelText(el)].filter(Boolean).join(' | ').toLowerCase().slice(0, 300);
  }

  /** What a field is for. C.fields: { 'css selector': 'kind' } from the store's flow wins. */
  function classifyField(el, C) {
    var type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (type === 'checkbox' || type === 'radio') return null;
    var overrides = C && C.fields;
    if (overrides) {
      for (var sel in overrides) {
        try { if (Object.prototype.hasOwnProperty.call(overrides, sel) && el.matches(sel)) return overrides[sel] || null; } catch (e) { /* bad selector */ }
      }
    }
    var desc = describe(el);
    var tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
    var last = tokens[tokens.length - 1];
    if (last && AUTOCOMPLETE[last]) {
      var k = AUTOCOMPLETE[last];
      return k === 'fullName' && /card|holder/.test(desc) ? 'cardName' : k;
    }
    if (type === 'email') return 'email';
    if (type === 'tel' && !/card|cvv|cvc|security/.test(desc)) return 'phone';
    for (var i = 0; i < RULES.length; i++) if (RULES[i][1].test(desc)) return RULES[i][0];
    return null;
  }

  /** What we can type, from your delivery details and your saved card. */
  function fieldValues(profile, card) {
    profile = profile || {};
    var v = {
      email: profile.email || '', phone: profile.phone || '', firstName: profile.firstName || '', lastName: profile.lastName || '',
      fullName: [profile.firstName, profile.lastName].filter(Boolean).join(' '), address1: profile.address1 || '', address2: profile.address2 || '',
      suburb: profile.suburb || '', state: profile.state || '', postcode: profile.postcode || '', country: 'Australia',
    };
    if (card) {
      v.cardNumber = card.number;
      v.cardName = card.name;
      v.cardExpMonth = card.expMonth;
      v.cardExpYear = card.expYear;
      v.cardExpiry = card.expMonth + '/' + String(card.expYear).slice(-2);
      v.cardCvc = card.cvc || '';
    }
    return v;
  }

  function setNative(el, value) {
    var proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    // Like typing (payment widgets such as Adyen's read inputType/data).
    var ev;
    try { ev = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }); } catch (e) { ev = new Event('input', { bubbles: true }); }
    el.dispatchEvent(ev);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** One key at a time: keydown, keypress, beforeinput, the character, input, keyup. */
  function typeKeys(el, value) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    String(value).split('').forEach(function (ch) {
      var kc = ch === '/' ? 191 : ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
      var code = /\d/.test(ch) ? 'Digit' + ch : ch === '/' ? 'Slash' : ch === ' ' ? 'Space' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : '';
      var key = { key: ch, code: code, keyCode: kc, which: kc, charCode: ch.charCodeAt(0), bubbles: true, cancelable: true };
      if (el.dispatchEvent(new KeyboardEvent('keydown', key)) && el.dispatchEvent(new KeyboardEvent('keypress', key))
        && el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true }))) {
        setter.call(el, el.value + ch);
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
      }
      el.dispatchEvent(new KeyboardEvent('keyup', key));
    });
  }

  /**
   * Type into a field like a person would (so formatters, frameworks and payment
   * widgets notice). Returns how it went in: 'typed' (the browser's own typing),
   * 'keys' (key by key), 'set', or 'rejected' (the field wouldn't keep it).
   */
  function typeInto(el, value, kind) {
    var digits = function (s) { return String(s || '').replace(/\D/g, ''); };
    var took = function () { return /^card(Number|Cvc|Expiry|ExpMonth|ExpYear)$/.test(kind) ? digits(el.value) === digits(value) : el.value === value; };
    el.focus();
    var how = 'typed';
    var ok = false;
    try { if (el.select) el.select(); ok = document.execCommand('insertText', false, value); } catch (e) { ok = false; }
    if (!ok || !took()) {
      how = 'keys';
      if (el.value) setNative(el, '');
      if (el.tagName === 'INPUT') typeKeys(el, value);
    }
    if (!took()) { how = 'set'; setNative(el, value); }
    if (!took()) how = 'rejected';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    return how;
  }

  // --- focus for payment frames ---------------------------------------------
  // Card boxes in a payment provider's frame (Kmart's, for one) only keep what's
  // typed into a focused box. A frame can't always focus itself, so it asks the
  // page above to focus it (which asks its own parent first, if it's a frame too),
  // one box at a time. Messages carry no card details.
  var FOCUS = 'mugibot-focus:';

  /** On a store page or a frame that holds other frames: focus a child frame when it asks. */
  function startFocusBroker() {
    if (window.__mugibotFocusBroker) return;
    window.__mugibotFocusBroker = true;
    var queue = [];
    var current = null;
    function frameOf(win) {
      return toArray(document.querySelectorAll('iframe, frame')).find(function (f) { return f.contentWindow === win; });
    }
    function finish(job) {
      if (current !== job) return;
      clearTimeout(job.timer);
      current = null;
      if (job.release) job.release();
      next();
    }
    function next() {
      if (current || !queue.length) return;
      var job = current = queue.shift();
      job.timer = setTimeout(function () { finish(job); }, 6000); // a frame that never says it's done
      requestFocus().then(function (release) { // our own frame first, if we're one
        job.release = release;
        try { job.frame.focus(); } catch (e) { /* ignore */ }
        job.source.postMessage(FOCUS + 'go:' + job.id, '*');
      });
    }
    window.addEventListener('message', function (e) {
      if (typeof e.data !== 'string' || e.data.indexOf(FOCUS) !== 0 || !e.source) return;
      var parts = e.data.slice(FOCUS.length).split(':');
      if (parts[0] === 'ask') {
        var frame = frameOf(e.source);
        if (frame) { queue.push({ id: parts[1], source: e.source, frame: frame }); next(); }
      } else if (parts[0] === 'done' && current && current.id === parts[1] && current.source === e.source) {
        finish(current);
      }
    });
  }

  /** In a frame: have the page above focus this frame. Resolves to release(), to call when done typing. */
  function requestFocus() {
    if (window.top === window.self) return Promise.resolve(function () {});
    return new Promise(function (resolve) {
      var id = Math.random().toString(36).slice(2);
      var settled = false;
      var release = function () { try { window.parent.postMessage(FOCUS + 'done:' + id, '*'); } catch (e) { /* ignore */ } };
      var settle = function () {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        resolve(release);
      };
      var onMessage = function (e) { if (e.source === window.parent && e.data === FOCUS + 'go:' + id) settle(); };
      window.addEventListener('message', onMessage);
      try { window.parent.postMessage(FOCUS + 'ask:' + id, '*'); } catch (e) { /* ignore */ }
      setTimeout(settle, 2000); // nobody above to help: type anyway
    });
  }

  function chooseOption(kind, select, values) {
    var n = function (s) { return String(s == null ? '' : s).trim().toLowerCase(); };
    var opts = toArray(select.options).filter(function (o) { return o.value !== '' || o.textContent.trim(); });
    var exact = function (cands) {
      for (var i = 0; i < cands.length; i++) {
        if (!cands[i]) continue;
        var c = n(cands[i]);
        var o = opts.find(function (x) { return n(x.value) === c || n(x.textContent) === c; });
        if (o) return o.value;
      }
      return null;
    };
    if (kind === 'state') {
      var abbr = String(values.state || '').toUpperCase();
      var full = AU_STATES[abbr];
      if (!abbr) return null;
      var hit = exact([abbr, full]);
      if (hit !== null) return hit;
      var o = opts.find(function (x) { return full && n(x.textContent).indexOf(n(full)) !== -1; });
      return o ? o.value : null;
    }
    if (kind === 'country') {
      var c = exact(['AU', 'AUS', 'Australia']);
      if (c !== null) return c;
      var oc = opts.find(function (x) { return /australia/i.test(x.textContent); });
      return oc ? oc.value : null;
    }
    if (kind === 'cardExpMonth') {
      var m = parseInt(values.cardExpMonth, 10);
      var om = opts.find(function (x) { return parseInt(x.value, 10) === m || parseInt(x.textContent, 10) === m || n(x.textContent).indexOf(MONTHS[m - 1]) === 0; });
      return om ? om.value : null;
    }
    if (kind === 'cardExpYear') {
      var y = parseInt(values.cardExpYear, 10);
      var oy = opts.find(function (x) { return [x.value, x.textContent].some(function (s) { var k = parseInt(s, 10); return k === y || k === y % 100; }); });
      return oy ? oy.value : null;
    }
    return values[kind] ? exact([values[kind]]) : null;
  }

  function placeholderSelected(select) {
    if (!select.value) return true;
    var t = select.selectedIndex >= 0 ? select.options[select.selectedIndex].textContent : '';
    return /^(-+|select|choose|please|pick|state|country|month|year|mm|yy|yyyy)\b/i.test(t.trim());
  }

  function radioLabel(el) {
    return (labelText(el) || (el.parentElement ? el.parentElement.innerText : '') || el.value || '').toLowerCase();
  }

  /**
   * Fill empty, visible fields in `root`. opts.onlyCard: card fields only. opts.selectsOnly: drop-downs only.
   * opts.flow: the store's checkout flow.
   * Returns { filled: [...kinds], kinds: {kind: true}, cardFieldsSeen, missingCard }.
   */
  function fillFields(root, values, opts) {
    opts = opts || {};
    var C = opts.flow || {};
    var out = { filled: [], kinds: {}, cardFieldsSeen: 0, missingCard: false };
    var fields = toArray(root.querySelectorAll('input, select, textarea')).filter(function (el) {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file', 'password', 'search'].indexOf(type) !== -1) return false;
      if (el.disabled || el.readOnly || inPanel(el)) return false;
      if (type === 'checkbox' || type === 'radio') {
        var l = el.closest('label') || el.parentElement;
        return isVisible(el) || (l && isVisible(l));
      }
      return isVisible(el);
    });

    fields.forEach(function (el) {
      var kind = classifyField(el, C);
      if (!kind) return;
      out.kinds[kind] = true;
      var isCard = CARD_KINDS.indexOf(kind) !== -1;
      if (isCard) out.cardFieldsSeen += 1;
      if (opts.onlyCard && !isCard) return;
      if (kind === 'addressLookup') return;
      if (opts.selectsOnly && el.tagName !== 'SELECT') return;
      if (el.tagName === 'SELECT') {
        if (!placeholderSelected(el)) return;
        var v = chooseOption(kind, el, values);
        if (v !== null && v !== undefined) { setNative(el, v); out.filled.push(kind); }
        return;
      }
      if (el.value) return; // never overwrite what's there (e.g. details from your store account)
      var val = values[kind];
      if (isCard && !val) { out.missingCard = true; return; }
      if (!val) return;
      typeInto(el, val, kind);
      out.filled.push(kind);
    });

    if (!opts.onlyCard) {
      // Radio groups: home delivery (or what the flow says); card payment.
      var wantCollect = C.delivery === 'collect';
      var groups = {};
      fields.forEach(function (el) {
        if ((el.getAttribute('type') || '').toLowerCase() !== 'radio') return;
        var g = el.name || el.id;
        (groups[g] = groups[g] || []).push(el);
      });
      Object.keys(groups).forEach(function (g) {
        var list = groups[g];
        if (list.some(function (r) { return r.checked; })) return;
        var labels = list.map(radioLabel);
        var isPayment = labels.some(function (l) { return /paypal|afterpay|zip|klarna|apple pay|google pay|credit|debit/.test(l); });
        var isDelivery = labels.some(function (l) { return /deliver|shipping|post|courier|express|standard|collect|pick ?up/.test(l); });
        var pick = null;
        if (isPayment) pick = list.find(function (r) { return /credit|debit|card/.test(radioLabel(r)); });
        else if (isDelivery && wantCollect) pick = list.find(function (r) { return /collect|pick ?up/.test(radioLabel(r)); });
        else if (isDelivery) pick = list.find(function (r) { var l = radioLabel(r); return /home delivery|standard|deliver|shipping|post/.test(l) && !/collect|pick ?up|in-?store|click/.test(l); });
        if (pick) { pick.click(); out.filled.push(isPayment ? 'payment method' : 'delivery method'); }
      });
      // "I agree to the terms" only — never marketing.
      fields.forEach(function (el) {
        if ((el.getAttribute('type') || '').toLowerCase() !== 'checkbox' || el.checked) return;
        var l = (labelText(el) + ' ' + describe(el)).toLowerCase();
        if (/agree|terms|conditions|t\s?&\s?c/.test(l) && !/newsletter|marketing|subscribe|offers|promotion|news\b|sms|email me|updates|kmail/.test(l)) {
          el.click();
          out.filled.push('terms');
        }
      });
    }
    return out;
  }

  function isSelected(el) {
    return el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true'
      || /(^|\s)(is-)?(selected|active|checked)(\s|$)/i.test(el.className || '');
  }

  function buttons(C) {
    return toArray(document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"], [role="tab"], [role="radio"]')).filter(function (el) {
      return !inPanel(el) && isVisible(el) && textOf(el) && textOf(el).length <= 80;
    }).map(function (el) {
      return { el: el, text: textOf(el), kind: classifyButton(textOf(el), C), disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' };
    });
  }

  function signature() {
    var t = document.body ? document.body.innerText.length : 0;
    return location.pathname + '|' + document.querySelectorAll('input,select,button').length + '|' + t;
  }

  async function waitForChange(before, ms) {
    var end = Date.now() + ms;
    while (Date.now() < end) {
      await wait(200);
      if (signature() !== before) { await wait(300); return true; }
    }
    return false;
  }

  function highlight(el, message) {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    el.style.setProperty('outline', '4px solid #22c55e', 'important');
    el.style.setProperty('outline-offset', '3px', 'important');
    var b = document.getElementById('mugibot-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'mugibot-banner';
      b.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483646;background:#16a34a;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:6px 14px;border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none;max-width:90vw';
      document.documentElement.appendChild(b);
    }
    b.textContent = message;
  }

  /** Try a suggestion list after typing into an address-lookup box. */
  async function useAddressLookup(values, C) {
    var box = toArray(document.querySelectorAll('input')).find(function (el) { return isVisible(el) && !el.value && classifyField(el, C) === 'addressLookup'; });
    if (!box || !values.address1) return false;
    typeInto(box, values.address1 + ', ' + values.suburb + ' ' + values.state + ' ' + values.postcode, 'addressLookup');
    await wait(1500);
    var options = toArray(document.querySelectorAll('[role="option"], [role="listbox"] li, .pac-item, [class*="suggestion" i] li, [class*="suggestion" i] [class*="item" i]')).filter(isVisible);
    var want = String(values.postcode || '');
    var pick = options.find(function (o) { return want && o.innerText.indexOf(want) !== -1; }) || options[0];
    if (!pick) return false;
    pick.click();
    await wait(800);
    return true;
  }

  /**
   * Walk through the checkout. opts: { values, flow (the store's checkout flow), storeName, setStatus, report, isActive(), hasCard, cardIssue }
   * Resolves to 'ready' | 'needs_you' | 'stopped' | 'timeout' | 'done'.
   */
  async function assist(opts) {
    var C = opts.flow || {};
    var setStatus = opts.setStatus || function () {};
    var report = opts.report || function () {};
    var done = C.done || /confirmation|thank-?you|order-?(complete|received|success)/i;
    var clicked = {};
    var chosen = {};
    var lookupTried = false;
    var manualTried = false;
    var idle = 0;
    var deadline = Date.now() + 4 * 60 * 1000;
    setStatus('Filling in checkout…');
    while (Date.now() < deadline) {
      if (opts.isActive && !opts.isActive()) { setStatus('Stopped.'); return 'stopped'; }
      if (done.test(location.pathname)) { setStatus('Order placed.'); return 'done'; }

      var fill = fillFields(document, opts.values, { flow: C });
      if (fill.filled.length) setStatus('Filled: ' + fill.filled.join(', '));
      var list = buttons(C);
      var finals = list.filter(function (b) { return b.kind === 'final'; });
      var manual = list.find(function (b) { return b.kind === 'manual'; });
      var choice = list.find(function (b) { return b.kind === 'choose' && !b.disabled && !chosen[norm(b.text)] && !isSelected(b.el); });
      var steps = list.filter(function (b) { return (b.kind === 'step' || b.kind === 'guest') && !b.disabled; });
      var fresh = steps.filter(function (b) { return !clicked[norm(b.text)]; });

      if (!fill.kinds.address1 && fill.kinds.addressLookup) {
        if (manual && !manualTried) { manualTried = true; manual.el.click(); await wait(500); continue; }
        if (!manual && !lookupTried) { lookupTried = true; setStatus('Looking up your address…'); await useAddressLookup(opts.values, C); continue; }
      }

      // The store's own choices first (e.g. "Home delivery"), each once.
      if (choice) {
        chosen[norm(choice.text)] = 1;
        var beforeChoice = signature();
        setStatus('Choosing "' + choice.text + '"…');
        report('step', 'Chose "' + choice.text + '"');
        choice.el.click();
        await waitForChange(beforeChoice, 4000);
        idle = 0;
        continue;
      }

      var step = fresh.find(function (b) { return b.kind === 'guest'; }) || fresh[0];
      if (step) {
        clicked[norm(step.text)] = 1;
        var before = signature();
        setStatus('Clicking "' + step.text + '"…');
        report('step', 'Clicked "' + step.text + '"');
        step.el.click();
        await waitForChange(before, 10000);
        idle = 0;
        continue;
      }

      if (finals.length) {
        await wait(400); // let the last fields settle
        fillFields(document, opts.values, { flow: C });
        var fin = finals.find(function (b) { return !b.disabled; }) || finals[0];
        var card = opts.hasCard ? (fill.missingCard ? ' Type in anything still empty on the card (like the CVV).' : '') : (CARD_ISSUE[opts.cardIssue] || '');
        var msg = 'Ready — review everything and press "' + fin.text + '" yourself.' + card;
        highlight(fin.el, 'Mugibot: ' + msg);
        setStatus(msg);
        report('ready', 'Checkout filled in' + (opts.storeName ? ' at ' + opts.storeName : '') + ' — waiting for you to press "' + fin.text + '"');
        return 'ready';
      }

      // A step button we already pressed is still there: maybe a field needs attention.
      var again = steps.find(function (b) { return clicked[norm(b.text)] && clicked[norm(b.text)] < 3; });
      if (again && idle > 3) {
        clicked[norm(again.text)] += 1;
        again.el.click();
        await wait(1500);
        idle = 0;
        continue;
      }
      idle += 1;
      if (idle > 40) {
        var stuck = steps[0] ? 'Stuck at "' + steps[0].text + '" — something on the page needs your input.' : "Couldn't find the next step — please continue yourself.";
        setStatus(stuck);
        report('error', stuck);
        return 'needs_you';
      }
      await wait(400);
    }
    setStatus('Took too long — please continue yourself.');
    return 'timeout';
  }

  return {
    isVisible: isVisible,
    typeInto: typeInto,
    startFocusBroker: startFocusBroker,
    requestFocus: requestFocus,
    classifyButton: classifyButton,
    classifyField: classifyField,
    fieldValues: fieldValues,
    fillFields: fillFields,
    assist: assist,
    CARD_KINDS: CARD_KINDS,
  };
})();
