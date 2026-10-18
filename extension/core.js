/* Mugibot — the store-page part of ⚡ Buy (built on TCGBot's Quick Checkout).

   One of each, straight to checkout, as fast as the store allows:
   - Shopify stores: the store's own cart link (/cart/<variant>:1) opens checkout with the
     product already in it — no product page clicks at all.
   - Other stores: Add to bag the moment the store's page can take the press, then — as
     soon as the store shows it went in — straight to its checkout page (or its "added"
     popup's Checkout button).
   Then fill.js fills checkout in and stops at the final button for you to press. Which
   buttons it presses comes from that store's flow (server/retailers/<store>.js); general
   rules cover anything a flow doesn't say. It only runs when you press a Mugibot button —
   or for an Auto-checkout run you armed (content.js), which presses the final button itself
   once it has checked the order against your limits.

   "Often bought together" and similar pop-ups that try to sell you more are closed with
   their own close button (×), never accepted. */

var MGBQuick = (function () {
  'use strict';

  var PANEL_ID = 'mugibot-qc';
  // Panels from other scripts (TCGBot, TCGCopBot, Tampermonkey) — ignored, and flagged if present.
  var OTHER_PANELS = ['tcgcopbot-qc', 'tcgbot-qc', 'tcgbot-quick-checkout', 'kmart-upc-quick-checkout'];
  var FLOW_MAX_AGE = 90000;
  // How often the page is looked at while ⚡ Buy runs.
  var POLL_MS = 100;
  // After pressing Add, checkout is only opened once the store shows the item went in.
  // If the page didn't react at all by QUIET_MS, the press came before the page was
  // ready: press once more. CONFIRM_MS: the bag count still hasn't moved — press once
  // more; or, if the count can't be read, go on anyway.
  var QUIET_MS = 5000;
  var CONFIRM_MS = 6000;
  // Added, and no "added" pop-up with a Checkout button, nor a bag link Mugibot knows, after this
  // long: the store's bag page, by its address. On the bag page with the item in it and no Checkout
  // button Mugibot knows after BAG_MS: a link that goes to checkout, else it says so (not 30 s on).
  var NO_ROUTE_MS = 2500;
  var BAG_MS = 4000;
  // The bag link's number hasn't moved this long after Add, but the store's cart answered the add: it's
  // in (some stores only update that number on the next page) — on to checkout, never Add again.
  var ANSWERED_MS = 2500;
  // How long to wait for a page built with React or Vue to wire up its Add button.
  var READY_MS = 8000;
  var ADDED_RE = /\badded to (your )?(bag|cart|basket|trolley)\b|\bitems? added\b/i;
  var EMPTY_RE = /\b(bag|cart|basket|trolley) is (currently )?empty\b|\bno items in (your )?(shopping )?(bag|cart|basket|trolley)\b|\bnothing in (your )?(bag|cart|basket|trolley)\b/i;
  var RECOMMENDATIONS = '[class*="recommend" i], [id*="recommend" i], [class*="carousel" i], [class*="related" i], [class*="upsell" i], [class*="product-card" i], [class*="product-tile" i], [class*="also-like" i]';
  var DRAWER = '[role="dialog"], [aria-modal="true"], [class*="drawer" i], [class*="minicart" i], [class*="mini-cart" i], [class*="mini-bag" i], [class*="minibag" i], [class*="flyout" i], [class*="modal" i], [class*="side-cart" i], [class*="added-to" i], [class*="addedto" i]';
  var EXPRESS = /paypal|afterpay|zip ?pay|\bzip\b|klarna|humm|latitude|apple ?pay|google ?pay|shop ?pay|express|continue shopping/i;
  var ADD_RE = /\b(add to (bag|cart|basket|trolley)|pre-?order)\b/i;
  // The final "buy" buttons are never pressed while getting to checkout, whatever a flow says
  // (only an armed Auto-checkout run presses one: content.js, at checkout).
  var FINAL = /check ?out securely|place (my |your )?order|pay now|pay securely|complete (my |your )?(order|purchase|payment)|submit (my )?(order|payment)|confirm (and|&) pay|pay \$|buy now/i;
  // Pop-ups that try to sell you more ("Often Bought Together" at Target) — closed, never accepted —
  // and newsletter sign-ups that cover the page.
  var UPSELL_RE = /often bought together|frequently bought( together)?|bought together|you (may|might) also (like|need|want)|customers (also|who) (bought|viewed|liked)|complete (the|your) (look|set|collection)|recommended for you|goes (well )?with|pairs? (well )?with|don.?t forget|add (a |an )?(protection|warranty|care plan|gift ?wrap)|protect your purchase|before you go|special offer|upgrade your (order|purchase)/i;
  var NEWSLETTER_RE = /newsletter|sign up (for|to) (our|the) (newsletter|emails?)|subscribe to (our|the)|get \d+% off your first/i;
  var CLOSE_RE = /^(×|✕|✖|x|close|close (this )?(dialog|popup|pop-up|modal|window)|dismiss|no,? thanks?|not now|maybe later|skip|continue without( adding)?|no thank you)$/i;
  var POPUP = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="pop-up" i], [class*="overlay" i], [class*="lightbox" i]';

  var wait = MGBFlows.wait; // (at full speed in a tab in the background too)
  var toArray = function (list) { return Array.prototype.slice.call(list); };
  var part = MGBFlows.part;
  var any = MGBFlows.any;

  // --------------------------------------------------------------------------
  // Finding things on the page
  // --------------------------------------------------------------------------
  function isVisible(el) {
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }

  function isDisabled(el) {
    return el.disabled || el.getAttribute('aria-disabled') === 'true';
  }

  /** Each thing a button is called by: its words, aria-label, title, value, and what it's labelled by. */
  function labelParts(el) {
    // (aria-labelledby: Amazon's "Buy Now" is a bare button, its words in a separate span.)
    var by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(function (id) { var x = document.getElementById(id); return x ? x.textContent : ''; }).join(' ');
    return [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.value, by]
      .filter(Boolean).map(function (t) { return String(t).trim().replace(/\s+/g, ' '); }).filter(Boolean);
  }

  function labelOf(el) {
    return labelParts(el).join(' ');
  }

  function textOf(el) {
    return (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
  }

  function inAnyPanel(el) {
    var ids = [PANEL_ID].concat(OTHER_PANELS);
    for (var i = 0; i < ids.length; i++) {
      var p = document.getElementById(ids[i]);
      if (p && p.contains(el)) return true;
    }
    return false;
  }

  function controls() {
    return toArray(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'))
      .filter(function (el) { return !inAnyPanel(el) && isVisible(el) && !isDisabled(el); });
  }

  /**
   * An upsell or newsletter pop-up over the page, and its close button (or null). A pop-up with a
   * Checkout button in it (the store's "added to bag" one) is never closed. R: the store's flow
   * (added.upsell: its own pop-up titles).
   */
  function findUpsellClose(R) {
    var mine = part(R, 'added').upsell;
    var pops = toArray(document.querySelectorAll(POPUP)).filter(function (el) { return !inAnyPanel(el) && isVisible(el); });
    for (var i = 0; i < pops.length; i++) {
      var pop = pops[i];
      var text = (pop.innerText || '').slice(0, 600);
      var upsell = (mine && mine.length && any(mine, text)) || UPSELL_RE.test(text);
      var newsletter = !upsell && NEWSLETTER_RE.test(text) && !!pop.querySelector('input[type="email"], input[name*="email" i]');
      if (!upsell && !newsletter) continue;
      var buttons = toArray(pop.querySelectorAll('button, a, [role="button"], input[type="button"]')).filter(function (el) { return isVisible(el) && !isDisabled(el); });
      if (buttons.some(function (el) { return isCheckoutLabel(R, textOf(el), 'popup'); })) continue;
      var close = buttons.find(function (el) {
        var label = [el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').trim();
        return CLOSE_RE.test(label) || /\bclose\b|\bdismiss\b/i.test(label) || CLOSE_RE.test(textOf(el).trim());
      }) || buttons.find(function (el) { return /(^|[\s_-])close([\s_-]|$)|modal-close|close-?(button|btn|icon)/i.test(String(el.className || '')) && textOf(el).length <= 2; });
      if (close) return { el: close, title: popupTitle(pop, text) };
    }
    return null;
  }

  /** A pop-up's title: its heading (or what it's labelled by), else its first line of words. */
  function popupTitle(pop, text) {
    var by = pop.getAttribute('aria-labelledby');
    var el = (by && document.getElementById(by.split(/\s+/)[0])) || pop.querySelector('h1, h2, h3, h4, [class*="title" i]');
    var t = el ? (el.innerText || '').trim() : '';
    if (!t) t = text.split('\n').map(function (x) { return x.trim(); }).find(function (x) { return /[a-z]{3}/i.test(x); }) || 'pop-up';
    return t.replace(/\s+/g, ' ').slice(0, 60);
  }

  /** Close an upsell or newsletter pop-up if one is showing. Returns its title, or null. */
  function dismissUpsell(R) {
    var hit = findUpsellClose(R);
    if (!hit) return null;
    hit.el.click();
    return hit.title;
  }

  function otherPanelPresent() {
    return OTHER_PANELS.some(function (id) { return !!document.getElementById(id); });
  }

  function isFinal(R, label) {
    return FINAL.test(label) || any(part(R, 'checkout').final, label);
  }

  /** Does this element sit in a tile that links to a different product? (e.g. "You may also like") */
  function inOtherProductTile(el) {
    var root = el;
    for (var i = 0; i < 4 && root.parentElement && root.parentElement !== document.body; i++) root = root.parentElement;
    var here = location.pathname.replace(/\/+$/, '');
    return toArray(root.querySelectorAll('a[href]')).some(function (a) {
      try {
        var u = new URL(a.getAttribute('href'), location.href);
        var path = u.pathname.replace(/\/+$/, '');
        return u.host === location.host && path !== here && /\/(product|products|p)\//i.test(path);
      } catch (e) { return false; }
    });
  }

  /**
   * A store whose product page goes straight to checkout with its own button (Amazon's "Buy Now",
   * product.buyNow): that button, or null. It's not the final button — that's at checkout.
   */
  function findBuyNow(R) {
    var P = part(R, 'product');
    if (!P.buyNow || !P.buyNow.length) return null;
    return controls().find(function (el) {
      return labelParts(el).some(function (t) { return t.length < 40 && any(P.buyNow, t); }) && !el.closest('header, nav') && !el.closest(RECOMMENDATIONS) && !inOtherProductTile(el);
    }) || null;
  }

  /** The store's sign-in page (Amazon sends you there from "Buy Now" when you're signed out). */
  function onSignInPage(R) {
    var check = R && R.account && R.account.check;
    var re = check && check.signedOutUrl;
    return (re && re.test && re.test(location.href)) || /\/(ap\/signin|signin|sign-in|login|log-in)(\/|$|\?)/i.test(location.pathname);
  }

  /** A checkout running in a frame of its own on this page (checkout.frames: Amazon's quick checkout). */
  function checkoutFrameShown(R) {
    var frames = part(R, 'checkout').frames || [];
    if (!frames.length) return false;
    return toArray(document.querySelectorAll('iframe')).some(function (f) {
      var src = f.src || '';
      try { src = new URL(src, location.href).href; } catch (e) { /* keep */ }
      return isVisible(f) && frames.some(function (re) { return re && re.test && re.test(src); });
    });
  }

  function findAddToBag(R) {
    var P = part(R, 'product');
    var labels = P.add && P.add.length ? P.add : [ADD_RE];
    var all = [];
    if (P.addSelector) {
      try { all = toArray(document.querySelectorAll(P.addSelector)).filter(function (el) { return isVisible(el) && !isDisabled(el) && !inAnyPanel(el); }); } catch (e) { all = []; }
    }
    if (!all.length) {
      all = controls().filter(function (el) {
        var label = labelOf(el);
        return label.length < 80 && any(labels, label) && !isFinal(R, textOf(el)) && !el.closest('header, nav');
      });
    }
    // Prefer the main buy box; fall back to any Add button that isn't on another product's tile.
    return all.find(function (el) { return !el.closest(RECOMMENDATIONS); })
      || all.find(function (el) { return !inOtherProductTile(el); })
      || null;
  }

  function isCheckoutLabel(R, label, where) {
    var t = label.trim();
    if (!t || t.length >= 60 || EXPRESS.test(t) || isFinal(R, t)) return false;
    var mine = where === 'popup' ? part(R, 'added').checkout : part(R, 'bag').checkout;
    if (mine && mine.length) {
      if (any(mine, t)) return true;
      if (where === 'popup') return false; // the store's own popup labels only
    }
    return /\b((secure |proceed to )?check ?out( now)?)\b/i.test(t) || /^continue to (details|checkout)$/i.test(t);
  }

  /**
   * inPopupOnly: only accept a Checkout button inside the "added to bag" popup / mini-bag.
   * before: buttons already showing before Add was pressed (a mini-bag that's always there
   * isn't the "added" popup).
   */
  function findCheckout(R, inPopupOnly, before) {
    if (inPopupOnly) {
      return controls().find(function (el) { return !(before && before.has(el)) && el.closest(DRAWER) && isCheckoutLabel(R, textOf(el), 'popup'); }) || null;
    }
    var list = controls().filter(function (el) { return isCheckoutLabel(R, textOf(el), 'bag'); });
    return list.find(function (el) { return !el.closest('header, nav'); }) || list[0] || null;
  }

  /**
   * A link that goes to the store's checkout (by its address), for a bag page whose Checkout button
   * Mugibot doesn't know by its words. Never PayPal's or another express one, nor a final button.
   */
  function checkoutLink(R) {
    return controls().find(function (el) {
      var href = el.getAttribute('href') || el.getAttribute('formaction') || '';
      if (!/\/check-?outs?\b|checkout/i.test(href) || EXPRESS.test(href) || /paypal|afterpay|klarna|shop-?pay|apple-?pay|google-?pay/i.test(href)) return false;
      var t = textOf(el);
      return !EXPRESS.test(t) && !isFinal(R, t) && t.length < 60;
    }) || null;
  }

  /** The store's bag page: flow bag.url, else /cart under the store's own address (Pokémon Center's is /en-au/cart). */
  function bagUrl(R) {
    var B = part(R, 'bag');
    if (B.url) return storePath(R, B.url);
    var under = '';
    try { under = new URL(R.base).pathname.replace(/\/+$/, ''); } catch (e) { under = (R && R.pathPrefix) || ''; }
    return under + '/cart';
  }

  function findBag(R) {
    var mine = part(R, 'added').viewBag;
    var list = controls().filter(function (el) {
      var label = textOf(el);
      if (mine && mine.length && any(mine, label)) return true;
      var l = label.toLowerCase();
      if (/add to (bag|cart)|check ?out/.test(l) || l.length > 60) return false;
      return /\b(view|open|my|shopping|go to)?\s*(bag|basket|cart|trolley)\b/.test(l);
    });
    return list.find(function (el) { return el.closest(DRAWER); }) || list[0] || null;
  }

  /**
   * How many items the store's bag link says are in the bag (e.g. "Bag, 2 items" or a
   * badge inside the link). null when no bag link shows a number.
   */
  function bagCount() {
    var best = null;
    toArray(document.querySelectorAll('a, button, [role="button"]')).forEach(function (el) {
      if (inAnyPanel(el) || !isVisible(el)) return;
      var label = labelOf(el);
      if (label.length > 60 || /add to|check ?out|continue/i.test(label)) return;
      var href = el.getAttribute('href') || '';
      var isBag = /\/(cart|bag|basket|trolley)(\/|$|\?|#)/i.test(href)
        || (!!el.closest('header, nav') && /\b(bag|cart|basket|trolley)\b/i.test(label));
      if (!isBag) return;
      var m = label.replace(/\$\s?\d[\d,]*(\.\d+)?/g, ' ').match(/\b(\d{1,3})\b/);
      if (m) best = Math.max(best || 0, parseInt(m[1], 10));
    });
    return best;
  }

  /** Counts changes the store makes to its page (not to our panel). */
  function watchPage() {
    var n = 0;
    var obs = new MutationObserver(function (list) {
      list.forEach(function (m) { if (!inAnyPanel(m.target.nodeType === 1 ? m.target : m.target.parentElement || document.body)) n++; });
    });
    obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    return { changes: function () { return n; }, stop: function () { obs.disconnect(); } };
  }

  /** A visible "Added to bag" message (popup, drawer, toast). */
  function addedMessage(R) {
    var mine = part(R, 'added').confirm;
    return toArray(document.querySelectorAll(DRAWER + ', [role="alert"], [role="status"], [aria-live]')).some(function (el) {
      if (inAnyPanel(el) || !isVisible(el)) return false;
      var t = (el.innerText || '').slice(0, 300);
      return (mine && mine.length && any(mine, t)) || ADDED_RE.test(t);
    });
  }

  /**
   * The bag page says there's nothing in it ("Your bag is empty"). Its words, not the number on the
   * bag icon: that can show 0 for a moment while a slow bag page loads (and pressing Add again
   * then would add a second one).
   */
  function bagLooksEmpty() {
    var main = document.querySelector('main') || document.body;
    return EMPTY_RE.test((main.innerText || '').slice(0, 5000)) && !(bagCount() > 0);
  }

  /** What the store's page is saying right now (an error, a pop-up's title), for "why it wasn't added". */
  function pageSays() {
    var els = toArray(document.querySelectorAll('[role="alert"], [role="alertdialog"], [role="dialog"], [aria-live="assertive"], [class*="error" i], [class*="toast" i]'));
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (inAnyPanel(el) || !isVisible(el)) continue;
      var head = el.querySelector('h1, h2, h3, h4');
      var t = ((head && head.innerText) || el.innerText || '').trim().replace(/\s+/g, ' ');
      if (t && /[a-z]{3}/i.test(t) && !ADDED_RE.test(t)) return t.slice(0, 100);
    }
    return '';
  }

  /**
   * On a page that has only just opened, give the store's own code time to start: until the
   * page has loaded, and settleMs after. Only for pages where Mugibot can't see when the
   * store's code has wired up its Add button (see whenReady).
   */
  async function settle(R) {
    var P = part(R, 'product');
    var ms = P.settleMs == null ? 400 : P.settleMs;
    var end = Date.now() + 10000;
    while (document.readyState !== 'complete' && Date.now() < end) await wait(50);
    var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    var left = (nav && nav.loadEventEnd ? nav.loadEventEnd : 0) + ms - performance.now();
    if (left > 0) await wait(Math.min(left, ms));
  }

  /**
   * Press Add as soon as the store's page can take it. Pages built with React or Vue
   * (Kmart's) show their Add button before their code has wired it up, and a press then
   * does nothing: `probe` (from the extension) looks into the page and says when the
   * button is wired up — usually long before the page has finished loading. Pages it
   * can't tell about wait for the page to load (settle).
   */
  async function whenReady(R, add, probe, setStatus) {
    var end = Date.now() + (part(R, 'product').readyMs || READY_MS);
    if (probe) {
      for (var said = false; ;) {
        var r = null;
        try { r = await probe(add); } catch (e) { r = null; }
        if (!r) break;
        if (r.ready) {
          if (said) await wait(POLL_MS); // just wired up: a moment for the page's own start-up to finish
          return findAddToBag(R) || add;
        }
        if (!r.framework || Date.now() > end) break;
        if (!said) { said = true; setStatus('Waiting for the store\'s page to be ready…'); }
        await wait(POLL_MS);
        add = findAddToBag(R) || add; // the page may have re-drawn it
      }
    }
    await settle(R);
    return findAddToBag(R) || add;
  }

  /** The store's site (any of its addresses): a request to it is the store, not an advert. */
  function sameSite(host) {
    var site = location.hostname.replace(/^www\./, '');
    return host === site || host.slice(-(site.length + 1)) === '.' + site;
  }

  /** A request to the store's cart, made by the page after `since` (Date.now() time), that has come back OK. */
  function cartRequestDone(since) {
    if (!performance.getEntriesByType) return false;
    var t0 = since - (performance.timeOrigin || 0);
    return performance.getEntriesByType('resource').some(function (e) {
      if ((e.initiatorType !== 'fetch' && e.initiatorType !== 'xmlhttprequest') || e.startTime < t0 || !e.responseEnd) return false;
      if (e.responseStatus && (e.responseStatus < 200 || e.responseStatus >= 300)) return false;
      try {
        var u = new URL(e.name);
        return sameSite(u.hostname) && /cart|basket|bag|trolley/i.test(u.pathname + u.search);
      } catch (x) { return false; }
    });
  }

  /**
   * A request to the store's cart, made by the page after `since`, that the store refused: its HTTP
   * status (e.g. 403, 409), or 0. (Kmart's add can be turned away while its page is still starting.)
   */
  function cartRequestFailed(since) {
    if (!performance.getEntriesByType) return 0;
    var t0 = since - (performance.timeOrigin || 0);
    var bad = 0;
    performance.getEntriesByType('resource').forEach(function (e) {
      if ((e.initiatorType !== 'fetch' && e.initiatorType !== 'xmlhttprequest') || e.startTime < t0 || !e.responseEnd) return;
      if (!e.responseStatus || (e.responseStatus >= 200 && e.responseStatus < 400)) return;
      try {
        var u = new URL(e.name);
        if (sameSite(u.hostname) && /cart|basket|bag|trolley/i.test(u.pathname + u.search)) bad = e.responseStatus;
      } catch (x) { /* ignore */ }
    });
    return bad;
  }

  /** Until the page has finished loading (at most 10 s), and the flow's settleMs after. */
  async function untilLoaded(R) {
    for (var end = Date.now() + 10000; document.readyState !== 'complete' && Date.now() < end;) await wait(100);
    var ms = part(R, 'product').settleMs;
    await wait(ms == null ? 400 : ms);
  }

  /** A path on this store (the dummy store keeps each store under its own folder). */
  function storePath(R, p) {
    return ((R && R.pathPrefix) || '') + p;
  }

  function onBagPage(R) {
    var re = part(R, 'bag').path || /\/(cart|bag|basket|trolley)(\/|$)/i;
    return re.test(location.pathname);
  }

  function onCheckoutPage(R) {
    var re = part(R, 'checkout').path || /\/checkout/i;
    return re.test(location.pathname) && !onBagPage(R);
  }

  /** The item on your watchlist that this page is for (matched by SKU in the link). */
  function productForPage(items, R) {
    var path = MGBFlows.decodedPath(location).toLowerCase();
    var shown = (items || []).filter(function (p) { return p.sku && p.url; });
    if (R && R.skuFromPath) {
      var m = MGBFlows.decodedPath(location).match(R.skuFromPath);
      if (m) {
        var sku = m[1].toLowerCase();
        var hit = shown.find(function (p) { return String(p.sku).toLowerCase() === sku && (!R.id || p.store === R.id); })
          || shown.find(function (p) { return String(p.sku).toLowerCase() === sku; });
        if (hit) return hit;
      }
    }
    return shown.find(function (p) { return (!R || p.store === R.id) && path.indexOf(String(p.sku).toLowerCase()) !== -1; }) || null;
  }

  async function waitForEl(find, ms) {
    var end = Date.now() + (ms || 0);
    for (;;) {
      var el = find();
      if (el || Date.now() >= end) return el;
      await wait(POLL_MS);
    }
  }

  /** Shopify: the product's option to buy — the one in the link, else the first in stock. */
  async function shopifyVariant(R) {
    var m = MGBFlows.decodedPath(location).match(/\/products\/([^/?#.]+)/);
    if (!m) return null;
    var want = new URLSearchParams(location.search).get('variant');
    try {
      var res = await fetch(storePath(R, '/products/' + encodeURIComponent(m[1]) + '.js'), { credentials: 'include', headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      var vars = ((await res.json()) || {}).variants || [];
      var v = vars.find(function (x) { return String(x.id) === want; }) || vars.find(function (x) { return x.available; }) || vars[0];
      return v && /^\d{1,20}$/.test(String(v.id)) ? String(v.id) : null;
    } catch (e) { return null; }
  }

  // --------------------------------------------------------------------------
  // The flow
  // --------------------------------------------------------------------------
  /**
   * opts: {
   *   fresh: true when a button was just pressed (false = resuming after the page changed),
   *   retailer: this store's flow (from the server),
   *   product: the matching watchlist item (or null) — {sku, name},
   *   products: your whole watchlist,
   *   store: {read(), save(flow), clear()} — where progress is kept between pages,
   *   setStatus(text), report(type, message, product),
   *   waitForButtonMs: how long to wait for Add to bag to appear (slow-loading pages),
   *   probe(addButton): resolves to {ready, framework} — has the store's own code wired the button up yet?
   *   why(reason, message, status): told why it stopped short of checkout ('sold_out', 'not_added', 'no_checkout',
   *     'timeout'; 'signed_out', with status 'needs_you': the store wants you signed in first)
   * }
   * Resolves to 'checkout' | 'checkout-frame' (the store's quick checkout, in a frame on this page: frame.js
   * runs it) | 'navigating' (to checkout, on a new page) | 'error' | 'stopped' | 'timeout'.
   */
  async function run(opts) {
    var page = { before: null, watch: null }; // what was on the page before Add was pressed, and changes since
    try {
      return await steps(opts, page);
    } finally {
      if (page.watch) page.watch.stop();
    }
  }

  function pressAdd(page, add) {
    page.before = new Set(controls());
    page.saidBefore = pageSays(); // (a message already showing isn't about this press)
    if (page.watch) page.watch.stop();
    page.watch = watchPage();
    add.click();
  }

  async function steps(opts, page) {
    var R = opts.retailer || null;
    var store = opts.store;
    var setStatus = opts.setStatus || function () {};
    var report = opts.report || function () {};
    var product = opts.product || null;
    var C = part(R, 'checkout');
    var why = opts.why || function () {};
    var closed = 0;
    // On its way to another page already (a link the store's code followed): nothing sent anywhere else meanwhile.
    var leaving = false;
    addEventListener('beforeunload', function () { leaving = true; }, { once: true });
    function skipUpsell() {
      if (closed >= 5) return false;
      var title = dismissUpsell(R);
      if (!title) return false;
      closed += 1;
      setStatus('Closed "' + title + '" — not adding anything else');
      report('step', 'Closed the "' + title + '" pop-up', product);
      return true;
    }

    function goCheckout(el) {
      store.clear();
      setStatus('Opening checkout…');
      report('checkout', 'Opening checkout', product);
      el.click();
      return 'checkout';
    }

    /**
     * Added: straight to the store's checkout page, or its popup's Checkout button. The trip is
     * remembered: a store sends an empty bag to its bag page instead of checkout (the add didn't go
     * through, though the page looked busy), and that's caught there.
     */
    function openCheckout(popup, flow) {
      if (!C.url && popup) return goCheckout(popup);
      store.save(Object.assign({}, flow, { stage: 'to-checkout', leftAt: Date.now() }));
      setStatus(flow && flow.added ? 'Added — opening checkout…' : 'Opening checkout…');
      report('checkout', 'Opening checkout', product);
      location.assign(storePath(R, C.url));
      return 'navigating';
    }

    /**
     * On the bag page with no Checkout button after a few seconds, and the bag looks empty: the add
     * didn't go through (the page only looked busy) — back to the product to press Add once more,
     * or say so. null: the bag isn't empty (keep looking).
     */
    function emptyBag(flow, how) {
      if (!bagLooksEmpty()) return null;
      if (!flow.retried && flow.productUrl) {
        store.save(Object.assign({}, flow, { stage: 'add-again', retried: true, startedAt: Date.now() }));
        setStatus('Your bag is empty — the add didn\'t go through. Going back to press Add again…');
        report('error', how + ', but the bag was empty — pressing Add again', product);
        location.assign(flow.productUrl);
        return 'navigating';
      }
      return notAdded(flow.said || '');
    }

    /**
     * The add didn't go through (nothing to show for it, the store turned it away, or it sent an
     * empty bag back). said: what the page said; status: what the store's cart answered (403…).
     */
    function notAdded(said, status) {
      store.clear();
      var name = (R && R.name) || 'The store';
      var answered = status ? ' (the store answered HTTP ' + status + ')' : '';
      setStatus(name + ' didn\'t add it to your bag' + (said ? ' — the page said: "' + said + '"' : '') + answered + '. Press Add to bag yourself, then Checkout.');
      report('error', name + ' did not add it to the bag' + (said ? ' (the page said: "' + said + '")' : '') + answered, product);
      why('not_added', (said ? 'The page said: "' + said + '"' : '') + (status ? (said ? ' — ' : '') + 'the store answered HTTP ' + status : ''));
      return 'error';
    }

    async function checkoutFromBag() {
      var checkout = await waitForEl(function () { skipUpsell(); return findCheckout(R, true) || findCheckout(R, false); }, 4000);
      if (!checkout) {
        store.clear();
        var empty = bagCount() === 0;
        setStatus(empty ? 'Your bag is empty — the item wasn\'t added. Go back and press Add to bag yourself.' : "Couldn't find the Checkout button on this page.");
        why(empty ? 'not_added' : 'no_checkout');
        return 'error';
      }
      return goCheckout(checkout);
    }

    if (opts.fresh) {
      store.clear();
      if (onCheckoutPage(R)) { setStatus('At checkout — filling it in…'); return 'checkout'; }
      if (onBagPage(R)) return checkoutFromBag();
      if (!product) { setStatus('Open one of your SKUs first (list below).'); return 'error'; }
      // Shopify: the store's own cart link puts it in the cart and opens checkout — no clicks.
      if (R && R.cartPath && R.cartPath.indexOf('{variant}') !== -1) {
        setStatus('Opening checkout with it in your cart…');
        var variant = await shopifyVariant(R);
        if (variant) {
          store.save({ stage: 'cart-link', startedAt: Date.now(), sku: product.sku, name: product.name });
          report('add', 'Opened the store\'s cart link — straight to checkout', product);
          location.assign(storePath(R, R.cartPath.replace('{variant}', variant).replace('{qty}', '1')));
          return 'navigating';
        }
      }
      var waitMs = opts.waitForButtonMs == null ? 1500 : opts.waitForButtonMs;
      // A store whose product page goes straight to checkout (Amazon's "Buy Now"): that, if it's there.
      if (part(R, 'product').buyNow) {
        setStatus('Looking for "Buy Now"…');
        var buy = await waitForEl(function () { skipUpsell(); return findBuyNow(R); }, Math.min(waitMs, 6000));
        if (buy) {
          buy = await whenReady(R, buy, opts.probe, setStatus);
          buy = findBuyNow(R) || buy;
          store.save({ stage: 'buy-now', startedAt: Date.now(), clickedAt: Date.now(), sku: product.sku, name: product.name, productUrl: location.href.split('#')[0] });
          var said = (labelParts(buy).find(function (t) { return any(part(R, 'product').buyNow, t); }) || 'Buy Now').slice(0, 40);
          setStatus('Pressing "' + said + '" — straight to checkout…');
          report('add', 'Clicked "' + said + '"', product);
          buy.click();
        }
      }
    }
    if (opts.fresh && !(store.read() || {}).stage) {
      setStatus('Looking for the Add button…');
      var add = await waitForEl(function () { skipUpsell(); return findAddToBag(R); }, waitMs);
      if (!add) {
        setStatus("Add to bag isn't available — sold out, or the page is still loading.");
        report('error', 'Add button not available', product);
        why('sold_out');
        return 'error';
      }
      add = await whenReady(R, add, opts.probe, setStatus);
      // Save before clicking in case the site changes page straight away.
      store.save({ stage: 'add-clicked', startedAt: Date.now(), clickedAt: Date.now(), sku: product.sku, name: product.name, countBefore: bagCount(), productUrl: location.href.split('#')[0] });
      setStatus('Adding to your bag…');
      pressAdd(page, add);
      report('add', 'Clicked "' + textOf(add).slice(0, 40) + '"', product);
    }

    var arrived = Date.now(); // when this page started looking (a bag page takes a moment to show what's in it)
    var deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      var flow = store.read();
      if (!flow) { setStatus('Stopped.'); return 'stopped'; }
      // "Often bought together" and the like: closed, then carry on.
      if (skipUpsell()) { await wait(250); continue; }
      if (!product) product = (opts.products || []).find(function (p) { return p.sku === flow.sku; }) || { sku: flow.sku, name: flow.name };
      if (Date.now() - flow.startedAt > FLOW_MAX_AGE) {
        store.clear();
        setStatus('Timed out. Check your bag and continue yourself.');
        report('error', 'Timed out before reaching checkout', product);
        why('timeout');
        return 'timeout';
      }
      if (onCheckoutPage(R)) {
        store.clear();
        setStatus('At checkout — filling it in…');
        report('checkout', 'Reached checkout', product);
        return 'checkout';
      }
      if (flow.stage === 'buy-now') {
        // "Buy Now" pressed: the store's checkout opens (above), or its quick checkout in a frame on
        // this page (frame.js runs that one), or its sign-in page when you're signed out.
        if (checkoutFrameShown(R)) {
          store.clear();
          setStatus('At checkout — filling it in…');
          report('checkout', 'Reached checkout (in the page\'s quick-checkout window)', product);
          return 'checkout-frame';
        }
        if (onSignInPage(R)) {
          store.clear();
          var who = (R && R.name) || 'The store';
          setStatus(who + ' wants you to sign in first — it only sells to signed-in customers. Sign in, then ⚡ Buy again.');
          report('error', who + ' asked you to sign in before checkout', product);
          why('signed_out', 'You\'re signed out at ' + who + ', and it only sells to signed-in customers — sign in there, then try again.', 'needs_you');
          return 'error';
        }
      } else if (flow.stage === 'to-checkout') {
        // On the way to checkout, and the store opened its bag instead: with the item in it, its
        // Checkout button; empty, the add didn't go through — back to the product to press Add once
        // more, or say so.
        // (Somewhere else — a sign-in page on the way, say: checkout's own steps take it from here, as before.)
        if (!onBagPage(R)) { store.clear(); return 'checkout'; }
        if (onBagPage(R)) {
          var fromBag = findCheckout(R, true) || findCheckout(R, false);
          if (fromBag) return goCheckout(fromBag);
          if (Date.now() - arrived > 4000) {
            var gone = emptyBag(flow, 'Opened checkout');
            if (gone) return gone;
            store.clear();
            setStatus("Couldn't find the Checkout button on your bag page. Continue yourself.");
            report('error', 'The store opened its bag instead of checkout, with no Checkout button', product);
            why('no_checkout');
            return 'error';
          }
        }
      } else if (flow.stage === 'add-again') {
        // Back on the product page after an empty bag: press Add once more (then as before).
        var again2 = await waitForEl(function () { skipUpsell(); return findAddToBag(R); }, (opts.waitForButtonMs || part(R, 'product').waitMs || 12000));
        if (!again2) {
          store.clear();
          setStatus("Add to bag isn't available any more — sold out, or the page is still loading.");
          report('error', 'Add button not available', product);
          why('sold_out');
          return 'error';
        }
        again2 = await whenReady(R, again2, opts.probe, setStatus);
        store.save(Object.assign({}, flow, { stage: 'add-clicked', clickedAt: Date.now(), countBefore: bagCount(), added: false, said: '' }));
        setStatus('Adding to your bag again…');
        pressAdd(page, again2);
        report('add', 'Pressed "' + textOf(again2).slice(0, 40) + '" again', product);
      } else if (flow.stage === 'cart-link') {
        // The cart link opened the cart instead of checkout (e.g. the store wants you to look first).
        if (onBagPage(R)) return checkoutFromBag();
        // Somewhere else (the product page again, say — the link's option has gone): its Add button, as for any store.
        if (Date.now() - arrived > NO_ROUTE_MS) {
          var add2 = findAddToBag(R);
          if (!add2) {
            store.clear();
            setStatus("The store's cart link didn't open checkout, and there's no Add button here. Continue yourself.");
            report('error', "The store's cart link didn't open checkout", product);
            why('no_checkout');
            return 'error';
          }
          add2 = await whenReady(R, add2, opts.probe, setStatus);
          store.save(Object.assign({}, flow, { stage: 'add-clicked', clickedAt: Date.now(), countBefore: bagCount(), productUrl: location.href.split('#')[0] }));
          setStatus('Adding to your bag…');
          pressAdd(page, add2);
          report('add', 'The cart link didn\'t open checkout — pressed "' + textOf(add2).slice(0, 40) + '"', product);
        }
      } else if (flow.stage === 'add-clicked') {
        var since = Date.now() - (flow.clickedAt || flow.startedAt);
        // The store's "added" popup, with its own Checkout button (one that wasn't there before the press).
        var popup = since > 200 ? findCheckout(R, true, page.before) : null;
        if (popup) return openCheckout(popup, flow);
        if (onBagPage(R)) {
          // The store opened its bag by itself after adding.
          store.save(Object.assign({}, flow, { stage: 'bag-clicked', bagAt: Date.now() }));
          continue;
        }
        // Anything the store says after the press (an error, a pop-up) — kept, for "why it wasn't added".
        var said = flow.added ? '' : pageSays();
        if (said && said !== page.saidBefore && said !== flow.said) { flow = Object.assign({}, flow, { said: said }); store.save(flow); }
        // The store turned the add away (its cart answered with an error — Kmart's can, for a visitor
        // whose page is still starting up): once the page has finished loading, press Add once more.
        // Turned away again: say so, with what the store answered.
        var refused = flow.added ? 0 : cartRequestFailed(flow.clickedAt);
        if (refused) {
          var again3 = flow.retried ? null : findAddToBag(R);
          if (!again3) return notAdded(flow.said || '', refused);
          setStatus('The store turned the add away (HTTP ' + refused + ') — pressing "' + textOf(again3).slice(0, 30) + '" again once the page has loaded…');
          report('add', 'The store turned the add away (HTTP ' + refused + ') — pressing "' + textOf(again3).slice(0, 40) + '" again once its page had loaded', product);
          await untilLoaded(R);
          again3 = findAddToBag(R) || again3;
          flow = Object.assign({}, flow, { retried: true, clickedAt: Date.now(), refused: refused });
          store.save(flow);
          pressAdd(page, again3);
          await wait(POLL_MS);
          continue;
        }
        // Only leave the page once the store shows it was added: its bag count went up, an
        // "Added to bag" message, or (where no count shows) its cart answered the add. Leaving
        // sooner can leave the page before the add finishes.
        var count = bagCount();
        var went = count != null && (flow.countBefore == null ? count > 0 : count > flow.countBefore);
        if (!flow.added && (went || addedMessage(R) || (count == null && cartRequestDone(flow.clickedAt)))) {
          flow = Object.assign({}, flow, { added: true, addedAt: Date.now() });
          store.save(flow);
          setStatus('Added — going to checkout…');
        }
        // Nothing on the page reacted to the press (we watched it), or the count didn't move.
        var ignored = !!page.watch && page.watch.changes() === 0 && since > QUIET_MS;
        var unmoved = count != null && flow.countBefore != null && count === flow.countBefore && since > CONFIRM_MS;
        // The bag link's number didn't move, but the store's cart answered the add (some stores only update
        // it on the next page): on to checkout — not Add again, which would put a second one in. (Its bag
        // turning out empty there: back for Add once more, as ever.)
        var answered = count != null && flow.countBefore != null && count === flow.countBefore && since > ANSWERED_MS && cartRequestDone(flow.clickedAt);
        if (!flow.added && answered) {
          flow = Object.assign({}, flow, { added: true, addedAt: Date.now() });
          store.save(flow);
          setStatus('Added — going to checkout…');
          report('add', 'The store\'s cart took it (its bag count didn\'t change on this page) — going to checkout', product);
          continue;
        }
        if (flow.added || (!ignored && !unmoved && since > CONFIRM_MS)) {
          if (C.url) return openCheckout(null, flow);
          // No checkout page to go to: the "added" popup's Checkout button (a moment for it to show), else the bag.
          var waited = flow.addedAt ? Date.now() - flow.addedAt : since;
          var bag = waited > 400 ? findBag(R) : null;
          if (bag) {
            store.save(Object.assign({}, flow, { stage: 'bag-clicked', bagAt: Date.now() }));
            setStatus('Opening your bag…');
            report('basket', 'Opening the bag', product);
            bag.click();
          } else if (waited > NO_ROUTE_MS && !leaving) {
            // Neither an "added" pop-up with a Checkout button nor a bag link Mugibot knows: the bag page itself.
            store.save(Object.assign({}, flow, { stage: 'bag-clicked', bagAt: Date.now(), bagUrlTried: true }));
            setStatus('Added — opening your bag…');
            report('basket', 'Opening the bag page (no bag link Mugibot knows on this page)', product);
            location.assign(bagUrl(R));
            return 'navigating';
          }
        } else if (ignored || unmoved) {
          var again = flow.retried ? null : findAddToBag(R);
          if (!again) return notAdded(flow.said || '');
          // The first press came before the page was ready: press once more.
          store.save(Object.assign({}, flow, { retried: true, clickedAt: Date.now() }));
          setStatus('The page wasn\'t ready — pressing "' + textOf(again).slice(0, 30) + '" again…');
          report('add', 'Pressed "' + textOf(again).slice(0, 40) + '" again (the page wasn\'t ready)', product);
          pressAdd(page, again);
        }
      } else if (flow.stage === 'bag-clicked') {
        // A bag drawer the general rules don't recognise: after a moment, any Checkout button will do.
        var late = Date.now() - (flow.bagAt || 0) > 1500;
        var checkout = findCheckout(R, true) || (onBagPage(R) || late ? findCheckout(R, false) : null);
        if (checkout) return goCheckout(checkout);
        // The bag page, empty: the add didn't go through.
        if (onBagPage(R) && Date.now() - arrived > BAG_MS) {
          var empty2 = emptyBag(flow, 'Opened the bag');
          if (empty2) return empty2;
          // The item's in the bag, but no Checkout button Mugibot knows: the store's checkout page, once —
          // or a link on the page that goes there — else it says so now (nothing more will show up).
          if (C.url && !flow.urlTried) {
            store.save(Object.assign({}, flow, { stage: 'to-checkout', urlTried: true, leftAt: Date.now() }));
            setStatus('Opening checkout…');
            report('checkout', 'Opening checkout (no Checkout button on the bag page)', product);
            location.assign(storePath(R, C.url));
            return 'navigating';
          }
          var link = checkoutLink(R);
          if (link) {
            report('checkout', 'Opening checkout (its link on the bag page)', product);
            return goCheckout(link);
          }
          store.clear();
          setStatus("Couldn't find the Checkout button on your bag page. Continue yourself.");
          report('error', 'The bag page had no Checkout button Mugibot knows', product);
          why('no_checkout');
          return 'error';
        }
        // A bag drawer with no Checkout button Mugibot knows, a while on: the bag page itself, once.
        if (!onBagPage(R) && !leaving && Date.now() - (flow.bagAt || 0) > NO_ROUTE_MS + 3500 && !flow.bagUrlTried) {
          store.save(Object.assign({}, flow, { stage: 'bag-clicked', bagUrlTried: true, bagAt: Date.now() }));
          setStatus('Opening your bag…');
          report('basket', 'Opening the bag page (no Checkout button in its drawer)', product);
          location.assign(bagUrl(R));
          return 'navigating';
        }
      }
      await wait(POLL_MS);
    }
    store.clear();
    setStatus("Checkout button wasn't found in time. Open your bag and continue yourself.");
    report('error', 'Checkout button not found in time', product);
    why('no_checkout');
    return 'timeout';
  }

  // --------------------------------------------------------------------------
  // The panel — small, top-left, draggable
  // --------------------------------------------------------------------------
  var POS_KEY = 'mgbPanelPos';
  var COLLAPSED_KEY = 'mgbPanelCollapsed';
  var FLOW_LABEL = { verified: 'verified flow', beta: 'beta flow', draft: 'draft flow — untested' };

  function smallButton(label, primary) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, {
      padding: primary ? '6px 8px' : '4px 7px', border: primary ? '0' : '1px solid #d4d7dd', borderRadius: '6px',
      background: primary ? '#3b2a7a' : '#f5f6f8', color: primary ? '#fff' : '#172033', cursor: 'pointer',
      font: 'inherit', fontWeight: primary ? '700' : '500', lineHeight: '1.2', margin: '0',
    });
    return b;
  }

  function readPos() {
    try {
      var p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (p && typeof p.left === 'number' && typeof p.top === 'number') return p;
    } catch (e) { /* ignore */ }
    return { left: 12, top: 12 };
  }

  /**
   * opts: { retailer, products, startLabel, onStart(), onStop(), note }
   * Returns { setStatus, setNote, setProducts, startButton, el }.
   */
  function makePanel(opts) {
    var R = opts.retailer || null;
    var old = document.getElementById(PANEL_ID);
    if (old) old.remove();
    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    var pos = readPos();
    Object.assign(panel.style, {
      position: 'fixed', left: pos.left + 'px', top: pos.top + 'px', width: '232px', maxHeight: '70vh', overflowY: 'auto',
      padding: '8px 10px', background: '#fff', color: '#172033', border: '1px solid #c9ccd3', borderRadius: '10px',
      boxShadow: '0 2px 12px rgba(0,0,0,.18)', zIndex: '2147483647', font: '12.5px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif',
      textAlign: 'left', boxSizing: 'border-box',
    });

    var head = document.createElement('div');
    Object.assign(head.style, { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'move', userSelect: 'none' });
    var title = document.createElement('strong');
    title.textContent = '⚡ Mugibot';
    title.style.flex = '1';
    var min = smallButton('–');
    min.title = 'Minimise';
    head.append(title, min);

    var body = document.createElement('div');
    var flowTag = document.createElement('div');
    Object.assign(flowTag.style, { marginTop: '3px', fontSize: '11px', color: R && R.flowStatus === 'verified' ? '#15803d' : '#b45309' });
    flowTag.textContent = R ? R.name + ' · ' + (FLOW_LABEL[R.flowStatus] || 'flow') : '';
    var info = document.createElement('div');
    Object.assign(info.style, { marginTop: '5px', fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
    var status = document.createElement('div');
    Object.assign(status.style, { marginTop: '3px', color: '#3d4655' });
    status.textContent = 'Ready.';
    var row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '6px', marginTop: '6px' });
    var start = smallButton(opts.startLabel || 'Add to bag → Checkout', true);
    start.style.flex = '1';
    start.style.whiteSpace = 'nowrap';
    var stop = smallButton('✕');
    stop.title = 'Stop';
    stop.setAttribute('aria-label', 'Stop');
    row.append(start, stop);
    var note = document.createElement('div');
    Object.assign(note.style, { marginTop: '5px', fontSize: '11px', color: '#6b7380' });
    var warn = document.createElement('div');
    Object.assign(warn.style, { marginTop: '5px', fontSize: '11px', color: '#b45309' });
    var toggle = document.createElement('a');
    toggle.href = '#';
    Object.assign(toggle.style, { display: 'inline-block', marginTop: '5px', fontSize: '11px', color: '#4c3bb3', textDecoration: 'none' });
    var list = document.createElement('div');
    list.style.display = 'none';
    body.append(flowTag, info, status, row, note, warn, toggle, list);
    panel.append(head, body);

    var products = opts.products || [];
    function renderProducts() {
      var cur = productForPage(products, R);
      info.textContent = cur ? cur.name + ' · SKU ' + cur.sku
        : onBagPage(R) ? 'Your bag' : onCheckoutPage(R) ? 'Checkout' : 'Open one of your SKUs';
      info.title = info.textContent;
      // This store's SKUs first.
      var shown = products.filter(function (p) { return p.url; }).sort(function (a, b) { return (b.store === (R && R.id)) - (a.store === (R && R.id)); });
      toggle.textContent = (list.style.display === 'none' ? '▸ ' : '▾ ') + 'Your SKUs (' + shown.length + ')';
      toggle.style.display = shown.length ? '' : 'none';
      list.textContent = '';
      shown.forEach(function (p, i) {
        var price = typeof p.price === 'number' ? ' — $' + p.price : '';
        var b = smallButton((i + 1) + '. ' + p.name + price);
        Object.assign(b.style, { display: 'block', width: '100%', marginTop: '4px', textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
        if (cur && cur.id === p.id) b.style.borderColor = '#3b2a7a';
        b.title = (p.storeName || p.store) + ' · SKU ' + p.sku;
        b.addEventListener('click', function () { window.open(p.url, '_blank', 'noopener'); });
        list.appendChild(b);
      });
    }
    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      list.style.display = list.style.display === 'none' ? '' : 'none';
      renderProducts();
    });

    function setNote(t) {
      note.textContent = t || '';
      note.style.display = t ? '' : 'none';
    }
    setNote(opts.note || '');
    function checkOthers() {
      var other = otherPanelPresent();
      warn.textContent = other ? 'Another quick-checkout tool (TCGBot, TCGCopBot or Tampermonkey?) is also on this page — turn it off so items aren\'t added twice.' : '';
      warn.style.display = other ? '' : 'none';
    }
    checkOthers();
    setTimeout(checkOthers, 2500); // other scripts may add their panel a little later

    var collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSED_KEY) === '1'; } catch (e) { /* ignore */ }
    function applyCollapsed() {
      body.style.display = collapsed ? 'none' : '';
      min.textContent = collapsed ? '+' : '–';
      panel.style.width = collapsed ? 'auto' : '232px';
    }
    min.addEventListener('click', function () {
      collapsed = !collapsed;
      try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
      applyCollapsed();
    });

    // Drag by the title bar; remembered per site.
    head.addEventListener('mousedown', function (e) {
      if (e.target === min) return;
      e.preventDefault();
      var startX = e.clientX;
      var startY = e.clientY;
      var r = panel.getBoundingClientRect();
      function move(ev) {
        var left = Math.max(0, Math.min(window.innerWidth - 60, r.left + ev.clientX - startX));
        var top = Math.max(0, Math.min(window.innerHeight - 30, r.top + ev.clientY - startY));
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.right = '';
        panel.style.bottom = '';
      }
      function up() {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        try { localStorage.setItem(POS_KEY, JSON.stringify({ left: parseInt(panel.style.left, 10), top: parseInt(panel.style.top, 10) })); } catch (e2) { /* ignore */ }
      }
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });

    // Only real clicks count — a web page can't press these buttons for you.
    start.addEventListener('click', function (e) { if (e.isTrusted && opts.onStart) opts.onStart(); });
    stop.addEventListener('click', function (e) { if (e.isTrusted && opts.onStop) opts.onStop(); });

    renderProducts();
    applyCollapsed();
    document.body.appendChild(panel);
    return {
      el: panel,
      startButton: start,
      setStatus: function (t) { status.textContent = t; },
      setNote: setNote,
      setProducts: function (p) { products = p || []; renderProducts(); },
      // Out of the way (bottom right), for a page you need yourself — a store's human check — without moving it for good.
      moveAside: function () { Object.assign(panel.style, { left: 'auto', top: 'auto', right: '12px', bottom: '12px' }); },
    };
  }

  /** Progress kept in the tab's sessionStorage, so it survives page changes. */
  function sessionStore(key) {
    return {
      read: function () { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (e) { return null; } },
      save: function (flow) { try { sessionStorage.setItem(key, JSON.stringify(flow)); } catch (e) { /* ignore */ } },
      clear: function () { try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ } },
    };
  }

  return {
    PANEL_ID: PANEL_ID,
    FINAL: FINAL,
    findAddToBag: findAddToBag,
    findUpsellClose: findUpsellClose,
    dismissUpsell: dismissUpsell,
    findCheckout: findCheckout,
    findBag: findBag,
    bagCount: bagCount,
    onCheckoutPage: onCheckoutPage,
    onBagPage: onBagPage,
    productForPage: productForPage,
    run: run,
    makePanel: makePanel,
    sessionStore: sessionStore,
  };
})();
