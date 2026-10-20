//map format
//n,m,turn
//grid_type[n][m] byte 0~49=army 50~99=city 100~149=generals 150~199=swamp with army 200=empty 201=mountain 204=swamp
//迷雾对局（fog=1 格）：201 山脉、204 沼泽保持可见，其余抹成空地（200）；
//视野内地形、归属与兵力正常下发，包含敌方建筑。
//army_cnt[n][m] int

$(document).ready(function () {
  ((x = -1), (y = -1));
  $('body').on('mousedown', function (e) {
    ((x = e.pageX), (y = e.pageY));
  });
  $('body').on('mousemove', function (e) {
    var w, X, Y;
    if (typeof e.originalEvent.buttons == 'undefined') {
      w = e.which;
    } else {
      w = e.originalEvent.buttons;
    }
    X = e.clientX || e.originalEvent.clientX;
    Y = e.clientY || e.originalEvent.clientY;
    if (w == 1) {
      $('#map').css('left', parseInt($('#map').css('left')) - x + X);
      $('#map').css('top', parseInt($('#map').css('top')) - y + Y);
      ((x = e.pageX), (y = e.pageY));
    }
  });
  var touches = [],
    expected_scale;
  function startTouch(s) {
    expected_scale = scale_sizes[scale];
    if (s.length <= 2) touches = s;
    else touches = [];
  }
  function handleMove(s) {
    var x = touches[0].pageX,
      y = touches[0].pageY,
      X = s[0].pageX,
      Y = s[0].pageY;
    $('#map').css('left', parseInt($('#map').css('left')) - x + X);
    $('#map').css('top', parseInt($('#map').css('top')) - y + Y);
  }
  function dis(a, b) {
    return Math.sqrt((a.pageX - b.pageX) * (a.pageX - b.pageX) + (a.pageY - b.pageY) * (a.pageY - b.pageY));
  }
  function moveTouch(s) {
    console.log(s);
    if (touches.length == 0) return;
    if (touches.length == 1) {
      if (s.length == 1) {
        handleMove(s);
        touches = s;
      } else if (s.length == 2) {
        var dis1 = dis(touches[0], s[0]),
          dis2 = dis(touches[0], s[1]);
        if (dis1 > dis2) s = [s[1], s[0]];
        handleMove(s);
        touches = s;
      } else {
        touches = [];
      }
    } else {
      if (s.length == 1) {
        var dis1 = dis(touches[0], s[0]),
          dis2 = dis(touches[1], s[0]);
        if (dis1 > dis2) touches = [touches[1], touches[0]];
        handleMove(s);
        touches = s;
      } else if (s.length == 2) {
        var x = (touches[0].pageX + touches[1].pageX) / 2,
          y = (touches[0].pageY + touches[1].pageY) / 2;
        var X = (s[0].pageX + s[1].pageX) / 2,
          Y = (s[0].pageY + s[1].pageY) / 2;
        $('#map').css('left', parseInt($('#map').css('left')) - x + X);
        $('#map').css('top', parseInt($('#map').css('top')) - y + Y);
        var dis1 = dis(touches[0], touches[1]),
          dis2 = dis(s[0], s[1]);
        expected_scale *= dis2 / dis1;
        if (expected_scale.toString().toLowerCase().indexOf('n') != -1) {
          expected_scale = scale_sizes[scale];
        } else {
          var pos,
            mi = 200;
          for (var i = 1; i < scale_sizes.length; i++) {
            var t = Math.abs(scale_sizes[i] - expected_scale);
            if (t < mi) ((mi = t), (pos = i));
          }
          if (pos != scale) {
            scale = pos;
            if (typeof localStorage != 'undefined') {
              localStorage.scale = scale.toString();
            }
            render();
          }
        }
        touches = s;
      } else {
        touches = [];
      }
    }
  }
  function endTouch() {
    touches = [];
  }
  function bindTouch(obj) {
    obj.addEventListener(
      'touchstart',
      function (e) {
        if (!in_game) return;
        startTouch(e.targetTouches);
      },
      false,
    );
    obj.addEventListener(
      'touchmove',
      function (e) {
        if (!in_game) return;
        moveTouch(e.targetTouches);
      },
      false,
    );
    obj.addEventListener(
      'touchend',
      function (e) {
        if (!in_game) return;
        moveTouch(e.targetTouches);
        endTouch();
      },
      false,
    );
  }
  bindTouch(document);

  if (window.innerWidth <= 1000) {
    // shoule be mobile
    $('#turn-counter').attr('class', 'mobile');
    $('#game-leaderboard').attr('class', 'mobile');
    $('#replay-top-left').attr('class', 'mobile');
  }
});

const scale_sizes = [0, 20, 25, 32, 40, 50, 60];

var n,
  m,
  turn,
  player,
  scale,
  selx,
  sely,
  selt,
  in_game = false;
var grid_type,
  army_cnt,
  isolated,
  fog,
  have_build,
  have_route = Array(4);
// 格子 DOM 元素缓存与内容影子表（init_map 随 n/m 重建；render() 热路径
// 免选择器查找与 innerHTML 序列化读取，issue #87）。
var cell_elems, cell_html;
// 本地唯一操作大队列；seq 与服务端 next_seq 保持单调一致。
var route = [];
var next_seq = 1;
// 当前对局是否为全局队列（多线争锋）模式：决定 Q 键清空队列还是撤回队尾（issue #119）。
var multi_line = false;
var general_order = Array();

var room_id = '',
  account_name = '',
  client_id,
  ready_state = 0,
  lost;
// 部署更新排队中：禁止开新局（开始按钮禁用），对局中显示「系统即将更新」横幅。
var deploy_queued = false;
// 上一份房间成员 uid 列表快照，用于 room_update 里检测新玩家进房（null = 尚未收到首帧）。
var prev_room_uids = null;
var allow_page_leave = false,
  game_ended = false;
var max_teams = 16;
var room_link_copy_timer = 0;

var chat_focus = false,
  is_team = false,
  starting_audio;

var is_replay = false,
  replay_id = false,
  replay_data = [],
  rcnt = 0,
  cur_turn = 0,
  is_autoplaying = false,
  autoplay_speed = 1;

window.addEventListener('beforeunload', function (e) {
  if (allow_page_leave || is_replay || !in_game || game_ended) return;
  e.preventDefault();
  e.returnValue = '';
  return '';
});

function showReplayError() {
  $('#replay-loading').css('display', 'none');
  $('#replay-error-alert').css('display', '');
}

