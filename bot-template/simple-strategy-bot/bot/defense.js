/**
 * defense.js — 防御计算：敌方进攻路径推演 + 防御/拦截候选生成。
 *
 * 核心思路：对每一个成规模的活敌兵力点（blob），用 Dijkstra 推演其进攻
 * 我方最近锚点（主城/指挥所）代价最低的路径，并按引擎战斗规则逐格模拟
 * 兵力损耗。凡能带着剩余兵力在若干 tick 后抵达锚点的，记为威胁；再按
 * 「到达 tick 数」排序。应对手段按优先级：
 *   A. 锚点贴脸应急：能歼灭（推兵严格大于）就歼灭，危急时先削弱；
 *   B. 直接反击兵源：贴住 blob 的己方格能吃掉它就立刻打；
 *   C. 集结拦截：在威胁路径上挑一个能及时集结足够兵力的己方格作为
 *      集结点（rally），由 logistics 的输送流把兵力调过去——提前防御；
 *   D. 守不住时：多主城则提前撤空将死主城兵力，单主城则全军出击换伤害。
 */

// 低于此兵力的敌格不构成纵深威胁（走两步就被地形/守军磨没了）。
const THREAT_MIN_ARMY = 6;
// 只推演距锚点 12 步以内的威胁（更远的等它靠近再说，每 tick 都会重算）。
const THREAT_MAX_HOPS = 12;
// 到达剩余 tick ≤ 此值视为紧急：防御 op 抢占队列（clear_queue 后立即执行）。
const URGENT_HOPS = 2;
// 开始为威胁集结的步数窗口。
const RALLY_WINDOW_HOPS = 10;

/**
 * 推演所有针对我方锚点的威胁，按紧急程度排序。
 * @returns 威胁数组 [{blobIdx, blobOwner, blobArmy, anchorIdx, anchorIsCrown,
 *   path, hops, strengthAtAnchor, anchorDefenseAtArrival, prefixStrength}]
 */
function evaluateThreats(ctx) {
  const { state } = ctx;
  const anchors = ctx.myAnchors();
  if (anchors.length === 0) {
    return [];
  }
  const anchorSet = new Set(anchors.map((a) => a.idx));
  const anchorDistAll = ctx.anchorDistAll();

  // 逐格代价（敌军视角）：经过敌格免费（保守：不指望敌人互殴），经过
  // 己方/中立格要付守军代价，山不可通行。
  const enterCost = (idx) => {
    if (!ctx.passable(idx)) {
      return Infinity;
    }
    if (ctx.isMineIdx(idx)) {
      return ctx.army(idx) + 1;
    }
    const owner = ctx.ownerAt(idx);
    if (owner === 0) {
      return ctx.army(idx) + 1;
    }
    return 1;
  };

  const threats = [];
  for (let idx = 0; idx < ctx.state.n * ctx.state.m; idx += 1) {
    if (!ctx.isAliveEnemyIdx(idx) || ctx.army(idx) < THREAT_MIN_ARMY) {
      continue;
    }
    // 粗筛：BFS 直线距离都超过窗口的 blob 不值得跑 Dijkstra。
    const roughDist = anchorDistAll[idx] < 0 ? Infinity : anchorDistAll[idx];
    if (roughDist > THREAT_MAX_HOPS) {
      continue;
    }

    const result = ctx.dijkstra([idx], enterCost, (cell) => anchorSet.has(cell));
    if (!result) {
      continue;
    }
    const path = result.path;
    const hops = path.length - 1;
    if (hops < 1 || hops > THREAT_MAX_HOPS) {
      continue;
    }

    // 逐格模拟：blob 以最激进的全冲（mode 2，推兵 = 兵力-1）推进，
    // 经过己方/中立格按守军严格大于规则扣减，经过敌格无损耗。
    // 注意模拟只走到锚点【前】一格；与锚点本身的胜负在下方统一判定
    // （到达强度 vs 到达时守军），避免锚点守军被重复扣减。
    let strength = ctx.army(idx) - 1;
    const prefixStrength = [strength];
    let reached = true;
    for (let i = 1; i < path.length - 1; i += 1) {
      const cell = path[i];
      const owner = ctx.ownerAt(cell);
      const isFreePassage = owner > 0 && !ctx.isMineIdx(cell);
      if (!isFreePassage) {
        const defense = ctx.army(cell);
        if (strength > defense) {
          strength -= defense;
        } else {
          reached = false;
          break;
        }
      }
      prefixStrength.push(strength);
    }
    if (!reached) {
      continue;
    }

    const anchorIdx = path[path.length - 1];
    const anchorIsCrown = ctx.tileKind(anchorIdx) === 'crown';
    // 锚点在等待期间也会增兵：主城每 tick +1，指挥所约每 50 tick +1（忽略）。
    // 引擎语义：推兵 <= 守军则进攻失败，故到达强度严格大于到达守军才构成威胁。
    const anchorDefenseAtArrival = ctx.army(anchorIdx) + (anchorIsCrown ? hops : 0);
    if (strength <= anchorDefenseAtArrival) {
      continue;
    }
    threats.push({
      blobIdx: idx,
      blobOwner: ctx.ownerAt(idx),
      blobArmy: ctx.army(idx),
      anchorIdx,
      anchorIsCrown,
      path,
      hops,
      strengthAtAnchor: strength,
      anchorDefenseAtArrival,
      prefixStrength,
    });
  }

  threats.sort((a, b) => a.hops - b.hops || b.strengthAtAnchor - a.strengthAtAnchor);
  return threats;
}

