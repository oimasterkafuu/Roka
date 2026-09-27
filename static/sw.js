// 部署更新兜底 Service Worker：服务器重启期间（或反代 5xx）把页面导航
// 替换为「正在更新」提示页（/updating.html，安装时预缓存），该页自行轮询
// 并在服务恢复后自动刷新回原页面。其余请求一律直通网络，不做缓存。
var UPDATING_PAGE_URL = '/updating.html';
var DEPLOY_CACHE = 'roka-deploy-v1';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(DEPLOY_CACHE)
      .then(function (cache) {
        return cache.add(UPDATING_PAGE_URL);
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') {
    return;
  }
  event.respondWith(
    fetch(request)
      .then(function (response) {
        // 反代在服务器进程退出时会返回 502/503 而非连接失败，同样视为更新中。
        if (response.status >= 500) {
          throw new Error('server unavailable: ' + response.status);
        }
        return response;
      })
      .catch(function () {
        return caches.match(UPDATING_PAGE_URL).then(function (cached) {
          return cached || Response.error();
        });
      }),
  );
});
