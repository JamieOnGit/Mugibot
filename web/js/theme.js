// Dark by default (Mugibot 2.1: a drop bot's dashboard), or whatever you last picked with the ☀/☾ button.
// (mgb-theme3: picks from before the dark look became the default start afresh.)
// Loaded before the page is drawn, so there's no flash of the other theme.
(() => {
  let t = 'dark';
  try { t = localStorage.getItem('mgb-theme3') || 'dark'; } catch { /* storage blocked */ }
  document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark';
})();
