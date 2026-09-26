'use strict';

// 每个活局面单独保存锁定；不保留全局玩家/地图引用，也不预测雾中兵力。
const plans = new WeakMap();
const HORIZON = 12;
function chooseDefense(state) {
  if (!state || state.dead || state.ended) return null;
  const { n, m, grid, army, playerId: me } = state;
  const size = n * m, turn = Number.isInteger(state.turn) ? state.turn : 0;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || size > 100000 ||
      !Number.isInteger(me) || me < 1 || me > 49 || grid?.length !== size || army?.length !== size) return null;
  const owner = v => v > 0 && v < 200 ? v % 50 : 0;
  const os = Array.from(grid, owner);
  const team = p => state.teams instanceof Map ? state.teams.get(p) : 0;
  const allied = (a, b) => a > 0 && b > 0 && (a === b || (team(a) > 0 && team(a) === team(b)));
  const unknown = i => !!state.fog?.[i] || grid[i] === 202 || grid[i] === 203;
  const own = i => os[i] === me && !unknown(i) && !state.isolated?.[i];
  const ns = i => {
    const out = [];
    if (i >= m) out.push(i - m);
    if (i % m) out.push(i - 1);
    if (i % m + 1 < m) out.push(i + 1);
    if (i + m < size) out.push(i + m);
    return out;
  };
  function growth(i, ticks) {
    if (!os[i] || unknown(i)) return 0;
    if (grid[i] === os[i] + 100) return ticks;
    if (state.isolated?.[i] || grid[i] >= 150) return 0;
    return Math.floor((turn + ticks) / 50) - Math.floor(turn / 50) +
      (grid[i] < 50 ? Math.max(0, Math.min(50, turn + ticks) - Math.max(25, turn)) : 0);
  }
  const count = (i, t) => army[i] + growth(i, t);
  const crowns = [], enemies = [], lands = [];
  for (let i = 0; i < size; i++) {
    if (!Number.isFinite(army[i]) || army[i] < 0 || !Number.isInteger(grid[i])) return null;
    if (own(i)) lands.push(i);
    if (os[i] === me && grid[i] === me + 100 && !unknown(i)) crowns.push(i);
    if (os[i] && !allied(me, os[i]) && !unknown(i) && !state.isolated?.[i] && count(i, 1) > 1) enemies.push(i);
  }
  let memory = plans.get(state);
  if (!memory || turn < memory.turn || memory.me !== me || memory.size !== size) {
    memory = { turn, me, size, lock: null, edges: new Map(), attempts: new Map(),
      pending: null, receiptTurn: -Infinity, defenses: [], progress: new Map() };
    plans.set(state, memory);
  }
  memory.turn = turn;
  // 同拍重入使用同一份上一拍快照；跨拍缺测不推断雾中移动。
  if (memory.observation?.turn !== turn) {
    memory.previous = memory.observation;
    memory.observation = { turn, grid: Array.from(grid), army: Array.from(army),
      visible: Array.from({ length: size }, (_, i) => !unknown(i)), distances: new Map() };
  }
  const previousObservation = memory.previous;
  // 只有服务器回执匹配本模块上一拍提议，才占用回防配额。
  const receipt = state.lastMove, pending = memory.pending;
  if (receipt && Number.isInteger(receipt.turn) && receipt.turn <= turn && receipt.turn > memory.receiptTurn) {
    memory.receiptTurn = receipt.turn;
    if (pending && receipt.op === 'm' && receipt.turn > pending.turn && receipt.turn <= pending.turn + 1 &&
        receipt.x * m + receipt.y === pending.s && receipt.dx * m + receipt.dy === pending.dest &&
        (receipt.mode == null || [0, 1, 2].includes(receipt.mode))) {
      memory.edges.set(pending.key, receipt.turn);
      if (!pending.urgent && !pending.counter) {
        memory.defenses.push(receipt.turn);
        memory.progress.set(pending.signature, { ...pending, executed: receipt.turn });
      }
    }
    memory.pending = null;
  }
  memory.defenses = memory.defenses.filter(t => t > turn - 5);
  // 对每个兵团分别搜索距离严格下降的最短路 DAG，避免多层绕路枚举。
  // BFS 保留绕山最短路；盟军格可汇合，其他守军消耗入侵兵力。
  const threats = [], pressure = new Map();
  let budget = 1500000;
  for (const c of crowns) {
    const distance = new Int32Array(size).fill(-1), queue = [c]; distance[c] = 0;
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h]; if (distance[i] >= HORIZON) continue;
      for (const j of ns(i)) {
        if (--budget < 0) return null;
        if (distance[j] < 0 && grid[j] !== 201 && !unknown(j)) {
          distance[j] = distance[i] + 1; queue.push(j);
        }
      }
    }
    memory.observation.distances.set(c, distance);
    const oldDistance = previousObservation?.turn === turn - 1 ? previousObservation.distances.get(c) : null;
    function advancing(e) {
      // 必须朝同一个既有皇冠实际搬兵，不能把新建皇冠或地形变化当成逼近。
      if (!oldDistance || !previousObservation.visible[e] || oldDistance[e] < 1) return false;
      const oldOwner = owner(previousObservation.grid[e]);
      const gained = oldOwner !== os[e] || army[e] > previousObservation.army[e] + 2;
      return gained && ns(e).some(s => previousObservation.visible[s] && !unknown(s) &&
        owner(previousObservation.grid[s]) === os[e] && os[s] === os[e] &&
        oldDistance[s] > oldDistance[e] && distance[s] > distance[e] &&
        previousObservation.army[s] > army[s] + 1);
    }
    for (const e of enemies) {
      if (distance[e] < 1 || distance[e] > HORIZON) continue;
      const approaching = distance[e] <= 3 || advancing(e);
      let layer = new Map([[e, { left: count(e, 1), path: [e], incoming: [count(e, 1)] }]]);
      let best = null;
      for (let t = 1; t <= distance[e] && layer.size; t++) {
        const next = new Map();
        for (const [i, p] of layer) for (const j of ns(i)) {
          if (--budget < 0) return null;
          if (distance[j] < 0 || distance[j] !== distance[i] - 1) continue;
          const incoming = p.left - 1;
          if (incoming <= 0) continue;
          const friendly = allied(os[e], os[j]);
          const left = incoming + (friendly ? count(j, t) : -count(j, t));
          if (j === c) {
            const threat = { c, e, time: t, incoming, deficit: left, path: [...p.path, j], arrivals: [...p.incoming, incoming] };
            if (!pressure.has(c) || incoming - growth(c, t) > pressure.get(c)) pressure.set(c, incoming - growth(c, t));
            if (left > 0 && (!best || t < best.time || (t === best.time && left > best.deficit))) best = threat;
          } else if (left > 0 && (!next.has(j) || next.get(j).left < left)) {
            // 已占领格的建筑摧毁，移动军只按普通地增长，不能带走原皇冠的未来增长。
            const tickGrowth = turn + t + 1;
            const movingGrowth = friendly ? growth(j, t + 1) - growth(j, t) :
              (tickGrowth % 50 === 0 ? 1 : 0) + (tickGrowth >= 26 && tickGrowth <= 50 ? 1 : 0);
            next.set(j, { left: left + movingGrowth, path: [...p.path, j], incoming: [...p.incoming, incoming] });
          }
        }
        layer = next;
      }
      if (best) threats.push({ ...best, approaching });
    }
  }
  if (!threats.length) { memory.lock = null; return null; }
  const threatOwners = new Set(threats.map(t => os[t.e]));
  // mode0 与服务器智能留兵一致；未知邻格拒绝运输，不将不可见数值当已知。
  function push(s, t, amount, tick) {
    if (!own(s) || ns(s).some(unknown)) return 0;
    let reserve = 0;
    for (const j of ns(s)) if (j !== t && grid[j] !== 201 && !allied(me, os[j])) reserve += count(j, tick) - 1;
    return Math.min(Math.max(0, amount - 1), Math.max(0, amount - reserve - 1));
  }
  const candidates = [];
  for (const threat of threats) {
    // 优先能够赶上的前线，不将城市/塔误当成终极救援目标。
    for (let k = 0; k < threat.path.length; k++) {
      const target = threat.path[k];
      if (!own(target) && target !== threat.e) continue;
      const deadline = Math.max(1, k), hostile = target === threat.e;
      if (threat.time > 3 && !hostile && !threat.approaching) continue;
      const need = hostile ? count(target, 1) + 1 : Math.max(0, threat.arrivals[k] - count(target, deadline) + 1);
      if (!hostile && need <= 0) continue;
      const d = new Int32Array(size).fill(-1), toward = new Int32Array(size).fill(-1), q = [target]; d[target] = 0;
      for (let h = 0; h < q.length; h++) for (const j of ns(q[h])) {
        if (--budget < 0) return null;
        if (d[j] < 0 && own(j) && d[q[h]] < deadline) { d[j] = d[q[h]] + 1; toward[j] = q[h]; q.push(j); }
      }
      const routes = [];
      for (const s of lands) {
        if (d[s] < 1 || d[s] > deadline) continue;
        const dest = toward[s], key = `${s}:${dest}`;
        if ((memory.edges.get(`${dest}:${s}`) ?? -Infinity) > turn - HORIZON) continue;
        const attempt = memory.attempts.get(key);
        if (attempt && attempt.turn < turn && attempt.count === army[s] && attempt.targetCount === army[dest] && turn - attempt.since >= 3) continue;
        let amount = push(s, dest, count(s, 1), 1);
        if (!amount) continue;
        // 所有有入侵路径的皇冠都保留足够守军，不牺牲另一个皇冠救最近者。
        if (grid[s] === me + 100 && count(s, 1) - amount < (pressure.get(s) ?? 0)) continue;
        const firstAmount = amount;
        let current = dest, steps = 1, baseline = 0;
        while (current !== target && amount > 0) {
          // 对照相同路线但不搬首格援军：沿途原有兵不能冒充新增贡献。
          const garrison = count(current, steps + 1);
          baseline = push(current, toward[current], baseline + garrison, steps + 1);
          amount = push(current, toward[current], amount + garrison, steps + 1);
          current = toward[current]; steps++;
        }
        const contribution = Math.max(0, amount - baseline);
        const urgent = threat.time <= 3;
        const minimum = Math.max(3, Math.ceil(threat.deficit * d[s] / threat.time));
        if (contribution > 0 && (urgent || (firstAmount >= minimum && contribution >= minimum)))
          routes.push({ s, dest, amount: contribution, contribution, firstAmount, distance: d[s], key });
      }
      routes.sort((a, b) => a.distance - b.distance || b.amount - a.amount || a.s - b.s);
      // 单路有效截击优先；否则只在串行搬运总时限内汇兵。路径不重叠，避免重复计算沿途守军。
      let chosen = routes.find(r => r.amount >= need), duration = chosen?.distance;
      if (!chosen && !hostile) {
        let sum = 0, ticks = 0; const used = new Set(), group = [];
        for (const r of routes) {
          const path = []; for (let i = r.s; i !== target; i = toward[i]) path.push(i);
          if (path.some(i => used.has(i)) || ticks + r.distance > deadline) continue;
          path.forEach(i => used.add(i)); sum += r.amount; ticks += r.distance; group.push(r);
          if (sum >= need) { chosen = group[0]; duration = ticks; break; }
        }
      }
      if (chosen) {
        const urgent = threat.time <= 3, counter = hostile;
        const signature = `${threat.c}:${os[threat.e]}`;
        const previous = memory.progress.get(signature);
        // 停滞的集兵威胁不应永久压住经济；真实三拍内致命救援、可胜截击不受此限制。
        if (!urgent && !counter && (memory.defenses.length >= 2 ||
            (previous && turn < previous.executed + 5 &&
              (threat.deficit >= previous.deficit || threat.time >= previous.time)))) continue;
        candidates.push({ ...chosen, target, threat, duration, frontline: k, urgent, counter, signature });
      }
    }
  }
  candidates.sort((a, b) => Number(b.counter) - Number(a.counter) || a.threat.time - b.threat.time || a.duration - b.duration ||
    ((b.target === memory.lock?.target ? 1 : 0) - (a.target === memory.lock?.target ? 1 : 0)) || a.frontline - b.frontline || b.amount - a.amount);
  const best = candidates[0];
  if (!best) { memory.lock = null; return null; }
  memory.lock = { target: best.target, crown: best.threat.c };
  memory.pending = { ...best, turn, deficit: best.threat.deficit, time: best.threat.time };
  const previous = memory.attempts.get(best.key);
  memory.attempts.set(best.key, { turn, since: previous?.count === army[best.s] && previous?.targetCount === army[best.dest] ? previous.since : turn,
    count: army[best.s], targetCount: army[best.dest] });
  for (const [key, tick] of memory.edges) if (tick < turn - HORIZON) memory.edges.delete(key);
  for (const [key, a] of memory.attempts) if (a.turn < turn - HORIZON) memory.attempts.delete(key);
  const urgent = best.threat.time <= 3 && best.threat.deficit > 0;
  const reason = `皇冠防守：${best.target === best.threat.e ? '前线截击' : '提前汇兵'}，敌军约${best.threat.time}tick抵达皇冠`;
  return { move: { x: Math.floor(best.s / m), y: best.s % m, dx: Math.floor(best.dest / m), dy: best.dest % m,
    half: false, mode: 0, reason }, threatOwners, urgent, reason };
}
module.exports = { chooseDefense };
