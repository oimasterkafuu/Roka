'use strict';
const { resolveParams } = require('./params.cjs');
const { architecture } = require('./architecture.cjs');
const { chooseBuild, urgent, crownTarget, clusterValue } = require('./building.cjs');
const { createContext } = require('./threat.cjs');

// 本模块**不保存任何跨回合计划**：每次调用都按当前局面重新算
// 「哪个格子该补兵、补到多少、这一 tick 从哪搬到哪」。
// 唯一的缓存是同一 tick 内 getSupplyBatch 需要读取的计算结果（当前回合的函数值）。
const currentBatch = new WeakMap();
// 同一 tick 内 policy 会调用本模块 2–3 次（军用/经济/常规），
// 这里缓存「本回合算出来的函数值」，换回合即失效并整份重算。
const turnMemo = new WeakMap();
// 缓存键必须覆盖所有会影响结果的入参：模式、FFA 允许目标集合、禁行边集合。
// 同一 tick 内 policy 会用不同参数多次调用，键不同就各算一份，绝不互相污染。
function memoFor(state, turn, key) {
  let all = turnMemo.get(state);
  if (!all || all.turn !== turn) { all = { turn, entries: new Map() }; turnMemo.set(state, all); }
  let memo = all.entries.get(key);
  if (!memo) {
    memo = { transport: new Map(), forecast: new Map(), rally: null, economySite: null };
    all.entries.set(key, memo);
  }
  return memo;
}

// 只公开本 tick 重新计算出来的补给需求；没有真实运输就是 null。
function getSupplyBatch(state) {
  const record = state && currentBatch.get(state);
  if (!record || !Number.isFinite(state.turn) || record.turn !== state.turn) return null;
  return record.batch ? { ...record.batch } : null;
}