function formatReplaySize(bytes) {
  if (bytes >= 1024 * 1024) {
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  if (bytes >= 1024) {
    return (bytes / 1024).toFixed(1) + ' KB';
  }
  return bytes + ' B';
}

function updateReplayLoading(loaded, total) {
  var $fill = $('#replay-loading-fill');
  var text;
  if (total > 0) {
    var percent = Math.min(100, Math.floor((loaded / total) * 100));
    $fill.removeClass('indeterminate').css('width', percent + '%');
    text =
      '回放加载中… ' + percent + '%（' + formatReplaySize(loaded) + ' / ' + formatReplaySize(total) + '）';
  } else {
    // 服务端未给出 X-Replay-Size（仍在转码重建）时进度「虚」显示：填充条往返滑动。
    $fill.addClass('indeterminate').css('width', '');
    text = '回放加载中… 已下载 ' + formatReplaySize(loaded);
  }
  $('#replay-loading-text').text(text);
}

// 流式下载回放二进制并按 X-Replay-Size（解压后大小）更新加载进度。
function fetchReplayWithProgress(url) {
  return fetch(url).then(function (res) {
    if (!res.ok) {
      throw new Error('load failed');
    }
    var total = Number(res.headers.get('X-Replay-Size')) || 0;
    var metadata = { etag: res.headers.get('ETag'), lastModified: res.headers.get('Last-Modified') };
    if (!res.body || !res.body.getReader) {
      return res.arrayBuffer().then(function (buffer) {
        updateReplayLoading(buffer.byteLength, total || buffer.byteLength);
        return { buffer: buffer, etag: metadata.etag, lastModified: metadata.lastModified };
      });
    }
    var reader = res.body.getReader();
    var chunks = [];
    var loaded = 0;
    updateReplayLoading(loaded, total);
    return reader.read().then(function pump(result) {
      if (result.done) {
        var buf = new Uint8Array(loaded);
        var offset = 0;
        for (var i = 0; i < chunks.length; i++) {
          buf.set(chunks[i], offset);
          offset += chunks[i].byteLength;
        }
        return { buffer: buf.buffer, etag: metadata.etag, lastModified: metadata.lastModified };
      }
      chunks.push(result.value);
      loaded += result.value.byteLength;
      updateReplayLoading(loaded, total);
      return reader.read().then(pump);
    });
  });
}

function base64ToArrayBuffer(b64) {
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

function loadServerReplay(id) {
  var url = '/api/getreplay/' + encodeURIComponent(id);
  function fromNetwork() {
    return fetchReplayWithProgress(url).then(function (result) {
      var decoded = decodeReplayBinary(result.buffer);
      // 存储失败（隐私模式、配额不足等）不影响本次观看。
      replayCachePut(id, result).catch(function () {});
      return decoded;
    });
  }
  return replayCacheGet(id)
    .catch(function () {
      return null;
    })
    .then(function (entry) {
      if (!entry) return fromNetwork();
      try {
        var decoded = decodeReplayBinary(entry.buffer);
        updateReplayLoading(entry.size, entry.size);
        return decoded;
      } catch {
        // 魔数通过但内容损坏：删掉坏条目，并且只回源一次。
        return replayCacheDelete(id)
          .catch(function () {})
          .then(fromNetwork);
      }
    });
}

if (location.pathname.substr(0, 8) == '/replays') {
  is_replay = true;
  // pathname 中是 URL 编码后的 id（含 + 的回放 id 会变成 %2B），先解码一次，
  // 后续请求时统一再做一次 encodeURIComponent，避免双重编码导致服务端找不到回放。
  replay_id = decodeURIComponent(location.pathname.substr(9));
  var replayLoadFailed = false;
  var replayFetch;
  if (replay_id == 'local') {
    // 首页“上传并查看回放”：服务器已把上传的 .rpl 转码为可播放二进制，暂存于 sessionStorage。
    replayFetch = new Promise(function (resolve, reject) {
      var b64 = sessionStorage.getItem('roka_local_replay');
      if (!b64) {
        reject(new Error('missing local replay'));
        return;
      }
      resolve(decodeReplayBinary(base64ToArrayBuffer(b64)));
    });
  } else {
    // 注意：本文件在 <head> 中同步加载，此刻 DOM 尚未解析，不能在这里操作
    // #replay-loading——显示/失败兜底统一放到 document.ready 的回放分支里。
    replayFetch = loadServerReplay(replay_id);
  }
  replayFetch
    .then(function (decoded) {
      replay_data = decoded;
      replayStart();
    })
    .catch(function () {
      replayLoadFailed = true;
      showReplayError();
    });
}

function replayStart() {
  rcnt++;
  if (rcnt == 2) {
    $('#replay-loading-fill').removeClass('indeterminate').css('width', '0%');
    $('#replay-loading').css('display', 'none');
    init_map(replay_data.n, replay_data.m);
    in_game = true;
    cur_turn = 0;
    initReplayViewTabs();
    initReplayTitle();
    initReplayStats();
    update(replay_data.initial);
  }
}

function init_map(_n, _m, general) {
  chat_focus = false;
  $('#chatroom-input').blur();
  // 排行榜列宽锁定（issue #93）按对局重置，新局从实际位数重新累积。
  resetLeaderboardColumnLock();
  ((n = _n), (m = _m));
  grid_type = Array(n);
  for (var i = 0; i < n; i++) {
    grid_type[i] = Array(m);
  }
  army_cnt = Array(n);
  for (var i = 0; i < n; i++) {
    army_cnt[i] = Array(m);
  }
  isolated = Array(n);
  have_build = Array(n);
  fog = Array(n);
  for (var i = 0; i < n; i++) {
    isolated[i] = Array(m);
    have_build[i] = Array(m);
    fog[i] = Array(m);
    for (var j = 0; j < m; j++) {
      fog[i][j] = 0;
    }
  }
  for (var d = 0; d < 4; d++) {
    have_route[d] = Array(n);
    for (var i = 0; i < n; i++) {
      have_route[d][i] = Array(m);
    }
  }
  route = Array();
  next_seq = 1;
  general_order = Array();
  ((selx = -1), (sely = -1), (selt = 1));

  var ts = '';
  for (var i = 0; i < n; i++) {
    ts += '<tr>';
    for (var j = 0; j < m; j++) {
      ts += '<td id="t' + i + '_' + j + '"></td>';
    }
    ts += '</tr>';
  }
  $('#map').html('<table><tbody>' + ts + '</table></tbody>');
  // 格子元素一次性缓存（render() 是唯一写者）：避免每帧 n·m 次 id 选择器
  // 查找；cell_html 记录各格上次写入的 innerHTML，免每帧序列化读取比对。
  cell_elems = Array(n);
  cell_html = Array(n);
  var tds = $('#map td');
  for (var i = 0, t = 0; i < n; i++) {
    cell_elems[i] = Array(m);
    cell_html[i] = Array(m);
    for (var j = 0; j < m; j++) {
      cell_elems[i][j] = tds[t++];
      cell_html[i][j] = '';
    }
  }

  if (!general || general[0] == -1) {
    general = [n / 2 - 0.5, m / 2 - 0.5];
  }
  $('#map').css('left', $(document).width() / 2 + (m / 2 - general[1] - 0.5) * scale_sizes[scale] + 'px');
  $('#map').css('top', $(document).height() / 2 + (n / 2 - general[0] - 0.5) * scale_sizes[scale] + 'px');
  for (var i = 0; i < n; i++) {
    for (var j = 0; j < m; j++) {
      $(cell_elems[i][j]).on('click', Function('click(' + i + ',' + j + ')'));
    }
  }
}

function click(x, y) {
  if (x < 0 || y < 0 || x >= n || y >= m) return;
  var ownCell = player > 0 && grid_type[x][y] < 200 && grid_type[x][y] % 50 == player;
  if (!is_replay && !ownCell) {
    ((selx = -1), (sely = -1));
    render();
    return;
  }
  // 保留 selt：Z 半兵待发状态只被下一次有效 WASD 消耗
  ((selx = x), (sely = y));
  render();
}

function moveSelected(d, shift) {
  if (selx < 0 || sely < 0 || d < 0 || d >= dire.length) return;
  var ownSelected = player > 0 && grid_type[selx][sely] < 200 && grid_type[selx][sely] % 50 == player;
  var nx = selx + dire[d].x,
    ny = sely + dire[d].y;
  if (nx < 0 || ny < 0 || nx >= n || ny >= m) return;
  // 山脉不可通行；迷雾格中除山脉、沼泽外均已抹成空地，故 201 只代表
  // 真实山脉，无需额外区分——非迷雾的真实山脉直接阻断入队。
  if (grid_type[nx][ny] == 201 && !fog[nx][ny]) return;
  // 命令可能有效时才入队：链式入队（本地队列非空，由服务器执行时校验），或当前选中
  // 己方正常领土且兵力 > 1（兵力 ≤ 1 时三种模式推出量均为 0；孤军不可推兵）。
  // 即使不入队、不显示箭头，光标也始终跟随移动——光标保持“活着”。
  if (anyRouteQueued() || (ownSelected && !isolated[selx][sely] && army_cnt[selx][sely] > 1)) {
    // 默认全兵（A-1）；Shift = 智能分兵；Z 待发时半兵。Shift 优先且不消耗 Z 待发状态。
    var mode = shift ? 0 : selt == 2 ? 1 : 2;
    addroute(selx, sely, d, mode);
    if (!shift) selt = 1;
  }
  ((selx = nx), (sely = ny));
  render();
}

function buildSelected(op) {
  if (selx < 0 || sely < 0) return;
  var cellType = grid_type[selx][sely];
  if (player <= 0) return;
  // 山脉与沼泽永远禁止建筑；其余格子（含队列未来将占领的格子）都允许入队，
  // 执行时由服务器校验，条件不满足会自动跳过并继续执行后续操作。
  if (cellType == 201 || cellType == 204 || (cellType >= 150 && cellType < 200)) return;
  if (op == 'b') {
    // X 建指挥所：普通地块（已有建筑则无效）
    if (cellType >= 50 && cellType != 200) return;
    addbuild(selx, sely, 'b');
  } else {
    // C：己方指挥所直接升级主城；普通地块连续入队两步——先建指挥所、下一回合再升级主城
    if (cellType >= 100 && cellType != 200) return;
    if (cellType >= 50 && cellType % 50 == player) {
      addbuild(selx, sely, 'c');
    } else {
      addbuild(selx, sely, 'b');
      addbuild(selx, sely, 'c');
    }
  }
  render();
}

// 目标格中心是否在当前视野内（#map 的 left/top 经 translate(-50%,-50%) 定位，即地图中心坐标）。
function isCellVisible(bx, by) {
  var s = scale_sizes[scale];
  var left = parseFloat($('#map').css('left'));
  var top = parseFloat($('#map').css('top'));
  if (isNaN(left) || isNaN(top)) return false;
  var cx = left + (by + 0.5 - m / 2) * s;
  var cy = top + (bx + 0.5 - n / 2) * s;
  return cx >= 0 && cx <= $(document).width() && cy >= 0 && cy <= $(document).height();
}

function jumpToGeneral() {
  if (player <= 0 || general_order.length == 0) return;
  var rx = selx >= 0 ? selx : n / 2 - 0.5,
    ry = sely >= 0 ? sely : m / 2 - 0.5;
  var bx = -1,
    by = -1,
    best = -1;
  for (var i = 0; i < general_order.length; i++) {
    var p = general_order[i].split('_');
    var gx = parseInt(p[0]),
      gy = parseInt(p[1]);
    var dist = Math.abs(gx - rx) + Math.abs(gy - ry);
    if (best == -1 || dist < best) {
      best = dist;
      ((bx = gx), (by = gy));
    }
  }
  if (bx < 0) return;
  // 目标主城已在视野内时只移动光标，镜头保持不动；不在视野内才把镜头居中过去。
  if (!isCellVisible(bx, by)) {
    $('#map').css('left', $(document).width() / 2 + (m / 2 - by - 0.5) * scale_sizes[scale] + 'px');
    $('#map').css('top', $(document).height() / 2 + (n / 2 - bx - 0.5) * scale_sizes[scale] + 'px');
  }
  // 保留 selt：Z 半兵待发状态只被下一次有效 WASD 消耗
  ((selx = bx), (sely = by));
  render();
}

function keypress(key, shift) {
  if (in_game && is_replay) {
    if (key == 'a' || key == 37) {
      backTurn();
    } else if (key == 'd' || key == 39) {
      nextTurn();
    } else if (key == ' ') {
      switchAutoplay();
    }
  } else if (in_game) {
    if (key == 27) {
      if (!canSurrender()) {
        hideSurrenderAlert();
        return;
      }
      if ($('#surrender-alert').css('display') == 'none') showSurrenderAlert();
      else hideSurrenderAlert();
    } else if (key == 'z') {
      selt = 3 - selt;
      render();
    } else if (key == 'w' || key == 38) {
      moveSelected(0, shift);
    } else if (key == 's' || key == 40) {
      moveSelected(1, shift);
    } else if (key == 'a' || key == 37) {
      moveSelected(2, shift);
    } else if (key == 'd' || key == 39) {
      moveSelected(3, shift);
    } else if (key == 'x') {
      buildSelected('b');
    } else if (key == 'c') {
      buildSelected('c');
    } else if (key == 'q') {
      clear_queue();
    } else if (key == 'e') {
      pop_queue();
    } else if (key == 't') {
      if (!chat_focus) {
        is_team = true;
        setTimeout(function () {
          $('#chatroom-input').focus();
          checkChat();
        }, 0);
      }
    } else if (key == 13) {
      if (!chat_focus) {
        is_team = false;
        setTimeout(function () {
          $('#chatroom-input').focus();
          checkChat();
        }, 0);
      }
    } else if (key == ' ') {
      jumpToGeneral();
    }
  } else if (!is_replay) {
    if (key == 13 && !chat_focus) {
      is_team = false;
      setTimeout(function () {
        $('#chatroom-input').focus();
        checkChat();
      }, 0);
    }
  }
}

function submitChatInput() {
  var text = chatStr.trim();
  if (text.length === 0) {
    chatStr = '';
    is_team = false;
    $('#chatroom-input').val('');
    $('#chatroom-input').blur();
    return;
  }
  socket.emit('send_message', { text: text, team: is_team });
  ((chatStr = ''), (is_team = false));
  $('#chatroom-input').val('');
}

function setRoomTopLeftVisible(show) {
  $('#room-top-left').css('display', show ? '' : 'none');
}

// 观战中（含战败后、终局复盘时）显示「下局模式」选择器：
// 纯观战用户可提前选好下一局只看不打，避免对局结束后被瞬间重开的下一局拉进场。
// 迷雾对局中的观战者（含观战席成员）额外显示「视角」选择器（看齐回放视角切换）。
function refreshSpectateMode() {
  var spectating = !is_replay && in_game && player == 0;
  var viewEligible = typeof spectateViewEligible == 'function' && spectateViewEligible();
  $('#spectate-mode').css('display', spectating || viewEligible ? '' : 'none');
  $('#spectate-mode-box').css('display', spectating ? '' : 'none');
  $('#spectate-view-section').css('display', viewEligible ? '' : 'none');
}

$(document).ready(function () {
  $('body').on('keypress', function (e) {
    keypress(e.key.toLowerCase(), e.shiftKey);
  });
  $('body').on('keydown', function (e) {
    keypress(e.keyCode, e.shiftKey);
  });
  $('#map_back').on('click', function (e) {
    ((selx = -1), (sely = -1), (selt = 1));
    render();
  });
  $('body').bind('mousewheel', function (e) {
    if (in_game) {
      if (e.originalEvent.deltaY > 0) {
        scale = Math.max(scale - 1, 1);
      } else {
        scale = Math.min(scale + 1, 6);
      }
      if (typeof localStorage != 'undefined') {
        localStorage.scale = scale.toString();
      }
      render();
    }
  });
  if (typeof localStorage != 'undefined') {
    if (typeof localStorage.scale == 'undefined') {
      localStorage.scale = '3';
    }
    scale = parseInt(localStorage.scale);
  }
});

if (!is_replay) {
  var socket = io.connect(location.origin, { transports: ['websocket', 'polling'] });
} else {
  function socket() {}
  socket.on = function () {};
}

// 房间心跳：每 30 秒上报一次，证明标签页仍然开启；后台标签页定时器会被浏览器节流，
// 但节流后的频率仍远高于服务端 600 秒的超时阈值。对局中也照常上报，无副作用。
// 仅在确认是房间成员后启动（room_update 只发给房内 socket）：未进房的挂着标签页
// 不再发心跳，服务端对房外心跳也不计入在线状态。
var room_heartbeat_timer = null;
var session_stamp = '';
function sendRoomHeartbeat() {
  var payload = {
    visible: document.visibilityState != 'hidden',
    focused: document.hasFocus(),
  };
  if (!session_stamp || !client_id || !window.crypto || !crypto.subtle) {
    socket.emit('room_heartbeat', payload);
    return;
  }
  crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(session_stamp + ':' + client_id))
    .then(function (buf) {
      payload.sig = Array.from(new Uint8Array(buf))
        .map(function (b) {
          return b.toString(16).padStart(2, '0');
        })
        .join('');
      socket.emit('room_heartbeat', payload);
    })
    .catch(function () {
      socket.emit('room_heartbeat', payload);
    });
}
function startRoomHeartbeat() {
  if (is_replay || room_heartbeat_timer !== null) return;
  room_heartbeat_timer = setInterval(sendRoomHeartbeat, 30000);
}
function stopRoomHeartbeat() {
  if (room_heartbeat_timer !== null) {
    clearInterval(room_heartbeat_timer);
    room_heartbeat_timer = null;
  }
}

// 连接级真人验证（幂等，可重复调用）：session_stamp、client_id 与 WebCrypto 齐备时
// 才计算 sig 并上报 client_verify，否则静默不发。目标是在进房之前完成验证——
// 任何开局时序（含 set_id 晚到的竞态）都不会再把真人误标为 [AI]。
function sendClientVerify() {
  if (!session_stamp || !client_id || !window.crypto || !crypto.subtle) {
    return;
  }
  crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(session_stamp + ':' + client_id))
    .then(function (buf) {
      var sig = Array.from(new Uint8Array(buf))
        .map(function (b) {
          return b.toString(16).padStart(2, '0');
        })
        .join('');
      socket.emit('client_verify', { sig: sig });
    })
    .catch(function () {
      // 签名失败时静默：room_heartbeat 的常规路径仍会周期重试。
    });
}

