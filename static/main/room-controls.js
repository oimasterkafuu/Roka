function joinGameRoom() {
  if (room_id != '') {
    socket.emit('join_game_room', { room: room_id });
  }
}

function getRoomLink() {
  return location.origin + location.pathname;
}

function refreshRoomLinkDisplay() {
  var link = getRoomLink();
  var text = htmlescape(link);
  if (room_id && link.substr(link.length - room_id.length) == room_id) {
    var prefix = link.substr(0, link.length - room_id.length);
    text = htmlescape(prefix) + '<b>' + htmlescape(room_id) + '</b>';
  }
  $('#room-link-text').html(text);
  $('#room-link-display').attr('data-link', link);
}

function copyTextFallback(text) {
  var textarea = $('<textarea readonly></textarea>');
  textarea.css({ position: 'fixed', top: '-1000px', left: '-1000px' });
  textarea.val(text);
  $('body').append(textarea);
  textarea[0].focus();
  textarea[0].select();
  var copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {}
  textarea.remove();
  return copied;
}

function showRoomLinkCopied() {
  clearTimeout(room_link_copy_timer);
  $('#room-link-copied').stop(true, true).css('display', 'inline');
  room_link_copy_timer = setTimeout(function () {
    $('#room-link-copied').fadeOut(150);
  }, 1200);
}

async function copyRoomLink() {
  var link = $('#room-link-display').attr('data-link') || getRoomLink();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(link);
      showRoomLinkCopied();
      return;
    }
  } catch {}
  if (copyTextFallback(link)) {
    showRoomLinkCopied();
  }
}

function isHuaxiaSeasonActiveClient() {
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  var month = Number(
    parts.find(function (part) {
      return part.type == 'month';
    }).value,
  );
  var day = Number(
    parts.find(function (part) {
      return part.type == 'day';
    }).value,
  );
  return month == 10 && day >= 1 && day <= 7;
}

function refreshHuaxiaAvailability() {
  var active = isHuaxiaSeasonActiveClient();
  $('[data-map-mode="huaxia"]').css('display', active ? '' : 'none');
  if (!active && getTabVal('map-mode') == '华夏系列') {
    setTabVal('map-mode', '标准地图');
  }
}

function getMapModeCode() {
  refreshHuaxiaAvailability();
  var mapMode = getTabVal('map-mode');
  if (mapMode == '峡谷回廊') return 'maze';
  if (mapMode == '群岛要塞') return 'archipelago';
  if (mapMode == '地中海') return 'mediterranean';
  if (mapMode == '华夏系列') return 'huaxia';
  return 'random';
}

function getMapRegionCode() {
  var regions = {
    秦: 'qin',
    汉: 'han',
    唐: 'tang',
    宋: 'song',
    元: 'yuan',
    明: 'ming',
    辽: 'liao',
    中国: 'china',
    台湾省: 'taiwan',
  };
  return regions[getTabVal('map-region')] || 'han';
}

function setMapModeByCode(code) {
  if (code == 'huaxia' && isHuaxiaSeasonActiveClient()) {
    setTabVal('map-mode', '华夏系列');
    return;
  }
  if (code == 'maze') {
    setTabVal('map-mode', '峡谷回廊');
    return;
  }
  if (code == 'archipelago') {
    setTabVal('map-mode', '群岛要塞');
    return;
  }
  if (code == 'mediterranean') {
    setTabVal('map-mode', '地中海');
    return;
  }
  setTabVal('map-mode', '标准地图');
}

function setMapRegionByCode(code) {
  var labels = {
    qin: '秦',
    han: '汉',
    tang: '唐',
    song: '宋',
    yuan: '元',
    ming: '明',
    liao: '辽',
    china: '中国',
    taiwan: '台湾省',
  };
  setTabVal('map-region', labels[code] || '汉');
}

function refreshMapInputHint() {
  var huaxia = getMapModeCode() == 'huaxia';
  $('#map-region-section').css('display', huaxia ? '' : 'none');
  $('#map-input-label').html(huaxia ? '地图随机种子（可选）：' : '地图随机种子：');
  $('#map-token').attr('placeholder', huaxia ? '华夏地区使用固定地形参数' : '留空将自动生成随机种子');
}

function getAllowTeamModeCode() {
  return getTabVal('team-mode') == '允许';
}

function setAllowTeamModeByCode(allow) {
  setTabVal('team-mode', allow ? '允许' : '不允许');
}

function getFogModeCode() {
  return getTabVal('fog-mode') == '开启';
}

function setFogModeByCode(fog) {
  setTabVal('fog-mode', fog ? '开启' : '关闭');
}

function getMapSizeCode() {
  return getTabVal('map-size') == '大地图' ? 'large' : 'normal';
}

function setMapSizeByCode(size) {
  setTabVal('map-size', size == 'large' ? '大地图' : '标准');
}

function refreshCustomTeamTabs(allowTeam) {
  var tabs = $('#tabs-custom-team')[0];
  if (!tabs) return;

  var firstPlayerTab = tabs.children[1];
  $(firstPlayerTab).html(allowTeam ? '1' : '参赛');
  for (var i = 2; i <= max_teams; i++) {
    $(tabs.children[i]).css('display', allowTeam ? '' : 'none');
  }
}

function setTabGroupReadonly(tabId, readonly) {
  var tabs = $('#' + tabId)[0];
  if (!tabs) return;
  if (readonly) $(tabs).attr('data-readonly', '1');
  else $(tabs).removeAttr('data-readonly');
  var key = tabId.substr(5);
  setTabVal(key, getTabVal(key));
}

