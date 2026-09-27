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
