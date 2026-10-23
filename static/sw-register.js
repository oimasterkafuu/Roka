// Registration stays same-origin; the generated worker imports its pinned CDN implementation.
if ('serviceWorker' in navigator) {
  var scriptVersion = new URL(document.currentScript.src).searchParams.get('v') || 'local';
  function registerDeploymentWorker() {
    navigator.serviceWorker.register('/sw.js?v=' + encodeURIComponent(scriptVersion)).catch(function () {});
  }
  if (document.readyState === 'complete') registerDeploymentWorker();
  else window.addEventListener('load', registerDeploymentWorker, { once: true });
}
