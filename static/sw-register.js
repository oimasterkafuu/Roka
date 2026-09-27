// 注册部署更新兜底 Service Worker（见 sw.js）：注册失败静默忽略，
// 不影响页面正常功能（老旧浏览器无 serviceWorker 时同样跳过）。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
