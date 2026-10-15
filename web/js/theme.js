// Dark by default (the Monitor's look), or whatever you last picked with the ☀/☾ button.
// Loaded before the page is drawn, so there's no flash of the other theme.
(() => {
  let t = 'dark';
  try { t = localStorage.getItem('mgb-theme') || 'dark'; } catch { /* storage blocked */ }
  document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark';
})();
