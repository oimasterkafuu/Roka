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
 *   2. muster - the very first post-burst tick the plan gathers; there is no
 *      lingering expansion once anything can be gathered.  The board is pulled
 *      into one forward launch cell (never a deep rear cell: a rear rally
 *      sends every front stack backwards along the corridor).  Gathering is
 *      all-in: every stack, including a crown/city garrison, sends all but its
 *      single engine-minimum soldier, and a rally that already holds the wave
 *      never short-circuits the crown surplus out of the column.  An anchor
 *      (crown/city) surplus is pulled before the rolling chain: the chain is
 *      always the nearest, fattest route and would otherwise out-score a
 *      distant crown forever, so the crown garrison was never spent.
 *   3. push - march that single column at the nearest reachable crown and
 *      destroy crown > city > plain on the way.  A quiet tick is allowed once;
 *      a second consecutive tick without a move repairs, advances the body, or
 *      hands the plan back - a frozen column is never acceptable.
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
 * Junction rule: only a branch with a *live enemy threat* earns a guard.  A
 * branch is live when the opponent can reconnect it AND an enemy stack on that
 * side can reach the junction within two ticks (the only force that can cut the
 * tail).  The road ahead and a neutral corridor with no army in it are not
 * threats: there is nothing there to cut us with, so the wave commits fully.
 * At a live fork the transit uses half pushes (mode 1), repeated up to three
 * times, so 1/2 + 1/4 + 1/8 = 7/8 of the wave moves up while a real 1/8 guard
 * holds the junction.  The smart split (mode 0) is never used there: it
 * reserves only the other hostile neighbours' army, which is the token guard
 * an adjacent anti stack cuts on the next tick.
 *
 * Push-mode policy: the main wave pushes fully (mode 2) by default, captures
 * included.  A capture away from a fork keeps nothing back - the v4 rule that
 * defaulted every capture to the half push left a useless 1/2 behind on plain
 * road (t143/t144.5 in the reviewed replay).  The half push (mode 1) exists for
 * exactly one situation: leaving a junction whose live branch can cut the tail
 * within two ticks.  There it is repeated up to `halfPushes` times and a
 * capture the half cannot take is simply not attempted.  Mode 0 is never used
 * on the main route.
 *
 * Crown-join rule: while the wave is still gathering, an own crown or city with
 * more than the engine minimum is pulled first.  The chain below it always
 * scores higher (short route, fat pile), so without this priority the garrison
 * was never spent and the wave that launched was one garrison short.
 *
 * Recall rule: a stack that still has a cheap forward kill (an adjacent enemy
 * cell it can take with a half push that is forward on the target axis) is not
 * recalled into the gather while any other source exists; the reserve that is
 * needed elsewhere is a different stack.  The junction guard size itself is a
 * separate tradeoff and is deliberately left as-is for now (see BASELINE.md).
 *
 * Cut rule: a cut never abandons the wave.  The plan first tries to repair the
 * cut, then hands the rally to the forward cell of the component that holds
 * the mass (`waveAnchorRoot`); the objective crown is never re-picked and no
 * stack is walked backwards to a rear seat.
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

// A crown/city surplus above this is pulled into the wave before the chain.
const CROWN_JOIN = 6;

