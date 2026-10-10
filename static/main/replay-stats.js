// 回放页增强：参赛者标题区（组队合并显示）+ 局势统计图（排行榜下方）。
// 数据来源：回放每帧自带的 leaderboard（initial 与每个 forward patch 均含
// 完整的兵力/领土计数），无需扫描棋盘，预计算复杂度 O(帧数 × 玩家数)。

// 统计图内部分组序列：组队局按队伍聚合，非组队局按玩家各自成组。
var replay_stats_groups = null;
// 全程兵力/领土最大位数（buildReplayStatsGroups 预计算，issue #93）：
// 供排行榜列宽预锁定（initReplayStats）与统计图数值标注的预留排版。
var replay_stats_max_digits = { army: 1, land: 1 };
// 当前帧游标位置对应的缓存画布（坐标轴与曲线只需画一次，逐帧只补游标竖线）。
var replay_stats_base = null;
var replay_stats_seeking = false;
// 颜色未就绪时的底图重绘重试计数（见 drawReplayStatsBase）。
var replay_stats_color_retry = 0;

// 读取地图格子的玩家配色（map.css 的 .c1~.c17），供 canvas 使用。
// 注意：回放数据可能先于样式表到达（fetch 与 CSS 并行），此时 .cN 规则尚未生效，
// getComputedStyle 返回透明色——透明结果绝不写入缓存（否则底图曲线永久不可见），
// 由 drawReplayStatsBase 的颜色就绪检查稍后重试。
var replay_color_cache = {};
function replayPlayerColor(id) {
  if (replay_color_cache[id]) return replay_color_cache[id];
  var el = $('<span class="c' + id + '"></span>')
    .css('display', 'none')
    .appendTo('body');
  var color = el.css('background-color');
  el.remove();
  if (!color || color == 'transparent' || color == 'rgba(0, 0, 0, 0)') {
    return '#253042';
  }
  replay_color_cache[id] = color;
  return color;
}

// 回放页标题区：同队成员逗号分隔、队伍之间「>」分隔（如 alice, bob > carol）。
// 组间顺序为终局名次序（replayFinalRankGroups，口径与服务端 buildFinalRank 一致），
// 不再按队号排序。迷雾组队局沿用 fog-team-names 规则：只显示队名「队伍 N」，不列成员用户名。
function initReplayTitle() {
  var lb0 = replay_data && replay_data.initial && replay_data.initial.leaderboard;
  if (!is_replay || !lb0 || !lb0.length || window.innerWidth <= 1000) return;
  var teamGame = fogTeamGame(lb0);
  var fogView = Boolean(replay_data.meta && replay_data.meta.fog);
  // 终局名次取自末帧 leaderboard（最后一个 forward patch；无 patch 时用 initial），
  // 其 dead 字段为出局序号、team 为队伍归属，足以现算与 rating 清算一致的名次。
  var lastLb = lb0;
  var patches = replay_data.patches || [];
  if (patches.length && patches[patches.length - 1].forward.leaderboard) {
    lastLb = patches[patches.length - 1].forward.leaderboard;
  }
  var groups = replayFinalRankGroups(lastLb);
  var parts = [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (teamGame && fogView) {
      parts.push(htmlescape(fogTeamName(g.team)));
      continue;
    }
    var names = [];
    for (var j = 0; j < g.members.length; j++) {
      // 成员名：统一用户名组件（rating 颜色 + 点击跳主页），不展示玩家配色色块。
      names.push(usernameLinkHtml(g.members[j].uid));
    }
    parts.push(names.join(', '));
  }
  // 标题区参赛者名接口不带 rating 颜色：批量补色（全局缓存，链接渲染后自动刷新）。
  usernameEnsureColors(
    lastLb.map(function (entry) {
      return entry.uid;
    }),
  );
  $('#replay-title').html(parts.join(' &gt; '));
  $('#replay-title').css('display', '');
}

// 预计算各组每帧的兵力/领土序列（帧 0 = initial，帧 k = 第 k 个 forward patch）。
function buildReplayStatsGroups() {
  var lb0 = replay_data.initial.leaderboard || [];
  var teamGame = fogTeamGame(lb0);
  var frames = replay_data.patches.length + 1;
  var groups = [];
  var groupIndex = {};
  for (var i = 0; i < lb0.length; i++) {
    var key = teamGame ? 't' + lb0[i].team : 'p' + lb0[i].id;
    if (typeof groupIndex[key] != 'undefined') continue;
    groupIndex[key] = groups.length;
    groups.push({
      key: key,
      label: teamGame ? fogTeamName(lb0[i].team) : String(lb0[i].uid),
      colorId: lb0[i].id,
      army: new Array(frames).fill(0),
      land: new Array(frames).fill(0),
    });
  }
  // 组队局颜色取队内最小玩家 id（与标题区一致）。
  if (teamGame) {
    for (var i = 0; i < lb0.length; i++) {
      var g = groups[groupIndex['t' + lb0[i].team]];
      g.colorId = Math.min(g.colorId, lb0[i].id);
    }
  }
  function absorb(lb, frame) {
    for (var i = 0; i < lb.length; i++) {
      var g = groups[groupIndex[teamGame ? 't' + lb[i].team : 'p' + lb[i].id]];
      if (!g) continue;
      g.army[frame] += lb[i].army;
      g.land[frame] += lb[i].land;
    }
  }
  absorb(lb0, 0);
  for (var f = 1; f < frames; f++) {
    absorb(replay_data.patches[f - 1].forward.leaderboard || [], f);
  }
  // 顺手统计全程兵力/领土最大位数（issue #93）：分组口径与排行榜显示一致
  // （组队局=团队合计、非组队局=个人），供列宽预锁定与数值标注排版。
  replay_stats_max_digits = { army: 1, land: 1 };
  for (var i = 0; i < groups.length; i++) {
    for (var f = 0; f < frames; f++) {
      replay_stats_max_digits.army = Math.max(replay_stats_max_digits.army, String(groups[i].army[f]).length);
      replay_stats_max_digits.land = Math.max(replay_stats_max_digits.land, String(groups[i].land[f]).length);
    }
  }
  return groups;
}