async function loadAccountProfile() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw '';
    const data = await res.json();
    account_name = data.username;
    // 会话戳只随游戏页 HTML 注入（不再经 JSON 接口下发），socket 直连的 bot 取不到。
    const stampMeta = document.querySelector('meta[name="roka-session-stamp"]');
    session_stamp = stampMeta && typeof stampMeta.content == 'string' ? stampMeta.content : '';
    // 拿到 stamp 立即验证一次（早于 joinGameRoom），消除进房瞬间开局的误标竞态。
    sendClientVerify();
  } catch {
    location.href = '/login';
  }
}

// 部署更新横幅：仅对局进行中（含观战）显示；准备阶段由禁用的开始按钮传达。
// 横幅全宽置顶（z-index 99）会遮住右上角排行榜，显示时把排行榜整体下移
// 到横幅下方（按实测高度），#replay-stats 面板逐帧按排行榜高度自动跟随。
function refreshDeployBanner() {
  var show = deploy_queued && in_game && !game_ended;
  $('#deploy-banner').css('display', show ? '' : 'none');
  $('#game-leaderboard').css('top', show ? $('#deploy-banner').outerHeight() + 'px' : '');
}

socket.on('update', update);

// 对局结算完成（rating 生效）后服务端广播 home_leaderboard：名字等级色可能变化，
// 失效用户名颜色缓存并重拉本页已渲染名字的颜色（issue #84；回放模式 socket.on 为空操作）。
socket.on('home_leaderboard', function () {
  usernameColorsInvalidate();
});

