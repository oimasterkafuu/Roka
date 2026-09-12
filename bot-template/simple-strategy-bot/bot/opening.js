/**
 * opening.js — 开局发育规划器（约 tick 1–50）。
 *
 * 规则依据（src/game-engine/tick-growth.ts 与 game-engine.ts）：
 *   主城每 tick +1 兵；26–50 tick 为爆发期，每块正常普通领土每 tick 额外 +1；
 *   每 tick 服务端只执行一条队首操作；推兵上限 = 兵力 - 1（每格至少留 1）。
 *
 * 关键结构洞察：开局即逐格外扩，深处每块新格都要付出链式补给的 op 代价
 *   （深度 d 的格 ≈ d 个 op）；而先憋主城兵力、再让大兵栈像蛇一样连续推进，
 *   每格只花 1 op。因此最优开局往往先空若干回合再启动——具体空几拍取决于
 *   本地地形（走廊深度、中立格守军、可用出口数），无法手写规则，只能模拟。
 *
 * 做法：每个 tick 用真实规则在本地模拟一组「等到第 w 拍再开工」的发育方案
 *   （蛇形推进 + 就近补链的贪心 rollout），在 tick 51 时点按
 *   「圈地爆发期总产兵 + 地皮 + 余兵」评分选最优；最优方案的首个操作即本
 *   tick 该下发的操作（可能是「按兵不动」）。每 tick 重算，滚动修正。
 *
 * 退出条件：turn > 50、主城丢失、任何活跃威胁、或活敌逼近我方领土
 *   （≤ ENEMY_ABORT_DIST 步）——敌情出现时立即交还常规管线。
 *   开局阶段不下任何建造令（爆发期圈地的产出效率远高于 50 兵一座的皇冠），
 *   也不发常规输送——模拟里已包含链式补给，外部输送只会打乱兵栈节奏。
 */

const BURST_START_TURN = 26;
const BURST_END_TURN = 50;
const OPENING_END_TURN = 50;
const ENEMY_ABORT_DIST = 6;
// 等待窗口搜索上限：再晚爆发期过半，憋兵失去意义。
const MAX_WAIT_TURN = 38;
// 模拟评分时点（爆发期结束后的第一拍）。
const HORIZON_TURN = 51;
// 每次规划的 rollout 个数上限（w = 当前+1 .. 当前+ROLL_OUTS）。
const MAX_ROLLOUTS = 22;
// 规划操作评分：低于防御/救援/切断，高于经济与常规输送。
const OPENING_OP_SCORE = 300;

function attackOp(ctx, fromIdx, toIdx, mode) {
  const from = ctx.xy(fromIdx);
  const to = ctx.xy(toIdx);
  return { kind: 'attack', payload: { x: from.x, y: from.y, dx: to.x, dy: to.y, mode } };
}

/**
 * 单次 rollout：从当前盘面出发，tick < startW 只憋兵，之后每 tick 执行
 * 贪心最优的一手（能占领则占领，否则把最大兵栈向最近可占领格推一格）。
 * 返回 { score, firstOps }（firstOps = 前两个 tick 的操作序列）。
 */