// 居中滑动窗口平均：兵力会因截断折半等瞬时暴跌，平滑后曲线更可读；
// 原始值另以浅色底层保留，便于对照真实拐点。
function smoothSeries(values, radius) {
  var len = values.length;
  var out = new Array(len);
  for (var i = 0; i < len; i++) {
    var sum = 0,
      cnt = 0;
    for (var k = Math.max(0, i - radius); k <= Math.min(len - 1, i + radius); k++) {
      sum += values[k];
      cnt += 1;
    }
    out[i] = sum / cnt;
  }
  return out;
}

function replayStatsMetric() {
  return getTabVal('replay-stats') == '领土' ? 'land' : 'army';
}

// 绘制坐标底图（网格 + 各组原始/平滑曲线）到离屏画布，供逐帧游标复用。
function drawReplayStatsBase() {
  var canvas = $('#replay-stats-canvas')[0];
  if (!canvas || !replay_stats_groups) return;
  var dpr = window.devicePixelRatio || 1;
  var cssW = 248,
    cssH = 132;
  if (canvas.width != cssW * dpr || canvas.height != cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
  }
  var frames = replay_data.patches.length + 1;
  if (frames < 2 || !replay_stats_groups.length) return;
  var i, g;
  // 颜色就绪检查：样式表（map.css 的 .cN）未加载完时绘制会得到全 fallback 色底图，
  // 此时放弃本次绘制并稍后重试（replayPlayerColor 对透明结果不入缓存，重试即真色）；
  // 检查须先于底图重建，避免未就绪时清掉旧底图。
  for (i = 0; i < replay_stats_groups.length; i++) {
    replayPlayerColor(replay_stats_groups[i].colorId);
  }
  var colorsReady = replay_stats_groups.every(function (grp) {
    return Boolean(replay_color_cache[grp.colorId]);
  });
  if (!colorsReady) {
    replay_stats_color_retry += 1;
    if (replay_stats_color_retry <= 50) {
      setTimeout(function () {
        drawReplayStatsBase();
        refreshReplayStatsFrame();
      }, 100);
    }
    return;
  }
  replay_stats_color_retry = 0;
  if (!replay_stats_base) replay_stats_base = document.createElement('canvas');
  var base = replay_stats_base;
  base.width = canvas.width;
  base.height = canvas.height;
  var ctx = base.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  var metric = replayStatsMetric();
  // 平滑半径随对局长度缩放（约每 120 帧 1 帧，上限 15），短局不动。
  var radius = Math.max(0, Math.min(15, Math.round(frames / 120)));
  var maxVal = 1;
  for (i = 0; i < replay_stats_groups.length; i++) {
    g = replay_stats_groups[i];
    g.smooth = smoothSeries(g[metric], radius);
    for (var f = 0; f < frames; f++) {
      maxVal = Math.max(maxVal, g[metric][f]);
    }
  }
  var padT = 14,
    padB = 4,
    padL = 2,
    padR = 2;
  var plotW = cssW - padL - padR,
    plotH = cssH - padT - padB;
  function xAt(f) {
    return padL + (f / (frames - 1)) * plotW;
  }
  function yAt(v) {
    return padT + plotH - (v / maxVal) * plotH;
  }
  // 网格与最大值刻度。
  ctx.strokeStyle = 'rgba(37, 48, 66, 0.12)';
  ctx.lineWidth = 1;
  for (i = 1; i <= 3; i++) {
    var y = padT + (plotH * i) / 3;
    ctx.beginPath();
    ctx.moveTo(padL, y + 0.5);
    ctx.lineTo(padL + plotW, y + 0.5);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(37, 48, 66, 0.55)';
  ctx.font = '10px Quicksand, sans-serif';
  // 顶部最大值标注按预计算的最大位数预留宽度排版（issue #93）：非等宽字体以
  // 最宽数字「8」估算占位，标注过宽时向右收进绘图区，避免探出边界挤压曲线。
  var maxLabel = formatReplayStatsValue(maxVal);
  var reservedDigits = metric == 'land' ? replay_stats_max_digits.land : replay_stats_max_digits.army;
  var labelW = Math.max(
    ctx.measureText(maxLabel).width,
    ctx.measureText(new Array(reservedDigits + 1).join('8')).width,
  );
  var labelX = padL + 2;
  if (labelX + labelW > padL + plotW) labelX = padL + plotW - labelW;
  ctx.fillText(maxLabel, labelX, padT - 4);
  for (i = 0; i < replay_stats_groups.length; i++) {
    g = replay_stats_groups[i];
    var color = replayPlayerColor(g.colorId);
    // 原始值浅色底层。
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var f = 0; f < frames; f++) {
      var x = xAt(f),
        y = yAt(g[metric][f]);
      if (f == 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // 平滑主曲线。
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (var f = 0; f < frames; f++) {
      var x = xAt(f),
        y = yAt(g.smooth[f]);
      if (f == 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function formatReplayStatsValue(v) {
  if (v >= 10000) return (v / 1000).toFixed(0) + 'k';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
}

// 每帧钩子（render-update.js 的 update() 调用）：底图 blit + 当前进度竖线游标，
// 并把统计图面板贴到排行榜正下方（排行榜高度随队伍层级变化）。
function refreshReplayStatsFrame() {
  if (!is_replay || !replay_stats_groups || !replay_stats_base) return;
  var panel = $('#replay-stats');
  if (panel.css('display') == 'none') return;
  var lbH = $('#game-leaderboard').outerHeight() || 0;
  panel.css('top', lbH + 8 + 'px');
  var canvas = $('#replay-stats-canvas')[0];
  var ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(replay_stats_base, 0, 0);
  var dpr = window.devicePixelRatio || 1;
  var frames = replay_data.patches.length + 1;
  if (frames < 2) return;
  var cssW = 248,
    padL = 2,
    padR = 2,
    padT = 14,
    padB = 4;
  var x = (padL + (cur_turn / (frames - 1)) * (cssW - padL - padR)) * dpr;
  ctx.strokeStyle = 'rgba(0, 128, 128, 0.9)';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(x, (padT - 8) * dpr);
  ctx.lineTo(x, (132 - padB) * dpr);
  ctx.stroke();
}

function seekReplayStats(clientX) {
  var canvas = $('#replay-stats-canvas')[0];
  var rect = canvas.getBoundingClientRect();
  var frac = (clientX - rect.left) / rect.width;
  frac = Math.max(0, Math.min(1, frac));
  var frames = replay_data.patches.length + 1;
  jumpToFrame(Math.round(frac * (frames - 1)));
}

function onReplayStatsTab() {
  drawReplayStatsBase();
  refreshReplayStatsFrame();
}

function initReplayStats() {
  if (!is_replay || !replay_data || !replay_data.patches || !replay_data.initial) return;
  if (window.innerWidth <= 1000) return;
  replay_stats_groups = buildReplayStatsGroups();
  if (!replay_stats_groups.length) return;
  // 排行榜兵力/领土列宽一次锁定到全程最大位数（issue #93），
  // 回放跳转/倒退也不会引起列宽变化（逐帧 update() 的锁定只增不减）。
  lb_lock_digits.army = Math.min(LB_LOCK_DIGITS_MAX, replay_stats_max_digits.army);
  lb_lock_digits.land = Math.min(LB_LOCK_DIGITS_MAX, replay_stats_max_digits.land);
  applyLeaderboardColumnLock();
  var legend = [];
  var legendTeamGame = fogTeamGame(replay_data.initial.leaderboard || []);
  for (var i = 0; i < replay_stats_groups.length; i++) {
    var g = replay_stats_groups[i];
    // 非组队局图例是用户名：统一用户名组件；组队局图例是队名「队伍 N」，保持纯文本。
    var labelCell = legendTeamGame ? htmlescape(g.label) : usernameLinkHtml(g.label);
    legend.push(
      '<span class="replay-stats-legend-item"><span class="inline-color-block c' +
        g.colorId +
        '"></span>' +
        labelCell +
        '</span>',
    );
  }
  $('#replay-stats-legend').html(legend.join(''));
  setTabVal('replay-stats', '兵力');
  $('#tabs-replay-stats').each(function () {
    for (var i = 1; i < this.children.length; i++) {
      initTab(this, this.children[i], onReplayStatsTab);
    }
  });
  var canvas = $('#replay-stats-canvas')[0];
  $(canvas).on('mousedown', function (e) {
    replay_stats_seeking = true;
    seekReplayStats(e.clientX);
    e.preventDefault();
  });
  $(document).on('mousemove.replay-stats', function (e) {
    if (replay_stats_seeking) seekReplayStats(e.clientX);
  });
  $(document).on('mouseup.replay-stats', function () {
    replay_stats_seeking = false;
  });
  drawReplayStatsBase();
  $('#replay-stats').css('display', '');
  refreshReplayStatsFrame();
}
