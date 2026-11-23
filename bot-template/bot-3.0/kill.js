'use strict';

// Finish layer for Bot(3.0).
//
// The relay planner is a heuristic scorer: it widens a corridor, funds crowns
// and marches toward the nearest frontier. That scoring has no notion of a
// route that *provably* ends the game, so a bot holding a decisive stack can
// keep building and oscillating while the opponent keeps its crowns. This
// module adds the missing question, in the spirit of Bot(2.0)'s duel kill-path:
//
//   "Which owned stack can reach an enemy crown, capture it, and keep enough
//    units on the crown that the capture cannot be undone - and do we get
//    there before the opponent decapitates us?"
//
// Only the first step of the winning route is emitted; the route is re-derived
// from the live board on every tick, so a blocked or cut route simply stops
// producing an order instead of marching a stale plan.
//
// Route model (identical to the planner so orders stay executable):
//   - a full push (mode 2) sends `present - 1`, one guard stays behind;
//   - an owned relay adds its garrison, a captured cell costs its garrison;
//   - the goal is captured when the incoming push is strictly larger than the
//     garrison it will have on arrival.
//
// Growth: crowns grow one unit per tick, plains and cities one unit per 50
// ticks, everything else is frozen. Defender growth is credited for every
// travel tick, including the tick of the capture, which is the conservative
// (attacker-hostile) reading of the resolution order: the layer therefore
// under-reports kills, never over-reports them.

const WALL = 201;
const INF = 1e6;

const ownerOf = (code) => (code < 200 ? code % 50 : 0);
const isCrown = (code) => code >= 100 && code < 150;

// Accepted route through an owned relay / a captured cell. Kept small so the
// arithmetic is auditable; `taps` never re-derive it.
function growthFor(code, turn, ticks) {
  if (!(ticks > 0)) return 0;
  if (isCrown(code)) return ticks;
  // Plains (`< 50`, `200`) grow on every 50th tick; cities, swamps and neutral
  // dead land never grow.
  if (code < 50 || code === 200) return Math.floor((turn + ticks) / 50) - Math.floor(turn / 50);
  return 0;
}

function garrisonAt(b, at, turn, ticks) {
  const base = Math.max(0, b.army_cnt[at]);
  const owner = ownerOf(b.grid_type[at]);
  // Neutral and isolated cells are frozen; only owned, connected cells grow.
  if (!owner || b.isolated[at]) return base;
  return base + growthFor(b.grid_type[at], turn, ticks);
}

const DEFAULTS = Object.freeze({
  // A finish must be short enough that the board cannot change much. The
  // measured trade-off is steep: see README. ETA 2 with a 60-unit surplus is
  // the widest setting that stayed neutral on the acceptance matrix.
  maxEta: 2,
  // Units left on the crown after the capture. A non-decapitation needs a real
  // surplus so the capture cannot simply be traded back next tick.
  surplus: 60,
  // A last-crown capture ends the game, so a bare capture is enough.
  decapSurplus: 1,
  // Ticks of head start required when the strike is a decapitation.
  margin: 1,
  // Exact path evaluation budget.
  maxTaps: 8,
  maxGoals: 12,
  // Earliest tick. Before this the opening/burst economy owns the game.
  minTurn: 45,
});

function optionsOf(input = {}) {
  const value = (name, min) => {
    const number = Number(input[name]);
    return Number.isFinite(number) ? Math.max(min, number) : DEFAULTS[name];
  };
  return {
    maxEta: value('maxEta', 1),
    surplus: value('surplus', 1),
    decapSurplus: value('decapSurplus', 1),
    margin: value('margin', 0),
    maxTaps: value('maxTaps', 1),
    maxGoals: value('maxGoals', 1),
    minTurn: value('minTurn', 0),
  };
}

