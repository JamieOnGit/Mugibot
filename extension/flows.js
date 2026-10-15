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

  return { revive: revive, forLocation: forLocation, any: any, part: part, decodedPath: decodedPath };
})();