// 部署更新排队广播：对局中显示警告横幅，准备阶段禁用开始按钮
// （room_update 的 update_queued 字段随后会同步完整房间状态）。
socket.on('deploy_queued', function (data) {
  deploy_queued = !data || data.queued !== false;
  refreshDeployBanner();
  if (deploy_queued && !in_game) {
    $('#force-start').css('display', 'block');
    $('#force-start').prop('disabled', true);
    $('#force-start').attr('class', '');
    $('#force-start').html('系统即将排队更新，请稍等');
  }
});

socket.on('starting', function () {
  // 新对局开始：观战视角复位为全图（新引擎实例不携带旧的视角偏好）。
  spectate_view_team = 0;
  spectate_view_uids = [];
  setRoomTopLeftVisible(false);
  $('#status-alert').css('display', 'none');
  $($('#status-alert').children()[0].children[6]).css('display', 'none');
  hideSurrenderAlert();
  $('#menu').css('display', 'none');
  $('#game-starting').css('display', '');
  starting_audio.play();
  // 页面在后台时弹浏览器通知提醒游戏开始（tag 按房间去重，多标签页只弹一次）。
  notifyEvent('room-start-' + room_id, 'Roka', '你所在的房间「' + room_id + '」游戏开始了！');
});

// 队列中是否有待发指令。
function anyRouteQueued() {
  return route.length > 0;
}

