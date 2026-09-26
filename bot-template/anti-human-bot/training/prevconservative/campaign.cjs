'use strict';

// 只保存目标和已由真实棋盘确认的树节点，不保存未来动作队列。
const memories = new WeakMap();
function chooseCampaign(state, params = {}, options = {}) {
  if (!state || typeof state !== 'object') return null;
  const reset = () => { memories.delete(state); return null; };
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
  if (!crowns.length || power <= 1.4 * enemyPower) return reset();
  let mem = memories.get(state);
  if (!mem || turn < mem.turn || mem.me !== me || mem.n !== n || mem.m !== m ||
      mem.gameId !== state.gameId || mem.targetOwner !== targetOwner) {
    mem = { turn, me, n, m, gameId: state.gameId, targetOwner, target: null, rally: null, done: new Set() };
    memories.set(state, mem);
  }
  mem.turn = turn;
  if (mem.target !== null && !crowns.includes(mem.target)) return reset();
  // 反向 BFS 同时寻找皇冠路径和最接近的己方前线，每格只访问一次。
  const toward = new Int32Array(size).fill(-1), root = new Int32Array(size).fill(-1);
  const q = mem.target === null ? crowns.slice() : [mem.target];
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
  // 只缓存对手目标；兵源、树和前线终点每tick滚动重算，执行过的格子增长后仍可供兵。
  mem.done.clear();mem.pending=null;
  // 选择当下的前线出发点，兼顾接敌距离与现有大军，给旧点微小迟滞而非锁死。
  let bestRally=-1,bestRallyScore=-Infinity;
  const fronts = options.boundaryAdvance ? new Set(Array.from({length:size}, (_,i)=>i)
    .filter(i=>own(i)&&toward[i]>=0&&ns(i).some(j=>targetSide(j)))) : null;
  for(let i=0;i<size;i++)if(own(i)&&toward[i]>=0&&root[i]=== (mem.target??root[i])){
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
  forecast = { ...forecast, required, available };
  // 只有真实 rally 兵足够才出击；不把尚未到达的树上兵计入 available。
  let phase, from, to, amount;
  if (available >= required) { phase = 'advance'; from = rally; to = path[0]; amount = available; }
  else if (job) { phase = 'gather'; ({ from, to, amount } = job); }
  else return null;
  // 本模块目标持续锁定且汇兵边只向根；额外避免直接反转普通物流刚执行的搬运。
  const last = state.lastMove;
  if (last?.op === 'm' && last.turn >= turn - 1 && last.x * m + last.y === to && last.dx * m + last.dy === from) return null;
  mem.pending = { turn, from, to, before: army[from], destination: army[to], phase };
  return { x: Math.floor(from / m), y: from % m, dx: Math.floor(to / m), dy: to % m,
    mode: 0, half: false, reason: { code: 'campaign', detail: phase === 'gather' ? '攻城树先叶后根汇兵' : '全程军力预算充足，进攻目标皇冠',
      phase, target: mem.target, rally, amount, distanceBefore: depth[from], distanceAfter: depth[to], forecast } };
}
module.exports = { chooseCampaign };
