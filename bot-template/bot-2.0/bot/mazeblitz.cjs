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
 * Dead/live branch rule (strong form): a side branch is dead when, with the
 * junction removed, the opponent cannot reconnect it to any anchor.  That is a
 * real connectivity test, not "is it currently isolated": the branch is
 * flooded with the junction blocked, and it is live only when a cell inside
 * that flood is still in its owner's engine `connectedSet` (a real path of
 * enemy-held cells back to an enemy crown/city that does not cross the
 * junction), or when fog hides part of it.  A plain passable route that would
 * have to fight through our own territory is not a reconnection.  Everything
 * else - including a branch with another external exit that leads nowhere -
 * is dead: its stacks are cut off, the engine freezes isolated cells, and a
 * trapped stack can never push back out.  A dead branch therefore never earns
 * a half-push tick or a detachment; the main wave goes fully into the live
 * direction.
 *
 * Junction rule: at a live fork the main-route transit uses half pushes
 * (mode 1), repeated up to three times, so 1/2 + 1/4 + 1/8 = 7/8 of the wave
 * moves up while a real 1/8 guard holds the junction.  The smart split
 * (mode 0) is never used there: it reserves only the other hostile neighbours'
 * army, which is the token guard an adjacent anti stack cuts on the next tick.
 *
 * Capture rule: taking a crown/city defaults to the half push, which still
 * kills the garrison in one tick and leaves 1/2 on the junction.  A full push
 * (mode 2) is the exception: only when half cannot take the garrison (the
 * target is one cell away, so the exchange is decided now) and the generic
 * guard accepts the tail it would leave behind.
 *
 * Fork rule: a side branch is only worth clearing when it is live and holds a
 * building.  A dead branch decays by itself; the held junction is enough, so
 * the main wave keeps moving instead of spending ticks in a dead end.
 *
 * `mazeBlitzPlan` receives the planner helpers it needs from `planner.cjs` so
 * this module never imports the planner (no require cycle).
 */

const { connectedSet } = require('./board.cjs');
const { actionCoordinates, computePush, preview } = require('./rules.cjs');

// Engine fact: the global burst runs from tick 26 through tick 50 inclusive.
const BURST_END_TURN = 50;

// A wave head below this cannot lead: the body has to take the wave over.
const STACK_MIN = 8;

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
  // Node budget for the dead/live flood and the enemy force walk.  Both are
  // real graph searches, so the cap only protects against pathological boards.
  branchScan: 240,
  // A crown/city garrison above its defensive reserve joins the wave.  The
  // reserve is the floor a home anchor keeps: it still has to survive the
  // adjacent stack and anything that lands two ticks out.
  anchorReserve: 20,
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
    branchScan: envNumber('APEX_MAZE_BLITZ_BRANCH_SCAN', DEFAULTS.branchScan, 8, 20000),
    anchorReserve: envNumber('APEX_MAZE_BLITZ_ANCHOR_RESERVE', DEFAULTS.anchorReserve, 1, 4000),
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

/**
 * Flood one fork branch with the junction removed.  This is a real
 * connectivity test: everything reachable here can only be entered through the
 * junction we already hold, so it is the branch's whole world once the
 * junction is ours.
 */
function branchRegion(b, root, first) {
  const region = new Set([first]);
  const queue = [first];
  let fogged = false;
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head];
    if (!b.visible[at]) fogged = true;
    for (const next of b.neighbors(at)) {
      if (next === root || region.has(next) || !b.passable(next)) continue;
      region.add(next);
      queue.push(next);
    }
  }
  return { region, fogged };
}

// A stack that can still push.  An anchor grows every tick, so it counts even
// at one soldier.
function pushCapable(b, at) {
  if (b.isolated[at]) return false;
  if (b.army[at] > 1) return true;
  const kind = b.kind(at);
  return kind === 'crown' || kind === 'city';
}

/**
 * Is the branch still tied to one of its anchors?  A cell only counts when it
 * is in its owner's engine `connectedSet`, i.e. when there is a path of
 * enemy-held cells back to an enemy crown/city that does not cross the
 * junction.  A plain passable flood is not enough: a branch whose only route
 * out crosses our own territory is dead, because the enemy would have to fight
 * through the ground we hold to reconnect it.
 */