function addroute(x, y, d, mode) {
  // 服务端静默丢弃场景（未在对局/已结束/已出局）下不入队不发送：
  // 否则本地自增 seq 而服务端未入队，两端 next_seq 永久错位（lst_moves 摘不到队列项）。
  if (lost === true || game_ended === true || in_game !== true) return;
  var seq = next_seq++;
  route.push({ x: x, y: y, d: d, mode: mode, seq: seq });
  socket.emit('attack', { x: x, y: y, dx: x + dire[d].x, dy: y + dire[d].y, mode: mode, half: mode == 1 });
  render();
}
function addbuild(x, y, op) {
  // 与 addroute 同一防线：服务端必然丢弃时不入队不发送，保持两端 seq 一致。
  if (lost === true || game_ended === true || in_game !== true) return;
  var seq = next_seq++;
  route.push({ x: x, y: y, build: op, seq: seq });
  socket.emit('build', { x: x, y: y, op: op });
  render();
}
function retract_last() {
  if (!route.length) return;
  var tmp = route.pop();
  socket.emit('pop_queue', {});
  if (!tmp.build && tmp.x + dire[tmp.d].x == selx && tmp.y + dire[tmp.d].y == sely)
    ((selx = tmp.x), (sely = tmp.y));
  render();
}
function clear_queue() {
  // 全局队列（多线争锋）对局 Q 与 E 同为撤回全局最后一条指令；
  // 单线对局 Q 清空整个操作队列（issue #119）。
  if (multi_line) {
    retract_last();
    return;
  }
  if (lost === true || game_ended === true || in_game !== true) return;
  if (!route.length) return;
  route = [];
  socket.emit('clear_queue', {});
  render();
}
function pop_queue() {
  retract_last();
}
function clearAllRoutes() {
  route = [];
}

socket.on('set_id', function (data) {
  client_id = data;
  // 覆盖 set_id 晚到的竞态：stamp 已就绪时立即补一次验证。
  sendClientVerify();
});

socket.on('init_map', function (data) {
  init_map(data.n, data.m, data.general);
  if (typeof data.next_seq == 'number') next_seq = data.next_seq;
  multi_line = data.multi_line === true;
  in_game = true;
  game_ended = false;
  lost = false;
  player = 0;
  fog_mode = false;
  spectate_view_uids = [];
  // 断线重连补发 init_map 的场景（无 starting 前置）：恢复此前选择的观战视角。
  if (spectate_view_team > 0) {
    socket.emit('spectate_view', { team: spectate_view_team });
  }
  refreshDeployBanner();
  $('#status-alert').css('display', 'none');
  hideSurrenderAlert();
  console.log(data);
  for (var i = 0; i < data.player_ids.length; i++) {
    if (data.player_ids[i] == client_id) {
      player = i + 1;
    }
  }
  route = Array.isArray(data.queue_ops)
    ? data.queue_ops.map(function (op) {
        return op.kind == 'm'
          ? {
              x: op.x,
              y: op.y,
              d: dire.findIndex(function (v) {
                return op.dx == op.x + v.x && op.dy == op.y + v.y;
              }),
              mode: op.mode,
              seq: op.seq,
            }
          : { x: op.x, y: op.y, build: op.kind, seq: op.seq };
      })
    : [];
  if (typeof data.next_seq == 'number') next_seq = data.next_seq;
  // 开局默认选中己方主城，无需先按空格即可直接操作。
  if (player > 0 && data.general && data.general[0] >= 0) {
    ((selx = data.general[0]), (sely = data.general[1]), (selt = 1));
  }
  refreshSpectateMode();
});

$(document).ready(function () {
  if (is_replay) {
    // 加载提示在 DOM 就绪后显示：若在就绪前已失败（如 404），直接改显错误弹窗。
    if (replayLoadFailed) showReplayError();
    else if (replay_id != 'local') $('#replay-loading').css('display', '');
    $('#replay-top-left').css('display', '');
    $('#replay-bottom').css('display', '');
    $('#replay-turn-jump-input').on('keypress', function (e) {
      if (e.charCode == 10 || e.charCode == 13) jumpToTurn();
    });
    $('#replay-turn-jump-button').on('click', jumpToTurn);
    $($('#replay-bottom-bar')[0].children[0]).on('click', backTurn);
    $($('#replay-bottom-bar')[0].children[1]).on('click', switchAutoplay);
    $($('#replay-bottom-bar')[0].children[2]).on('click', nextTurn);
    $('#replay-autoplay-btn').on('click', switchAutoplay);
    $('#replay-exit-btn').on('click', _exit);
    $('#replay-error-back').on('click', function () {
      location.href = '/';
    });
    $('#replay-download-btn').on('click', function () {
      var a = document.createElement('a');
      if (replay_id == 'local') {
        // 本地上传的回放：把用户上传的原始 .rpl 文件原样给回。
        var b64 = sessionStorage.getItem('roka_local_replay_raw');
        if (!b64) {
          return;
        }
        a.href = URL.createObjectURL(
          new Blob([base64ToArrayBuffer(b64)], { type: 'application/octet-stream' }),
        );
        a.download = 'roka-replay-local.rpl';
      } else {
        // 服务器回放：单独请求原始 .rpl 存储文件，而非解码后的可播放二进制。
        a.href = '/api/downloadreplay/' + encodeURIComponent(replay_id);
        a.download = 'roka-replay-' + replay_id + '.rpl';
      }
      document.body.appendChild(a);
      a.click();
      if (replay_id == 'local') {
        URL.revokeObjectURL(a.href);
      }
      a.remove();
    });
    $('#tabs-replay-autoplay').each(function () {
      for (var i = 1; i < this.children.length; i++) {
        initTab(this, this.children[i], setAutoplayRate);
      }
    });
    replayStart();
    return;
  }
  $('#chat').css('display', '');
  $('#menu').css('display', '');
  setRoomTopLeftVisible(true);
  var tmp = location.pathname;
  room_id = tmp.substr(tmp.indexOf('games/') + 6);
  refreshRoomLinkDisplay();
  starting_audio = new Audio('/gong.mp3?v={{V}}');
  // 已登录才能进入本页（未登录会在 loadAccountProfile 跳走），此处引导通知权限。
  maybePromptNotificationPermission();
  loadAccountProfile().then(function () {
    joinGameRoom();
  });
});

