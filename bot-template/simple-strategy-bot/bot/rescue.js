/**
 * rescue.js — 切断救援：组织兵力打通走廊，接应被敌方截断的孤军区域。
 *
 * 引擎规则依据（src/game-engine.ts applyConnectivity）：
 *   领土与任一锚点（主城/指挥所）失去连通的瞬间兵力减半并孤军化，
 *   10 tick 宽限后每 2 tick 衰减 5% 直至中立；孤军格不能移动也不能产兵。
 *   而一旦重连（我方任一连通格与孤军格相邻成链），孤军立即恢复且兵力 ×2。
 *   因此「打通一格走廊」是全局性价比最高的操作之一：救回整片领土、兵力翻倍、
 *   恢复产能；反之放任不管就是整片白送。
 *
 * 决策：
 *   1. 孤军格聚块（board.myIsolatedRegions），逐块评估；
 *   2. 走廊 = 多源 Dijkstra：从我方「连通且可操作」的格子出发，穿过非己方格
 *      （代价 = 守军 + 1 + 邻近敌军风险），抵达该块任一格即打通；
 *   3. 需求 required = 走廊守军和 + 1；可交付 = 入口推兵 + 沿途可集结余量
 *      （gatherable 严格口径，不动咽喉守军）。价值 = 块内兵力（重连翻倍计
 *      半）+ 地格 + 指挥所加成，再按衰减窗口打折（救不回来之前就没兵了
 *      的块不值钱）；
 *   4. 可行（可交付 >= 需求）且性价比高 → 生成救援计划 state.rescuePlan
 *      （跨 tick 存续，带滞后防抖动）：入口未就绪则以入口为集结焦点，
 *      就绪则沿走廊逐格全冲推进；
 *   5. 止损：可交付远低于需求（< 60%）或赶不上衰减窗口的块判定为「救不了」，
 *      不再投入——不再向其方向输送、不集结，把兵力留给主战场。
 */

// 走廊代价中「邻近敌军兵力」的风险权重（与 offense 一致）。
const RISK_WEIGHT = 0.35;
// 集结窗口：最多花多少 op 把救援走廊入口喂饱。
const GATHER_OPS = 8;
// 开打门槛：入口推兵量达到走廊需求的比例即推进。
const COMMIT_RATIO = 0.9;
// 止损线：可交付不足需求的 60% 判定救不了。
const HOPELESS_RATIO = 0.6;
// 孤军衰减节奏（与引擎 constants 一致）：10 tick 宽限，之后每 2 tick 5%。
const GRACE_TICKS = 10;
const DECAY_EVERY = 2;
const DECAY_RATIO = 0.05;

function attackOp(ctx, fromIdx, toIdx, mode) {
  const from = ctx.xy(fromIdx);
  const to = ctx.xy(toIdx);
  return { kind: 'attack', payload: { x: from.x, y: from.y, dx: to.x, dy: to.y, mode } };
}

/** 估算再过 waitTicks 个 tick 该块还剩多少兵力（宽限期不衰减，之后指数衰减）。 */
function decayedArmy(army, isolatedAge, waitTicks) {
  let remaining = army;
  let age = isolatedAge;
  for (let t = 0; t < waitTicks; t += 1) {
    age += 1;
    if (age > GRACE_TICKS && age % DECAY_EVERY === 1) {
      remaining = Math.max(0, remaining - Math.max(1, Math.ceil(remaining * DECAY_RATIO)));
    }
  }
  return remaining;
}

/**
 * 评估一个孤军块的救援走廊。
 * @param forcedEntry 非空时只从该入口单源推演（进行中的计划沿用走廊，防抖动）
 * @returns 可行计划 {entry, path, required, deliverable, ready, score} 或
 *          不可行 {hopeless: true} 或 null（无走廊）
 */