/**
 * 在威胁路径上选择集结点（rally）。
 * 候选为路径上的全部己方格（含锚点）。某格在 blob 到达前还有 k tick，
 * 需要守住 = 到达时兵力 >= 到达时强度（引擎：推兵 <= 守军则进攻失败）。
 * 缺口 = 到达强度 - 现有兵力 - 等待期增兵；用 gatherable 估算 k-1 个 op
 * 窗口内能集结多少。优先选「可行且缺口最小」的点（最早最省地解除威胁）；
 * 都不可行时选缺口最小的点做最后的抵抗。
 */
function chooseRally(ctx, threat) {
  const { path, prefixStrength } = threat;
  let best = null;
  for (let i = path.length - 1; i >= 1; i -= 1) {
    const idx = path[i];
    if (!ctx.isMineIdx(idx)) {
      continue;
    }
    const k = i; // blob 到达该格还需 k tick
    const strengthAt = prefixStrength[i - 1]; // 到达该格前一格时的强度
    const isCrown = ctx.tileKind(idx) === 'crown';
    const defenseAtArrival = ctx.army(idx) + (isCrown ? k : 0);
    const need = strengthAt - defenseAtArrival;
    if (need <= 0) {
      // 该点天然守得住（上游守军已把 blob 磨到无害），无需集结。
      continue;
    }
    const gather = ctx.gatherable(idx, Math.max(0, k - 1), -1);
    const feasible = gather.amount >= need;
    const candidate = { idx, k, need, feasible };
    if (
      !best ||
      (candidate.feasible && !best.feasible) ||
      (candidate.feasible === best.feasible && candidate.need < best.need)
    ) {
      best = candidate;
    }
  }
  return best;
}

function attackOp(ctx, fromIdx, toIdx, mode) {
  const from = ctx.xy(fromIdx);
  const to = ctx.xy(toIdx);
  return { kind: 'attack', payload: { x: from.x, y: from.y, dx: to.x, dy: to.y, mode } };
}

/**
 * 生成防御候选与集结焦点。
 * @returns {{candidates: Array, rally: number|null, rallyScore: number, urgent: boolean}}
 */