function chooseLogistics(state, move, build, params = {}) {
  if (!state || state.ended || state.dead) return null;
  const { n, m, grid, army, playerId: me } = state;
  const size = n * m;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n <= 0 || m <= 0 ||
      !Number.isInteger(me) || me < 1 || me > 49 || !grid || !army ||
      grid.length !== size || army.length !== size) return null;
  const turn = Number.isFinite(state.turn) ? state.turn : 0;
  currentBatch.set(state, { turn, batch: null });
  const memoKey = '';   // 占位，真正的键在模式判定之后构建
  let memo = null;
  const ctx = createContext(state, params);
  if (!ctx) return null;
  const p = resolveParams(params);
  const militaryOnly = params.militaryOnly === true;
  const economyOnly = params.economyOnly === true;
  // 缓存键必须覆盖所有会影响结果的入参：模式、FFA 允许目标集合、禁行边集合。
  // 同一 tick 内 policy 会用不同参数多次调用，键不同就各算一份，绝不互相污染。
  memo = memoFor(state, turn, [
    militaryOnly ? 'm' : '', economyOnly ? 'e' : '',
    params.allowedOwners ? [...params.allowedOwners].sort((a, b) => a - b).join(',') : '*',
    params.blockedEdges ? params.blockedEdges.size : 0,
  ].join('|'));
  if (!militaryOnly && !economyOnly && urgent(state, move)) return null;
  const architecturePlan = architecture(state, p);
  const { owners, count, own, hostile: enemy, allied, neighbors } = ctx;
  const unknown = (i) => !ctx.knownAt(i);
  const lands = [], fronts = [], borders = [];
  let crowns = 0, cities = 0, available = 0;
  for (let i = 0; i < size; i++) {
    if (!own(i)) continue;
    lands.push(i);
    if (grid[i] === me + 100) crowns++;
    if (grid[i] === me + 50) cities++;
    available += Math.max(0, count(i) - 1);
    if (neighbors[i].some((j) => enemy(j) && (!params.allowedOwners || params.allowedOwners.has(owners[j])))) fronts.push(i);
    if (neighbors[i].some((j) => !allied(owners[j], me) && !owners[j] && grid[j] !== 201 && grid[j] !== 203)) borders.push(i);
  }
  if (!lands.length) return null;
  const race = ctx.race;
  const targetCrowns = crownTarget(lands.length, turn, p, state);

  function pushed(from, to) {
    let reserve = 0;
    for (const k of neighbors[from]) {
      if (k === to || grid[k] === 201 || grid[k] === 203 || allied(owners[k], me)) continue;
      reserve += unknown(k) ? 2 : count(k) - 1;
    }
    return Math.min(count(from) - 1, Math.max(0, count(from) - reserve - 1));
  }
  const pressureAt = (i) => ctx.pressure(i, { radius: 1 }).adj;
  // enemyDistance < 0 表示这片区域根本走不到敌人（最安全），不能当成“不安全”。
  const safe = (i) => own(i) && (ctx.enemyDistance[i] < 0 || ctx.enemyDistance[i] > Math.max(3, p.enemyDistance));
  const safety = Math.max(2, Math.ceil(p.buildSafety));

  /** 反向有向 BFS：只把兵往目标方向搬，天然不会来回倒兵。 */
  function transport(target, funding = false) {
    // 关键：把「当前经济工地」纳入缓存键，否则同一 tick 内不同模式会读到彼此的结果。
    const memoKey = `${target}:${funding ? 1 : 0}:${economySiteTarget}`;
    if (memo.transport.has(memoKey)) return memo.transport.get(memoKey);
    const result = computeTransport(target, funding);
    memo.transport.set(memoKey, result);
    return result;
  }
  function computeTransport(target, funding = false) {
    const d = new Int32Array(size).fill(-1), queue = [target]; d[target] = 0;
    for (let h = 0; h < queue.length; h++) for (const j of neighbors[queue[h]]) {
      if (d[j] >= 0 || !own(j) || params.blockedEdges?.has(`${j}:${queue[h]}`)) continue;
      d[j] = d[queue[h]] + 1; queue.push(j);
    }
    let best = null, rear = 0;
    for (const from of lands) {
      if (d[from] <= 0 || neighbors[from].some(enemy)) continue;
      if (!funding && economySiteTarget === from) continue;   // 工地自己不吃自己的存量
      rear += Math.max(0, count(from) - 1);
      for (const to of neighbors[from]) {
        if (!own(to) || d[to] !== d[from] - 1 || params.blockedEdges?.has(`${from}:${to}`)) continue;
        let amount = pushed(from, to), mode = 0;
        if (amount <= 0) continue;
        if (grid[from] === me + 100) {
          const keep = safe(from) && from !== economySiteTarget
            ? Math.max(4, Math.round(safety / 2))
            : Math.max(safety, pressureAt(from) + 1);
          if (count(from) - amount < keep) { amount = Math.floor(amount / 2); mode = 1; }
          if (amount <= 0 || count(from) - amount < keep) continue;
        }
        const gain = amount / Math.max(1, d[from]);
        const local = d[from] <= 3 && amount >= 5;
        if (!best || (!funding && local && !best.local) || ((funding || local === best.local) && gain > best.gain))
          best = { from, to, amount, gain, distance: d[from], local, mode };
      }
    }
    return { best, rear, ratio: rear / Math.max(1, available) };
  }

  // ── 经济工地：每 tick 重新挑一次（安全、可负担、离敌远） ────────────────
  // 工地的「可建成性」= 有足够资金就能安全开工：reserve 只由敌方威胁决定，与我方驻军无关，
  // 所以不需要为每个候选重建一次整张 architecture（那是 95% 的决策耗时）。
  const economicSite = (i) => {
    const risk = architecturePlan.assess(i);
    return Boolean(risk.complete) && Number.isFinite(risk.reserve);
  };
  let economySiteTarget = -1;
  function pickEconomySite() {
    if (memo.economySite !== null) return memo.economySite;
    if (crowns >= targetCrowns) { memo.economySite = -1; return -1; }
    const candidates = lands.filter((i) => safe(i) && economicSite(i) &&
      (grid[i] === me + 50 || (grid[i] === me && crowns + cities < targetCrowns)));
    const clusterScore = (i) => clusterValue(state, i) + count(i) +
      neighbors[i].reduce((s, j) => s + (own(j) && (grid[j] === me + 100 || grid[j] === me + 50) ? 12 : 0), 0);
    candidates.sort((a, b) => (grid[b] === me + 50) - (grid[a] === me + 50) || clusterScore(b) - clusterScore(a) || a - b);
    memo.economySite = candidates.length ? candidates[0] : -1;
    return memo.economySite;
  }
  function economyGoal(target) {
    const risk = architecturePlan.assess(target);
    const base = grid[target] === me + 50 ? 50 : 50 + (race.behind ? 0 : p.foundationPremium);
    return base + (Number.isFinite(risk.reserve) ? risk.reserve : safety);
  }
  function economyAction() {
    const buildNow = chooseBuild(state, null, p);
    if (buildNow) return { ...buildNow, kind: 'build',
      reason: { code: 'logistics-invest', phase: buildNow.op === 'c' ? 'upgrade' : 'foundation', detail: buildNow.reason } };
    if (economySiteTarget < 0) return null;
    const goal = economyGoal(economySiteTarget);
    if (count(economySiteTarget) >= goal) return null;
    const flow = transport(economySiteTarget, true), job = flow.best;
    if (!job) return null;
    return { kind: 'attack', x: Math.floor(job.from / m), y: job.from % m,
      dx: Math.floor(job.to / m), dy: job.to % m, half: job.mode === 1, mode: job.mode ?? 0,
      reason: { code: 'economy-fund', phase: 'fund', target: economySiteTarget, goal,
        amount: job.amount, distanceBefore: job.distance, distanceAfter: job.distance - 1,
        rearAvailable: flow.rear, raceDeficit: race.deficit } };
  }
  // 无论哪种模式，先把本 tick 的经济工地定下来（每 tick 重算，供运输缓存键与保护逻辑共用）。
  economySiteTarget = crowns < targetCrowns ? pickEconomySite() : -1;
  if (economyOnly) return economyAction();

  // ── 前线补给：每 tick 重新找集结点与「最弱可打邻格」的缺口 ──────────────
  // 先用 O(1) 启发式把候选压到常数个（附近兵多、贴近敌人、离我方腹地近），
  // 再对这几个候选做真正的运输 BFS——避免每个前线格都跑一次全图搜索。
  function pickRally() {
    if (memo.rally !== null) return memo.rally;
    for (const pool of [fronts, borders]) {
      if (!pool.length) continue;
      const ranked = pool.map((target) => {
        const near = ctx.support(target, { radius: 2 }).total;
        const foe = ctx.pressure(target, { radius: 1 }).adj;
        return { target, key: near + foe * 0.5 - (ctx.frontDistance[target] || 0) * 2 };
      }).sort((a, b) => b.key - a.key).slice(0, 8);
      let selected = -1, bestScore = -Infinity;
      for (const { target } of ranked) {
        const flow = transport(target);
        if (!flow.best) continue;
        const score = flow.best.gain + Math.min(flow.rear, 200) * 0.1;
        if (score > bestScore) { bestScore = score; selected = target; }
      }
      if (selected >= 0) { memo.rally = selected; return selected; }
    }
    memo.rally = -1;
    return -1;
  }
  function forecast(target) {
    if (memo.forecast.has(target)) return memo.forecast.get(target);
    let weakest = null;
    for (const i of neighbors[target]) {
      if (!enemy(i) || (params.allowedOwners && !params.allowedOwners.has(owners[i]))) continue;
      const local = ctx.support(i, { radius: 2, exclude: target });
      const total = count(i, 1) + Math.min(local.total * 0.35, count(i, 1) * 0.5);
      if (!weakest || total < weakest.total) weakest = { index: i, total };
    }
    if (!weakest) { memo.forecast.set(target, null); return null; }
    const margin = Math.min(40, Math.max(2, Math.ceil(weakest.total * 0.03)));
    const required = Math.ceil(weakest.total) + margin;
    const result = { enemyTarget: weakest.index, defense: Math.ceil(weakest.total), required, margin,
      needed: Math.max(0, required - count(target)) };
    memo.forecast.set(target, result);
    return result;
  }
  const rally = pickRally();
  if (militaryOnly) {
    if (rally < 0) return null;
    const prediction = forecast(rally);
    if (!prediction || prediction.needed <= 0) return null;
    const flow = transport(rally), job = flow.best;
    if (!job) return null;
    // 本 tick 的缺口（纯计算结果，不跨回合保存）
    currentBatch.set(state, { turn, batch: { target: rally, required: prediction.required, active: true } });
    const batch = { target: rally, required: prediction.required, active: true };
    return { kind: 'attack', x: Math.floor(job.from / m), y: job.from % m,
      dx: Math.floor(job.to / m), dy: job.to % m, mode: job.mode, reason: { code: 'frontline-supply',
        phase: 'reinforce', target: rally, amount: job.amount, batch,
        forecast: { ...prediction, eta: job.distance + 1 }, distanceBefore: job.distance,
        distanceAfter: job.distance - 1 } };
  }

  // ── 常规物流：先建设（资金到位就建）、再筹资、最后向前线/边界输送 ────────
  const buildNow = chooseBuild(state, move, p);
  if (buildNow) {
    const i = buildNow.x * m + buildNow.y;
    const risk = architecturePlan.assess(i);
    return { ...buildNow, kind: 'build', reason: { code: 'logistics-invest',
      phase: buildNow.op === 'c' ? 'upgrade' : risk.crownSafe ? 'foundation' : 'anchor-tower',
      target: i, reserve: risk.reserve, detail: buildNow.reason } };
  }
  let plan = rally, phase = 'reinforce';
  if (crowns < targetCrowns) {
    if (economySiteTarget >= 0) {
      const goal = economyGoal(economySiteTarget);
      if (count(economySiteTarget) < goal) { plan = economySiteTarget; phase = 'fund'; }
    }
  }
  if (plan < 0) return null;
  if (phase === 'reinforce') {
    const prediction = forecast(plan);
    if (!prediction || prediction.needed <= 0) return null;
  }
  const flow = transport(plan, phase === 'fund'), job = flow.best;
  if (!job) return null;
  return { kind: 'attack', x: Math.floor(job.from / m), y: job.from % m,
    dx: Math.floor(job.to / m), dy: job.to % m, half: job.mode === 1, mode: job.mode ?? 0,
    reason: { code: phase === 'fund' ? 'economy-fund' : 'logistics-transport', phase, target: plan,
      amount: job.amount, distanceBefore: job.distance, distanceAfter: job.distance - 1,
      rearAvailable: flow.rear, rearRatio: flow.ratio, gain: job.gain, raceDeficit: race.deficit } };
}
module.exports = { chooseLogistics, getSupplyBatch };
