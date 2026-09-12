/**
 * logistics.js — 后勤：兵力汇集输送（flow）与中立扩张（expansion）。
 *
 * 汇集输送：给定焦点格（防御集结点 rally / 救援走廊入口 / 打击入口 /
 * 突破集结点 / 喂养目标），对所有己方格求「到焦点的 BFS 距离场」，每 tick
 * 挑选性价比最高的己方格向焦点方向推进一步。效果上是多源、多链路的
 * 传送带：沿路各格兵力逐 tick 向焦点合流，而不是每次都从兵力最大的单点
 * 出发取兵。无焦点时退化为通用前线输送（沿 frontierDist 向最近前线送兵）。
 *
 * 稳定性细节：
 *   - 推出量用与引擎一致的 previewPush 预演，推不出兵的 op 根本不下发；
 *   - 驻军保留线（garrisonAt）：任何输送/扩张都不得把源格抽到保留线以下
 *     ——边境格保留邻敌推兵量，咽喉格保留分离区域守军（防截断偷家）。
 *     全冲会破线时退半兵，半兵也破线才跳过；有紧急焦点的集结（集结/救援）
 *     不受咽喉保留限制（生死关头全军可动）；
 *   - 升级链保护：兵力低于升级线且不贴活敌的指挥所不作输送/扩张源
 *     （兵是升皇冠的本金，抽走就永远升不了；军事操作不受此限）；
 *   - 防往返抖动：state.recentMoves 记录最近数 tick 的移动方向，与其中
 *     任一恰好互逆的候选直接丢弃（覆盖整个队列深度，而非只记上一 tick）。
 *
 * 中立扩张：边界格用 mode 0 智能分兵占领中立/孤军格，优先 0 兵空地
 * （多向可及时空地永远优先于永不产兵的沼泽）；12–25 tick 为爆发期前的
 * 抢地冲刺窗口（爆发期每块普通领土每 tick +1，圈地 = 产兵），扩张
 * 大幅加分；爆发期（26–50 tick）普通格扩张同样加权；活敌格不在
 * 这里处理（交给 offense 的 cut / strike）。
 */

// 爆发期区间（与 src/game-engine/tick-growth.ts 一致）。
const BURST_START_TURN = 26;
const BURST_END_TURN = 50;
// 抢地冲刺窗口（12–25 tick），见头注释。
const RUSH_START_TURN = 12;
const RUSH_END_TURN = 25;
const RUSH_BONUS = 100;
// 无焦点输送只动腹地格（距前线 >= 2），边界格留给扩张/切断/突破决策。
const FRONTIER_FLOW_MIN_DIST = 2;
// 升级链保护：兵力未稳过升级线（<52）且不贴活敌的指挥所是「正在攒升级」
// 的格子——它的兵是升皇冠的本金，不能被输送/扩张顺手抽走（抽走就永远
// 升不了）。军事操作（打击/切断/防御）不受此限。
const UPGRADE_CHAIN_LINE = 52;
// 建设 earmark：普通格兵力达到建设门槛（101）后不再作输送/扩张源——
// 兵是「直建皇冠」的本金，抽走会让队列中的建造令执行时失效。
const BUILD_EARMARK_ARMY = 101;
// 防往返窗口：与最近 4 tick 内任一移动恰好互逆的候选丢弃。
const ANTI_OSCILLATION_WINDOW = 4;

/** 升级链保护判定：低于升级线且安全的指挥所。 */
function inUpgradeChain(ctx, idx) {
  return ctx.tileKind(idx) === 'city' && ctx.army(idx) < UPGRADE_CHAIN_LINE && ctx.keepAt(idx) <= 1;
}

/** 建设 earmark 判定：兵力达到建设门槛的普通格（军事操作不受此限）。 */
function buildEarmarked(ctx, idx) {
  return ctx.tileKind(idx) === 'plain' && ctx.army(idx) >= BUILD_EARMARK_ARMY;
}

function attackOp(ctx, fromIdx, toIdx, mode) {
  const from = ctx.xy(fromIdx);
  const to = ctx.xy(toIdx);
  return { kind: 'attack', payload: { x: from.x, y: from.y, dx: to.x, dy: to.y, mode } };
}

/** 最近 reverseKey（to>from）方向上有过移动则视为往返抖动。 */
function isOscillation(state, fromIdx, toIdx) {
  const recent = state.recentMoves;
  if (!recent) {
    return false;
  }
  const at = recent.get(`${toIdx}>${fromIdx}`);
  return typeof at === 'number' && state.turn - at <= ANTI_OSCILLATION_WINDOW;
}

