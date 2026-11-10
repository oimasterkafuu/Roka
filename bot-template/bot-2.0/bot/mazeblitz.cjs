'use strict';

/**
 * Maze blitz (APEX_MAZE_BLITZ=1, maze rooms only, default off).
 *
 * A dedicated opening/assault plan for corridor maps, kept separate from the
 * default planner so open maps and the existing maze campaign are untouched
 * when the flag is off:
 *
 *   1. expand only - every action in the engine burst window (ticks 26..50,
 *      see src/game-engine/tick-growth.ts) paints a new cell and no army is
 *      spent on a city.  The burst pays one army per owned plain per tick, so
 *      the number of owned cells *is* the size of the future wave.
 *   2. muster - after the burst, stop economy and small strikes and pull the
 *      board into one forward launch cell (never a deep rear cell: a rear
 *      rally sends every front stack backwards along the corridor).
 *   3. push - march that single column at the nearest reachable crown and
 *      destroy crown > city > plain on the way.
 *
 * Junction rule: main-route transit uses half pushes (mode 1), repeated up to
 * three times, so 1/2 + 1/4 + 1/8 = 7/8 of the wave moves up while a real 1/8
 * guard holds the junction.  The smart split (mode 0) is never used there: it
 * reserves only the other hostile neighbours' army, which is the token guard
 * an adjacent anti stack cuts on the next tick.  A full push (mode 2) is only
 * allowed when the junction has no hostile contact besides the cell we move
 * into, so nothing can cut the one-soldier tail.
 *
 * Fork rule: a side branch is only worth clearing when it can still reconnect
 * to an enemy anchor (real connectivity through `connectedSet`, not a local
 * heuristic).  An already isolated branch (plain cells cut off from every
 * enemy crown and city) decays by itself; the held junction is enough, so the
 * main wave keeps moving instead of spending ticks in a dead end.
 *
 * `mazeBlitzPlan` receives the planner helpers it needs from `planner.cjs` so
 * this module never imports the planner (no require cycle).
 */

const { connectedSet } = require('./board.cjs');
const { actionCoordinates, computePush, preview } = require('./rules.cjs');

// Engine fact: the global burst runs from tick 26 through tick 50 inclusive.
const BURST_END_TURN = 50;

const DEFAULTS = Object.freeze({
  smallFloor: 340,
  largeFloor: 520,
  commitMargin: 1.15,
  launchReserve: 20,
  latestLaunch: 170,
  branchDepth: 14,
  branchShare: 0.55,
  branchReserve: 24,
  junctionThreat: 12,
  halfPushes: 3,
  stallLimit: 10,
  detachStall: 4,
  splitCooldown: 6,
  rescueScan: 6,
  abandonLimit: 2,
  gateCap: 2.5,
});

function envNumber(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  return String(raw).trim() === '1' || String(raw).trim() === 'true';
}

function mazeBlitzConfig(overrides = {}) {
  return {
    enabled: envFlag('APEX_MAZE_BLITZ', false),
    openingEnd: envNumber('APEX_MAZE_BLITZ_OPENING', BURST_END_TURN, 0, 400),
    smallFloor: envNumber('APEX_MAZE_BLITZ_FLOOR_SMALL', DEFAULTS.smallFloor, 0, 4000),
    largeFloor: envNumber('APEX_MAZE_BLITZ_FLOOR_LARGE', DEFAULTS.largeFloor, 0, 4000),
    commitMargin: envNumber('APEX_MAZE_BLITZ_MARGIN', DEFAULTS.commitMargin, 1, 4),
    launchReserve: DEFAULTS.launchReserve,
    latestLaunch: envNumber('APEX_MAZE_BLITZ_LATEST', DEFAULTS.latestLaunch, 0, 4000),
    branchDepth: envNumber('APEX_MAZE_BLITZ_BRANCH_DEPTH', DEFAULTS.branchDepth, 1, 60),
    branchShare: envNumber('APEX_MAZE_BLITZ_BRANCH_SHARE', DEFAULTS.branchShare, 0, 1),
    branchReserve: DEFAULTS.branchReserve,
    junctionThreat: envNumber('APEX_MAZE_BLITZ_JUNCTION', DEFAULTS.junctionThreat, 0, 4000),
    halfPushes: envNumber('APEX_MAZE_BLITZ_HALF_PUSHES', DEFAULTS.halfPushes, 1, 6),
    stallLimit: DEFAULTS.stallLimit,
    detachStall: DEFAULTS.detachStall,
    splitCooldown: DEFAULTS.splitCooldown,
    rescueScan: DEFAULTS.rescueScan,
    abandonLimit: DEFAULTS.abandonLimit,
    gateCap: envNumber('APEX_MAZE_BLITZ_GATE_CAP', DEFAULTS.gateCap, 1, 20),
    ...overrides,
  };
}

