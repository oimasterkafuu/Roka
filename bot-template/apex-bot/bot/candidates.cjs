'use strict';
const { preview, computePush } = require('./rules.cjs');
const { connectedToAnchor } = require('./board.cjs');
function candidates(board) {
  const out = [], connected = connectedToAnchor(board);
  for (let i = 0; i < board.size; i++) {
    if (!board.own(i) || board.isolated[i] || !connected.has(i)) continue;
    const from = board.xy(i);
    if (board.army[i] > 1) for (const j of board.neighbors(i)) {
      if (!board.visible[j] || ['unknown', 'mountain'].includes(board.kind(j))) continue;
      const to = board.xy(j), sends = new Set();
      for (const mode of [0, 1, 2]) {
        const send = computePush(board, i, j, mode);
        if (send <= 0 || sends.has(send)) continue;
        sends.add(send);
        out.push({ kind: 'attack', ...from, dx: to.x, dy: to.y, mode });
      }
    }
    if (board.army[i] >= 50 && ['city', 'land'].includes(board.kind(i))) {
      const a = { kind: 'build', ...from, op: board.kind(i) === 'city' ? 'c' : 'b' };
      if (preview(board, a).ok) out.push(a);
    }
  }
  return out;
}
module.exports = { candidates };
