// Mugibot — runs only on your Mugibot dashboard (the server in config.js).
// Lets the dashboard see that the extension is installed, which account it's
// connected to and whether a card is saved (brand and last 4 digits only),
// connect it with one click, and open the extension's card settings.

(() => {
  'use strict';
  if (window.top !== window.self) return;
  document.documentElement.setAttribute('data-mugibot-extension', chrome.runtime.getManifest().version);

  const ask = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? null : res)); } catch { resolve(null); }
  });

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== 'mugibot-app' || typeof d.type !== 'string') return;
    let reply = null;
    if (d.type === 'hello') reply = await ask({ type: 'appHello' });
    else if (d.type === 'pair' && typeof d.code === 'string') reply = await ask({ type: 'pair', code: d.code });
    else if (d.type === 'cardStatus') reply = await ask({ type: 'cardStatus' });
    else if (d.type === 'openCardSettings') reply = await ask({ type: 'openCardSettings' });
    else if (d.type === 'checkNow') reply = await ask({ type: 'checkNow' });
    else return;
    window.postMessage({ source: 'mugibot-ext', type: d.type, id: d.id, reply }, location.origin);
  });
})();
