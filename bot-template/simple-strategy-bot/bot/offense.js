/**
 * offense.js — 进攻：目标评估、考虑敌方防守的路径规划、集结打击、切断入侵。
 *
 * 打击计划（state.plan 跨 tick 存续）：
 *   1. 目标 = 活敌的主城/指挥所。收益：端掉对方最后一座主城 = 直接淘汰
 *      （其全部领土减半沦为孤军），收益最高；普通主城/指挥所次之。
 *   2. 路径 = 多源 Dijkstra 求「己方可操作格 → 目标」的最优进军路线，
 *      代价 = 途经守军 + 风险权重 × 邻近敌军兵力（enemyPressure）+ 步数。
 *      风险项让路径主动绕开敌军重兵区——对方更难组织防守/反扑，即
 *      「更难被破解」；步数项让对方反应时间最短。
 *   3. 集结 = 入口格兵力不足时，把入口设为 logistics 的输送焦点，沿路
 *      己方格的兵力会随进军自动并入（穿过己方格即合流），多源汇集而非
 *      只从单一大点取兵。
 *   4. 每 tick 用最新棋盘重算路径与需求（hysteresis：除非明显更优否则
 *      不更换目标），入口推兵量达到需求的 85% 即全冲（mode 2）打下一格
 *      ——对龟缩对手，沿途吃下的格子是净收益，不等 100% 稳赢才动；
 *      行进中敌方增援导致不再占优时自然停下转为继续集结。
 *
 * 切断入侵：对突入己方领土的活敌格，凡相邻己方格能全冲吃掉的立即打，
 * 深度越深（被己方格包围程度）、越靠近我锚点、目标是指挥所/主城者越优先。
 */

// 集结窗口：最多花多少 op 把一个打击入口喂饱。
const GATHER_OPS = 10;
// 集结启动门槛：可交付兵力达到需求的比例即开始集结（越早集越快到线）。
const RALLY_GATE_RATIO = 0.4;
// 开打门槛：入口推兵量达到路径需求的比例即全冲。打龟缩对手时，即使
// 最后差一口气，沿途吃下的格子也是净收益（残链停在半路，已占领格
// 仍归我方），不必等到 100% 稳赢才动。
const STRIKE_COMMIT_RATIO = 0.85;
// 路径代价中「邻近敌军兵力」的权重（反击暴露风险）。
const RISK_WEIGHT = 0.35;
// 路径代价中「经过队友格」的固定惩罚（避免行军顺手吞并盟友领土）。
const TEAMMATE_PENALTY = 6;
// 切换打击目标的滞后系数：新目标评分须超过旧目标 × 此系数才换。
const REPLAN_MARGIN = 1.3;
// 进行中/候选路径的入口若紧贴重兵敌格，集结时容易被打断，扣分。
const ENTRY_EXPOSURE_PENALTY = 0.35;
// 敌军增援的时间余量：皇冠目标在逼近期间每 tick +1，集结期同样增长。
const CROWN_GROWTH_PER_HOP = 1;

function attackOp(ctx, fromIdx, toIdx, mode) {
  const from = ctx.xy(fromIdx);
  const to = ctx.xy(toIdx);
  return { kind: 'attack', payload: { x: from.x, y: from.y, dx: to.x, dy: to.y, mode } };
}

/** 进军路径的进入代价（己方 1 步；中立/敌格 = 守军 + 风险；队友绕开）。 */
function invasionEnterCost(ctx, pressure, idx) {
  if (!ctx.passable(idx)) {
    return Infinity;
  }
  if (ctx.isMineIdx(idx)) {
    return 1;
  }
  const owner = ctx.ownerAt(idx);
  const risk = RISK_WEIGHT * pressure[idx];
  if (owner === 0) {
    return ctx.army(idx) + risk + 1;
  }
  if (ctx.isTeammateOwner(owner)) {
    return TEAMMATE_PENALTY + 1;
  }
  return ctx.army(idx) + risk + 1;
}

/**
 * 评估一条进军路径：
 *   totalDefense = 入口之后所有非己方格的守军之和；
 *   gains = 途经己方格能并入的兵力（扣除边境保留）；
 *   required = 入口格需要的推兵量（+1 严格大于；皇冠目标含行进期增兵）。
 */