function rollout(ctx, startW, firstOpsOut) {
  const { state } = ctx;
  const total = state.n * state.m;
  // 静态地形：mountain 与「活敌格」都视为墙（开局阶段敌情出现即整体退出，
  // 能走到这里说明敌人还远，保守起见不当可占目标也不借道）。
  const passable = new Uint8Array(total);
  const isNeutralCity = new Uint8Array(total);
  const isSwamp = new Uint8Array(total);
  for (let idx = 0; idx < total; idx += 1) {
    const kind = ctx.tileKind(idx);
    const blocked = kind === 'mountain' || ctx.isAliveEnemyIdx(idx);
    passable[idx] = blocked ? 0 : 1;
    isNeutralCity[idx] = kind === 'city' && ctx.ownerAt(idx) === 0 ? 1 : 0;
    isSwamp[idx] = kind === 'swamp' ? 1 : 0;
  }
  const owned = new Uint8Array(total);
  const army = new Int32Array(total);
  const isCrown = new Uint8Array(total);
  for (let idx = 0; idx < total; idx += 1) {
    owned[idx] = ctx.isMineIdx(idx) ? 1 : 0;
    army[idx] = ctx.army(idx);
    isCrown[idx] = owned[idx] && ctx.tileKind(idx) === 'crown' ? 1 : 0;
  }
  // 已持有格的入手 tick 记 0（整个爆发期都参与产兵）。
  const captureTick = new Int16Array(total);

  const neighborsOf = (idx) => {
    const { x, y } = ctx.xy(idx);
    const out = [];
    for (const dir of ctx.directions) {
      const nx = x + dir.x;
      const ny = y + dir.y;
      if (ctx.inBounds(nx, ny)) {
        out.push(ctx.idx(nx, ny));
      }
    }
    return out;
  };

  // onwardBonus(v)：v 两格范围内可占领的中立格数（占领方向的开阔度）。
  const onwardCache = new Map();
  const onwardBonus = (v) => {
    if (onwardCache.has(v)) {
      return onwardCache.get(v);
    }
    let count = 0;
    for (const a of neighborsOf(v)) {
      if (!owned[a] && passable[a]) {
        count += 1;
      }
      for (const b of neighborsOf(a)) {
        if (b !== v && !owned[b] && passable[b]) {
          count += 0.5;
        }
      }
    }
    onwardCache.set(v, count);
    return count;
  };

  let lastPlanned = 0;
  for (let t = state.turn + 1; t <= HORIZON_TURN; t += 1) {
    // 增长：主城 +1；普通格每 50 tick +1；爆发期（26–50）正常普通格 +1。
    const burst = t >= BURST_START_TURN && t <= BURST_END_TURN;
    const plainGrowth = t % 50 === 0;
    for (let idx = 0; idx < total; idx += 1) {
      if (!owned[idx]) {
        continue;
      }
      if (isCrown[idx]) {
        army[idx] += 1;
      } else if (!isSwamp[idx] && (plainGrowth || burst)) {
        // 开局阶段不自建指挥所；中立城占领后会被引擎摧毁为普通格，一并按普通格算。
        army[idx] += 1;
      }
    }

    if (t < startW) {
      continue;
    }

    // 可占领目标距离场：全部「非己方、可通行」格为源（BFS 经过所有可通行格）。
    const field = new Int16Array(total).fill(-1);
    const queue = [];
    for (let idx = 0; idx < total; idx += 1) {
      if (!owned[idx] && passable[idx]) {
        field[idx] = 0;
        queue.push(idx);
      }
    }
    if (queue.length === 0) {
      break; // 无可占目标：只剩增长
    }
    let head = 0;
    while (head < queue.length) {
      const u = queue[head];
      head += 1;
      for (const v of neighborsOf(u)) {
        if (field[v] === -1 && passable[v]) {
          field[v] = field[u] + 1;
          queue.push(v);
        }
      }
    }

    // 候选一：直接占领（蛇头推进）。
    let bestOp = null;
    let bestScore = -Infinity;
    let bestFeed = null;
    let bestFeedArmy = 0;
    for (let s = 0; s < total; s += 1) {
      if (!owned[s] || army[s] <= 1) {
        continue;
      }
      for (const v of neighborsOf(s)) {
        if (!passable[v]) {
          continue;
        }
        if (!owned[v]) {
          const push = army[s] - 1;
          if (push <= army[v]) {
            continue; // 严格大于守军才占领
          }
          let score = isSwamp[v] ? 18 : 100;
          if (isNeutralCity[v]) {
            score += 20; // 中立城守军厚，占之即大片连通腹地（城体被摧毁为普通格）
          }
          score += 7 * onwardBonus(v);
          score -= 4 * Math.min(army[v], 30);
          score += Math.min(push, 40) * 0.25;
          if (score > bestScore) {
            bestScore = score;
            bestOp = [s, v];
          }
        } else if (field[v] >= 0 && field[s] === field[v] + 1) {
          // 候选二：链式补给——把兵栈向最靠近可占领格的己方格推一格。
          if (army[s] > bestFeedArmy) {
            bestFeedArmy = army[s];
            bestFeed = [s, v];
          }
        }
      }
    }

    const chosen = bestOp || bestFeed;
    if (!chosen) {
      continue; // 无棋可走：憋兵
    }
    const [s, v] = chosen;
    const push = army[s] - 1;
    army[s] = 1;
    if (!owned[v]) {
      army[v] = push - army[v];
      owned[v] = 1;
      captureTick[v] = t;
    } else {
      army[v] += push;
    }
    if (t - state.turn <= 2 && firstOpsOut) {
      firstOpsOut.push([s, v]);
    }
    lastPlanned = t;
  }

  // 评分：爆发期产兵总量 + 地皮基线 + 余兵（同分时兵多者优 = 更敢憋）。
  let score = 0;
  let plains = 0;
  let totalArmy = 0;
  for (let idx = 0; idx < total; idx += 1) {
    if (!owned[idx]) {
      continue;
    }
    totalArmy += army[idx];
    if (isSwamp[idx]) {
      continue; // 沼泽永不产兵，不计分（占它只为打通走廊，已由 onwardBonus 鼓励）
    }
    plains += 1;
    const c = Math.max(BURST_START_TURN, captureTick[idx]);
    if (c <= BURST_END_TURN) {
      score += HORIZON_TURN - c; // 该格在爆发期产出的总兵
    }
  }
  score += plains * 3 + totalArmy * 0.02;
  void lastPlanned;
  return score;
}

