'use strict';

/** 独立、有界的开局覆核。null 表示不覆盖原动作；不建造、不保存计划。
 * t 的命令在 t+1 增长后执行，新领地从 t+2 才开始产兵。
 * openingBudget 默认 24000，硬上限 60000；耗尽时只返回已验证的直接扩张。
 */
function chooseOpening(state, proposedMove, params = {}) {
  if (!state || state.dead || state.ended) return null;
  const { n, m, grid, army, playerId: me, turn } = state;
  const size = n * m;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || size > 100000 ||
      !Number.isInteger(me) || me < 1 || me > 49 || grid?.length !== size || army?.length !== size ||
      !Number.isInteger(turn) || turn < 0 || turn >= 50) return null;
  let budget = Number.isFinite(params?.openingBudget) ? Math.max(0, Math.min(60000, Math.floor(params.openingBudget))) : 24000;
  const exhausted = Symbol('预算');
  const spend = () => { if (--budget < 0) throw exhausted; };
  const owner = v => v > 0 && v < 200 ? v % 50 : 0;
  const team = state.teams instanceof Map ? state.teams.get(me) : 0;
  const ally = o => o === me || (o > 0 && team > 0 && state.teams.get(o) === team);
  const visible = i => !state.fog?.[i] && grid[i] !== 202 && grid[i] !== 203;
  const pass = i => visible(i) && grid[i] !== 201;
  const type = i => grid[i] >= 100 && grid[i] < 150 ? 'crown' : grid[i] >= 50 && grid[i] < 100 ? 'city' :
    grid[i] >= 150 && grid[i] < 200 || grid[i] === 204 ? 'swamp' : 'plain';
  function ns(i) {
    spend();
    const a = [];
    if (i >= m) a.push(i - m);
    if (i % m) a.push(i - 1);
    if (i % m + 1 < m) a.push(i + 1);
    if (i + m < size) a.push(i + m);
    return a;
  }
  function growth(c, from, to) {
    if (!c.o) return 0;
    if (c.type === 'crown') return to - from;
    if (c.iso || c.type === 'swamp') return 0;
    return Math.floor(to / 50) - Math.floor(from / 50) +
      (c.type === 'plain' ? Math.max(0, Math.min(50, to) - Math.max(25, from)) : 0);
  }
  function read(board, i, tick) {
    spend();
    const c = board.get(i) || { o: owner(grid[i]), a: Math.max(0, army[i]), type: type(i), iso: !!state.isolated?.[i], tick: turn };
    return { ...c, a: c.a + growth(c, c.tick, tick), tick };
  }
  function push(board, s, t, tick) {
    const c = read(board, s, tick);
    if (c.o !== me || c.iso || !visible(s)) return 0;
    let reserve = 0;
    for (const k of ns(s)) {
      if (k === t || grid[k] === 201 || grid[k] === 203) continue;
      // 迷雾绝不读取旧军力/所有者；可见空地的 -1 必须保留。
      if (!visible(k)) reserve += 2;
      else { const b = read(board, k, tick); if (!ally(b.o)) reserve += b.a - 1; }
    }
    return Math.max(0, Math.min(c.a - 1, c.a - reserve - 1));
  }
  const crowns = [], sources = [];
  let best = null, bestScore = -Infinity;
  const empty = new Map();
  const move = (s, t, reason) => ({ x: Math.floor(s / m), y: s % m, dx: Math.floor(t / m), dy: t % m, half: false, mode: 0, reason });
  // 对主城和行动两端检查同 tick 扑杀及下一 tick 反击；敌以全军减一作为保守上界。
  function pressure(board, i, tick) {
    let sum = 0;
    for (const k of ns(i)) {
      if (!pass(k)) continue;
      const e = read(board, k, tick);
      if (e.o && !ally(e.o) && !e.iso) sum += Math.max(0, e.a - 1);
    }
    return sum;
  }
  function act(board, s, t, tick) {
    if (!pass(t)) return null;
    const a = read(board, s, tick), b = read(board, t, tick);
    if (b.iso || (ally(b.o) && b.o !== me)) return null;
    const amount = push(board, s, t, tick);
    if (amount <= 0 || (b.o !== me && amount <= b.a)) return null;
    const out = new Map(board);
    out.set(s, { ...a, a: a.a - amount });
    out.set(t, { ...b, o: me, a: b.o === me ? b.a + amount : amount - b.a, iso: false });
    for (const i of new Set([...crowns, s, t])) {
      const after = read(out, i, tick);
      if (after.o !== me) continue;
      if (after.a < 1 || pressure(out, i, tick) > after.a ||
          pressure(out, i, tick + 1) > read(out, i, tick + 1).a) return null;
      // 尚未执行我方命令时，敌人也可能先扑向主城。
      if (crowns.includes(i) && pressure(board, i, tick) > read(board, i, tick).a) return null;
    }
    return { board: out, cost: b.o === me ? 0 : b.a + 1 };
  }
  function value(board, t, tick, cost) {
    const c = read(board, t, tick);
    const income = growth({ ...c, o: me, iso: false }, tick, 50);
    // 末班免费拓地仍有领土价值，但高驻军格必须在本轮回本。
    if (cost > income + 1) return -Infinity;
    let space = 0;
    for (const k of ns(t)) {
      if (!pass(k)) continue;
      const b = read(board, k, tick + 1);
      if (!ally(b.o) && !b.iso && b.type === 'plain') space += 1 / (1 + b.a);
    }
    return income * 4 + space * 2 - cost * 3 - pressure(board, t, tick + 1);
  }
  try {
    for (let i = 0; i < size; i++) {
      spend();
      if (!Number.isFinite(army[i]) || army[i] < 0) return null;
      if (visible(i) && owner(grid[i]) === me && !state.isolated?.[i]) {
        sources.push(i); if (type(i) === 'crown') crowns.push(i);
      }
    }
    const r = proposedMove?.reason;
    if (proposedMove?.urgent || /守|防御|防守|救援|清除.*威胁|defen|rescue|emergency/i.test(typeof r === 'string' ? r : JSON.stringify(r || {}))) return null;
    // “斩首”可能只是远程路径标签，仅实际可捕获的相邻敌主城受到保护。
    const p = proposedMove;
    if (p && (p.kind == null || p.kind === 'attack') && [p.x, p.y, p.dx, p.dy].every(Number.isInteger) &&
        p.x >= 0 && p.x < n && p.dx >= 0 && p.dx < n && p.y >= 0 && p.y < m && p.dy >= 0 && p.dy < m &&
        Math.abs(p.x - p.dx) + Math.abs(p.y - p.dy) === 1) {
      const s = p.x * m + p.y, t = p.dx * m + p.dy;
      const c = read(empty, t, turn + 1);
      const mode = p.mode ?? (p.half ? 1 : 0);
      const amount = mode === 2 ? read(empty, s, turn + 1).a - 1 :
        mode === 1 ? Math.floor(push(empty, s, t, turn + 1) / 2) : push(empty, s, t, turn + 1);
      if (pass(t) && owner(grid[s]) === me && !state.isolated?.[s] && c.type === 'crown' && c.o && !ally(c.o) && amount > c.a) return null;
    }
    // 所有源的直接安全普通格扩张先完整评估；任何铺路都不能抢占它们。
    for (const s of sources) for (const t of ns(s)) {
      if (!pass(t) || ally(owner(grid[t])) || type(t) !== 'plain') continue;
      const result = act(empty, s, t, turn + 1);
      if (!result) continue;
      const score = value(result.board, t, turn + 1, result.cost);
      if (score > bestScore) { bestScore = score; best = move(s, t, turn >= 26 ? '爆发拓地' : '开局播种'); }
    }
    if (best) return best;
    // 深度最多4、分支最多4，模拟逐 tick 增长和留兵；仅有可回本普通终点才运输。
    let route = null, routeScore = -Infinity;
    function search(board, s, path, first, cost) {
      const depth = path.length;
      if (depth > 4 || turn + depth > 50) return;
      for (const t of ns(s)) {
        if (path.includes(t) || !pass(t)) continue;
        const b = read(board, t, turn + depth);
        if (ally(b.o) && b.o !== me) continue;
        const result = act(board, s, t, turn + depth);
        if (!result) continue;
        const start = first || [s, t], total = cost + result.cost;
        if (depth >= 2 && b.o !== me && b.type === 'plain') {
          const score = value(result.board, t, turn + depth, total + depth - 1) - depth * 3;
          if (score > routeScore) { routeScore = score; route = move(...start, '爆发调兵'); }
        }
        search(result.board, t, [...path, t], start, total);
      }
    }
    for (const s of sources) search(empty, s, [s], null, 0);
    return route;
  } catch (e) {
    if (e === exhausted) return best;
    throw e;
  }
}
module.exports = { chooseOpening };
