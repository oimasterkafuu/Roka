'use strict';
const { chooseMove } = require('./planner.cjs');
const { chooseBuild } = require('./building.cjs');
const { chooseLogistics } = require('./logistics.cjs');
const { chooseTactic } = require('./tactics.cjs');
const { chooseOpening } = require('./opening.cjs');
const { chooseInterception } = require('./interception.cjs');
const { analyzeFFA, acceptFFAAction } = require('./ffa.cjs');
function chooseAction(state, params = {}) {
  if (!state || state.ended || state.dead) return null;
  const analysis = analyzeFFA(state);
  const constrained = { ...params, allowedOwners: analysis.allowedOwners };
  const attack = move => move ? { kind:'attack', ...move } : null;
  const allowed = a => a && acceptFFAAction(state,a,analysis);
  const proposed = chooseMove(state, constrained);
  const interception = attack(chooseInterception(state, proposed, constrained));
  if (allowed(interception)) return interception;
  const emergency = attack(analysis.emergencyMove);
  if (allowed(emergency)) return emergency;
  const opening = attack(chooseOpening(state, proposed, constrained));
  if (allowed(opening)) return opening;
  const tactic = chooseTactic(state, proposed, constrained);
  const move = allowed(attack(tactic)) ? tactic : proposed;
  if (Number.isInteger(state.turn) && state.turn >= 0 && state.turn < 50)
    return allowed(attack(move)) ? attack(move) : null;
  const build = chooseBuild(state, move, constrained);
  const logistics = chooseLogistics(state, move, build, constrained);
  if (allowed(logistics)) return logistics;
  if (build) return {kind:'build',...build};
  return allowed(attack(move)) ? attack(move) : null;
}
module.exports = { chooseAction };
