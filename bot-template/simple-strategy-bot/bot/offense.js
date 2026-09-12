/**
 * offense.js — 进攻：目标评估、考虑敌方防守的路径规划、集结打击、切断入侵、
 * 前线突破集结。
 *
 * 打击计划（state.plan 跨 tick 存续）：
 *   1. 目标 = 活敌的主城/指挥所，或高价值敌方咽喉格（切断即让其后方
 *      整片无锚区域孤军化：兵力当场减半并逐拍衰减——走廊地图上仅次于
 *      斩首的打击）。收益：端掉对方最后一座主城 = 直接淘汰（其全部
 *      领土减半沦为孤军），收益最高；切断咽喉次之；普通主城/指挥所再次之。
 *   2. 路径 = 多源 Dijkstra 求「己方可操作格 → 目标」的最优进军路线，
 *      代价 = 途经守军 + 风险权重 × 邻近敌军兵力（enemyPressure）+ 步数。
 *      风险项让路径主动绕开敌军重兵区；步数项让对方反应时间最短。
 *      入口优先选非锚点格（成本相近时）——从主城倾巢而出等于开门揖盗。
 *   3. 集结 = 入口兵力不足时以入口为输送焦点，沿路己方格自动合流；
 *      入口推兵量到路径需求 85% 即开打。集结可行性分两层：窗口集结
 *      （24 op 窗口可交付 + 集结期净产能 ≥ 需求 40%）与纵深集结
 *      （机动兵力 ≥ 需求 80% 且入口已有 15% 根基）——后者让
 *      「终结龟缩对手」的长集结不会被误判为打不动而放弃。
 *   4. 行军模式：从锚点（主城/指挥所）起步用 mode 1 半兵——主力出征的同时
 *      家里始终留一半守军，根治「换家被一波端」；踏上普通格后恢复
 *      mode 2 全冲。plan.headIdx 跟踪行军栈头部，减少路径抖动。
 *   5. 回防纪律：活跃威胁逼近（hops ≤ 8）时取消打击计划全军回防，
 *      除非打击能在威胁到达前端掉威胁来源的最后一座主城（斩首更快）。
 *   6. 机动兵力闸：不开需求超过当前机动兵力（全军 − 各格驻军保留）80%
 *      的新打击——进攻不得倾巢而出。
 *   7. 进行中打击的体检：目标被大幅增援（超出立计划时已计入的自然增长）
 *      即弃打止损；集结缺口连续两个观察窗（各 ≥25 tick）扩大 = 产能跟
 *      不上目标增长的无望集结，弃打转发育。弃打目标进入冷却，防止反复
 *      立计划把机动兵力永远耗在输送上。
 *
 * 前线突破集结：没有打击计划时，挑一个「集结后可突破」的前线对峙点作为
 * 输送焦点——周边兵力朝同一方向汇集成股，推兵量一旦足够就由扩张/切断
 * 自动打出去；无可突破点时退化为向最厚的前线兵堆合流整补。这保证前线
 * 兵力永远有统一方向感，不零散、不停滞。
 *
 * 切断入侵：对突入己方领土的活敌格，凡相邻己方格能全冲吃掉的立即打，
 * 深度越深、越靠近我锚点、目标是指挥所/主城者越优先。
 */

