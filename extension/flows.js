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

  /**
   * Is this page the store's checkpoint (JB Hi-Fi's hCaptcha page at /checkpoint) or its virtual
   * queue ("You're in the queue!")? → { kind: 'checkpoint' | 'queue', wait: minutes or null }, or
   * null. Read the same way as the server reads it (server/monitor/gate.js), from the open page.
   */
  function gateHere(retailer, doc, loc) {
    var g = retailer && retailer.gate;
    if (!g || !g.page) return null;
    var p = g.page;
    var list = function (v) { return (Array.isArray(v) ? v : v ? [v] : []).filter(function (re) { return re && re.test; }); };
    var where = !!((p.path && p.path.test && p.path.test(decodedPath(loc))) || (p.url && p.url.test && p.url.test(String(loc.href || ''))));
    var text = '';
    try { text = String((doc.body && doc.body.innerText) || '').slice(0, 20000); } catch (e) { text = ''; }
    var html = function () { try { return doc.documentElement.outerHTML.slice(0, 2000000); } catch (e) { return ''; } };
    var markers = list(p.markers);
    if (g.kind === 'checkpoint') {
      // Its own address, with its check on it (a "not found" page there isn't one).
      if (!where) return null;
      if (markers.length) { var h = html(); if (!markers.some(function (re) { return re.test(h); })) return null; }
    } else if (!where && !list(p.text).some(function (re) { return re.test(text); })) {
      return null;
    }
    var m = p.wait && p.wait.test ? text.match(p.wait) : null;
    var wait = m ? Math.min(1440, Math.max(0, parseInt(m[1], 10))) : null;
    return { kind: g.kind, wait: isFinite(wait) ? wait : null };
  }

  return { revive: revive, forLocation: forLocation, any: any, part: part, decodedPath: decodedPath, gateHere: gateHere };
})();
