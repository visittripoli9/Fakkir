/* Set the theme before first paint: explicit saved choice, else follow the device.
 * External (not inline) so the Content-Security-Policy can forbid inline scripts. */
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t !== 'dark' && t !== 'light') {
      t = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    var apply = function () { if (document.body) document.body.dataset.theme = t; };
    apply();
    if (!document.body) document.addEventListener('DOMContentLoaded', apply);
  } catch (e) {}
})();
