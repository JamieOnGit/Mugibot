// Mugibot — runs the moment a store page starts loading, before the store's
// own code. Grabs the one-time "⚡ Buy" code from the address
// (…#mgb-go=<code>) before the site can tidy the address up, and (in the
// Chrome Web Store copy) marks the page as handled by that copy.

(() => {
  'use strict';
  if (window.top !== window.self) return;
  // The Chrome Web Store copy marks the page, so a downloaded copy also installed in this browser stays out of the way.
  if (chrome.runtime.getManifest().update_url) document.documentElement.setAttribute('data-mugibot-store', chrome.runtime.getManifest().version);
  const m = location.hash.match(/mgb-go=([A-Za-z0-9_-]{8,64})/);
  if (!m) return;
  try {
    sessionStorage.setItem('mgbGoCode', JSON.stringify({ code: m[1], at: Date.now() }));
  } catch {
    /* storage blocked — content.js falls back to the address */
  }
  const rest = location.hash.replace(/&?mgb-go=[A-Za-z0-9_-]+/, '').replace(/^#&?/, '#');
  history.replaceState(history.state, '', location.pathname + location.search + (rest === '#' ? '' : rest));
})();