socket.on('connect', function () {
  $('#disconnect-banner').css('display', 'none');
  // 断线重连后 stamp 仍在本地，先补验证再进房。
  sendClientVerify();
  joinGameRoom();
});

socket.on('connect_error', function () {
  location.href = '/login';
});
// 房间准备阶段超过 600 秒无心跳，被服务器移出房间：重定向回首页。
socket.on('room_kick', function () {
  stopRoomHeartbeat();
  location.href = '/';
});
socket.on('disconnect', function (reason) {
  // 断线后房间成员身份待重连确认，先停心跳；重连成功收到 room_update 后重启。
  stopRoomHeartbeat();
  if (reason == 'io server disconnect') {
    location.href = '/';
    return;
  }
  // 普通断网：socket.io 自动重连，10 秒宽限期内重连可恢复对局。
  if (!is_replay) {
    $('#disconnect-banner').css('display', '');
  }
});

socket.on('room_update', function (data) {
  // room_update 只发给房间内 socket：收到即确认成员身份，启动房间心跳。
  sendRoomHeartbeat();
  startRoomHeartbeat();
  setTabVal('game-speed', data.speed + 'x');
  setAllowTeamModeByCode(Boolean(data.allow_team));
  setFogModeByCode(Boolean(data.fog));
  setMultiLineModeByCode(Boolean(data.multi_line));
  setMapModeByCode(data.map_mode || 'random');
  setMapRegionByCode(data.map_region || 'china');
  setMapSizeByCode(data.map_size || 'normal');
  refreshMapInputHint();
  $('#map-token').val(normalizeMapTokenInput(data.map_token || ''));
  // 自定义种子（issue #86）：高亮输入框并显示提示，提醒本房间将重复生成相同地图。
  var customSeed = data.map_token_custom === true;
  $('#map-token').toggleClass('custom-seed', customSeed);
  $('#map-token-custom-hint').css('display', customSeed ? '' : 'none');
  var tmp = Array(max_teams + 1);
  for (var i = 0; i <= max_teams; i++) {
    tmp[i] = '';
  }
  var isHost = data.players.length > 0 && data.players[0].sid == client_id;
  var allowTeam = Boolean(data.allow_team);
  var roomRunning = Boolean(data.in_game);
  var hasServerBotForbiddingTeam = false;
  var hasBotForbiddingFog = false;
  var hasBotForbiddingMultiLine = false;
  for (var i = 0; i < data.players.length; i++) {
    var p = data.players[i];
    if (p.server_bot && p.server_bot_allow_team !== true) {
      hasServerBotForbiddingTeam = true;
    }
    if (
      (p.bot && !(p.server_bot && p.server_bot_allow_fog === true)) ||
      (p.server_bot && p.server_bot_allow_fog !== true)
    ) {
      hasBotForbiddingFog = true;
    }
    if (
      (p.bot && !(p.server_bot && p.server_bot_allow_multi_line === true)) ||
      (p.server_bot && p.server_bot_allow_multi_line !== true)
    ) {
      hasBotForbiddingMultiLine = true;
    }
    if (hasServerBotForbiddingTeam && hasBotForbiddingFog && hasBotForbiddingMultiLine) {
      break;
    }
  }
  setTabGroupReadonly('tabs-game-speed', roomRunning || !isHost);
  setTabGroupReadonly('tabs-map-mode', roomRunning || !isHost);
  setTabGroupReadonly('tabs-map-region', roomRunning || !isHost || getMapModeCode() != 'huaxia');
  setTabGroupReadonly('tabs-map-size', roomRunning || !isHost);
  setTabGroupReadonly('tabs-team-mode', roomRunning || !isHost || hasServerBotForbiddingTeam);
  setTabGroupReadonly('tabs-fog-mode', roomRunning || !isHost || hasBotForbiddingFog);
  setTabGroupReadonly('tabs-multi-line-mode', roomRunning || !isHost || hasBotForbiddingMultiLine);
  $('#team-mode-bot-hint').css('display', hasServerBotForbiddingTeam ? '' : 'none');
  $('#fog-mode-bot-hint').css('display', hasBotForbiddingFog ? '' : 'none');
  $('#multi-line-mode-bot-hint').css('display', hasBotForbiddingMultiLine ? '' : 'none');
  $('#team-mode-section').css('display', isHost && !roomRunning ? '' : 'none');
  if (isHost && !roomRunning) $('#map-token').removeAttr('disabled');
  else $('#map-token').attr('disabled', '');
  $('#host-' + isHost.toString()).css('display', '');
  $('#host-' + (!isHost).toString()).css('display', 'none');

  var playingCount = 0;
  var selfTeam = 0;
  var selfReady = false;
  roomMemberTeams = {};
  for (var i = 0; i < data.players.length; i++) {
    roomMemberTeams[data.players[i].uid] = data.players[i].team;
    if (data.players[i].team) playingCount += 1;
    if (data.players[i].sid == client_id) {
      selfTeam = data.players[i].team;
      selfReady = Boolean(data.players[i].ready && data.players[i].team !== 0);
      if (data.players[i].team) {
        $('#you-are').css('display', '');
        $('#you-are-2').css('display', '');
        $($('#you-are')[0].children[1]).attr('class', 'inline-color-block c' + (i + 1));
        $($('#you-are-2')[0].children[1]).attr('class', 'inline-color-block c' + (i + 1));
      } else {
        $('#you-are').css('display', 'none');
        $('#you-are-2').css('display', 'none');
      }
    }
    var groupId = allowTeam ? data.players[i].team : data.players[i].team ? 1 : 0;
    tmp[groupId] += '<div>';
    if (groupId) {
      if (i == 0) {
        tmp[groupId] += '<span class="inline-color-block">' + crown_html + '</span>';
      } else {
        tmp[groupId] += '<span class="inline-color-block c' + (i + 1) + '"></span>';
      }
    }
    tmp[groupId] += '<p>';
    if (i == 0) tmp[groupId] += '<b>';
    // 成员名：统一用户名组件（rating 颜色 + 点击跳主页），接口不带颜色时先 rt-unrated 渲染。
    // ready（已准备）用内联 underline 表达：rt-* 的 text-decoration:none 会盖掉 <u> 继承的下划线。
    // 未经真人客户端认证的连接显示「[AI] 」前缀（仅当前对局的房间视图生效）。
    var memberLink = usernameLinkHtml(data.players[i].uid);
    if (data.players[i].ai) memberLink = '[AI] ' + memberLink;
    if (data.players[i].ready) {
      memberLink = memberLink.replace('<a ', '<a style="text-decoration: underline" ');
    }
    tmp[groupId] += memberLink;
    if (i == 0) tmp[groupId] += '</b>';
    tmp[groupId] += '</p>';
    tmp[groupId] += '</div>';
  }
  // 房间成员名批量补 rating 颜色（带缓存与去重；补色后自动刷新已渲染链接）。
  usernameEnsureColors(
    data.players.map(function (p) {
      return p.uid;
    }),
  );

  var canSelectPlayer = selfTeam != 0 || playingCount < max_teams;
  self_team = selfTeam;
  $('#team-select-section').css('display', !roomRunning && canSelectPlayer ? '' : 'none');
  setTabGroupReadonly('tabs-custom-team', roomRunning || !canSelectPlayer);
  refreshCustomTeamTabs(allowTeam);
  setTabVal('custom-team', selfTeam ? (allowTeam ? selfTeam.toString() : '参赛') : '观战');
  ready_state = selfReady ? 1 : 0;
  setTabVal('spectate-mode', selfTeam ? '参与' : '观战');

  if (allowTeam) {
    for (var i = 0; i <= max_teams; i++) {
      if (tmp[i] != '') {
        tmp[i] =
          '<div class="custom-team-container"><h4>' +
          (i ? '队伍 ' + i : '观战席') +
          '</h4>' +
          tmp[i] +
          '</div>';
      }
    }
    var res_html = '';
    for (var i = 1; i <= max_teams; i++) {
      res_html += tmp[i];
    }
    res_html += tmp[0];
    $('#teams').html(res_html);
  } else {
    var compact_html = '';
    if (tmp[1] != '') {
      compact_html += '<div class="custom-team-container"><h4>参赛者</h4>' + tmp[1] + '</div>';
    }
    if (tmp[0] != '') {
      compact_html += '<div class="custom-team-container"><h4>观众席</h4>' + tmp[0] + '</div>';
    }
    $('#teams').html(compact_html);
  }

  deploy_queued = Boolean(data.update_queued);
  refreshDeployBanner();
  if (!roomRunning && deploy_queued) {
    // 部署更新排队期间禁止开新局：开始按钮禁用并提示。
    $('#force-start').css('display', 'block');
    $('#force-start').prop('disabled', true);
    $('#force-start').attr('class', '');
    $('#force-start').html('系统即将排队更新，请稍等');
  } else if (
    !roomRunning &&
    data.players.filter(function (player) {
      return player.team !== 0;
    }).length >= 2
  ) {
    $('#force-start').css('display', 'block');
    $('#force-start').prop('disabled', false);
    var counts = data.ready_counts || {};
    var countText = ['human', 'ai']
      .filter(function (kind) {
        return counts[kind] && counts[kind].total > 0;
      })
      .map(function (kind) {
        return (kind === 'human' ? '真人' : 'AI') + ' ' + counts[kind].ready + '/' + counts[kind].need;
      })
      .join('，');
    $('#force-start').html('我准备好了');
    $('#force-start').attr('title', countText);
    $('#ready-counts').text(countText).show();
  } else {
    ready_state = 0;
    $('#force-start').css('display', 'none');
    $('#ready-counts').hide();
    $('#force-start').prop('disabled', false);
  }
  if (
    !roomRunning &&
    !deploy_queued &&
    data.players.filter(function (player) {
      return player.team !== 0;
    }).length >= 2 &&
    ready_state
  ) {
    $('#force-start').attr('class', 'inverted');
  } else {
    $('#force-start').attr('class', '');
  }

  // 检测新玩家进房：对比上一份 uid 快照（含观战席），页面在后台时弹浏览器通知。
  // 首帧只建立快照不通知；自己进房不通知。
  var curUids = [];
  for (var i = 0; i < data.players.length; i++) {
    curUids.push(data.players[i].uid);
  }
  if (prev_room_uids !== null) {
    var joined = [];
    for (var i = 0; i < curUids.length; i++) {
      if (prev_room_uids.indexOf(curUids[i]) === -1 && curUids[i] !== account_name) {
        joined.push(curUids[i]);
      }
    }
    if (joined.length > 0) {
      notifyEvent('room-join-' + room_id, 'Roka', joined.join('、') + ' 进入了房间「' + room_id + '」');
    }
  }
  prev_room_uids = curUids;
});

