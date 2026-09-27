'use strict';
const { chooseMove } = require('./planner.cjs');
const { chooseBuild } = require('./building.cjs');
const { chooseLogistics } = require('./logistics.cjs');
const { chooseTactic } = require('./tactics.cjs');
const { chooseOpening } = require('./opening.cjs');
const { chooseInterception } = require('./interception.cjs');
const { analyzeFFA, acceptFFAAction } = require('./ffa.cjs');
const { chooseDefense } = require('./defense.cjs');
const { createMovementGuard } = require('./movement-guard.cjs');
function decide(state, params, guard) {
  if (!state || state.ended || state.dead) return null;
  const analysis = analyzeFFA(state);
  const defense = chooseDefense(state);
  if (defense) for (const owner of defense.threatOwners) analysis.allowedOwners.add(owner);
  const constrained = { ...params, allowedOwners: analysis.allowedOwners, blockedEdges: guard.blockedEdges };
  const attack = move => move ? { kind:'attack', ...move } : null;
  const allowed = (a, emergency = false) => a && acceptFFAAction(state,a,analysis) && guard.accept(a, { emergency });
  const proposed = chooseMove(state, constrained);
  const interception = attack(chooseInterception(state, proposed, constrained));
  if (allowed(interception)) return interception;
  const emergency = attack(analysis.emergencyMove);
  if (allowed(emergency, true)) return emergency;
  const reinforcement = attack(defense?.move);
  if (defense?.urgent && allowed(reinforcement, true)) return reinforcement;
  const opening = attack(chooseOpening(state, proposed, constrained));
  if (allowed(opening)) return opening;
  const tactic = chooseTactic(state, proposed, constrained);
  const move = allowed(attack(tactic)) ? tactic : proposed;
  if (Number.isInteger(state.turn) && state.turn >= 0 && state.turn < 50)
    return allowed(attack(move)) ? attack(move) : null;
  if (allowed(reinforcement)) return reinforcement;
  const build = chooseBuild(state, move, constrained);
  const logistics = chooseLogistics(state, move, build, constrained);
  if (allowed(logistics)) return logistics;
  if (build) return {kind:'build',...build};
  return allowed(attack(move)) ? attack(move) : null;
}
function chooseAction(state, params = {}) {
  if (!state || state.ended || state.dead) return null;
  const guard = createMovementGuard(state);
  const action = decide(state, params, guard);
  guard.finish(action);
  return action;
}
module.exports = { chooseAction };
