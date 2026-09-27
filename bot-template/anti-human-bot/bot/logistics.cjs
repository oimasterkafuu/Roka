'use strict';
const { resolveParams } = require('./params.cjs');
const { architecture } = require('./architecture.cjs');
const { chooseBuild, urgent, crownTarget, clusterValue } = require('./building.cjs');
const { createContext } = require('./threat.cjs');

// 本模块**不保存任何跨回合计划**：每次调用都按当前局面重新算
// 「哪个格子该补兵、补到多少、这一 tick 从哪搬到哪」。
// 唯一的缓存是同一 tick 内 getSupplyBatch 需要读取的计算结果（当前回合的函数值）。
const currentBatch = new WeakMap();
// 跨回合的只有「防抖/滞回」（用户 2026-09-27 硬性方针，不是复活旧版计划状态）：
//   - 工地/集结点滞回：旧目标仍有效时继续用它，除非挑战者明显更好——每 tick 重选
//     会让运输方向反复横跳、同一堆兵来回倒（RMtDIbE7rDS6 t107–t302 工地目标连跳）；
//   - 僵持放弃：持续向同一集结点喂兵但缺口长期不收敛 = 无目的僵持堆兵，
//     停止输送一段时间，让兵力转投别的方向（找弱点）。
const planning = new WeakMap();
function planFor(state, turn, me) {
  let mem = planning.get(state);
  if (!mem || turn < mem.turn || mem.me !== me) {
    mem = { turn, me, site: null, rally: null, feed: null, abandoned: new Map() };
    planning.set(state, mem);
  }
  mem.turn = turn;
  return mem;
}
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
  const macro = planFor(state, turn, me);
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

  /** 反向有向 BFS：只把兵往目标方向搬，天然不会来回倒兵。
   *  need 是目标还缺多少兵：低于 minTransport 且填不满缺口的「小勺」运输直接跳过——
   *  蚂蚁搬家式分兵永远集不齐数量（实测 57% 的补给运输不足 20 兵）。 */
  function transport(target, funding = false, need = Infinity) {
    // 关键：把「当前经济工地」与缺口档位纳入缓存键，否则同一 tick 内不同模式会读到彼此的结果。
    const memoKey = `${target}:${funding ? 1 : 0}:${economySiteTarget}:${Number.isFinite(need) ? Math.ceil(need) : 'inf'}`;
    if (memo.transport.has(memoKey)) return memo.transport.get(memoKey);
    const result = computeTransport(target, funding, need);
    memo.transport.set(memoKey, result);
    return result;
  }
  function computeTransport(target, funding = false, need = Infinity) {
    const d = new Int32Array(size).fill(-1), queue = [target]; d[target] = 0;
    for (let h = 0; h < queue.length; h++) for (const j of neighbors[queue[h]]) {
      if (d[j] >= 0 || !own(j) || params.blockedEdges?.has(`${j}:${queue[h]}`)) continue;
      d[j] = d[queue[h]] + 1; queue.push(j);
    }
    let rear = 0;
    const jobs = [];
    for (const from of lands) {
      if (d[from] <= 0 || neighbors[from].some(enemy)) continue;
      // 工地只保留「开工额度」（分档筹资目标，到位即建），超出的存量照常供军事运输——
      // 整格豁免曾让 187 兵的大堆自证为工地后趴窝 35 回合（uzsTrD 复盘根因）。
      const earmark = !funding && economySiteTarget === from ? economyGoal(from) : 0;
      if (count(from) - 1 <= earmark) continue;
      rear += Math.max(0, count(from) - 1 - earmark);
      for (const to of neighbors[from]) {
        if (!own(to) || d[to] !== d[from] - 1 || params.blockedEdges?.has(`${from}:${to}`)) continue;
        let amount = pushed(from, to), mode = 0;
        if (amount <= 0) continue;
        if (earmark) {
          amount = Math.min(amount, count(from) - earmark);
          if (amount <= 0) continue;
        }
        // 小勺过滤：低于绝对下限且填不满缺口的运输不执行（缺口本身就这么大时照常收尾）。
        // 大缺口下的相对劣势不硬拦（那会把「全部家当只有 100 兵」也饿死），而是交给
        // 下面的 gain 竞争与 need 加权的 local 门槛——有大股可运时小股自然输。
        if (amount < p.minTransport && amount < need) continue;
        if (grid[from] === me + 100) {
          const safeHome = safe(from) && from !== economySiteTarget;
          const keep = safeHome
            ? Math.max(4, Math.round(safety / 2))
            : Math.max(safety, pressureAt(from) + 1);
          if (count(from) - amount < keep && !safeHome) { amount = Math.floor(amount / 2); mode = 1; }
          // 安全主城不再减半外运：减半会让兵堆按 1/2、1/4、1/8 几何级变成无数小勺
          //（实测 386 次减半运输中 299 次不足 20 兵），违反「一律全兵推进」方针。
          // safe() 已保证敌军距离足够远，留 1 兵可接受；逼近的威胁由 defense 分支反应。
          if (amount <= 0 || (!safeHome && count(from) - amount < keep)) continue;
          if (amount < p.minTransport && amount < need) continue;
        }
        jobs.push({ from, to, amount, distance: d[from], mode });
      }
    }
    for (const job of jobs) {
      job.gain = job.amount / Math.max(1, job.distance);
      // 「近源优先」只在运输量对缺口有意义时成立：缺口大时近处小股不能抢占
      // 远处大堆——近源是效率偏好，不是让 10 兵小股反复插队的理由。
      job.local = job.distance <= 3 && job.amount >= Math.max(p.minTransport, need * 0.25);
    }
    let best = null;
    if (need >= p.bulkPullMin) {
      // ── 集兵树形化（用户 2026-09-27 硬方针）──────────────────────────────
      // 大缺口需要多源协同时，调度按树形汇聚：最远的子树先动（深度降序，平级比
      // 运量），逐级向目标汇聚——远端与近端同时在路上，避免每次一条链式长跑、
      // 单格长途跋涉。优先池只收「整批大堆」（≥bulkPullMin，深后方一次性拉出）
      // 与「占缺口一定份额的深源」（≥supplyTreeDepth 跳），远端小勺不白跑；
      // 没有合格深源/大堆时退回全体候选。
      const deep = jobs.filter((j) => j.amount >= p.bulkPullMin ||
        (j.distance >= p.supplyTreeDepth && j.amount >= Math.max(p.minTransport, need * 0.25)));
      const pool = deep.length ? deep : jobs;
      for (const job of pool)
        if (!best || job.distance > best.distance ||
          (job.distance === best.distance && job.amount > best.amount)) best = job;
    } else {
      for (const job of jobs)
        if (!best || (!funding && job.local && !best.local) ||
          ((funding || job.local === best.local) && job.gain > best.gain)) best = job;
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
    // 前线迁都（用户 2026-09-27 硬方针）：除大后方安全格外，「稳定前线」格
    // （威胁场低、我方局部兵力占优，见 architecture.frontStable）也可作工地——
    // 位置相对稳定下来后就该更积极地建造，把主要兵源、新皇冠聚集到前线。
    // 位置判断不按出生点，按当前敌我分布（frontStable 用的是现场威胁场/敌距）。
    const candidates = lands.filter((i) => (safe(i) || architecturePlan.frontStable(i)) && economicSite(i) &&
      (grid[i] === me + 50 || (grid[i] === me && crowns + cities < targetCrowns)));
    // 驻军只按封顶 60 计入：选址看的是位置，不是「这格已经堆了多少兵」——
    // 全额计入会让大兵堆自证为工地，再把整格 earmark 成禁地（uzsTrD 复盘根因）。
    // 迁都加成：稳定前线格按靠前程度加分（敌距越小加分越多），产能主动前移。
    const clusterScore = (i) => clusterValue(state, i) + Math.min(count(i), 60) +
      neighbors[i].reduce((s, j) => s + (own(j) && (grid[j] === me + 100 || grid[j] === me + 50) ? 12 : 0), 0) +
      (architecturePlan.frontStable(i) && !safe(i)
        ? p.frontBaseBonus + Math.max(0, p.buildRearDist - ctx.enemyDistance[i]) * 2 : 0);
    candidates.sort((a, b) => (grid[b] === me + 50) - (grid[a] === me + 50) || clusterScore(b) - clusterScore(a) || a - b);
    let chosen = candidates.length ? candidates[0] : -1;
    // 滞回（用户硬性方针：防抖/目标锁定）：上一个工地仍合法时继续往它送，
    // 除非挑战者是「指挥所 vs 平地」的类型跃迁或评分明显更高——每 tick 重选
    // 会让同一堆兵在不同候选工地之间来回倒（RMtDIbE7rDS6 t107–t302 目标连跳）。
    const prev = macro.site;
    if (prev && prev.i !== chosen && candidates.includes(prev.i)) {
      const typeJump = chosen >= 0 && grid[chosen] === me + 50 && grid[prev.i] !== me + 50;
      if (!typeJump && (chosen < 0 || clusterScore(prev.i) * p.siteHysteresis >= clusterScore(chosen)))
        chosen = prev.i;
    }
    macro.site = chosen >= 0 ? { i: chosen } : null;
    memo.economySite = chosen;
    return memo.economySite;
  }
  function economyGoal(target) {
    // 筹资目标 = 建造触发线分档（用户 2026-09-27「一次性集满再造」硬方针）：
    // 平地工地按位置综合研判分档（architecture.buildFund：大后方约 100、
    // 前线约 150、中间按危险度过渡、被打穿的绝境回落 100），一次集满再开工，
    // 避免「花 50 集一次、再花 50 又集一次」的来回折腾；已是指挥所的升级工地
    // 仍按 51（钱已投在工地上，到位即升）。
    // 工地的选址安全由 economicSite/assess 的贴脸防守检查负责，与筹资目标无关。
    return grid[target] === me + 50 ? 51 : Math.max(51, architecturePlan.buildFund(target));
  }
  function economyAction() {
    const buildNow = chooseBuild(state, null, p);
    if (buildNow) return { ...buildNow, kind: 'build',
      reason: { code: 'logistics-invest', phase: buildNow.op === 'c' ? 'upgrade' : 'foundation', detail: buildNow.reason } };
    if (economySiteTarget < 0) return null;
    const goal = economyGoal(economySiteTarget);
    if (count(economySiteTarget) >= goal) return null;
    const flow = transport(economySiteTarget, true, goal - count(economySiteTarget)), job = flow.best;
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
      const scores = new Map();
      for (const { target } of ranked) {
        // 僵持放弃的集结点在冷静期内不再入选：持续喂兵却没推进 = 无目的堆兵。
        if ((macro.abandoned.get(target) ?? -1) >= turn) continue;
        const flow = transport(target, false, forecast(target)?.needed ?? Infinity);
        if (!flow.best) continue;
        const score = flow.best.gain + Math.min(flow.rear, 200) * 0.1;
        scores.set(target, score);
        if (score > bestScore) { bestScore = score; selected = target; }
      }
      // 滞回：上一个集结点仍可打时继续喂它，除非挑战者明显更好——
      // 集结点每 tick 跳变等于把兵在几个前线之间来回搬，永远集不齐。
      const prev = macro.rally;
      if (prev && scores.has(prev.i) && prev.i !== selected &&
          scores.get(prev.i) * p.siteHysteresis >= bestScore) {
        selected = prev.i;
        bestScore = scores.get(prev.i);
      }
      if (selected >= 0) {
        macro.rally = { i: selected, score: bestScore };
        memo.rally = selected;
        return selected;
      }
    }
    macro.rally = null;
    memo.rally = -1;
    return -1;
  }
  // 僵持检测（用户硬性方针：禁止无目的僵持堆兵）：持续向同一集结点喂兵，
  // 但缺口在 rallyStallTicks 内没有明显收敛（敌增长吃掉我们的输送）→
  // 放弃该集结点一段时间，兵力转投别的方向（找弱点），不再蚂蚁搬家。
  function trackFeed(target, needed) {
    const feed = macro.feed;
    if (!feed || feed.target !== target || needed <= feed.initial * 0.7) {
      macro.feed = { target, initial: needed, last: needed, since: turn };
      return false;
    }
    if (needed < feed.last) { feed.last = needed; feed.since = turn; return false; }
    if (turn - feed.since >= p.rallyStallTicks) {
      macro.abandoned.set(target, turn + p.rallyAbandonTicks);
      macro.feed = null;
      if (macro.rally?.i === target) macro.rally = null;
      return true;
    }
    return false;
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
    // 僵持放弃：本 tick 起停止向该集结点输送（下 tick 起它会被排除出候选）。
    if (trackFeed(rally, prediction.needed)) return null;
    const flow = transport(rally, false, prediction.needed), job = flow.best;
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
  let need = Infinity;
  if (phase === 'reinforce') {
    const prediction = forecast(plan);
    if (!prediction || prediction.needed <= 0) return null;
    if (trackFeed(plan, prediction.needed)) return null;
    need = prediction.needed;
  } else {
    need = Math.max(0, economyGoal(plan) - count(plan));
  }
  const flow = transport(plan, phase === 'fund', need), job = flow.best;
  if (!job) return null;
  return { kind: 'attack', x: Math.floor(job.from / m), y: job.from % m,
    dx: Math.floor(job.to / m), dy: job.to % m, half: job.mode === 1, mode: job.mode ?? 0,
    reason: { code: phase === 'fund' ? 'economy-fund' : 'logistics-transport', phase, target: plan,
      amount: job.amount, distanceBefore: job.distance, distanceAfter: job.distance - 1,
      rearAvailable: flow.rear, rearRatio: flow.ratio, gain: job.gain, raceDeficit: race.deficit } };
}
module.exports = { chooseLogistics, getSupplyBatch };