$(document).ready(function () {
  $('#tabs-game-speed').each(function () {
    for (var i = 1; i < this.children.length; i++) {
      initTab(this, this.children[i], function () {
        updateConfPatch({ speed: parseFloat(getTabVal('game-speed')) });
      });
    }
  });
  $('#tabs-map-mode').each(function () {
    for (var i = 1; i < this.children.length; i++) {
      initTab(this, this.children[i], function () {
        refreshMapInputHint();
        updateConfPatch({ map_mode: getMapModeCode() });
      });
    }
  });
  $('#tabs-map-region').each(function () {
    for (var i = 1; i < this.children.length; i++) {
      initTab(this, this.children[i], function () {
        updateConfPatch({ map_region: getMapRegionCode() });
      });
    }
  });
  $('#tabs-team-mode').each(function () {
    for (var i = 1; i < this.children.length; i++) {
      initTab(this, this.children[i], function () {
        updateConfPatch({ allow_team: getAllowTeamModeCode() });
      });
    }
  });
  $('#tabs-fog-mode').each(function () {
    for (var i = 1; i < this.children.length; i++) {
      initTab(this, this.children[i], function () {
        updateConfPatch({ fog: getFogModeCode() });
      });
    }
  });
  $('#tabs-multi-line-mode').each(function () {
    for (var i = 1; i < this.children.length; i++) {
      initTab(this, this.children[i], function () {
        updateConfPatch({ multi_line: getMultiLineModeCode() });
      });
    }
  });
  $('#tabs-map-size').each(function () {
    for (var i = 1; i < this.children.length; i++) {
      initTab(this, this.children[i], function () {
        updateConfPatch({ map_size: getMapSizeCode() });
      });
    }
  });
  $('#tabs-custom-team').each(function () {
    for (var i = 1; i < this.children.length; i++) {
      initTab(this, this.children[i], updateTeam);
    }
  });
  $('#tabs-spectate-mode').each(function () {
    for (var i = 1; i < this.children.length; i++) {
      initTab(this, this.children[i], updateSpectateMode);
    }
  });
  // 「全图」tab 常驻 DOM 只绑一次；玩家 tab 由 refreshSpectateViewTabs 生成时绑定。
  $('#tabs-spectate-view').each(function () {
    initTab(this, this.children[1], onSpectateViewTab);
  });
  $('#force-start').on('click', function () {
    // 部署更新排队期间禁止开新局（服务端 change_ready 同样拦截兜底）。
    if (deploy_queued) return;
    ready_state ^= 1;
    socket.emit('change_ready', { ready: ready_state });
  });
  // 种子仅在失焦（change）时上传：删空后由服务端补随机种子并回填，避免输入中途被覆盖。
  $('#map-token').on('change', delayUpdateMapToken);
  $('#room-link-display').on('click', copyRoomLink);
  $('#room-home-btn').on('click', _exit);
});

