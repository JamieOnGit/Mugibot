/* Mugibot — Clear cart, on a store's bag page (server/bags.js, docs/AUTO-CHECKOUT.md).

   Pressed on your dashboard, Clear cart has your checkout browser open the store's bag in a tab of its
   own, and this empties it the way you would: each thing in it, the store's own Remove (or Delete, or
   its bin or ×) pressed one at a time, and the store's "Are you sure?" answered yes. Then the bag is
   opened once more, to check it's empty. Shopify stores: the store's own "empty the cart" (its
   /cart/clear.js, what its cart page's code uses), checked the same way.

   Nothing else on the page is pressed — not "Save for later", nor "Undo", nor a promo code's or gift
   card's remove, nor anything in a "Saved for later" or wish list (Amazon's is right under its cart).
   Progress is kept in the tab: a store whose Remove opens a new page carries on there. */

var MGBBag = (function () {
  'use strict';

  var Q = MGBQuick.helpers;
  var wait = MGBFlows.wait;
  var part = MGBFlows.part;
  var any = MGBFlows.any;
  var KEY = 'mgbClear';
  var MAX_PRESSES = 40;
  var MAX_MS = 75000;
  // After a press: how long the store has to take the thing out (or ask "Are you sure?").
  var PRESS_MS = 8000;

  // A line's own Remove: its words ("Remove", "Delete", "Remove item", "Remove from cart")…
  var WORDS = /^(remove|delete)( (this )?(item|product|line))?( from (your |my )?(shopping )?(bag|cart|basket|trolley))?$/i;
  // …what it's called for a screen reader ("Remove Pokémon TCG … from cart", "Delete item")…
  var NAMED = /^(remove|delete)\b/i;
  // …or an icon (×, a bin) the store marks as one.
  var ICON = /remove|delete|trash|(^|[\s_-])bin([\s_-]|$)/i;
  // The whole bag at once ("Remove all", "Empty cart"): pressed first, where there's one.
  var ALL = /^((remove|delete|clear) all( items)?|(empty|clear) (your |my |the )?(shopping )?(bag|cart|basket|trolley))$/i;
  // Never pressed: a promo code's or gift card's remove, "Save for later", "Undo"…
  var NOT_LINE = /^(remove|delete) (the |this |your )?(promo(tion)?|coupon|voucher|discount|gift ?card|code|offer|address)\b|save (it )?for later|move to (wish ?list|saved)|\bundo\b|wish ?list/i;
  var NOT_HERE = '[class*="promo" i], [id*="promo" i], [class*="coupon" i], [id*="coupon" i], [class*="voucher" i], [class*="discount" i], [class*="gift-card" i], [class*="giftcard" i]';
  // …nor anything in the saved-for-later or wish list beside the bag, nor "you may also like".
  var OTHER_LIST = '[id*="saved" i], [class*="saved-for-later" i], [class*="savedforlater" i], [class*="save-for-later" i], [id*="save-for-later" i], [data-name*="saved" i], [class*="wishlist" i], [id*="wishlist" i], [class*="wish-list" i]';
  var RECOMMENDATIONS = '[class*="recommend" i], [id*="recommend" i], [class*="carousel" i], [class*="related" i], [class*="upsell" i], [class*="also-like" i]';
  // The store's "Are you sure?" after Remove: its yes.
  var YES = /^(yes|ok|okay|confirm|continue|remove|delete|yes,? (remove|delete)( (it|item|this item|product|this product))?|(remove|delete) (it|item|this item|product|this product)|yes,? i'?m sure)$/i;
  var ASKS = /are you sure|sure you want|\bconfirm\b|\b(remove|delete)\b[^?]{0,120}\?/i;
  var POPUP = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="confirm" i], [class*="dialog" i]';
  var NOT_FOUND = /page not found|\b404\b|can.?t (find|be found) (that|this|the) page|page (doesn.?t|does not) exist/i;
  // The store saying your bag's empty, anywhere on the page — its bag page, or a pop-up over the page it sent
  // the tab to instead (EB Games: "Oh no! currently your cart is empty.", over its home page).
  var EMPTY_SAID = /\b(bag|cart|basket|trolley) is (currently |now )?empty\b|\bno (items|products) in (your )?(shopping )?(bag|cart|basket|trolley)\b|\bnothing in (your )?(shopping )?(bag|cart|basket|trolley)\b|\byour (shopping )?(bag|cart|basket|trolley) (is )?empty\b/i;

  function read(id) {
    try { var p = JSON.parse(sessionStorage.getItem(KEY) || 'null'); return p && p.id === id ? p : null; } catch (e) { return null; }
  }
  function save(p) { try { sessionStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* ignore */ } }
  function forget() { try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } }

  function pressables(root) {
    return Q.toArray((root || document).querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"], input[type="image"]'))
      .filter(function (el) { return !Q.inAnyPanel(el) && Q.isVisible(el) && !Q.isDisabled(el); });
  }

  function visiblePops() {
    return Q.toArray(document.querySelectorAll(POPUP)).filter(function (el) { return !Q.inAnyPanel(el) && Q.isVisible(el); });
  }

  /** A pop-up asking "Are you sure?" (its own Remove is its yes, not a line's). */
  function asking(pop) {
    return ASKS.test((pop.innerText || '').slice(0, 800));
  }

  function aside(R, el) {
    return !!(el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]') || el.closest(OTHER_LIST) || promoBox(R, el) || el.closest(RECOMMENDATIONS));
  }

  /** A link to one of the store's products. */
  function productLink(R, a) {
    var re = R && R.productPath;
    if (!re || !re.test) return false;
    try { return re.test(new URL(a.getAttribute('href'), location.href).pathname); } catch (e) { return false; }
  }

  /**
   * A promo code's, discount's or gift card's box — not a line of the bag, which links to its product
   * (a line marked "has a discount" is still a line: its Remove is pressed).
   */
  function promoBox(R, el) {
    var box = el.closest(NOT_HERE);
    return !!box && !Q.toArray(box.querySelectorAll('a[href]')).some(function (a) { return productLink(R, a); });
  }

  /** What the store calls a control in its own markup: its class, id, name, data-action, link. */
  function marks(el) {
    var cls = el.className && typeof el.className === 'object' ? el.className.baseVal : el.className;
    return [cls, el.id, el.getAttribute('name'), el.getAttribute('data-action'), el.getAttribute('data-testid'), el.getAttribute('data-test'), el.getAttribute('href')].filter(Boolean).join(' ');
  }

  function scopeOf(R) {
    var C = part(R, 'bag').clear || {};
    return (C.scope && document.querySelector(C.scope)) || document;
  }

  /** Is this one of the bag's Remove buttons (a line's — or, all: the whole bag's)? */
  function isRemove(R, el, all) {
    var parts = Q.labelParts(el);
    if (parts.some(function (t) { return NOT_LINE.test(t); })) return false;
    var text = Q.textOf(el);
    if (all) return ALL.test(text);
    if (ALL.test(text)) return false;
    var mine = part(R, 'bag').clear && part(R, 'bag').clear.remove;
    if (mine && mine.length && parts.some(function (t) { return any(mine, t); })) return true;
    if (WORDS.test(text)) return true;
    if (parts.some(function (t) { return t.length < 160 && NAMED.test(t); })) return true;
    // An icon with no words (×, a bin): the store's own name for it.
    if (text.length <= 2 && ICON.test(marks(el))) return true;
    // Shopify's link that sets the line to none.
    var href = el.getAttribute('href') || '';
    return /\/cart\/change\b/.test(href) && /[?&]quantity=0(&|$)/.test(href);
  }

  function find(R, all) {
    var asks = visiblePops().filter(asking);
    return pressables(scopeOf(R)).filter(function (el) {
      if (aside(R, el) || asks.some(function (p) { return p.contains(el); })) return false;
      return isRemove(R, el, all);
    });
  }
  var removes = function (R) { return find(R, false); };
  var removeAll = function (R) { return find(R, true)[0] || null; };

  /** The store's "Are you sure?" that came up after a press (not one showing before): its yes. */
  function yesButton(before, pressed) {
    var pops = visiblePops().filter(function (p) { return before.indexOf(p) === -1 && asking(p); });
    for (var i = 0; i < pops.length; i++) {
      var yes = pressables(pops[i]).find(function (b) { return b !== pressed && YES.test(Q.textOf(b)); });
      if (yes) return yes;
    }
    return null;
  }

  /** The thing a Remove is for, by name ("Pokémon TCG …"), for the panel. */
  function lineName(el) {
    var row = el.closest('li, tr, article, [class*="line" i], [class*="item" i], [class*="product" i]');
    var a = row && Q.toArray(row.querySelectorAll('a[href]')).find(function (x) { return !/remove|change|delete/i.test(x.getAttribute('href') || '') && (x.innerText || '').trim(); });
    var t = (a && a.innerText) || '';
    if (!t) {
      var named = Q.labelParts(el).find(function (x) { return NAMED.test(x) && x.length > 10; });
      if (named) t = named.replace(/^(remove|delete)\s+(product\s+)?/i, '').replace(/\s+from (your |my )?(shopping )?(bag|cart|basket|trolley)$/i, '');
    }
    t = t.trim().replace(/\s+/g, ' ');
    return t ? '"' + t.slice(0, 60) + '"' : '';
  }

  /** The store's products still listed on the page (not "you may also like"): how many. */
  function productLines(R) {
    return Q.toArray(scopeOf(R).querySelectorAll('a[href]')).filter(function (a) { return Q.isVisible(a) && !aside(R, a) && productLink(R, a); }).length;
  }

  /** The page says the bag's empty, in a line of its own anywhere that shows (not the header's mini-bag while it's hidden). */
  function emptyShown() {
    var els = document.querySelectorAll('h1, h2, h3, h4, p, span, div, strong, b, li, section, [role="dialog"], [role="alert"], [role="status"]');
    for (var i = 0; i < els.length && i < 5000; i++) {
      var el = els[i];
      var t = String(el.innerText || el.textContent || '');
      if (t.length > 240 || !EMPTY_SAID.test(t) || Q.inAnyPanel(el) || !Q.isVisible(el)) continue;
      // (A button or link's words — "Empty cart", "Empty your bag" — are something to press, not the bag saying so.)
      if (el.closest('button, a, [role="button"], label, select, option')) continue;
      // (Its own words — not a whole page that happens to hold them, nor "you may also like".)
      if (el.closest(RECOMMENDATIONS) || el.closest(OTHER_LIST)) continue;
      return true;
    }
    return false;
  }

  /** Nothing in the bag: the page says so, or its count says 0 — or, with neither, none of the store's products on it. */
  function empty(R) {
    if (Q.bagLooksEmpty({ drawer: true }) || emptyShown()) return true;
    var c = MGBQuick.bagCount();
    if (c === 0) return true;
    if (c > 0) return false;
    return !removes(R).length && !productLines(R);
  }

  /** A page not found (the store's answer, or its words). */
  function notFound() {
    var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    if (nav && nav.responseStatus >= 400) return true;
    var h1 = document.querySelector('h1');
    return NOT_FOUND.test(document.title + ' ' + ((h1 && h1.innerText) || ''));
  }

  /** The store's bag page (not a page not found, nor somewhere it sent the tab instead). */
  function onBag(R) {
    // (Or its cart open in a pop-up over another page: EB Games' cart opens over its home page.)
    return !notFound() && (MGBQuick.onBagPage(R) || removes(R).length > 0 || !!MGBQuick.bagDrawer());
  }

  /** The store's own link to its bag (in its header), when the address Mugibot knows isn't it. */
  function bagLink(R) {
    var re = part(R, 'bag').path || /\/(cart|bag|basket|trolley)(\/|$)/i;
    var a = Q.toArray(document.querySelectorAll('a[href]')).find(function (x) {
      try {
        var u = new URL(x.getAttribute('href'), location.href);
        return u.host === location.host && re.test(u.pathname) && u.pathname !== location.pathname && !/remove|change|add|delete|update|clear/i.test(u.pathname + u.search);
      } catch (e) { return false; }
    });
    return a ? new URL(a.getAttribute('href'), location.href).href : null;
  }

  /** A quantity drop-down with a 0 in it (Amazon's "0 (Delete)"), for a line with no Remove Mugibot knows. */
  function zeroQty(R) {
    return Q.toArray(scopeOf(R).querySelectorAll('select')).find(function (s) {
      return Q.isVisible(s) && !s.disabled && !aside(R, s) && s.value !== '0' && Q.toArray(s.options).some(function (o) { return o.value === '0'; });
    }) || null;
  }

  /** Until the page has loaded — and, a page drawn by its own code, its lines (or its "empty") are there. */
  async function settled(R) {
    for (var end = Date.now() + 10000; document.readyState !== 'complete' && Date.now() < end;) await wait(100);
    for (var until = Date.now() + 6000; Date.now() < until;) {
      if (notFound() || removes(R).length || removeAll(R) || Q.bagLooksEmpty({ drawer: true }) || emptyShown() || MGBQuick.bagCount() === 0) return;
      await wait(200);
    }
  }

  /** Shopify: the store's own cart, emptied at once. How many things it had (0: none), or null (it can't here). */
  async function shopifyEmpty(R) {
    var cart = function () {
      return fetch(Q.storePath(R, '/cart.js'), { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; });
    };
    try {
      var before = await cart();
      if (!before || typeof before.item_count !== 'number') return null;
      if (!before.item_count) return 0;
      var r = await fetch(Q.storePath(R, '/cart/clear.js'), { method: 'POST', credentials: 'include', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{}' });
      if (!r.ok) return null;
      var after = await cart();
      return after && after.item_count === 0 ? before.item_count : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * After a press: the thing's gone ('gone'), the page is on its way to a new one ('leaving'), or nothing
   * happened ('nothing'). The store's "Are you sure?" is answered yes on the way.
   */
  async function afterPress(el, pops, moved, leaving) {
    var asked = false;
    var seen = 0;
    for (var end = Date.now() + PRESS_MS; Date.now() < end;) {
      await wait(150);
      if (leaving()) return 'leaving';
      if (!asked) {
        var yes = yesButton(pops, el);
        if (yes) { asked = true; yes.click(); end = Date.now() + PRESS_MS; continue; }
      }
      // (Twice in a row: a list being drawn again can look shorter for a moment.)
      if (moved()) { if (++seen >= 2) return 'gone'; } else seen = 0;
    }
    return leaving() ? 'leaving' : 'nothing';
  }

  /**
   * opts: { retailer, job: { id, store, storeName }, setStatus(text), report(status, removed, message),
   *   sayYes(): the page's own "Are you sure?" boxes (the browser's confirm()) answer yes in this tab }
   * Resolves to 'done' (how it went is reported) or 'navigating' (the next page carries on).
   */
  async function run(opts) {
    var R = opts.retailer;
    var job = opts.job;
    var name = (R && R.name) || 'the store';
    var setStatus = opts.setStatus || function () {};
    var p = read(job.id) || { id: job.id, removed: 0, items: null, startedAt: Date.now(), moved: false, checked: false, ajax: false, stuck: 0, pending: null };
    save(p);
    var gone = false;
    addEventListener('beforeunload', function () { gone = true; });
    var leaving = function () { return gone; };

    function finish(status, message) {
      forget();
      // (The bag's own count before, where it showed one — two of a thing are two items.)
      var n = status === 'cleared' ? Math.max(p.removed, p.items || 0) : p.removed;
      setStatus(status === 'cleared' ? '🧹 Emptied — ' + n + ' item' + (n === 1 ? '' : 's') + ' removed.'
        : status === 'empty' ? '🧹 Your bag here was already empty.' : '🧹 ' + message);
      return Promise.resolve(opts.report(status, n, message || '')).then(function () { return 'done'; });
    }
    function progress() { opts.report('clearing', p.removed, ''); }
    function reload(text) { save(p); setStatus(text); location.reload(); return 'navigating'; }

    if (Date.now() - p.startedAt > MAX_MS) return finish('failed', 'It took too long — have a look in this tab.');
    await opts.sayYes();
    setStatus('🧹 Emptying your ' + name + ' bag…');
    await settled(R);

    // A press that opened a new page (its Remove posts a form): did it take the thing out?
    if (p.pending) {
      var took = empty(R) ? p.pending.lines : Math.max(0, p.pending.lines - removes(R).length);
      if (took > 0) { p.removed += took; p.stuck = 0; progress(); } else p.stuck += 1;
      p.pending = null;
      save(p);
    }
    // Sent somewhere else, saying your bag's empty (EB Games' empty cart is a pop-up over its home page), or
    // its bag count at 0: it's empty — nothing to press. (A moment for a pop-up drawn by the page's own code.)
    if (!onBag(R)) {
      for (var late = Date.now() + 4000; Date.now() < late && !emptyShown() && MGBQuick.bagCount() !== 0;) await wait(250);
      if (!p.removed && (emptyShown() || MGBQuick.bagCount() === 0)) return finish('empty');
      if (p.removed && (emptyShown() || MGBQuick.bagCount() === 0)) return finish('cleared');
    }
    // Not the bag (a page not found, or somewhere else): the store's own bag link, once.
    if (!onBag(R)) {
      var link = !p.moved && bagLink(R);
      if (link) {
        p.moved = true;
        save(p);
        setStatus('🧹 Opening your bag from ' + name + "'s own link…");
        location.assign(link);
        return 'navigating';
      }
      return finish('failed', "Couldn't find your bag at " + name + ' (' + location.pathname + " isn't it).");
    }
    if (p.items == null && !p.removed) {
      var c0 = MGBQuick.bagCount();
      p.items = c0 > 0 ? c0 : 0;
      save(p);
    }
    // Shopify: the store's own "empty the cart" — then the bag looked at again.
    if (R && R.platform === 'shopify' && !p.ajax) {
      p.ajax = true;
      save(p);
      var had = await shopifyEmpty(R);
      if (had === 0 && empty(R)) return finish('empty');
      if (had > 0) {
        p.removed += had;
        p.items = Math.max(p.items || 0, had);
        p.checked = true;
        progress();
        return reload('🧹 Emptied — checking your bag…');
      }
      // (null: its cart can't be emptied that way here — its Remove buttons, below.)
    }

    var waited = false;
    for (var presses = 0; ;) {
      if (leaving()) return 'navigating';
      if (Date.now() - p.startedAt > MAX_MS) return finish('failed', 'It took too long — ' + p.removed + ' removed so far; have a look in this tab.');
      Q.dismissUpsell(R);
      var all = removeAll(R);
      var list = removes(R);
      var zero = !all && !list.length && !empty(R) ? zeroQty(R) : null;
      if (!all && !list.length && !zero) {
        // (The last press may still be on its way — a moment for the page to catch up, once.)
        if (empty(R) || waited) break;
        waited = true;
        for (var until = Date.now() + 5000; Date.now() < until && !empty(R) && !removes(R).length && !removeAll(R);) await wait(250);
        continue;
      }
      waited = false;
      if (p.stuck >= 2) return finish('failed', name + ' didn\'t take ' + (lineName(list[0] || all || zero) || 'it') + ' out when its Remove button was pressed — empty it yourself in this tab.');
      if (presses++ >= MAX_PRESSES) return finish('failed', 'Pressed Remove ' + MAX_PRESSES + " times and there's still more — have a look in this tab.");
      var el = all || list[0] || zero;
      setStatus('🧹 Removing ' + (all ? 'everything' : lineName(el) || 'the next thing') + '…');
      var pops = visiblePops();
      var lines = list.length;
      var count = MGBQuick.bagCount();
      var shown = productLines(R);
      // Gone: one Remove fewer (a line's own), or the bag's count down, or the page says it's empty — or
      // (the whole bag's button, a quantity set to 0) the control itself gone, or fewer of the store's products listed.
      var moved = function () {
        // (The pressed button greyed out — "Removing…": the store's still at it.)
        if (el.isConnected && Q.isVisible(el) && (Q.isDisabled(el) || el.getAttribute('aria-busy') === 'true')) return false;
        var c = MGBQuick.bagCount();
        if ((count != null && c != null && c < count) || Q.bagLooksEmpty({ drawer: true })) return true;
        if (!all && !zero) return removes(R).length < lines;
        return !el.isConnected || !Q.isVisible(el) || productLines(R) < shown;
      };
      p.pending = { lines: Math.max(lines, 1), at: Date.now() };
      save(p);
      if (zero) {
        zero.value = '0';
        zero.dispatchEvent(new Event('input', { bubbles: true }));
        zero.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.click();
      }
      var out = await afterPress(el, pops, moved, leaving);
      if (out === 'leaving') return 'navigating';
      p.pending = null;
      if (out === 'gone') {
        p.removed += Math.max(lines - removes(R).length, 1);
        p.stuck = 0;
        progress();
      } else {
        p.stuck += 1;
      }
      save(p);
    }
    // Nothing more to press: is it empty? (Emptied here: opened once more, to be sure it is.)
    if (empty(R)) {
      if (p.removed > 0 && !p.checked) { p.checked = true; return reload('🧹 Checking your bag is empty…'); }
      return finish(p.removed > 0 ? 'cleared' : 'empty');
    }
    return finish('failed', "There's still something in your " + name + " bag, and no Remove button Mugibot knows for it — empty it yourself in this tab.");
  }

  return { run: run, removes: removes, empty: empty };
})();
