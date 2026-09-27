'use strict';
const { createContext } = require('./threat.cjs');
const { resolveParams } = require('./params.cjs');

// 建造选址评估：某格现在投 50 兵（或升级）值不值、守不守得住。
// 与旧版差别：威胁按到达时间衰减（不再把 8 跳外的大军当贴脸），
// 经济落后时自动放宽安全门槛，避免「因为怕死所以永远不建」。
// 同回合缓存：一次决策里 policy/logistics/building 会反复问同一局面，
// 缓存的是「本回合的函数值」，下一回合 turn 变化后必然重算，不构成跨回合计划。
const turnCache = new WeakMap();
function architecture(state, params = {}) {
  const turn = Number.isFinite(state?.turn) ? state.turn : -1;
  const cached = turnCache.get(state);
  if (cached && cached.turn === turn) return cached.instance;
  const instance = buildArchitecture(state, params);
  turnCache.set(state, { turn, instance });
  return instance;
}
function buildArchitecture(state, params = {}) {
  const p = resolveParams(params);
  const ctx = createContext(state, params);
  if (!ctx) return { assess: () => Object.freeze({ crownSafe: false, foundationSafe: false, towerSafe: false, tactical: false, complete: false, reserve: Infinity, incoming: Infinity, distance: 0, funding: 0, anchorGroups: 0 }), neighbors: [], own: () => false, count: () => 0, unknown: () => false, owners: [], params: p, race: null,
    buildFund: () => 51, locationRisk: () => 0, frontStable: () => false };
  const { size, me, owners, grid, army, neighbors, own, count, known } = ctx;
  const race = ctx.race;
  const cache = new Map();
  const rejected = Object.freeze({ crownSafe: false, foundationSafe: false, towerSafe: false,
    tactical: false, complete: false, reserve: Infinity, incoming: Infinity, distance: 0, funding: 0, anchorGroups: 0 });

  // ── 建造位置分档（用户 2026-09-27 硬方针 + 2026-09-28 回调）───────────────
  // 位置判断不按出生点（迁都很常见，出生点早就不是参照系），按现场因素：
  // 「该格距最近敌方压力的跳数」与「局部威胁场」综合评估这是大后方还是前线。
  // locationRisk ∈ [0,1]：0 = 大后方，1 = 前线。威胁极大（≥buildDesperateThreat，
  // 敌人已打穿到腹地）时回落 0——退无可退，按大后方阈值尽快建造。
  // 开局提速（earlyBuildTurns 内）：距离档整体后移（前后界按 earlyDistScale
  // 收缩）——开局的「中间档」不抬高到拖慢建造，保证首座建造/调兵不慢一拍。
  const early = ctx.turn < p.earlyBuildTurns;
  const distLo = early ? Math.max(1, Math.round(p.buildFrontDist * p.earlyDistScale)) : p.buildFrontDist;
  const distHi = Math.max(distLo + 1, early ? Math.round(p.buildRearDist * p.earlyDistScale) : p.buildRearDist);
  const riskCache = new Map();
  function locationRisk(i) {
    if (riskCache.has(i)) return riskCache.get(i);
    const dist = ctx.enemyDistance[i];
    const distRisk = dist < 0 ? 0 : dist <= distLo ? 1 : dist >= distHi ? 0 : (distHi - dist) / (distHi - distLo);
    const spot = ctx.pressure(i, { radius: p.buildThreatRadius, decay: p.buildPressureDecay, ticks: p.buildThreatRadius });
    const risk = spot.total >= p.buildDesperateThreat ? 0
      : Math.max(distRisk, Math.min(1, spot.total / Math.max(1, p.buildFundThreat)));
    riskCache.set(i, risk);
    return risk;
  }
  // 建造资金阈值分档：大后方 rearBuildFund（约 100，一次集满可连续建造两次），
  // 前线 frontBuildFund（约 150，风险高留足余量），中间按危险度线性过渡。
  // 下限 51 是引擎硬门槛（建造花 50 且至少留 1 兵）。开局提速：前线档按
  // earlyFrontFundScale 下调（默认 100）——早期前线建造也要「用得上、用得早」。
  // 四舍五入后与 rearBuildFund 相等时直接返回，避免威胁场把 risk 推到 1 后
  // 按 max(51, round(100.3)) 抬到 101。
  function buildFund(i) {
    const front = early ? Math.round(p.frontBuildFund * p.earlyFrontFundScale) : p.frontBuildFund;
    if (front <= p.rearBuildFund) return p.rearBuildFund;
    return Math.max(51, Math.round(p.rearBuildFund + (front - p.rearBuildFund) * locationRisk(i)));
  }
  // 前线稳定格：前线区域内（贴脸不算、纯后方不算）但威胁场低、我方局部兵力
  // 占优——「相对稳定下来」的前线位置，应更积极地建造（前线迁都：兵源/产能前移）。
  function frontStable(i) {
    if (!own(i)) return false;
    const dist = ctx.enemyDistance[i];
    if (dist < 2 || dist >= p.buildRearDist) return false;
    const spot = ctx.pressure(i, { radius: p.buildThreatRadius, decay: p.buildPressureDecay, ticks: p.buildThreatRadius });
    if (spot.total > p.frontStableThreat) return false;
    return ctx.support(i, { radius: 2 }).total >= spot.total * p.frontStableMargin;
  }

  function assess(i) {
    if (cache.has(i)) return cache.get(i);
    if (!own(i) || (grid[i] !== me && grid[i] !== me + 50)) return rejected;
    // 敌军按到达时间衰减：5 跳外的一万兵不再是「下 tick 就贴脸」。
    const spot = ctx.pressure(i, { radius: p.buildThreatRadius, decay: p.buildPressureDecay, ticks: p.buildThreatRadius });
    const nearest = ctx.enemyDistance[i];
    let uncertain = false;
    if (nearest >= 0 && nearest <= p.buildThreatRadius) {
      const seen = new Set([i]);
      let layer = [i];
      for (let d = 0; d <= p.buildThreatRadius && layer.length; d++) {
        const next = [];
        for (const u of layer) for (const v of neighbors[u]) {
          if (seen.has(v) || !ctx.passable(v)) continue;
          seen.add(v);
          if (!known[v]) { uncertain = true; break; }
          if (d < p.buildThreatRadius) next.push(v);
        }
        if (uncertain) break;
        layer = next;
      }
    }
    const defending = race.behind ? p.raceAggression : 1;
    const safety = Math.max(2, Math.ceil(p.buildSafety / defending));
    const weight = p.threatWeight / defending;
    const reserve = safety + spot.total * weight;
    const afterUpgrade = count(i) - 50;
    // 触发线 = 引擎真实门槛 + 留 1 兵：建造/升级花费 50（reference/src/game-engine.ts
    // chkBuildCity/chkUpgradeCrown 要求执行时兵力 >= 50），51 兵即可开工，花完至少留 1 兵，
    // 新建的 0 兵建筑下一 tick 会被顺手拆掉。**不再叠加 reserve / foundationPremium 等
    // 策略余量**——那会让 52 兵的格子继续等增援，白耽误一个回合。
    const affordable = count(i) >= 51;
    // 防守性检查（保留，不是经济余量）：建完只剩 afterUpgrade 兵，若贴脸敌军本 tick
    // 就能反超夺回，这 50 兵等于白送，不建。远处衰减威胁只进评分、不做门槛。
    const crownSafe = !uncertain && affordable && afterUpgrade >= spot.adj;
    // 新建与升级同一条触发线：满足即建，不再要求 50+premium+reserve 的额外余量。
    const foundationSafe = crownSafe;
    // 减损塔：只有切断候选格会分裂出第二个带建筑的连通块时才有独立价值。
    const seen = new Uint8Array(size); seen[i] = 1;
    let anchorGroups = 0;
    for (const start of neighbors[i]) {
      if (seen[start] || !ctx.friendly(start)) continue;
      const q = [start]; seen[start] = 1; let anchors = 0;
      for (let h = 0; h < q.length; h++) {
        const k = q[h];
        if (ctx.friendly(k) && grid[k] >= 50 && grid[k] < 150) anchors++;
        for (const j of neighbors[k]) if (!seen[j] && ctx.friendly(j)) { seen[j] = 1; q.push(j); }
      }
      if (anchors) anchorGroups++;
    }
    const tactical = anchorGroups >= 2 && (nearest < 0 || nearest <= Math.max(3, p.enemyDistance + 1));
    const towerSafe = tactical && count(i) - 50 >= safety + spot.adj * weight && !ctx.unknownNear(i);
    const result = { crownSafe, foundationSafe, towerSafe, tactical, complete: true,
      reserve, incoming: spot.total, distance: nearest < 0 ? 99 : nearest, funding: count(i), anchorGroups };
    cache.set(i, result);
    return result;
  }
  return { assess, neighbors, own, count, unknown: (i) => !known[i], owners, params: p, race, context: ctx,
    buildFund, locationRisk, frontStable };
}
module.exports = { architecture };
