/**
 * defense.js — 防御计算：敌方进攻路径推演 + 防御/拦截候选生成。
 *
 * 核心思路：对每一个成规模的活敌兵力点（blob），用 Dijkstra 推演其进攻
 * 我方最近锚点（主城/指挥所）代价最低的路径，并按引擎战斗规则逐格模拟
 * 兵力损耗。凡能带着剩余兵力在若干 tick 后抵达锚点的，记为威胁；再按
 * 「到达 tick 数」排序。威胁分两层：
 *   - 静止威胁（龟缩的大兵堆）：只做贴脸应急与「可吃即切」，不集结、
 *     不冻结经济——不为一个不动的东西拖垮自己的皇冠生产线；
 *   - 活跃威胁（hops 在缩小的，即正在逼近的）：才触发集结布防（C）、
 *     紧急抢占与撤离/决战（D），并向上层输出 activeThreats 用于冻结
 *     经济与暂缓新进攻计划。
 * 应对手段按优先级：
 *   A. 锚点贴脸应急：能歼灭（推兵严格大于）就歼灭，危急时先削弱；
 *   B. 直接反击兵源：贴住 blob 的己方格能吃掉它就立刻打；
 *   C. 集结拦截：在威胁路径上挑一个能及时集结足够兵力的己方格作为
 *      集结点（rally），由 logistics 的输送流把兵力调过去——提前防御；
 *      集结点带滞后保持（且路径上已有守得住的格时不再集结），防止
 *      焦点逐 tick 振荡导致输送流往返倒兵；
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
 * 威胁激活判定：只有「正在逼近」的威胁才触发集结/冻结经济。
 *
 * 威胁模型假设敌格立即向我方锚点开拔。对龟缩对手（大兵堆蹲在原地不动），
 * 这个假设永远不成立——若因一个静止的兵堆永久冻结建设，皇冠数量永远起
 * 不来，收入永远追不上，正是「越守越穷」的死局。因此对每个
 * （敌方 owner, 我方锚点）组合记录历史最小 hops：
 *   - 本 tick 的 hops 严格小于历史最小值 = 正在逼近 → 激活；
 *   - 防御闩锁（defenseLatch）：一旦激活且 hops ≤ 8，闩锁 6 tick——
 *     在「守得住 ↔ 守不住」的平衡点上威胁会随我方集结/皇冠增兵反复进出
 *     清单，闩锁保证集结焦点不在平衡点上高频抖动；威胁真的消失
 *     （被歼灭/撤退）6 tick 后闩锁自动松开，正常恢复经济与进攻；
 *   - 滞留宽限：刚活跃过（4 tick 内）且没有明显撤退（hops 不超过历史
 *     最小值 +1）时保持激活；
 *   - 其余静止或变远的威胁不激活（不集结、不冻结经济），但它的贴脸应急
 *     与可吃即切仍然生效——敌格真进我境时由这两层兜底。
 * 状态存在 state.threatMinHops / state.threatLastActive / state.defenseLatch，
 * 随 resetMap 清空。
 */
function activateThreats(ctx, threats) {
  const { state } = ctx;
  if (!state.threatMinHops) {
    state.threatMinHops = new Map();
  }
  if (!state.threatLastActive) {
    state.threatLastActive = new Map();
  }
  if (!state.defenseLatch) {
    state.defenseLatch = new Map();
  }
  const active = [];
  const seenKeys = new Set();
  for (const t of threats) {
    const key = `${t.blobOwner}:${t.anchorIdx}`;
    seenKeys.add(key);
    const prevMin = state.threatMinHops.get(key);
    const lastActive = state.threatLastActive.get(key);
    const approaching = typeof prevMin !== 'number' || t.hops < prevMin;
    const latched = (state.defenseLatch.get(key) ?? -1) >= state.turn;
    const lingering =
      typeof prevMin === 'number' &&
      typeof lastActive === 'number' &&
      state.turn - lastActive <= 4 &&
      t.hops <= prevMin + 1;
    if (approaching && t.hops <= 8) {
      // 逼近到危险距离：上闩锁，至少坚守 6 tick。
      state.defenseLatch.set(key, state.turn + 6);
    }
    if (approaching || lingering || latched) {
      active.push(t);
      state.threatLastActive.set(key, state.turn);
    }
    if (approaching) {
      state.threatMinHops.set(key, t.hops);
    }
  }
  // 威胁从清单消失（被歼灭/撤退/守军已足够）后不续闩，6 tick 内自然松开。
  for (const key of [...state.defenseLatch.keys()]) {
    if (!seenKeys.has(key) && (state.defenseLatch.get(key) ?? -1) < state.turn) {
      state.defenseLatch.delete(key);
    }
  }
  return active;
}

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
 * 沿威胁路径从 blob 侧向锚点扫描己方格：某格在 blob 到达前还有 k tick，
 * 需要守住 = 到达时兵力 >= 到达时强度（引擎：推兵 <= 守军则进攻失败）。
 * 缺口 = 到达强度 - 现有兵力 - 等待期增兵；用 gatherable 估算 k-1 个 op
 * 窗口内能集结多少。优先选「可行且缺口最小」的点（最早最省地解除威胁）；
 * 都不可行时选缺口最小的点做最后的抵抗。遇到第一个「天然守得住」
 * （缺口 ≤ 0）的格即停止扫描：它前方没有可集结点就直接不集结
 * （blob 会死在它前面），避免前线/锚点间集结振荡。
 * preferIdx（上 tick 的集结点）仍在候选中且不比最优差太多（缺口差 < 12、
 * 可行性不更差）时沿用——集结点逐 tick 在相邻格间跳变会让输送流来回
 * 倒兵（兵力在集结点与锚点间往返 shuttle），反而抽干锚点、贻误战机。
 */
