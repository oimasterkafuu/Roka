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
  if (!ctx) return { assess: () => Object.freeze({ crownSafe: false, foundationSafe: false, towerSafe: false, tactical: false, complete: false, reserve: Infinity, incoming: Infinity, distance: 0, funding: 0, anchorGroups: 0 }), neighbors: [], own: () => false, count: () => 0, unknown: () => false, owners: [], params: p, race: null };
  const { size, me, owners, grid, army, neighbors, own, count, known } = ctx;
  const race = ctx.race;
  const cache = new Map();
  const rejected = Object.freeze({ crownSafe: false, foundationSafe: false, towerSafe: false,
    tactical: false, complete: false, reserve: Infinity, incoming: Infinity, distance: 0, funding: 0, anchorGroups: 0 });

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
  return { assess, neighbors, own, count, unknown: (i) => !known[i], owners, params: p, race, context: ctx };
}
module.exports = { architecture };