socket.on('left', function () {
  $('#menu').css('display', '');
  setRoomTopLeftVisible(true);
  $('#game').css('display', 'none');
  $('#game-leaderboard').css('display', 'none');
  $('#turn-counter').css('display', 'none');
  $('#chat-messages-container').html('');
  $('#status-alert').css('display', 'none');
  $($('#status-alert').children()[0].children[6]).css('display', 'none');
  hideSurrenderAlert();
  ready_state = 0;
  in_game = false;
  game_ended = false;
  replay_id = false;
  // 离开对局：清空聊天色块门闸用的对局排行榜，回到房间准备阶段口径。
  gameLeaderboard = null;
  refreshDeployBanner();
  refreshSpectateMode();
});

$(document).ready(function () {
  var collapsed = true;
  $('#chat-messages-container').attr('class', 'minimized');
  $('#chatroom-input').attr('class', 'minimized');
  $('#chat-messages-container').on('click', function () {
    collapsed = !collapsed;
    $('#chat-messages-container').attr('class', collapsed ? 'minimized' : '');
    $('#chatroom-input').attr('class', collapsed ? 'minimized' : '');
  });
  // 连续进出类系统消息折叠状态（issue #113）：仅当新消息直接接在折叠元素之后时合并，
  // 中间插入任何其他消息（普通聊天、开局/设置提示等）即断开，各自正常显示。
  var chatFoldEl = null;
  var chatFoldState = null;
  socket.on('chat_message', function (data) {
    // 用户名色块三门闸：「在房间且参战」才给色——
    // 1) 跨房转发的消息（带 room 字段）是房外的人，不显示色块；
    // 2) 对局中：以排行榜为准，在榜且未淘汰（class_ != 'dead'）的参赛者显示其分配颜色；
    // 3) 房间准备阶段：以 room_update 的成员队伍表为准，参赛席（team > 0）显示座位色，
    //    观战席或不在房间不显示。
    // 注意：色块是局内分配色（.cN），与用户名链接本身的 rating 颜色（rt-*）职责分开。
    var chatColor = 0;
    if (data.color && !data.room) {
      if (gameLeaderboard) {
        for (var i = 0; i < gameLeaderboard.length; i++) {
          if (gameLeaderboard[i].uid === data.sender && gameLeaderboard[i].class_ != 'dead') {
            chatColor = gameLeaderboard[i].id;
            break;
          }
        }
      } else if (roomMemberTeams[data.sender] > 0) {
        chatColor = data.color;
      }
    }
    var $p = $('<p class="chat-message"></p>');
    if (data.team) {
      $p.append($('<span style="font-family:Quicksand-Bold,HYMaQiDuo-Bold"></span>').text(teamPrefix));
    }
    if (chatColor) {
      $p.append($('<span class="inline-color-block c' + chatColor + '"></span>'));
    }
    if (data.color || data.sender) {
      // 有发送者但不满足给色条件（房外/观战/已淘汰）：保留用户名，只去掉色块。
      // 用户名：统一用户名组件（rating 颜色 + 点击跳主页），接口不带颜色时先 rt-unrated 渲染。
      $p.append(usernameLink(data.sender, null, 'username'), $('<span></span>').text(': ' + data.text));
      usernameEnsureColors([data.sender]);
      chatFoldEl = null;
      chatFoldState = null;
    } else {
      var $container = $('#chat-messages-container');
      if (data.fold) {
        if (chatFoldEl && $container.children().last().is(chatFoldEl)) {
          // 上一条仍是未被打断的折叠元素：就地合并更新文案，不新增消息行。
          chatFoldState = chatFoldAppend(chatFoldState, data.fold);
          chatFoldEl.text(chatFoldState.text);
          $container.scrollTop(233333);
          return;
        }
        chatFoldState = chatFoldAppend(null, data.fold);
        chatFoldEl = $p;
      } else {
        chatFoldEl = null;
        chatFoldState = null;
      }
      $p.addClass('server-chat-message').text(chatFoldState ? chatFoldState.text : data.text);
    }
    $('#chat-messages-container').append($p);
    $('#chat-messages-container').scrollTop(233333);
  });
  $('#chatroom-input').on('keydown', function (data) {
    if (data.keyCode != 13) return;
    data.preventDefault();
    data.stopPropagation();
    submitChatInput();
  });
  $('#chatroom-input').focus(function () {
    chat_focus = true;
  });
  $('#chatroom-input').blur(function () {
    chat_focus = false;
    is_team = false;
    checkChat();
  });
  $('#chatroom-input').on('change', checkChat);
  $('#chatroom-input').on('input', checkChat);
  $($('#status-alert').children()[0].children[2]).on('click', function (e) {
    $('#status-alert').css('display', 'none');
  });
  $($('#status-alert').children()[0].children[4]).on('click', function (e) {
    if (lost && !game_ended) {
      // 战败且对局未结束时该按钮为「观战」：仅关闭弹窗、留在房间内继续观战；
      // 对局彻底结束后按钮变为「返回房间」，走下方 return_room。
      $('#status-alert').css('display', 'none');
    } else {
      socket.emit('return_room');
    }
  });
  $($('#status-alert').children()[0].children[6]).on('click', function (e) {
    window.open('/replays/' + encodeURIComponent(replay_id), '_blank');
  });
  $($('#status-alert').children()[0].children[8]).on('click', _exit);
  $('#surrender-confirm').on('click', function () {
    if (!canSurrender()) {
      hideSurrenderAlert();
      return;
    }
    hideSurrenderAlert();
    socket.emit('surrender');
  });
  $('#surrender-cancel').on('click', hideSurrenderAlert);
});
