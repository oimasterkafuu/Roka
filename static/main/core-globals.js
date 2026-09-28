function htmlescape(x) {
  return $('<div>').text(x).html();
}

const dire = [
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
];
const dire_char = ['↑', '↓', '←', '→'];
const dire_class = ['arrow_u', 'arrow_d', 'arrow_l', 'arrow_r'];
const map_token_max_length = 32;
const replay_binary_magic = [0x52, 0x50, 0x42, 0x34]; // RPB4（meta 追加 fog 标志，供回放视角选择）
const replay_binary_magic_v3 = [0x52, 0x50, 0x42, 0x33]; // RPB3（旧格式，meta 无 fog 标志）
const replay_binary_magic_v2 = [0x52, 0x50, 0x42, 0x32]; // RPB2（旧格式，含 surrender_progress 字段）
const replay_binary_magic_v1 = [0x52, 0x50, 0x42, 0x31]; // RPB1（旧格式，无 isolated 字段）
const replay_class_from_code = ['', 'dead', 'afk'];
const replay_text_decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

// 回放视角：0 = 全知（默认），>0 = 该队伍编号（仅迷雾对局的回放可切换）。
var replay_view_team = 0;

// 实时观战视角（仅迷雾对局）：0 = 全图（默认），>0 = 所选玩家的队伍编号，
// 服务端按该队伍可见性下发迷雾帧（语义对齐回放视角 replay_view_team）。
var spectate_view_team = 0;
// 当前对局是否为迷雾局：由 update 帧是否携带 fog 字段判定（无迷雾局不显示视角选择）。
var fog_mode = false;
// 自己在房间里的队伍（0 = 观战席），由 room_update 维护，用于判定观战视角资格。
var self_team = 0;

function normalizeMapTokenInput(token) {
  return String(token || '').slice(0, map_token_max_length);
}

// 迷雾局观战/回放共享的名称显示规则（回放与观战两条链路共用，勿各写一套）：
// 组队局（存在 ≥2 人的队伍）只显示队伍名「队伍 N」，非组队局照常显示用户名；
// 存活参赛玩家自己的视角不受影响（fogObserverView 仅对观战/回放为真）。

// 组队局判定：任一队伍编号出现 ≥2 次。接受队伍编号数组或含 team 字段的条目数组。
function fogTeamGame(entries) {
  var counts = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var t = Number(e != null && typeof e == 'object' ? e.team : e);
    if (!(t > 0)) continue;
    counts[t] = (counts[t] || 0) + 1;
    if (counts[t] >= 2) return true;
  }
  return false;
}

function fogTeamName(team) {
  return '队伍 ' + team;
}

// 终局名次比较器：与服务端 src/game-engine/leaderboard.ts 的 compareFinalRank
// 逐字一致（存活者优先；出局者按 dead 降序——死得晚名次高；再按 land、army 降序决胜）。
// leaderboard 条目的 dead 为出局序号（0 = 存活）。
function replayFinalRankCompare(a, b) {
  var aliveA = a.dead === 0 ? 1 : 0;
  var aliveB = b.dead === 0 ? 1 : 0;
  if (aliveA !== aliveB) return aliveB - aliveA;
  if (a.dead !== b.dead) return b.dead - a.dead;
  if (a.land !== b.land) return b.land - a.land;
  return b.army - a.army;
}

// 终局名次的队伍分组投影：按 replayFinalRankCompare 排出个人全序后按 team 分组
// （保持全序相对顺序）。返回 [{team, members}]，组序即队伍名次序——整队存活者在前，
// 全灭队以队内最后死亡成员为准；组内成员顺序即个人名次序。非组队局每队一人，
// 天然退化为个人名次序。
function replayFinalRankGroups(entries) {
  var sorted = entries.slice().sort(replayFinalRankCompare);
  var groups = [];
  var groupIndex = {};
  for (var i = 0; i < sorted.length; i++) {
    var e = sorted[i];
    if (typeof groupIndex[e.team] == 'undefined') {
      groupIndex[e.team] = groups.length;
      groups.push({ team: e.team, members: [e] });
    } else {
      groups[groupIndex[e.team]].members.push(e);
    }
  }
  return groups;
}

// 统一显示名：组队局取队伍名，非组队局取用户名。
function fogDisplayName(uid, team, teamGame) {
  return teamGame ? fogTeamName(team) : uid;
}

// 当前是否处于迷雾局的观战/回放视角（存活参赛者视角为 false，名称显示不受影响）。
function fogObserverView() {
  if (typeof is_replay != 'undefined' && is_replay) {
    return Boolean(
      typeof replay_data != 'undefined' && replay_data && replay_data.meta && replay_data.meta.fog,
    );
  }
  return fog_mode && player == 0;
}
