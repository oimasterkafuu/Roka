'use strict';
const { chooseMove } = require('./planner.cjs');
const { chooseBuild } = require('./building.cjs');
const { chooseLogistics } = require('./logistics.cjs');
const { chooseTactic } = require('./tactics.cjs');
function chooseAction(state, params = {}) {
  if (!state || state.ended || state.dead) return null;
  const proposed = chooseMove(state, params);
  const move = chooseTactic(state, proposed, params) || proposed;
  const build = chooseBuild(state, move, params);
  const logistics = chooseLogistics(state, move, build, params);
  if (logistics) return logistics;
  return build ? { kind: 'build', ...build } : move ? { kind: 'attack', ...move } : null;
}
module.exports = { chooseAction };
