'use strict';

const { cutAnalysis } = require('../board.cjs');

/**
 * Backward "required departing army" search (PolyGen style) for Bot(2.0).
 *
 * Pure functions only: every result is derived from the board snapshot that
 * the server already handed to the bot.  The wire format reports hidden cells
 * with owner 0 and army 0, so fog is respected by construction instead of by
 * an extra visibility check sprinkled through the search.
 *
 * Route model (no waiting, one cell per tick):
 *
 *   every push sends `present - 1` (one guard always stays on the source)
 *   own relay     : present = send + garrison(t)
 *   captured cell : present = send - garrison(t), and send > garrison(t)
 *   goal          : captured <=> send > garrison(goal, eta)
 *
 * Because all moves cost exactly one tick and we never wait, the arrival tick
 * at the i-th path cell is `i`, and the goal is reached at `eta = path.length-1`.
 * Garrison growth is therefore evaluated at a known absolute tick, which makes
 * the requirement exact along a concrete path (see `evaluatePath`).
 */

// Crowns add one unit per tick, plains/cities add one unit per 50 ticks, swamps
// and neutral cells never produce.  The 26..50 global "burst" bonus for plains
// is deliberately ignored: it is symmetric for both sides and would make the
// requirement depend on the wall clock instead of the route length.
function growthFor(kind, turn, ticks) {
  if (!(ticks > 0)) return 0;
  if (kind === 'crown') return ticks;
  if (kind !== 'plain' && kind !== 'city') return 0;
  const base = Math.max(0, Number(turn) || 0);
  return Math.max(0, Math.floor((base + ticks) / 50) - Math.floor(base / 50));
}

// Normal (owned, visible, non-isolated) cells grow; neutral and isolated cells
// are frozen, so their garrison is the snapshot value.
function garrisonAt(board, at, ticks) {
  const base = Math.max(0, Number(board.army[at]) || 0);
  if (!(ticks > 0)) return base;
  const owner = board.owner(at);
  if (!owner || board.isolated[at]) return base;
  return base + growthFor(board.kind(at), board.turn, ticks);
}

function ownAt(board, at, owner) {
  return board.owner(at) === owner;
}

function relayAt(board, at, owner) {
  const cellOwner = board.owner(at);
  return cellOwner > 0 && board.sameTeam(owner, cellOwner);
}

function foeAt(board, at, owner) {
  const cellOwner = board.owner(at);
  return cellOwner > 0 && !board.sameTeam(owner, cellOwner);
}

const DEFAULTS = Object.freeze({
  maxEta: 240,
  candidateLimit: 24,
  allowRiskyCuts: false,
  cutRiskPenalty: 1,
  cutSlack: 0,
  ignoreGrowth: false,
  relaxLimit: null,
});

function optionsOf(input = {}) {
  return {
    maxEta: Number.isFinite(input.maxEta) ? Math.max(1, input.maxEta) : DEFAULTS.maxEta,
    candidateLimit: Number.isFinite(input.candidateLimit) ? Math.max(1, input.candidateLimit) : DEFAULTS.candidateLimit,
    allowRiskyCuts: input.allowRiskyCuts === undefined ? DEFAULTS.allowRiskyCuts : Boolean(input.allowRiskyCuts),
    cutRiskPenalty: Number.isFinite(input.cutRiskPenalty) ? Math.max(0, input.cutRiskPenalty) : DEFAULTS.cutRiskPenalty,
    cutSlack: Number.isFinite(input.cutSlack) ? Math.max(0, input.cutSlack) : DEFAULTS.cutSlack,
    ignoreGrowth: Boolean(input.ignoreGrowth),
    relaxLimit: Number.isFinite(input.relaxLimit) ? Math.max(1, input.relaxLimit) : null,
    goal: Number.isInteger(input.goal) ? input.goal : null,
  };
}