// The wave target must be reachable, not aspirational.  A 0.34 maze room has
// roughly 49 open cells (7x7), a 0.68 room roughly 225 (15x15); asking a small
// board for 400 units is impossible before the opponent is already dead.
function waveFloor(size, cfg) {
  return Number(size) >= 500 ? cfg.largeFloor : cfg.smallFloor;
}

function blitzEligible(board, memory, cfg = mazeBlitzConfig()) {
  if (!cfg.enabled) return false;
  if (String(memory?.mapMode || '') !== 'maze') return false;
  return Number(board?.size) > 0;
}

function initialState() {
  return {
    phase: 'expand',
    root: -1,
    prev: -1,
    crown: -1,
    detach: null,
    lastSplitTurn: -999,
    stall: 0,
    blocked: [],
    launches: 0,
    abandons: 0,
    frozen: 0,
    frozenAt: 0,
    splits: 0,
    peakWave: 0,
    skippedBranches: 0,
    halfAt: -1,
    halfPushes: 0,
  };
}

// The enemy anchor set is the real definition of "can reconnect": a cell that
// is not in its owner's `connectedSet` has no path to a crown or city, so it
// cannot be reinforced and decays on its own.
function enemyConnectedOwners(b, cells) {
  const owners = new Set();
  for (const at of cells) {
    const owner = b.owner(at);
    if (owner > 0 && !b.sameTeam(owner, b.playerId)) owners.add(owner);
  }
  const connected = new Set();
  for (const owner of owners) {
    for (const at of connectedSet(b, owner)) connected.add(at);
  }
  return connected;
}

/**
 * Walk one fork branch and report what it contains.  The maze is a tree, so
 * excluding the junction keeps the scan inside the branch; the depth cap
 * protects boards that contain cycles.
 */
function analyzeBranch(b, root, first, cfg, connected) {
  const seen = new Set([root, first]);
  const nodes = [{ at: first, depth: 0, cost: b.enemy(first) ? b.army[first] + 1 : 0 }];
  let building = null;
  let reconnectable = false;
  for (let head = 0; head < nodes.length; head += 1) {
    const node = nodes[head];
    const at = node.at;
    if (b.enemy(at)) {
      if (connected && connected.has(at)) reconnectable = true;
      const kind = b.kind(at);
      if (kind === 'crown' || kind === 'city') {
        const value = kind === 'crown' ? 3 : 1;
        const score = value * 1000 - node.cost * 0.6 - node.depth;
        if (!building || score > building.score) {
          building = { at, kind, cost: node.cost, depth: node.depth, score };
        }
      }
    }
    if (node.depth >= cfg.branchDepth) continue;
    for (const next of b.neighbors(at)) {
      if (seen.has(next) || !b.passable(next)) continue;
      seen.add(next);
      nodes.push({
        at: next,
        depth: node.depth + 1,
        cost: node.cost + (b.enemy(next) ? b.army[next] + 1 : 0),
      });
    }
  }
  let adjacent = 0;
  for (const next of b.neighbors(root)) {
    if (b.enemy(next)) adjacent = Math.max(adjacent, b.army[next]);
  }
  return {
    at: first,
    building,
    reconnectable,
    adjacent,
    cost: building ? building.cost : 0,
    reach: nodes.length,
  };
}

function branchWorthClearing(branch, cfg) {
  if (!branch) return false;
  // An isolated plain branch has nothing to destroy and cannot be reinforced:
  // holding the junction is enough, so keep the main wave moving.
  if (!branch.reconnectable) return false;
  return Boolean(branch.building);
}

function pathResistance(b, path) {
  let resistance = 0;
  for (const cell of path.slice(1)) {
    if (!b.enemy(cell)) continue;
    resistance += b.army[cell] + 1;
    if (b.kind(cell) === 'crown') resistance += path.length;
  }
  return resistance;
}