function planDefense(ctx, threats) {
  const { state } = ctx;
  const candidates = [];
  const anchors = ctx.myAnchors();
  const crownCount = ctx.myCrowns().length;
  const lastCrownIdx = crownCount === 1 ? ctx.myCrowns()[0] : -1;

  /* ---------- A. 锚点贴脸应急 ---------- */
  for (const anchor of anchors) {
    for (const eIdx of ctx.neighbors(anchor.idx)) {
      if (!ctx.isAliveEnemyIdx(eIdx)) {
        continue;
      }
      const eArmy = ctx.army(eIdx);
      // 反击来源：能吃到该敌格的己方邻格（含锚点本身），取推兵最大者。
      let bestSource = null;
      let bestPush = 0;
      const sources = [anchor.idx, ...ctx.neighbors(eIdx)];
      for (const sIdx of sources) {
        if (!ctx.operable(sIdx)) {
          continue;
        }
        const push = ctx.army(sIdx) - 1;
        if (push > bestPush) {
          bestPush = push;
          bestSource = sIdx;
        }
      }
      if (bestSource === null) {
        continue;
      }
      const anchorArmy = ctx.army(anchor.idx);
      if (bestPush > eArmy) {
        candidates.push({
          score: 900 + (anchor.isCrown ? 40 : 0) + Math.min(eArmy, 60),
          // 唯一主城告急时抢占队列，不给过期 op 让路。
          preempt: anchor.idx === lastCrownIdx,
          op: attackOp(ctx, bestSource, eIdx, 2),
          srcKey: bestSource,
          tag: 'defend',
        });
      } else if (eArmy >= anchorArmy) {
        // 敌军下 tick 就能吃掉锚点：抢先削弱（互损，敌格兵力 -推兵量）。
        candidates.push({
          score: 860 + (anchor.isCrown ? 40 : 0),
          preempt: true,
          op: attackOp(ctx, bestSource, eIdx, 2),
          srcKey: bestSource,
          tag: 'defend-weaken',
        });
      }
    }
  }

  /* ---------- B/C/D. 纵深威胁应对 ---------- */
  let rally = null;
  let rallyScore = 0;
  let urgent = false;
  const threat = threats[0];
  if (threat) {
    urgent = threat.hops <= URGENT_HOPS;

    // B. 直接反击兵源：贴住 blob 的己方格能吃掉它就打；紧急时削弱到
    // 「剩余强度 <= 锚点到达时守军」也算解围。
    for (const sIdx of ctx.neighbors(threat.blobIdx)) {
      if (!ctx.operable(sIdx)) {
        continue;
      }
      const push = ctx.army(sIdx) - 1;
      if (push > threat.blobArmy) {
        candidates.push({
          score: 880,
          preempt: urgent,
          op: attackOp(ctx, sIdx, threat.blobIdx, 2),
          srcKey: sIdx,
          tag: 'intercept-kill',
        });
      } else if (push >= 2 && threat.strengthAtAnchor - push <= threat.anchorDefenseAtArrival) {
        candidates.push({
          score: 840,
          preempt: urgent,
          op: attackOp(ctx, sIdx, threat.blobIdx, 2),
          srcKey: sIdx,
          tag: 'intercept-weaken',
        });
      }
    }

    // C. 集结拦截/坚守：把 rally 交给 logistics 的输送流。
    // rally 滞后保持：评估前 3 个威胁的集结点，若上 tick 的 rally 仍在
    // 其中就沿用，避免多路受敌时集结焦点来回跳变导致输送往返。
    if (threat.hops <= RALLY_WINDOW_HOPS) {
      const choices = [];
      for (const t of threats.slice(0, 3)) {
        if (t.hops > RALLY_WINDOW_HOPS) {
          continue;
        }
        const c = chooseRally(ctx, t);
        if (c) {
          choices.push({ threat: t, choice: c });
        }
      }
      let selected = choices[0] || null;
      if (selected && typeof state.rallyIdx === 'number' && state.rallyIdx >= 0) {
        const preferred = choices.find((item) => item.choice.idx === state.rallyIdx);
        if (preferred) {
          selected = preferred;
        }
      }
      if (selected) {
        const { threat: selThreat, choice } = selected;
        rally = choice.idx;
        rallyScore = 620 + Math.max(0, 8 - Math.min(selThreat.hops, 8)) * 25;
        urgent = urgent || choice.k <= URGENT_HOPS;

        if (!choice.feasible && choice.idx === selThreat.anchorIdx && selThreat.anchorIsCrown) {
          // D. 主城守不住：多主城提前撤空（兵力不陪葬）；单主城全军出击。
          if (crownCount >= 2 && choice.k <= 1) {
            let evacTarget = -1;
            let evacScore = -1;
            for (const nIdx of ctx.neighbors(selThreat.anchorIdx)) {
              if (!ctx.isMineIdx(nIdx)) {
                continue;
              }
              const pressure = ctx.enemyPressure()[nIdx];
              const score = -pressure * 10 + ctx.army(nIdx);
              if (score > evacScore) {
                evacScore = score;
                evacTarget = nIdx;
              }
            }
            if (evacTarget >= 0) {
              candidates.push({
                score: 750,
                preempt: true,
                op: attackOp(ctx, selThreat.anchorIdx, evacTarget, 2),
                srcKey: selThreat.anchorIdx,
                tag: 'evacuate',
              });
            }
          } else if (crownCount <= 1) {
            for (let idx = 0; idx < state.n * state.m; idx += 1) {
              if (!ctx.operable(idx)) {
                continue;
              }
              for (const eIdx of ctx.neighbors(idx)) {
                if (!ctx.isAliveEnemyIdx(eIdx)) {
                  continue;
                }
                candidates.push({
                  score: 950,
                  preempt: true,
                  op: attackOp(ctx, idx, eIdx, 2),
                  srcKey: idx,
                  tag: 'last-stand',
                });
                break;
              }
            }
          }
        }
      }
    }
  }

  return { candidates, rally, rallyScore, urgent };
}

module.exports = { evaluateThreats, planDefense, THREAT_MIN_ARMY, THREAT_MAX_HOPS };
