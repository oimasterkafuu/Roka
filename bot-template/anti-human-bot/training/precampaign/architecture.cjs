'use strict';
const { resolveParams } = require('./params.cjs');

// 每次决策独立快照；不缓存可变 state。候选 BFS 共用硬预算，耗尽时拒绝投资。
function architecture(state, params = {}) {
  const p = resolveParams(params);
  const { n, m, grid, army, playerId: me } = state, size = n * m;
  const owner = v => v > 0 && v < 200 ? v % 50 : 0;
  const owners = Array.from(grid, owner);
  const team = state.teams instanceof Map ? state.teams.get(me) : 0;
  const allied = id => id === me || (id > 0 && team > 0 && state.teams.get(id) === team);
  const unknown = i => !!state.fog?.[i] || grid[i] === 202 || grid[i] === 203;
  const count = i => Number.isFinite(army[i]) ? Math.max(0, army[i]) : 0;
  const friendly = i => allied(owners[i]) && !unknown(i) && !state.isolated?.[i];
  const own = i => owners[i] === me && friendly(i);
  const anchor = i => friendly(i) && grid[i] >= 50 && grid[i] < 150;
  const neighbors = Array.from({ length: size }, (_, i) => {
    const a = [];
    if (i >= m) a.push(i - m);
    if (i % m) a.push(i - 1);
    if (i % m + 1 < m) a.push(i + 1);
    if (i + m < size) a.push(i + m);
    return a;
  });
  let budget = 200000;
  const cache = new Map();
  const rejected = Object.freeze({ crownSafe: false, foundationSafe: false, towerSafe: false,
    tactical: false, complete: false, reserve: Infinity, incoming: Infinity, distance: 0, funding: 0 });
  function field(start, allowed) {
    const d = new Int32Array(size).fill(-1), q = [start]; d[start] = 0;
    for (let h = 0; h < q.length; h++) {
      if (--budget < 0) return null;
      for (const j of neighbors[q[h]]) if (d[j] < 0 && allowed(j)) {
        d[j] = d[q[h]] + 1; q.push(j);
      }
    }
    return { d, q };
  }
  function assess(i) {
    if (cache.has(i)) return cache.get(i);
    let result = rejected;
    // 即使调整参数，也不允许把地形、雾或队友建筑当作自己的候选。
    if (!own(i) || (grid[i] !== me && grid[i] !== me + 50) || budget <= 0) return result;
    const path = field(i, j => grid[j] !== 201);
    const supply = field(i, own);
    if (!path || !supply) return result;
    let distance = Infinity, incoming = 0, uncertain = false, immediate = 0;
    const turn = Number.isFinite(state.turn) ? Math.max(0, state.turn) : 1;
    // 不使用最近源的 power 场：遍历同一地形分量的所有敌军，包含后排强军。
    // 不抵扣沿途攻占损耗，不依赖队友阻挡；所有可达兵可协同，是保守上界。
    for (const j of path.q) {
      const d = path.d[j];
      // 有限到达窗口：远在另一端的全部敌兵不能被当作立刻贴脸，否则永不建设。
      const horizon = Math.max(8, Math.ceil(p.enemyDistance) + 2);
      if (unknown(j)) { distance = Math.min(distance, d); if (d <= horizon) uncertain = true; continue; }
      if (!owners[j] || allied(owners[j]) || state.isolated?.[j]) continue;
      distance = Math.min(distance, d);
      if (d > horizon) continue;
      const ticks = horizon;
      const growth = grid[j] >= 100 && grid[j] < 150 ? ticks :
        Math.floor((turn + ticks) / 50) - Math.floor(turn / 50) +
        (grid[j] < 50 ? Math.max(0, Math.min(50, turn + ticks) - Math.max(25, turn)) : 0);
      const force = Math.max(0, count(j) - 1) + (state.isolated?.[j] ? 0 : growth);
      incoming += force;
      if (d <= 2) immediate += force;
    }
    const reserve = p.buildSafety + incoming * Math.max(1, p.threatWeight);
    const after = count(i) - 50;
    // 本地实兵证明，不把尚未下达命令的己方援军/皇冠未来增长算成保证。
    const crownSafe = !uncertain && after >= reserve;
    let funding = count(i);
    for (const j of supply.q) if (j !== i)
      funding += Math.max(0, count(j) - Math.max(1, p.buildSafety) - supply.d[j]);
    // 删除候选后，至少两个仍含团队建筑锚点的分量，才具有独立连通价值。
    // 普通边界、无建筑的长尾、平坦前线均不自动成为塔点。
    const seen = new Uint8Array(size); seen[i] = 1;
    let anchorGroups = 0;
    for (const start of neighbors[i]) {
      if (seen[start] || !friendly(start)) continue;
      const q = [start]; seen[start] = 1; let anchors = 0;
      for (let h = 0; h < q.length; h++) {
        if (--budget < 0) return rejected;
        const k = q[h]; if (anchor(k)) anchors++;
        for (const j of neighbors[k]) if (!seen[j] && friendly(j)) { seen[j] = 1; q.push(j); }
      }
      if (anchors) anchorGroups++;
    }
    const tactical = anchorGroups >= 2 && distance <= Math.max(4, p.enemyDistance + 2);
    // 塔损失较低，但仍不能把50兵花在即将被直接攻破的位置。
    const towerSafe = tactical && after >= p.buildSafety + immediate * Math.max(1, p.threatWeight) &&
      !neighbors[i].some(unknown);
    // 后方先把两阶段费用集中到同一格再落塔；不能以分散资金承诺未来升级。
    result = { crownSafe, foundationSafe: crownSafe && count(i) >= 100 + reserve,
      towerSafe, tactical, complete: true, reserve, incoming, distance, funding, anchorGroups };
    cache.set(i, result);
    return result;
  }
  return { assess, neighbors, own, count, unknown, owners, params: p };
}
module.exports = { architecture };