function routeNeed(b, path, crown, h, cfg) {
  const resistance = pathResistance(b, path);
  const guard = enemyGuard(b, crown);
  const need = Math.max(
    resistance * cfg.commitMargin + cfg.launchReserve,
    guard * 1.35 + cfg.launchReserve,
  );
  return { resistance, guard, need: Math.ceil(need) };
}

// The staging gate is about the *target's* defence, so it must count the
// enemy garrison around that crown, not `localGuard` (which sums our own cells
// near it).
function enemyGuard(b, crown) {
  const distance = new Array(b.size).fill(Infinity);
  distance[crown] = 0;
  const queue = [crown];
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head];
    if (distance[at] >= 4) continue;
    for (const next of b.neighbors(at)) {
      if (!b.passable(next) || distance[next] !== Infinity) continue;
      distance[next] = distance[at] + 1;
      queue.push(next);
    }
  }
  let guard = 0;
  for (let at = 0; at < b.size; at += 1) {
    if (distance[at] <= 4 && b.enemy(at)) guard += b.army[at];
  }
  return guard;
}

// Everything still sitting in the rear that a muster action could still pull.
// A launch that leaves a large mass behind is exactly the half-column the
// tactic is meant to avoid.
function gatherableMass(b, own, root) {
  let mass = 0;
  for (const at of own) {
    if (at === root || b.isolated[at]) continue;
    mass += Math.max(0, b.army[at] - 1);
  }
  return mass;
}

// A junction is any cell with more than one passable exit.  That is exactly
// where the smart split (mode 0) leaves a token guard, so the main route must
// never use it there.
function forkDegree(b, at) {
  let exits = 0;
  for (const next of b.neighbors(at)) if (b.passable(next)) exits += 1;
  return exits;
}

// A full push (mode 2) leaves one soldier behind, so it is only safe when no
// hostile cell touches the source except the cell we move into: nothing can
// retake the tail and isolate the wave.
function allPushSafe(b, at, to) {
  for (const next of b.neighbors(at)) {
    if (next !== to && b.enemy(next)) return false;
  }
  return true;
}

// Re-seat the wave on the forward side.  Picking the largest stack regardless
// of depth walks every forward stack back down the corridor, which is the
// wasted-gathering stall seen in the replays.
function forwardStack(b, own, crown, h, slack = 3) {
  const f = h.field(b, [crown]);
  const candidates = [];
  for (const at of own) {
    if (b.isolated[at] || b.army[at] <= 1) continue;
    const distance = f.distance[at];
    if (Number.isFinite(distance)) candidates.push({ at, distance, army: b.army[at] });
  }
  if (!candidates.length) return -1;
  const front = Math.min(...candidates.map((cell) => cell.distance));
  const band = candidates.filter((cell) => cell.distance <= front + slack);
  band.sort((a, z) => z.army - a.army || a.distance - z.distance || a.at - z.at);
  if (band[0].army >= 8) return band[0].at;
  candidates.sort((a, z) => z.army - a.army || a.distance - z.distance || a.at - z.at);
  return candidates[0].at;
}

function crownAtRisk(b, at) {
  for (const next of b.neighbors(at)) {
    if (!b.enemy(next) || b.isolated[next]) continue;
    if (b.army[next] - 1 >= b.army[at]) return true;
  }
  return false;
}

// Minimal launch veto: a home crown that one enemy push can take must be
// answered first (the defence layer above this plan already had its chance).
function homeCrownExposed(b, m) {
  const home = Number.isInteger(m?.home) ? m.home : -1;
  if (home >= 0 && b.own(home) && b.kind(home) === 'crown' && !b.isolated[home]) {
    return crownAtRisk(b, home);
  }
  for (let at = 0; at < b.size; at += 1) {
    if (!b.own(at) || b.kind(at) !== 'crown' || b.isolated[at]) continue;
    if (crownAtRisk(b, at)) return true;
  }
  return false;
}

