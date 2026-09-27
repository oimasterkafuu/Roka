'use strict';
const { resolveParams } = require('./params.cjs');
const { architecture } = require('./architecture.cjs');
const { chooseBuild, urgent, crownTarget, clusterValue } = require('./building.cjs');

// 只以局面对象为键，不把任何局面的引用放进共享计划。
const memories = new WeakMap();

// 只公开本 tick 已重新验证过、确有运输动作的一轮补给。
function getSupplyBatch(state) {
  const memory = state && memories.get(state);
  if (!memory || state.ended || state.dead || memory.turn !== (Number.isFinite(state.turn) ? state.turn : 0)) return null;
  return memory.activeBatch ? { ...memory.activeBatch } : null;
}

function chooseLogistics(state, move, build, params = {}) {
  const previous = state && memories.get(state);
  if (previous) previous.activeBatch = null;
  if (!state || state.ended || state.dead) {
    if (state) memories.delete(state);
    return null;
  }
  const { n, m, grid, army, playerId: me } = state;
  const size = n * m;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n <= 0 || m <= 0 ||
      !Number.isInteger(me) || me < 1 || me > 49 || !grid || !army ||
      grid.length !== size || army.length !== size) return null;
  const turn = Number.isFinite(state.turn) ? state.turn : 0;
  let memory = memories.get(state);
  if (!memory || turn < memory.turn || memory.me !== me || memory.size !== size) {
    memory = { turn, me, size, rally: null, economy: null, lastTransport: -Infinity, lastBuild: -Infinity, observations: new Map(), lastEconomy: -Infinity, edges: new Map() };
    memories.set(state, memory);
  }
  memory.turn = turn;
  // 先处理回退，再让行，避免紧急 tick 掩盖重开。
  const militaryOnly = params.militaryOnly === true;
  if (!militaryOnly && urgent(state, move)) return null;
  const p = resolveParams(params);
  const architecturePlan = architecture(state, p);
  const owner = v => v > 0 && v < 200 ? v % 50 : 0;
  const owners = Array.from(grid, owner);
  const team = state.teams instanceof Map ? state.teams.get(me) : 0;
  const allied = id => id === me || (id > 0 && team > 0 && state.teams.get(id) === team);
  const unknown = i => !!state.fog?.[i] || grid[i] === 202 || grid[i] === 203;
  const own = i => owners[i] === me && !state.isolated?.[i] && !unknown(i);
  const count = i => Number.isFinite(army[i]) ? Math.max(0, army[i]) : 0;
  const enemy = i => owners[i] > 0 && !allied(owners[i]) && !unknown(i) && !state.isolated?.[i];
  const neighbors = Array.from({ length: size }, (_, i) => {
    const a = [];
    if (i >= m) a.push(i - m);
    if (i % m) a.push(i - 1);
    if (i % m + 1 < m) a.push(i + 1);
    if (i + m < size) a.push(i + m);
    return a;
  });
  function field(seeds, allowed) {
    const d = new Int32Array(size).fill(-1), q = [];
    for (const i of seeds) { d[i] = 0; q.push(i); }
    for (let h = 0; h < q.length; h++) for (const j of neighbors[q[h]]) {
      if (d[j] < 0 && allowed(j)) { d[j] = d[q[h]] + 1; q.push(j); }
    }
    return d;
  }
  function pushed(from, to) {
    let reserve = 0;
    for (const k of neighbors[from]) {
      if (k === to || grid[k] === 201 || grid[k] === 203 || allied(owners[k])) continue;
      reserve += unknown(k) ? 2 : count(k) - 1;
    }
    return Math.min(count(from) - 1, Math.max(0, count(from) - reserve - 1));
  }
  const pressure = i => neighbors[i].reduce((s, j) => s + (enemy(j) ? Math.max(0, count(j) - 1) : 0), 0);
  const lands = [], fronts = [], borders = [], threats = [];
  let crowns = 0, cities = 0, available = 0;
  for (let i = 0; i < size; i++) {
    if (enemy(i) || unknown(i)) threats.push(i);
    if (!own(i)) continue;
    lands.push(i);
    if (grid[i] === me + 100) crowns++;
    if (grid[i] === me + 50) cities++;
    available += Math.max(0, count(i) - 1);
    if (neighbors[i].some(j => enemy(j) && (!params.allowedOwners || params.allowedOwners.has(owners[j])))) fronts.push(i);
    if (neighbors[i].some(j => !allied(owners[j]) && (!owners[j] || !params.allowedOwners || params.allowedOwners.has(owners[j])) && grid[j] !== 201 && grid[j] !== 203)) borders.push(i);
  }
  if (!lands.length) return null;
  const danger = field(threats, i => grid[i] !== 201 && grid[i] !== 203);
  const safe = i => own(i) && (danger[i] < 0 || danger[i] > Math.max(3, p.enemyDistance));
  const economicSite = i => {
    const risk = architecturePlan.assess(i);
    if (!risk.complete || !Number.isFinite(risk.reserve)) return false;
    // 只证明筹齐后的安全潜力，不拿虚拟兵放行真实建造。
    if (risk.crownSafe) return true;
    const virtualArmy = Array.from(army);
    virtualArmy[i] = 100 + risk.reserve;
    return architecture({ ...state, army: virtualArmy }, p).assess(i).crownSafe;
  };
  const targetCrowns = crownTarget(lands.length, turn, p, state);
  const safety = Math.max(2, Math.ceil(p.buildSafety));
  // 仅比较连续可见、同属同类型格的增量；扣掉自然增长，不读取敌方命令。
  function growth(i, start, ticks) {
    if (!owners[i] || state.isolated?.[i] || unknown(i)) return 0;
    if (grid[i] > 100 && grid[i] < 150) return ticks;
    if (grid[i] >= 150) return 0;
    const periodic = Math.floor((start + ticks) / 50) - Math.floor(start / 50);
    return periodic + (grid[i] < 50 ? Math.max(0, Math.min(50, start + ticks) - Math.max(25, start)) : 0);
  }
  const rates = new Map(), observed = new Map();
  for (const i of threats) if (enemy(i)) {
    const old = memory.observations.get(i);
    let rate = 0;
    if (old && old.code === grid[i] && turn > old.turn)
      rate = Math.max(0, count(i) - old.count - growth(i, old.turn, turn - old.turn)) / (turn - old.turn);
    else if (old && old.turn === turn) rate = old.rate;
    rates.set(i, rate);
    observed.set(i, { code: grid[i], count: count(i), turn, rate });
  }
  memory.observations = observed;
  // 远端敌总量属于进攻预测，不可再次折算为每个后方格的无限留兵。
  const reserveAt = i => Math.max(safety, pressure(i) + 1);
  function transport(target, funding = false) {
    // 反向有向BFS把禁行边纳入路径，而非求完最短路才发现第一步不能走。
    const d = new Int32Array(size).fill(-1), queue = [target]; d[target] = 0;
    for (let h=0;h<queue.length;h++) for (const j of neighbors[queue[h]]) {
      if (d[j]>=0 || !own(j) || params.blockedEdges?.has(`${j}:${queue[h]}`)) continue;
      if (!militaryOnly && (memory.edges.get(`${queue[h]}:${j}`) ?? -Infinity)+12>turn) continue;
      d[j]=d[queue[h]]+1;queue.push(j);
    }
    let best = null, rear = 0;
    for (const from of lands) {
      if (d[from] <= 0 || neighbors[from].some(enemy)) continue;
      // 已筹资金及运输途中的资金不再向前线抽走；目标失守、失去安全资格或达标即解除。
      if (!militaryOnly && !funding && memory.economy && (memory.economy.target === from || memory.economy.funded.has(from)) && safe(from) &&
          crowns < targetCrowns && (grid[memory.economy.target] === me + 50 || (grid[memory.economy.target] === me && crowns + cities < targetCrowns))) continue;
      rear += Math.max(0, count(from) - 1);
      for (const to of neighbors[from]) {
        if (!own(to) || d[to] !== d[from] - 1 || params.blockedEdges?.has(`${from}:${to}`)) continue;
        if (!militaryOnly && (memory.edges.get(`${to}:${from}`) ?? -Infinity) + 12 > turn) continue;
        let amount = pushed(from, to), mode = 0;
        if (amount <= 0) continue;
        // 附近皇冠不能全抽就改用真实半兵，不应因此跳过它去搬最远巨堆。
        if (grid[from] === me + 100) {
          const keep = safe(from) ? 1 : Math.max(safety, pressure(from) + 1);
          if (count(from) - amount < keep) { amount = Math.floor(amount / 2); mode = 1; }
          if (amount <= 0 || count(from) - amount < keep) continue;
        }
        // 不能让近处1兵/2兵循环或皇冠每tick新长的几兵永远压住远方有效兵源。
        if (militaryOnly && amount < Math.max(5, Math.min(50, Math.ceil(count(target) * 0.01)))) continue;
        const gain = amount / Math.max(1, d[from]);
        const local = d[from] <= 3 && amount >= 5;
        // 军事补给优先已在近处的有效兵源；经济筹资保留按效率选源。
        if (!best || (!funding && local && !best.local) ||
            ((funding || local === best.local) && gain > best.gain))
          best = { from, to, amount, gain, distance: d[from], local, mode };
      }
    }
    return { best, rear, ratio: rear / Math.max(1, available) };
  }
  // 真实敌人边界优先；只有没有可达敌前线时才选择中立/雾边界。
  const validRally = plan => {
    if (!plan || !own(plan.target) || !(fronts.length ? fronts : borders).includes(plan.target)) return false;
    const d = field([plan.target], own);
    return lands.some(i => d[i] > 0);
  };
  if (militaryOnly && memory.batch) {
    const b = memory.batch;
    if (turn - b.since >= 16 || !own(b.target) || !enemy(b.enemy) ||
        grid[b.enemy] !== b.enemyCode || !neighbors[b.target].includes(b.enemy) ||
        !fronts.includes(b.target) || count(b.target) >= b.required) {
      memory.batch = null;
      return null;
    }
    memory.rally = { target: b.target, since: b.since };
  }
  if (!validRally(memory.rally)) {
    memory.rally = null;
    for (const pool of [fronts, borders]) {
      let selected = null;
      for (const target of pool) {
        const flow = transport(target);
        if (!flow.best) continue;
        const score = flow.best.gain + Math.min(flow.rear, 200) * 0.1;
        if (!selected || score > selected.score) selected = { target, score, since: turn, until: turn + 12 };
      }
      if (selected) { memory.rally = selected; break; }
    }
  }
  function forecast(plan, flow) {
    if (!plan) return null;
    const interval = flow.ratio >= 0.35 || flow.best?.gain >= 20 ? 2 : 4;
    const eta = Math.min(militaryOnly ? 16 : Infinity, (flow.best?.distance || 0) * interval + 1);
    let defense = 0, naturalGrowth = 0, reinforcement = 0, observedGain = 0, enemyTarget = null;
    for (const target of neighbors[plan.target].filter(i => enemy(i) &&
        (!params.allowedOwners || params.allowedOwners.has(owners[i])))) {
      const d = field([target], j => enemy(j) && owners[j] === owners[target]);
      let support = 0;
      // 只计两步内的有限局部后援；远端敌军不进入本轮预算。
      for (const j of threats) if (j !== target && enemy(j) && d[j] > 0 && d[j] <= (militaryOnly ? Math.min(2, eta) : eta))
        support += Math.max(0, count(j) + growth(j, turn, eta - d[j]) - d[j] - 1);
      const cap = militaryOnly ? Math.ceil(count(target) * 0.05) : Infinity;
      support = Math.min(cap, support);
      const g = growth(target, turn, eta), trend = Math.min(cap, (rates.get(target) || 0) * eta);
      if (count(target) + g + Math.max(support, trend) >= defense + naturalGrowth + reinforcement) {
        enemyTarget = target;
        defense = count(target); naturalGrowth = g; reinforcement = Math.max(support, trend); observedGain = trend;
      }
    }
    const margin = militaryOnly ? Math.max(2, Math.ceil(defense * 0.1)) : 2;
    const required = defense + naturalGrowth + reinforcement + margin;
    return { eta, enemyTarget, defense, naturalGrowth, reinforcement, observedGain, margin, required,
      needed: Math.max(0, required - count(plan.target)) };
  }
  const rallyFlow = memory.rally ? transport(memory.rally.target) : null;
  const prediction = forecast(memory.rally, rallyFlow);
  // 专门的前线缺口通道：不要求总军力领先、不要求看见敌皇冠，
  // 不受普通经济/隔tick配额影响。只有当前确实缺兵且存在有效运输才抢占微操。
  if (militaryOnly) {
    if (!memory.rally || !fronts.includes(memory.rally.target) || !prediction ||
        (!memory.batch && prediction.needed <= 0)) { memory.batch = null; return null; }
    const job = rallyFlow?.best;
    if (!job) { memory.batch = null; memory.rally = null; return null; }
    if (!memory.batch && params.allowStartBatch === false) return null;
    if (!memory.batch) memory.batch = { target: memory.rally.target, required: prediction.required,
      since: turn, enemy: prediction.enemyTarget, enemyCode: grid[prediction.enemyTarget], forecast: prediction };
    const b = memory.batch;
    const batch = { target: b.target, required: b.required, active: true };
    memory.activeBatch = batch;
    const batchForecast = { ...b.forecast, needed: Math.max(0, b.required - count(b.target)) };
    return {kind:'attack', x:Math.floor(job.from/m), y:job.from%m,
      dx:Math.floor(job.to/m), dy:job.to%m, mode:job.mode, reason:{code:'frontline-supply',
        phase:'reinforce', target:memory.rally.target, amount:job.amount, forecast:batchForecast, batch: { ...batch },
        distanceBefore:job.distance, distanceAfter:job.distance-1}};
  }
  // 军事预算最多占安全后方的一半，为产能留出份额；不无限扣除敌援军预测。
  function budget(target) {
    const d = field([target], own);
    const rear = lands.reduce((sum, i) => sum + (d[i] >= 0 && safe(i) ?
      Math.max(0, count(i) - reserveAt(i) - d[i]) : 0), 0);
    return rear - Math.min(prediction?.needed || 0, rear * 0.5);
  }
  const economicValid = plan => plan && safe(plan.target) && economicSite(plan.target) && crowns < targetCrowns &&
    (grid[plan.target] === me + 50 || (grid[plan.target] === me && cities === 0 && crowns + cities < targetCrowns));
  if (!economicValid(memory.economy)) memory.economy = null;
  if (!memory.economy && crowns < targetCrowns) {
    const candidates = lands.filter(i => safe(i) && economicSite(i) &&
      (grid[i] === me + 50 || (grid[i] === me && cities === 0 && crowns + cities < targetCrowns)));
    // 相邻产能集群降低筹资路程，但不为集群牺牲安全条件。
    const clusterScore = i => clusterValue(state,i) + count(i) + neighbors[i].reduce((s,j) => s + (own(j) && (grid[j] === me+100 || grid[j] === me+50) ? 12 : 0), 0);
    candidates.sort((a, b) => (grid[b] === me + 50) - (grid[a] === me + 50) || clusterScore(b) - clusterScore(a) || a - b);
    for (const target of candidates) {
      if (budget(target) < (grid[target] === me + 50 ? 50 : 100) &&
          !(grid[target] === me + 50 && turn >= 100 && lands.length >= 20 && crowns === 1)) continue;
      memory.economy = { target, since: turn, funded: new Set([target]) };
      break;
    }
  }
  const economy = memory.economy;
  // 建造和筹资共享配额；升级不用等待旧 building 再次给出建议。
  const economicSlot = !memory.rally || turn - memory.lastEconomy >= 4;
  if (economicSlot && turn > memory.lastBuild) {
    // 不信任外部 build 提示，也不凭物流预算自行放行；实际建造入口完全共用。
    const approved = chooseBuild(state, move, p);
    if (approved) {
      const i = approved.x * m + approved.y;
      const risk = architecturePlan.assess(i);
      memory.lastBuild = turn; memory.lastEconomy = turn;
      return { ...approved, kind: 'build', reason: { code: 'logistics-invest',
        phase: approved.op === 'c' ? 'upgrade' : risk.crownSafe ? 'foundation' : 'anchor-tower',
        target: i, reserve: risk.reserve, detail: approved.reason } };
    }
  }
  let plan = memory.rally, phase = 'reinforce';
  // 筹资每四tick最多取得一次额外行动，不能长期吞掉真实前线运输。
  if (economy && economicSlot) {
    const risk = architecturePlan.assess(economy.target);
    const goal = (grid[economy.target] === me + 50 ? 50 : 100) + risk.reserve;
    if (count(economy.target) < goal) { plan = economy; phase = 'fund'; }
  }
  if (!plan) return null;
  if (phase === 'reinforce' && prediction && prediction.defense > 0 && prediction.needed === 0) return null;
  const flow = transport(plan.target, phase === 'fund'), job = flow.best;
  if (!job) return null;
  const elapsed = turn - memory.lastTransport;
  // 高闲置比例/高收益有隔tick配额，小规模后方也会在等待后获得配额。
  const interval = flow.ratio >= 0.35 || job.gain >= 20 ? 2 : 4;
  if (elapsed <= 0 || (move && (elapsed < interval || (job.amount < 3 && elapsed < 8)))) return null;
  memory.edges.set(`${job.from}:${job.to}`, turn);
  memory.lastTransport = turn;
  if (phase === 'fund') { memory.lastEconomy = turn; economy.funded.add(job.to); }
  return { kind: 'attack', x: Math.floor(job.from / m), y: job.from % m,
    dx: Math.floor(job.to / m), dy: job.to % m, half: job.mode === 1, mode: job.mode ?? 0,
    reason: { code: 'logistics-transport', phase, target: plan.target, planSince: plan.since,
      lockedUntil: null, forecast: prediction, amount: job.amount, distanceBefore: job.distance,
      distanceAfter: job.distance - 1, rearAvailable: flow.rear, rearRatio: flow.ratio,
      gain: job.gain, quotaInterval: interval, waited: Number.isFinite(elapsed) ? elapsed : null } };
}
module.exports = { chooseLogistics, getSupplyBatch };