// 集结窗口：最多花多少 op 把一个打击入口喂饱。窗口要覆盖走廊地图里
// 远端大兵栈的输送链（10 步以内的来源 × 多路），太小会把「能打赢的仗」
// 误判成集结不起，从而永远不终结龟缩对手。
const GATHER_OPS = 24;
// 集结启动门槛：可交付兵力达到需求的比例即开始集结（越早集越快到线）。
// 开打门槛：入口推兵量达到路径需求的比例即开打。
const STRIKE_COMMIT_RATIO = 0.85;
// 集结起步线：可交付（含集结窗口产能）低于需求的此比例且纵深也不支持
// 长集结时，判定打不动，不浪费集结。
const RALLY_GATE_RATIO = 0.4;
// 纵深长集结线：机动兵力足以覆盖需求、且入口已有 15% 根基时允许长集结——
// 兵在图上、输送流迟早送到；产能差会把缺口越拉越小。没有这条线，打
// 龟缩大主城（需求随时间 +1/tick 增长）的仗永远集不起来。
const DEEP_RALLY_BASE_RATIO = 0.15;
const DEEP_RALLY_MOBILE_RATIO = 0.8;
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
// 活跃威胁逼近到此步数内：不开新打击、进行中的打击回防（除非斩首更快）。
const DEFENSE_BUSY_HOPS = 8;
// 非锚点入口偏好：成本不超过锚点入口的此倍数时改用普通格入口。
const NON_ANCHOR_ENTRY_MARGIN = 1.35;
// 机动兵力闸：新打击需求不得超过机动兵力的此比例（防倾巢而出）。
const MOBILE_BUDGET_RATIO = 0.8;
const MOBILE_BUDGET_FLOOR = 24;

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
 *   gains = 途经己方格能并入的兵力（扣除驻军保留）；
 *   required = 入口格需要的推兵量（+1 严格大于；皇冠目标含行进期增兵）。
 */
