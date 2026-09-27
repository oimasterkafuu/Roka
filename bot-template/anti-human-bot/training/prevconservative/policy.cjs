'use strict';
const { chooseMove } = require('./planner.cjs');
const { chooseBuild } = require('./building.cjs');
const { chooseLogistics, getSupplyBatch } = require('./logistics.cjs');
const { chooseTactic } = require('./tactics.cjs');
const { chooseOpening } = require('./opening.cjs');
const { chooseInterception } = require('./interception.cjs');
const { analyzeFFA, acceptFFAAction } = require('./ffa.cjs');
const { chooseDefense } = require('./defense.cjs');
const { chooseCampaign } = require('./campaign.cjs');
const { chooseRescue } = require('./rescue.cjs');
const { createMovementGuard } = require('./movement-guard.cjs');
const { createFrontline } = require('./frontline.cjs');
const decisionDiagnostics = new WeakMap();
function getDecisionDiagnostics(state) { return decisionDiagnostics.get(state) || null; }
function decide(state, params, guard) {
  if (!state || state.ended || state.dead) return null;
  const analysis = analyzeFFA(state);
  const defense = chooseDefense(state);
  if (defense) for (const owner of defense.threatOwners) analysis.allowedOwners.add(owner);
  const constrained = { ...params, allowedOwners: analysis.allowedOwners, blockedEdges: guard.blockedEdges };
  const front = state.turn >= 50 ? createFrontline(state, constrained) : null;
  const attack = (move, emergency = false) => {
    const safe = front && !emergency ? front.assess(move) : move;
    return safe ? { kind:'attack', ...safe } : null;
  };
  const diagnostic = {turn:state.turn, frontline:front?.diagnostics, ffaRejected:0, movementRejected:0};
  decisionDiagnostics.set(state, diagnostic);
  const allowed = (a, emergency = false) => {
    if (!a) return false;
    if (!acceptFFAAction(state,a,analysis)) { diagnostic.ffaRejected++; return false; }
    if (!guard.accept(a,{emergency})) { diagnostic.movementRejected++; return false; }
    return true;
  };
  // 真有现成进攻/补给时，不先做昂贵的全局路线和截击候选搜索。
  let proposed, interception;
  const emergency = attack(analysis.emergencyMove, true);
  if (allowed(emergency, true)) return emergency;
  const reinforcement = attack(defense?.move, Boolean(defense?.urgent));
  if (defense?.urgent && allowed(reinforcement, true)) return reinforcement;
  // 可立即执行的有效进攻优先于普通救援、集兵和建设，不能被远后方任务饿死。
  const advance = attack(front?.choose());
  const canAdvance = allowed(advance);
  const supply = front ? attack(chooseLogistics(state, null, null, {
    ...constrained, militaryOnly:true, allowStartBatch:!canAdvance
  })) : null;
  const batch = getSupplyBatch(state);
  const canSupply = allowed(supply);
  const advanceTarget = advance ? advance.dx * state.m + advance.dy : -1;
  const takesCrown = advanceTarget >= 0 && state.grid[advanceTarget] > 100 && state.grid[advanceTarget] < 150;
  const batchHoldsAdvance = !takesCrown && canSupply && batch?.active && advance &&
    advance.x * state.m + advance.y === batch.target;
  if (canAdvance && !batchHoldsAdvance) return advance;
  const rescueMove = chooseRescue(state, constrained);
  if (rescueMove?.rescueWindow?.temporary) {
    const temporaryRescue = attack(rescueMove, true);
    if (allowed(temporaryRescue)) { const {rescueWindow, ...action} = temporaryRescue; return action; }
  }
  // 打不过时先把后方有效兵源送向前线，而不是让2000兵在空格间找替代动作。
  if (canSupply) return supply;
  proposed = chooseMove(state, constrained);
  interception = attack(chooseInterception(state, proposed, constrained));
  if (allowed(interception)) return interception;
  // 临时重连由救援模块审核单次夺桥和行动窗口，不再套用持久占领预算。
  const rescue = attack(rescueMove, rescueMove?.rescueWindow?.temporary === true);
  if (allowed(rescue)) { const {rescueWindow, ...action} = rescue; return action; }
  const opening = attack(chooseOpening(state, proposed, constrained));
  if (allowed(opening)) return opening;
  const tactic = chooseTactic(state, proposed, constrained);
  const move = allowed(attack(tactic)) ? tactic : proposed;
  if (Number.isInteger(state.turn) && state.turn >= 0 && state.turn < 50)
    return allowed(attack(move)) ? attack(move) : null;
  const build = chooseBuild(state, move, constrained);
  const campaign = attack(chooseCampaign(state, constrained, {
    targetOwner: analysis.targetOwner, threatened: Boolean(defense?.urgent || emergency), boundaryAdvance: true
  }));
  // 攻城树独占调兵方向；每四tick允许一次经济投资，不让建设或微操反向拆散集结。
  if (allowed(campaign)) {
    if (build && state.turn % 4 === 0) return {kind:'build',...build};
    return campaign;
  }
  if (allowed(reinforcement)) return reinforcement;
  const rawLogistics = chooseLogistics(state, move, build, constrained);
  const logistics = rawLogistics?.kind === 'build' ? rawLogistics : attack(rawLogistics);
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
module.exports = { chooseAction, getDecisionDiagnostics };