function chooseRally(ctx, threat, preferIdx = -1) {
  const { path, prefixStrength } = threat;
  const candidates = [];
  // 从 blob 侧向锚点扫描：第一个「到达时天然守得住」的己方格意味着
  // blob 会死在它前面——此时若再去集结锚点侧缺口更大的格，就会把刚
  // 集结到前线的兵力抽回去，下一 tick 前线又失守、再集结……如此逐
  // tick 往返 shuttle（集结点在相邻格间振荡），反而抽干锚点贻误战机。
  // 因此存在已守得住的格时：其前方（靠 blob 侧）还有可集结点则向前
  // 集结（更早拦截、减少领土损失），否则不再集结、按兵不动。
  for (let i = 1; i < path.length; i += 1) {
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
      // 该点天然守得住（上游守军已把 blob 磨到无害）：前方没有可集结
      // 点时才直接收兵；有则继续向前集结争取更早拦截。
      if (candidates.length === 0) {
        return null;
      }
      break;
    }
    const gather = ctx.gatherable(idx, Math.max(0, k - 1), -1, true);
    candidates.push({ idx, k, need, feasible: gather.amount >= need });
  }
  let best = null;
  for (const candidate of candidates) {
    if (
      !best ||
      (candidate.feasible && !best.feasible) ||
      (candidate.feasible === best.feasible && candidate.need < best.need)
    ) {
      best = candidate;
    }
  }
  if (best && preferIdx >= 0) {
    const preferred = candidates.find((c) => c.idx === preferIdx);
    if (
      preferred &&
      (preferred.feasible || !best.feasible) &&
      preferred.need <= best.need + 12
    ) {
      return preferred;
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

  /* ---------- B/C/D. 纵深威胁应对 ----------
   * B（可吃即切）对全部威胁生效——静止的敌兵堆能吃掉也该吃；
   * C/D（集结布防、撤离/决战）只对「正在逼近」的活跃威胁生效，
   * 不为静止的龟缩兵堆冻结经济与集结。 */
  const activeThreats = activateThreats(ctx, threats);
  let rally = null;
  let rallyScore = 0;
  let urgent = false;
  const threat = threats[0];
  const activeThreat = activeThreats[0] || null;
  if (threat) {
    // B. 直接反击兵源：贴住 blob 的己方格能吃掉它就打；紧急时削弱到
    // 「剩余强度 <= 锚点到达时守军」也算解围。
    const urgentB = threat.hops <= URGENT_HOPS;
    for (const sIdx of ctx.neighbors(threat.blobIdx)) {
      if (!ctx.operable(sIdx)) {
        continue;
      }
      const push = ctx.army(sIdx) - 1;
      if (push > threat.blobArmy) {
        candidates.push({
          score: 880,
          preempt: urgentB,
          op: attackOp(ctx, sIdx, threat.blobIdx, 2),
          srcKey: sIdx,
          tag: 'intercept-kill',
        });
      } else if (push >= 2 && threat.strengthAtAnchor - push <= threat.anchorDefenseAtArrival) {
        candidates.push({
          score: 840,
          preempt: urgentB,
          op: attackOp(ctx, sIdx, threat.blobIdx, 2),
          srcKey: sIdx,
          tag: 'intercept-weaken',
        });
      }
    }
  }

  if (activeThreat) {
    urgent = activeThreat.hops <= URGENT_HOPS;

    // C. 集结拦截/坚守：把 rally 交给 logistics 的输送流。
    // rally 滞后保持：评估前 3 个威胁的集结点，若上 tick 的 rally 仍在
    // 其中就沿用，避免多路受敌时集结焦点来回跳变导致输送往返。
    if (activeThreat.hops <= RALLY_WINDOW_HOPS) {
      const choices = [];
      for (const t of activeThreats.slice(0, 3)) {
        if (t.hops > RALLY_WINDOW_HOPS) {
          continue;
        }
        const c = chooseRally(ctx, t, state.rallyIdx ?? -1);
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

  return { candidates, rally, rallyScore, urgent, activeThreats };
}

module.exports = { evaluateThreats, planDefense, THREAT_MIN_ARMY, THREAT_MAX_HOPS };