function evaluatePath(ctx, path, targetIsCrown) {
  let totalDefense = 0;
  let gains = 0;
  for (let i = 1; i < path.length; i += 1) {
    const idx = path[i];
    const owner = ctx.ownerAt(idx);
    if (ctx.isMineIdx(idx)) {
      gains += Math.max(0, ctx.army(idx) - ctx.garrisonAt(idx));
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

/** 列出打击目标：活敌的主城与指挥所 + 高价值敌方咽喉格（切断打击）。 */
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
  // 敌方咽喉格：切断即让其后方整片无锚区域孤军化（兵力当场减半并衰减）。
  // 这是走廊地图上性价比仅次于斩首的打击——城墙型对手（皇冠蹲坑）被切断
  // 一次就伤筋动骨。分离规模太小不值得专门跑一趟。
  for (const [owner, chokes] of ctx.enemyChokes()) {
    for (const [idx, sep] of chokes) {
      if (sep.cells < 5) {
        continue;
      }
      cells.push({
        idx,
        owner,
        isCrown: false,
        payoff: Math.min(600, sep.cells * 6 + Math.floor(sep.army * 0.5)),
      });
    }
  }
  return cells;
}

/**
 * 评估一个打击目标：路径、入口、需求、可交付兵力与评分。
 * 进行中的计划（同目标）优先从行军栈头部继续，减少路径抖动；
 * 锚点入口成本相近时改选非锚点入口（不从主城倾巢而出）。
 */
function evaluateTarget(ctx, state, target) {
  const pressure = ctx.enemyPressure();
  const enterCost = (idx) => invasionEnterCost(ctx, pressure, idx);
  const isTarget = (idx) => idx === target.idx;
  const operable = ctx.myOperable();
  const multi = ctx.dijkstra(operable, enterCost, isTarget);
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

  // 锚点入口偏好修正：若入口落在主城/指挥所且非锚点入口成本相近，改用
  // 普通格入口——锚点守军是最后的防线，不做行军起点。
  const entryKind = ctx.tileKind(chosen.entry);
  if ((entryKind === 'crown' || entryKind === 'city') && chosen.entry !== state.plan?.headIdx) {
    const nonAnchorSources = operable.filter((idx) => {
      const kind = ctx.tileKind(idx);
      return kind !== 'crown' && kind !== 'city';
    });
    if (nonAnchorSources.length > 0) {
      const alt = ctx.dijkstra(nonAnchorSources, enterCost, isTarget);
      if (alt && alt.cost <= chosen.cost * NON_ANCHOR_ENTRY_MARGIN + 2) {
        chosen = alt;
      }
    }
  }

  const pathEval = evaluatePath(ctx, chosen.path, target.isCrown);
  const entry = chosen.entry;
  // 行军模式：锚点起步半兵（留一半守家），普通格全冲。
  const marchMode = ctx.tileKind(entry) === 'crown' || ctx.tileKind(entry) === 'city' ? 1 : 2;
  const next = chosen.path[1];
  const entryPush = next === undefined ? 0 : ctx.previewPush(entry, next, marchMode);
  const gather = ctx.gatherable(entry, GATHER_OPS, -1);
  // 集结期间皇冠目标还在增兵，集结耗时计入需求。
  const effectiveRequired = pathEval.required + (target.isCrown ? gather.ticks : 0);
  const deliverable = entryPush + gather.amount;
  // 碾压终结：全军兵力已倍数于对方时降低开打门槛——拖着不打只会把对局
  // 拖进无限阵地的烂尾局。
  const overwhelm = ctx.stats().myArmy >= 2.5 * Math.max(1, ctx.armyOf(target.owner));
  const commitRatio = overwhelm ? 0.5 : STRIKE_COMMIT_RATIO;
  const ready = entryPush >= Math.ceil(pathEval.required * commitRatio);

  const victimArmy = ctx.armyOf(target.owner);
  const payoff =
    target.payoff ??
    (target.isCrown
      ? ctx.crownsOf(target.owner) === 1
        ? 1000 + Math.floor(victimArmy / 4)
        : 380
      : 170);
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
    marchMode,
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
        // 深入锚点腹地的活敌是最高优先级军事目标——不立即切断，等它
        // 被喂肥或贴到锚点就来不及了（评分压过一切常规打击）。
        score += anchorDist === 1 ? 380 : 340 - anchorDist * 20;
        score += Math.min(ctx.army(sIdx), 80); // 腹地切断顺手清理大兵堆旁的来敌
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

/**
 * 前线突破集结焦点：挑「集结后可突破」的前线对峙点（差距能由周边集结
 * 补上、且对峙期间不会被对方先下手），把分散的前线兵力导向同一突破口；
 * 推兵量一够，扩张/切断候选会自动执行突破。没有可突破点时不再乱动
 * （兵力留在皇冠上自然增长，胜过在前线平摊停滞）。
 */
function breakthroughFocus(ctx) {
  const frontierDist = ctx.frontierDist();
  let best = null;
  for (const sIdx of ctx.myOperable()) {
    if (ctx.isolatedAt(sIdx) || frontierDist[sIdx] !== 1) {
      continue; // 只看贴前线格
    }
    const gather = ctx.gatherable(sIdx, 6, -1);
    if (gather.amount < 2) {
      continue;
    }
    for (const tIdx of ctx.neighbors(sIdx)) {
      if (!ctx.passable(tIdx) || ctx.isMineIdx(tIdx)) {
        continue;
      }
      const owner = ctx.ownerAt(tIdx);
      if (owner > 0 && ctx.isTeammateOwner(owner)) {
        continue;
      }
      const tArmy = ctx.army(tIdx);
      const push = ctx.previewPush(sIdx, tIdx, 0);
      const deficit = tArmy + 1 - push;
      if (deficit <= 0) {
        continue; // 已可吃，扩张/切断会处理
      }
      if (gather.amount < deficit) {
        continue; // 集结也补不上差距
      }
      const enemyPush = ctx.isAliveEnemyIdx(tIdx) ? tArmy - 1 : 0;
      if (enemyPush > ctx.army(sIdx) + gather.amount) {
        continue; // 对峙不安全：集结期间会被对方先下手
      }
      let value;
      if (ctx.isAliveEnemyIdx(tIdx)) {
        value = 120 + Math.min(tArmy, 60);
      } else if (owner === 0) {
        value = 45 + Math.min(tArmy, 40);
      } else {
        value = 75; // 出局者/孤军领土
      }
      if (ctx.tileKind(tIdx) === 'swamp') {
        value *= 0.4;
      }
      const ticks = gather.ticks + 1;
      const score = value / (1 + 0.25 * ticks) - deficit * 1.2;
      if (!best || score > best.score) {
        best = { idx: sIdx, score };
      }
    }
  }
  return best ? { idx: best.idx, baseScore: 235 } : null;
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
    // 冷却中的目标跳过（无望集结 / 被大幅增援后弃打的），防止反复立计划。
    if ((state.planCooldown?.get(target.idx) ?? 0) > state.turn) {
      continue;
    }
    const evaluated = evaluateTarget(ctx, state, target);
    if (evaluated && (!best || evaluated.score > best.score)) {
      best = evaluated;
    }
  }

  // hysteresis：已有计划的当前评估 × REPLAN_MARGIN 仍不输新目标就继续。
  let current = null;
  if (state.plan) {
    current = evaluateTarget(ctx, state, {
      idx: state.plan.targetIdx,
      owner: state.plan.owner,
      isCrown: ctx.tileKind(state.plan.targetIdx) === 'crown',
    });
    if (current && (!best || current.score * REPLAN_MARGIN >= best.score)) {
      best = current;
    }
  }

  // 进行中打击的体检（仅当 best 仍是原计划目标时）：
  if (state.plan && best && best.targetIdx === state.plan.targetIdx) {
    const meta = state.plan; // 元数据挂在 plan 对象上，下方重写时携带
    if (typeof meta.startRequired !== 'number') {
      meta.startRequired = best.effectiveRequired;
    }
    // 目标被大幅增援（超出立计划时已计入的行进/集结期自然增长）：继续
    // 行军等于把兵栈送进增援后的虎口——弃打，已推进的兵栈转作前哨，
    // 该目标进入短冷却。
    if (
      best.effectiveRequired >
      meta.startRequired + Math.max(15, Math.ceil(meta.startRequired * 0.35))
    ) {
      state.planCooldown.set(best.targetIdx, state.turn + 60);
      state.plan = null;
      return { candidates, focus: breakthroughFocus(ctx) };
    }
    // 无望集结：缺口（需求 − 可交付）连续两个观察窗在扩大 = 产能跟不上
    // 目标增长（典型：对方皇冠更多，需求 +1/tick 比我输送快）。拖着只会
    // 把全部机动兵力永远耗在集结上——弃打转发育，产能反超后冷却结束
    // 自然重开。
    if (!best.ready) {
      const gap = best.effectiveRequired - best.deliverable;
      if (typeof meta.gapAt === 'number' && state.turn - meta.gapAt >= 25) {
        meta.gapGrew = gap > meta.lastGap + 2 ? (meta.gapGrew || 0) + 1 : 0;
        meta.lastGap = gap;
        meta.gapAt = state.turn;
        if (meta.gapGrew >= 2) {
          state.planCooldown.set(best.targetIdx, state.turn + 150);
          state.plan = null;
          return { candidates, focus: breakthroughFocus(ctx) };
        }
      } else if (typeof meta.gapAt !== 'number') {
        meta.lastGap = gap;
        meta.gapAt = state.turn;
        meta.gapGrew = 0;
      }
    }
  }

  // 回防纪律：活跃威胁逼近时取消打击全军回防；除非进行中打击能抢在威胁
  // 到达前端掉威胁来源的最后一座主城（斩首成功 = 威胁源头整军孤军化）。
  const topThreat = threats.length > 0 ? threats[0] : null;
  if (state.plan && topThreat && topThreat.hops <= DEFENSE_BUSY_HOPS) {
    const finishing =
      current &&
      current.ready &&
      current.payoff >= 1000 &&
      current.owner === topThreat.blobOwner &&
      current.hops <= Math.max(1, topThreat.hops - 1);
    if (!finishing) {
      state.plan = null;
      return { candidates, focus: null };
    }
    best = current;
  }

  // 防御吃紧时不开新计划（兵力留给防御），进行中的贴近打击继续。
  const defenseBusy = topThreat !== null && topThreat.hops <= DEFENSE_BUSY_HOPS;
  if (!best || (defenseBusy && !state.plan)) {
    return { candidates, focus: defenseBusy ? null : breakthroughFocus(ctx) };
  }

  // 机动兵力闸：新打击需求不得透支机动兵力（全军 − 各格驻军保留）。
  // 打不起的仗不打，前线转为突破集结/整补。
  if (!state.plan) {
    const budget = Math.max(MOBILE_BUDGET_FLOOR, ctx.mobileArmy() * MOBILE_BUDGET_RATIO);
    if (!best.ready && best.effectiveRequired > budget) {
      return { candidates, focus: breakthroughFocus(ctx) };
    }
  }

  // 断供弃打：进行中的计划入口已无补给（周边没有可调之余兵）且推兵
  // 不达标——兵栈悬在敌境干等只会被逐个吃掉，放弃计划；该兵栈转作
  // 前哨，由切断/突破等常规逻辑继续使用。
  if (state.plan && best && !best.ready && best.gatherTicks === 0 && best.deliverable < best.effectiveRequired) {
    state.plan = null;
    return { candidates, focus: breakthroughFocus(ctx) };
  }

  // 目标明显打不动时不浪费集结。两层判定：
  //   1) 窗口集结：24 op 窗口内可交付 + 集结期净产能 ≥ 需求 40%——常规标准；
  //   2) 纵深集结：机动兵力 ≥ 需求 80%（兵在图上，只是还没走到）且入口已
  //      有 15% 根基——龟缩对手的皇冠需求虽在增长，但我方产能更高时，
  //      长集结一定收敛；这条线让「终结龟缩」的仗能集起来。
  if (!best.ready) {
    const burst = ctx.state.turn >= 26 && ctx.state.turn <= 50;
    const myProd = ctx.myCrowns().length + (burst ? ctx.stats().myLand : 0);
    const targetProd = best.isCrown ? 1 : 0;
    const windowTicks = Math.ceil(GATHER_OPS / 2);
    const projected = best.deliverable + Math.max(0, myProd - targetProd) * windowTicks;
    const windowViable = projected >= best.effectiveRequired * RALLY_GATE_RATIO;
    const deepViable =
      ctx.mobileArmy() * DEEP_RALLY_MOBILE_RATIO >= best.effectiveRequired &&
      best.deliverable >= best.effectiveRequired * DEEP_RALLY_BASE_RATIO;
    if (!windowViable && !deepViable) {
      state.plan = null;
      return { candidates, focus: breakthroughFocus(ctx) };
    }
  }

  const prevPlan = state.plan;
  state.plan = {
    targetIdx: best.targetIdx,
    owner: best.owner,
    headIdx: best.entry,
  };
  // 携带同目标旧计划的体检元数据（立计划需求基线、缺口趋势）。
  if (prevPlan && prevPlan.targetIdx === best.targetIdx) {
    state.plan.startRequired = prevPlan.startRequired;
    state.plan.lastGap = prevPlan.lastGap;
    state.plan.gapAt = prevPlan.gapAt;
    state.plan.gapGrew = prevPlan.gapGrew;
  }

  if (best.ready) {
    const next = best.path[1];
    candidates.push({
      score: best.payoff >= 1000 ? 820 : best.isCrown ? 610 : 560,
      preempt: false,
      op: attackOp(ctx, best.entry, next, best.marchMode),
      srcKey: best.entry,
      tag: 'strike',
    });
    // 行军加速：路径还长时把再下一步也排进队列（本 tick 只执行一条，
    // 第二条下 tick 立即执行——若第一步受挫该 op 会被引擎自动跳过）。
    if (best.path.length >= 3) {
      const after = best.path[2];
      candidates.push({
        score: best.payoff >= 1000 ? 810 : best.isCrown ? 600 : 550,
        preempt: false,
        op: attackOp(ctx, next, after, 2),
        srcKey: next,
        tag: 'strike',
      });
    }
    // 行军栈头部前移到下一格，下 tick 从头部继续规划（防路径抖动）。
    state.plan.headIdx = next;
    return { candidates, focus: null };
  }

  return { candidates, focus: { idx: best.entry, baseScore: 340 } };
}

module.exports = { planOffense };
