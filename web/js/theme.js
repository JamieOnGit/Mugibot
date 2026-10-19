// Light by default (the bright card-table look), or whatever you last picked with the ☀/☾ button.
// (mgb-theme2: a pick from before the light look became the default — dark then — starts afresh.)
// Loaded before the page is drawn, so there's no flash of the other theme.
(() => {
  let t = 'light';
  try { t = localStorage.getItem('mgb-theme2') || 'light'; } catch { /* storage blocked */ }
  document.documentElement.dataset.theme = t === 'dark' ? 'dark' : 'light';
})();