function pickCrown(b, m, own, state, h) {
  const crowns = [];
  for (let at = 0; at < b.size; at += 1) {
    if (b.enemy(at) && b.kind(at) === 'crown' && !state.blocked.includes(at)) crowns.push(at);
  }
  if (!crowns.length) {
    state.blocked = [];
    for (let at = 0; at < b.size; at += 1) if (b.enemy(at) && b.kind(at) === 'crown') crowns.push(at);
  }
  if (!crowns.length) return -1;
  const base = Number.isInteger(state.root) && b.own(state.root)
    ? state.root
    : own.reduce((best, at) => (b.army[at] > b.army[best] ? at : best), own[0]);
  let best = -1;
  let bestScore = -Infinity;
  for (const crown of crowns) {
    const f = h.field(b, [crown]);
    const distance = f.distance[base];
    if (!Number.isFinite(distance)) continue;
    const path = h.route(f, base);
    const resistance = pathResistance(b, path);
    const core = crown === m.enemyHome ? 900 : 0;
    const score = -distance * 2.5 - resistance * 0.18 - b.army[crown] * 0.08 + core;
    if (score > bestScore) {
      bestScore = score;
      best = crown;
    }
  }
  return best;
}

// Staging must sit on the forward side of the attack axis.  A deep rear cell
// pulls every front stack backwards one corridor cell at a time, which is the
// "gathering walked the same route twice" stall from the replays.  Scan
// outward in two-cell bands and stop at the first band that actually holds a
// stack: that is the forward-most mass, and the rear gathers into it instead
// of the front walking back.
function launchCell(b, own, crown, h) {
  const f = h.field(b, [crown]);
  const cells = [];
  for (const at of own) {
    if (b.isolated[at]) continue;
    const distance = f.distance[at];
    if (!Number.isFinite(distance)) continue;
    cells.push({ at, distance, army: b.army[at] });
  }
  if (!cells.length) return -1;
  const nearest = Math.min(...cells.map((cell) => cell.distance));
  const largest = (pool) => pool.reduce((best, cell) =>
    cell.army > best.army || (cell.army === best.army && cell.distance < best.distance) ? cell : best,
  pool[0]);
  // Cells adjacent to the target are contact, not staging; only use them when
  // the board has nothing else.
  for (let band = nearest; band <= nearest + 60; band += 2) {
    const inside = cells.filter((cell) => cell.distance <= band + 1);
    const staging = inside.filter((cell) => cell.distance >= 2);
    const stack = largest(staging.length ? staging : inside);
    if (stack && stack.army > 1) return stack.at;
  }
  const staging = cells.filter((cell) => cell.distance >= 2);
  const pool = staging.length ? staging : cells;
  return pool.reduce((best, cell) =>
    cell.distance < best.distance || (cell.distance === best.distance && cell.army > best.army) ? cell : best,
  pool[0]).at;
}

function expandDecision(b, m, own, h, state) {
  const enemies = [];
  for (let at = 0; at < b.size; at += 1) if (b.enemy(at) && !b.isolated[at]) enemies.push(at);
  const ed = h.field(b, enemies);
  const opened = h.mazeOpening(b, m, own, ed) || h.opening(b, m, own, ed);
  if (opened) return { ...opened, branch: 'blitz-expand' };
  return { action: null, branch: 'blitz-expand-wait' };
}

// Main-route transit.  A half push keeps a real guard; repeating it up to
// `cfg.halfPushes` times at a fork moves 7/8 of the wave while 1/8 stays on the
// junction.  Mode 0 is never tried: its reserve is a token guard, not a hold.
function march(b, state, path, cfg, h) {
  const root = state.root;
  const next = path[1];
  const fork = forkDegree(b, root) >= 3;
  let action = null;
  let mode = -1;
  for (const candidate of allPushSafe(b, root, next) ? [2, 1] : [1]) {
    const attempt = h.safeMove(b, root, next, 'blitz-push', [candidate]);
    if (!attempt) continue;
    action = attempt;
    mode = candidate;
    break;
  }
  if (!action) return null;
  const holding = fork && mode === 1;
  const count = holding ? (state.halfAt === root ? state.halfPushes : 0) + 1 : 0;
  return {
    action,
    branch: b.enemy(next) ? 'blitz-break' : 'blitz-march',
    next,
    mode,
    // Stay on the junction for the next half push until the guard is 1/8.
    advance: !holding || count >= cfg.halfPushes,
    count,
  };
}

