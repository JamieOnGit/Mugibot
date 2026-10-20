/* Mugibot — checkout autofill (runs in the page, and in card iframes). Fills
   empty fields from your delivery details/card, presses the store's
   "Continue to …" step buttons in order, picks home delivery and card
   payment, and STOPS at the final button ("Checkout securely", "Place
   order", "Pay now"…) — that one is never pressed here. (An armed
   Auto-checkout run hands it to content.js, which checks the order against
   your limits before pressing it.)

   The store's flow (server/retailers/<store>.js → checkout) says which step,
   guest, choice and final buttons that store uses; the general rules below
   cover the rest. */

var MGBFill = (function () {
  'use strict';

  // (At full speed in a tab in the background too: MGBFlows.wait.)
  var wait = function (ms) { return typeof MGBFlows !== 'undefined' && MGBFlows.wait ? MGBFlows.wait(ms) : new Promise(function (r) { setTimeout(r, ms); }); };
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
    // ("Area": Premium Bandai's Global-e checkout calls the country that.)
    ['country', /country|\barea\b(?!\s*code)/],
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
  var FINAL_RE = /^(check ?out securely|place (my |your )?order( (and|&) pay| now)?|place your order|pay (and|&) place (my |your )?order|pay now|pay securely( now)?|complete (my |your )?(order|purchase|payment)|submit (my )?(order|payment)|confirm (and|&) pay|confirm (my )?(order|purchase|payment)|pay \$?\s?[\d,.]+( now)?|buy now( and pay)?|buy now and pay|complete checkout)$/;
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
    return (el.innerText || el.value || el.getAttribute('aria-label') || labelledBy(el) || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
  }
  /** What a bare button is labelled by (Amazon's "Place your order": its words in a separate span). */
  function labelledBy(el) {
    var ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return ids.map(function (id) { var x = document.getElementById(id); return x ? x.textContent : ''; }).join(' ').trim();
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
    // (Words that aren't the final button at this store: EB Games' "Pay Now" is a kind of payment.)
    if (any(C.notFinal, t)) return any(C.choose, t) ? 'choose' : null;
    // (The final button with the order's total in it — Shop's "Pay now $47.99": its words without the amount.)
    var bare = t.replace(/\s*(?:(?:a|au|us)?\$\s?[\d,]+(?:\.\d{1,2})?|[\d,]+\.\d{2})(?:\s?(?:aud|usd))?$/, '').trim();
    if (FINAL_RE.test(t) || (bare && bare !== t && FINAL_RE.test(bare)) || any(C.final, t) || any(C.final, label)) return 'final';
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
      // Floating-label designs: the label is a sibling — never another box's label (one holding its own
      // field, or one "for" another field).
      var sib = toArray(el.parentElement.querySelectorAll('label, legend, span')).find(function (x) {
        return x !== el && !x.contains(el) && !x.querySelector('input, select, textarea') && !(x.htmlFor && x.htmlFor !== el.id) && (x.innerText || '').length < 60;
      });
      if (sib) parts.push(sib.innerText);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function describe(el) {
    // ("address[state]", "customer[email]": the part in brackets says what it is — not the "address" before it.)
    var name = el.getAttribute('name') || '';
    var inner = name.match(/\[([^\]]+)\]$/);
    return [el.getAttribute('autocomplete'), inner ? inner[1] : name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'),
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

  /** A box that suggests addresses as you type (a combobox), rather than a plain street box. */
  function isSuggestBox(el) {
    var ac = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
    return el.getAttribute('role') === 'combobox' || ac === 'list' || ac === 'both' || el.getAttribute('aria-haspopup') === 'listbox';
  }

  /**
   * What a field is for, on this page: like classifyField, plus two things it can only tell from
   * the rest of the form. A one-line address box (no suburb or postcode boxes to go with it, and it
   * suggests addresses — or the flow says the address is one line: C.addressLookup) is an address
   * lookup. A drop-down for "expiry" is the month or the year, by what it lists.
   */
  function fieldKind(el, C, ctx) {
    var kind = classifyField(el, C);
    if (kind === 'address1' && el.tagName === 'INPUT' && ctx && !ctx.hasParts && (isSuggestBox(el) || (C && C.addressLookup))) return 'addressLookup';
    if (kind === 'cardExpiry' && el.tagName === 'SELECT') {
      var nums = toArray(el.options).map(function (o) { return parseInt(o.value || o.textContent, 10); }).filter(function (n) { return !isNaN(n); });
      if (nums.some(function (n) { return n >= 2000 || (n > 12 && n < 100); })) return 'cardExpYear';
      if (nums.length && nums.every(function (n) { return n >= 1 && n <= 12; })) return 'cardExpMonth';
    }
    return kind;
  }

  /** Does the form have separate suburb / postcode boxes (so a street box is just the street)? */
  function addressParts(fields, C) {
    return fields.some(function (el) { var k = classifyField(el, C); return k === 'suburb' || k === 'postcode'; });
  }

  /**
   * The phone number for a box that already shows the country's code next to it (a "+61" drop-down,
   * like Premium Bandai's): the number without its leading 0. Otherwise as saved.
   */
  function phoneFor(el, values, C) {
    var phone = String(values.phone || '');
    var local = phone.replace(/^\+?61\s*/, '0').replace(/\s+/g, '');
    var box = el.parentElement;
    var shown = !!(C && C.phoneLocal);
    for (var i = 0; !shown && box && i < 3; i++, box = box.parentElement) {
      var sel = box.querySelector('select');
      var t = sel && sel !== el && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent : '';
      if (/\+\s?61\b/.test(t) || (/\+\s?61\b/.test(box.innerText || '') && (box.innerText || '').length < 200)) shown = true;
    }
    return shown ? local.replace(/^0/, '') : phone;
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
  function typeInto(el, value, kind, keepFocus) {
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
    // (keepFocus: an address finder, whose suggestions close when it loses the focus.)
    if (keepFocus) return how;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    return how;
  }

  // --- focus for payment frames ---------------------------------------------
  // Card boxes in a payment provider's frame (Kmart's, for one) only keep what's
  // typed into a focused box. A frame can't always focus itself, so it asks the
  // page above to focus it (which asks its own parent first, if it's a frame too),
  // one box at a time. Messages carry no card details. A frame's script can start
  // before the page above is listening, so it asks again every 100 ms until it's
  // answered (the page above takes each ask once).
  var FOCUS = 'mugibot-focus:';

  /** On a store page or a frame that holds other frames: focus a child frame when it asks. */
  function startFocusBroker() {
    if (window.__mugibotFocusBroker) return;
    window.__mugibotFocusBroker = true;
    var queue = [];
    var current = null;
    var known = function (id) { return (current && current.id === id) || queue.some(function (j) { return j.id === id; }); };
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
        if (frame) {
          // "You're in the queue": the frame waits its turn instead of typing without the focus.
          try { e.source.postMessage(FOCUS + 'queued:' + parts[1], '*'); } catch (x) { /* ignore */ }
          // (An ask repeated before our answer reached it: already queued, or being focused now.)
          if (known(parts[1])) return;
          queue.push({ id: parts[1], source: e.source, frame: frame });
          next();
        }
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
      var ask = function () { try { window.parent.postMessage(FOCUS + 'ask:' + id, '*'); } catch (e) { /* ignore */ } };
      var asking = null;
      var settle = function () {
        if (settled) return;
        settled = true;
        clearInterval(asking);
        window.removeEventListener('message', onMessage);
        resolve(release);
      };
      var fallback = null;
      var onMessage = function (e) {
        if (e.source !== window.parent) return;
        if (e.data === FOCUS + 'go:' + id) { clearTimeout(fallback); settle(); }
        // Queued behind other boxes: wait for our turn (each box takes at most a few seconds).
        else if (e.data === FOCUS + 'queued:' + id) { clearInterval(asking); clearTimeout(fallback); fallback = setTimeout(settle, 20000); }
      };
      window.addEventListener('message', onMessage);
      ask();
      // (The page above may not be listening yet — its script starts when it's ready: asked again until it answers.)
      asking = setInterval(ask, 100);
      fallback = setTimeout(settle, 1500); // nobody above to help: type anyway
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
    // (A radio alone in its cell, its words in the row's other cells — Magento's shipping methods table.)
    var row = el.closest('tr, li');
    return (labelText(el) || (el.parentElement ? el.parentElement.innerText : '') || (row ? row.innerText : '') || el.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** The heading a radio sits under ("Parcel Post", "Shipping method"), if any. */
  function headingBefore(el) {
    var row = el.closest('label, li, tr') || el.parentElement;
    for (var up = 0; row && up < 3; up++, row = row.parentElement) {
      for (var s = row.previousElementSibling, n = 0; s && n < 8; s = s.previousElementSibling, n++) {
        if (s.matches('h1, h2, h3, h4, h5, h6, legend, dt, strong, b, [class*="heading" i], [class*="title" i]')) return (s.innerText || '').trim();
        if (s.querySelector && s.querySelector('input[type="radio"]')) continue; // another option of the same group
      }
    }
    var fs = el.closest('fieldset');
    var lg = fs && fs.querySelector('legend');
    return lg ? (lg.innerText || '').trim() : '';
  }

  /** A radio's label with the heading it sits under: what a flow's shipping choice is matched against. */
  function radioContext(el) {
    return (radioLabel(el) + ' ' + headingBefore(el)).replace(/\s+/g, ' ').trim();
  }

  var COLLECT_RE = /collect|pick ?up|in-?store|click (&|and) collect/;
  // Payments that aren't the card (a store's default can be one): switched to the card when the flow pays by card.
  var NOT_CARD_RE = /paypal|afterpay|\bzip\b|zip ?pay|klarna|humm|latitude|apple ?pay|google ?pay|pay (in|later)|\bpay later\b|gift ?card|flypay/;
  // Radio groups switched away from the store's default, per page: never more than twice (a page that switches back).
  var SWITCHED = {};

  /**
   * A drop-down drawn over by a nicer one (WooCommerce's selectWoo, select2, Choices, Tom Select): the
   * real one is hidden, its stand-in shown — it's the real one that's chosen in (the stand-in follows it).
   */
  function enhancedSelect(el) {
    if (el.tagName !== 'SELECT' || !/select2-hidden-accessible|choices__input|tomselected|ts-hidden-accessible/.test(String(el.className || ''))) return false;
    var next = el.nextElementSibling;
    var wrap = el.closest('.choices, .ts-wrapper');
    return !!((next && /select2|ts-wrapper/.test(String(next.className || '')) && isVisible(next)) || (wrap && isVisible(wrap)));
  }

  // Boxes never ticked for you, whatever the flow says: newsletters, offers, marketing texts.
  var MARKETING_RE = /newsletter|marketing|subscribe|offers|promotion|news\b|sms|text me|email me|updates|kmail/i;
  // At every store: a box saying you accept its terms or agreement ("By selecting, you indicate your
  // acceptance of the Membership Agreement", "I have read and agree to the terms and conditions") — the
  // checkout won't go without it. (Never one to save your details, or a marketing one.)
  var CONSENT_RE = /\b(accept(ance)?|agree(ment)?|i have read|acknowledge|consent)\b[\s\S]{0,80}\b(terms|conditions|agreement|policy|policies|rules)\b|\bmembership agreement\b|\b(terms|conditions)\b[\s\S]{0,40}\b(accept|agree)/i;
  var NOT_CONSENT_RE = /save (my|this|your)|remember me|keep me signed|create an account|use (this|my) (address|card) for/i;
  // (Nor one that adds something you pay for — a protection plan, a warranty, a subscription, a price in its words —
  //  however it says "I agree": "Add 2-year Protection Plan ($29) — I accept the plan terms".)
  // (Words of what's being sold, not a store's name: "Premium Bandai's policy", "data protection" are fine.)
  var PAID_RE = /\$\s?\d|\d\s?(aud|usd)\b|\bplan\b|protection plan|(device|product|purchase|package|parcel|shipping|order) protection|warranty|insurance|\bcover(age)? for\b|subscri|premium (plan|membership|subscription)|\bjoin\b|per (month|year|week)|\/\s?(mo|month|yr|year)\b|donat|\btip\b|gift wrap|add-?on|upgrade|\btrial\b/i;

  /**
   * The flow's boxes to have ticked (C.tick: Shopify's "Use shipping address as billing address", Shop
   * checkout links' membership agreement) or not (C.untick: WooCommerce's "Deliver to a different
   * address?", which can come ticked) — and, with C.tickRequired, any box the checkout marks as required
   * (never marketing). Real tick boxes, and ones drawn as role="checkbox". Each at most twice per page
   * (a store that ticks it back: left as it says).
   */
  /**
   * The words beside a tick box that its label leaves out — Mattel's real checkout labels its box only "By
   * selecting, you indicate your acceptance of the", its "Membership Agreement ↗" link outside the label: the
   * biggest block around the box (up to 5 levels up) that holds no other box or field, in 250 letters or fewer.
   */
  function rowText(el) {
    var best = '';
    var p = el.parentElement;
    for (var i = 0; p && i < 5 && p !== document.body; i++, p = p.parentElement) {
      var others = toArray(p.querySelectorAll('input, select, textarea, [role="checkbox"], [role="switch"]')).filter(function (x) { return x !== el && !el.contains(x) && !x.contains(el) && (x.getAttribute('type') || '').toLowerCase() !== 'hidden'; });
      if (others.length) break;
      var t = (p.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length > 250) break;
      best = t;
    }
    return best;
  }

  function setTicks(root, C, out) {
    toArray(root.querySelectorAll('input[type="checkbox"], [role="checkbox"], [role="switch"]')).forEach(function (el) {
      var real = el.matches('input');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' || inPanel(el)) return;
      // (A real box inside a drawn one is that box: the real one's ticked.)
      if (!real && el.querySelector('input[type="checkbox"]')) return;
      var l = el.closest('label') || el.parentElement;
      if (!isVisible(el) && !(l && isVisible(l))) return;
      var words = (labelText(el) + ' ' + describe(el) + (real ? '' : ' ' + textOf(el)) + ' ' + rowText(el)).replace(/\s+/g, ' ');
      var required = real ? el.required || el.getAttribute('aria-required') === 'true' : el.getAttribute('aria-required') === 'true';
      var want = any(C.tick, words) ? true : any(C.untick, words) ? false : C.tickRequired && required ? true
        : CONSENT_RE.test(words) && !NOT_CONSENT_RE.test(words) && !PAID_RE.test(words) ? true : null;
      if (want && MARKETING_RE.test(words)) want = null;
      var checked = real ? el.checked : el.getAttribute('aria-checked') === 'true';
      if (want === null || checked === want) return;
      var key = 'tick|' + (el.name || el.id || words.slice(0, 40));
      if ((SWITCHED[key] || 0) >= 3) return;
      SWITCHED[key] = (SWITCHED[key] || 0) + 1;
      el.click();
      // (A box the page draws over a hidden one, and only answers clicks on its label: the label.)
      var now = real ? el.checked : el.getAttribute('aria-checked') === 'true';
      if (now !== want) {
        var lab = (real && el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest('label');
        if (lab) lab.click();
      }
      out.filled.push((want ? 'ticked "' : 'unticked "') + (labelText(el) || (real ? '' : textOf(el)) || el.name || 'box').replace(/\s+/g, ' ').trim().slice(0, 50) + '"');
    });
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
    if (!opts.onlyCard) setTicks(root, C, out);
    var fields = toArray(root.querySelectorAll('input, select, textarea')).filter(function (el) {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file', 'password', 'search'].indexOf(type) !== -1) return false;
      if (el.disabled || el.readOnly || inPanel(el)) return false;
      if (type === 'checkbox' || type === 'radio') {
        var l = el.closest('label') || el.parentElement;
        return isVisible(el) || (l && isVisible(l));
      }
      return isVisible(el) || enhancedSelect(el);
    });

    var ctx = { hasParts: addressParts(fields, C) };
    fields.forEach(function (el) {
      var kind = fieldKind(el, C, ctx);
      if (!kind) return;
      out.kinds[kind] = true;
      var isCard = CARD_KINDS.indexOf(kind) !== -1;
      if (isCard) out.cardFieldsSeen += 1;
      // (A checkout with your details and card in already — Shop's: nothing of yours is typed in.)
      if (C.ownDetails) return;
      if (opts.onlyCard && !isCard) return;
      if (kind === 'addressLookup') return;
      if (opts.selectsOnly && el.tagName !== 'SELECT') return;
      if (el.tagName === 'SELECT') {
        // (Your details are Australian: a country box the store set to somewhere else is changed too.)
        var otherCountry = kind === 'country' && !/australia|^au$|^aus$/i.test(el.selectedIndex >= 0 ? (el.options[el.selectedIndex].textContent + ' ' + el.value).trim() : '');
        if (!placeholderSelected(el) && !otherCountry) return;
        var v = chooseOption(kind, el, values);
        if (v !== null && v !== undefined) { setNative(el, v); out.filled.push(kind); }
        return;
      }
      if (el.value) return; // never overwrite what's there (e.g. details from your store account)
      var val = kind === 'phone' ? phoneFor(el, values, C) : values[kind];
      if (isCard && !val) { out.missingCard = true; return; }
      if (!val) return;
      typeInto(el, val, kind);
      out.filled.push(kind);
    });

    if (!opts.onlyCard && !C.ownDetails) {
      // Radio groups: home delivery (or what the flow says) and the flow's shipping choice; card payment.
      // A group nobody has chosen in yet gets one; a store's own default is changed only when it's
      // click & collect (for home delivery), a payment that isn't the card, or not the flow's shipping.
      var wantCollect = C.delivery === 'collect';
      var wantShip = C.shipping && C.shipping.length ? C.shipping : null;
      var groups = {};
      fields.forEach(function (el) {
        if ((el.getAttribute('type') || '').toLowerCase() !== 'radio') return;
        var g = el.name || el.id;
        (groups[g] = groups[g] || []).push(el);
      });
      Object.keys(groups).forEach(function (g) {
        var list = groups[g];
        var labels = list.map(radioLabel);
        var isPayment = labels.some(function (l) { return /paypal|afterpay|zip|klarna|apple pay|google pay|credit|debit/.test(l); });
        var isDelivery = !isPayment && labels.some(function (l) { return /deliver|shipping|post|courier|express|standard|collect|pick ?up/.test(l); });
        var home = function (r) { var l = radioLabel(r); return /home delivery|standard|deliver|shipping|post/.test(l) && !COLLECT_RE.test(l); };
        var card = function (r) { return /credit|debit|card/.test(radioLabel(r)) && !NOT_CARD_RE.test(radioLabel(r)); };
        var ship = function (r) { return wantShip && !COLLECT_RE.test(radioLabel(r)) && any(wantShip, radioContext(r)); };
        var checked = list.find(function (r) { return r.checked; });
        var pick = null;
        if (!checked) {
          if (isPayment) pick = list.find(card);
          else if (isDelivery && wantCollect) pick = list.find(function (r) { return COLLECT_RE.test(radioLabel(r)); });
          // (C.shippingFallback 'first': the flow's choice, else whatever the store offers first — Gamesmen's.)
          else if (isDelivery) pick = list.find(ship) || list.find(home) || (C.shippingFallback === 'first' ? list.find(function (r) { return !COLLECT_RE.test(radioLabel(r)); }) : null);
        } else if (isDelivery && !wantCollect && COLLECT_RE.test(radioLabel(checked))) {
          pick = list.find(ship) || list.find(home); // the store chose click & collect for you
        } else if (isDelivery && wantShip && !ship(checked)) {
          pick = list.find(ship); // a shipping method the flow says to pick (e.g. Standard), when it isn't the one chosen
        } else if (isPayment && C.payment === 'card' && NOT_CARD_RE.test(radioLabel(checked)) && !card(checked)) {
          pick = list.find(card); // the store chose PayPal (or the like) for you
        }
        if (!pick || pick.checked) return;
        var key = g + '|' + radioLabel(pick).slice(0, 40);
        if (checked && (SWITCHED[key] || 0) >= 2) return;
        if (checked) SWITCHED[key] = (SWITCHED[key] || 0) + 1;
        pick.click();
        out.filled.push(isPayment ? 'payment method' : 'delivery method');
      });
    }
    if (!opts.onlyCard) {
      // "I agree to the terms" only — never marketing.
      fields.forEach(function (el) {
        if ((el.getAttribute('type') || '').toLowerCase() !== 'checkbox' || el.checked) return;
        var l = (labelText(el) + ' ' + describe(el)).toLowerCase();
        if (/agree|terms|conditions|t\s?&\s?c/.test(l) && !MARKETING_RE.test(l)) {
          el.click();
          out.filled.push('terms');
        }
      });
    }
    return out;
  }

  /** The PayPal button: one that says so, or PayPal's own button frame. */
  function paypalButton() {
    var b = toArray(document.querySelectorAll('button, a, input[type="submit"], input[type="image"], [role="button"]')).find(function (el) {
      return isVisible(el) && !inPanel(el) && /paypal/i.test(textOf(el) + ' ' + (el.getAttribute('alt') || '') + ' ' + (el.getAttribute('src') || '') + ' ' + (el.className || ''));
    });
    return b || toArray(document.querySelectorAll('iframe')).find(function (f) { return isVisible(f) && /paypal\.com/i.test(f.src || ''); }) || null;
  }

  function isSelected(el) {
    return el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true'
      || /(^|\s)(is-)?(selected|active|checked)(\s|$)/i.test(el.className || '');
  }

  function buttons(C) {
    return toArray(document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"], [role="tab"], [role="radio"]')).filter(function (el) {
      return !inPanel(el) && isVisible(el) && textOf(el) && textOf(el).length <= 80;
    }).map(function (el) {
      var kind = classifyButton(textOf(el), C);
      // A tab or an option ("Pay Now", "Pay Later") is a choice on the page, never the final button.
      if (kind === 'final' && /^(tab|radio|option|menuitemradio)$/.test(el.getAttribute('role') || '')) kind = null;
      return { el: el, text: textOf(el), kind: kind, disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' };
    });
  }

  function signature() {
    var t = document.body ? document.body.innerText.length : 0;
    return location.pathname + '|' + document.querySelectorAll('input,select,button').length + '|' + t;
  }

  async function waitForChange(before, ms) {
    var end = Date.now() + ms;
    while (Date.now() < end) {
      await wait(100);
      if (signature() !== before) { await wait(150); return true; }
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

  var SUGGESTIONS = '[role="option"], [role="listbox"] li, .pac-item, [class*="suggest" i] li, [class*="suggest" i] [class*="item" i], [class*="autocomplete" i] li, [class*="address-result" i], [class*="addressResult" i], [id*="listbox" i] li';

  /** The address-lookup box on the page (the one-line "start typing your address" box), or null. */
  function lookupBox(C) {
    var fields = toArray(document.querySelectorAll('input')).filter(function (el) { return isVisible(el) && !inPanel(el); });
    var ctx = { hasParts: addressParts(fields, C) };
    return fields.find(function (el) { return fieldKind(el, C, ctx) === 'addressLookup'; }) || null;
  }

  /**
   * Type your address into an address-lookup box and pick the store's suggestion for it (the one
   * with your postcode, else your suburb, else the first). try: 0, 1, 2 — the address written a bit
   * shorter each time (some lookups find nothing for the whole line). Resolves to what happened:
   * 'picked', 'none' (no suggestions came up) or 'no-box'.
   */
  async function useAddressLookup(values, C, attempt) {
    var box = lookupBox(C);
    if (!box || !values.address1) return 'no-box';
    var tries = [values.address1 + ', ' + values.suburb + ' ' + values.state + ' ' + values.postcode, values.address1 + ' ' + values.suburb, values.address1];
    var query = tries[Math.min(attempt || 0, tries.length - 1)].replace(/\s+/g, ' ').trim();
    if (box.value) setNative(box, '');
    typeInto(box, query, 'addressLookup', true); // (still in the box: lookups show their list while it has the focus)
    box.dispatchEvent(new KeyboardEvent('keyup', { key: query.slice(-1), bubbles: true }));
    var options = [];
    for (var end = Date.now() + 6000; !options.length && Date.now() < end;) {
      await wait(150);
      options = toArray(document.querySelectorAll(SUGGESTIONS)).filter(function (o) { var t = (o.innerText || '').trim(); return isVisible(o) && !inPanel(o) && t.length >= 5 && t.length < 200; });
    }
    var has = function (o, s) { return s && (o.innerText || '').toLowerCase().indexOf(String(s).toLowerCase()) !== -1; };
    var street = String(values.address1 || '').split(/\s+/).slice(0, 2).join(' ');
    var pick = options.find(function (o) { return has(o, values.postcode) && has(o, street); }) || options.find(function (o) { return has(o, values.postcode); })
      || options.find(function (o) { return has(o, values.suburb); }) || options[0];
    if (!pick) return 'none';
    // (Many lookups take the choice on mouse-down, before the click.)
    ['mousedown', 'mouseup'].forEach(function (t) { pick.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); });
    pick.click();
    await wait(700);
    return 'picked';
  }

  /** Is this choice already the one chosen? (Its own state only — never a neighbouring option's.) */
  function isChosen(el) {
    if (isSelected(el)) return true;
    var lab = el.matches('label') ? el : el.closest('label');
    var input = el.matches('input') ? el : el.querySelector('input[type="radio"], input[type="checkbox"]')
      || (lab && (lab.htmlFor ? document.getElementById(lab.htmlFor) : lab.querySelector('input[type="radio"], input[type="checkbox"]')));
    return !!(input && input.checked);
  }

  /**
   * The flow's next choice to make (C.choose: "Home Delivery", "Credit Card"…), however the store
   * shows it: a button, a tab, a tile, a radio's label. Matched against the choice's own words, then
   * the nearest thing to click around them. Null when there's none still to make. chosen: what's
   * been pressed already (each only once).
   */
  function findChoice(C, chosen, pressed) {
    if (!C.choose || !C.choose.length) return null;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var CLICKABLE = 'button, a, label, [role="button"], [role="tab"], [role="radio"], [role="option"], [role="checkbox"], [role="menuitemradio"], [tabindex], [onclick], [class*="option" i], [class*="tile" i]';
    var fallback = null;
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      var t = norm(n.nodeValue);
      if (!t || t.length > 60 || !any(C.choose, t)) continue;
      var host = n.parentElement;
      // (Each choice at most 3 times: a store that re-draws it without showing it's chosen.)
      if (!host || inPanel(host) || !isVisible(host) || (chosen[t] || 0) >= 3) continue;
      var el = host.closest(CLICKABLE);
      var clickable = !!el && norm(textOf(el)).length <= 160;
      if (!clickable) el = host;
      if ((pressed && pressed.has(el)) || el.disabled || el.getAttribute('aria-disabled') === 'true' || isChosen(el)) continue;
      var radio = el.matches('label') ? (el.htmlFor ? document.getElementById(el.htmlFor) : el.querySelector('input[type="radio"], input[type="checkbox"]')) : null;
      var hit = { el: radio || el, text: t, from: el };
      // The same words can show up where there's nothing to press (an order summary's "Home Delivery $9"):
      // something to click first, plain words only if there's nothing else.
      if (clickable) return hit;
      if (!fallback) fallback = hit;
    }
    return fallback;
  }

  /**
   * Walk through the checkout. opts: { values, flow (the store's checkout flow), storeName, setStatus, report, isActive(), hasCard, cardIssue,
   *   auto: an Auto-checkout run — at the final button, onFinal({ el, text }) is called and 'final' returned (nothing highlighted) }
   * Resolves to 'ready' | 'final' | 'needs_you' | 'stopped' | 'timeout' | 'done'.
   */
  async function assist(opts) {
    var C = opts.flow || {};
    var setStatus = opts.setStatus || function () {};
    var report = opts.report || function () {};
    var done = C.done || /confirmation|thank-?you|order-?(complete|received|success)/i;
    var clicked = {};
    var chosen = {};
    var pressed = new WeakSet();
    var lookups = 0;
    var picked = false;
    var manualTried = false;
    var finalAt = 0;
    var idle = 0;
    // (An Auto-checkout run, opts.patientMs: a store slowed right down in a hot drop gets this long —
    //  30 minutes — its steps pressed again while they don't take, and your account told how it's going.)
    var startedAt = Date.now();
    var deadline = startedAt + (opts.patientMs || 4 * 60 * 1000);
    var beatAt = 0;
    var beat = function (text) {
      if (!opts.onBeat || Date.now() - beatAt < 20000) return;
      beatAt = Date.now();
      opts.onBeat(text);
    };
    setStatus('Filling in checkout…');
    while (Date.now() < deadline) {
      if (opts.isActive && !opts.isActive()) { setStatus('Stopped.'); return 'stopped'; }
      // (A slow checkout — over a minute in, whatever it's waiting on: your account hears it's still going.)
      if (Date.now() - startedAt > 60000) beat('Still filling in checkout — the store is slow');
      if (done.test(location.pathname)) { setStatus('Order placed.'); return 'done'; }

      // "Add a protection plan?" and the like: closed, never accepted.
      if (typeof MGBQuick !== 'undefined' && MGBQuick.dismissUpsell) {
        var popup = MGBQuick.dismissUpsell({ flow: { checkout: C } });
        if (popup) { report('step', 'Closed the "' + popup + '" pop-up'); await wait(300); continue; }
      }

      var fill = fillFields(document, opts.values, { flow: C });
      if (fill.filled.length) setStatus('Filled: ' + fill.filled.join(', '));
      var list = buttons(C);
      var finals = list.filter(function (b) { return b.kind === 'final'; });
      var manual = list.find(function (b) { return b.kind === 'manual'; });
      var choice = list.find(function (b) { return b.kind === 'choose' && !b.disabled && !chosen[norm(b.text)] && !isSelected(b.el); }) || findChoice(C, chosen, pressed);
      var steps = list.filter(function (b) { return (b.kind === 'step' || b.kind === 'guest') && !b.disabled; });
      var fresh = steps.filter(function (b) { return !clicked[norm(b.text)]; });

      // A one-line address box with suggestions: "Enter address manually" if the store has it, else
      // type it and pick the suggestion (up to 3 tries, written a little shorter each time).
      // (A box that already has your address — from your store account — is left as it is.)
      var lbox = !fill.kinds.address1 && fill.kinds.addressLookup && !picked ? lookupBox(C) : null;
      if (lbox && (lookups > 0 || !lbox.value)) {
        if (manual && !manualTried) { manualTried = true; manual.el.click(); await wait(300); continue; }
        if (!manual && lookups < 3) {
          setStatus('Looking up your address…');
          var how = await useAddressLookup(opts.values, C, lookups);
          lookups += 1;
          if (how === 'picked') { picked = true; report('step', 'Picked your address from the store\'s suggestions'); }
          else if (lookups === 3) report('error', 'The store\'s address finder didn\'t suggest your address — pick it yourself');
          idle = 0;
          continue;
        }
      }

      // The store's own choices first (e.g. "Home delivery"), each once.
      if (choice) {
        chosen[norm(choice.text)] = (chosen[norm(choice.text)] || 0) + 1;
        pressed.add(choice.from || choice.el);
        var beforeChoice = signature();
        setStatus('Choosing "' + choice.text + '"…');
        report('step', 'Chose "' + choice.text + '"');
        choice.el.click();
        await waitForChange(beforeChoice, 4000);
        idle = 0;
        continue;
      }

      // Steps that need the card in first (EB Games' "Done" under its card boxes): not before it is.
      if (C.afterCard && C.afterCard.length && opts.cardReady) {
        var early = fresh.filter(function (b) { return any(C.afterCard, norm(b.text)); });
        if (early.length && !(await opts.cardReady(true))) {
          fresh = fresh.filter(function (b) { return early.indexOf(b) === -1; });
          if (!fresh.length) { setStatus('Waiting for your card to go in…'); idle += 1; await wait(500); continue; }
        }
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

      // A store that only takes PayPal (C.payment 'paypal'): its PayPal button (often in PayPal's own frame) is where it stops.
      if (!finals.length && C.payment === 'paypal') {
        var pp = paypalButton();
        if (pp) finals = [{ el: pp, text: textOf(pp) && textOf(pp).length < 60 ? textOf(pp) : 'Checkout with PayPal', kind: 'final', disabled: false }];
      }

      if (finals.length) {
        // The final button can show before the last choices do (a payment choice that only comes up
        // once the address is in): with the card still to go in, keep making choices for a while.
        if (!finalAt) finalAt = Date.now();
        if (C.payment === 'card' && opts.cardReady && Date.now() - finalAt < 12000 && !(await opts.cardReady())) {
          setStatus('Waiting for your card to go in…');
          await wait(200);
          continue;
        }
        await wait(200); // let the last fields settle
        fillFields(document, opts.values, { flow: C });
        var fin = finals.find(function (b) { return !b.disabled; }) || finals[0];
        if (opts.auto) {
          setStatus('Filled in — placing your order…');
          if (opts.onFinal) opts.onFinal({ el: fin.el, text: fin.text });
          return 'final';
        }
        var card = opts.hasCard ? (fill.missingCard ? ' Type in anything still empty on the card (like the CVV).' : '') : (CARD_ISSUE[opts.cardIssue] || '');
        var msg = 'Ready — review everything and press "' + fin.text + '" yourself.' + card;
        highlight(fin.el, 'Mugibot: ' + msg);
        setStatus(msg);
        report('ready', 'Checkout filled in' + (opts.storeName ? ' at ' + opts.storeName : '') + ' — waiting for you to press "' + fin.text + '"');
        return 'ready';
      }

      // A step button we already pressed is still there: maybe a field needs attention. (A patient run: the
      // store may just be slow to answer it — pressed again every few seconds, as long as it's patient.)
      var patient = !!opts.patientMs;
      var again = steps.find(function (b) { return clicked[norm(b.text)] && (patient || clicked[norm(b.text)] < 3); });
      if (again && idle > (patient ? 16 : 6)) {
        clicked[norm(again.text)] += 1;
        if (patient) {
          setStatus('The store\'s slow to answer "' + again.text + '" — pressing it again…');
          beat('Still at "' + again.text + '" — the store\'s slow to answer; pressing it again (for up to ' + Math.round(opts.patientMs / 60000) + ' minutes)');
        }
        again.el.click();
        await wait(1500);
        idle = 0;
        continue;
      }
      // (Still loading, or its button busy: the store's working on it — not stuck.)
      var working = patient && typeof MGBQuick !== 'undefined' && MGBQuick.pageBusy && MGBQuick.pageBusy();
      if (!working) idle += 1;
      if (idle > 64 && !(patient && Date.now() < deadline)) {
        var stuck = steps[0] ? 'Stuck at "' + steps[0].text + '" — something on the page needs your input.' : "Couldn't find the next step — please continue yourself.";
        setStatus(stuck);
        report('error', stuck);
        return 'needs_you';
      }
      if (idle > 64) {
        // (Patient: said, and on it goes — the page may come right; a box only you can fill, you fill in.)
        var slow = steps[0] ? 'Waiting at "' + steps[0].text + '" — the store hasn\'t moved on yet (if a box needs you, fill it in)' : 'Waiting for the store\'s checkout to move on';
        setStatus(slow + '…');
        beat(slow);
        idle = 32;
      }
      await wait(250);
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
    fieldKind: fieldKind,
    findChoice: findChoice,
    fieldValues: fieldValues,
    fillFields: fillFields,
    assist: assist,
    CARD_KINDS: CARD_KINDS,
  };
})();
