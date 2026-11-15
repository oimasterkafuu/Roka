/* global $, io, usernameLink, usernameEnsureColors */
function pad2(value) {
  return String(value).padStart(2, '0');
}
function relativeTime(time) {
  var diff = Date.now() - time;
  if (diff < 0) {
    diff = 0;
  }
  var sec = Math.floor(diff / 1000);
  if (sec < 10) {
    return '刚刚';
  }
  if (sec < 60) {
    return sec + ' 秒前';
  }
  var min = Math.floor(sec / 60);
  if (min < 60) {
    return min + ' 分钟前';
  }
  var hour = Math.floor(min / 60);
  if (hour < 24) {
    return hour + ' 小时前';
  }
  var day = Math.floor(hour / 24);
  if (day < 30) {
    return day + ' 天前';
  }
  var d = new Date(time);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function fullTime(time) {
  var d = new Date(time);
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    ' ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes())
  );
}

// 带 rating 颜色的用户名链接：统一走 /username.js 组件（全局缓存 + 批量补色）。
var replayRequest = 0;
var replayState;
function readReplayState() {
  var params = new URLSearchParams(location.search);
  var page = Number(params.get('page'));
  return {
    searching: ['username', 'from', 'to'].some(function (key) {
      return params.has(key);
    }),
    username: params.get('username') || '',
    from: params.get('from') || '',
    to: params.get('to') || '',
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1000000) : 1,
  };
}
function replayDate(value) {
  if (!value || !Number.isFinite(Number(value))) return '';
  var date = new Date(Number(value) * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}
function replayDateSeconds(value, end) {
  if (!value) return '';
  var date = new Date(value + 'T' + (end ? '23:59:59' : '00:00:00'));
  return Number.isFinite(date.getTime()) ? String(Math.floor(date.getTime() / 1000)) : '';
}
function navigateReplays(state) {
  var params = new URLSearchParams();
  if (state.searching) {
    ['username', 'from', 'to'].forEach(function (key) {
      if (state[key]) params.set(key, state[key]);
    });
  }
  if (state.searching || state.page > 1) params.set('page', String(state.page));
  history.pushState(null, '', '/replays' + (params.size ? '?' + params : ''));
  loadReplaysPage();
}
async function loadReplaysPage() {
  var generation = ++replayRequest;
  replayState = readReplayState();
  var state = replayState;
  $('#query-username').val(state.username);
  $('#query-from').val(replayDate(state.from));
  $('#query-to').val(replayDate(state.to));
  $('#replays-heading').text(state.searching ? '查询结果' : '最新回放');
  $('#replays-pagination').prop('hidden', false);
  $('#replays-prev, #replays-next').prop('disabled', true);
  $('#replays-page').text('第 ' + state.page + ' 页');
  $('#replays-body').empty();
  $('#replays-status').text('加载中…');
  var params = new URLSearchParams({
    limit: '50',
    offset: String((state.page - 1) * 50),
  });
  ['username', 'from', 'to'].forEach(function (key) {
    if (state[key]) params.set(key, state[key]);
  });
  try {
    var response = await fetch('/api/replays?' + params);
    if (!response.ok) throw new Error('replay-list-failed');
    var data = await response.json();
    if (generation !== replayRequest) return;
    var names = [];
    data.items.forEach(function (item) {
      var row = $('<tr tabindex="0"></tr>');
      function watch() {
        location.href = '/replays/' + encodeURIComponent(item.id);
      }
      row.on('click', watch).on('keydown', function (event) {
        if (event.target === this && event.key === 'Enter') watch();
      });
      $('<td></td>')
        .text(relativeTime(item.time * 1000))
        .attr('title', fullTime(item.time * 1000))
        .appendTo(row);
      $('<td></td>').text(item.turn).appendTo(row);
      var rank = $('<td></td>').appendTo(row);
      var groups =
        Array.isArray(item.teams) && item.teams.length
          ? item.teams.map(function (team) {
              return team.members || [];
            })
          : (item.rank || []).map(function (name) {
              return [name];
            });
      groups.forEach(function (members, index) {
        if (index) rank.append(' › ');
        members.forEach(function (name, memberIndex) {
          if (memberIndex) rank.append(', ');
          names.push(name);
          usernameLink(name, null, null, { stopPropagation: true }).appendTo(rank);
        });
      });
      $('#replays-body').append(row);
    });
    usernameEnsureColors(names);
    $('#replays-status').text(
      data.items.length
        ? state.searching
          ? '共 ' + data.total + ' 条'
          : ''
        : state.searching
          ? '没有符合条件的回放 · 共 ' + data.total + ' 条'
          : '暂无回放',
    );
    $('#replays-prev').prop('disabled', state.page <= 1);
    $('#replays-next').prop('disabled', !data.has_more);
  } catch (error) {
    if (generation === replayRequest) $('#replays-status').text('加载失败，请重试查询');
  }
}
$('#replay-query').on('submit', function (event) {
  event.preventDefault();
  navigateReplays({
    searching: true,
    username: $('#query-username').val().trim(),
    from: replayDateSeconds($('#query-from').val(), false),
    to: replayDateSeconds($('#query-to').val(), true),
    page: 1,
  });
});
$('#replays-prev').on('click', function () {
  navigateReplays(Object.assign({}, replayState, { page: replayState.page - 1 }));
});
$('#replays-next').on('click', function () {
  navigateReplays(Object.assign({}, replayState, { page: replayState.page + 1 }));
});
$('#replays-latest').on('click', function () {
  navigateReplays({ searching: false });
});
window.addEventListener('popstate', loadReplaysPage);
function arrayBufferToBase64(buf) {
  var bytes = new Uint8Array(buf);
  var bin = '';
  for (var i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
$('#replay-upload-file').on('change', function () {
  $('#replay-upload-view').prop('disabled', !this.files.length);
});
$('#replay-upload-view').on('click', async function () {
  var file = $('#replay-upload-file')[0].files[0];
  if (!file) return;
  $(this).prop('disabled', true);
  try {
    var response = await fetch('/api/replay-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) throw new Error('incompatible');
    var viewable = await response.arrayBuffer();
    sessionStorage.setItem('roka_local_replay_raw', arrayBufferToBase64(await file.arrayBuffer()));
    sessionStorage.setItem('roka_local_replay', arrayBufferToBase64(viewable));
    location.href = '/replays/local';
  } catch (error) {
    alert('回放文件与当前版本不兼容或已损坏');
  } finally {
    $(this).prop('disabled', false);
  }
});
async function loadReplayAuth() {
  try {
    var response = await fetch('/api/auth/me', { cache: 'no-store' });
    if (!response.ok) return;
    var user = await response.json();
    if (!user.username) return;
    $('#replay-login').prop('hidden', true);
    $('#replay-upload').prop('hidden', false);
  } catch (error) {
    /* Keep the guest login prompt. */
  }
}
var replayRefreshTimer = null;
function scheduleReplayRefresh() {
  if (replayRefreshTimer !== null) return;
  replayRefreshTimer = setTimeout(function () {
    replayRefreshTimer = null;
    loadReplaysPage();
  }, 2000);
}
var replaySocket = io({ query: { home: '1' } });
replaySocket.on('home_leaderboard', scheduleReplayRefresh);

loadReplaysPage();
loadReplayAuth();