/**
 * Backward requirement field (monotone heap, finalising on pop).
 *
 * `need[cell]` is the smallest push that must arrive at `cell` from its
 * predecessor on the chosen route:
 *
 *   need[goal] = garrison(goal, 0) + 1                     (strictly greater)
 *   need[pred] = max(1, need[succ] + 1 - army[pred])       own relay / tap
 *   need[pred] = need[succ] + garrison(pred) + 1           must be captured
 *
 * A tap is an owned cell whose `army - 1` covers `need[successor]`; it is
 * detected after the search instead of being encoded as a zero label, because
 * labels must stay positive to mean "an army arrives here".  That positivity is
 * what makes merging composable: an upstream fragment can top a relay up
 * without the relay pretending it needs nothing.
 *
 * Owned relays make the recurrence non-monotone (a large friendly garrison
 * lowers the requirement, so the backward edge carries a negative weight).  A
 * strict Dijkstra is therefore not optimal, but it is still sound and it cannot
 * create a parent cycle, since a cell can only point at an already-finalised
 * successor.  Finalising on such an edge can only leave a requirement too high,
 * which may hide a kill but can never recommend an infeasible one;
 * `evaluatePath` recomputes the arithmetic exactly for the emitted path.
 * Relaxations are O(nodes log nodes); `relaxLimit` is a safety budget.
 * Deterministic tie-break: label, then cell index.
 */
function backwardRequirements(board, goal, owner, relaxLimit) {
  const size = board.size;
  const need = new Float64Array(size).fill(Infinity);
  const steps = new Int32Array(size).fill(-1);
  const next = new Int32Array(size).fill(-1);
  const settled = new Uint8Array(size);
  const limit = relaxLimit || size * 12 + 1024;

  const heapKeys = [];
  const heapCells = [];
  const swap = (i, j) => {
    const key = heapKeys[i]; heapKeys[i] = heapKeys[j]; heapKeys[j] = key;
    const cell = heapCells[i]; heapCells[i] = heapCells[j]; heapCells[j] = cell;
  };
  const push = (key, cell) => {
    heapKeys.push(key);
    heapCells.push(cell);
    let i = heapKeys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapKeys[parent] < key || (heapKeys[parent] === key && heapCells[parent] <= cell)) break;
      swap(i, parent);
      i = parent;
    }
  };
  const pop = () => {
    const key = heapKeys[0];
    const cell = heapCells[0];
    const lastKey = heapKeys.pop();
    const lastCell = heapCells.pop();
    if (heapKeys.length) {
      heapKeys[0] = lastKey;
      heapCells[0] = lastCell;
      let i = 0;
      while (true) {
        const left = i * 2 + 1;
        if (left >= heapKeys.length) break;
        let child = left;
        const right = left + 1;
        if (right < heapKeys.length && (heapKeys[right] < heapKeys[left] || (heapKeys[right] === heapKeys[left] && heapCells[right] < heapCells[left]))) child = right;
        if (heapKeys[child] > heapKeys[i] || (heapKeys[child] === heapKeys[i] && heapCells[child] >= heapCells[i])) break;
        swap(i, child);
        i = child;
      }
    }
    return [key, cell];
  };

  need[goal] = garrisonAt(board, goal, 0) + 1;
  steps[goal] = 0;
  push(need[goal], goal);

  let settledCount = 0;
  while (heapKeys.length) {
    const [key, at] = pop();
    if (settled[at] || key > need[at]) continue;
    settled[at] = 1;
    settledCount += 1;
    if (settledCount > limit) break;
    const base = need[at];
    for (const pred of board.neighbors(at)) {
      if (settled[pred] || !board.passable(pred)) continue;
      let candidate;
      if (relayAt(board, pred, owner)) {
        // Isolated owned cells cannot push, so they cannot relay a stack.
        if (board.isolated[pred]) continue;
        candidate = base + 1 - Math.max(0, Number(board.army[pred]) || 0);
        if (candidate < 1) candidate = 1;
      } else {
        // The captured cell becomes ours but still keeps one guard on the next
        // push, so a captured hop costs its garrison plus that guard.
        candidate = base + garrisonAt(board, pred, 0) + 1;
      }
      if (candidate >= need[pred]) continue;
      need[pred] = candidate;
      next[pred] = at;
      steps[pred] = steps[at] + 1;
      push(candidate, pred);
    }
  }
  return { need, steps, next };
}

