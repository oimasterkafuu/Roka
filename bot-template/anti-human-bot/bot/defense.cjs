'use strict';
const { resolveParams } = require('./params.cjs');

// 每个活局面单独保存锁定；不保留全局玩家/地图引用，也不预测雾中兵力。
const plans = new WeakMap();
const HORIZON = 12;
const URGENT_TICKS = 3;
function chooseDefense(state, params = {}) {
  if (!state || state.dead || state.ended) return null;
  const { n, m, grid, army, playerId: me } = state;
  const size = n * m, turn = Number.isInteger(state.turn) ? state.turn : 0;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || size > 100000 ||
      !Number.isInteger(me) || me < 1 || me > 49 || grid?.length !== size || army?.length !== size) return null;
  const p = resolveParams(params);
  const owner = v => v > 0 && v < 200 ? v % 50 : 0;
  const os = Array.from(grid, owner);
  const team = p => state.teams instanceof Map ? state.teams.get(p) : 0;
  const allied = (a, b) => a > 0 && b > 0 && (a === b || (team(a) > 0 && team(a) === team(b)));
  const unknown = i => !!state.fog?.[i] || grid[i] === 202 || grid[i] === 203;
  const own = i => os[i] === me && !unknown(i) && !state.isolated?.[i];
  // mazeLike（与 threat.cjs 同一口径：已知格山体占比 ≥mazeMountainRatio）。
  let mountains = 0, knownCells = 0;
  for (let i = 0; i < size; i++) if (!unknown(i)) { knownCells++; if (grid[i] === 201) mountains++; }
  const mazeLike = knownCells > 0 && mountains / knownCells >= p.mazeMountainRatio;
  // issue #70：迷宫走廊动辄 15–19 跳，HORIZON=12 的反应窗让贴境敌大堆在可见范围内
  // 停 16 tick / 行军 18 turn 零应对（场 1 gwD2oA4C1FjB、场 2 eX1LjyqR5HUA）。
  // 皇冠 BFS 量的本来就是走廊连通距离，maze 下只需放宽跳数上限与提前汇兵窗口。
  const horizon = mazeLike ? Math.round(p.mazeDefenseHorizon) : HORIZON;
  const rallyWindow = Math.max(URGENT_TICKS, Math.round(p.defenseHorizon),
    mazeLike ? Math.round(p.mazeRallyWindow) : 0);  const ns = i => {
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
    memory = { turn, me, size };
    plans.set(state, memory);
  }
  memory.turn = turn;
  // 只保留本 tick 的距离场缓存（同一回合内重复查询用），不做跨回合快照。
  if (memory.observation?.turn !== turn) {
    memory.observation = { turn, distances: new Map() };
  }
  // 对每个兵团分别搜索距离严格下降的最短路 DAG，避免多层绕路枚举。
  // BFS 保留绕山最短路；盟军格可汇合，其他守军消耗入侵兵力。
  const threats = [], pressure = new Map();
  let budget = 1500000;
  for (const c of crowns) {
    const distance = new Int32Array(size).fill(-1), queue = [c]; distance[c] = 0;
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h]; if (distance[i] >= horizon) continue;
      for (const j of ns(i)) {
        if (--budget < 0) return null;
        if (distance[j] < 0 && grid[j] !== 201 && !unknown(j)) {
          distance[j] = distance[i] + 1; queue.push(j);
        }
      }
    }
    memory.observation.distances.set(c, distance);
    for (const e of enemies) {
      if (distance[e] < 1 || distance[e] > horizon) continue;
      // 只看当前局面：威胁离皇冠的当前距离是否落在反应窗口内。
      const approaching = distance[e] <= rallyWindow;
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
  if (!threats.length) return mazeLike ? megaStackPreposition() : null;
  const threatOwners = new Set(threats.map(t => os[t.e]));
  // mode0 与服务器智能留兵一致；未知邻格拒绝运输，不将不可见数值当已知。
  function push(s, t, amount, tick) {
    if (!own(s) || ns(s).some(unknown)) return 0;
    let reserve = 0;
    for (const j of ns(s)) if (j !== t && grid[j] !== 201 && !allied(me, os[j])) reserve += count(j, tick) - 1;
    return Math.min(Math.max(0, amount - 1), Math.max(0, amount - reserve - 1));
  }
    // ── maze 贴境超大兵堆预置防线（issue #70，函数声明提升，上方两处 null 兜底调用）──
  // 场 1：191 兵堆贴着我方前哨停了 16 tick——战斗推演认定它打不穿沿途守军（或它
  // 还在反应窗外），于是全程零应对；可它一旦启动，4 兵前哨一 tick 就碎。mazeLike
  // 时对「贴我方领土的超大可见兵堆（≥megaStackMin/2）」无视上述闸门：往最薄弱的
  // 贴境格预置增援——敌堆在走廊里多停一 tick，我们就多集一 tick 兵。
  function megaStackPreposition() {
    const minStack = Math.max(2, Math.round(p.megaStackMin / 2));
    const gatherWindow = Math.min(6, rallyWindow);
    let guard = null;
    for (const e of enemies) {
      const stack = count(e, 1);
      if (stack < minStack) continue;
      // 贴境最强格压得住敌堆 = 威胁已被前线挡住，不预置（交回正常管线判断）。
      let wall = 0, target = -1;
      for (const b of ns(e)) {
        if (!own(b)) continue;
        wall = Math.max(wall, count(b, 1));
        if (count(b, 1) < stack && (target < 0 || count(b, 1) < count(target, 1))) target = b;
      }
      if (target < 0 || wall >= stack) continue;
      const need = stack - count(target, 1) + 1;
      // 贴境格随时可能一 tick 陷落：从我方境内沿严格下降路径往它集兵。
      const d = new Int32Array(size).fill(-1), toward = new Int32Array(size).fill(-1), q = [target];
      d[target] = 0;
      for (let h = 0; h < q.length; h++) for (const j of ns(q[h])) {
        if (--budget < 0) return null;
        if (d[j] < 0 && own(j) && d[q[h]] < gatherWindow) { d[j] = d[q[h]] + 1; toward[j] = q[h]; q.push(j); }
      }
      for (const s of lands) {
        if (d[s] < 1) continue;
        const amount = push(s, toward[s], count(s, 1), 1);
        // 与背水一战同一条纪律：贡献不足缺口一成的零星碎兵是白送，不虚报动作。
        if (amount < Math.max(10, Math.ceil(need * 0.1))) continue;
        // 所有有入侵路径的皇冠都保留足够守军，不牺牲另一个皇冠救最近者。
        if (grid[s] === me + 100 && count(s, 1) - amount < Math.max(4, pressure.get(s) ?? 0)) continue;
        const score = amount / d[s];
        if (!guard || score > guard.score) guard = { s, dest: toward[s], amount, score, e };
      }
    }
    if (!guard) return null;
    const reason = `maze预置防线：贴境敌堆约${Math.round(count(guard.e, 1))}兵，先送${Math.round(guard.amount)}兵补向贴境格`;
    return { move: { x: Math.floor(guard.s / m), y: guard.s % m, dx: Math.floor(guard.dest / m), dy: guard.dest % m,
      half: false, mode: 0, reason }, threatOwners: new Set([os[guard.e]]), urgent: false, imminent: false, reason };
  }
  const candidates = [];
  // 补不齐缺口时的最强部分增援（按威胁收集，全或无筛选之后再兜底）。
  const fallbacks = [];
  for (const threat of threats) {
    // 优先能够赶上的前线，不将城市/塔误当成终极救援目标。
    for (let k = 0; k < threat.path.length; k++) {
      const target = threat.path[k];
      if (!own(target) && target !== threat.e) continue;
      const deadline = Math.max(1, k), hostile = target === threat.e;
      // 反应窗口不再只有 3 tick：能提前拦的威胁提前拦，避免敌堆贴脸才动。
      if (threat.time > rallyWindow && !hostile && !threat.approaching) continue;
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
        const dest = toward[s];
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
        const urgent = threat.time <= URGENT_TICKS;
        const minimum = Math.max(3, Math.ceil(threat.deficit * d[s] / threat.time));
        if (contribution > 0 && (urgent || (firstAmount >= minimum && contribution >= minimum)))
          routes.push({ s, dest, amount: contribution, contribution, firstAmount, distance: d[s] });
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
        const urgent = threat.time <= URGENT_TICKS, counter = hostile;
        candidates.push({ ...chosen, target, threat, duration, frontline: k, urgent, counter });
      } else if (routes.length) {
        // 全或无的陷阱（_E_ 胜局复盘根因）：400+ 兵堆压向皇冠时，没有任何一路
        // 能补齐缺口，旧实现直接当「无防御动作」返回 null，bot 随后几 tick
        // 照常筹资/建设，皇冠零增援陷落。这里记下最强的一路部分增援兜底——
        // 皇冠被端就是终局，每拖一 tick 都可能有新的援军进入窗口。
        const top = routes.reduce((a, b) => (b.amount > a.amount ? b : a));
        fallbacks.push({ ...top, target, threat, need, duration: top.distance, frontline: k });
      }
    }
  }
  // 纯当前局面排序：先截击、再早到达、再短路径、再靠前的前线、再多兵。
  candidates.sort((a, b) => Number(b.counter) - Number(a.counter) || a.threat.time - b.threat.time ||
    a.duration - b.duration || a.frontline - b.frontline || b.amount - a.amount);
  const best = candidates[0];
  if (!best) {
    // 背水一战：所有路线都补不齐缺口时，仍返回最强的一路部分增援（lastStand），
    // 绝不零反应。零星碎兵（贡献不足缺口 10% 且不到 10 兵）不送——那是白给。
    // 只兜底反应窗口（defenseHorizon）内的贴脸威胁；窗口外的远威胁交给
    // 补给/物流管线预置兵力，不提前锁死全部动作。
    const viable = fallbacks.filter((fb) => fb.threat.deficit > 0 && fb.threat.time <= rallyWindow &&
      fb.amount >= Math.max(10, Math.ceil(fb.need * 0.1)));
    if (!viable.length) return mazeLike ? megaStackPreposition() : null;
    viable.sort((a, b) => a.threat.time - b.threat.time || b.amount - a.amount);
    const fb = viable[0];
    const reason = `皇冠防守：背水一战，缺口约${Math.round(fb.need)}补不齐，先送最强一路约${Math.round(fb.amount)}兵，敌军约${fb.threat.time}tick抵达皇冠`;
    return { move: { x: Math.floor(fb.s / m), y: fb.s % m, dx: Math.floor(fb.dest / m), dy: fb.dest % m,
      half: false, mode: 0, reason }, threatOwners,
      urgent: fb.threat.time <= URGENT_TICKS && fb.threat.deficit > 0,
      imminent: fb.threat.time <= 1 && fb.threat.deficit > 0,
      lastStand: true, deficit: Math.round(fb.threat.deficit), reason };
  }
  const urgent = best.threat.time <= URGENT_TICKS && best.threat.deficit > 0;
  // 只有贴脸救城（1 tick 内）或前线截击才允许越过移动护栏的反向禁行：
  // 提前汇兵（威胁还有 2+ tick）若与刚执行的运输方向相反而硬拉回去，
  // 就会和经济/物流运输在同一堆兵上互相倒兵（RMtDIbE7rDS6 t526⇄t527⇄t533⇄t534 绕圈根因）。
  const imminent = (best.threat.time <= 1 || best.counter) && best.threat.deficit > 0;
  const reason = `皇冠防守：${best.target === best.threat.e ? '前线截击' : '提前汇兵'}，敌军约${best.threat.time}tick抵达皇冠`;
  return { move: { x: Math.floor(best.s / m), y: best.s % m, dx: Math.floor(best.dest / m), dy: best.dest % m,
    half: false, mode: 0, reason }, threatOwners, urgent, imminent, reason };
}
module.exports = { chooseDefense };