function advanceDetach(b, m, state, cfg, h) {
  const detach = state.detach;
  if (!detach) return null;
  if (!b.own(detach.at) || b.isolated[detach.at] || b.army[detach.at] <= 1) {
    state.detach = null;
    return null;
  }
  if (!b.enemy(detach.goal) || !['crown', 'city'].includes(b.kind(detach.goal))) {
    state.detach = null;
    return null;
  }
  const f = h.field(b, [detach.goal]);
  const path = h.route(f, detach.at);
  if (!path || path.length < 2) {
    state.detach = null;
    return null;
  }
  const next = path[1];
  const action = h.safeMove(b, detach.at, next, 'blitz-detach', [2, 1]);
  if (!action) {
    detach.stall = (detach.stall || 0) + 1;
    if (detach.stall >= cfg.detachStall) state.detach = null;
    return null;
  }
  detach.stall = 0;
  detach.at = next;
  detach.turns = (detach.turns || 0) + 1;
  if (detach.turns > cfg.branchDepth * 3) state.detach = null;
  return { action, branch: 'blitz-detach' };
}

function splitDecision(b, state, path, mainNeed, cfg, h) {
  if (b.turn - state.lastSplitTurn < cfg.splitCooldown) return null;
  const root = state.root;
  const next = path[1];
  const sides = [];
  for (const side of b.neighbors(root)) {
    if (side === next || side === state.prev) continue;
    if (!b.passable(side)) continue;
    sides.push(side);
  }
  if (!sides.length) return null;
  const connected = enemyConnectedOwners(b, sides.length ? [root, ...sides] : [root]);
  const wave = b.army[root];
  let best = null;
  for (const side of sides) {
    const branch = analyzeBranch(b, root, side, cfg, connected);
    const threatened = branch.adjacent >= cfg.junctionThreat;
    const worth = branchWorthClearing(branch, cfg) ||
      (threatened && branch.reconnectable === false && branch.cost > 0);
    if (!worth) {
      state.skippedBranches += 1;
      continue;
    }
    const send = computePush(b, root, side, 1);
    const need = Math.max(cfg.branchReserve, branch.cost + cfg.branchReserve);
    if (send < need) continue;
    if (send > wave * cfg.branchShare) continue;
    const remaining = wave - send;
    if (remaining < mainNeed) continue;
    const kindScore = branch.building?.kind === 'crown' ? 300 : branch.building ? 120 : 60;
    const score = kindScore - branch.depth * 2 - need * 0.1 + (threatened ? 40 : 0);
    if (!best || score > best.score) {
      best = { side, branch, send, score, goal: branch.building?.at ?? -1 };
    }
  }
  if (!best) return null;
  const action = h.safeMove(b, root, best.side, 'blitz-split', [1]);
  if (!action) return null;
  state.splits += 1;
  state.lastSplitTurn = b.turn;
  // The detachment restarts the main-route half-push count.
  state.halfAt = -1;
  state.halfPushes = 0;
  state.detach = { at: best.side, goal: best.goal, started: b.turn, stall: 0, turns: 0 };
  return { action, branch: 'blitz-fork' };
}

// A cut corridor freezes the whole forward column (the engine rejects moves
// from isolated cells) and halves it once, so a frozen wave is worth one
// action to reconnect: the recaptured bridge also doubles the trapped army
// back.  The bridge must really reconnect, verified with the real
// connectivity rule, not with proximity.
function rescueCut(b, own, state, h, cfg) {
  const root = state.root;
  if (!b.own(root) || !b.isolated[root]) return null;
  const trapped = new Set([root]);
  const queue = [root];
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of b.neighbors(queue[head])) {
      if (trapped.has(next) || !b.own(next) || !b.isolated[next]) continue;
      trapped.add(next);
      queue.push(next);
    }
  }
  const candidates = [];
  for (const from of own) {
    if (b.isolated[from] || !b.own(from) || b.army[from] <= 1) continue;
    for (const to of b.neighbors(from)) {
      if (!b.enemy(to) || b.isolated[to]) continue;
      if (![...b.neighbors(to)].some((next) => trapped.has(next))) continue;
      candidates.push({ from, to, army: b.army[to] });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, z) => a.army - z.army || b.army[z.from] - b.army[a.from]);
  for (const candidate of candidates.slice(0, cfg.rescueScan)) {
    const action = h.safeMove(b, candidate.from, candidate.to, 'cut');
    if (!action) continue;
    const result = preview(b, action);
    if (!result.ok || !result.captured) continue;
    const connected = connectedSet(result.after, b.playerId);
    if (!connected.has(root)) continue;
    return { action, branch: 'blitz-rescue' };
  }
  return null;
}