function followRoute(next, start, goal) {
  const path = [start];
  let at = start;
  for (let guard = 0; guard <= next.length; guard += 1) {
    at = next[at];
    if (at < 0) return null;
    path.push(at);
    if (at === goal) return path;
  }
  return null;
}

/**
 * Exact requirement and delivery along one concrete path.
 *
 * Backward: `required` is the minimum push the tap must send into its first
 * route cell.  Forward: the same recurrence played forward with an explicit
 * `present` army per cell, verifying every capture and yielding the growth
 * breakdown.  Both are exact for the path under the documented growth model
 * (growth credited for every travel tick, including the tick on which the goal
 * is attacked, which is the attacker-conservative reading of the tick order).
 */
function evaluatePath(board, path, owner, ignoreGrowth) {
  const eta = path.length - 1;
  const goal = path[path.length - 1];
  const garrison = (at, ticks) => (ignoreGrowth ? Math.max(0, Number(board.army[at]) || 0) : garrisonAt(board, at, ticks));
  const goalGarrison = garrison(goal, eta);

  // A push sends `present - 1` (one guard stays behind on every hop).
  let required = goalGarrison + 1;
  for (let i = path.length - 2; i >= 1; i -= 1) {
    const at = path[i];
    if (relayAt(board, at, owner)) required = Math.max(1, required + 1 - garrison(at, i));
    else required += garrison(at, i) + 1;
  }

  const growth = { total: 0, goal: goalGarrison - Math.max(0, Number(board.army[goal]) || 0), relays: 0, defenders: 0 };
  let present = Math.max(0, Number(board.army[path[0]]) || 0);
  const departing = Math.max(0, present - 1);
  let feasible = departing > 0;
  for (let i = 1; i < path.length - 1 && feasible; i += 1) {
    const at = path[i];
    const now = garrison(at, i);
    const send = present - 1;
    if (relayAt(board, at, owner)) {
      growth.relays += now - Math.max(0, Number(board.army[at]) || 0);
      present = send + now;
    } else {
      growth.defenders += now - Math.max(0, Number(board.army[at]) || 0);
      if (send <= now) feasible = false;
      else present = send - now;
    }
  }
  const send = present - 1;
  if (send <= goalGarrison) feasible = false;
  const delivered = send - goalGarrison;
  growth.total = growth.goal + growth.relays + growth.defenders;
  return { eta, departing, required, delivered, goalGarrison, growth, feasible: feasible && delivered > 0 };
}

/**
 * Conservative enemy reach estimate for the cut check.
 *
 * Multi-source BFS from every visible enemy stack that can still push.  The
 * propagated strength is the source's `army - 1`, i.e. no attrition from
 * fighting through our land: this overestimates the enemy, which biases the
 * cut verdict towards "risky" (the safe direction for a route recommendation).
 */
function enemyPressure(board, owner) {
  const size = board.size;
  const distance = new Int32Array(size).fill(-1);
  const strength = new Float64Array(size);
  const queue = [];
  for (let at = 0; at < size; at += 1) {
    if (!board.passable(at) || board.isolated[at]) continue;
    if (!foeAt(board, at, owner)) continue;
    const army = Math.max(0, Number(board.army[at]) || 0);
    if (army <= 1) continue;
    distance[at] = 0;
    strength[at] = army - 1;
    queue.push(at);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head];
    for (const next of board.neighbors(at)) {
      if (!board.passable(next) || distance[next] >= 0) continue;
      distance[next] = distance[at] + 1;
      strength[next] = strength[at];
      queue.push(next);
    }
  }
  return { distance, strength };
}

/**
 * Cut risk on a chosen route.
 *
 * Roka connectivity is the reason an ETA alone is not a recommendation: a
 * single-cell owned corridor can be cut behind an advancing stack, at which
 * point the captured cells lose their anchor path, become isolated and cannot
 * push again.  We therefore look only at owned cells of the route that are
 * articulation points of our territory with detached land (`cut.land > 0`) and
 * ask whether an enemy stack can arrive there before our strike lands and beat
 * the local garrison at that tick.
 *
 * Levels: 'none' (no corridor cell), 'low' (corridor exists, no enemy in time)
 * and 'high' (enemy can take the cut before `eta`, so the route is likely to be
 * blocked or to strand the stack).
 */
