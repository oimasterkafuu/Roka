'use strict';

const { distanceField } = require('./board.cjs');
const { preview } = require('./rules.cjs');
const { safeMove, secureDecision, parallelTactics, constructionThreat } = require('./planner.cjs');

function reserveDelivery(reserved, delivery) {
  reserved.add(delivery?.at);
  reserved.add(delivery?.root);
  for (const edge of delivery?.edges || []) edge.forEach((at) => reserved.add(at));
}

// Emit independent one-step heads only. A target that is another source is
// an engine dependency, even when the operations were submitted in reverse
// order. Reserving both endpoints also prevents double spending a garrison.
function parallelActions(board, memory, primary) {
  const actions = [];
  const occupied = new Set();
  const own = [];
  const enemies = [];
  for (let at = 0; at < board.size; at++) {
    if (board.own(at) && !board.isolated[at]) own.push(at);
    if (board.enemy(at) && !board.isolated[at]) enemies.push(at);
  }
  const enemyDistance = distanceField(board, enemies, board.passable).distance;
  const reserved = new Set([memory.campaign?.at, memory.rearEconomy?.site]);
  reserveDelivery(reserved, memory.delivery);
  reserveDelivery(reserved, memory.rearEconomy?.delivery);
  for (const at of memory.buildPlan?.cells?.slice(memory.buildPlan.index) || []) reserved.add(at);
  let after = board;
  const total = own.reduce((sum, at) => sum + board.army[at], 0);
  // Side projects spend a bounded fraction of current army; a committed
  // spearhead gets the rest, including all frozen delivery-tree sources.
  let budget = Math.floor(total * (memory.campaign ? 0.2 : 0.35));
  const add = (decision, main = false) => {
    if (!decision?.action || actions.length >= 6) return false;
    const action = decision.action;
    const from = board.idx(action.x, action.y);
    const to = action.kind === 'attack' ? board.idx(action.dx, action.dy) : from;
    if (occupied.has(from) || occupied.has(to)) return false;
    const urgent = /cut|crown|defen|intercept|anchor/.test(decision.branch || '');
    if (!main && !urgent && (reserved.has(from) || reserved.has(to))) return false;
    if (action.kind === 'build' && after.army[from] < (action.op === 'c' ? 101 : 51)) return false;
    const secure = secureDecision(after, decision);
    // A repair belongs to a different lane; evaluate it on the next frame.
    if (secure.action !== action) return false;
    const result = preview(after, action);
    if (!result.ok) return false;
    const cost = action.kind === 'build' ? 50 : result.send;
    if (!main && !urgent && cost > budget) return false;
    if (!main && !urgent) budget -= cost;
    occupied.add(from);
    occupied.add(to);
    after = result.after;
    actions.push(action);
    if (!main) {
      memory.byBranch[decision.branch] = (memory.byBranch[decision.branch] || 0) + 1;
      memory.actions++;
    }
    return true;
  };
  const hostilePressure = (at, omit = -1) => {
    let value = 0;
    for (const next of board.neighbors(at)) {
      if (next !== omit && board.enemy(next) && !board.isolated[next]) {
        value = Math.max(value, board.army[next] - 1);
      }
    }
    return value;
  };
  add(primary, true);
  for (const decision of parallelTactics(board, memory, own)) add(decision);
  reserveDelivery(reserved, memory.parallelDefense?.delivery);
  const crowns = own.filter((at) => board.kind(at) === 'crown');
  if (crowns.length === 1 && enemyDistance[crowns[0]] <= 36 && board.turn >= 40) reserved.add(crowns[0]);
  const canBuild = !constructionThreat(after, own, enemies);
  // Do not let auxiliary lanes withdraw any active convoy. Only fresh neutral
  // captures and already-funded construction are eligible; no rear shuttles.
  const candidates = [];
  const recent = memory.parallelRecent || (memory.parallelRecent = new Map());
  for (const [key, turn] of recent) if (board.turn - turn > 8) recent.delete(key);
  for (const from of own) {
    if (reserved.has(from) || occupied.has(from)) continue;
    const near = enemyDistance[from];
    const pressure = hostilePressure(from);
    if (
      canBuild &&
      ['plain', 'city'].includes(board.kind(from)) &&
      near >= 4 &&
      board.army[from] >= (board.kind(from) === 'city' ? 101 : 51) &&
      board.army[from] - 50 > pressure
    ) {
      candidates.push({
        action: { kind: 'build', ...board.xy(from), op: board.kind(from) === 'city' ? 'c' : 'b' },
        branch: 'parallel-build',
        score: 200 + (board.kind(from) === 'city' ? 80 : 0),
      });
    }
    for (const to of board.neighbors(from)) {
      if (board.owner(to) || !board.passable(to) || board.kind(to) === 'swamp') continue;
      if (recent.has(`${to}:${from}`)) continue;
      // Far from contact, grow territory locally with modest splits rather
      // than launching the whole production stack on a cross-map expedition.
      const distant = board.size >= 800 && near > 16;
      if (board.army[from] < (distant ? 12 : 4)) continue;
      const modes = near <= 8 ? [2, 0, 1] : distant ? [1] : [1, 0];
      const action = safeMove(board, from, to, 'move', modes);
      if (!action) continue;
      const result = preview(board, action);
      const arrival = result.send - board.army[to];
      if (!result.ok || (near <= 8 && arrival < 8) || arrival <= hostilePressure(to, from) + 1) continue;
      candidates.push({
        action,
        branch: 'parallel-expand',
        score:
          40 +
          board.neighbors(to).filter((at) => !board.owner(at) && board.passable(at)).length * 4 -
          Math.min(40, board.army[from]) * 0.1,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates) add(candidate);
  for (const action of actions) {
    if (action.kind === 'attack') {
      recent.set(`${board.idx(action.x, action.y)}:${board.idx(action.dx, action.dy)}`, board.turn);
    }
  }
  memory.parallelTicks = (memory.parallelTicks || 0) + Number(actions.length > 1);
  memory.maxParallel = Math.max(memory.maxParallel || 0, actions.length);
  return actions;
}

module.exports = { parallelActions };