function pushDecision(b, m, own, h, state, cfg) {
  const detached = advanceDetach(b, m, state, cfg, h);
  if (detached) return detached;
  // A cut corridor freezes the column in place, so repairing the cut is worth
  // one action before anything else; if no rear stack can reconnect it, the
  // trapped stack can never move again and a new root is the only option.
  if (Number.isInteger(state.root) && b.own(state.root) && b.isolated[state.root]) {
    if (!state.frozenAt) state.frozenAt = b.turn;
    state.frozen = (state.frozen || 0) + 1;
    const rescue = rescueCut(b, own, state, h, cfg);
    if (rescue) return rescue;
    if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') console.error('ABANDON', b.turn, state.root, b.army[state.root]);
    state.abandons = (state.abandons || 0) + 1;
    const forward = Number.isInteger(state.crown) && b.enemy(state.crown)
      ? forwardStack(b, own, state.crown, h)
      : -1;
    const strongest = forward >= 0
      ? forward
      : own.reduce((best, at) => (b.army[at] > b.army[best] ? at : best), own[0]);
    // A trapped column leaves no usable wave. Do not burn the rest of the
    // game marching a token stack down the same corridor: hand the board back
    // to the default maze planner (the layer stays additive).
    if (state.abandons >= cfg.abandonLimit || b.army[strongest] < Math.max(100, waveFloor(b.size, cfg) * 0.4)) {
      state.phase = 'done';
      return null;
    }
    state.root = strongest;
    state.halfAt = -1;
    state.halfPushes = 0;
    state.stall = 0;
  }
  if (!Number.isInteger(state.root) || !b.own(state.root) || b.army[state.root] <= 1) {
    const forward = Number.isInteger(state.crown) && b.enemy(state.crown)
      ? forwardStack(b, own, state.crown, h)
      : -1;
    state.root = forward >= 0
      ? forward
      : own.reduce((best, at) => (b.army[at] > b.army[best] ? at : best), own[0]);
    state.halfAt = -1;
    state.halfPushes = 0;
    state.stall = 0;
  }
  if (!(Number.isInteger(state.crown) && b.enemy(state.crown) && b.kind(state.crown) === 'crown')) {
    state.crown = pickCrown(b, m, own, state, h);
    if (state.crown < 0) {
      state.phase = 'done';
      return null;
    }
    state.forward = null;
    state.halfAt = -1;
    state.halfPushes = 0;
  }
  const f = h.field(b, [state.crown]);
  const path = h.route(f, state.root);
  if (!path || path.length < 2) {
    const action = h.safeMove(b, state.root, state.crown, 'blitz-push', [2, 1]);
    if (action) {
      state.prev = state.root;
      state.root = state.crown;
      state.stall = 0;
      return { action, branch: 'blitz-strike' };
    }
    state.stall += 1;
    return null;
  }
  const need = routeNeed(b, path, state.crown, h, cfg);
  const mainNeed = routeNeed(b, path.slice(1), state.crown, h, cfg).need;
  const split = splitDecision(b, state, path, mainNeed, cfg, h);
  if (split) return split;
  const moved = march(b, state, path, cfg, h);
  if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') console.error('PUSH', b.turn, state.root, b.army[state.root], path.slice(0,3), moved ? [moved.action.x, moved.action.y, moved.action.dx, moved.action.dy, moved.action.mode] : null);
  if (moved) {
    const { next, advance, count, ...decision } = moved;
    if (advance) {
      state.prev = state.root;
      state.root = next;
      state.halfAt = -1;
      state.halfPushes = 0;
      state.peakWave = Math.max(state.peakWave, b.army[next]);
    } else {
      // The main wave committed only half this tick; keep the junction as the
      // root so the following ticks push the next halves through it.
      state.halfAt = state.root;
      state.halfPushes = count;
    }
    state.stall = 0;
    return decision;
  }
  // The corridor head is too strong for the current column. Pull the rear in
  // (this is also how a returning fork detachment rejoins) before retrying.
  state.stall += 1;
  if (state.stall >= cfg.stallLimit) {
    state.blocked.push(state.crown);
    state.stall = 0;
    state.detach = null;
    state.crown = pickCrown(b, m, own, state, h);
    if (state.crown < 0) {
      state.phase = 'done';
      return null;
    }
    return { action: null, branch: 'blitz-retarget' };
  }
  const delivery = h.gather(b, m, state.root, b.army[state.root] + 40, 'blitz-rejoin');
  if (delivery) return delivery;
  return { action: null, branch: 'blitz-push-wait' };
}

