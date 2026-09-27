'use strict';
const { chooseMove } = require('./planner.cjs');
const { chooseBuild } = require('./building.cjs');
const { chooseLogistics } = require('./logistics.cjs');
const { chooseTactic } = require('./tactics.cjs');
const { chooseOpening } = require('./opening.cjs');
function chooseAction(state, params = {}) {
  if (!state || state.ended || state.dead) return null;
  const proposed = chooseMove(state, params);
  const opening = chooseOpening(state, proposed, params);
  if (opening) return { kind: 'attack', ...opening };
  const move = chooseTactic(state, proposed, params) || proposed;
  // 一次性增长窗口不能被经济/长程集结抢占。无可行扩张时仍允许救援或铺路。
  if (Number.isInteger(state.turn) && state.turn >= 0 && state.turn < 50)
    return move ? { kind: 'attack', ...move } : null;
  const build = chooseBuild(state, move, params);
  const logistics = chooseLogistics(state, move, build, params);
  if (logistics) return logistics;
  return build ? { kind: 'build', ...build } : move ? { kind: 'attack', ...move } : null;
}
module.exports = { chooseAction };