function branchAnchored(b, region) {
  const byOwner = new Map();
  for (const at of region) {
    if (!b.enemy(at)) continue;
    const owner = b.owner(at);
    let linked = byOwner.get(owner);
    if (!linked) {
      linked = connectedSet(b, owner);
      byOwner.set(owner, linked);
    }
    if (linked.has(at)) return true;
  }
  return false;
}

/**
 * Walk one fork branch and report what it contains.
 *
 * Dead / live is the strong definition: remove the junction, flood the branch,
 * and ask whether the opponent can still reconnect it to an anchor.  Live only
 * when an enemy city/crown sits in the flood, an enemy stack in the flood can
 * force its way to the trapped cluster, or fog hides part of it.  A branch
 * whose other exit leads nowhere is dead even though it is not "a dead end":
 * the enemy force cannot come back in without passing the held junction.
 */
function analyzeBranch(b, root, first, cfg) {
  const { region, fogged } = branchRegion(b, root, first);
  const anchored = branchAnchored(b, region);
  const reconnectable = fogged || anchored;
  const seen = new Set([root, first]);
  const nodes = [{ at: first, depth: 0, cost: b.enemy(first) ? b.army[first] + 1 : 0 }];
  let building = null;
  for (let head = 0; head < nodes.length; head += 1) {
    const node = nodes[head];
    const at = node.at;
    if (b.enemy(at)) {
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
    anchored,
    fogged,
    cost: building ? building.cost : 0,
    reach: nodes.length,
  };
}

/**
 * The passable side branches of a junction, each classified dead/live.  Our own
 * cells are the rear, not a branch, and the transit target is excluded.
 */
function junctionSides(b, root, next, skip, cfg) {
  const sides = [];
  for (const side of b.neighbors(root)) {
    if (side === next || side === skip) continue;
    if (!b.passable(side) || b.own(side)) continue;
    sides.push({ at: side, branch: analyzeBranch(b, root, side, cfg) });
  }
  return sides;
}

// A live side branch means the junction has a genuine reconnection threat.
function junctionLive(sides) {
  return sides.some((side) => side.branch.reconnectable);
}

function branchWorthClearing(branch, cfg) {
  if (!branch) return false;
  // A dead branch has nothing to destroy and cannot be reinforced: holding the
  // junction is enough, so keep the main wave moving.
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

/**
 * Re-seat the wave on the forward side.
 *
 *  1. A real stack (>= STACK_MIN) inside the forward band of the front cell
 *     wins: that is the head, and the rear gathers into it.
 *  2. Otherwise the wave's *body* takes over - the largest stack of the same
 *     own-connected component.  That is the recovery the old "largest stack
 *     anywhere" fallback provided when a half push dumped the head and left
 *     the mass behind, but it can no longer jump across a cut, which is what
 *     promoted the rear home crown and reversed the path.
 *  3. With no stack in the front component at all, return -1: the caller
 *     holds its objective instead of walking the rear mass up the corridor.
 */
function forwardStack(b, own, crown, h, slack = 3) {
  const f = h.field(b, [crown]);
  const cells = [];
  for (const at of own) {
    if (b.isolated[at]) continue;
    const distance = f.distance[at];
    if (Number.isFinite(distance)) cells.push({ at, distance, army: b.army[at] });
  }
  if (!cells.length) return -1;
  const staging = cells.filter((cell) => cell.distance >= 2);
  const pool = staging.length ? staging : cells;
  const frontCell = pool.reduce((best, cell) =>
    cell.distance < best.distance || (cell.distance === best.distance && cell.army > best.army) ? cell : best,
  pool[0]);
  const comp = ownComponent(b, frontCell.at);
  const stacks = cells.filter((cell) => comp.has(cell.at) && cell.army > 1);
  if (!stacks.length) return -1;
  const front = Math.min(...stacks.map((cell) => cell.distance));
  const band = stacks.filter((cell) => cell.distance <= front + slack);
  band.sort((a, z) => z.army - a.army || a.distance - z.distance || a.at - z.at);
  if (band[0].army >= STACK_MIN) return band[0].at;
  stacks.sort((a, z) => z.army - a.army || a.distance - z.distance || a.at - z.at);
  return stacks[0].at;
}

// Own-anchor connectivity, not proximity: cells joined through our own live
// territory.  A component cannot receive a delivery from another one, so a rear
// crown cut off from the front must never be offered as the rally.
function ownComponent(b, start) {
  const comp = new Set();
  if (!b.own(start) || b.isolated[start]) return comp;
  comp.add(start);
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of b.neighbors(queue[head])) {
      if (comp.has(next) || !b.own(next) || b.isolated[next]) continue;
      comp.add(next);
      queue.push(next);
    }
  }
  return comp;
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

// Staging must sit on the forward side of the attack axis.  Scan outward in
// two-cell bands and stop at the first band that actually holds a stack: that
// is the forward-most mass, and the rear gathers into it instead of the front
// walking back.  The scan is restricted to the own-connected component of the
// front cell: after a frontier cut the home crown is a *different* component,
// and promoting it is exactly the rear re-seat that reversed the path.
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
  const start = cells.find((cell) => cell.distance === nearest).at;
  const comp = ownComponent(b, start);
  const local = cells.filter((cell) => comp.has(cell.at));
  if (!local.length) return start;
  const nearestLocal = Math.min(...local.map((cell) => cell.distance));
  const largest = (pool) => pool.reduce((best, cell) =>
    cell.army > best.army || (cell.army === best.army && cell.distance < best.distance) ? cell : best,
  pool[0]);
  // Cells adjacent to the target are contact, not staging; only use them when
  // the connected part has nothing else.
  for (let band = nearestLocal; band <= nearestLocal + 60; band += 2) {
    const inside = local.filter((cell) => cell.distance <= band + 1);
    const staging = inside.filter((cell) => cell.distance >= 2);
    const stack = largest(staging.length ? staging : inside);
    if (stack && stack.army > 1) return stack.at;
  }
  const staging = local.filter((cell) => cell.distance >= 2);
  const pool = staging.length ? staging : local;
  return pool.reduce((best, cell) =>
    cell.distance < best.distance || (cell.distance === best.distance && cell.army > best.army) ? cell : best,
  pool[0]).at;
}

