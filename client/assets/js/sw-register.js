/* Service-worker registration + auto-reload on update.
 * External (not inline) so the Content-Security-Policy can forbid inline scripts. */
(function () {
  if (!('serviceWorker' in navigator)) return;
  var refreshing = false;
  // when a new service worker takes control (new build), reload once to pick it up
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  });
})();
