'use strict';

// 原创、无跨局记忆的单步规划器。dx/dy 是目标坐标（不是方向增量）。
const { resolveParams } = require('./params.cjs');
exports.chooseMove = function chooseMove(state, params = {}) {
  if (!state || state.ended || state.dead) return null;
  const tuning = resolveParams(params);
  const { n, m, playerId: me, grid, army, teams } = state;
  const size = n * m;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n <= 0 || m <= 0 ||
      !Number.isInteger(me) || me < 1 || me > 49 || !grid || !army ||
      grid.length !== size || army.length !== size) return null;
  const isolated = state.isolated || [];
  const fog = state.fog || [];
  const owner = (v) => v >= 1 && v <= 49 ? v :
    v >= 51 && v <= 99 ? v - 50 : v >= 100 && v <= 149 ? v - 100 :
      v >= 151 && v <= 199 ? v - 150 : 0;
  const owners = Array.from(grid, owner);
  const team = teams instanceof Map ? teams.get(me) : undefined;
  const ally = (id) => id === me || (id > 0 && team != null && team !== 0 && teams.get(id) === team);
  const enemy = (i) => owners[i] > 0 && !ally(owners[i]);
  const unknown = (i) => Boolean(fog[i]) || grid[i] === 202;
  const count = (i) => Number.isFinite(army[i]) ? Math.max(0, army[i]) : 0;
  // 长程目标不能按当前驻军报价：抵达前敌主城持续产兵，普通地还可能处于爆发期。
  const growthBy = (i, ticks) => {
    if (!owners[i] || isolated[i] || unknown(i)) return 0;
    if (grid[i] >= 101 && grid[i] <= 149) return ticks;
    if (grid[i] >= 150) return 0;
    const start = Number.isInteger(state.turn) ? state.turn : 0;
    return Math.floor((start + ticks) / 50) - Math.floor(start / 50) +
      (grid[i] < 50 ? Math.max(0, Math.min(50, start + ticks) - Math.max(25, start)) : 0);
  };
  const passable = (i) => grid[i] !== 201 && grid[i] !== 203 &&
    (owners[i] === me || !ally(owners[i])); // 不借道、不转移队友领地。
  const neighbors = Array.from({ length: size }, (_, i) => {
    const a = [];
    if (i >= m) a.push(i - m);
    if (i % m > 0) a.push(i - 1);
    if (i % m + 1 < m) a.push(i + 1);
    if (i + m < size) a.push(i + m);
    return a;
  });
  const crowns = [];
  const sources = [];
  for (let i = 0; i < size; i++) {
    if (owners[i] !== me) continue;
    if (grid[i] === 100 + me) crowns.push(i);
    if (!isolated[i] && count(i) > 1) sources.push(i);
  }
  if (!sources.length) return null;

  // 精确复现 mode:0 的静态留兵：空格的 -1 也保留，与引擎一致。
  function push(from, to, total, previous = -1) {
    let reserve = 0;
    for (const k of neighbors[from]) {
      if (k === to || k === previous || grid[k] === 201 || grid[k] === 203 || ally(owners[k])) continue;
      reserve += unknown(k) ? 2 : count(k) - 1;
    }
    return Math.min(total - 1, Math.max(0, total - reserve - 1));
  }
  const pressure = (i, except = -1) => neighbors[i].reduce((sum, k) =>
    sum + (k !== except && enemy(k) && !isolated[k] ? Math.max(0, count(k) - 1) : 0), 0);
  const danger = new Set(crowns.filter((i) => pressure(i) >= count(i)));

  // 多源距离场：境内汇兵只沿严格下降的前线距离，避免 A→B→A 倒兵。
  const distance = new Int32Array(size).fill(-1);
  const queue = [];
  for (let i = 0; i < size; i++) {
    if (owners[i] === me && !isolated[i] && neighbors[i].some((k) => passable(k) && owners[k] !== me)) {
      distance[i] = 0;
      queue.push(i);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (const k of neighbors[i]) {
      if (owners[k] === me && !isolated[k] && distance[k] < 0) {
        distance[k] = distance[i] + 1;
        queue.push(k);
      }
    }
  }
  let best = null;
  function offer(from, to, score, reason) {
    const amount = push(from, to, count(from));
    if (amount <= 0) return;
    if (crowns.includes(from) && count(from) - amount <= pressure(from, owners[to] !== me ? to : -1)) return;
    if (!best || score > best.score) best = { from, to, score, reason };
  }

  // 扫描所有源的局部救援/汇兵；远程搜索只选 24 个重要源。
  for (const s of sources) {
    for (const t of neighbors[s]) {
      if (!passable(t)) continue;
      const amount = push(s, t, count(s));
      if (owners[t] === me && !isolated[t]) {
        if (danger.has(t)) offer(s, t, 100000 + Math.min(amount, pressure(t)), '守主城');
        if (distance[s] > 0 && distance[t] === distance[s] - 1)
          offer(s, t, 100 + Math.min(amount, 100) - distance[t], '前线汇兵');
      }
      if (enemy(t) && !unknown(t) && amount > count(t) + growthBy(t, 1) && crowns.some((c) => danger.has(c) && neighbors[c].includes(t)))
        offer(s, t, 110000 + amount - count(t), '清除主城威胁');
      if (enemy(t) && grid[t] >= 101 && grid[t] <= 149 && !unknown(t) && amount > count(t) + growthBy(t, 1))
        offer(s, t, 90000 + amount - count(t), '斩首');
    }
  }
  sources.sort((a, b) => {
    const importance = (i) => count(i) + (neighbors[i].some((k) => danger.has(k)) ? 10000 : 0);
    return importance(b) - importance(a) || a - b;
  });
  let budget = 24000;
  for (const source of sources.slice(0, 24)) {
    if (budget <= 0) break;
    // 单个格只入队一次，选择可负担的最短路径；不通过绕圈重复收集兵力。
    const seen = new Uint8Array(size);
    seen[source] = 1;
    const paths = [{ at: source, first: -1, prev: -1, total: count(source), depth: 0 }];
    for (let head = 0; head < paths.length && budget > 0; head++) {
      const p = paths[head];
      budget--;
      if (p.depth >= 18) continue;
      for (const t of neighbors[p.at]) {
        if (seen[t] || !passable(t)) continue;
        const sent = push(p.at, t, p.total, p.prev);
        const ours = owners[t] === me;
        // 雾平地只作为探路终点，不假装知道雾后防守或规划穿雾斩首。
        const defense = unknown(t) ? Math.max(2, count(t)) : count(t) + (!ours ? growthBy(t, p.depth + 1) : 0);
        if (sent <= 0 || (!ours && sent <= defense)) continue;
        const depth = p.depth + 1;
        const first = p.first < 0 ? t : p.first;
        const remaining = ours ? sent + count(t) : sent - defense;
        seen[t] = 1;
        let score = -Infinity;
        let reason = '';
        if (danger.has(t)) { score = 100000; reason = '守主城'; }
        else if (!ours && !unknown(t)) {
          if (enemy(t) && grid[t] >= 101 && grid[t] <= 149) { score = 90000; reason = '斩首'; }
          else if (neighbors[t].some((k) => owners[k] === me && isolated[k])) { score = 12000; reason = '打通孤军'; }
          else if (grid[t] >= 50 && grid[t] <= 99) { score = 2200; reason = '切断指挥所'; }
          else if ((grid[t] >= 150 && grid[t] <= 199) || grid[t] === 204) { score = 900; reason = '通过沼泽'; }
          else { score = (enemy(t) ? 1800 : 1500) * tuning.expansionWeight; reason = '拓地'; }
        } else if (!ours) { score = 700 * tuning.explorationWeight; reason = '探路'; }
        // 孤立格不能出兵：先从连通区域进入恢复连接，不把它当跳板。
        if (ours && isolated[t]) { score = 12000; reason = '回收孤军'; }
        const inward = owners[first] === me && !isolated[first];
        const strategic = score >= 12000;
        if (score > -Infinity && (!inward || strategic || distance[first] < distance[source]))
          offer(source, first, score - depth * tuning.moveDepthCost + Math.min(remaining, 30), reason);
        if (!unknown(t) && !isolated[t]) paths.push({ at: t, first, prev: p.at, total: remaining, depth });
      }
    }
  }
  if (!best) return null;
  return {
    x: Math.floor(best.from / m), y: best.from % m,
    dx: Math.floor(best.to / m), dy: best.to % m,
    half: false, mode: 0, reason: best.reason,
  };
};