const DEFAULTS = Object.freeze({
  smallFloor: 340,
  largeFloor: 520,
  commitMargin: 1.15,
  launchReserve: 20,
  branchDepth: 14,
  branchShare: 0.55,
  branchReserve: 24,
  junctionThreat: 12,
  // Node budget for the dead/live flood and the enemy force walk.  Both are
  // real graph searches, so the cap only protects against pathological boards.
  branchScan: 240,
  halfPushes: 3,
  stallLimit: 10,
  detachStall: 4,
  splitCooldown: 6,
  rescueScan: 6,
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
    branchDepth: envNumber('APEX_MAZE_BLITZ_BRANCH_DEPTH', DEFAULTS.branchDepth, 1, 60),
    branchShare: envNumber('APEX_MAZE_BLITZ_BRANCH_SHARE', DEFAULTS.branchShare, 0, 1),
    branchReserve: DEFAULTS.branchReserve,
    junctionThreat: envNumber('APEX_MAZE_BLITZ_JUNCTION', DEFAULTS.junctionThreat, 0, 4000),
    branchScan: envNumber('APEX_MAZE_BLITZ_BRANCH_SCAN', DEFAULTS.branchScan, 8, 20000),
    halfPushes: envNumber('APEX_MAZE_BLITZ_HALF_PUSHES', DEFAULTS.halfPushes, 1, 6),
    stallLimit: DEFAULTS.stallLimit,
    detachStall: DEFAULTS.detachStall,
    splitCooldown: DEFAULTS.splitCooldown,
    rescueScan: DEFAULTS.rescueScan,
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
    idle: 0,
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
  // Only the force on *this* side of the fork can cut the junction guard; the
  // cell we are walking into is the road ahead, not a branch threat, and an
  // army of one cannot push at all (computePush caps at total - 1).
  let adjacent = 0;
  for (const next of b.neighbors(root)) {
    if (next !== first && !region.has(next)) continue;
    if (b.enemy(next)) adjacent = Math.max(adjacent, b.army[next]);
  }
  // A real threat is a stack on this side that can reach the junction within
  // two ticks.  A neutral corridor with no army in it cannot cut us at all.
  let near = 0;
  for (const node of nodes) {
    if (node.depth <= 2 && b.enemy(node.at)) near = Math.max(near, b.army[node.at]);
  }
  const threat = Math.max(adjacent, near);
  const live = reconnectable && (threat > 1 || fogged);
  return {
    at: first,
    building,
    // A branch only earns a guard when the enemy can both reconnect it and cut
    // us with it now: a stack on that side within two ticks is the only force
    // that can take the junction.  A neutral corridor with no army in it has
    // nothing to cut us with, so it is not a threat.
    reconnectable,
    live,
    threat,
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
  return sides.some((side) => side.branch.live);
}

function branchWorthClearing(branch, cfg) {
  if (!branch) return false;
  // A dead branch has nothing to destroy and cannot be reinforced: holding the
  // junction is enough, so keep the main wave moving.  A live branch without
  // an adjacent threat is not worth a detachment either.
  if (!branch.live) return false;
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
  const need = Math.max(resistance * cfg.commitMargin + cfg.launchReserve, guard * 1.35 + cfg.launchReserve);
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
// Only the root's own-connected component can actually deliver, so a stack
// behind a cut is not counted as part of this wave.
function gatherableMass(b, own, root) {
  const comp = ownComponent(b, root);
  let mass = 0;
  for (const at of own) {
    if (at === root || !comp.has(at) || b.isolated[at]) continue;
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
  const frontCell = pool.reduce(
    (best, cell) =>
      cell.distance < best.distance || (cell.distance === best.distance && cell.army > best.army)
        ? cell
        : best,
    pool[0],
  );
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
  const base =
    Number.isInteger(state.root) && b.own(state.root)
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
  const largest = (pool) =>
    pool.reduce(
      (best, cell) =>
        cell.army > best.army || (cell.army === best.army && cell.distance < best.distance) ? cell : best,
      pool[0],
    );
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
  return pool.reduce(
    (best, cell) =>
      cell.distance < best.distance || (cell.distance === best.distance && cell.army > best.army)
        ? cell
        : best,
    pool[0],
  ).at;
}

/**
 * All-in forward gathering.
 *
 * One stack moves per tick along our own territory toward the rally, always as
 * a full push (mode 2), so the source keeps only the single soldier the engine
 * needs to stay legal.  There is deliberately no anchor/home reserve: the maze
 * blitz is an all-in trade, and a crown garrison left behind is exactly the
 * incomplete wave from the replays.
 *
 * The rally only re-seats forward while it cannot lead (a token stack or a lost
 * cell).  A rally that already holds the column is never walked up one cell per
 * tick: doing that scattered the gathered mass again in the previous revision.
 * A stack that is already ahead of the rally is never pulled back down the
 * corridor, so after the first forward re-seat the gather only walks forward.
 */
/**
 * The own component that actually holds the wave.
 *
 * A cut mid-gather must never hand the column to a token on another lane: the
 * rally has to stay with the mass.  The anchor is the largest own stack that is
 * not an anchor building (that is the rolling pile), its own component is the
 * wave's world, and the new rally is the forward-most cell of that component
 * that can still deliver.  Return -1 when no such cell exists, so the caller
 * keeps its objective instead of promoting a rear seat.
 */
function waveAnchorRoot(b, own, crown, h) {
  if (!Number.isInteger(crown) || crown < 0) return -1;
  const cf = h.field(b, [crown]);
  let pile = -1;
  for (const at of own) {
    if (b.isolated[at] || !b.own(at) || b.army[at] <= 1) continue;
    if (b.kind(at) === 'crown' || b.kind(at) === 'city') continue;
    if (pile < 0 || b.army[at] > b.army[pile]) pile = at;
  }
  if (pile < 0) return -1;
  const cells = [];
  for (const at of ownComponent(b, pile)) {
    if (b.army[at] <= 1) continue;
    const distance = cf.distance[at];
    if (Number.isFinite(distance)) cells.push({ at, distance, army: b.army[at] });
  }
  if (!cells.length) return -1;
  // The rally is the nearest real stack of the wave's own component, never a
  // rear seat: a dead-end cell behind the pile held the rally in v4 while the
  // wave grew two cells ahead of it, so the floor was never met at the root and
  // the plan gathered in place for a thousand ticks.  Army only breaks a tie
  // between cells at the same distance, and a token on another lane can never
  // take the rally over.
  const front = Math.min(...cells.map((cell) => cell.distance));
  const near = cells.filter((cell) => cell.distance === front).sort((a, z) => z.army - a.army || a.at - z.at);
  return near[0].at;
}

function componentMass(b, comp) {
  let mass = 0;
  for (const at of comp) mass += b.army[at];
  return mass;
}

/**
 * A cheap forward kill the stack could still take on its own: an adjacent enemy
 * cell it can capture with a half push, where that cell is a building (a
 * crown/city is never a side show) or is forward on the target axis.  Such a
 * stack is the spearhead and must not be recalled into the gather.
 */
function cheapForwardTarget(b, at, cf) {
  const here = Number.isFinite(cf?.distance?.[at]) ? cf.distance[at] : Infinity;
  for (const next of b.neighbors(at)) {
    if (!b.enemy(next) || b.isolated[next]) continue;
    if (computePush(b, at, next, 1) <= b.army[next]) continue;
    if (b.kind(next) === 'crown' || b.kind(next) === 'city') return true;
    if (Number.isFinite(cf?.distance?.[next]) && cf.distance[next] <= here) return true;
  }
  return false;
}

function blitzGather(b, m, own, state, crown, need, cfg, h, reason) {
  if (!Number.isInteger(crown) || crown < 0) return null;
  if (!b.own(state.root) || b.isolated[state.root]) return null;
  const cf = h.field(b, [crown]);
  if (b.army[state.root] < STACK_MIN) {
    const forward = forwardStack(b, own, crown, h);
    const rootDistance = cf.distance[state.root];
    if (
      forward >= 0 &&
      forward !== state.root &&
      Number.isFinite(cf.distance[forward]) &&
      (!Number.isFinite(rootDistance) || cf.distance[forward] < rootDistance)
    ) {
      if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') {
        console.error('RESEAT-FWD', b.turn, state.root, '->', forward, rootDistance, cf.distance[forward]);
      }
      state.root = forward;
      state.halfAt = -1;
      state.halfPushes = 0;
    }
  }
  m.delivery = null;
  const root = state.root;
  const rootDistance = cf.distance[root];
  const deficit = Math.max(1, need - b.army[root]);
  // Own-territory routing only: a delivery never has to fight for its path.
  const f = h.field(b, [root], (at) => b.own(at) && !b.isolated[at]);
  const candidates = [];
  for (let at = 0; at < b.size; at += 1) {
    if (at === root || !b.own(at) || b.isolated[at] || b.army[at] <= 1) continue;
    if (!Number.isFinite(f.distance[at]) || f.distance[at] <= 0) continue;
    const to = f.parent[at];
    if (!(to >= 0)) continue;
    if (Number.isFinite(rootDistance) && cf.distance[at] < rootDistance && cf.distance[to] > cf.distance[at])
      continue;
    const action = actionCoordinates(b, at, to, 2);
    if (!preview(b, action).ok) continue;
    // Prefer a fat *chain* close to the rally over one distant big stack: the
    // column then rolls forward and the rally grows on the next few ticks
    // instead of waiting for a long march from the rear.
    const route = h.route(f, at);
    let mass = 0;
    for (const cell of route.slice(0, -1)) mass += Math.max(0, b.army[cell] - 1);
    candidates.push({
      action,
      at,
      to,
      army: b.army[at],
      // A crown or city is a reserve, not a corridor cell.  Its surplus is pure
      // wave, and the chain below it is always nearer and fatter, so it is
      // pulled first instead of losing the score to the nearest route.
      anchor: (b.kind(at) === 'crown' || b.kind(at) === 'city') && b.army[at] - 1 >= CROWN_JOIN,
      // A stack with its own cheap forward kill keeps it; the gather uses
      // another source, so a real spearhead is never recalled.
      held: cheapForwardTarget(b, at, cf),
      steps: Math.max(1, route.length - 1),
      score: Math.min(deficit + 50, mass) / Math.max(1, route.length - 1),
    });
  }
  if (!candidates.length) return null;
  // 1. An anchor surplus joins the wave before the chain rolls again.
  const anchors = candidates
    .filter((candidate) => candidate.anchor)
    .sort((a, z) => a.steps - z.steps || z.army - a.army || a.at - z.at);
  // 2. Otherwise the chain scores as before, but a stack that still owns a
  //    cheap forward kill is only recalled when nothing else can deliver.
  const free = candidates.filter((candidate) => !candidate.held);
  const pool = free.length ? free : candidates;
  const best = anchors.length
    ? anchors[0]
    : pool.reduce(
        (pick, candidate) =>
          !pick ||
          candidate.score > pick.score ||
          (candidate.score === pick.score && candidate.army > pick.army)
            ? candidate
            : pick,
        null,
      );
  if (!best) return null;
  if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') {
    console.error(
      'GATHER',
      b.turn,
      best.at,
      '->',
      best.to,
      b.army[best.at],
      'root',
      root,
      b.army[root],
      best.anchor ? 'anchor' : '',
    );
  }
  return { action: best.action, branch: reason };
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
 * Rule: the main wave pushes fully (mode 2) by default, captures included.
 * The half push (mode 1) is only for leaving a junction whose live branch can
 * counterattack within two ticks, and there it is the only mode: a capture the
 * half cannot take is not attempted.  Mode 0 is never tried on the main route
 * (its reserve is a token guard, not a hold).
 */
function pushModes(b, root, next, live) {
  if (!live) return [2, 1];
  if (b.enemy(next) && computePush(b, root, next, 1) <= b.army[next]) return [];
  return [1];
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
    console.error(
      'JUNCTION',
      b.turn,
      'root',
      root,
      'army',
      b.army[root],
      'mode',
      action.mode,
      'live',
      live,
      'sides',
      sides
        .map(
          (side) =>
            `${side.at}:${side.branch.reconnectable ? 'live' : 'dead'}:${b.isolated[side.at] ? 'iso' : 'free'}:${b.army[side.at]}`,
        )
        .join(','),
    );
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

// The rally is gone or cut: move the body itself forward on the same crown.
// Every candidate is a real, preview-validated full push along the shortest
// route, so a quiet tick can always be replaced by progress toward the head.
function advanceBody(b, own, state, h, cfg) {
  const crown = state.crown;
  if (!(Number.isInteger(crown) && b.enemy(crown))) return null;
  const f = h.field(b, [crown]);
  const candidates = [];
  for (const at of own) {
    if (!b.own(at) || b.isolated[at] || b.army[at] <= 1) continue;
    const distance = f.distance[at];
    if (!Number.isFinite(distance) || distance <= 0) continue;
    candidates.push({ at, distance, army: b.army[at] });
  }
  candidates.sort((a, z) => a.distance - z.distance || z.army - a.army || a.at - z.at);
  for (const candidate of candidates) {
    const to = f.parent[candidate.at];
    if (!(to >= 0)) continue;
    const action = directPush(b, candidate.at, to, 2);
    if (!action) continue;
    if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') {
      console.error('ADVANCE', b.turn, candidate.at, '->', to, b.army[candidate.at]);
    }
    state.root = candidate.at;
    state.halfAt = -1;
    state.halfPushes = 0;
    state.stall = 0;
    state.frozen = 0;
    state.idle = 0;
    return { action, branch: 'blitz-advance' };
  }
  return null;
}

// One quiet tick is tolerated (a delivery is landing, a detachment is coming
// back, a cut may reopen).  A second consecutive one is not: the plan moves the
// body forward, paints a cell so it is not idling, or hands the board back.
function waitOne(b, m, own, state, h, cfg, decision) {
  state.idle = (state.idle || 0) + 1;
  if (state.idle <= 1) return decision;
  const forced = advanceBody(b, own, state, h, cfg);
  if (forced) return forced;
  const expand = expandDecision(b, m, own, h, state, cfg);
  if (expand.action) return expand;
  state.phase = 'done';
  return null;
}

function pushDecision(b, m, own, h, state, cfg) {
  const detached = advanceDetach(b, m, state, cfg, h);
  if (detached) {
    state.idle = 0;
    return detached;
  }
  // A cut corridor freezes the column in place, so repairing the cut is worth
  // one action before anything else.  While the front is cut the objective and
  // the root stay where they are: the repair is aimed at the trapped column,
  // and no rear cell is promoted while the front can still be reconnected.
  if (Number.isInteger(state.root) && b.own(state.root) && b.isolated[state.root]) {
    if (!state.frozenAt) state.frozenAt = b.turn;
    state.frozen = (state.frozen || 0) + 1;
    const rescue = rescueCut(b, own, state, h, cfg);
    if (rescue) {
      state.frozen = 0;
      state.idle = 0;
      return rescue;
    }
    // One tick of patience, no more: the engine makes the trapped column pay
    // one half, and a nearby stack may still reopen it next tick.  From the
    // following tick the plan must move - an alternate forward connected cell
    // takes the wave over, or the body advances on the same objective.  A
    // multi-tick `blitz-hold` is what froze t34.5-44.5 in the replay.
    if (state.frozen <= 1) {
      if (process.env.APEX_MAZE_BLITZ_DEBUG === '1')
        console.error('HOLD-CUT', b.turn, state.root, state.frozen);
      return waitOne(b, m, own, state, h, cfg, { action: null, branch: 'blitz-hold' });
    }
    state.abandons = (state.abandons || 0) + 1;
    if (process.env.APEX_MAZE_BLITZ_DEBUG === '1')
      console.error('ABANDON', b.turn, state.root, b.army[state.root]);
    // An alternate forward connected stack takes the wave over; the cut root
    // itself is never re-seated backwards.  The handover follows the component
    // that actually holds the mass (`waveAnchorRoot`), not the nearest token on
    // another lane, so a 269 stack is never abandoned and the rally never
    // walks back down the corridor.
    const crownReady0 = Number.isInteger(state.crown) && b.enemy(state.crown);
    const anchor = crownReady0 ? waveAnchorRoot(b, own, state.crown, h) : -1;
    // A real wave has to take over; a token or a rear pile would just restart
    // the same 100-cell march and feed the enemy one small column after
    // another.  In that case the blitz is over and the default planner decides.
    const minimum = Math.max(100, waveFloor(b.size, cfg) * 0.4);
    const mass = anchor >= 0 ? componentMass(b, ownComponent(b, anchor)) : 0;
    if (anchor >= 0 && anchor !== state.root && b.army[anchor] >= minimum) {
      state.root = anchor;
      state.halfAt = -1;
      state.halfPushes = 0;
      state.stall = 0;
      state.frozen = 0;
    } else {
      const advance = advanceBody(b, own, state, h, cfg);
      if (advance) return advance;
      // Nothing on this board can move toward the head: hand the game back to
      // the default planner with an action this tick instead of freezing in
      // place.  A multi-tick no-op is the one thing the replays ruled out.
      state.phase = 'done';
      const expand = expandDecision(b, m, own, h, state, cfg);
      return expand.action ? expand : null;
    }
  }
  const crownReady = Number.isInteger(state.crown) && b.enemy(state.crown) && b.kind(state.crown) === 'crown';
  if (!Number.isInteger(state.root) || !b.own(state.root) || b.army[state.root] <= 1) {
    const forward = crownReady ? forwardStack(b, own, state.crown, h) : -1;
    state.root = forward >= 0 ? forward : launchCell(b, own, state.crown, h);
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
      state.idle = 0;
      return { action, branch: 'blitz-strike' };
    }
    state.stall += 1;
    const advance = advanceBody(b, own, state, h, cfg);
    if (advance) return advance;
    return waitOne(b, m, own, state, h, cfg, { action: null, branch: 'blitz-push-wait' });
  }
  const need = routeNeed(b, path, state.crown, h, cfg);
  const mainNeed = routeNeed(b, path.slice(1), state.crown, h, cfg).need;
  const split = splitDecision(b, state, path, mainNeed, cfg, h);
  if (split) {
    state.idle = 0;
    return split;
  }
  const moved = march(b, state, path, cfg, h);
  if (process.env.APEX_MAZE_BLITZ_DEBUG === '1')
    console.error(
      'PUSH',
      b.turn,
      state.root,
      b.army[state.root],
      path.slice(0, 3),
      moved ? [moved.action.x, moved.action.y, moved.action.dx, moved.action.dy, moved.action.mode] : null,
    );
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
    state.idle = 0;
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
    return waitOne(b, m, own, state, h, cfg, { action: null, branch: 'blitz-retarget' });
  }
  const delivery = blitzGather(
    b,
    m,
    own,
    state,
    state.crown,
    b.army[state.root] + 40,
    cfg,
    h,
    'blitz-rejoin',
  );
  if (delivery) {
    state.idle = 0;
    return delivery;
  }
  const advance = advanceBody(b, own, state, h, cfg);
  if (advance) return advance;
  return waitOne(b, m, own, state, h, cfg, { action: null, branch: 'blitz-push-wait' });
}

function musterDecision(b, m, own, enemies, h, state, cfg) {
  if (!(Number.isInteger(state.crown) && b.enemy(state.crown) && b.kind(state.crown) === 'crown')) {
    state.crown = pickCrown(b, m, own, state, h);
    state.root = -1;
  }
  // No target at all: the only case where painting more ground is correct.
  if (state.crown < 0) return expandDecision(b, m, own, h, state, cfg);
  if (!Number.isInteger(state.root) || !b.own(state.root) || b.isolated[state.root]) {
    // A cut in the middle of the gather must not re-seat the wave on another
    // lane: the objective and the mass stay, so the plan repairs the cut first
    // and otherwise hands the rally to the forward cell of the component that
    // holds the wave (`waveAnchorRoot`).  A first seat follows the same rule;
    // `launchCell` (a distance-band scan that ranks tokens first) is only the
    // last resort, because that scan is how t31 of the reviewed replay dropped
    // a 269 stack and re-gathered the other way.
    const cut = Number.isInteger(state.root) && b.own(state.root) && b.isolated[state.root];
    if (cut) {
      const rescue = rescueCut(b, own, state, h, cfg);
      if (rescue) {
        state.idle = 0;
        return rescue;
      }
    }
    const anchor = waveAnchorRoot(b, own, state.crown, h);
    state.root = anchor >= 0 ? anchor : launchCell(b, own, state.crown, h);
    state.halfAt = -1;
    state.halfPushes = 0;
    state.stall = 0;
    if (cut) state.abandons = (state.abandons || 0) + 1;
    m.delivery = null;
  }
  if (state.root < 0) return expandDecision(b, m, own, h, state, cfg);
  const f = h.field(b, [state.crown]);
  const path = h.route(f, state.root);
  if (!path || path.length < 2) {
    state.phase = 'push';
    return pushDecision(b, m, own, h, state, cfg);
  }
  const wave = b.army[state.root];
  const floor = waveFloor(b.size, cfg);
  state.peakWave = Math.max(state.peakWave, wave);
  // Launch the tick the wave floor is met and a route exists.  There is no
  // later threshold and no resistance gate: a 759-unit column waiting for a
  // two-thousand-army estimate is the missed window from the replays.
  if (wave >= floor) {
    state.phase = 'push';
    state.launches += 1;
    state.idle = 0;
    return pushDecision(b, m, own, h, state, cfg);
  }
  if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') {
    console.error(
      'MUSTER',
      b.turn,
      'root',
      state.root,
      'wave',
      wave,
      'floor',
      floor,
      'remaining',
      gatherableMass(b, own, state.root),
      'dist',
      f.distance[state.root],
    );
  }
  // Burst is over: gather on this very tick, never keep expanding while
  // anything can still join the column.
  const delivery = blitzGather(
    b,
    m,
    own,
    state,
    state.crown,
    Math.max(waveFloor(b.size, cfg), b.army[state.root] + 1),
    cfg,
    h,
    'blitz-muster',
  );
  if (delivery) {
    state.idle = 0;
    return delivery;
  }
  // Nothing left to gather: the rally is the wave, so it attacks with what it
  // has instead of painting more ground.  Expanding only remains for the case
  // where there is no wave at all (the rally holds its single soldier).
  if (wave > 1) {
    state.phase = 'push';
    state.launches += 1;
    state.idle = 0;
    return pushDecision(b, m, own, h, state, cfg);
  }
  return expandDecision(b, m, own, h, state, cfg);
}

function mazeBlitzPlan(b, m, own, enemies, h, cfg = mazeBlitzConfig()) {
  if (!cfg.enabled || !own.length) return null;
  if (String(m?.mapMode || '') !== 'maze') return null;
  const state = m.blitz || (m.blitz = initialState());
  if (state.phase === 'done') return null;
  // Expansion phase: no construction at all, the burst window rewards cell
  // count and nothing else.  The decision state carries the tick that just
  // finished, so a state turn of `openingEnd` is already the first post-burst
  // tick - the gather must start there, not paint once more.
  if (state.phase === 'expand') {
    if (b.turn < cfg.openingEnd) return expandDecision(b, m, own, h, state, cfg);
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
  waveAnchorRoot,
  componentMass,
  cheapForwardTarget,
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
  advanceBody,
  blitzGather,
  initialState,
};