/**
 * A crown/city keeps a real defensive reserve: the strongest adjacent enemy
 * stack plus the force that lands two ticks out (anchors grow every tick, so a
 * lone soldier there still counts).  Everything above the reserve belongs to
 * the super-wave instead of sitting at home.
 */
function anchorReserve(b, h, at, floor = DEFAULTS.anchorReserve) {
  if (!['crown', 'city'].includes(b.kind(at))) return 0;
  let reserve = Math.max(1, floor);
  for (const next of b.neighbors(at)) {
    if (b.enemy(next) && !b.isolated[next]) reserve = Math.max(reserve, b.army[next]);
  }
  if (h?.enemyEta && h?.etaArrival) {
    const eta = h.enemyEta(b);
    reserve = Math.max(reserve, h.etaArrival(eta, at) + 1);
  }
  return reserve;
}

/**
 * Forward gathering.
 *
 * The source selection is the proven generic gather (one stack per tick along
 * the own-cell route toward the rally), with three corrections on top:
 *
 *   1. the rally is re-seated forward before the gather runs: if a real stack
 *      is closer to the target crown than the root, the root moves up to it.
 *      That is what stops a forward stack from being walked back.
 *   2. a step that would increase the distance to the target crown is refused.
 *      The t28.5-33 back-and-forth was the rally jumping to a rear pack cell
 *      after a frontier cut and then pulling the front back; the stack now
 *      holds, and the rally moves up to it instead.
 *   3. an anchor (crown/city) keeps its defensive reserve when it contributes:
 *      above the reserve its surplus joins the wave, below it the move is
 *      refused so the anchor is never drained to a token garrison.
 */
