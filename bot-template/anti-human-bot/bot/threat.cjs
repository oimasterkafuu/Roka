'use strict';
// 共享的局面分析层：把「谁的地、多少兵、离我多远、敌人有多少产能」一次性算清楚，
// 供 frontline / architecture / building / logistics / policy 复用。
//
// 与旧实现的关键差别：所有敌方兵力都按「到达所需 tick 数」衰减计入，
// 不再存在「2 跳内全额」「8 跳内全额」这类把远处大军当贴脸敌人的量；
// 同时提供建造竞赛（crown race）状态，供经济落后时切换到追赶策略。
const { resolveParams } = require('./params.cjs');

const fieldCache = new WeakMap();

function createContext(state, params = {}) {
  if (!state || state.dead || state.ended) return null;
  const { n, m, grid, army } = state;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || n * m > 100000) return null;
  const size = n * m;
  if (!Number.isInteger(state.playerId) || state.playerId < 1 || state.playerId > 49) return null;
  if (grid?.length !== size || army?.length !== size) return null;
  const me = state.playerId;
  const turn = Number.isFinite(state.turn) ? state.turn : 0;
  const p = resolveParams(params);

  const cached = fieldCache.get(state);
  if (cached && cached.turn === turn && cached.me === me && cached.size === size) return cached;

  const team = (id) => Number(state.teams instanceof Map ? state.teams.get(id) : state.teams?.[id]);
  const myTeam = team(me);
  const allied = (a, b) => a > 0 && b > 0 && (a === b || (myTeam > 0 && team(a) === myTeam && team(b) === myTeam));
  const ownerOf = (v) => (v > 0 && v < 200 ? v % 50 : 0);
  const owners = new Int16Array(size);
  const known = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    owners[i] = ownerOf(grid[i]);
    known[i] = !state.fog?.[i] && grid[i] !== 202 && grid[i] !== 203 ? 1 : 0;
  }
  const passable = (i) => grid[i] !== 201 && grid[i] !== 203;
  const isolated = (i) => Boolean(state.isolated?.[i]);
  const own = (i) => known[i] === 1 && owners[i] === me && !isolated(i);
  const hostile = (i) => known[i] === 1 && owners[i] > 0 && !allied(owners[i], me) && !isolated(i);
  const friendly = (i) => known[i] === 1 && allied(owners[i], me) && !isolated(i);
  const unknownNear = (i) => {
    for (const j of neighborsOf(i)) if (!known[j]) return true;
    return false;
  };
  const neighbors = new Array(size);
  function neighborsOf(i) {
    let list = neighbors[i];
    if (list) return list;
    list = [];
    if (i >= m) list.push(i - m);
    if (i % m) list.push(i - 1);
    if (i % m + 1 < m) list.push(i + 1);
    if (i + m < size) list.push(i + m);
    neighbors[i] = list;
    return list;
  }
  for (let i = 0; i < size; i++) neighborsOf(i);

  // 含增长的兵力：与引擎一致（皇冠每 tick +1；普通格每 50 tick +1；26–50 爆发期普通格额外 +1）。
  function growth(i, ticks) {
    const o = owners[i];
    if (!o || isolated(i) || !known[i]) return 0;
    if (grid[i] === o + 100) return ticks;
    if (grid[i] >= 150) return 0;
    const periodic = Math.floor((turn + ticks) / 50) - Math.floor(turn / 50);
    return periodic + (grid[i] < 50 ? Math.max(0, Math.min(50, turn + ticks) - Math.max(25, turn)) : 0);
  }
  const count = (i, ticks = 1) => (Number.isFinite(army[i]) ? Math.max(0, army[i]) : 0) + growth(i, ticks);

  // 距离场：到最近的己方建筑（城市/皇冠）；没有建筑时为 -1。
  const anchorDistance = new Int32Array(size).fill(-1);
  {
    const queue = [];
    for (let i = 0; i < size; i++) if (own(i) && grid[i] >= 50 && grid[i] < 150) { anchorDistance[i] = 0; queue.push(i); }
    for (let h = 0; h < queue.length; h++) for (const j of neighbors[queue[h]])
      if (anchorDistance[j] < 0 && own(j)) { anchorDistance[j] = anchorDistance[queue[h]] + 1; queue.push(j); }
  }
  // 距离场：到最近「贴敌前线格」的跳数（0 = 自己就贴敌）。
  const frontDistance = new Int32Array(size).fill(-1);
  {
    const queue = [];
    for (let i = 0; i < size; i++) {
      if (!own(i)) continue;
      let front = false;
      for (const j of neighbors[i]) if (passable(j) && owners[j] !== me && !allied(owners[j], me)) { front = true; break; }
      if (front) { frontDistance[i] = 0; queue.push(i); }
    }
    for (let h = 0; h < queue.length; h++) for (const j of neighbors[queue[h]])
      if (frontDistance[j] < 0 && own(j)) { frontDistance[j] = frontDistance[queue[h]] + 1; queue.push(j); }
  }
  // 距离场：到最近的敌方（含中立）可通行格的跳数，用于「腹地/前线」判定。
  const enemyDistance = new Int32Array(size).fill(-1);
  {
    const queue = [];
    for (let i = 0; i < size; i++) {
      if (!passable(i)) continue;
      if (owners[i] > 0 && !allied(owners[i], me)) { enemyDistance[i] = 0; queue.push(i); }
    }
    for (let h = 0; h < queue.length; h++) for (const j of neighbors[queue[h]])
      if (enemyDistance[j] < 0 && passable(j)) { enemyDistance[j] = enemyDistance[queue[h]] + 1; queue.push(j); }
  }

  const options = (o) => ({
    radius: Number.isFinite(o?.radius) ? Math.max(0, Math.min(4, Math.floor(o.radius))) : p.threatRadius,
    decay: Number.isFinite(o?.decay) ? Math.max(0, Math.min(1, o.decay)) : p.pressureDecay,
    exclude: Number.isInteger(o?.exclude) ? o.exclude : -1,
    ticks: Number.isFinite(o?.ticks) ? Math.max(1, Math.min(4, Math.floor(o.ticks))) : 2,
    armyOnly: o?.armyOnly === true,
  });
  // 局部敌军压力：按距离衰减（1 跳全额，2 跳 decay，3 跳 decay² …）。
  function pressure(i, o) {
    const { radius, decay, exclude, ticks, armyOnly } = options(o);
    let adj = 0, near = 0;
    const seen = new Set([i, exclude]);
    let layer = [i];
    for (let d = 1; d <= radius && layer.length; d++) {
      const next = [];
      for (const u of layer) for (const v of neighbors[u]) {
        if (seen.has(v) || !passable(v)) continue;
        seen.add(v);
        if (hostile(v)) {
          const force = armyOnly ? Math.max(0, army[v]) : Math.max(0, count(v, ticks) - 1);
          if (d === 1) adj += force;
          else near += force * Math.pow(decay, d - 1);
        }
        if (d < radius) next.push(v);
      }
      layer = next;
    }
    return { adj, near, total: adj + near };
  }
  // 局部己方支援：不含起点自身。
  function support(i, o) {
    const { radius, decay, exclude, ticks } = options(o);
    let adj = 0, near = 0, tiles = 0;
    const seen = new Set([i, exclude]);
    let layer = [i];
    for (let d = 1; d <= radius && layer.length; d++) {
      const next = [];
      for (const u of layer) for (const v of neighbors[u]) {
        if (seen.has(v) || !passable(v)) continue;
        seen.add(v);
        if (own(v) || friendly(v)) {
          const force = Math.max(0, count(v, ticks) - 1);
          tiles++;
          if (d === 1) adj += force; else near += force * Math.pow(decay, d - 1);
        }
        if (d < radius) next.push(v);
      }
      layer = next;
    }
    return { adj, near, total: adj + near, tiles };
  }
  // 集结在目标格上的己方邻格兵力（不含源点）。
  function friendlyAdjacent(i, exclude) {
    let force = 0, tiles = 0;
    for (const j of neighbors[i]) if (j !== exclude && friendly(j)) { force += Math.max(0, count(j) - 1); tiles++; }
    return { force, tiles };
  }
  // 同 tick 可能落到目标格的敌军增援：相邻敌军扣掉自身周边压力后的可动兵。
  function reinforcement(i, exclude, p2 = p) {
    let force = 0;
    for (const j of neighbors[i]) {
      if (j === exclude || !hostile(j)) continue;
      const ownPressure = pressure(j, { exclude: i, radius: 1 }).adj;
      force += Math.max(0, count(j) - 1 - ownPressure);
    }
    return force * p2.counterWeight;
  }

  // 阵营统计与建造竞赛。buildings = 城市 + 皇冠；race 以皇冠为主要产能指标。
  function factions() {
    const stats = new Map();
    for (let i = 0; i < size; i++) {
      if (!known[i] || !owners[i]) continue;
      const o = owners[i];
      let entry = stats.get(o);
      if (!entry) { entry = { owner: o, land: 0, army: 0, crowns: 0, cities: 0, neutralArmy: 0 }; stats.set(o, entry); }
      entry.land++;
      entry.army += Math.max(0, army[i]) + growth(i, 1);
      if (grid[i] === o + 100) entry.crowns++;
      if (grid[i] === o + 50) entry.cities++;
    }
    return stats;
  }
  const all = factions();
  const mine = all.get(me) || { land: 0, army: 0, crowns: 0, cities: 0 };
  let best = null, enemyCrowns = 0, enemyArmy = 0, enemyLand = 0;
  for (const entry of all.values()) {
    if (allied(entry.owner, me)) continue;
    enemyCrowns += entry.crowns; enemyArmy += entry.army; enemyLand += entry.land;
    if (!best || entry.crowns > best.crowns || (entry.crowns === best.crowns && entry.army > best.army)) best = entry;
  }
  const race = {
    myCrowns: mine.crowns, myCities: mine.cities, myBuildings: mine.crowns + mine.cities,
    myLand: mine.land, myArmy: mine.army,
    bestCrowns: best ? best.crowns : 0, bestOwner: best ? best.owner : null,
    bestArmy: best ? best.army : 0, bestLand: best ? best.land : 0,
    enemyCrowns, enemyArmy, enemyLand,
    deficit: (best ? best.crowns : 0) - mine.crowns,
    behind: Boolean(best) && ((best.crowns - mine.crowns >= p.raceLead) ||
      (best.crowns >= 3 && best.crowns >= mine.crowns * 1.5) ||
      (enemyCrowns >= 6 && enemyCrowns >= (mine.crowns + 1) * 2)),
  };

  const ctx = {
    state, n, m, size, turn, me, params: p, owners, grid, army, known, neighbors,
    ownerOf, allied, knownAt: (i) => known[i] === 1, passable, isolated, own, hostile, friendly, unknownNear,
    count, growth, anchorDistance, frontDistance, enemyDistance,
    pressure, support, friendlyAdjacent, reinforcement, race, factions: all,
  };
  fieldCache.set(state, ctx);
  return ctx;
}

module.exports = { createContext };
