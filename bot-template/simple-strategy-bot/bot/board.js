/**
 * board.js — 棋盘状态视图与空间分析（纯函数层）。
 *
 * 所有决策模块共享的基础设施：格子编码查询、距离场（BFS）、带权最短路
 * （Dijkstra）、以及与引擎 computePush 完全一致的推兵量预演。本层不做任何
 * 决策、不接触 socket；派生数据按 tick 缓存（每个 tick 由 strategy.js
 * 重新 buildContext，缓存随 ctx 一起失效）。
 *
 * grid_type 编码（全图视野，权威文档见 static/develop-bot.html）：
 *   200 中立空地 / 201 山 / 204 中立沼泽；
 *   0..49   普通格（owner = code，0 表示带兵中立格）；
 *   50..99  指挥所（owner = code - 50）；
 *   100..149 主城（owner = code - 100）；
 *   150..199 沼泽（owner = code - 150）。
 */

const DIRECTIONS = [
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
];

function ownerOf(code) {
  if (typeof code !== 'number' || code >= 200) {
    return 0;
  }
  return code % 50;
}

/** 格子地形类别：mountain / swamp / city / crown / plain。 */
function tileKindOf(code) {
  if (code === 201) {
    return 'mountain';
  }
  if (code === 204 || (code >= 150 && code < 200)) {
    return 'swamp';
  }
  if (code >= 100 && code < 150) {
    return 'crown';
  }
  if (code >= 50 && code < 100) {
    return 'city';
  }
  return 'plain';
}

