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
const replay_binary_magic = [0x52, 0x50, 0x42, 0x33]; // RPB3（移除 surrender_progress 字段）
const replay_binary_magic_v2 = [0x52, 0x50, 0x42, 0x32]; // RPB2（旧格式，含 surrender_progress 字段）
const replay_binary_magic_v1 = [0x52, 0x50, 0x42, 0x31]; // RPB1（旧格式，无 isolated 字段）
const replay_class_from_code = ['', 'dead', 'afk'];
const replay_text_decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function normalizeMapTokenInput(token) {
  return String(token || '').slice(0, map_token_max_length);
}
