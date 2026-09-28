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
const { chooseCutoff, chooseNeckGuard } = require('./cutoff.cjs');
const { chooseColumnStrike } = require('./column.cjs');
const { createContext } = require('./threat.cjs');
const { resolveParams } = require('./params.cjs');

const decisionDiagnostics = new WeakMap();

// ── 保底动作 ─────────────────────────────────────────────────────────────
// 任何模块都没给出动作时，也必须做一件「保守且绝不亏」的事，不允许空转：
//   1) 后方有空闲资金 → 直接建/升皇冠（哪怕位置不是最优，产能也是净赚）；
//   2) 后方有大堆不贴敌的兵 → 往最需要的前线格搬一步（聚兵）；
//   3) 前线有大堆但打不动 → 横向汇兵到邻敌压力最大的己方邻格（不后退、不空转）。
// 全部只看当前局面，不保存任何计划。
function guaranteedAction(state, ctx, params) {
  if (!ctx) return null;
  const { me, size, grid, count, own, hostile, neighbors, frontDistance } = ctx;
  const blocked = (a, b) => params.blockedEdges?.has(`${a}:${b}`);
  const coord = (i) => ({ x: Math.floor(i / ctx.m), y: i % ctx.m });
  // 1) 后方建皇冠：不贴敌的安全格，攒够 50 兵就开工（指挥所先升级，其次新建）。
  //    开局提速（用户 2026-09-28 回调）：前 earlyBuildTurns 个 tick 内不贴敌
  //    即开工，不让「大后方 100 的档位」拖慢第一座建造——开局就用得上、用得早。
  let foundSite = -1, newSite = -1;
  for (let i = 0; i < size; i++) {
    if (!own(i) || count(i) < 50) continue;
    if (neighbors[i].some((j) => hostile(j))) continue;
    if (grid[i] === me + 50) { foundSite = i; break; }
    if (newSite < 0 && grid[i] === me) newSite = i;
  }
  const site = foundSite >= 0 ? foundSite : newSite;
  if (site >= 0) {
    const { x, y } = coord(site);
    return { kind: 'build', op: foundSite >= 0 ? 'c' : 'b', x, y,
      reason: foundSite >= 0 ? '保底：升级后方皇冠' : '保底：后方新建皇冠' };
  }
  // 2) 聚兵：把后方最大的一堆（不贴敌）往最近的前线格方向搬一步。
  let source = -1, best = 1;
  for (let i = 0; i < size; i++) {
    if (!own(i) || count(i) <= best) continue;
    if (neighbors[i].some((j) => hostile(j))) continue;
    const d = frontDistance[i];
    source = i; best = count(i);
  }
  if (source >= 0) {
    const d = frontDistance[source];
    let dest = -1;
    for (const j of neighbors[source]) {
      if (!own(j) || blocked(source, j)) continue;
      const dj = frontDistance[j];
      if (dj >= 0 && (d < 0 || dj < d)) { if (dest < 0 || dj < frontDistance[dest]) dest = j; }
    }
    if (dest < 0) for (const j of neighbors[source]) if (own(j) && !blocked(source, j)) { dest = j; break; }
    if (dest >= 0) {
      const from = coord(source), to = coord(dest);
      return { kind: 'attack', ...from, dx: to.x, dy: to.y, half: false, mode: 0, reason: '保底：后方聚兵向前' };
    }
  }
  // 3) 前线横向汇兵：不后退，把兵挪向邻敌压力最大的己方邻格。
  let frontSource = -1, frontBest = 1;
  for (let i = 0; i < size; i++) {
    if (!own(i) || count(i) <= frontBest) continue;
    if (!neighbors[i].some((j) => hostile(j))) continue;
    frontSource = i; frontBest = count(i);
  }
  if (frontSource >= 0) {
    let dest = -1, pressure = -1;
    for (const j of neighbors[frontSource]) {
      if (!own(j) || blocked(frontSource, j)) continue;
      const foe = ctx.pressure(j, { radius: 1 }).adj;
      if (foe > pressure) { pressure = foe; dest = j; }
    }
    if (dest < 0) for (const j of neighbors[frontSource]) if (own(j) && !blocked(frontSource, j)) { dest = j; break; }
    if (dest >= 0) {
      const from = coord(frontSource), to = coord(dest);
      return { kind: 'attack', ...from, dx: to.x, dy: to.y, half: false, mode: 0, reason: '保底：前线横向汇兵' };
    }
  }
  return null;
}
// 「是否该转守」完全由当前局面推出：前线密度明显低于对手、且对手是真正的竞争者时才算过度扩张。
// 不保存任何跨回合状态，因此不会出现「昨天决定今天还照着做」。
function consolidation(state, ctx, params) {
  if (!ctx) return false;
  const tuning = resolveParams(params);
  if (tuning.consolidateLoss <= 0) return false;
  const race = ctx.race;
  if (race.myLand < 8 || race.bestLand < 4) return false;
  // 只有「兵力明显少 + 地皮也没领先」才算被压着打，才值得暂时只守不扩。
  // 只看"每格兵力密度"会让大后期的大国永久进入守势（实地日志里因此连续 20 tick 空动作）。
  const weakerArmy = race.myArmy < 0.7 * race.bestArmy;
  const notAheadLand = race.myLand < 1.2 * race.bestLand;
  return weakerArmy && notAheadLand;
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
  // 提前汇兵（威胁 2+ tick）不绕过移动护栏——否则与经济/物流运输互相倒兵绕圈；
  // 只有贴脸救城/前线截击（imminent）保持紧急放行。
  const reinforcement = attack(defense?.move, Boolean(defense?.imminent));
  if (defense?.urgent && allowed(reinforcement, Boolean(defense?.imminent))) return take(reinforcement, 'defense-urgent');
  // 可立即执行的有效进攻优先于普通救援、集兵和建设，不能被远后方任务饿死。
  const advance = attack(front?.choose());
  const canAdvance = allowed(advance);
  // 偷家防御：敌人插进我方腹地时，先掐断它与自家主城的连接（整队变孤军＝性价比最高的防御）。
  // 已经能夺敌皇冠的推进仍然优先；其余情况让位给截断。
  const cutoff = chooseCutoff(state, constrained);
  const cutoffAction = cutoff ? { kind: 'attack', ...cutoff.move } : null;
  const advanceWinsBuilding = advance && state.grid[advance.dx * state.m + advance.dy] > 50 &&
    state.grid[advance.dx * state.m + advance.dy] < 150;
  // 纯涂色推进（目标是无主中立格）：截断/建造/筹资都压过它（用户 2026-09-29 硬方针：
  // 资源优先供给截断、产能与集结，只有没事干时才放开涂色）。
  const ownerOf = (v) => (v > 0 && v < 200 ? v % 50 : 0);
  const advanceIsPaint = Boolean(advance) && ownerOf(state.grid[advance.dx * state.m + advance.dy]) === 0;
  // 背水一战最高优先（学自 _E_ 的胜局：rjWd t302 / jlms t346 / bIEK t514，
  // 400+ 兵堆压向皇冠的 5+ tick 里，旧策略因「补不齐缺口」零防守反应，
  // 照常筹资/建设/补给，皇冠被一击斩首）。补不齐也要每 tick 送最强一路——
  // 皇冠陷落即终局，每拖一 tick 都可能有援军进入窗口。
  // 唯一例外：本 tick 能反拆对方皇冠/指挥所（对攻抢先，拆了对面就赢赛跑）。
  if (defense?.lastStand && !advanceWinsBuilding) {
    const stand = attack(defense.move, true);
    if (allowed(stand, true)) return take(stand, 'defense-last-stand');
  }
  // 敌方跳板纵队拦截（2026-09-28 用户硬方针，主动防御层）：敌方深入我方腹地且
  // 仍在推进的跳板/兵柱纵队，优先掐链、其次侧击腰部，不坐等它走到皇冠再背水。
  // 优先级：背水一战（上面）之下、自家预锚/截断/脖子纪律/推进之上；「本 tick 能
  // 拆敌方皇冠/指挥所」的斩首推进仍例外。皇冠告急（urgent/lastStand）或家里
  // 多路告急（≥2 个敌阵营同时在威胁）时不为拦纵队抽空防守；defense.imminent
  // 的「提前截击」不算告急——那正是该掐链而不是被动等的场面。
  const columnCrisis = defense && (defense.urgent || defense.lastStand || defense.threatOwners?.size >= 2);
  if (!advanceWinsBuilding && !columnCrisis) {
    const column = chooseColumnStrike(state, constrained);
    if (column) {
      // 身后下刀优先（2026-09-29 用户追加方针）：迎头撞（短促自耗型）只在确实
      // 没有后方切断点时才用——截断模块能从敌块身后（朝向其老家的连通方向）
      // 下刀时，先截断让插入段孤死，不以兵换兵硬拼。
      if (column.headOn && cutoff && allowed(cutoffAction)) return take(cutoffAction, 'cutoff');
      const strike = attack(column.move, Boolean(column.urgent));
      // frontline 审查会把 mode/reason 改写成全冲口径；保留拦截语义 reason，
      // 让日志/复盘能看到「掐链/迎头/打头」这一层主动防御动作。
      if (strike) strike.reason = column.move.reason;
      if (allowed(strike, Boolean(column.urgent))) return take(strike, 'column-strike');
    }
  }
  // 攻城评估提前算一次（下方各 campaign 分支复用）：浓缩突击/画圈推进/锚点建造的提议。
  const campaignRaw = chooseCampaign(state, constrained, {
    targetOwner: analysis.targetOwner, threatened: Boolean(defense?.urgent || emergency),
    boundaryAdvance: true, ratio: race?.behind ? 1.12 : 1.3,
  });
  // 同 tick 预锚 / 腾出格补锚（2026-09-27 第二轮，用户硬方针）：走廊可能被 1 tick
  // 切断时大堆原地起锚、推进后腾出的格立即补锚——紧急建造，压过本 tick 的移动
  // 决策（含脖子纪律的增援/回缩与入侵截断），不受锚点链节奏限制；仍让位于上面
  // 的背水一战与「本 tick 能拆敌方皇冠/指挥所」的斩首推进。
  if (campaignRaw?.kind === 'build' && campaignRaw.reason?.phase !== 'anchor' &&
      !advanceWinsBuilding && allowed(campaignRaw)) return take(campaignRaw, 'campaign-preempt-anchor');
  // 截断的优先级仅次于「本 tick 能拆敌方皇冠/指挥所」的推进：
  // urgent（偷家贴脸或冻住规模很大）时无条件抢占；
  // 防守场景（对手正在威胁我方皇冠/生命，defense 有动作）下，截断也压过普通推进与调兵。
  const defenseScenario = Boolean(defense?.move);
  if (cutoff && !advanceWinsBuilding && (cutoff.urgent || defenseScenario) &&
      allowed(cutoffAction)) return take(cutoffAction, 'cutoff');
  // 脖子纪律：我方割点本 tick 就能被敌方大堆打穿（一整段兵力将变孤军）时，
  // 补兵/回缩优先于普通推进与调兵——连通被切和皇冠被端一样是生存问题。
  const neck = chooseNeckGuard(state, constrained);
  const neckAction = neck ? { kind: 'attack', ...neck.move } : null;
  if (neck && !advanceWinsBuilding && allowed(neckAction)) return take(neckAction, 'neck-guard');
  // 锚点链（画圈推进的建造节奏，学自 _E_）：推进走廊有截断风险、或到达节奏 tick
  // 且走廊上有攒够兵的锚点候选时，落指挥所保连通压过普通推进——E 的节奏就是
  // 「走几步、停一 tick 建站」。让位于「本 tick 能拆敌方皇冠/指挥所」的推进
  // （斩首/拆建筑优先级不变），也让位于上面的背水/截断/脖子纪律。
  if (campaignRaw?.kind === 'build' && !advanceWinsBuilding && allowed(campaignRaw))
    return take(campaignRaw, 'campaign-anchor');
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
  // 「竞赛追赶做实」（用户 2026-09-29 硬方针）：产能落后时，只要本 tick 的推进
  // 不过是中立涂色，经济就压过它——不再只让出 1/economyShareTicks 的 tick。
  const economyUrgent = Boolean(race?.behind) && state.turn >= 60 &&
    (!canAdvance || advanceIsPaint || (economyShare > 0 && contested && state.turn % economyShare === 0));
  if (economyUrgent && !advanceWinsBuilding) {
    const buildNow = chooseBuild(state, null, constrained);
    if (buildNow) return take({ kind: 'build', ...buildNow }, 'economy-emergency-build');
    const fund = front ? attack(chooseLogistics(state, null, null, { ...constrained, economyOnly: true })) : null;
    if (allowed(fund)) return take(fund, 'economy-emergency-fund');
  }
  // 涂色让位（用户 2026-09-29 硬方针）：本 tick 的推进只是中立涂色时——
  //   1. 非紧急截断（敌深入有脖子可掐）压过涂色，「该截还是要截」；
  //      （确证根因：旧调度里非紧急截断只在 !canAdvance 时执行，而只要有涂色可扩
  //      canAdvance 恒真，截断方案被无限期搁置、涂色每 tick 抢先。）
  //   2. 可负担的建造（chooseBuild 自带产能目标/评分门闸，产能富余时自然返回 null）
  //      与经济筹资压过涂色——建造节奏对标对手，产能不落后太多才放开涂色。
  if (canAdvance && advanceIsPaint && !batchHoldsAdvance) {
    if (allowed(cutoffAction)) return take(cutoffAction, 'cutoff');
    const buildNow = chooseBuild(state, null, constrained);
    if (buildNow) return take({ kind: 'build', ...buildNow }, 'build-over-paint');
    const fund = front ? attack(chooseLogistics(state, null, null, { ...constrained, economyOnly: true })) : null;
    if (allowed(fund)) return take(fund, 'economy-fund-over-paint');
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
  // 锚点链建造（kind:'build'）不经 frontline 移动审查，与 logistics 的建造同例直通。
  const campaign = campaignRaw?.kind === 'build' ? campaignRaw : attack(campaignRaw);
  // 攻城树独占调兵方向；每四tick允许一次经济投资，不让建设或微操反向拆散集结。
  if (allowed(campaign)) {
    if (campaign.kind === 'build') return take(campaign, 'campaign-anchor');
    if (build && state.turn % 4 === 0) return take({ kind: 'build', ...build }, 'campaign-build');
    return take(campaign, 'campaign');
  }
  if (allowed(reinforcement)) return take(reinforcement, 'defense');
  const rawLogistics = chooseLogistics(state, move, build, constrained);
  const logistics = rawLogistics?.kind === 'build' ? rawLogistics : attack(rawLogistics);
  if (allowed(logistics)) return take(logistics, 'logistics');
  if (build) return take({ kind: 'build', ...build }, 'build');
  // 空动作回退：经济 → 规划器 → 保底动作，绝不留空 tick。
  const fallbackEconomy = attack(chooseLogistics(state, move, build, { ...constrained, economyOnly: true }));
  if (allowed(fallbackEconomy)) return take(fallbackEconomy, 'economy-fallback');
  if (allowed(attack(move))) return take(attack(move), 'planner');
  const guaranteed = guaranteedAction(state, ctx, constrained);
  if (allowed(guaranteed)) return take(guaranteed, 'fallback');
  return null;
}

function chooseAction(state, params = {}) {
  if (!state || state.ended || state.dead) return null;
  const guard = createMovementGuard(state);
  const action = decide(state, params, guard);
  guard.finish(action);
  return action;
}
module.exports = { chooseAction, getDecisionDiagnostics };
