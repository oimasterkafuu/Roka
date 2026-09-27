'use strict';

/**
 * 可见棋盘上的有界救援建议，不接入客户端，不保存路径，也不修改输入。
 * rescueBudget 默认 24000，上限 100000；rescueMaxSteps 默认/上限 6；
 * rescueMaxSources 默认/上限 8；rescueMinGain 默认 12（下限 1）。
 * 四邻己方孤立组件只需重新接到正常己格，不要求消灭敌锚点。
 * 引擎重连是届时当前兵乘二，不是恢复历史原兵；未知孤立年龄一律按每步
 * 5% 衰减、重连后八步价值折扣估算。增长只计可预测的近期增长。
 * 不模拟敌行动队列、远程援军、斩首转移或隐藏地形；近敌按全冲上界计风险。
 * 最多八源、六步的简单路径 BFS；每源只比较最短可胜重连层，预算耗尽放弃。
 * 替代进攻仅识别正常己兵已能直接攻同一敌方的可见机会，不是全局战役搜索。
 */
function chooseRescue(state, params = {}) {
  if (!state || state.dead || state.ended) return null;
  params = params || {};
  const { n, m, grid, army, playerId: me } = state, size = n * m;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || size > 100000 ||
      !Number.isInteger(me) || me < 1 || me > 49 || grid?.length !== size || army?.length !== size) return null;
  const bound = (v, d, max) => Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : d;
  let budget = bound(params.rescueBudget, 24000, 100000);
  const maxSteps = bound(params.rescueMaxSteps, 6, 6), maxSources = bound(params.rescueMaxSources, 8, 8);
  const minGain = Math.max(1, bound(params.rescueMinGain, 12, 10000));
  const exhausted = Symbol('救援预算耗尽');
  const spend = () => { if (budget-- <= 0) throw exhausted; };
  const owner = i => grid[i] > 0 && grid[i] < 200 ? grid[i] % 50 : 0;
  const team = p => state.teams instanceof Map ? state.teams.get(p) : state.teams?.[p];
  const ally = p => p === me || (p > 0 && team(p) > 0 && team(p) === team(me));
  const known = i => !state.fog?.[i] && ![202, 203].includes(grid[i]);
  const normal = i => known(i) && owner(i) === me && !state.isolated?.[i];
  const enemy = i => owner(i) > 0 && !ally(owner(i));
  const allowed = i => !owner(i) || owner(i) === me || (!ally(owner(i)) &&
    (!params.allowedOwners || params.allowedOwners.has(owner(i))) &&
    (!state.allowedOwners || state.allowedOwners.has(owner(i))));
  const blocked = (s, t) => params.blockedEdges?.has(`${s}:${t}`) || state.blockedEdges?.has(`${s}:${t}`);
  const ns = i => {
    const out = [];
    if (i >= m) out.push(i - m);
    if (i % m) out.push(i - 1);
    if (i % m + 1 < m) out.push(i + 1);
    if (i + m < size) out.push(i + m);
    return out;
  };
  const turn = Number.isInteger(state.turn) ? state.turn : 0;
  function growth(i, ticks, restored = false, offset = 0) {
    if (!owner(i)) return 0;
    if (grid[i] === owner(i) + 100) return ticks;
    if ((!restored && state.isolated?.[i]) || grid[i] >= 150) return 0;
    let add = 0;
    for (let t = 1; t <= ticks; t++) {
      const tick = turn + offset + t;
      add += (tick % 50 === 0 ? 1 : 0) + (grid[i] === owner(i) && tick >= 26 && tick <= 50 ? 1 : 0);
    }
    return add;
  }
  try {
    const components = [], seen = new Set(), sources = [];
    for (let i = 0; i < size; i++) {
      spend();
      if (!Number.isInteger(grid[i]) || !Number.isFinite(army[i]) || army[i] < 0) return null;
      if (normal(i) && army[i] > 1) sources.push(i);
      if (!known(i) || owner(i) !== me || !state.isolated?.[i] || seen.has(i)) continue;
      const cells = [i]; seen.add(i);
      for (let h = 0; h < cells.length; h++) {
        spend();
        for (const j of ns(cells[h])) if (known(j) && owner(j) === me && state.isolated?.[j] && !seen.has(j)) {
          seen.add(j); cells.push(j);
        }
      }
      const border = new Set(cells.flatMap(ns).filter(j => !seen.has(j)));
      // 已接正常格却仍报告孤立是过渡快照，不凭空赚一次重连收益。
      if ([...border].some(normal)) continue;
      components.push({ cells, border, mass: cells.reduce((a, j) => a + army[j], 0) });
    }
    let best = null;
    for (const comp of components) {
      spend();
      const distances = new Map();
      for (const i of sources) {
        let nearest = Infinity;
        for (const j of comp.cells) {
          spend();
          nearest = Math.min(nearest, Math.abs(Math.floor(i / m) - Math.floor(j / m)) + Math.abs(i % m - j % m) - 1);
        }
        distances.set(i, nearest);
      }
      const selected = sources.filter(i => distances.get(i) <= maxSteps).sort((a, b) => distances.get(a) - distances.get(b) || army[b] - army[a] || a - b).slice(0, maxSources);
      const foes = new Set([...comp.border].filter(enemy).map(owner));
      for (const source of selected) {
        const queue = [{ path: [source], board: new Map(), cost: 0 }];
        let shortest = Infinity;
        for (let h = 0; h < queue.length; h++) {
          spend();
          const node = queue[h], s = node.path.at(-1), step = node.path.length;
          if (step > maxSteps || step > shortest) continue;
          const read = i => node.board.get(i) || { o: owner(i), a: army[i] + growth(i, step) };
          for (const t of ns(s)) {
            spend();
            if (!known(t) || grid[t] === 201 || !allowed(t) || blocked(s, t) || node.path.includes(t) ||
                (owner(t) === me && state.isolated?.[t])) continue;
            // 未知邻格会影响智能留兵，无法保证实际出兵数。
            if (ns(s).some(j => !known(j))) continue;
            const from = read(s), to = read(t);
            let reserve = 0;
            for (const j of ns(s)) if (j !== t && grid[j] !== 201 && !ally(read(j).o)) reserve += read(j).a - 1;
            const amount = Math.max(0, Math.min(from.a - 1, from.a - reserve - 1));
            if (amount <= 0 || (to.o !== me && amount <= to.a)) continue;
            let danger = 0;
            for (const j of ns(s)) if (enemy(j) && !state.isolated?.[j]) danger += Math.max(0, read(j).a - 1);
            if (grid[s] === me + 100 && from.a - amount < Math.max(2, danger)) continue;
            const remaining = to.o === me ? to.a + amount : amount - to.a;
            let risk = 0, strongest = 0;
            for (const j of ns(t)) if (j !== s && enemy(j) && !state.isolated?.[j] && read(j).o !== me) {
              const force = Math.max(0, read(j).a + growth(j, 1, false, step) - 1);
              risk += force; strongest = Math.max(strongest, force);
            }
            // 一步重连不要求扛住未来所有集结。但当前tick单次反击就能夺桥时，
            // 不能假设孤立军已经获得下一tick行动机会。
            const temporary = risk >= remaining && step === 1 && comp.border.has(t) &&
              strongest < remaining && comp.mass >= 2 * amount &&
              comp.cells.some(i => ns(i).some(j => known(j) && enemy(j) && allowed(j) &&
                !blocked(i,j) && 2 * army[i] * 0.95 - 1 > army[j] + growth(j,2)));
            if (risk >= remaining && !temporary) continue;
            const cost = node.cost + (from.a - amount) + (to.o === me ? 0 : to.a) + risk * 0.75 + 3;
            const path = [...node.path, t];
            if (comp.border.has(t)) {
              shortest = step;
              let alternative = false;
              for (const a of sources) {
                spend();
                if (path.includes(a)) continue;
                for (const b of ns(a)) if (known(b) && foes.has(owner(b)) && allowed(b) && !blocked(a, b) && !path.includes(b)) {
                  let r = 0;
                  if (ns(a).some(j => !known(j))) continue;
                  for (const j of ns(a)) if (j !== b && grid[j] !== 201 && !ally(owner(j))) r += army[j] + growth(j, 1) - 1;
                  if (Math.min(army[a] - 1, army[a] - r - 1) > army[b] + growth(b, 1)) alternative = true;
                }
              }
              const restored = 2 * comp.mass * Math.pow(0.95, step);
              const future = restored * Math.pow(0.95, 8) * 0.65;
              const production = comp.cells.reduce((sum, i) => sum + Math.max(0, growth(i, 8, true, step) - growth(i, 8, false, step)), 0) * 0.5;
              const opportunity = alternative ? future * 0.65 + amount * 0.15 : 0;
              const score = (temporary ? future * 0.5 : future) + production - cost - opportunity;
              if (score >= minGain && (!best || score > best.score)) best = { source, first: path[1], score, steps: step, temporary };
            } else {
              const board = new Map(node.board);
              board.set(s, { o: me, a: from.a - amount });
              board.set(t, { o: me, a: remaining });
              queue.push({ path, board, cost });
            }
          }
        }
      }
    }
    if (!best) return null;
    return { x: Math.floor(best.source / m), y: best.source % m, dx: Math.floor(best.first / m), dy: best.first % m,
      ...(best.temporary ? { rescueWindow: { steps:1, temporary:true } } : {}),
      half: false, mode: 0, reason: `救援重连：预计${best.steps}步，保守净收益${Math.floor(best.score)}兵` };
  } catch (error) {
    if (error === exhausted) return null;
    throw error;
  }
}
module.exports = { chooseRescue };
