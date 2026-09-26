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
const { chooseCutoff } = require('./cutoff.cjs');
const { createContext } = require('./threat.cjs');
const { resolveParams } = require('./params.cjs');

const decisionDiagnostics = new WeakMap();
// 「是否该转守」完全由当前局面推出：前线密度明显低于对手、且对手是真正的竞争者时才算过度扩张。
// 不保存任何跨回合状态，因此不会出现「昨天决定今天还照着做」。
function consolidation(state, ctx, params) {
  if (!ctx) return false;
  const tuning = resolveParams(params);
  if (tuning.consolidateLoss <= 0) return false;
  const race = ctx.race;
  if (race.myLand < 8 || race.bestLand < 4) return false;
  const contested = race.bestLand >= 0.3 * race.myLand || race.bestArmy >= 0.8 * race.myArmy;
  if (!contested) return false;
  const density = race.myArmy / Math.max(1, race.myLand);
  const foeDensity = race.bestArmy / Math.max(1, race.bestLand);
  return density * 1.6 < foeDensity;
}
function getDecisionDiagnostics(state) { return decisionDiagnostics.get(state) || null; }

function decide(state, params, guard) {
  if (!state || state.ended || state.dead) return null;
  const ctx = createContext(state, params);
  const tuning = resolveParams(params);
  const race = ctx?.race ?? null;
  const analysis = analyzeFFA(state);
  const defense = chooseDefense(state);
  if (defense) for (const owner of defense.threatOwners) analysis.allowedOwners.add(owner);
  const consolidating = consolidation(state, ctx, params);
  const constrained = { ...params, allowedOwners: analysis.allowedOwners, blockedEdges: guard.blockedEdges, consolidate: consolidating };
  const front = state.turn >= 50 ? createFrontline(state, constrained) : null;
  const attack = (move, emergency = false) => {
    const safe = front && !emergency ? front.assess(move) : move;
    return safe ? { kind: 'attack', ...safe } : null;
  };
  const diagnostic = { turn: state.turn, frontline: front?.diagnostics, ffaRejected: 0, movementRejected: 0, race, consolidating, branch: null };
  decisionDiagnostics.set(state, diagnostic);
  const allowed = (a, emergency = false) => {
    if (!a) return false;
    if (!acceptFFAAction(state, a, analysis)) { diagnostic.ffaRejected++; return false; }
    if (!guard.accept(a, { emergency })) { diagnostic.movementRejected++; return false; }
    return true;
  };
  const take = (action, branch) => { if (action) diagnostic.branch = branch; return action; };

  // 真有现成进攻/补给时，不先做昂贵的全局路线和截击候选搜索。
  let proposed, interception;
  const emergency = attack(analysis.emergencyMove, true);
  if (allowed(emergency, true)) return take(emergency, 'ffa-emergency');
  const reinforcement = attack(defense?.move, Boolean(defense?.urgent));
  if (defense?.urgent && allowed(reinforcement, true)) return take(reinforcement, 'defense-urgent');
  // 可立即执行的有效进攻优先于普通救援、集兵和建设，不能被远后方任务饿死。
  const advance = attack(front?.choose());
  const canAdvance = allowed(advance);
  // 偷家防御：敌人插进我方腹地时，先掐断它与自家主城的连接（整队变孤军＝性价比最高的防御）。
  // 已经能夺敌皇冠的推进仍然优先；其余情况让位给截断。
  const cutoff = chooseCutoff(state, constrained);
  const cutoffAction = cutoff ? { kind: 'attack', ...cutoff.move } : null;
  const advanceWinsBuilding = advance && state.grid[advance.dx * state.m + advance.dy] > 50 &&
    state.grid[advance.dx * state.m + advance.dy] < 150;
  if (cutoff?.urgent && !advanceWinsBuilding && allowed(cutoffAction)) return take(cutoffAction, 'cutoff');
  // 攻冠的推进永远最优先；但普通推进不能让位于「家里皇冠正被吃掉」。
  const advanceTakesCrown = advanceWinsBuilding;
  if (tuning.defensePriority >= 1 && defense && !advanceTakesCrown && !defense.urgent) {
    const guardMove = attack(defense.move);
    if (allowed(guardMove)) return take(guardMove, 'defense-guard');
  }
  // 等级 2：不抢进攻 tick，但抢在「继续往门口堆兵」之前回防。
  const defenseMove = defense ? attack(defense.move) : null;
  const supply = front ? attack(chooseLogistics(state, null, null, {
    ...constrained, militaryOnly: true, allowStartBatch: !canAdvance,
  })) : null;
  const batch = getSupplyBatch(state);
  const canSupply = allowed(supply);
  const advanceTarget = advance ? advance.dx * state.m + advance.dy : -1;
  // 51–99 是敌方指挥所，101–149 是敌方皇冠：拆建筑永远不被批次/经济/截断顶掉。
  const takesBuilding = advanceTarget >= 0 && state.grid[advanceTarget] > 50 && state.grid[advanceTarget] < 150;
  const batchHoldsAdvance = !takesBuilding && canSupply && batch?.active && advance &&
    advance.x * state.m + advance.y === batch.target;

  // 经济落后就是紧急情况：敌人每多一座皇冠就多一份永久产能。
  // 落后时固定拿出 1/3 的 tick（差距大时 1/2）做经济，其余 tick 照常进攻，
  // 既不放弃军事压力，也不再让「门口永远缺兵」吞掉全部产能。
  const deficit = race?.deficit ?? 0;
  const share = Math.max(0, Math.round(tuning.economyShareTicks));
  const economyShare = share > 0 ? (deficit >= 3 ? Math.max(2, Math.ceil(share / 2)) : share) : 0;
  // 只有当对手兵力不弱于我们（我们不是靠滚雪球赢的那一方）才值得让出进攻 tick 换产能；
  // 碾压局继续全速进攻，不做无谓的经济让位。
  const contested = race ? race.bestArmy >= 0.8 * Math.max(1, race.myArmy) : false;
  const economyUrgent = Boolean(race?.behind) && state.turn >= 60 &&
    (!canAdvance || (economyShare > 0 && contested && state.turn % economyShare === 0));
  if (economyUrgent && !advanceWinsBuilding) {
    const buildNow = chooseBuild(state, null, constrained);
    if (buildNow) return take({ kind: 'build', ...buildNow }, 'economy-emergency-build');
    const fund = front ? attack(chooseLogistics(state, null, null, { ...constrained, economyOnly: true })) : null;
    if (allowed(fund)) return take(fund, 'economy-emergency-fund');
  }
  if (canAdvance && !batchHoldsAdvance) return take(advance, 'advance');
  const rescueMove = chooseRescue(state, constrained);
  if (rescueMove?.rescueWindow?.temporary) {
    const temporaryRescue = attack(rescueMove, true);
    if (allowed(temporaryRescue)) { const { rescueWindow, ...action } = temporaryRescue; return take(action, 'rescue-temporary'); }
  }
  // 打不过时先把后方有效兵源送向前线，而不是让2000兵在空格间找替代动作。
  if (tuning.defensePriority >= 2 && defense && !advanceTakesCrown && allowed(defenseMove)) return take(defenseMove, 'defense-guard');
  // 非紧急的入侵截断（远处偷家）：有富余动作时再处理。
  if (!canAdvance && allowed(cutoffAction)) return take(cutoffAction, 'cutoff');
  if (canSupply) return take(supply, 'supply');
  proposed = chooseMove(state, constrained);
  interception = attack(chooseInterception(state, proposed, constrained));
  if (allowed(interception)) return take(interception, 'interception');
  // 临时重连由救援模块审核单次夺桥和行动窗口，不再套用持久占领预算。
  const rescue = attack(rescueMove, rescueMove?.rescueWindow?.temporary === true);
  if (allowed(rescue)) { const { rescueWindow, ...action } = rescue; return take(action, 'rescue'); }
  const opening = attack(chooseOpening(state, proposed, constrained));
  if (allowed(opening)) return take(opening, 'opening');
  const tactic = chooseTactic(state, proposed, constrained);
  const move = allowed(attack(tactic)) ? tactic : proposed;
  if (Number.isInteger(state.turn) && state.turn >= 0 && state.turn < 50)
    return allowed(attack(move)) ? take(attack(move), 'early') : null;
  const build = chooseBuild(state, move, constrained);
  const campaign = attack(chooseCampaign(state, constrained, {
    targetOwner: analysis.targetOwner, threatened: Boolean(defense?.urgent || emergency),
    boundaryAdvance: true, ratio: race?.behind ? 1.12 : 1.3,
  }));
  // 攻城树独占调兵方向；每四tick允许一次经济投资，不让建设或微操反向拆散集结。
  if (allowed(campaign)) {
    if (build && state.turn % 4 === 0) return take({ kind: 'build', ...build }, 'campaign-build');
    return take(campaign, 'campaign');
  }
  if (allowed(reinforcement)) return take(reinforcement, 'defense');
  const rawLogistics = chooseLogistics(state, move, build, constrained);
  const logistics = rawLogistics?.kind === 'build' ? rawLogistics : attack(rawLogistics);
  if (allowed(logistics)) return take(logistics, 'logistics');
  if (build) return take({ kind: 'build', ...build }, 'build');
  // 空动作回退：还有经济可做就先做经济，其次才是扩张/探路，避免整 tick 空转。
  const fallbackEconomy = attack(chooseLogistics(state, move, build, { ...constrained, economyOnly: true }));
  if (allowed(fallbackEconomy)) return take(fallbackEconomy, 'economy-fallback');
  return allowed(attack(move)) ? take(attack(move), 'planner') : null;
}

function chooseAction(state, params = {}) {
  if (!state || state.ended || state.dead) return null;
  const guard = createMovementGuard(state);
  const action = decide(state, params, guard);
  guard.finish(action);
  return action;
}
module.exports = { chooseAction, getDecisionDiagnostics };