function blitzGather(b, m, own, state, crown, need, cfg, h, reason) {
  if (!Number.isInteger(crown) || crown < 0) return null;
  if (!b.own(state.root) || b.isolated[state.root]) return null;
  const cf = h.field(b, [crown]);
  const forward = forwardStack(b, own, crown, h);
  if (forward >= 0 && Number.isFinite(cf.distance[forward]) &&
    (!Number.isFinite(cf.distance[state.root]) || cf.distance[forward] < cf.distance[state.root])) {
    if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') {
      console.error('RESEAT-FWD', b.turn, state.root, '->', forward, cf.distance[state.root], cf.distance[forward]);
    }
    state.root = forward;
    state.halfAt = -1;
    state.halfPushes = 0;
    m.delivery = null;
  }
  if (b.army[state.root] >= need) {
    m.delivery = null;
    return null;
  }
  const decision = h.gather(b, m, state.root, need, reason);
  if (!decision) return null;
  const action = decision.action;
  if (!action || action.kind !== 'attack') return decision;
  const from = b.idx(action.x, action.y);
  const to = b.idx(action.dx, action.dy);
  if (!Number.isFinite(cf.distance[from]) || cf.distance[to] > cf.distance[from]) {
    // The generic gather wanted to walk this stack back down the corridor.
    // Hold it; the rally re-seats on it next tick instead of reversing.
    if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') {
      console.error('HOLD-BACK', b.turn, from, '->', to, cf.distance[from], '->', cf.distance[to]);
    }
    m.delivery = null;
    return null;
  }
  const reserve = anchorReserve(b, h, from, cfg.anchorReserve);
  if (reserve > 0) {
    const send = computePush(b, from, to, action.mode ?? 0);
    if (b.army[from] - send < reserve) {
      // The anchor would be drained below its reserve: send half instead.
      const half = computePush(b, from, to, 1);
      const alt = actionCoordinates(b, from, to, 1);
      if (half > 0 && b.army[from] - half >= reserve && preview(b, alt).ok) {
        return { action: alt, branch: reason };
      }
      m.delivery = null;
      return null;
    }
  }
  return decision;
}

function expandDecision(b, m, own, h, state, cfg = mazeBlitzConfig()) {
  const enemies = [];
  for (let at = 0; at < b.size; at += 1) if (b.enemy(at) && !b.isolated[at]) enemies.push(at);
  const ed = h.field(b, enemies);
  const opened = h.mazeOpening(b, m, own, ed) || h.opening(b, m, own, ed);
  if (opened) return { ...opened, branch: 'blitz-expand' };
  return { action: null, branch: 'blitz-expand-wait' };
}

/**
 * Rule: the main-route transit is only a half push when a side branch can still
 * reconnect.  A dead branch never earns the three half-push ticks: the wave
 * goes fully into the live direction.  Mode 0 is never tried (its reserve is a
 * token guard, not a hold).
 */
function pushModes(b, root, next, live) {
  const building = !b.friendly(next) && ['crown', 'city'].includes(b.kind(next));
  const half = computePush(b, root, next, 1);
  if (building) {
    // Captures default to the half push: it still kills the garrison in one
    // tick and leaves a real guard behind.  A full push is the exception, for
    // the case where half cannot take the garrison at all (the target is one
    // cell away, so that exchange is decided now).
    if (half > b.army[next]) return [1];
    return computePush(b, root, next, 2) > b.army[next] ? [2, 1] : [1];
  }
  return live ? [1] : [2, 1];
}

/**
 * A push the generic guard refuses only because it still counts a dead branch
 * as a live threat.  The move is still proven: legal, capturing, and the
 * captured head stays connected to our anchors (the engine freezes a column
 * that its own push cuts).
 */
function directPush(b, root, next, mode) {
  const action = actionCoordinates(b, root, next, mode);
  const result = preview(b, action);
  if (!result.ok) return null;
  if (b.enemy(next) && !result.captured) return null;
  const connected = connectedSet(result.after, b.playerId);
  return connected.has(next) ? action : null;
}