function musterDecision(b, m, own, enemies, h, state, cfg) {
  if (!(Number.isInteger(state.crown) && b.enemy(state.crown) && b.kind(state.crown) === 'crown')) {
    state.crown = pickCrown(b, m, own, state, h);
    state.root = -1;
  }
  if (state.crown < 0) return expandDecision(b, m, own, h, state);
  if (!Number.isInteger(state.root) || !b.own(state.root) || b.isolated[state.root]) {
    state.root = launchCell(b, own, state.crown, h);
    state.halfAt = -1;
    state.halfPushes = 0;
    m.delivery = null;
  }
  if (state.root < 0) return expandDecision(b, m, own, h, state);
  const f = h.field(b, [state.crown]);
  const path = h.route(f, state.root);
  if (!path || path.length < 2) {
    state.phase = 'push';
    return pushDecision(b, m, own, h, state, cfg);
  }
  const need = routeNeed(b, path, state.crown, h, cfg);
  const wave = b.army[state.root];
  const floor = waveFloor(b.size, cfg);
  // The full route resistance is unbounded (a 0.68 corridor can hold thousands
  // of enemy army), so it is only used as the gather target, capped at a
  // multiple of the board floor.
  const gate = Math.max(floor, Math.min(need.need, floor * cfg.gateCap));
  const remaining = gatherableMass(b, own, state.root);
  state.peakWave = Math.max(state.peakWave, wave);
  // Launch as soon as the wave clears the board floor and a route exists.  The
  // resistance estimate must not hold a wave that is already bigger than what
  // the corridor can meet: a 759-unit column waiting for a two-thousand-army
  // "need" is the missed window from the replays.  The only veto is a home
  // crown that one enemy push can take on this tick.
  const viable = !homeCrownExposed(b, m);
  const ready = wave >= floor;
  const exhausted = wave >= floor * 0.7 && remaining <= Math.max(40, wave * 0.2);
  const deadline = b.turn >= cfg.latestLaunch && wave >= floor * 0.6;
  if (viable && (ready || exhausted || deadline)) {
    state.phase = 'push';
    state.launches += 1;
    return pushDecision(b, m, own, h, state, cfg);
  }
  const delivery = h.gather(b, m, state.root, gate, 'blitz-muster');
  if (delivery) return delivery;
  return expandDecision(b, m, own, h, state);
}

function mazeBlitzPlan(b, m, own, enemies, h, cfg = mazeBlitzConfig()) {
  if (!cfg.enabled || !own.length) return null;
  if (String(m?.mapMode || '') !== 'maze') return null;
  const state = m.blitz || (m.blitz = initialState());
  if (state.phase === 'done') return null;
  // Expansion phase: no construction at all, the burst window rewards cell
  // count and nothing else.
  if (state.phase === 'expand') {
    if (b.turn <= cfg.openingEnd) return expandDecision(b, m, own, h, state);
    state.phase = 'muster';
    m.delivery = null;
  }
  // Defence still owns threatened ticks while the column is being assembled.
  // Once it is committed the wave must keep moving; the plan's own anchor
  // guard (above this layer) still catches a lethal strike on a home crown.
  if (state.phase !== 'push') {
    const defend = h.defense(b, m, own);
    if (defend) return defend;
  }
  if (state.phase === 'muster') return musterDecision(b, m, own, enemies, h, state, cfg);
  return pushDecision(b, m, own, h, state, cfg);
}

module.exports = {
  BURST_END_TURN,
  mazeBlitzConfig,
  blitzEligible,
  mazeBlitzPlan,
  waveFloor,
  pathResistance,
  routeNeed,
  enemyGuard,
  gatherableMass,
  forkDegree,
  allPushSafe,
  forwardStack,
  homeCrownExposed,
  launchCell,
  analyzeBranch,
  branchWorthClearing,
  initialState,
};