/**
 * 开局规划主入口。
 * @returns {{active: boolean, candidates: Array, waitTurns: number}}
 *   active=false 表示开局结束/不适用，交还常规管线。
 */
function planOpening(ctx, state, activeThreats) {
  const inactive = { active: false, candidates: [], waitTurns: 0 };
  if (state.turn > OPENING_END_TURN || state.playerId <= 0) {
    return inactive;
  }
  if (ctx.myCrowns().length === 0) {
    return inactive;
  }
  if (activeThreats && activeThreats.length > 0) {
    return inactive;
  }
  // 活敌逼近我方领土即退出开局（交还防御/切断逻辑）。
  const myTerritoryDist = ctx.myTerritoryDist();
  for (let idx = 0; idx < state.n * state.m; idx += 1) {
    if (ctx.isAliveEnemyIdx(idx) && myTerritoryDist[idx] >= 0 && myTerritoryDist[idx] <= ENEMY_ABORT_DIST) {
      return inactive;
    }
  }

  // 逐 w 模拟：w = 下一拍就开工 .. 憋到 MAX_WAIT_TURN。
  // 注意时机语义：本 tick 下发的 op 在服务端下一 tick 才执行，对应模拟里
  // t = state.turn + 1 的操作；w > turn+1 表示「本 tick 按兵不动」。
  const from = state.turn + 1;
  const to = Math.min(MAX_WAIT_TURN, from + MAX_ROLLOUTS - 1);
  let bestW = -1;
  let bestScore = -Infinity;
  let bestOps = [];
  for (let w = from; w <= to; w += 1) {
    const ops = [];
    const score = rollout(ctx, w, ops);
    if (score > bestScore) {
      bestScore = score;
      bestW = w;
      bestOps = ops;
    }
  }
  if (bestW > from || bestOps.length === 0) {
    // 最优解是继续憋（或附近已无中立地可占但开局窗口未过——保持等待，
    // 不交还常规管线，避免无焦点输送把兵栈打散）。
    return { active: true, candidates: [], waitTurns: Math.max(0, bestW - from) };
  }
  const candidates = bestOps.slice(0, 2).map(([s, v], i) => ({
    score: OPENING_OP_SCORE - i * 5,
    preempt: false,
    op: attackOp(ctx, s, v, 2),
    srcKey: s,
    tag: 'opening',
  }));
  return { active: true, candidates, waitTurns: 0 };
}

module.exports = { planOpening, OPENING_END_TURN };
