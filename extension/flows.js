/* Mugibot — retailer flows in the page.

   Each store's checkout flow comes from your Mugibot server (the files in
   server/retailers/): which buttons to press, where the bag and checkout
   are, which button is the final one. They arrive as JSON, so regular
   expressions travel as { re, f } and are rebuilt here. */

var MGBFlows = (function () {
  'use strict';

  function revive(v) {
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === 'object') {
      var keys = Object.keys(v);
      if (typeof v.re === 'string' && keys.every(function (k) { return k === 're' || k === 'f'; })) {
        try { return new RegExp(v.re, v.f || ''); } catch (e) { return null; }
      }
      var out = {};
      keys.forEach(function (k) { out[k] = revive(v[k]); });
      return out;
    }
    return v;
  }

  function decodedPath(loc) {
    try { return decodeURIComponent(loc.pathname); } catch (e) { return loc.pathname; }
  }

  /** The retailer whose flow applies to this page (by address, and path for the dummy store). */
  function forLocation(retailers, loc) {
    var host = String(loc.host || '').toLowerCase();
    var path = decodedPath(loc);
    return (retailers || []).find(function (r) {
      var hostOk = (r.hosts || []).some(function (h) { return host === h || host.slice(-(h.replace(/^www\./, '').length + 1)) === '.' + h.replace(/^www\./, ''); });
      return hostOk && (!r.pathPrefix || path === r.pathPrefix || path.indexOf(r.pathPrefix + '/') === 0);
    }) || null;
  }

  /** Does any of the patterns match the text? */
  function any(list, text) {
    return !!list && list.some(function (re) { return re && re.test && re.test(text); });
  }

  /** The flow section, or an empty object. */
  function part(retailer, name) {
    return (retailer && retailer.flow && retailer.flow[name]) || {};
  }

  // A store's own page (its menus, its products) has lots of links; a queue page has a handful. A store
  // page that mentions its queue (a banner about a launch) is still the store. (server/monitor/gate.js)
  var STORE_PAGE_LINKS = 40;
  var QUEUE_WORDS = /queue|in (the )?line|waiting room/i;

  /**
   * Is this page the store's checkpoint (JB Hi-Fi's hCaptcha page at /checkpoint) or its virtual
   * queue ("You're in the queue!")? → { kind: 'checkpoint' | 'queue', wait: minutes or null }, or
   * null. Read the same way as the server reads it (server/monitor/gate.js), from the open page —
   * cheaply: an ordinary page is never read word by word or laid out for it.
   */
  function gateHere(retailer, doc, loc) {
    var g = retailer && retailer.gate;
    if (!g || !g.page) return null;
    var p = g.page;
    var list = function (v) { return (Array.isArray(v) ? v : v ? [v] : []).filter(function (re) { return re && re.test; }); };
    var where = !!((p.path && p.path.test && p.path.test(decodedPath(loc))) || (p.url && p.url.test && p.url.test(String(loc.href || ''))));
    var html = function () { try { return doc.documentElement.outerHTML.slice(0, 2000000); } catch (e) { return ''; } };
    var markers = list(p.markers);
    var text = null;
    var words = function () {
      if (text === null) { try { text = String((doc.body && doc.body.innerText) || '').slice(0, 20000); } catch (e) { text = ''; } }
      return text;
    };
    if (g.kind === 'checkpoint') {
      // Its own address, with its check on it (a "not found" page there isn't one).
      if (!where) return null;
      if (markers.length) { var h = html(); if (!markers.some(function (re) { return re.test(h); })) return null; }
    } else {
      if (!where) {
        var raw = '';
        try { raw = String((doc.body && doc.body.textContent) || ''); } catch (e) { raw = ''; }
        if (!QUEUE_WORDS.test(raw) || !list(p.text).some(function (re) { return re.test(words()); })) return null;
      }
      if (doc.querySelectorAll('a[href]').length >= STORE_PAGE_LINKS) return null;
    }
    var m = p.wait && p.wait.test ? words().match(p.wait) : null;
    var wait = m ? Math.min(1440, Math.max(0, parseInt(m[1], 10))) : null;
    return { kind: g.kind, wait: isFinite(wait) ? wait : null };
  }

  /**
   * Wait a moment. In a tab in the background (another checkout of yours in front), the page's own
   * timers run at most about once a second, so a checkout there would crawl: its short waits are
   * timed by the extension's worker instead, which runs at full speed. (The page's own timer too,
   * whichever is first — in front, as ever.)
   */
  function wait(ms) {
    return new Promise(function (resolve) {
      var done = false;
      var fin = function () { if (!done) { done = true; resolve(); } };
      if (document.hidden && ms < 1000 && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        try { chrome.runtime.sendMessage({ type: 'sleep', ms: ms }, function () { void chrome.runtime.lastError; fin(); }); } catch (e) { /* the extension was updated */ }
      }
      setTimeout(fin, ms);
    });
  }

  return { revive: revive, forLocation: forLocation, any: any, part: part, decodedPath: decodedPath, gateHere: gateHere, wait: wait };
})();
