// 回放 ID 由原始内容哈希生成；同一 ID 的观看数据不可变，无需命中时重新请求服务器。
var REPLAY_CACHE_VERSION = 1;
var REPLAY_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
var REPLAY_CACHE_MAX_ENTRIES = 200;

function replayCacheKey(id) {
  return id;
}

function replayCacheValid(entry, id) {
  if (!entry || entry.id !== replayCacheKey(id) || entry.version !== REPLAY_CACHE_VERSION) return false;
  if (!(entry.buffer instanceof ArrayBuffer) || entry.size !== entry.buffer.byteLength || !entry.size)
    return false;
  if (!Number.isFinite(entry.downloadedAt) || !Number.isFinite(entry.lastViewedAt)) return false;
  if (typeof entry.etag !== 'string' || typeof entry.lastModified !== 'string') return false;
  // 无 HTTP 验证器时，以首次下载时间和解压后长度作为本地兜底元数据。
  var bytes = new Uint8Array(entry.buffer);
  for (var i = 0; i < replay_binary_magic.length; i++) {
    if (bytes[i] !== replay_binary_magic[i]) return false;
  }
  return true;
}

// 按最近查看时间淘汰；同 ID 的旧记录由 put 替换，不占新增配额。
function replayCacheEvictions(entries, id, size) {
  var others = entries.filter(function (entry) {
    return entry.id !== id;
  });
  var bytes =
    size +
    others.reduce(function (sum, entry) {
      return sum + (Number.isFinite(entry.size) ? entry.size : 0);
    }, 0);
  others.sort(function (a, b) {
    return a.lastViewedAt - b.lastViewedAt;
  });
  var removed = [];
  while (others.length + 1 > REPLAY_CACHE_MAX_ENTRIES || bytes > REPLAY_CACHE_MAX_BYTES) {
    var oldest = others.shift();
    if (!oldest) break;
    removed.push(oldest.id);
    bytes -= Number.isFinite(oldest.size) ? oldest.size : 0;
  }
  return removed;
}

function openReplayCache() {
  return new Promise(function (resolve, reject) {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    var request = indexedDB.open('roka-replay-cache', 1);
    request.onupgradeneeded = function () {
      request.result.createObjectStore('replays', { keyPath: 'id' });
    };
    request.onsuccess = function () {
      resolve(request.result);
    };
    request.onerror = function () {
      reject(request.error);
    };
    request.onblocked = function () {
      reject(new Error('IndexedDB blocked'));
    };
  });
}

function replayCacheGet(id) {
  return openReplayCache().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('replays', 'readwrite');
      var store = tx.objectStore('replays');
      var entry;
      store.get(replayCacheKey(id)).onsuccess = function (event) {
        entry = event.target.result;
        if (replayCacheValid(entry, id)) {
          entry.lastViewedAt = Date.now();
          store.put(entry);
        } else if (entry) {
          store.delete(replayCacheKey(id));
          entry = null;
        }
      };
      tx.oncomplete = function () {
        db.close();
        resolve(entry || null);
      };
      tx.onerror = tx.onabort = function () {
        db.close();
        reject(tx.error);
      };
    });
  });
}

function replayCacheDelete(id) {
  return openReplayCache().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('replays', 'readwrite');
      tx.objectStore('replays').delete(replayCacheKey(id));
      tx.oncomplete = function () {
        db.close();
        resolve();
      };
      tx.onerror = tx.onabort = function () {
        db.close();
        reject(tx.error);
      };
    });
  });
}

function replayCachePut(id, result) {
  var buffer = result.buffer;
  if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength > REPLAY_CACHE_MAX_BYTES) {
    return Promise.resolve();
  }
  return openReplayCache().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('replays', 'readwrite');
      var store = tx.objectStore('replays');
      var entries = [];
      store.openCursor().onsuccess = function (event) {
        var cursor = event.target.result;
        if (cursor) {
          entries.push({
            id: cursor.value.id,
            size: cursor.value.size,
            lastViewedAt: cursor.value.lastViewedAt,
          });
          cursor.continue();
          return;
        }
        var evictions = replayCacheEvictions(entries, replayCacheKey(id), buffer.byteLength);
        for (var i = 0; i < evictions.length; i++) store.delete(evictions[i]);
        var now = Date.now();
        store.put({
          id: replayCacheKey(id),
          version: REPLAY_CACHE_VERSION,
          buffer: buffer,
          size: buffer.byteLength,
          downloadedAt: now,
          lastViewedAt: now,
          etag: result.etag || '',
          lastModified: result.lastModified || '',
        });
      };
      tx.oncomplete = function () {
        db.close();
        resolve();
      };
      tx.onerror = tx.onabort = function () {
        db.close();
        reject(tx.error);
      };
    });
  });
}
