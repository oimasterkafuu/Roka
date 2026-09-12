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
   * 敌方逼近度跟踪（menace）：state.enemyMenace — owner → { minDist, lastApproach }。
   * minDist = 该 owner 的活敌格离我锚点（主城/指挥所）的历史最近 BFS 距离；
   * 距离缩小 = 正在逼近 → 刷新 lastApproach。只有「正在/刚逼近过」的敌人
   * 才计入驻军危险场：龟缩不动的兵堆（minDist 长期不变）不冻结我方走廊
   * 兵力——这正是「对方不动我也不动」死局的破解关键。
   * 惰性计算且每 tick 只算一次（memo），顺势把观测写回 state。
   */
  ctx.menacingOwners = () =>
    memo('menacingOwners', () => {
      const MENACE_GRACE = 8; // 最后一次逼近后保持威胁登记的 tick 数
      if (!state.enemyMenace) {
        state.enemyMenace = new Map();
      }
      const menace = state.enemyMenace;
      const anchorDist = ctx.anchorDistAll();
      const curMin = new Map(); // owner → 本 tick 最近距离
      for (let idx = 0; idx < total; idx += 1) {
        if (!ctx.isAliveEnemyIdx(idx)) {
          continue;
        }
        const d = anchorDist[idx];
        if (d < 0) {
          continue;
        }
        const owner = ctx.ownerAt(idx);
        curMin.set(owner, Math.min(curMin.get(owner) ?? Infinity, d));
      }
      const active = new Set();
      for (const [owner, d] of curMin) {
        const rec = menace.get(owner) || { minDist: Infinity, lastApproach: -1000 };
        if (d < rec.minDist) {
          rec.minDist = d;
          rec.lastApproach = state.turn;
        }
        menace.set(owner, rec);
        if (state.turn - rec.lastApproach <= MENACE_GRACE) {
          active.add(owner);
        }
      }
      return active;
    });

  /**
   * 危险场：max-plus 传播（Dijkstra 变体），每格的值 = 敌人把兵推到该格时
   * 大致还剩多少兵力（army-1 逐格衰减）。两层叠加取逐格最大：
   *   1) 扑击层：所有活敌格为源，限 3 步——贴身敌格不论动不动，一两拍内
   *      都能扑到邻格（「静态」≠无害，龟缩对手的小股贴边兵照样偷城）；
   *   2) 压境层：仅 menacing（正在逼近）的敌格为源，限 14 步——远程推进的
   *      主力在抵达前就应抬高沿线驻军。
   *   远处龟缩不动的兵堆两层都够不着，不冻结我方走廊兵力——这正是
   *  「对方不动我也不动」死局的破解关键。
   */
  ctx.dangerField = () =>
    memo('dangerField', () => {
      const POUNCE_HOPS = 3;
      const MENACE_HOPS = 14;
      const menacing = ctx.menacingOwners();
      const field = new Array(total).fill(0);
      const hops = new Array(total).fill(-1);
      // 每个节点记录其传播源头是否为 menacing——射程上限由源头决定，
      // 不能看中继格的归属（传播进己方领土后 owner 已是自己）。
      const srcMenacing = new Array(total).fill(false);
      // 大顶堆：用负值复用小顶堆。
      const heap = createHeap();
      for (let idx = 0; idx < total; idx += 1) {
        if (!ctx.isAliveEnemyIdx(idx)) {
          continue;
        }
        const v = ctx.army(idx) - 1;
        if (v > field[idx]) {
          field[idx] = v;
          hops[idx] = 0;
          srcMenacing[idx] = menacing.has(ctx.ownerAt(idx));
          heap.push(-v, idx);
        }
      }
      while (heap.size > 0) {
        const [neg, u] = heap.pop();
        const val = -neg;
        if (val < field[u]) {
          continue;
        }
        const reach = srcMenacing[u] ? MENACE_HOPS : POUNCE_HOPS;
        if (val <= 2 || hops[u] >= reach) {
          continue;
        }
        for (const v of ctx.neighbors(u)) {
          if (!ctx.passable(v)) {
            continue;
          }
          const nv = val - 1;
          if (nv > field[v]) {
            field[v] = nv;
            hops[v] = hops[u] + 1;
            srcMenacing[v] = srcMenacing[u];
            heap.push(-nv, v);
          }
        }
      }
      return field;
    });

  /**
   * 驻军保留线：keepAt（邻接敌军推兵量）+ 咽喉格守军。
   * 咽喉格一旦被小股敌军切断，其后方整片无锚领土会断链减半并孤军化。
   * 守军规模按「危险场」定量：贴身敌格（扑击层）与正在逼近的敌人
   * （压境层）抬高守军——留守 = 敌人推到该格时的剩余兵力 + 2（封顶 50）；
   * 远处龟缩不动的兵堆不冻结我方走廊的机动兵力。
   * 进攻/输送以此线为余量上限，保证「进攻不倾巢而出、要道不被偷家」。
   */
  ctx.garrisonAt = (idx) => {
    let keep = ctx.keepAt(idx);
    const choke = ctx.myChokes().get(idx);
    if (choke) {
      const danger = ctx.dangerField()[idx];
      let extra;
      if (danger <= 1) {
        extra = 3; // 无逼近之敌：象征性守军（防单兵摸哨）
      } else {
        extra = Math.min(50, danger + 2);
        if (choke.cells >= 8) {
          // 分离规模很大时给一个下限，防止危险场低估了慢速推进。
          extra = Math.max(extra, Math.min(12, 3 + Math.ceil(choke.cells / 3)));
        }
      }
      keep = Math.max(keep, extra);
    }
    return keep;
  };

  /** 机动兵力估算：全军 − 各格驻军保留之和（含边境与咽喉守军）。 */
  ctx.mobileArmy = () =>
    memo('mobileArmy', () => {
      const stats = ctx.stats();
      let reserved = 0;
      for (const idx of ctx.myCells()) {
        reserved += Math.min(ctx.army(idx), ctx.garrisonAt(idx));
      }
      return Math.max(0, stats.myArmy - reserved);
    });

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

  /** 与锚点连通的己方格（引擎 isolated=0）。 */
  ctx.isConnectedMine = (idx) => ctx.isMineIdx(idx) && !ctx.isolatedAt(idx);

  /**
   * 己方孤军连通块（isolated>0 的己方格按四方向聚块）。
   * 返回 [{cells, army, anchors}]：army 为块内总兵力，anchors 为块内指挥所数
   * （孤军块不含主城——主城永远不会孤军化；含指挥所的块重连价值更高）。
   */
  ctx.myIsolatedRegions = () =>
    memo('myIsolatedRegions', () => {
      const regions = [];
      const seen = new Set();
      for (let idx = 0; idx < total; idx += 1) {
        if (!ctx.isMineIdx(idx) || !ctx.isolatedAt(idx) || seen.has(idx)) {
          continue;
        }
        const cells = [];
        let army = 0;
        let anchors = 0;
        const queue = [idx];
        seen.add(idx);
        while (queue.length > 0) {
          const u = queue.pop();
          cells.push(u);
          army += ctx.army(u);
          if (ctx.tileKind(u) === 'city') {
            anchors += 1;
          }
          for (const v of ctx.neighbors(u)) {
            if (!seen.has(v) && ctx.isMineIdx(v) && ctx.isolatedAt(v)) {
              seen.add(v);
              queue.push(v);
            }
          }
        }
        regions.push({ cells, army, anchors });
      }
      return regions;
    });

  /**
   * 咽喉格（割点）分析：在给定的连通领土图上求割点——若该格被切断，
   * 哪些不含锚点的子区域会整片失去连通（断链减半+孤军化）。
   * 返回 Map<idx, {cells, army}>：cells/army 为会被分离的规模最大一块的价值。
   * 实现：虚拟超级根连接全部锚点，迭代 Tarjan 求 lowlink；锚点自身不作割点。
   * 我方与敌方领土共用此分析（我方 → 驻军保留；敌方 → 切断打击目标）。
   */
  function computeChokes(connectedCells, anchorIdxList) {
    const result = new Map();
    if (anchorIdxList.length === 0) {
      return result;
    }
    const anchorSet = new Set(anchorIdxList);
    const cellSet = new Set(connectedCells);

    const disc = new Map();
    const low = new Map();
    const subCells = new Map();
    const subArmy = new Map();
    const subHasAnchor = new Map();
    let timer = 0;

    // 迭代 DFS（显式栈），对每个连通分量分别跑。锚点优先作根：割点判定
    // 的低链规则对「根」不适用，让根落在锚点（锚点本就不作割点标记）
    // 可以规避根节点误判。
    const starts = [...anchorIdxList, ...connectedCells.filter((idx) => !anchorSet.has(idx))];
    for (const start of starts) {
      if (disc.has(start)) {
        continue;
      }
      // stack 项：[idx, parentIdx, 邻居迭代游标]
      const stack = [[start, -1, 0]];
      disc.set(start, timer);
      low.set(start, timer);
      subCells.set(start, 1);
      subArmy.set(start, ctx.army(start));
      subHasAnchor.set(start, anchorSet.has(start));
      timer += 1;
      // childrenOf: u → DFS 树上的儿子列表（割点判定用）
      const childrenOf = new Map();
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        const u = top[0];
        const nbrs = [...ctx.neighbors(u)].filter((v) => cellSet.has(v));
        let advanced = false;
        while (top[2] < nbrs.length) {
          const v = nbrs[top[2]];
          top[2] += 1;
          if (!disc.has(v)) {
            disc.set(v, timer);
            low.set(v, timer);
            subCells.set(v, 1);
            subArmy.set(v, ctx.army(v));
            subHasAnchor.set(v, anchorSet.has(v));
            timer += 1;
            if (!childrenOf.has(u)) {
              childrenOf.set(u, []);
            }
            childrenOf.get(u).push(v);
            stack.push([v, u, 0]);
            advanced = true;
            break;
          } else if (v !== top[1]) {
            low.set(u, Math.min(low.get(u), disc.get(v)));
          }
        }
        if (advanced) {
          continue;
        }
        // u 的子树处理完，回溯更新父亲
        stack.pop();
        const parent = top[1];
        if (parent !== -1) {
          low.set(parent, Math.min(low.get(parent), low.get(u)));
          subCells.set(parent, subCells.get(parent) + subCells.get(u));
          subArmy.set(parent, subArmy.get(parent) + subArmy.get(u));
          subHasAnchor.set(parent, subHasAnchor.get(parent) || subHasAnchor.get(u));
        }
      }

      // 割点判定：非锚点格 u 的某个 DFS 儿子 v 满足 low[v] >= disc[u]
      // 且 v 的子树不含锚点 → 切断 u 会让 v 的子树整片失联。
      for (const [u, children] of childrenOf) {
        if (anchorSet.has(u)) {
          continue;
        }
        let separatedCells = 0;
        let separatedArmy = 0;
        for (const v of children) {
          if (low.get(v) >= disc.get(u) && !subHasAnchor.get(v)) {
            separatedCells += subCells.get(v);
            separatedArmy += subArmy.get(v);
          }
        }
        if (separatedCells >= 3) {
          const prev = result.get(u);
          if (!prev || separatedCells > prev.cells) {
            result.set(u, { cells: separatedCells, army: separatedArmy });
          }
        }
      }
    }
    return result;
  }

  ctx.myChokes = () =>
    memo('myChokes', () => {
      const anchors = ctx.myAnchors().map((a) => a.idx);
      const connected = ctx.myCells().filter((idx) => ctx.isConnectedMine(idx));
      return computeChokes(connected, anchors);
    });

  /**
   * 敌方咽喉格：owner → Map<idx, {cells, army}>。切断该格会让其身后
   * 不含锚点的整片区域孤军化（兵力立即减半、随后衰减）——进攻切断
   * 的目标池。只算活敌；每个 owner 的领土分开分析。
   */
  ctx.enemyChokes = () =>
    memo('enemyChokes', () => {
      const byOwner = new Map();
      const cellsByOwner = new Map();
      const anchorsByOwner = new Map();
      for (let idx = 0; idx < total; idx += 1) {
        if (!ctx.isAliveEnemyIdx(idx)) {
          continue;
        }
        const owner = ctx.ownerAt(idx);
        if (!cellsByOwner.has(owner)) {
          cellsByOwner.set(owner, []);
          anchorsByOwner.set(owner, []);
        }
        cellsByOwner.get(owner).push(idx);
        const kind = ctx.tileKind(idx);
        if (kind === 'crown' || kind === 'city') {
          anchorsByOwner.get(owner).push(idx);
        }
      }
      for (const [owner, cells] of cellsByOwner) {
        byOwner.set(owner, computeChokes(cells, anchorsByOwner.get(owner)));
      }
      return byOwner;
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

  /** 己方领土距离场（可通行格全过）：任意格离我领土边界有多远（开局敌情判定用）。 */
  ctx.myTerritoryDist = () =>
    memo('myTerritoryDist', () => ctx.bfsField(ctx.myCells(), (idx) => ctx.passable(idx)));

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
   * 每个贡献格按「兵力 - 驻军保留（边境 + 咽喉守军）」计余量——进攻/救援
   * 集结不得抽空要害；防御集结（relaxed=true）生死关头只扣边境保留，
   * 咽喉守军也算可动员。
   * 供养者按「每 op 产出」（余量/距离）降序取用：大兵栈即使远几格也比
   * 门口的小散兵值得先调——总 op 预算是硬约束，效率排序让它花在刀刃上。
   * 返回 { amount, ticks }（ticks 为估算的集结 op 数 = 各来源距离之和）。
   */
  ctx.gatherable = (centerIdx, opBudget, excludeIdx, relaxed = false) => {
    // 孤军格不能移动（chkMove 要求 !isolated），既不能作贡献者也不能当
    // 输送通道——把兵推进孤军格等于冻结在里面。
    const field = ctx.bfsField([centerIdx], (idx) => ctx.isMineIdx(idx) && !ctx.isolatedAt(idx));
    const feeders = [];
    for (let idx = 0; idx < total; idx += 1) {
      if (idx === centerIdx || idx === excludeIdx || !ctx.isMineIdx(idx) || ctx.isolatedAt(idx)) {
        continue;
      }
      const d = field[idx];
      if (d < 1 || d > opBudget) {
        continue;
      }
      const keep = relaxed ? ctx.keepAt(idx) : ctx.garrisonAt(idx);
      const surplus = ctx.army(idx) - keep;
      if (surplus > 0) {
        feeders.push({ d, surplus });
      }
    }
    feeders.sort((a, b) => b.surplus / b.d - a.surplus / a.d);
    let amount = 0;
    let ticks = 0;
    for (const feeder of feeders) {
      if (ticks + feeder.d > opBudget) {
        continue; // 预算装不下这个来源的整个输送链，看下一个更高效的
      }
      amount += feeder.surplus;
      ticks += feeder.d;
    }
    return { amount, ticks };
  };

  return ctx;
}

module.exports = { DIRECTIONS, ownerOf, tileKindOf, buildContext };
