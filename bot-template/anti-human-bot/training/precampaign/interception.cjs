'use strict';

/** 有界断供覆核。null 表示保留原规划；不模拟多人行动队列或雾中援军。
 * interceptionBudget 默认 16000（上限 60000），interceptionMinGain 默认 8。
 * 仅对完整可见的敌同队连通分量计收益，最多评估八个可攻占节点。
 */
function chooseInterception(state, proposedMove, params = {}) {
  if (!state || state.dead || state.ended) return null;
  const { n, m, grid, army, playerId: me } = state;
  const size = n * m;
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || size > 100000 ||
      !Number.isInteger(me) || me < 1 || me > 49 || grid?.length !== size || army?.length !== size) return null;
  const bounded = (v, d, max) => Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : d;
  let budget = bounded(params?.interceptionBudget, 16000, 60000);
  const gain = bounded(params?.interceptionMinGain, 8, 1000);
  const exhausted = Symbol('图预算耗尽');
  const spend = () => { if (budget-- <= 0) throw exhausted; };
  const owner = v => v > 0 && v < 200 && v % 50 ? v % 50 : 0;
  const team = p => state.teams instanceof Map ? state.teams.get(p) : undefined;
  const allied = (a, b) => a > 0 && b > 0 && (a === b || (team(a) > 0 && team(a) === team(b)));
  const unknown = i => Boolean(state.fog?.[i]) || grid[i] === 202 || grid[i] === 203;
  const anchor = i => grid[i] >= 51 && grid[i] <= 149 && owner(grid[i]) > 0;
  const ns = i => {
    const out = [];
    if (i >= m) out.push(i - m);
    if (i % m) out.push(i - 1);
    if (i % m + 1 < m) out.push(i + 1);
    if (i + m < size) out.push(i + m);
    return out;
  };
  const tick = (Number.isInteger(state.turn) ? state.turn : 0) + 1;
  const owners = [], counts = [], crowns = [];
  function push(s, t, mode = 0) {
    if (state.isolated?.[s] || unknown(s) || ns(s).some(unknown)) return 0;
    const cap = Math.max(0, counts[s] - 1);
    if (mode === 2) return cap;
    let reserve = 0;
    for (const j of ns(s)) if (j !== t && grid[j] !== 201 && !allied(owners[s], owners[j])) reserve += counts[j] - 1;
    const amount = Math.max(0, counts[s] - reserve - 1);
    return Math.min(cap, mode === 1 ? Math.floor(amount / 2) : amount);
  }
  function indices(move) {
    if (!move || (move.kind != null && move.kind !== 'attack') ||
        ![move.x, move.y, move.dx, move.dy].every(Number.isInteger) ||
        move.x < 0 || move.x >= n || move.dx < 0 || move.dx >= n ||
        move.y < 0 || move.y >= m || move.dy < 0 || move.dy >= m) return null;
    const s = move.x * m + move.y, t = move.dx * m + move.dy;
    return ns(s).includes(t) && owners[s] === me ? { s, t } : null;
  }
  try {
    for (let i = 0; i < size; i++) {
      spend();
      if (!Number.isFinite(army[i]) || army[i] < 0) return null;
      const o = owner(grid[i]); owners.push(o);
      const crown = grid[i] === o + 100 && o > 0;
      const growth = !o ? 0 : crown ? 1 : state.isolated?.[i] || grid[i] >= 150 ? 0 :
        (tick % 50 === 0 ? 1 : 0) + (grid[i] === o && tick >= 26 && tick <= 50 ? 1 : 0);
      counts.push(army[i] + growth);
      if (crown && o === me) crowns.push(i);
    }
    const base = indices(proposedMove);
    // 斩首优先，不拿断供收益覆盖它。
    if (proposedMove && /斩首|decap/i.test(proposedMove.reason || '')) return null;
    if (base && owners[base.t] && !allied(me, owners[base.t]) && grid[base.t] === owners[base.t] + 100 &&
        push(base.s, base.t, proposedMove.mode ?? (proposedMove.half ? 1 : 0)) > counts[base.t]) return null;
    function endangered(candidate, cut) {
      for (const c of crowns) {
        spend();
        const defense = counts[c] - (candidate?.s === c ? candidate.amount : 0);
        for (const e of ns(c)) {
          if (unknown(e)) return true;
          // 连通重算在所有玩家动作后：即使本tick会断供，敌军仍可能先完成致命攻击。
          if (state.isolated?.[e]) continue;
          if (e === candidate?.t) continue;
          // 对方可以全冲，不能只按智能分兵的较小数值保证皇冠安全。
          if (owners[e] && !allied(me, owners[e]) && counts[e] - 1 > defense) return true;
        }
      }
      return false;
    }
    const crisis = endangered(null, null);
    const urgent = /守|救|防守|主城威胁|紧急|rescue|urgent|defen/i.test(proposedMove?.reason || '');
    if (urgent && !crisis) return null;
    let baseline = 0;
    if (base && !allied(me, owners[base.t]) && !unknown(base.t)) {
      const amount = push(base.s, base.t, proposedMove.mode ?? (proposedMove.half ? 1 : 0));
      baseline = Math.min(amount, counts[base.t]) + (amount > counts[base.t] ? 25 : 0);
    }
    const candidates = [];
    for (let s = 0; s < size; s++) {
      spend();
      if (owners[s] !== me || state.isolated?.[s] || unknown(s)) continue;
      for (const t of ns(s)) {
        if (unknown(t) || !owners[t] || allied(me, owners[t])) continue;
        const amount = push(s, t);
        if (amount <= counts[t]) continue;
        candidates.push({ s, t, amount });
      }
    }
    // 薄点优先；同一个节点仅取兵力最充裕的可用进攻源。
    candidates.sort((a, b) => counts[a.t] - counts[b.t] || b.amount - a.amount || a.s - b.s);
    const seenTargets = new Set();
    const selected = candidates.filter(c => !seenTargets.has(c.t) && seenTargets.add(c.t)).slice(0, 8);
    let best = null;
    for (const c of selected) {
      const component = new Set([c.t]), queue = [c.t];
      let complete = true;
      for (let head = 0; head < queue.length; head++) {
        spend();
        for (const j of ns(queue[head])) {
          if (unknown(j)) { complete = false; continue; }
          if (allied(owners[c.t], owners[j]) && !component.has(j)) { component.add(j); queue.push(j); }
        }
      }
      if (!complete) continue;
      // 从所有剩余城市/皇冠同时出发；被攻下的建筑已经摧毁，绝非新锚点。
      const reachable = new Set(queue.filter(i => i !== c.t && anchor(i)));
      const todo = [...reachable];
      for (let head = 0; head < todo.length; head++) {
        spend();
        for (const j of ns(todo[head])) if (j !== c.t && component.has(j) && !reachable.has(j)) {
          reachable.add(j); todo.push(j);
        }
      }
      const cut = new Set();
      let loss = 0, invasion = false;
      for (const i of queue) {
        spend();
        if (i === c.t || reachable.has(i) || state.isolated?.[i]) continue;
        cut.add(i);
        loss += counts[i] <= 1 ? 0 : counts[i] - Math.floor(counts[i] / 2);
        if (counts[i] > 1 && ns(i).some(j => owners[j] === me)) invasion = true;
      }
      if (!invasion || !cut.size || endangered(c, cut)) continue;
      const score = loss + 25 - counts[c.t];
      if (score < baseline + gain && !crisis) continue;
      if (!best || score > best.score) best = { ...c, score, loss };
    }
    if (!best) return null;
    return { x: Math.floor(best.s / m), y: best.s % m, dx: Math.floor(best.t / m), dy: best.t % m,
      half: false, mode: 0, reason: `断供防守：切断敌连接薄点，预计削减${best.loss}兵${crisis ? '并解除皇冠直接威胁' : ''}` };
  } catch (error) {
    if (error === exhausted) return null;
    throw error;
  }
}
module.exports = { chooseInterception };