// Small binary heap keyed by (need, cell) so ties resolve deterministically.
function createHeap() {
  const keys = [];
  const cells = [];
  const less = (i, j) => keys[i] < keys[j] || (keys[i] === keys[j] && cells[i] < cells[j]);
  const swap = (i, j) => {
    const key = keys[i];
    keys[i] = keys[j];
    keys[j] = key;
    const cell = cells[i];
    cells[i] = cells[j];
    cells[j] = cell;
  };
  return {
    get length() {
      return keys.length;
    },
    push(key, cell) {
      keys.push(key);
      cells.push(cell);
      let i = keys.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!less(i, parent)) break;
        swap(i, parent);
        i = parent;
      }
    },
    pop() {
      const key = keys[0];
      const cell = cells[0];
      const lastKey = keys.pop();
      const lastCell = cells.pop();
      if (keys.length) {
        keys[0] = lastKey;
        cells[0] = lastCell;
        let i = 0;
        for (;;) {
          const left = i * 2 + 1;
          if (left >= keys.length) break;
          const right = left + 1;
          const child = right < keys.length && less(right, left) ? right : left;
          if (!less(child, i)) break;
          swap(i, child);
          i = child;
        }
      }
      return [key, cell];
    },
  };
}

// Backward "required departing army" field from every goal crown at once.
//
// `need[cell]` is the smallest push that must arrive at `cell`:
//   need[goal] = garrison(goal) + 1                       (strictly greater)
//   need[own]  = max(1, need[next] + 1 - army[own])        relay: garrison helps
//   need[foe]  = need[next] + garrison(foe) + 1            must be captured
//
// Owned relays make the recurrence non-monotone, so the label can only be too
// high (a kill can be hidden but never invented); `evaluatePath` re-derives the
// arithmetic exactly for the emitted path. Multi-source keeps this to one
// search per tick regardless of how many enemy crowns are visible.
function backwardNeed(b, goals, ctx, eta) {
  const { size, neighbors, grid_type: tile } = b;
  const { teams, myTeam, turn } = ctx;
  const need = new Float64Array(size).fill(Infinity);
  const steps = new Int32Array(size).fill(-1);
  const next = new Int32Array(size).fill(-1);
  const goalOf = new Int32Array(size).fill(-1);
  const settled = new Uint8Array(size);
  const heap = createHeap();
  for (const goal of goals) {
    const value = garrisonAt(b, goal, turn, 0) + 1;
    if (value >= need[goal]) continue;
    need[goal] = value;
    steps[goal] = 0;
    goalOf[goal] = goal;
    heap.push(value, goal);
  }
  while (heap.length) {
    const [key, at] = heap.pop();
    if (settled[at] || key > need[at]) continue;
    settled[at] = 1;
    const depth = steps[at];
    if (depth >= eta) continue;
    const base = need[at];
    for (const pred of neighbors[at]) {
      if (settled[pred] || tile[pred] === WALL) continue;
      let candidate;
      if (teams[pred] === myTeam) {
        // An isolated cell cannot push, so it cannot relay a column either.
        if (b.isolated[pred]) continue;
        candidate = Math.max(1, base + 1 - Math.max(0, b.army_cnt[pred]));
      } else {
        candidate = base + garrisonAt(b, pred, turn, 0) + 1;
      }
      if (candidate >= need[pred]) continue;
      need[pred] = candidate;
      next[pred] = at;
      steps[pred] = depth + 1;
      goalOf[pred] = goalOf[at];
      heap.push(candidate, pred);
    }
  }
  return { need, steps, next, goalOf };
}

function followRoute(next, start) {
  const path = [start];
  let at = start;
  for (let guard = 0; guard <= next.length; guard++) {
    at = next[at];
    if (at < 0) return null;
    path.push(at);
    if (next[at] < 0) return path;
  }
  return null;
}

// Exact forward delivery along one concrete path. Defender growth is credited
// for every travel tick, so `delivered` is a lower bound on the units standing
// on the goal after the capture.
function evaluatePath(b, path, ctx) {
  const { teams, myTeam, turn } = ctx;
  const eta = path.length - 1;
  let present = Math.max(0, b.army_cnt[path[0]]);
  let weakest = present;
  for (let step = 1; step < path.length; step++) {
    const at = path[step];
    const garrison = garrisonAt(b, at, turn, step);
    const send = present - 1;
    if (teams[at] === myTeam) present = send + garrison;
    else {
      if (send <= garrison) return { feasible: false, eta, step, at, send, garrison };
      present = send - garrison;
    }
    weakest = Math.min(weakest, present);
  }
  return { feasible: present >= 1, eta, delivered: present, weakest };
}

