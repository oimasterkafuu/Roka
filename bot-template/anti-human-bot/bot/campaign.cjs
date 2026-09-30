'use strict';

// 无跨回合计划：每次调用都按当前棋盘重算目标、集结点与攻城树。
const { resolveParams } = require('./params.cjs');
const { createContext } = require('./threat.cjs');
const { ownStrandedMass } = require('./cutoff.cjs');

function chooseCampaign(state, params = {}, options = {}) {
  if (!state || typeof state !== 'object') return null;
  const reset = () => null;
  const { n, m, grid, army, playerId: me } = state;
  const size = n * m, turn = state.turn ?? 0;
  if (state.dead || state.ended || options.threatened || !Number.isInteger(n) || !Number.isInteger(m) ||
      n < 1 || m < 1 || size > 100000 || !Number.isInteger(me) || me < 1 || me > 49 ||
      grid?.length !== size || army?.length !== size || !Number.isFinite(turn) || turn < 50) return reset();
  const team = p => state.teams instanceof Map ? state.teams.get(p) : state.teams?.[p];
  const allied = (a, b) => a > 0 && b > 0 && (a === b || (team(a) > 0 && team(a) === team(b)));
  const os = new Int16Array(size);
  const known = i => !state.fog?.[i] && grid[i] !== 202 && grid[i] !== 203;
  const own = i => known(i) && os[i] === me && !state.isolated?.[i];
  const ns = i => {
    const out = [];
    if (i >= m) out.push(i - m);
    if (i % m) out.push(i - 1);
    if (i % m + 1 < m) out.push(i + 1);
    if (i + m < size) out.push(i + m);
    return out;
  };
  const blocked = (a, b) => params.blockedEdges?.has(`${a}:${b}`) || state.blockedEdges?.has(`${a}:${b}`);
  const p = resolveParams(params);
  const growth = (i, ticks) => {
    if (!os[i] || !known(i)) return 0;
    if (grid[i] === os[i] + 100) return ticks;
    if (state.isolated?.[i] || grid[i] >= 150) return 0;
    return Math.floor((turn + ticks) / 50) - Math.floor(turn / 50);
  };
  const count = (i, t = 1) => army[i] + growth(i, t);
  let targetOwner = options.targetOwner;
  const factions = [];
  for (let i = 0; i < size; i++) {
    if (!Number.isInteger(grid[i]) || !Number.isFinite(army[i]) || army[i] < 0) return reset();
    os[i] = grid[i] > 0 && grid[i] < 200 ? grid[i] % 50 : 0;
    if (known(i) && os[i] && !allied(me, os[i]) && !factions.some(p => allied(p, os[i]))) factions.push(os[i]);
  }
  // 双方局 FFA 的 targetOwner 为 null；多阵营局必须由上层指定，绝不自行换第三方。
  if (targetOwner == null && factions.length === 1) targetOwner = factions[0];
  if (!Number.isInteger(targetOwner) || targetOwner < 1 || targetOwner > 49 || allied(me, targetOwner)) return reset();
  const targetSide = i => os[i] > 0 && allied(os[i], targetOwner);
  const pass = i => known(i) && grid[i] !== 201 && !state.isolated?.[i] &&
    (own(i) || !os[i] || targetSide(i));
  let power = 0, enemyPower = 0;
  const crowns = [];
  for (let i = 0; i < size; i++) {
    if (own(i)) power += Math.max(0, count(i) - 1);
    if (known(i) && targetSide(i)) {
      enemyPower += count(i);
      if (grid[i] === os[i] + 100 && pass(i)) crowns.push(i);
    }
  }
  if (!crowns.length || power <= (Number.isFinite(options.ratio) ? options.ratio : 1.4) * enemyPower) return reset();
  const mem = { target: null, rally: null };
  // 反向 BFS 同时寻找皇冠路径和最接近的己方前线，每格只访问一次。
  const toward = new Int32Array(size).fill(-1), root = new Int32Array(size).fill(-1);
  const q = crowns.slice();
  const approachDistance = new Int32Array(size);
  for (const i of q) { toward[i] = i; root[i] = i; }
  let nearest = -1;
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    if (own(i)) { if (nearest < 0) nearest = i; continue; }
    for (const j of ns(i)) if (toward[j] < 0 && pass(j) && !blocked(j, i)) {
      toward[j] = i; root[j] = root[i]; approachDistance[j]=approachDistance[i]+1; q.push(j);
    }
  }
  // 兵源、树和前线终点每 tick 重算。
  // 选择当下的前线出发点，兼顾接敌距离与现有大军，给旧点微小迟滞而非锁死。
  let bestRally=-1,bestRallyScore=-Infinity;
  const fronts = options.boundaryAdvance ? new Set(Array.from({length:size}, (_,i)=>i)
    .filter(i=>own(i)&&toward[i]>=0&&ns(i).some(j=>targetSide(j)))) : null;
  for(let i=0;i<size;i++)if(own(i)&&toward[i]>=0&&root[i]===root[i]){
    if (fronts?.size && !fronts.has(i)) continue;
    const d=approachDistance[i];
    const score=Math.log2(1+count(i))*2-(options.boundaryAdvance ? Math.min(d, 3) : d)+(i===mem.rally?1:0);
    if(score>bestRallyScore){bestRallyScore=score;bestRally=i;}
  }
  mem.rally=bestRally<0?null:bestRally;
  if(mem.rally!==null)mem.target=root[mem.rally];
  if (mem.rally === null) {
    if (nearest < 0) return reset();
    mem.rally = nearest; mem.target = root[nearest];
  }
  const rally = mem.rally;
  if (!own(rally) || toward[rally] < 0 || root[rally] !== mem.target) return reset();
  const path = [];
  for (let i = toward[rally]; ; i = toward[i]) {
    path.push(i);
    // 稳推只筹集下一格所需兵力，不为整条穿心攻城路线无限集兵。
    if (i === mem.target || (options.boundaryAdvance && !own(i))) break;
  }
  // 单个连通分量的 parent 树，距离严格递减，因此没有环。
  const parent = new Int32Array(size).fill(-1), depth = new Int32Array(size), tree = [rally];
  parent[rally] = rally;
  for (let h = 0; h < tree.length; h++) {
    const i = tree[h];
    for (const j of ns(i)) if (parent[j] < 0 && own(j) && !blocked(j, i)) {
      parent[j] = i; depth[j] = depth[i] + 1; tree.push(j);
    }
  }
  // mode 0 是智能留兵，不是可任意指定数量的移动。
  function pushed(from, to, amount = count(from)) {
    if (ns(from).some(j => !known(j))) return 0;
    let reserve = 0, danger = 0;
    for (const j of ns(from)) {
      if (os[j] && !allied(me, os[j]) && !state.isolated?.[j]) danger += Math.max(0, count(j) - 1);
      if (j !== to && grid[j] !== 201 && !allied(me, os[j])) reserve += count(j) - 1;
    }
    const out = Math.max(0, Math.min(amount - 1, amount - reserve - 1));
    if (grid[from] === me + 100 && amount - out < Math.max(1, danger)) return 0;
    return out;
  }
  // 分别报价立即出击与已选汇兵边的耗时，未选择的远源不能抬高预算。
  function budget(gatherTicks) {
    const eta = gatherTicks + path.length;
    const distance = new Int32Array(size).fill(-1), support = path.slice();
    for (const i of support) distance[i] = 0;
    for (let h = 0; h < support.length; h++) {
      const i = support[h];
      if (distance[i] >= eta) continue;
      for (const j of ns(i)) if (distance[j] < 0 && known(j) && targetSide(j) && !state.isolated?.[j]) {
        distance[j] = distance[i] + 1; support.push(j);
      }
    }
    let defense = 0, reinforcement = 0, enemyGrowth = 0, reserveTax = 0;
    const onPath = new Set(path);
    for (const i of support) if (targetSide(i)) {
      enemyGrowth += growth(i, eta);
      if (onPath.has(i)) defense += army[i];
      else reinforcement += army[i];
    }
    for (const i of path) if (!os[i]) defense += army[i];
    for (let k = 0; k + 1 < path.length; k++) for (const j of ns(path[k])) {
      if (j === path[k + 1] || onPath.has(j) || own(j) || grid[j] === 201 || allied(me, os[j])) continue;
      if (!known(j)) return null;
      reserveTax += Math.max(0, count(j, eta) - 1);
    }
    return { gatherTicks, eta, defense, reinforcement, enemyGrowth, movementTax: path.length, reserveTax,
      required: defense + reinforcement + enemyGrowth + path.length + reserveTax + 1 };
  }
  const immediate = budget(0);
  if (!immediate) return reset();
  const available = pushed(rally, path[0]), required = immediate.required;
  const selected = new Uint8Array(size), sources = [];
  // 固定有效收益门槛：远方巨堆不能让附近皇冠或小而够用的兵源失去资格。
  for (const i of tree) if (i !== rally && !fronts?.has(i)) {
    const amount = pushed(i, parent[i]);
    if (amount >= 5 && amount - depth[i] >= 4) sources.push({ i, amount });
  }
  let edgeCount = 0, supplied = available, forecast = immediate;
  // 已够兵时根本不建筹兵树；否则仅选覆盖缺口的来源，近源不足才扩至远源。
  for (let pick = 0; available < required && supplied < forecast.required && pick < 12; pick++) {
    let best = null;
    for (const source of sources) {
      if (source.used || selected[source.i]) continue;
      let edges = 0;
      for (let j = source.i; j !== rally; j = parent[j]) if (!selected[j]) edges++;
      const delivered = source.amount - depth[source.i];
      const score = delivered / Math.max(1, edges), near = depth[source.i] <= 3;
      if (edges + edgeCount > 64 || (!near && score < 3)) continue;
      if (!best || (near && !best.near) || (near === best.near && score > best.score))
        best = { source, edges, score, near, delivered };
    }
    if (!best) break;
    best.source.used = true;
    for (let j = best.source.i; j !== rally; j = parent[j]) if (!selected[j]) { selected[j] = 1; edgeCount++; }
    supplied += best.delivered;
    forecast = budget(edgeCount);
    if (!forecast) return reset();
  }
  const active = new Uint8Array(size);
  let job = null;
  for (let h = tree.length - 1; h > 0; h--) {
    const i = tree[h], p = parent[i];
    if (!selected[i]) continue;
    const amount = pushed(i, p), near = depth[i] <= 3;
    // 远源经过近源时也先发走近处现兵，不等待远端叶子全部到齐。
    if ((!active[i] || (near && amount >= 5 && amount - depth[i] >= 4)) && amount > 2 && !fronts?.has(i)) {
      const score = (amount - 1) / Math.max(1, depth[i]);
      if (!job || (near && !job.near) || (near === job.near && score > job.score))
        job = { from: i, to: p, amount, score, near };
    }
    active[p] = 1;
  }
  // ── 浓缩突击（学自 _E_ 的单堆全冲，2026-09-27）──────────────────────────
  // 出击兵力达到决定性规模（≥megaStackMin 且 ≥所需×assaultMargin）时建议 mode2
  // 全冲（留 1 兵）逐格压向皇冠——大堆不被 mode0 智能留兵逐格剥皮，保持完整
  // 直到贴脸，最后一击由 frontline 的斩首锁定/合力推接管（整合点，非平行系统）。
  // 无跨回合状态：大堆被打残（跌破决定性规模）的下一 tick 自动回到稳推/汇兵，
  // 不死磕（止损）；家里有事时 defense/lastStand/cutoff/neck-guard 在 policy
  // 调度中全部优先于本模块（防斩首约束）。
  const stack = count(rally) - 1;
  const stackReady = stack >= p.megaStackMin && stack >= Math.ceil(required * p.assaultMargin);
  // 截断风险联动（cutoff/neck-guard）：全冲后 rally 只留 1 兵——若 rally 是大堆
  // 回锚的唯一通道（走廊头部没有其他连锚的我方邻格）、且 rally 贴脸有可动敌军
  // 能随手吃掉这 1 兵，大堆立即变孤军（不能移动、5 tick 后衰减——_E_ 败局形态）。
  // 这种脖子不全冲，降级为 mode0 稳推：智能留兵会在 rally 留下压得住贴脸敌军的
  // 守军，脖子有人守，大堆照样前进（policy 管线里 frontline 的 allInSafe 闸门
  // 与 neck-guard 模块是同一方向的第二、三道保险）。
  const neckRisk = stackReady && !ns(path[0]).some((j) => j !== rally && own(j)) &&
    ns(rally).some((j) => os[j] && !allied(me, os[j]) && !state.isolated?.[j] && count(j) > 2);
  const assault = stackReady && !neckRisk;
  // ── 画圈推进（2026-09-27，学自 _E_ 锋面量化）────────────────────────────
  // E 的推进锋面不是 1 格宽单列：推进期 5×5 窗口内己方格中位 7、垂直截面宽中位 4
  // （对手广正面为 13/6），是宽 2–3 的连通小块，一边画小圈一边往里推。实现：
  // 锋面头部不足 pushFrontWidth 宽时，大堆先侧向扫一格（与锋面平齐、不越过头部、
  // 下一步不会立刻回头的侧翼格），把推进带涂成两格宽；下一 tick 头部已是宽块，
  // 再沿路径前压——连通性优先于推进速度。
  let sweepTo = -1;
  if (assault && available >= required && approachDistance[rally] > 2) {
    // 只在「窄突出部」画圈：rally 自身只有 ≤1 个己方邻格（唯一的己方连接就是身后
    // 走廊）时才需要把锋面涂宽；rally 还坐在我方连片领土里时块本来就是宽的。
    const rallyOwn = ns(rally).filter((j) => own(j)).length;
    const headOwn = ns(path[0]).filter((j) => j !== rally && own(j)).length;
    if (rallyOwn <= 1 && headOwn + 1 < p.pushFrontWidth) {
      let latKey = Infinity;
      for (const j of ns(rally)) {
        if (j === path[0] || own(j) || !pass(j) || blocked(rally, j)) continue;
        if (toward[j] < 0 || toward[j] === rally) continue; // 不连皇冠方向/下一步即回头的不要
        if (approachDistance[j] < approachDistance[path[0]] - 1) continue; // 不越过锋面乱窜
        if (count(rally) - 1 - count(j, 1) < 1) continue; // 打不下来不扫
        const key = approachDistance[j] * 100000 + count(j, 1); // 与锋面平齐者优先
        if (key < latKey) { latKey = key; sweepTo = j; }
      }
    }
  }
  // ── 锚点链：推进走廊上按节奏落指挥所，用建筑当连通锚点防断联 ──────────────
  // E 推进窗口内指挥所建造间隔中位 4 tick、建造点距大堆/路径中位 2 格（近半数
  // 直接落在大堆脚下）。走廊 = rally 沿 anchorDist 严格下降走回锚点的路；候选
  // 为走廊上离最近建筑 ≥anchorChainGap、攒够 51 兵、建成后余兵不被贴脸敌兵吃掉的
  // 平地格。连通判定与 cutoff.cjs 共用同一份 BFS（ownStrandedMass，引擎
  // applyConnectivity 同款规则）：走廊存在 1 格脖子（移除后大堆段断锚）且走廊贴敌
  // = 有截断风险 → 锚点建造优先于本 tick 的移动；无风险时按 anchorBuildEvery 的
  // 节奏建造（大堆脚下的建造仍受节奏限制，避免每 tick 停工建站把推进拖死）。
  if (approachDistance[rally] > 2) {
    const anchorDist = new Int32Array(size).fill(-1);
    {
      const q = [];
      for (let i = 0; i < size; i++) if (own(i) && (grid[i] === me + 100 || grid[i] === me + 50)) { anchorDist[i] = 0; q.push(i); }
      for (let h = 0; h < q.length; h++) for (const j of ns(q[h]))
        if (anchorDist[j] < 0 && own(j) && !blocked(j, q[h])) { anchorDist[j] = anchorDist[q[h]] + 1; q.push(j); }
    }
    if (anchorDist[rally] >= p.anchorChainGap) {
      const corridor = [rally];
      while (corridor.length < 12) {
        const cur = corridor[corridor.length - 1];
        let next = -1;
        for (const j of ns(cur)) if (own(j) && anchorDist[j] >= 0 && anchorDist[j] < anchorDist[cur] &&
          (next < 0 || anchorDist[j] < anchorDist[next])) next = j;
        if (next < 0) break;
        corridor.push(next);
      }
      let site = -1;
      for (const c of corridor) {
        if (anchorDist[c] < p.anchorChainGap || grid[c] !== me || count(c) < p.anchorMinArmy) continue;
        // 建成后余兵必须压得住贴脸敌兵（否则指挥所落地即被顺手拆掉，白送 50）。
        if (ns(c).some((j) => os[j] && !allied(me, os[j]) && !state.isolated?.[j] && count(j) - 1 > count(c) - 50)) continue;
        if (site < 0 || anchorDist[c] > anchorDist[site]) site = c; // 离锚点最远者优先：链向前延伸
      }
      if (site >= 0) {
        const corridorHostile = corridor.some((c) => ns(c).some((j) => os[j] && !allied(me, os[j]) && !state.isolated?.[j]));
        const ctx = createContext(state, params); // policy 流程里命中同 tick 缓存
        // issue #70：迷宫快推单格走廊永远攒不出第二个 51 兵格（门槛即引擎建造花费），
        // 长补给线零锚点，一次百兵扫线抹掉全部领先（场 2 北伐 t99–113 被一锅端）。
        // mazeLike 时不再要求走廊贴敌：只要走廊存在 1 格脖子（移除后大堆段断锚）
        // 就视为有截断风险，无条件优先落锚——包括大堆脚下（站住一 tick 建站，
        // 下一 tick 该格成新锚点，链自然向前延伸）。
        let risky = false;
        if (ctx && (corridorHostile || ctx.mazeLike)) for (const c of corridor.slice(0, 8)) {
          const stranded = ownStrandedMass(ctx, c, p.cutoffScan);
          if (stranded !== null && stranded >= p.cutoffMinIsolate) { risky = true; break; }
        }
        const rhythm = turn % Math.max(2, Math.round(p.anchorBuildEvery)) === 0;
        if ((risky && (site !== rally || ctx?.mazeLike)) || rhythm) {
          return { kind: 'build', x: Math.floor(site / m), y: site % m, op: 'b',
            reason: { code: 'campaign', phase: 'anchor', target: mem.target, rally, site, risky,
              detail: risky ? '锚点链：走廊有截断风险，优先落指挥所保连通' : '锚点链：按节奏在推进走廊落指挥所' } };
        }
      }
    }
  }
  // 只有真实 rally 兵足够才出击；不把尚未到达的树上兵计入 available。
  let phase, from, to, amount;
  if (available >= required) { phase = 'advance'; from = rally; to = sweepTo >= 0 ? sweepTo : path[0]; amount = available; }
  else if (job) { phase = 'gather'; ({ from, to, amount } = job); }
  else return null;
  // 本模块目标持续锁定且汇兵边只向根；额外避免直接反转普通物流刚执行的搬运。
  const last = state.lastMove;
  if (last?.op === 'm' && last.turn >= turn - 1 && last.x * m + last.y === to && last.dx * m + last.dy === from) return null;
  mem.pending = { turn, from, to, before: army[from], destination: army[to], phase };
  const striking = phase === 'advance';
  return { x: Math.floor(from / m), y: from % m, dx: Math.floor(to / m), dy: to % m,
    mode: striking && assault ? 2 : 0, half: false, reason: { code: 'campaign',
      detail: phase === 'gather' ? '攻城树先叶后根汇兵'
        : assault && to === sweepTo ? '画圈推进：侧向扫一格，锋面涂成连通宽块'
        : assault ? '浓缩突击：决定性大堆全冲压向皇冠，沿途只留1兵' : '全程军力预算充足，进攻目标皇冠',
      phase, assault: striking ? assault : undefined, target: mem.target, rally, amount,
      distanceBefore: depth[from], distanceAfter: depth[to], forecast } };
}
module.exports = { chooseCampaign };
