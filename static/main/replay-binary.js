function decodeReplayBinary(buffer) {
  return new Promise(function (resolve, reject) {
    var worker = new Worker(
      '/main/replay-worker.bundle.js?v=' + encodeURIComponent(window.ROKA_ASSET_CONFIG?.version || '1'),
    );
    function failed(message) {
      worker.terminate();
      reject(new Error(message));
    }
    worker.onerror = function (event) {
      failed(event.message);
    };
    worker.onmessageerror = function () {
      failed('回放损坏');
    };
    worker.onmessage = function (event) {
      var data = event.data;
      if (data.error) {
        failed(data.error);
        return;
      }
      if (data.replay) {
        worker.terminate();
        resolve(data.replay);
        return;
      }
      $('#replay-loading-text').text('重建回放… Tick ' + data.tick + ' / ' + data.total);
      $('#replay-loading-fill')
        .removeClass('indeterminate')
        .css('width', (100 * data.tick) / Math.max(1, data.total) + '%');
    };
    worker.postMessage(buffer);
  });
}

function replayFogAt(history, mode, cell, turn) {
  if (!history || (history.omniscientFrom !== null && turn >= history.omniscientFrom)) return 0;
  var changes = history.cells.get(cell);
  if (!changes || changes[0] > turn) return mode === 'normal' ? 2 : 1;
  var low = 1;
  var high = changes.length;
  while (low < high) {
    var middle = (low + high) >>> 1;
    if (changes[middle] <= turn) low = middle + 1;
    else high = middle;
  }
  return low & 1 ? 0 : 1;
}