function evaluatePath(ctx, path, targetIsCrown) {
  let totalDefense = 0;
  let gains = 0;
  for (let i = 1; i < path.length; i += 1) {
    const idx = path[i];
    const owner = ctx.ownerAt(idx);
    if (ctx.isMineIdx(idx)) {
      gains += Math.max(0, ctx.army(idx) - ctx.keepAt(idx));
      continue;
    }
    if (owner > 0 && ctx.isTeammateOwner(owner)) {
      continue;
    }
    totalDefense += ctx.army(idx);
  }
  const hops = path.length - 1;
  const growthMargin = targetIsCrown ? hops * CROWN_GROWTH_PER_HOP : 0;
  const required = Math.max(1, totalDefense + 1 + growthMargin - gains);
  return { totalDefense, gains, hops, required };
}

/** 列出打击目标：活敌的主城与指挥所。 */
function listTargets(ctx) {
  const targets = [];
  for (const [owner, entry] of ctx.stats().perOwner) {
    if (owner === ctx.state.playerId || ctx.isTeammateOwner(owner) || ctx.ownerDead(owner)) {
      continue;
    }
    if (entry.crowns === 0 && entry.cities === 0) {
      continue;
    }
    targets.push(owner);
  }
  const cells = [];
  for (let idx = 0; idx < ctx.state.n * ctx.state.m; idx += 1) {
    const kind = ctx.tileKind(idx);
    if (kind !== 'crown' && kind !== 'city') {
      continue;
    }
    const owner = ctx.ownerAt(idx);
    if (targets.includes(owner)) {
      cells.push({ idx, owner, isCrown: kind === 'crown' });
    }
  }
  return cells;
}

/**
 * 评估一个打击目标：路径、入口、需求、可交付兵力与评分。
 * 进行中的计划（同目标）优先从其头部继续，减少路径抖动。
 */
function evaluateTarget(ctx, state, target) {
  const pressure = ctx.enemyPressure();
  const enterCost = (idx) => invasionEnterCost(ctx, pressure, idx);
  const isTarget = (idx) => idx === target.idx;
  const multi = ctx.dijkstra(ctx.myOperable(), enterCost, isTarget);
  if (!multi) {
    return null;
  }

  let chosen = multi;
  if (state.plan && state.plan.targetIdx === target.idx) {
    const head = state.plan.headIdx;
    if (head !== null && ctx.operable(head)) {
      const single = ctx.dijkstra([head], enterCost, isTarget);
      if (single && single.cost <= multi.cost * 1.4) {
        chosen = single;
      }
    }
  }

  const pathEval = evaluatePath(ctx, chosen.path, target.isCrown);
  const entry = chosen.entry;
  const entryPush = ctx.army(entry) - 1;
  const gather = ctx.gatherable(entry, GATHER_OPS, -1);
  // 集结期间皇冠目标还在增兵，集结耗时计入需求。
  const effectiveRequired = pathEval.required + (target.isCrown ? gather.ticks : 0);
  const deliverable = entryPush + gather.amount;
  const ready = entryPush >= Math.ceil(pathEval.required * STRIKE_COMMIT_RATIO);

  const victimArmy = ctx.armyOf(target.owner);
  const payoff = target.isCrown
    ? ctx.crownsOf(target.owner) === 1
      ? 1000 + Math.floor(victimArmy / 4)
      : 380
    : 170;
  const feasRatio = Math.min(1, deliverable / (effectiveRequired + 1));
  const timeCost = 1 + 0.1 * pathEval.hops + 0.06 * gather.ticks;
  // 入口暴露惩罚：入口邻接的重兵敌格会在集结期打断计划。
  let exposure = 0;
  for (const nIdx of ctx.neighbors(entry)) {
    if (ctx.isAliveEnemyIdx(nIdx)) {
      exposure = Math.max(exposure, ctx.army(nIdx));
    }
  }
  const exposureFactor = 1 / (1 + ENTRY_EXPOSURE_PENALTY * Math.max(0, exposure - entryPush) / 50);
  const score = (payoff * (ready ? 1.25 : feasRatio) * exposureFactor) / timeCost;

  return {
    targetIdx: target.idx,
    owner: target.owner,
    isCrown: target.isCrown,
    payoff,
    path: chosen.path,
    entry,
    required: pathEval.required,
    effectiveRequired,
    deliverable,
    ready,
    hops: pathEval.hops,
    gatherTicks: gather.ticks,
    score,
  };
}