function routeCutRisk(board, path, eta, pressure, options) {
  const owner = options.owner;
  const cut = cutAnalysis(board, owner);
  const exposures = [];
  let corridor = 0;
  for (let step = 0; step < path.length - 1; step += 1) {
    const at = path[step];
    if (!relayAt(board, at, owner)) continue;
    if (!cut.points.has(at) || cut.land[at] <= 0) continue;
    corridor += 1;
    const arrival = pressure.distance[at];
    if (arrival < 0 || arrival > eta - 1 - options.cutSlack) continue;
    const defender = garrisonAt(board, at, arrival);
    if (pressure.strength[at] <= defender) continue;
    exposures.push({
      cell: at,
      step,
      phase: arrival < step ? 'before-stack' : 'behind-stack',
      arrival,
      defender,
      threat: Math.round(pressure.strength[at]),
    });
  }
  const risky = exposures.length > 0;
  const level = risky ? 'high' : corridor > 0 ? 'low' : 'none';
  let deadline = Infinity;
  for (const exposure of exposures) deadline = Math.min(deadline, exposure.arrival);
  return { level, risky, cells: exposures, corridor, deadline: Number.isFinite(deadline) ? deadline : null };
}

function better(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.rankEta !== b.rankEta) return a.rankEta < b.rankEta ? a : b;
  if (a.delivered !== b.delivered) return a.delivered > b.delivered ? a : b;
  return a.tap <= b.tap ? a : b;
}

function failure(reason, extra = {}) {
  return {
    ok: false,
    reason,
    eta: Infinity,
    path: null,
    tap: -1,
    departing: 0,
    delivered: 0,
    goal: -1,
    growth: { total: 0, goal: 0, relays: 0, defenders: 0 },
    cutRisk: { level: 'none', risky: false, cells: [], corridor: 0, deadline: null },
    ...extra,
  };
}

function killToward(board, goal, options, pressure) {
  const owner = options.owner;
  if (relayAt(board, goal, owner)) return failure('goal-owned', { goal });
  const { need, steps, next } = backwardRequirements(board, goal, owner, options.relaxLimit);

  // Candidate taps are owned, non-isolated cells with a route.  The static
  // requirement is growth-free, while friendly relays can only make a route
  // cheaper, so taps within `eta` units of the static requirement (one unit per
  // travel tick is the most a relay can add) are evaluated exactly.  If that
  // generous filter still yields nothing, every routed tap is retried so a
  // surprise can never be hidden by the filter itself.
  const routed = [];
  for (let at = 0; at < board.size; at += 1) {
    if (!ownAt(board, at, owner) || board.isolated[at]) continue;
    const army = Math.max(0, Number(board.army[at]) || 0);
    if (army <= 1 || next[at] < 0) continue;
    const eta = steps[at];
    if (eta < 1 || eta > options.maxEta) continue;
    const requirement = need[next[at]];
    if (!Number.isFinite(requirement)) continue;
    routed.push({ tap: at, eta, requirement, surplus: army - 1 - requirement });
  }
  const eligible = routed
    .filter((candidate) => candidate.surplus + candidate.eta >= 0)
    .sort((a, b) => (a.eta - b.eta) || (b.surplus - a.surplus) || (a.tap - b.tap));
  const fallback = routed.slice().sort((a, b) => (a.eta - b.eta) || (a.tap - b.tap));

  let best = null;
  let risky = null;
  const tried = new Set();
  const attempt = (candidate) => {
    if (tried.has(candidate.tap)) return;
    tried.add(candidate.tap);
    const path = followRoute(next, candidate.tap, goal);
    if (!path) return;
    const detail = evaluatePath(board, path, owner, options.ignoreGrowth);
    if (!detail.feasible) return;
    const cutRisk = routeCutRisk(board, path, detail.eta, pressure, options);
    const record = {
      ok: true,
      reason: cutRisk.risky ? 'risky-cut' : 'ok',
      eta: detail.eta,
      rankEta: detail.eta + (cutRisk.risky ? options.cutRiskPenalty : 0),
      path,
      tap: candidate.tap,
      departing: detail.departing,
      required: detail.required,
      delivered: detail.delivered,
      goal,
      growth: detail.growth,
      cutRisk,
    };
    if (cutRisk.risky) {
      risky = better(risky, record);
      if (!options.allowRiskyCuts) return;
    }
    best = better(best, record);
  };

  for (let i = 0; i < eligible.length && i < options.candidateLimit; i += 1) attempt(eligible[i]);
  if (!best) {
    for (let i = 0; i < fallback.length && i < options.candidateLimit; i += 1) attempt(fallback[i]);
  }

  // A rejected risky route is returned with its diagnostics so callers can see
  // why the kill was not recommended (and may retry with allowRiskyCuts).
  if (!best && risky) return { ...risky, ok: false, reason: 'cut-risk' };
  if (!best) return failure('no-route', { goal });
  const { rankEta, ...publicRecord } = best;
  return publicRecord;
}