// An owned articulation cell with land behind it is a corridor: an enemy stack
// that arrives first cuts the column off from every crown it started from.
function corridorRisk(b, path, ctx, eta) {
  const { cut, threat } = ctx;
  if (!cut || !threat) return null;
  for (let step = 1; step < eta; step++) {
    const at = path[step];
    if (ctx.teams[at] !== ctx.myTeam || !cut[at]) continue;
    if (threat[at] > Math.max(0, b.army_cnt[at])) return { cell: at, step, threat: threat[at] };
  }
  return null;
}

// Visible crowns of one owner. Under fog the count is a lower bound, so a
// hidden crown can never be mistaken for the last one (see `decap` below).
function visibleCrownsOf(b, ctx, player) {
  const team = ctx.teamByOwner.get(player) ?? 0;
  if (!team) return Infinity;
  let count = 0;
  for (let at = 0; at < b.size; at++) {
    if (ctx.teams[at] !== team) continue;
    if (!isCrown(b.grid_type[at])) continue;
    count++;
  }
  return count;
}

// Fastest enemy decapitation of our last crown, capped at `cap` ticks.
// Only used when our own strike ends the game, so the extra search is rare.
function counterEta(b, ctx, cap) {
  const { homes } = ctx;
  const rival = ctx.rivalTeam;
  if (!rival || !homes.length) return Infinity;
  const flipped = {
    teams: ctx.teams,
    myTeam: rival,
    turn: ctx.turn,
  };
  const eta = Math.max(1, Math.min(cap, 12));
  const { need, steps } = backwardNeed(b, homes, flipped, eta);
  let best = Infinity;
  for (let at = 0; at < b.size; at++) {
    if (ctx.teams[at] !== rival || b.isolated[at]) continue;
    const step = steps[at];
    if (step < 1 || step > eta) continue;
    if (!(b.army_cnt[at] - 1 >= need[at])) continue;
    best = Math.min(best, step);
  }
  return best;
}