/** 切断入侵候选：能全冲吃掉的活敌格，按深度/锚点 proximity/目标价值排序。 */
function cutCandidates(ctx) {
  const candidates = [];
  const anchorDistAll = ctx.anchorDistAll();
  for (const sIdx of ctx.myOperable()) {
    for (const eIdx of ctx.neighbors(sIdx)) {
      if (!ctx.isAliveEnemyIdx(eIdx)) {
        continue;
      }
      const eArmy = ctx.army(eIdx);
      const push = ctx.army(sIdx) - 1;
      if (push <= eArmy) {
        continue;
      }
      // 深度 proxy：目标格被己方格包围的程度（越深入我境越优先切断）。
      let myAdj = 0;
      for (const nIdx of ctx.neighbors(eIdx)) {
        if (ctx.isMineIdx(nIdx)) {
          myAdj += 1;
        }
      }
      const owner = ctx.ownerAt(eIdx);
      const kind = ctx.tileKind(eIdx);
      let score = 210 + 22 * myAdj + Math.min(eArmy, 60);
      if (kind === 'crown') {
        score += ctx.crownsOf(owner) === 1 ? 600 : 240;
      } else if (kind === 'city') {
        score += 120;
      }
      const anchorDist = anchorDistAll[eIdx];
      if (anchorDist >= 0 && anchorDist <= 3) {
        score += 50;
      }
      // 源格其他方向还有活敌时，要求打完后留有缓冲，否则降权。
      let otherEnemyMax = 0;
      for (const nIdx of ctx.neighbors(sIdx)) {
        if (nIdx !== eIdx && ctx.isAliveEnemyIdx(nIdx)) {
          otherEnemyMax = Math.max(otherEnemyMax, ctx.army(nIdx));
        }
      }
      if (otherEnemyMax > 0 && push - eArmy < 3) {
        score *= 0.5;
      }
      candidates.push({
        score,
        // 高价值贴脸目标（如可斩杀的主城）抢占队列，避免 stale op 占坑。
        preempt: score >= 800,
        op: attackOp(ctx, sIdx, eIdx, 2),
        srcKey: sIdx,
        tag: 'cut',
      });
    }
  }
  return candidates;
}

/** 计划是否仍然成立：目标仍属原敌、仍是主城/指挥所、敌方未出局。 */
function planStillValid(ctx, plan) {
  if (ctx.ownerAt(plan.targetIdx) !== plan.owner || ctx.ownerDead(plan.owner)) {
    return false;
  }
  const kind = ctx.tileKind(plan.targetIdx);
  return kind === 'crown' || kind === 'city';
}

/**
 * 进攻主入口：返回 { candidates, focus }。
 * focus = 集结焦点（{idx, baseScore}），交给 logistics 生成输送流。
 */
function planOffense(ctx, state, threats) {
  const candidates = cutCandidates(ctx);

  if (state.plan && !planStillValid(ctx, state.plan)) {
    state.plan = null;
  }

  const targets = listTargets(ctx);
  let best = null;
  for (const target of targets) {
    const evaluated = evaluateTarget(ctx, state, target);
    if (evaluated && (!best || evaluated.score > best.score)) {
      best = evaluated;
    }
  }

  // hysteresis：已有计划的当前评估 × REPLAN_MARGIN 仍不输新目标就继续。
  if (state.plan) {
    const current = evaluateTarget(ctx, state, {
      idx: state.plan.targetIdx,
      owner: state.plan.owner,
      isCrown: ctx.tileKind(state.plan.targetIdx) === 'crown',
    });
    if (current && (!best || current.score * REPLAN_MARGIN >= best.score)) {
      best = current;
    }
  }

  // 防御吃紧时不开新计划（兵力留给防御），进行中的贴近打击继续。
  const defenseBusy = threats.length > 0 && threats[0].hops <= 6;
  if (!best || (defenseBusy && !state.plan)) {
    return { candidates, focus: null };
  }

  // 目标明显打不动（可交付兵力不到需求的集结门槛）时不浪费集结。
  if (best.deliverable < best.effectiveRequired * RALLY_GATE_RATIO && !best.ready) {
    state.plan = null;
    return { candidates, focus: null };
  }

  state.plan = {
    targetIdx: best.targetIdx,
    owner: best.owner,
    headIdx: best.entry,
  };

  if (best.ready) {
    const next = best.path[1];
    candidates.push({
      score: best.payoff >= 1000 ? 820 : best.isCrown ? 610 : 560,
      preempt: false,
      op: attackOp(ctx, best.entry, next, 2),
      srcKey: best.entry,
      tag: 'strike',
    });
    return { candidates, focus: null };
  }

  return { candidates, focus: { idx: best.entry, baseScore: 340 } };
}

module.exports = { planOffense };