function updateConfPatch(patch) {
  if (!patch) return;
  if (Object.keys(patch).length === 0) return;
  socket.emit('change_game_conf', patch);
}

const delayUpdateMapToken = _.debounce(function () {
  var value = normalizeMapTokenInput($('#map-token').val());
  if ($('#map-token').val() != value) {
    $('#map-token').val(value);
  }
  updateConfPatch({ map_token: value.trim() });
}, 300);

function updateTeam() {
  var team = getTabVal('custom-team');
  if (team == '观战') team = 0;
  else if (team == '参赛') team = 1;
  else team = parseInt(team);
  if (isNaN(team)) return;
  socket.emit('change_team', { team: team });
}

// 观战中的「下局模式」选择：仅决定下一局的观战/参与身份（team 0/1），不影响当前对局。
function updateSpectateMode() {
  socket.emit('change_team', { team: getTabVal('spectate-mode') == '观战' ? 0 : 1 });
}

// 观战视角选择（迷雾对局，看齐回放的视角切换）：默认「全图」；组队局 tab 显示
// 队伍名（每队一个「队伍 N」）、非组队局显示各玩家用户名（与回放视角同一套规则，
// 见 core-globals.js），选中后服务端按该队伍的可见性下发迷雾帧。tabs 按排行榜动态生成。
var spectate_view_labels = [];
var spectate_view_teams = {};

// 观战视角资格：迷雾对局中的纯观战者（中途进房/观战席/已战败/终局前），
// 存活参赛者不可切换（服务端同样拒绝，防止借视角窥探他队视野）。
function spectateViewEligible() {
  return !is_replay && in_game && !game_ended && fog_mode && (player == 0 || self_team == 0);
}

function onSpectateViewTab() {
  var val = getTabVal('spectate-view');
  spectate_view_team = val == '全图' ? 0 : spectate_view_teams[val] || 0;
  socket.emit('spectate_view', { team: spectate_view_team });
}

// 按当前排行榜重建视角 tabs（全图 + 各参赛玩家）；仅玩家集合变化时重建以保留选中态。
function refreshSpectateViewTabs(lb) {
  var section = $('#spectate-view-section');
  if (!section.length) return;
  if (!spectateViewEligible() || !Array.isArray(lb)) {
    section.css('display', 'none');
    spectate_view_labels = [];
    return;
  }
  section.css('display', '');
  var teamGame = fogTeamGame(lb);
  var labels = [];
  var teams = {};
  for (var i = 0; i < lb.length; i++) {
    var label = fogDisplayName(lb[i].uid, lb[i].team, teamGame);
    if (typeof teams[label] != 'undefined') continue;
    labels.push(label);
    teams[label] = lb[i].team;
  }
  var key = labels.slice().sort().join('|');
  if (key == spectate_view_labels.slice().sort().join('|')) return;
  spectate_view_labels = labels;
  spectate_view_teams = teams;
  var tabs = $('#tabs-spectate-view')[0];
  if (!tabs) return;
  while (tabs.children.length > 2) {
    tabs.removeChild(tabs.lastChild);
  }
  for (var i = 0; i < labels.length; i++) {
    $(tabs).append($('<div class="inline-button"></div>').text(labels[i]));
  }
  for (var i = 2; i < tabs.children.length; i++) {
    initTab(tabs, tabs.children[i], onSpectateViewTab);
  }
  // 恢复选中态：优先找回同队伍的 tab；找不到则回退全图并通知服务端。
  var selected = '全图';
  if (spectate_view_team > 0) {
    for (var i = 0; i < labels.length; i++) {
      if (teams[labels[i]] == spectate_view_team) {
        selected = labels[i];
        break;
      }
    }
  }
  if (selected == '全图' && spectate_view_team != 0) {
    spectate_view_team = 0;
    socket.emit('spectate_view', { team: 0 });
  }
  setTabVal('spectate-view', selected);
}

function getTabVal(x) {
  return $($('#tabs-' + x)[0].children[0]).val();
}

function setTabVal(x, y) {
  var tabGroup = $('#tabs-' + x)[0];
  if (!tabGroup) return;
  var tabs = tabGroup.children;
  var readonly = $(tabGroup).attr('data-readonly') == '1';
  for (var i = 1; i < tabs.length; i++) {
    var active = $(tabs[i]).html() == y;
    var cls = active ? 'inline-button inverted' : 'inline-button';
    if (readonly) cls += ' readonly';
    $(tabs[i]).attr('class', cls);
  }
  $(tabs[0]).val(y);
}

function initTab(x, y, callback) {
  $(y).on('click', function () {
    var groupKey = $(x).attr('id').substr(5);
    var nextVal = $(y).html();
    if (getTabVal(groupKey) == nextVal) return;
    setTabVal(groupKey, nextVal);
    callback();
  });
}

var chatStr = '';
var teamPrefix = '[队伍] ';

$(document).ready(function () {
  refreshHuaxiaAvailability();
  window.setInterval(refreshHuaxiaAvailability, 60 * 1000);
});

function checkChat() {
  var tmp = $('#chatroom-input').val(),
    res;
  if (is_team) {
    if (tmp.substr(0, teamPrefix.length) == teamPrefix) {
      res = tmp.substr(teamPrefix.length);
    } else {
      res = chatStr;
    }
  } else {
    if (tmp.substr(0, teamPrefix.length) == teamPrefix) {
      res = tmp.substr(teamPrefix.length);
    } else {
      res = tmp;
    }
  }
  chatStr = res;
  $('#chatroom-input').val((is_team ? teamPrefix : '') + res);
}
