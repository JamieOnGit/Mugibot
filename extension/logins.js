/* Mugibot — the store login monitor: are you signed in at this store?

   Signed in at a store, ⚡ Buy's checkout is faster: the store fills in your
   saved address (and often your card) itself. Mugibot tells you where you
   aren't, so you can sign in before a drop.

   Two ways to tell, both read-only (nothing is clicked, nothing is typed):
   - A store whose pages say so (account.check in its file in server/retailers/):
     Shopify stores put the signed-in customer's number in every page, and so on.
     The background worker reads the store's page that way every 10 minutes,
     with your cookies, like opening it in a tab; the store-page script reads
     the page you have open.
   - Any other store: the page you have open. Its header shows a "Sign in"
     link while you're signed out, and "Hi, <name>" or "Sign out" once you're in.
   - Shop (account.check.onScreen): what's on the screen on Shop's checkout — your
     email, "Check out as guest" — never a page's source, and never fetched: Shop's
     pages are an app whose code carries "Sign in to your account" signed in or not.

   Used by the background worker (imported) and the store-page script. */

(function () {
  'use strict';

  function rx(v) {
    if (v instanceof RegExp) return v;
    if (v && typeof v.re === 'string') { try { return new RegExp(v.re, v.f || ''); } catch (e) { return null; } }
    return null;
  }

  /**
   * From a store's page (its HTML and address) and the store's account.check: 'in', 'out' or null.
   * check.signedInPage: the store's account page itself, when it doesn't say "signed out" (Shop's:
   * shop.app/account asks you to sign in there while you're signed out).
   */
  function fromHtml(html, url, check) {
    if (!check || check.onScreen) return null;
    var outUrl = rx(check.signedOutUrl);
    var signedIn = rx(check.signedIn);
    var signedOut = rx(check.signedOut);
    var inPage = rx(check.signedInPage);
    if (outUrl && outUrl.test(String(url || ''))) return 'out';
    if (signedIn && signedIn.test(html)) return 'in';
    if (signedOut && signedOut.test(html)) return 'out';
    if (inPage && inPage.test(html)) return 'in';
    return null;
  }

  // The header's account link: "Sign in", "Log in", "Sign in / Register", Amazon's "Hello, sign in"…
  var SIGN_IN = /^(sign ?in|log ?in|login)(\s*(\/|or|&|\|)\s*(register|join|sign ?up|create (an )?account))?$|^(hello|hi),? sign in$|^sign in or (create|register)\b/i;
  // …and once you're in: "Hi, Jamie", "Hello Jamie", "Sign out".
  var HI_NAME = /^(hi|hello|hey|welcome back),?\s+(?!(sign|log)\b|there\b|guest\b)[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'.\- ]{0,24}!?$/i;
  var SIGN_OUT = /^(sign|log) ?out$/i;

  function textOf(el) {
    return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var s = el.ownerDocument.defaultView.getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  var EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

  /**
   * What's on the screen, for a store whose pages' source can't be read for it (check.onScreen, Shop's):
   * on its page where (Shop's checkout), signed in when you can see both a short piece of text that's one
   * of in ("Check out as guest", offered beside your saved details) and, with email, an email address
   * (yours, by Shop's logo) — as a member's signed-in checkout showed them. 'in' or null — never 'out'
   * from a page.
   */
  function onScreen(doc, s) {
    var where = rx(s.where);
    if (where && !where.test(String(doc.location.pathname || ''))) return null;
    var ins = [].concat(s['in'] || []).map(rx).filter(Boolean);
    var sawIn = !ins.length;
    var sawEmail = !s.email;
    var els = doc.querySelectorAll('a, button, [role="button"], [role="link"], span, p, div, h1, h2, h3, h4, h5, h6');
    for (var i = 0; i < els.length && i < 5000 && !(sawIn && sawEmail); i++) {
      var el = els[i];
      if (el.children.length > 3 || el.closest('#mugibot-qc')) continue;
      var t = textOf(el);
      if (!t || t.length > 80) continue;
      var isIn = !sawIn && ins.some(function (re) { return re.test(t); });
      var isEmail = !sawEmail && EMAIL.test(t);
      if (!(isIn || isEmail) || !visible(el)) continue;
      if (isIn) sawIn = true;
      if (isEmail) sawEmail = true;
    }
    return sawIn && sawEmail ? 'in' : null;
  }

  /** From the page you have open: 'in', 'out' or null (can't tell). */
  function fromPage(doc, check) {
    if (check && check.onScreen) return onScreen(doc, check.onScreen);
    var known = fromHtml(doc.documentElement.outerHTML, doc.location.href, check);
    if (known) return known;
    var els = doc.querySelectorAll('header a, header button, [role="banner"] a, [role="banner"] button, nav a, nav button, '
      + '[class*="header" i] a, [class*="header" i] button, [id*="header" i] a, [id*="header" i] button, '
      + '[class*="account" i] a, [class*="account" i] button, a[href*="account" i], a[href*="login" i], a[href*="logout" i]');
    var signedIn = false;
    var signedOut = false;
    var tuckedAway = false;
    for (var i = 0; i < els.length && i < 400; i++) {
      var el = els[i];
      var text = textOf(el);
      var label = String(el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      if (text.length > 40) text = '';
      var shown = visible(el);
      if (SIGN_OUT.test(text) || SIGN_OUT.test(label)) {
        if (shown) signedIn = true;
        else tuckedAway = true; // in a closed account menu… or a page that hides one of the two
        continue;
      }
      if (!shown) continue;
      if (HI_NAME.test(text)) signedIn = true;
      else if (SIGN_IN.test(text) || SIGN_IN.test(label)) signedOut = true;
    }
    // A "Sign in" link you can see beats a "Sign out" tucked away (some pages carry both and hide one).
    return signedIn ? 'in' : signedOut ? 'out' : tuckedAway ? 'in' : null;
  }

  globalThis.MGBLogins = { fromHtml: fromHtml, fromPage: fromPage };
})();