function goalsFor(board, owner, options) {
  if (options.goal !== null) return [options.goal];
  const goals = [];
  for (let at = 0; at < board.size; at += 1) {
    if (!board.visible[at]) continue;
    if (board.kind(at) !== 'crown') continue;
    if (!foeAt(board, at, owner)) continue;
    goals.push(at);
  }
  return goals;
}

/**
 * Best kill route against the enemy crown(s).
 *
 * Options (all optional):
 *   owner/playerId     side to search for (default board.playerId)
 *   goal              explicit target cell, default every visible enemy crown
 *   maxEta            route length cap in ticks (default 240)
 *   candidateLimit    how many taps get the exact growth evaluation (24)
 *   allowRiskyCuts    keep routes with a cut exposure (default false)
 *   cutRiskPenalty    ranking penalty (ticks) for risky routes (1)
 *   cutSlack          extra safety margin before the enemy cut counts (0)
 *   ignoreGrowth      treat garrisons as static, for cross-checks (false)
 *   relaxLimit        backward relaxation budget override
 *
 * Returns { ok, reason, eta, path, tap, departing, required, delivered, goal,
 * growth, cutRisk }:
 *   departing = army[tap] - 1 (full push)
 *   required  = minimum push the tap must send into its first route cell
 *   delivered = army left on the goal after the capture (0 on failure)
 *   growth    = { total, goal, relays, defenders } production during travel;
 *               goal/defenders make the job harder, relays help.  `total` is
 *               the signed sum, so it is not comparable across kinds.
 *   cutRisk   = { level: 'none'|'low'|'high', risky, cells, corridor, deadline }
 * On failure `ok:false` with a `reason` of 'no-goal' | 'goal-owned' |
 * 'no-route' | 'cut-risk'; a rejected risky route still carries its full
 * diagnostics.
 */
function bestKill(board, input = {}) {
  const owner = Number(input.owner ?? input.playerId ?? board.playerId) || 0;
  if (!owner) return failure('no-owner');
  const options = { ...optionsOf(input), owner };
  const goals = goalsFor(board, owner, options);
  if (!goals.length) return failure('no-goal');

  const pressure = enemyPressure(board, owner);
  let best = null;
  let risky = null;
  let first = null;
  for (const goal of goals) {
    if (!Number.isInteger(goal) || goal < 0 || goal >= board.size) continue;
    const result = killToward(board, goal, options, pressure);
    if (!first) first = result;
    if (result.ok) {
      best = better(best, result);
    } else if (result.reason === 'cut-risk') {
      risky = better(risky, result);
    }
  }
  if (best) return best;
  if (risky) return risky;
  return first || failure('no-route');
}

module.exports = {
  DEFAULTS,
  growthFor,
  garrisonAt,
  enemyPressure,
  routeCutRisk,
  backwardRequirements,
  evaluatePath,
  bestKill,
};
