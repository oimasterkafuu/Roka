'use strict';

/**
 * 有界、可见信息上的短程战术覆核，不是完整引擎模拟：不推演多人行动队列、
 * 斩首后的全军转移、孤军衰减及迷雾后的援军。敌方一手既可先增援，也可后反击。
 * null 表示没有可用动作；有效原动作在收益不足或预算耗尽时原样规范化保留。
 * 参数：tacticBudget（默认12000，硬上限40000），tacticMinGain（默认8）。
 * 不接入客户端，不导入模板，也不修改输入。所有新动作只使用 mode:0。
 */
function chooseTactic(state, proposedMove, params = {}) {
  if (!state || state.dead || state.ended) return null;
  const { n, m, grid, army, playerId: me } = state;
  const size = n * m;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || size > 100000 ||
      !Number.isInteger(me) || me < 1 || me > 49 || grid?.length !== size || army?.length !== size) return null;
  const limit = (v, fallback, max) => Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : fallback;
  let budget = limit(params?.tacticBudget, 12000, 40000);
  const minGain = Math.max(1, limit(params?.tacticMinGain, 8, 1000));
  const exhausted = Symbol('预算耗尽');
  function spend() { if (budget-- <= 0) throw exhausted; }
  const owner = (v) => v >= 1 && v <= 49 ? v : v >= 51 && v <= 99 ? v - 50 :
    v >= 101 && v <= 149 ? v - 100 : v >= 151 && v <= 199 ? v - 150 : 0;
  const team = (p) => state.teams instanceof Map ? state.teams.get(p) : undefined;
  const allied = (a, b) => a > 0 && b > 0 && (a === b || (team(a) != null && team(a) !== 0 && team(a) === team(b)));
  const visible = (i) => !state.fog?.[i] && grid[i] !== 202;
  const blocked = (i) => grid[i] === 201 || grid[i] === 203;
  const ns = (i) => {
    const out = [];
    if (i >= m) out.push(i - m);
    if (i % m) out.push(i - 1);
    if (i % m < m - 1) out.push(i + 1);
    if (i + m < size) out.push(i + m);
    return out;
  };
  const initial = (i) => ({ o: owner(grid[i]), a: Number.isFinite(army[i]) ? Math.max(0, army[i]) : 0,
    type: grid[i] >= 101 && grid[i] <= 149 ? 'crown' : grid[i] >= 50 && grid[i] <= 99 ? 'city' :
      grid[i] >= 150 && grid[i] <= 199 || grid[i] === 204 ? 'swamp' : 'plain', iso: Boolean(state.isolated?.[i]) });
  const read = (board, i) => board.get(i) || initial(i);
  const normalize = (move) => {
    if (!move || (move.kind != null && move.kind !== 'attack') ||
        ![move.x, move.y, move.dx, move.dy].every(Number.isInteger) ||
        move.x < 0 || move.x >= n || move.dx < 0 || move.dx >= n ||
        move.y < 0 || move.y >= m || move.dy < 0 || move.dy >= m ||
        Math.abs(move.x - move.dx) + Math.abs(move.y - move.dy) !== 1) return null;
    const s = move.x * m + move.y, t = move.dx * m + move.dy;
    if (owner(grid[s]) !== me || state.isolated?.[s] || blocked(t) ||
        (owner(grid[t]) !== me && allied(me, owner(grid[t])))) return null;
    return { x: move.x, y: move.y, dx: move.dx, dy: move.dy, half: move.mode === 1 || (move.mode == null && move.half === true),
      mode: [0, 1, 2].includes(move.mode) ? move.mode : move.half === true ? 1 : 0,
      reason: typeof move.reason === 'string' ? move.reason : '原规划' };
  };
  const base = normalize(proposedMove);
  // 守城/救援/斩首常带有长程语义，短程收益不能把它们降级。
  if (base && (/守|救|斩首|主城威胁|紧急|defen|rescue|urgent|decap/i.test(base.reason) ||
      initial(base.dx * m + base.dy).type === 'crown')) return base;
  const empty = new Map();
  function push(board, s, t, mode = 0) {
    spend();
    const source = read(board, s);
    if (source.iso || source.a <= 1) return 0;
    const cap = source.a - 1;
    if (mode === 2) return cap;
    let reserve = 0;
    for (const k of ns(s)) {
      const c = read(board, k);
      if (k !== t && !blocked(k) && !allied(source.o, c.o)) reserve += visible(k) ? c.a - 1 : 2;
    }
    const amount = Math.max(0, source.a - reserve - 1);
    return Math.min(cap, mode === 1 ? Math.floor(amount / 2) : amount);
  }
  const turn = Number.isInteger(state.turn) ? state.turn : 0;
  // 惰性增长：仅复制短程涉及的格子，不为每个分支复制整张地图。
  function grown(board, cells, tick) {
    const out = new Map(board);
    for (const i of cells) {
      spend();
      const c = read(board, i);
      const add = !c.o ? 0 : c.type === 'crown' ? 1 : c.iso || c.type === 'swamp' ? 0 :
        (tick % 50 === 0 ? 1 : 0) + (c.type === 'plain' && tick >= 26 && tick <= 50 ? 1 : 0);
      out.set(i, { ...c, a: c.a + add });
    }
    return out;
  }
  function act(board, s, t, mode = 0) {
    const amount = push(board, s, t, mode), a = read(board, s), b = read(board, t);
    const out = new Map(board);
    out.set(s, { ...a, a: a.a - amount });
    if (allied(a.o, b.o)) out.set(t, { ...b, a: b.a + amount });
    else if (amount > b.a) out.set(t, { o: a.o, a: amount - b.a, iso: false, type: b.type === 'swamp' ? 'swamp' : 'plain' });
    else out.set(t, { ...b, a: b.a - amount });
    return out;
  }
  // 仅在完整遍历的敌方连通分量内计分；看不清/分量过大时放弃瓶颈奖励。
  function cutValue(t) {
    const enemy = owner(grid[t]);
    if (!enemy || allied(me, enemy)) return 0;
    const component = new Set([t]), queue = [t], anchors = [];
    for (let q = 0; q < queue.length; q++) {
      spend();
      const i = queue[q];
      if (!visible(i) || queue.length > 256) return 0;
      if (['city', 'crown'].includes(initial(i).type)) anchors.push(i);
      for (const k of ns(i)) if (owner(grid[k]) === enemy && !component.has(k)) { component.add(k); queue.push(k); }
    }
    if (!anchors.length) return 0;
    const reachable = new Set(anchors.filter((i) => i !== t)), todo = [...reachable];
    for (let q = 0; q < todo.length; q++) {
      spend();
      for (const k of ns(todo[q])) if (k !== t && component.has(k) && !reachable.has(k)) { reachable.add(k); todo.push(k); }
    }
    return Math.min(100, queue.reduce((sum, i) => sum + (i !== t && !reachable.has(i) && !state.isolated?.[i] ? initial(i).a : 0), 0)) * 0.6;
  }
  try {
    const candidates = [];
    const key = (s, t) => `${s}:${t}`;
    const baseKey = base && key(base.x * m + base.y, base.dx * m + base.dy);
    for (let s = 0; s < size; s++) {
      spend();
      if (owner(grid[s]) !== me || state.isolated?.[s] || !visible(s)) continue;
      for (const t of ns(s)) {
        if (blocked(t) || !visible(t) || allied(me, owner(grid[t]))) continue;
        const amount = push(empty, s, t);
        if (amount <= initial(t).a || key(s, t) === baseKey) continue;
        candidates.push({ s, t, mode: 0, rank: Math.min(30, amount - initial(t).a) + (owner(grid[t]) ? 12 : 0) });
        candidates.sort((a, b) => b.rank - a.rank || a.s - b.s || a.t - b.t);
        if (candidates.length > (base ? 7 : 8)) candidates.pop();
      }
    }
    if (base) candidates.unshift({ s: base.x * m + base.y, t: base.dx * m + base.dy, mode: base.mode });
    function evaluate(c) {
      const { s, t } = c;
      if (!visible(t)) return -10;
      const cells = new Set([s, t]);
      for (const k of [s, t]) for (const j of ns(k)) { cells.add(j); for (const h of ns(j)) cells.add(h); }
      const start = grown(empty, cells, turn + 1);
      const ours = act(start, s, t, c.mode);
      const after = grown(ours, cells, turn + 2);
      const cut = cutValue(t);
      function score(board) {
        spend();
        let value = 0;
        for (const i of cells) {
          const before = initial(i), now = read(board, i);
          value += (now.o === me ? now.a : 0) - (before.o === me ? before.a : 0);
          if (before.o === me && now.o !== me) value -= before.type === 'crown' ? 10000 : 25;
          if (before.o !== me && now.o === me) value += 25;
        }
        if (initial(t).o !== me) value += read(board, t).o === me ? cut : -80;
        return value;
      }
      let worst = score(after);
      const responses = [];
      for (const e of cells) {
        spend();
        const enemy = read(start, e);
        if (!enemy.o || allied(me, enemy.o) || enemy.iso || !visible(e)) continue;
        for (const target of [s, t]) {
          if (!ns(e).includes(target)) continue;
          const reinforcement = allied(enemy.o, read(start, target).o);
          const b = reinforcement ? start : after;
          if (!reinforcement && read(b, target).o !== me) continue;
          const amount = push(b, e, target);
          if (amount > 0) responses.push({ e, target, reinforcement, rank: amount - read(b, target).a + (initial(target).type === 'crown' ? 10000 : 0) });
        }
      }
      responses.sort((a, b) => b.rank - a.rank);
      for (const r of responses.slice(0, 8)) {
        const branch = r.reinforcement ? grown(act(act(start, r.e, r.target), s, t, c.mode), cells, turn + 2) : act(after, r.e, r.target);
        worst = Math.min(worst, score(branch));
      }
      return worst;
    }
    let best = null, bestScore = -Infinity, originalScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const score = evaluate(candidates[i]);
      if (base && i === 0) originalScore = score;
      if (score > bestScore) { bestScore = score; best = candidates[i]; }
    }
    if (!best || bestScore < 0 || (base && bestScore < originalScore + minGain)) return base;
    return { x: Math.floor(best.s / m), y: best.s % m, dx: Math.floor(best.t / m), dy: best.t % m,
      half: false, mode: 0, reason: '短程对抗：避开反击并争取稳定收益' };
  } catch (error) {
    if (error === exhausted) return base;
    throw error;
  }
}
module.exports = { chooseTactic };