// Enumerate the strike, cheapest route first. Returns `{ ok: false, reason }`
// with the last rejection attached when nothing is feasible and safe on the
// current snapshot.
function planFinish(b, ctx, input = {}) {
  const options = optionsOf(input);
  const { size, grid_type: tile } = b;
  const { teams, myTeam, turn, homes, targets } = ctx;
  if (!homes?.length) return { ok: false, reason: 'no-home' };
  if (turn < options.minTurn) return { ok: false, reason: 'early' };
  // Only an opponent's crown can be finished; the planner's `targets` already
  // carries remembered enemy crowns, but a stale fog memory must never be
  // attacked blind.
  const goals = [];
  for (const at of targets ?? []) {
    if (!isCrown(tile[at])) continue;
    if (b.fog[at]) continue;
    if (!teams[at] || teams[at] === myTeam) continue;
    goals.push(at);
    if (goals.length >= options.maxGoals) break;
  }
  if (!goals.length) return { ok: false, reason: 'no-goal' };
  const { need, steps, next, goalOf } = backwardNeed(b, goals, ctx, options.maxEta);

  const taps = [];
  for (let at = 0; at < size; at++) {
    if (teams[at] !== myTeam || b.isolated[at]) continue;
    const army = Math.max(0, b.army_cnt[at]);
    if (army < 2 || next[at] < 0) continue;
    const eta = steps[at];
    if (eta < 1 || eta > options.maxEta) continue;
    taps.push({ tap: at, eta, surplus: army - 1 - need[next[at]] });
  }
  if (!taps.length) return { ok: false, reason: 'no-tap' };
  taps.sort((a, c) => a.eta - c.eta || c.surplus - a.surplus || a.tap - c.tap);

  let rejected = null;
  for (const candidate of taps.slice(0, options.maxTaps)) {
    if (candidate.surplus < 0) continue;
    const path = followRoute(next, candidate.tap);
    if (!path || path.length < 2) continue;
    // Under fog an unseen cell reports an empty garrison, so a route through
    // hidden ground would invent a free capture. Require every captured hop to
    // be visible.
    let hidden = false;
    for (let step = 1; step < path.length; step++) {
      if (teams[path[step]] === myTeam) continue;
      if (b.fog[path[step]]) {
        hidden = true;
        break;
      }
    }
    if (hidden) continue;
    const detail = evaluatePath(b, path, ctx);
    if (!detail.feasible) continue;
    const goal = goalOf[candidate.tap];
    if (!isCrown(tile[goal])) continue;
    const goalOwner = ownerOf(tile[goal]);
    const goalTeam = ctx.teamByOwner.get(goalOwner) ?? 0;
    if (!goalTeam || goalTeam === myTeam) continue;
    // Fog hides crowns, so "last crown" can only be trusted on a clear board.
    const decap =
      !b.fogMode && goalTeam === ctx.rivalTeam && visibleCrownsOf(b, ctx, goalOwner) <= 1;
    // The route model cannot see the opponent's next decisions, so the crown
    // must survive the reinforcements that can physically reach it while the
    // column is on its way. `threat` is the planner's decayed four-step
    // hostile mass, which is exactly that window for these short routes.
    const reinforce = Math.max(0, ctx.threat?.[goal] ?? 0);
    // With a single crown, emptying it into a long expedition is exactly the
    // over-extension the planner refuses; only a decapitation justifies it.
    if (!decap && homes.length < 2) {
      rejected = { reason: 'sole-crown', eta: detail.eta, goal };
      continue;
    }
    const required = (decap ? options.decapSurplus : options.surplus) + reinforce;
    if (detail.delivered < required) {
      rejected = { reason: 'surplus', eta: detail.eta, goal, delivered: detail.delivered, reinforce };
      continue;
    }
    const risk = corridorRisk(b, path, ctx, detail.eta);
    if (risk && !decap) {
      rejected = { reason: 'cut', eta: detail.eta, goal, risk };
      continue;
    }
    if (decap) {
      const eta = counterEta(b, ctx, detail.eta);
      if (!(detail.eta + options.margin <= eta)) {
        rejected = { reason: 'race', eta: detail.eta, goal, theirEta: eta };
        continue;
      }
    }
    if (!risk && ctx.danger?.length && ctx.homes.length <= 2 && !decap) {
      rejected = { reason: 'danger', eta: detail.eta, goal };
      continue;
    }
    return {
      ok: true,
      reason: 'ok',
      eta: detail.eta,
      delivered: detail.delivered,
      goal,
      decap,
      risk,
      path,
      tap: candidate.tap,
      from: candidate.tap,
      to: path[1],
      mode: 2,
    };
  }
  return { ok: false, reason: rejected?.reason ?? 'no-route', ...(rejected || {}) };
}

// The finish layer ships on: with `_PUNISH` it is the pair that takes
// `relay/mediterranean/clear/single` from 19/32 to 21/32 on the sixteen-seed
// screen, and on the full matrix it adds wins without a regressing cell. The
// caller only runs it when the shadow layer is armed (the opponent is the
// replayed relay planner), so a relay-derived bot such as anti is untouched.
// `BOT3_FINISH=0` (or `board.finish = false`) restores the old default.
function finishEnabled() {
  const raw = process.env.BOT3_FINISH;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  const value = String(raw).trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

function finishOptions() {
  const numeric = (name) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : undefined;
  };
  return {
    maxEta: numeric('BOT3_FINISH_ETA'),
    surplus: numeric('BOT3_FINISH_SURPLUS'),
    decapSurplus: numeric('BOT3_FINISH_DECAP_SURPLUS'),
    margin: numeric('BOT3_FINISH_MARGIN'),
    minTurn: numeric('BOT3_FINISH_TURN'),
  };
}

module.exports = {
  DEFAULTS,
  growthFor,
  garrisonAt,
  backwardNeed,
  evaluatePath,
  planFinish,
  finishEnabled,
  finishOptions,
};
