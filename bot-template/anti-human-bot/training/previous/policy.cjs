'use strict';
const { chooseMove } = require('./planner.cjs');
const { chooseBuild } = require('./building.cjs');
// 无合法/有益行动返回 null；payload 与现有客户端坐标、op 协议一致。
function chooseAction(state, params = {}) {
  if (!state || state.ended || state.dead) return null;
  const move = chooseMove(state, params);
  const build = chooseBuild(state, move, params);
  return build ? { kind: 'build', ...build } : move ? { kind: 'attack', ...move } : null;
}
module.exports = { chooseAction };
