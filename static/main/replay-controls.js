function backTurn() {
  if (is_autoplaying) switchAutoplay();
  if (!replay_data || !replay_data.patches || cur_turn <= 0) {
    return false;
  }
  var patch = replay_data.patches[cur_turn - 1];
  if (!patch || !patch.backward) {
    return false;
  }
  update(patch.backward);
  cur_turn -= 1;
  return true;
}

function nextTurn(ignore = false) {
  if (is_autoplaying && !ignore) return false;
  if (!replay_data || !replay_data.patches || cur_turn >= replay_data.patches.length) {
    return false;
  }
  var patch = replay_data.patches[cur_turn];
  if (!patch || !patch.forward) {
    return false;
  }
  update(patch.forward);
  cur_turn += 1;
  return true;
}

function jumpToTurn() {
  if (is_autoplaying) switchAutoplay();
  var uturn = String($('#replay-turn-jump-input').val() || '').trim(),
    turn = 0;
  if (!replay_data || !replay_data.patches || !replay_data.initial) {
    return;
  }
  if (!uturn || uturn.length == 0) {
    turn = 0;
  } else if (uturn[uturn.length - 1] == '.') {
    turn = parseInt(uturn.substr(0, uturn.length - 1)) * 2 + 1;
  } else {
    turn = parseInt(uturn) * 2;
  }
  if (isNaN(turn)) {
    return;
  }
  var targetFrame = -1;
  if (replay_data.initial.turn == turn) {
    targetFrame = 0;
  } else {
    for (var i = 0; i < replay_data.patches.length; i++) {
      if (replay_data.patches[i].forward.turn == turn) {
        targetFrame = i + 1;
        break;
      }
    }
  }
  if (targetFrame < 0) {
    return;
  }
  jumpToFrame(targetFrame);
}

// 跳转到指定帧下标（0 = 初始帧，k = 应用第 k 个 forward patch 之后），
// 统计图游标点击/拖动经此跳转（见 replay-stats.js）。
function jumpToFrame(targetFrame) {
  if (!replay_data || !replay_data.patches || !replay_data.initial) {
    return;
  }
  targetFrame = Math.max(0, Math.min(replay_data.patches.length, Math.floor(targetFrame)));
  if (targetFrame == cur_turn) {
    return;
  }
  if (is_autoplaying) switchAutoplay();
  while (cur_turn < targetFrame) {
    if (!nextTurn(true)) break;
  }
  while (cur_turn > targetFrame) {
    if (!backTurn()) break;
  }
}

function switchAutoplay(keepRateTabsVisible = false) {
  var autoplayBtn = $('#replay-autoplay-btn');
  is_autoplaying = !is_autoplaying;
  if (!is_autoplaying) {
    autoplayBtn.attr('class', 'small');
    $('#tabs-replay-autoplay').css('display', keepRateTabsVisible ? 'inline-block' : 'none');
    return;
  }
  autoplayBtn.attr('class', 'small inverted');
  $('#tabs-replay-autoplay').css('display', 'inline-block');
  setTimeout(autoplay, 500 / autoplay_speed);
}

function autoplay() {
  if (!is_autoplaying) return;
  if (!nextTurn(true)) {
    switchAutoplay(true);
    return;
  }
  setTimeout(autoplay, 500 / autoplay_speed);
}

function setAutoplayRate() {
  var tmp = $($('#tabs-replay-autoplay')[0].children[0]).val();
  autoplay_speed = parseFloat(tmp.substr(0, tmp.length - 1));
}

// 回放视角 tab 标签 → 队伍编号（组队局标签为「队伍 N」，非组队局为玩家用户名）。
var replay_view_teams = {};

function onReplayViewTab() {
  var val = getTabVal('replay-view');
  setReplayViewTeam(val == '全知' ? 0 : replay_view_teams[val] || 0);
}

// 切换回放视角（0 = 全知，>0 = 队伍编号）：重算迷雾遮罩并立即重绘当前帧。
function setReplayViewTeam(team) {
  replay_view_team = team;
  applyReplayFogView();
  render();
}

// 迷雾对局的回放提供视角选择器（全知 + 各参赛队伍）；未开启迷雾的回放不显示。
// 组队局 tab 显示队伍名（每队一个「队伍 N」），非组队局显示各玩家用户名
// （与观战视角同一套规则，见 core-globals.js）。
function initReplayViewTabs() {
  var section = $('#replay-view-section');
  var tabs = $('#tabs-replay-view')[0];
  if (!tabs) return;
  // 复位为仅含「全知」（回放页每次加载只进一次，防御性清理）。
  while (tabs.children.length > 2) {
    tabs.removeChild(tabs.lastChild);
  }
  replay_view_team = 0;
  replay_view_teams = {};
  setTabVal('replay-view', '全知');
  var meta = replay_data && replay_data.meta;
  if (!meta || !meta.fog || !Array.isArray(meta.player_teams)) {
    section.css('display', 'none');
    return;
  }
  var teamGame = fogTeamGame(meta.player_teams);
  var entries = [];
  for (var i = 0; i < meta.player_teams.length; i++) {
    var t = Number(meta.player_teams[i]);
    if (!(t > 0)) continue;
    var name = meta.player_names && meta.player_names[i] ? String(meta.player_names[i]) : fogTeamName(t);
    var label = fogDisplayName(name, t, teamGame);
    if (typeof replay_view_teams[label] != 'undefined') continue;
    replay_view_teams[label] = t;
    entries.push({ label: label, team: t });
  }
  entries.sort(function (a, b) {
    return a.team - b.team;
  });
  if (!entries.length) {
    section.css('display', 'none');
    return;
  }
  for (var k = 0; k < entries.length; k++) {
    $(tabs).append($('<div class="inline-button"></div>').text(entries[k].label));
  }
  for (var i = 1; i < tabs.children.length; i++) {
    initTab(tabs, tabs.children[i], onReplayViewTab);
  }
  section.css('display', '');
}

function _exit() {
  if (typeof allow_page_leave != 'undefined') {
    allow_page_leave = true;
  }
  location.href = '/';
}

function canSurrender() {
  return in_game && !is_replay && player > 0 && !lost;
}

function showSurrenderAlert() {
  if (!canSurrender()) {
    hideSurrenderAlert();
    return;
  }
  $('#surrender-alert').css('display', '');
}

function hideSurrenderAlert() {
  $('#surrender-alert').css('display', 'none');
}
