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

function normalizeMapTokenInput(token) {
  return String(token || '').slice(0, map_token_max_length);
}