/** 简易二叉堆（[cost, idx] 按 cost 弹出最小值）。 */
function createHeap() {
  const items = [];
  const push = (cost, idx) => {
    items.push([cost, idx]);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (items[p][0] <= items[i][0]) {
        break;
      }
      [items[p], items[i]] = [items[i], items[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < items.length && items[l][0] < items[smallest][0]) {
          smallest = l;
        }
        if (r < items.length && items[r][0] < items[smallest][0]) {
          smallest = r;
        }
        if (smallest === i) {
          break;
        }
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  };
  return {
    push,
    pop,
    get size() {
      return items.length;
    },
  };
}

/**
 * 以 state（strategy.js 持有的对局状态）为底构建本 tick 的分析上下文。
 * state 需要：n, m, gridType, armyCnt, isolated, playerId, turn,
 * teams（playerId → 队伍号）, allowTeam, deadPlayers（Set<playerId>）。
 */
function buildContext(state) {
  const total = state.n * state.m;
  const cache = new Map();

  const ctx = {
    state,
    directions: DIRECTIONS,
  };

  /* ---------- 基础查询 ---------- */

  ctx.idx = (x, y) => x * state.m + y;
  ctx.xy = (idx) => ({ x: Math.floor(idx / state.m), y: idx % state.m });
  ctx.inBounds = (x, y) => x >= 0 && y >= 0 && x < state.n && y < state.m;
  ctx.codeAt = (idx) => state.gridType[idx];
  ctx.army = (idx) => state.armyCnt[idx] || 0;
  ctx.ownerAt = (idx) => ownerOf(state.gridType[idx]);
  ctx.tileKind = (idx) => tileKindOf(state.gridType[idx]);
  ctx.passable = (idx) => state.gridType[idx] !== 201;
  ctx.isolatedAt = (idx) => (state.isolated[idx] || 0) > 0;
  ctx.isMineIdx = (idx) => ctx.ownerAt(idx) === state.playerId && state.playerId > 0;
  ctx.isTeammateOwner = (owner) => {
    if (owner <= 0 || owner === state.playerId || !state.allowTeam) {
      return false;
    }
    const mine = state.teams.get(state.playerId);
    const theirs = state.teams.get(owner);
    return typeof mine === 'number' && mine > 0 && mine === theirs;
  };
  ctx.isEnemyIdx = (idx) => {
    const owner = ctx.ownerAt(idx);
    return owner > 0 && owner !== state.playerId && !ctx.isTeammateOwner(owner);
  };
  // 活敌：未出局（不在 kills 里）且该格不处于孤军状态。
  ctx.isAliveEnemyIdx = (idx) =>
    ctx.isEnemyIdx(idx) && !state.deadPlayers.has(ctx.ownerAt(idx)) && !ctx.isolatedAt(idx);
  ctx.ownerDead = (owner) => state.deadPlayers.has(owner);
  ctx.neighbors = function* (idx) {
    const { x, y } = ctx.xy(idx);
    for (const dir of DIRECTIONS) {
      const nx = x + dir.x;
      const ny = y + dir.y;
      if (ctx.inBounds(nx, ny)) {
        yield ctx.idx(nx, ny);
      }
    }
  };

  // 可操作格：己方、非孤军、兵力 > 1（与服务端 chkMove 一致）。
  ctx.operable = (idx) => ctx.isMineIdx(idx) && ctx.army(idx) > 1 && !ctx.isolatedAt(idx);

  /**
   * 边境保留兵力：邻接的最大活敌推兵量（mode 2 = 兵力-1）。守住需要
   * 兵力 >= 敌军推兵量（相等即击退，引擎语义：cnt <= 守军则进攻失败）。
   * 无邻敌时为 1（保底留 1 兵）。
   */
  ctx.keepAt = (idx) => {
    let keep = 1;
    for (const nIdx of ctx.neighbors(idx)) {
      if (ctx.isAliveEnemyIdx(nIdx)) {
        keep = Math.max(keep, ctx.army(nIdx) - 1);
      }
    }
    return keep;
  };

  // 同队判定（与引擎 computePush 的防御求和口径一致）。
  function sameTeamEngine(a, b) {
    if (a <= 0 || b <= 0) {
      return a === b;
    }
    if (!state.allowTeam) {
      return a === b;
    }
    const ta = state.teams.get(a);
    const tb = state.teams.get(b);
    return typeof ta === 'number' && ta > 0 && ta === tb;
  }

  /**
   * 推兵量预演：与服务端 game-engine.computePush 完全一致。
   * mode 0 智能分兵（为其他方向的非队友格保留 Σ(兵力-1)+1，含中立空格
   * 每格 -1 的引擎怪癖）、mode 1 半兵、mode 2 全冲（兵力-1）。
   */
  ctx.previewPush = (fromIdx, toIdx, mode) => {
    const totalArmy = ctx.army(fromIdx);
    const cap = Math.max(0, totalArmy - 1);
    if (mode === 2) {
      return cap;
    }
    const { x, y } = ctx.xy(fromIdx);
    const target = ctx.xy(toIdx);
    let defense = 0;
    for (const dir of DIRECTIONS) {
      const nx = x + dir.x;
      const ny = y + dir.y;
      if (nx === target.x && ny === target.y) {
        continue;
      }
      if (!ctx.inBounds(nx, ny)) {
        continue;
      }
      const nIdx = ctx.idx(nx, ny);
      if (!ctx.passable(nIdx)) {
        continue;
      }
      const nOwner = ctx.ownerAt(nIdx);
      const fromOwner = ctx.ownerAt(fromIdx);
      if (nOwner > 0 && sameTeamEngine(nOwner, fromOwner)) {
        continue;
      }
      defense += ctx.army(nIdx) - 1;
    }
    const theoretical = Math.max(0, totalArmy - defense - 1);
    return Math.min(mode === 1 ? Math.floor(theoretical / 2) : theoretical, cap);
  };

  /* ---------- 按 tick 缓存的派生数据 ---------- */

  function memo(key, compute) {
    if (!cache.has(key)) {
      cache.set(key, compute());
    }
    return cache.get(key);
  }

  /** 多源 BFS 距离场。passThrough(idx) 决定是否可进入；源格距离为 0。 */
  ctx.bfsField = (sources, passThrough) => {
    const dist = new Array(total).fill(-1);
    const queue = [];
    for (const s of sources) {
      if (dist[s] === -1) {
        dist[s] = 0;
        queue.push(s);
      }
    }
    let head = 0;
    while (head < queue.length) {
      const u = queue[head];
      head += 1;
      for (const v of ctx.neighbors(u)) {
        if (dist[v] !== -1 || !passThrough(v)) {
          continue;
        }
        dist[v] = dist[u] + 1;
        queue.push(v);
      }
    }
    return dist;
  };

  /**
   * 多源 Dijkstra：sources 内格子代价 0 起步，进入其他格子的代价由
   * enterCost(idx) 给出（Infinity 表示不可进入）。isTarget(idx) 命中即停。
   * 返回 { cost, path, entry }（path 从 entry 到目标，含两端），不可达为 null。
   */
  ctx.dijkstra = (sources, enterCost, isTarget) => {
    const dist = new Array(total).fill(Infinity);
    const parent = new Array(total).fill(-1);
    const heap = createHeap();
    for (const s of sources) {
      if (dist[s] !== 0) {
        dist[s] = 0;
        heap.push(0, s);
      }
    }
    while (heap.size > 0) {
      const [d, u] = heap.pop();
      if (d > dist[u]) {
        continue;
      }
      if (isTarget(u)) {
        const path = [];
        let cur = u;
        while (cur !== -1) {
          path.push(cur);
          cur = parent[cur];
        }
        path.reverse();
        return { cost: d, path, entry: path[0] };
      }
      for (const v of ctx.neighbors(u)) {
        const w = enterCost(v);
        if (!Number.isFinite(w)) {
          continue;
        }
        const nd = d + w;
        if (nd < dist[v]) {
          dist[v] = nd;
          parent[v] = u;
          heap.push(nd, v);
        }
      }
    }
    return null;
  };

  /** 全部己方格。 */
  ctx.myCells = () =>
    memo('myCells', () => {
      const list = [];
      for (let idx = 0; idx < total; idx += 1) {
        if (ctx.isMineIdx(idx)) {
          list.push(idx);
        }
      }
      return list;
    });

  /** 全部可操作己方格（兵力>1、非孤军）。 */
  ctx.myOperable = () => memo('myOperable', () => ctx.myCells().filter((idx) => ctx.operable(idx)));

  /** 己方锚点列表 [{idx, isCrown}]（主城 + 指挥所），主城在前。 */
  ctx.myAnchors = () =>
    memo('myAnchors', () => {
      const crowns = [];
      const cities = [];
      for (const idx of ctx.myCells()) {
        const kind = ctx.tileKind(idx);
        if (kind === 'crown') {
          crowns.push({ idx, isCrown: true });
        } else if (kind === 'city') {
          cities.push({ idx, isCrown: false });
        }
      }
      return [...crowns, ...cities];
    });

  ctx.myCrowns = () =>
    memo('myCrowns', () => ctx.myAnchors().filter((a) => a.isCrown).map((a) => a.idx));
  ctx.myCities = () =>
    memo('myCities', () => ctx.myAnchors().filter((a) => !a.isCrown).map((a) => a.idx));

  /** 前线距离场：所有可通行的非己方格为源（含中立与敌格）。 */
  ctx.frontierDist = () =>
    memo('frontierDist', () => {
      const sources = [];
      for (let idx = 0; idx < total; idx += 1) {
        if (ctx.passable(idx) && !ctx.isMineIdx(idx)) {
          sources.push(idx);
        }
      }
      return ctx.bfsField(sources, (idx) => ctx.passable(idx));
    });

  /** 锚点距离场（仅经己方格）：衡量己方领土的锚点覆盖。 */
  ctx.anchorDistMine = () =>
    memo('anchorDistMine', () => ctx.bfsField(ctx.myAnchors().map((a) => a.idx), (idx) => ctx.isMineIdx(idx)));

  /** 锚点距离场（可通行格全过）：衡量任意格离我锚点有多远（威胁 proximity 用）。 */
  ctx.anchorDistAll = () =>
    memo('anchorDistAll', () => ctx.bfsField(ctx.myAnchors().map((a) => a.idx), (idx) => ctx.passable(idx)));

  /** 活敌距离场：所有活敌格为源（经济选址的死区判定用）。 */
  ctx.enemyDistAll = () =>
    memo('enemyDistAll', () => {
      const sources = [];
      for (let idx = 0; idx < total; idx += 1) {
        if (ctx.isAliveEnemyIdx(idx)) {
          sources.push(idx);
        }
      }
      return ctx.bfsField(sources, (idx) => ctx.passable(idx));
    });

  /** 敌军压力场：每格邻接（四方向）的活敌兵力总和，进攻路径风险项。 */
  ctx.enemyPressure = () =>
    memo('enemyPressure', () => {
      const pressure = new Array(total).fill(0);
      for (let idx = 0; idx < total; idx += 1) {
        if (!ctx.isAliveEnemyIdx(idx)) {
          continue;
        }
        const army = ctx.army(idx);
        for (const nIdx of ctx.neighbors(idx)) {
          pressure[nIdx] += army;
        }
      }
      return pressure;
    });

  /** 全军统计：myLand/myArmy 与每 owner 的 land/army/crowns/cities。 */
  ctx.stats = () =>
    memo('stats', () => {
      const perOwner = new Map();
      let myLand = 0;
      let myArmy = 0;
      for (let idx = 0; idx < total; idx += 1) {
        const owner = ctx.ownerAt(idx);
        if (owner <= 0) {
          continue;
        }
        const army = ctx.army(idx);
        let entry = perOwner.get(owner);
        if (!entry) {
          entry = { land: 0, army: 0, crowns: 0, cities: 0 };
          perOwner.set(owner, entry);
        }
        entry.land += 1;
        entry.army += army;
        const kind = ctx.tileKind(idx);
        if (kind === 'crown') {
          entry.crowns += 1;
        } else if (kind === 'city') {
          entry.cities += 1;
        }
        if (owner === state.playerId) {
          myLand += 1;
          myArmy += army;
        }
      }
      return { myLand, myArmy, perOwner };
    });

  ctx.crownsOf = (owner) => ctx.stats().perOwner.get(owner)?.crowns ?? 0;
  ctx.armyOf = (owner) => ctx.stats().perOwner.get(owner)?.army ?? 0;

  /**
   * 集结潜力估算：center 周围（仅经己方格、BFS 距离 ≤ opBudget 步内、
   * 累计 op 开销不超 opBudget）可向 center 输送的兵力上限。
   * 每个贡献格按「兵力 - 边境保留」计余量，按距离贪心取近者优先。
   * 返回 { amount, ticks }（ticks 为估算的集结 op 数 = 各来源距离之和）。
   */
  ctx.gatherable = (centerIdx, opBudget, excludeIdx) => {
    const field = ctx.bfsField([centerIdx], (idx) => ctx.isMineIdx(idx));
    const feeders = [];
    for (let idx = 0; idx < total; idx += 1) {
      if (idx === centerIdx || idx === excludeIdx || !ctx.isMineIdx(idx)) {
        continue;
      }
      const d = field[idx];
      if (d < 1) {
        continue;
      }
      const surplus = ctx.army(idx) - ctx.keepAt(idx);
      if (surplus > 0) {
        feeders.push({ d, surplus });
      }
    }
    feeders.sort((a, b) => a.d - b.d);
    let amount = 0;
    let ticks = 0;
    for (const feeder of feeders) {
      if (ticks + feeder.d > opBudget) {
        break;
      }
      amount += feeder.surplus;
      ticks += feeder.d;
    }
    return { amount, ticks };
  };

  return ctx;
}

module.exports = { DIRECTIONS, ownerOf, tileKindOf, buildContext };
