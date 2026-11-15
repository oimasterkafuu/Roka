'use strict';
const { createContext } = require('./threat.cjs');
const { chooseMove } = require('./planner.cjs');
const { chooseCutoff } = require('./cutoff.cjs');
const { chooseDefense } = require('./defense.cjs');

// A bounded portfolio of independent roots. Existing queued chains are opaque:
// reserve both endpoints until the server acknowledges removal, including cycles.
const histories = new WeakMap();
function chooseActions(state, primary, params = {}) {
  if (!state?.multiLine) return primary ? [primary] : [];
  const ctx = createContext(state, params);
  if (!ctx) return [];
  const used = new Set(), actions = [];
  const key = a => a.x * state.m + a.y;
  for (const op of state.queue || []) {
    used.add(key(op));
    if (op.kind === 'm') used.add(op.dx * state.m + op.dy);
  }
  let history = histories.get(state);
  if (!history) histories.set(state, history = []);
  history = history.filter(e => state.turn - e.turn <= 4);
  histories.set(state, history);
  const blockedEdges = new Set(history.map(e => `${e.to}:${e.from}`));
  const add = (a, lane) => {
    if (!a || actions.length >= 8) return false;
    const from = key(a), move = a.kind === 'attack';
    const to = move ? a.dx * state.m + a.dy : from;
    if (used.has(from) || used.has(to) || !ctx.own(from)) return false;
    if (move && blockedEdges.has(`${from}:${to}`)) return false;
    if (move && ctx.own(to)) {
      const reachable = new Set([to]);
      for (let changed = true; changed;) {
        changed = false;
        for (const edge of history) if (reachable.has(edge.from) && !reachable.has(edge.to)) {
          reachable.add(edge.to); changed = true;
        }
      }
      if (reachable.has(from)) return false;
    }
    // Defense reserve is a separate budget; never spend it on another lane.
    if (move) {
      const reserve = ctx.neighbors[from].reduce((v, i) =>
        i !== to && ctx.hostile(i) ? v + Math.max(0, ctx.count(i) - 1) : v, 0);
      let smartReserve = 0;
      for (const i of ctx.neighbors[from]) {
        if (i === to || ctx.grid[i] === 201 || ctx.grid[i] === 203 || ctx.allied(ctx.owners[i], ctx.me)) continue;
        smartReserve += state.fog?.[i] ? 2 : ctx.count(i) - 1;
      }
      const total = ctx.count(from), cap = Math.max(0, total - 1);
      const theoretical = Math.max(0, total - smartReserve - 1);
      const mode = a.mode ?? 0;
      const sent = mode === 2 ? cap : Math.min(cap, mode === 1 ? Math.floor(theoretical / 2) : theoretical);
      if (sent <= 0 || total - sent < reserve + 1) return false;
      if (ctx.own(to) && lane !== 'defense' && lane !== 'cutoff' && ctx.count(from) < 8) return false;
    }
    used.add(from); used.add(to);
    actions.push({ ...a, lane });
    if (move) history.push({ from, to, turn: state.turn });
    return true;
  };
  // Immediate crown wins and cuts get independent resources before normal work.
  for (let from = 0; from < ctx.size; from++) {
    if (!ctx.own(from) || used.has(from)) continue;
    for (const to of ctx.neighbors[from]) {
      if (!ctx.hostile(to) || ctx.grid[to] < 101 || ctx.grid[to] > 149) continue;
      let reserve = 0;
      for (const i of ctx.neighbors[from]) {
        if (i === to || ctx.grid[i] === 201 || ctx.grid[i] === 203 || ctx.friendly(i)) continue;
        reserve += state.fog?.[i] ? 2 : ctx.count(i) - 1;
      }
      const sent = Math.min(ctx.count(from) - 1, Math.max(0, ctx.count(from) - reserve - 1));
      if (sent > ctx.count(to)) add({ kind: 'attack', x: Math.floor(from / state.m), y: from % state.m,
        dx: Math.floor(to / state.m), dy: to % state.m, mode: 0, reason: '直接推冠' }, 'main');
    }
  }
  const cut = chooseCutoff(state, { ...params, blockedEdges });
  add(cut && { kind: 'attack', ...cut.move }, 'cutoff');
  const defense = chooseDefense(state);
  add(defense?.move && { kind: 'attack', ...defense.move }, 'defense');
  add(primary, 'main');
  // Two economic sites per tick, disjoint from military commitments. Hard
  // engine thresholds are 51 for a post and 101 for a crown upgrade.
  let economy = 0;
  const sites = Array.from({ length: ctx.size }, (_, i) => i)
    .sort((a, b) => Number(ctx.grid[b] === ctx.me + 50) - Number(ctx.grid[a] === ctx.me + 50));
  if (state.turn >= 50) for (const i of sites) {
    if (economy >= 2) break;
    if (!ctx.own(i) || used.has(i) || ctx.neighbors[i].some(j => ctx.hostile(j))) continue;
    const type = ctx.grid[i], army = state.army[i];
    const op = type === ctx.me + 50 && army >= 101 ? 'c' : type === ctx.me && army >= 51 ? 'b' : null;
    if (op && add({ kind: 'build', op, x: Math.floor(i / state.m), y: i % state.m, reason: '独立建设预算' }, 'economy')) economy++;
  }
  // Three secondary fronts, recomputing only available source roots. No
  // fictional same-tick army transfer and no repeated selection of one stack.
  for (let i = 0; i < 3; i++) {
    const move = chooseMove(state, { ...params, blockedSources: used, blockedTargets: used, blockedEdges });
    if (!move) break;
    if (!add({ kind: 'attack', ...move }, 'expansion')) used.add(key(move));
  }
  return actions;
}
module.exports = { chooseActions };