// Main-route transit.  At a live fork a half push keeps a real guard and is
// repeated up to `cfg.halfPushes` times (7/8 forward, 1/8 on the junction).
// With every side branch dead the wave commits fully instead.
function march(b, state, path, cfg, h) {
  const root = state.root;
  const next = path[1];
  const fork = forkDegree(b, root) >= 3;
  const sides = junctionSides(b, root, next, -1, cfg);
  const live = junctionLive(sides);
  // The guard only ever bypasses the generic push guard when every side branch
  // is structurally dead: there the enemy really cannot touch the tail.  A
  // live branch that is merely far away still goes through `safeMove`.
  const deadOnly = sides.every((side) => !side.branch.reconnectable);
  const modes = pushModes(b, root, next, live);
  let action = null;
  let mode = -1;
  for (const candidate of modes) {
    // The generic guard still charges us for a structurally dead branch, so a
    // dead junction may verify the same push directly before falling back to a
    // weaker mode.  Mode order is preserved: a half-sufficient capture stays a
    // half push even when the full push would also be legal.
    let attempt = h.safeMove(b, root, next, 'blitz-push', [candidate]);
    if (!attempt && deadOnly) attempt = directPush(b, root, next, candidate);
    if (!attempt) continue;
    action = attempt;
    mode = candidate;
    break;
  }
  if (!action) return null;
  if (process.env.APEX_MAZE_BLITZ_DEBUG === '1' && fork) {
    console.error('JUNCTION', b.turn, 'root', root, 'army', b.army[root], 'mode', action.mode,
      'live', live, 'sides', sides.map((side) => `${side.at}:${side.branch.reconnectable ? 'live' : 'dead'}:${b.isolated[side.at] ? 'iso' : 'free'}:${b.army[side.at]}`).join(','));
  }
  // Repeated half pushes only make sense on a real fork, and a capture at a
  // fork stays in the ladder too: the captured cell is ours from the next tick
  // on, so halving into it moves the rest of the wave through instead of
  // stranding half the column on the junction.
  const holding = fork && live && mode === 1;
  const count = holding ? (state.halfAt === root ? state.halfPushes : 0) + 1 : 0;
  return {
    action,
    branch: b.enemy(next) ? 'blitz-break' : 'blitz-march',
    next,
    mode,
    live,
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
  const sides = junctionSides(b, root, next, state.prev, cfg);
  if (!sides.length) return null;
  const wave = b.army[root];
  let best = null;
  for (const side of sides) {
    const branch = side.branch;
    // Rule A: an unreachable branch is dead.  Its stacks are already cut off
    // and the engine freezes them, so they are never worth a tick.
    const worth = branchWorthClearing(branch, cfg);
    if (!worth) {
      state.skippedBranches += 1;
      continue;
    }
    const threatened = branch.adjacent >= cfg.junctionThreat;
    const send = computePush(b, root, side.at, 1);
    const need = Math.max(cfg.branchReserve, branch.cost + cfg.branchReserve);
    if (send < need) continue;
    if (send > wave * cfg.branchShare) continue;
    const remaining = wave - send;
    if (remaining < mainNeed) continue;
    const kindScore = branch.building?.kind === 'crown' ? 300 : branch.building ? 120 : 60;
    const score = kindScore - branch.depth * 2 - need * 0.1 + (threatened ? 40 : 0);
    if (!best || score > best.score) {
      best = { side: side.at, branch, send, score, goal: branch.building?.at ?? -1 };
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
  // one action before anything else.  While the front is cut the objective and
  // the root stay where they are: the repair is aimed at the trapped column,
  // and no rear cell is promoted while the front can still be reconnected.
  if (Number.isInteger(state.root) && b.own(state.root) && b.isolated[state.root]) {
    if (!state.frozenAt) state.frozenAt = b.turn;
    state.frozen = (state.frozen || 0) + 1;
    const rescue = rescueCut(b, own, state, h, cfg);
    if (rescue) return rescue;
    state.abandons = (state.abandons || 0) + 1;
    // Hold the objective and the root while the cut is fresh: the trapped
    // column pays one half only, and a nearby stack may still reopen it.  The
    // root is NOT re-seated to whatever stack happens to be largest - that is
    // the rear fallback that produced the t28.5-33 backward walk.
    if (state.abandons < cfg.abandonLimit) {
      if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') console.error('HOLD-CUT', b.turn, state.root, state.abandons);
      return { action: null, branch: 'blitz-hold' };
    }
    if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') console.error('ABANDON', b.turn, state.root, b.army[state.root]);
    // The trapped column is really gone.  Take over from a forward, connected
    // stack only; if there is none (or it is a token), hand the board back to
    // the default planner instead of walking a rear stack up the same corridor.
    const forward = Number.isInteger(state.crown) && b.enemy(state.crown)
      ? forwardStack(b, own, state.crown, h)
      : -1;
    if (forward < 0 || b.army[forward] < Math.max(100, waveFloor(b.size, cfg) * 0.4)) {
      state.phase = 'done';
      return null;
    }
    state.root = forward;
    state.halfAt = -1;
    state.halfPushes = 0;
    state.stall = 0;
  }
  const crownReady = Number.isInteger(state.crown) && b.enemy(state.crown) && b.kind(state.crown) === 'crown';
  if (!Number.isInteger(state.root) || !b.own(state.root) || b.army[state.root] <= 1) {
    const forward = crownReady ? forwardStack(b, own, state.crown, h) : -1;
    state.root = forward >= 0
      ? forward
      : launchCell(b, own, state.crown, h);
    state.halfAt = -1;
    state.halfPushes = 0;
    state.stall = 0;
  } else if (crownReady && b.army[state.root] < STACK_MIN) {
    // The head was dumped by a half push and left a token behind.  A two or
    // four soldier root cannot push, so the body takes the wave over (same
    // own-connected component only).
    const body = forwardStack(b, own, state.crown, h);
    if (body >= 0 && b.army[body] > b.army[state.root] * 2) {
      state.root = body;
      state.halfAt = -1;
      state.halfPushes = 0;
      state.stall = 0;
      return pushDecision(b, m, own, h, state, cfg);
    }
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
  const delivery = blitzGather(b, m, own, state, state.crown, b.army[state.root] + 40, cfg, h, 'blitz-rejoin');
  if (delivery) return delivery;
  return { action: null, branch: 'blitz-push-wait' };
}

function musterDecision(b, m, own, enemies, h, state, cfg) {
  if (!(Number.isInteger(state.crown) && b.enemy(state.crown) && b.kind(state.crown) === 'crown')) {
    state.crown = pickCrown(b, m, own, state, h);
    state.root = -1;
  }
  if (state.crown < 0) return expandDecision(b, m, own, h, state, cfg);
  if (!Number.isInteger(state.root) || !b.own(state.root) || b.isolated[state.root]) {
    state.root = launchCell(b, own, state.crown, h);
    state.halfAt = -1;
    state.halfPushes = 0;
    m.delivery = null;
  }
  if (state.root < 0) return expandDecision(b, m, own, h, state, cfg);
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
  if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') {
    console.error('MUSTER', b.turn, 'root', state.root, 'wave', wave, 'floor', floor, 'gate', gate,
      'remaining', remaining, 'dist', f.distance[state.root]);
  }
  const delivery = blitzGather(b, m, own, state, state.crown, gate, cfg, h, 'blitz-muster');
  if (delivery) return delivery;
  return expandDecision(b, m, own, h, state, cfg);
}

function mazeBlitzPlan(b, m, own, enemies, h, cfg = mazeBlitzConfig()) {
  if (!cfg.enabled || !own.length) return null;
  if (String(m?.mapMode || '') !== 'maze') return null;
  const state = m.blitz || (m.blitz = initialState());
  if (state.phase === 'done') return null;
  // Expansion phase: no construction at all, the burst window rewards cell
  // count and nothing else.
  if (state.phase === 'expand') {
    if (b.turn <= cfg.openingEnd) return expandDecision(b, m, own, h, state, cfg);
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
  forwardStack,
  ownComponent,
  homeCrownExposed,
  launchCell,
  analyzeBranch,
  branchWorthClearing,
  branchRegion,
  branchAnchored,
  junctionSides,
  junctionLive,
  pushModes,
  directPush,
  anchorReserve,
  blitzGather,
  initialState,
};
