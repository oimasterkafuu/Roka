/**
 * logistics.js — 后勤：兵力汇集输送（flow）与中立扩张（expansion）。
 *
 * 汇集输送：给定焦点格（防御集结点 rally 或打击入口 entry），对所有
 * 己方格求「到焦点的 BFS 距离场」，每 tick 挑选性价比最高的一个己方格
 * 向焦点方向推进一步。效果上是多源、多链路的传送带：沿路各格兵力
 * 逐 tick 向焦点合流，而不是每次都从兵力最大的单点出发取兵。
 * 无焦点时退化为通用前线输送（沿 frontierDist 向最近前线送兵）。
 *
 * 稳定性细节：
 *   - 推出量用与引擎一致的 previewPush 预演，推不出兵的 op 根本不下发
 *     （服务端会跳过无效队首，但会白耗本 tick 的执行名额）；
 *   - 边境暴露格（邻接活敌）用 mode 0 智能分兵，自动保留防御兵力；
 *   - 防往返抖动：与上一 tick 输送方向恰好互逆的候选直接丢弃。
 *
 * 中立扩张：边界格用 mode 0 智能分兵占领中立/孤军格，优先 0 兵空地；
 * 爆发期（26–50 tick）普通格扩张加权（每块地都在爆兵）；活敌格不在
 * 这里处理（交给 offense 的 cut / strike）。
 */

// 爆发期区间（与 src/game-engine/tick-growth.ts 一致）。
const BURST_START_TURN = 26;
const BURST_END_TURN = 50;
// 无焦点输送只动腹地格（距前线 >= 2），边界格留给扩张/切断决策。
const FRONTIER_FLOW_MIN_DIST = 2;

function attackOp(ctx, fromIdx, toIdx, mode) {
  const from = ctx.xy(fromIdx);
  const to = ctx.xy(toIdx);
  return { kind: 'attack', payload: { x: from.x, y: from.y, dx: to.x, dy: to.y, mode } };
}

/** 中立/失主领土扩张候选（mode 0 智能分兵）。 */
function expansionCandidates(ctx, state) {
  const candidates = [];
  const burst = state.turn >= BURST_START_TURN && state.turn <= BURST_END_TURN;
  for (const sIdx of ctx.myOperable()) {
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
      const tArmy = ctx.army(tIdx);
      const push = ctx.previewPush(sIdx, tIdx, 0);
      // 引擎语义：推兵严格大于守军才占领；推不动或占不下的 op 不下发。
      if (push <= tArmy) {
        continue;
      }
      const kind = ctx.tileKind(tIdx);
      let base;
      if (kind === 'swamp') {
        base = 45; // 沼泽永不产兵，优先级最低
      } else if (owner === 0) {
        base = tArmy === 0 ? 130 : 122 - Math.min(tArmy, 50);
      } else {
        // 孤军/出局者领土：不增兵不反击，近乎白捡。
        base = 125 - Math.min(tArmy, 50);
      }
      if (burst && kind === 'plain') {
        base += 35;
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
 * 汇集输送候选。focus = {idx, baseScore} 时向焦点输送；否则向最近前线输送。
 * @returns 候选数组（pipeline 取最高分的一条或两条）
 */
function flowCandidates(ctx, state, focus) {
  const field = focus
    ? ctx.bfsField([focus.idx], (idx) => ctx.isMineIdx(idx))
    : ctx.frontierDist();
  const minDist = focus ? 1 : FRONTIER_FLOW_MIN_DIST;
  const candidates = [];
  for (const sIdx of ctx.myOperable()) {
    if (focus && sIdx === focus.idx) {
      continue;
    }
    const d = field[sIdx];
    if (d < minDist) {
      continue;
    }
    for (const tIdx of ctx.neighbors(sIdx)) {
      if (!ctx.isMineIdx(tIdx) || field[tIdx] !== d - 1) {
        continue;
      }
      // 防往返：上一 tick 刚把 tIdx 的兵推进 sIdx，就别再推回去。
      if (state.lastFlow && state.lastFlow.from === tIdx && state.lastFlow.to === sIdx) {
        continue;
      }
      const borderExposed = ctx.keepAt(sIdx) > 1;
      const mode = borderExposed ? 0 : 2;
      const push = ctx.previewPush(sIdx, tIdx, mode);
      if (push < 1) {
        continue;
      }
      const base = focus ? focus.baseScore : 50;
      candidates.push({
        score: base + Math.min(push, 80) / 4 - 2 * d,
        preempt: false,
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