/** 中立/失主领土扩张候选（mode 0 智能分兵）。 */
function expansionCandidates(ctx, state) {
  const candidates = [];
  const burst = state.turn >= BURST_START_TURN && state.turn <= BURST_END_TURN;
  const rush = state.turn >= RUSH_START_TURN && state.turn <= RUSH_END_TURN;
  // 非冲刺期只扩张有产出的地皮（普通格/指挥所），沼泽永不产兵不抢；
  // 冲刺期（12–25 tick，为爆发期囤地）才连沼泽一起圈。
  const allowSwamp = rush;
  for (const sIdx of ctx.myOperable()) {
    if (inUpgradeChain(ctx, sIdx) || buildEarmarked(ctx, sIdx)) {
      continue; // 攒升级中的指挥所 / 攒直建皇冠的高兵普通格不外抽
    }
    for (const tIdx of ctx.neighbors(sIdx)) {
      if (!ctx.passable(tIdx) || ctx.isMineIdx(tIdx)) {
        continue;
      }
      const owner = ctx.ownerAt(tIdx);
      if (owner > 0 && ctx.isTeammateOwner(owner)) {
        continue;
      }
      // 活敌格由 offense 处理；这里只吃中立格与孤军/出局者领土。
      if (ctx.isAliveEnemyIdx(tIdx)) {
        continue;
      }
      const kind = ctx.tileKind(tIdx);
      if (kind === 'swamp' && !allowSwamp) {
        continue;
      }
      const tArmy = ctx.army(tIdx);
      // 引擎 mode 0 的「保留量」怪癖（中立空格也计 -1）靠 previewPush
      // 预演消化；结果上源格至少要留住 keepReserve 与驻军保留线。
      // 兵不是无限的：冲刺期每步给以后留 1 兵；目标是 0 兵中立格时也留 1
      // 即可（占下这块地本身就值回票价，剩 1 兵不是死格——mode 0 预演本就
      // 保证推出后至少留 1）；其余情况留 2 保持源格可操作。
      const keepReserve = rush || tArmy === 0 ? 1 : 2;
      const push = ctx.previewPush(sIdx, tIdx, 0);
      if (push <= tArmy || ctx.army(sIdx) - push < Math.max(keepReserve, ctx.garrisonAt(sIdx))) {
        continue;
      }
      let base;
      if (kind === 'swamp') {
        base = 45; // 沼泽永不产兵：多向可及时空地永远优先，沼泽垫底
      } else if (owner === 0) {
        base = tArmy === 0 ? 130 : 122 - Math.min(tArmy, 50);
      } else {
        // 孤军/出局者领土：不增兵不反击，近乎白捡。
        base = 125 - Math.min(tArmy, 50);
      }
      if (burst && kind === 'plain') {
        base += 35;
      }
      if (rush) {
        base += RUSH_BONUS; // 爆发期前的抢地冲刺：圈地 = 爆发期产兵
      }
      candidates.push({
        score: base + Math.min(ctx.army(sIdx), 60) / 6,
        preempt: false,
        op: attackOp(ctx, sIdx, tIdx, 0),
        srcKey: sIdx,
        tag: 'expand',
      });
    }
  }
  return candidates;
}

/**
 * 汇集输送候选。focus = {idx, baseScore, overrideGarrison} 时向焦点输送；
 * 否则向最近前线输送。
 * @returns 候选数组（pipeline 取最高分的一条或两条）
 */
function flowCandidates(ctx, state, focus) {
  const field = focus
    ? ctx.bfsField([focus.idx], (idx) => ctx.isMineIdx(idx) && !ctx.isolatedAt(idx))
    : ctx.frontierDist();
  const minDist = focus ? 1 : FRONTIER_FLOW_MIN_DIST;
  const overrideGarrison = Boolean(focus && focus.overrideGarrison);
  const candidates = [];
  for (const sIdx of ctx.myOperable()) {
    if (inUpgradeChain(ctx, sIdx) || buildEarmarked(ctx, sIdx)) {
      continue; // 攒升级中的指挥所 / 攒直建皇冠的高兵普通格不外抽
    }
    if (focus && sIdx === focus.idx) {
      continue;
    }
    const d = field[sIdx];
    if (d < minDist) {
      continue;
    }
    for (const tIdx of ctx.neighbors(sIdx)) {
      if (!ctx.isMineIdx(tIdx) || ctx.isolatedAt(tIdx) || field[tIdx] !== d - 1) {
        continue;
      }
      // 防往返：最近几 tick 刚把 tIdx 的兵推进 sIdx，就别再推回去。
      // 紧急集结（防御 rally）不受此限——敌军到家门口时该回头必须回头。
      if (!focus?.urgent && isOscillation(state, sIdx, tIdx)) {
        continue;
      }
      const borderExposed = ctx.keepAt(sIdx) > 1;
      const garrison = overrideGarrison ? ctx.keepAt(sIdx) : ctx.garrisonAt(sIdx);
      // 全冲（边境格智能分兵）优先；推完跌破驻军保留线则退半兵；
      // 半兵也守不住线就不动——要害格的守军不为常规输送所动。
      let mode = borderExposed ? 0 : 2;
      let push = ctx.previewPush(sIdx, tIdx, mode);
      if (push >= 1 && ctx.army(sIdx) - push < garrison && mode === 2) {
        mode = 1;
        push = ctx.previewPush(sIdx, tIdx, 1);
      }
      if (push < 1 || ctx.army(sIdx) - push < garrison) {
        continue;
      }
      const base = focus ? focus.baseScore : 50;
      candidates.push({
        score: base + Math.min(push, 80) / 4 - 2 * d,
        preempt: false,
        urgentFlow: Boolean(focus && focus.urgent),
        op: attackOp(ctx, sIdx, tIdx, mode),
        srcKey: sIdx,
        tag: 'flow',
      });
      break; // 每格只取一个最短路方向
    }
  }
  return candidates;
}

module.exports = { expansionCandidates, flowCandidates };
