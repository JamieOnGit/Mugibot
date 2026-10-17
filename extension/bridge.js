// Mugibot — runs only on your Mugibot dashboard (the server in config.js).
// Lets the dashboard see that the extension is installed, which account it's
// connected to and whether a card is saved (brand and last 4 digits only),
// connect it with one click, and open the extension's card settings.

(() => {
  'use strict';
  if (window.top !== window.self) return;
  const root = document.documentElement;
  const version = chrome.runtime.getManifest().version;
  // The Chrome Web Store copy (it updates itself) answers the dashboard. A downloaded copy
  // also installed in this browser stays quiet, and tells the dashboard it's there to remove.
  const fromStore = !!chrome.runtime.getManifest().update_url;
  if (fromStore) {
    root.setAttribute('data-mugibot-store', version);
    root.setAttribute('data-mugibot-extension', version);
  } else if (!root.hasAttribute('data-mugibot-store')) {
    root.setAttribute('data-mugibot-extension', version);
  }
  let told = null;
  const stepAside = () => {
    if (fromStore) return false;
    const there = root.hasAttribute('data-mugibot-store');
    if (there) root.setAttribute('data-mugibot-old-copy', version);
    if (told !== there) {
      told = there;
      try { chrome.runtime.sendMessage({ type: 'storeCopy', present: there }, () => void chrome.runtime.lastError); } catch { /* the extension was reloaded */ }
    }
    return there;
  };
  document.addEventListener('DOMContentLoaded', stepAside);

  const ask = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res)); } catch { resolve(null); }
  });

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== 'mugibot-app' || typeof d.type !== 'string') return;
    if (stepAside()) return;
    let reply = null;
    if (d.type === 'hello') reply = await ask({ type: 'appHello' });
    else if (d.type === 'pair' && typeof d.code === 'string') reply = await ask({ type: 'pair', code: d.code });
    else if (d.type === 'cardStatus') reply = await ask({ type: 'cardStatus' });
    else if (d.type === 'openCardSettings') reply = await ask({ type: 'openCardSettings' });
    else if (d.type === 'checkNow') reply = await ask({ type: 'checkNow' });
    else if (d.type === 'checkLogins') reply = await ask({ type: 'checkLogins' });
    else if (d.type === 'acoListen') reply = await ask({ type: 'acoListen' });
    else return;
    window.postMessage({ source: 'mugibot-ext', type: d.type, id: d.id, reply }, location.origin);
  });
})();