function evaluateRegion(ctx, state, region, forcedEntry = null) {
  const pressure = ctx.enemyPressure();
  const regionSet = new Set(region.cells);

  // 孤军块的年龄 = 块内格子的最大 isolatedAge（近似整体剩余窗口）。
  let maxAge = 0;
  for (const idx of region.cells) {
    maxAge = Math.max(maxAge, ctx.state.isolated[idx] || 0);
  }

  const enterCost = (idx) => {
    if (!ctx.passable(idx)) {
      return Infinity;
    }
    if (ctx.isMineIdx(idx)) {
      return 1; // 己方格（含孤军格）进入代价 1 步
    }
    const owner = ctx.ownerAt(idx);
    if (owner > 0 && ctx.isTeammateOwner(owner)) {
      return Infinity; // 不借道队友领土
    }
    return ctx.army(idx) + 1 + RISK_WEIGHT * pressure[idx];
  };
  const isTarget = (idx) => regionSet.has(idx);

  // 多源：全部连通可操作的己方格；forcedEntry 时锁定入口。
  const sources = forcedEntry !== null ? [forcedEntry] : ctx.myOperable().filter((idx) => !ctx.isolatedAt(idx));
  if (sources.length === 0) {
    return null;
  }
  const result = ctx.dijkstra(sources, enterCost, isTarget);
  if (!result) {
    return null;
  }
  const { path, entry } = result;

  // 需求 = 走廊上非己方格的守军和 + 1（逐格严格大于才能连穿）。
  let defense = 0;
  for (let i = 1; i < path.length; i += 1) {
    const cell = path[i];
    if (!ctx.isMineIdx(cell)) {
      defense += ctx.army(cell);
    }
  }
  const required = defense + 1;
  const hops = path.length - 1;

  const entryPush = ctx.army(entry) - 1;
  const gather = ctx.gatherable(entry, GATHER_OPS, -1);
  const deliverable = entryPush + gather.amount;
  const ready = entryPush >= Math.ceil(required * COMMIT_RATIO);
  const eta = ready ? hops : gather.ticks + hops;

  // 止损判定：可交付远低于需求 → 救不了；或打通时块内兵力已所剩无几。
  if (deliverable < required * HOPELESS_RATIO) {
    return { hopeless: true };
  }
  const rescuedArmy = decayedArmy(region.army, maxAge, eta);
  const value = rescuedArmy * 0.5 + region.cells.length * 2 + region.anchors * 40;
  if (value < required * 0.5) {
    return { hopeless: true }; // 代价远超收益，不救
  }

  const score = (value * (ready ? 1.2 : 0.7)) / (1 + 0.15 * eta);
  return {
    entry,
    path,
    required,
    deliverable,
    ready,
    hops,
    score,
    value,
    regionSize: region.cells.length,
  };
}

/**
 * 救援主入口。
 * 计划承诺制：已有计划且区域仍在、走廊仍可行时，锁定原入口继续推进
 * （每 tick 用最新棋盘从原入口重算走廊），不在多条近似走廊间跳变；
 * 走廊被打穿或区域消失/重连后才重新评估全部孤军块。
 * @returns {{candidates: Array, focus: {idx, baseScore}|null}}
 */
function planRescue(ctx, state) {
  const candidates = [];
  const regions = ctx.myIsolatedRegions();
  if (regions.length === 0) {
    state.rescuePlan = null;
    return { candidates, focus: null };
  }

  // 进行中的计划：区域仍有孤军格则沿用入口继续。
  if (state.rescuePlan) {
    const aliveCells = state.rescuePlan.regionCells.filter((idx) => ctx.isMineIdx(idx) && ctx.isolatedAt(idx));
    if (aliveCells.length === 0) {
      state.rescuePlan = null;
    } else {
      let army = 0;
      let anchors = 0;
      for (const idx of aliveCells) {
        army += ctx.army(idx);
        if (ctx.tileKind(idx) === 'city') {
          anchors += 1;
        }
      }
      const region = { cells: aliveCells, army, anchors };
      const entryOk =
        ctx.isConnectedMine(state.rescuePlan.entry) && ctx.army(state.rescuePlan.entry) > 1;
      const re = entryOk ? evaluateRegion(ctx, state, region, state.rescuePlan.entry) : null;
      if (!re || re.hopeless) {
        state.rescuePlan = null; // 走廊消失或已救不了 → 放弃，转入重新评估
      } else {
        re.regionCells = aliveCells;
        state.rescuePlan = {
          entry: re.entry,
          path: re.path,
          required: re.required,
          score: re.score,
          regionCells: aliveCells,
        };
        if (re.ready) {
          const next = re.path[1];
          candidates.push({
            score: 640 + Math.min(re.value, 120),
            preempt: false,
            op: attackOp(ctx, re.entry, next, 2),
            srcKey: re.entry,
            tag: 'rescue',
          });
          return { candidates, focus: null };
        }
        return { candidates, focus: { idx: re.entry, baseScore: 360 } };
      }
    }
  }

  let best = null;
  for (const region of regions) {
    const evaluated = evaluateRegion(ctx, state, region);
    if (!evaluated) {
      continue;
    }
    if (evaluated.hopeless) {
      // 止损：救不了的块不投入任何兵力（不集结、不输送），把兵力留给主战场。
      continue;
    }
    evaluated.regionCells = region.cells;
    if (!best || evaluated.score > best.score) {
      best = evaluated;
    }
  }

  if (!best) {
    return { candidates, focus: null };
  }

  state.rescuePlan = {
    entry: best.entry,
    path: best.path,
    required: best.required,
    score: best.score,
    regionCells: best.regionCells,
  };

  if (best.ready) {
    const next = best.path[1];
    candidates.push({
      score: 640 + Math.min(best.value, 120),
      preempt: false,
      op: attackOp(ctx, best.entry, next, 2),
      srcKey: best.entry,
      tag: 'rescue',
    });
    return { candidates, focus: null };
  }

  return { candidates, focus: { idx: best.entry, baseScore: 360 } };
}

module.exports = { planRescue };
