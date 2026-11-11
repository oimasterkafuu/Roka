'use strict';

/**
 * Maze blitz (maze rooms only, default off; APEX_MAZE_BLITZ=1 enables).
 *
 * A dedicated assault plan for corridor maps, kept separate from the default
 * planner so open maps and the existing maze campaign are untouched when the
 * flag is off:
 *
 *   0. watch - ticks before the launch belong to the default planner (the
 *      burst opening is not changed); this layer only records the opponent's
 *      land growth so the opponent-style gate can classify the match-up.
 *   1. gate - at the launch tick the gate decides whether this opponent is a
 *      swarm (keeps painting at burst rate, no second building) or a crown
 *      racer.  A declined gate ends the layer for the game and the default
 *      planner keeps the board on that very tick: the fallback is literally
 *      the pre-blitz maze behaviour, not a partial blitz.
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
 * Junction rule (v6, simulated): a junction is a passable cell with at least
 * three passable 4-neighbours, i.e. at least two branch directions besides the
 * arrival/transit cell (mountains and the board edge are not counted).  Only a
 * move that *leaves* a junction is allowed to half; every other move is a full
 * push.  At a junction the wave simulates the worst-case enemy arrival per
 * tick (`threatTimeline`) and only halves while the simulated guard it leaves
 * behind still covers that arrival plus `guardMargin`:
 *
 *   - the post-our-move state is simulated tick by tick for `threatHorizon`
 *     ticks; the enemy gets one action per tick (not every source at once),
 *     uses the all-in push (mode 2) and the real engine reserve formula;
 *   - growth is applied every tick (crown +1, plain/city on the 50-tick
 *     boundary, the extra burst growth inside ticks 26..50) to both the enemy
 *     piles and our own junction guard;
 *   - branches are classified rather than assumed: own ground is only skipped
 *     when it survives the horizon, neutral ground is a delayed path (a capture
 *     tick is paid), the planned destination is only impassable when our push
 *     really captures it, an isolated enemy stack cannot move at all, and
 *     sources sharing one approach cell may combine (a friendly transfer).
 *
 * k is the largest number of successive half pushes whose guard timeline stays
 * above the threat timeline; it is not assumed to be 1/2, 1/4, 1/8 - the real
 * post-push army of the junction is used.  When no k (not even 0) is safe the
 * plan reinforces or aborts instead of pushing the guard away.  The full-push
 * exception is narrow and documented in `fullPushException`.
 *
 * Push-mode policy: every move that does not leave a junction is a full push
 * (mode 2), captures included - the v4 rule that defaulted every capture to the
 * half push left a useless 1/2 behind on plain road (t143/t144.5 of the
 * reviewed replay).  The half push (mode 1) exists only for the junction
 * transit ladder above, and mode 0 (the smart split) is never used on the main
 * route.
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
  // A branch threat below this is not a real branch threat: the guard ladder
  // would spend ticks to keep a guard the wave already has by momentum.
  junctionThreat: 12,
  // Node budget for the dead/live flood and the enemy force walk.  Both are
  // real graph searches, so the cap only protects against pathological boards.
  branchScan: 240,
  // Junction half-push rule: simulated horizon T in ticks, the guard margin
  // kept above the simulated threat, and the ladder cap.
  threatHorizon: 6,
  guardMargin: 4,
  maxHalf: 4,
  threatScan: 240,
  stallLimit: 10,
  detachStall: 4,
  splitCooldown: 6,
  rescueScan: 6,
  // Large rooms (0.68 maze, ~890 cells) are judged by size, not by profile:
  // a full push there leaves a 1-soldier tail the opponent can cut, so the
  // junction rule behaves differently from the compact 0.34 rooms.
  bigBoard: 800,
  rescueTicks: 6,
  rescueMass: 0,
  pairRescue: true,
  // A junction whose ladder is closed may be reinforced, but not forever: a
  // 174-tick hold was the v6 stall on the 0.68 rooms, so after a few failed
  // holds the blitz hands the board back instead of feeding one junction.
  holdLimit: 4,
  // Opponent-style gate (see opponentGate): the blitz is anti-specific, so it
  // only runs when the observed opponent behaves like a swarm (keeps painting
  // through the burst) instead of a crown racer (stops painting, starts a
  // second building).  Window in ticks before the launch, the enemy cells the
  // opponent must still add inside it, and the enemy buildings that already
  // mark a crown racer.
  gate: true,
  gateForce: false,
  gateWindow: 10,
  gatePaint: 6,
  gateBuildings: 2,
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
    // APEX_MAZE_BLITZ_HALF_PUSHES is the pre-v6 name of the same ladder cap.
    maxHalf: envNumber(
      'APEX_MAZE_BLITZ_MAX_HALF',
      envNumber('APEX_MAZE_BLITZ_HALF_PUSHES', DEFAULTS.maxHalf, 1, 8),
      1,
      8,
    ),
    threatHorizon: envNumber('APEX_MAZE_BLITZ_T', DEFAULTS.threatHorizon, 1, 50),
    guardMargin: envNumber('APEX_MAZE_BLITZ_GUARD', DEFAULTS.guardMargin, 0, 4000),
    threatScan: envNumber('APEX_MAZE_BLITZ_THREAT_SCAN', DEFAULTS.threatScan, 8, 20000),
    stallLimit: DEFAULTS.stallLimit,
    detachStall: DEFAULTS.detachStall,
    splitCooldown: DEFAULTS.splitCooldown,
    rescueScan: DEFAULTS.rescueScan,
    bigBoard: envNumber('APEX_MAZE_BLITZ_BIG', DEFAULTS.bigBoard, 0, 100000),
    rescueTicks: envNumber('APEX_MAZE_BLITZ_RESCUE_TICKS', DEFAULTS.rescueTicks, 1, 40),
    rescueMass: envNumber('APEX_MAZE_BLITZ_RESCUE_MASS', DEFAULTS.rescueMass, 0, 100000),
    // APEX_MAZE_BLITZ_PAIR=0 disables the large-room "pair the push with the
    // rear cut rescue" escape and leaves the pure hold/reinforce/abort rule.
    pairRescue: envFlag('APEX_MAZE_BLITZ_PAIR', DEFAULTS.pairRescue),
    holdLimit: envNumber('APEX_MAZE_BLITZ_HOLD_LIMIT', DEFAULTS.holdLimit, 1, 400),
    // Opponent-style gate.  APEX_MAZE_BLITZ_GATE=0 restores the blanket (v6)
    // blitz, APEX_MAZE_BLITZ_GATE_FORCE=1 forces the blitz past the gate; both
    // are A/B switches, the shipped behaviour is the gate.
    gate: envFlag('APEX_MAZE_BLITZ_GATE', DEFAULTS.gate),
    gateForce: envFlag('APEX_MAZE_BLITZ_GATE_FORCE', DEFAULTS.gateForce),
    gateWindow: envNumber('APEX_MAZE_BLITZ_GATE_WINDOW', DEFAULTS.gateWindow, 2, 60),
    gatePaint: envNumber('APEX_MAZE_BLITZ_GATE_PAINT', DEFAULTS.gatePaint, 0, 400),
    gateBuildings: envNumber('APEX_MAZE_BLITZ_GATE_BUILDINGS', DEFAULTS.gateBuildings, 1, 20),
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
    // Isolated-branch experiment (see trackIsolatedBranches).
    iso: null,
    junctionTicks: 0,
    halfLadders: 0,
    // Rear-anchor cut rescue (see rearRescueCut).
    rescue: null,
    rescueSince: 0,
    rearRescues: 0,
    rescuePaired: 0,
    fullExceptions: 0,
    holdTicks: 0,
    junctionAborts: 0,
    // Opponent-style gate (see opponentGate).
    gate: null,
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

/* ========================================================================
 * Junction half-push rule: simulate the worst-case enemy arrival instead of
 * summing nearby stacks.
 * ===================================================================== */

// Engine fact, mirrored from src/game-engine/tick-growth.ts: the burst runs
// ticks 26..50 inclusive, plains and cities grow on every 50th tick, and a
// crown grows on every tick.
const GROWTH_BURST_START = 26;
const GROWTH_BURST_END = 50;
const GROWTH_PLAIN_INTERVAL = 50;

function growthAt(kind, tick) {
  if (kind === 'crown') return 1;
  const plainTick = tick % GROWTH_PLAIN_INTERVAL === 0;
  if (kind === 'city') return plainTick ? 1 : 0;
  if (kind === 'plain') {
    const burst = tick >= GROWTH_BURST_START && tick <= GROWTH_BURST_END;
    return (plainTick ? 1 : 0) + (burst ? 1 : 0);
  }
  return 0;
}

// How much a pile of `kind` gains while it waits `ticks` ticks after the tick
// that just finished.  A crown grows every tick, so waiting is real growth.
function pileGrowth(turn, kind, ticks) {
  let gain = 0;
  for (let step = 0; step < ticks; step += 1) gain += growthAt(kind, turn + 1 + step);
  return gain;
}

/**
 * A junction is a passable cell with at least three passable 4-neighbours.
 * Three passable neighbours already give two branch directions besides the
 * arrival (`state.prev`) or transit cell, so the degree test is the documented
 * "two different branch directions" requirement; mountains, unknown terrain
 * and the board edge are not counted.
 */
function isJunction(b, at) {
  return forkDegree(b, at) >= 3;
}

// Threat simulation owner encoding: we only ever need us / them / neutral.
const SIM_OURS = 1;
const SIM_ENEMY = 2;
const SIM_NONE = 0;
const SIM_PLAIN = 0;
const SIM_CITY = 1;
const SIM_CROWN = 2;
const SIM_OTHER = 3;

/**
 * Flat, engine-shaped copy of the frame used by the threat simulation.  Fog is
 * kept as neutral ground: an unseen cell cannot be counted as ours, and the
 * enemy still pays a movement tick to walk through it.
 */
function threatSnapshot(b) {
  const size = b.size;
  const sim = {
    size,
    kind: new Uint8Array(size),
    owner: new Uint8Array(size),
    army: new Float64Array(size),
    passable: new Uint8Array(size),
    isolated: new Uint8Array(size),
    neighbors: (at) => b.neighbors(at),
  };
  for (let at = 0; at < size; at += 1) {
    const kind = b.kind(at);
    sim.kind[at] =
      kind === 'crown' ? SIM_CROWN : kind === 'city' ? SIM_CITY : kind === 'plain' ? SIM_PLAIN : SIM_OTHER;
    sim.passable[at] = b.passable(at) ? 1 : 0;
    sim.owner[at] = b.own(at) ? SIM_OURS : b.enemy(at) ? SIM_ENEMY : SIM_NONE;
    sim.army[at] = Math.max(0, Number(b.army[at]) || 0);
    sim.isolated[at] = b.isolated[at] ? 1 : 0;
  }
  return sim;
}

// Engine `computePush` reserve: every non-friendly neighbour except the target
// keeps `army - 1`.  Neutral cells count too (their army is zero, so they add
// -1 exactly like the engine and `rules.computePush` do).
function computeDefense(b, from, to, army = b.army) {
  let defense = 0;
  const fromOwner = b.owner(from);
  for (const next of b.neighbors(from)) {
    if (next === to || !b.passable(next)) continue;
    const nextOwner = b.owner(next);
    if (nextOwner > 0 && b.sameTeam(fromOwner, nextOwner)) continue;
    defense += (Number(army[next]) || 0) - 1;
  }
  return defense;
}

function simDefense(sim, from, to) {
  let defense = 0;
  const fromOwner = sim.owner[from];
  for (const next of sim.neighbors(from)) {
    if (next === to || !sim.passable[next]) continue;
    const owner = sim.owner[next];
    if (owner !== SIM_NONE && owner === fromOwner) continue;
    defense += sim.army[next] - 1;
  }
  return defense;
}

function simSend(sim, from, to, mode) {
  const total = sim.army[from];
  const cap = Math.max(0, total - 1);
  if (mode === 2) return cap;
  const theoretical = Math.max(0, total - simDefense(sim, from, to) - 1);
  return Math.min(cap, mode === 1 ? Math.floor(theoretical / 2) : theoretical);
}

function simKindName(kind) {
  return kind === SIM_CROWN ? 'crown' : kind === SIM_CITY ? 'city' : kind === SIM_PLAIN ? 'plain' : 'other';
}

/**
 * Worst-case enemy arrival timeline at the junction, one enemy action per tick.
 *
 * The flood starts at the junction and walks the passable graph; the enemy may
 * path through our own ground (paying the defender) and through neutral ground
 * (paying one movement tick, which is the documented "delayed path" of a
 * neutral branch).  Each source then walks its own shortest route toward the
 * junction with the real engine arithmetic: every push leaves one soldier
 * behind and a capture also removes the defender, so
 * `mass -= 1` per move and `mass -= defender` for every non-enemy cell taken.
 * The arrival tick is the number of moves, because one stack moves per tick.
 *
 * Sources sharing one approach cell (the junction neighbour they come through)
 * may combine: the pile waits and the next stack pushes into it, which is a
 * friendly transfer costing one extra tick.  Different approaches never sum -
 * with one action per tick only one of them can attack, so the maximum is used.
 */
function threatTimeline(b, sim, root, blocked, cfg) {
  const horizon = Math.max(1, Math.round(cfg.threatHorizon));
  const threat = new Array(horizon + 1).fill(0);
  const distance = new Int16Array(sim.size).fill(-1);
  const parent = new Int32Array(sim.size).fill(-1);
  distance[root] = 0;
  const queue = [root];
  let visited = 0;
  for (let head = 0; head < queue.length; head += 1) {
    if (visited >= cfg.threatScan) break;
    const at = queue[head];
    for (const next of sim.neighbors(at)) {
      if (distance[next] >= 0 || !sim.passable[next] || blocked.has(next)) continue;
      // Isolated-side rule: an adjacent branch that is an isolated enemy cell is
      // disconnected from every enemy anchor, so *that side* contributes no
      // threat and is not a corridor either.  We deliberately do not model the
      // enemy walking another live stack through the isolated branch to
      // reconnect it: the isolated-branch experiment is what makes that
      // assumption explicit (34% direct recapture of the cut junction at 0.34,
      // ~5-10% at 0.68).  Only the isolated side is dropped - every other
      // normal, neutral or weak-own branch still feeds the timeline below, and
      // there is deliberately no "the whole junction is safe" shortcut here.
      if (sim.isolated[next] && sim.owner[next] === SIM_ENEMY) continue;
      distance[next] = distance[at] + 1;
      parent[next] = at;
      queue.push(next);
      visited += 1;
    }
  }
  const groups = new Map();
  for (let at = 0; at < sim.size; at += 1) {
    // An isolated enemy stack cannot move at all (engine `chkMove`), so it is
    // never a source either.
    if (sim.owner[at] !== SIM_ENEMY || sim.isolated[at] || sim.army[at] < 2) continue;
    const start = distance[at];
    if (start < 1 || start > horizon) continue;
    let pile = sim.army[at];
    let cell = at;
    let moves = 0;
    let approach = -1;
    for (;;) {
      const next = parent[cell];
      if (next < 0) break;
      if (next === root) {
        approach = cell;
        break;
      }
      if (!sim.passable[next]) break;
      const defender = sim.owner[next] === SIM_ENEMY ? 0 : sim.army[next];
      if (pile - 1 <= defender) break; // the stack cannot take the next cell
      pile = pile - 1 - defender;
      moves += 1;
      cell = next;
      if (moves > horizon) break;
    }
    if (approach < 0 || pile < 2) continue;
    // The attack on the junction is one more action and it pushes all but one
    // soldier (mode 2), so that is the force that actually arrives.
    pile -= 1;
    if (pile < 1) continue;
    const tick = moves + 1;
    if (tick > horizon) continue;
    const list = groups.get(approach) || [];
    list.push({ at, tick, mass: pile, kind: sim.kind[at] });
    groups.set(approach, list);
  }
  for (const sources of groups.values()) {
    for (const source of sources) {
      const kind = simKindName(source.kind);
      for (let tick = source.tick; tick <= horizon; tick += 1) {
        // A pile that waits at home keeps growing (a crown grows every tick), so
        // the later it attacks the more it brings.
        const mass = source.mass + pileGrowth(b.turn, kind, tick - source.tick);
        if (mass > threat[tick]) threat[tick] = mass;
      }
    }
    if (sources.length > 1) {
      const total = sources.reduce((sum, source) => sum + source.mass, 0);
      const last = Math.max(...sources.map((source) => source.tick));
      for (let tick = last + 1; tick <= horizon; tick += 1) {
        // The merged pile waits on the approach cell, which is not its home
        // crown, so it does not grow while it waits.
        if (total > threat[tick]) threat[tick] = total;
      }
    }
  }
  return threat;
}

/**
 * The guard the junction keeps for ticks 1..T when the wave halves out of it
 * `halfPushes` times and then leaves.  Both the guard growth and the real
 * post-push army of the junction are used, so 3 half pushes are not assumed to
 * be exactly 1/8: the engine reserve (other hostile neighbours) is recomputed
 * on the frame, and the send is the engine's `floor((total - reserve - 1)/2)`.
 */
function guardTimeline(b, root, next, halfPushes, cfg) {
  const horizon = Math.max(1, Math.round(cfg.threatHorizon));
  const kind = b.kind(root);
  const defense = computeDefense(b, root, next);
  const guard = new Array(horizon + 1).fill(0);
  let total = Math.max(0, Number(b.army[root]) || 0);
  for (let tick = 1; tick <= horizon; tick += 1) {
    total += growthAt(kind, b.turn + tick);
    if (tick <= halfPushes) {
      const cap = Math.max(0, total - 1);
      const theoretical = Math.max(0, total - defense - 1);
      total -= Math.min(cap, Math.floor(theoretical / 2));
    }
    guard[tick] = total;
  }
  return guard;
}

/**
 * The largest k in [0, maxHalf] whose guard timeline stays above the threat
 * timeline plus the margin on *every* simulated tick - including the ticks
 * after the wave has left the junction, because the guard it left behind is
 * still the cell the branch can take.  `-1` means not even holding (k = 0) is
 * safe and the plan must reinforce or abort.
 */
function selectHalfPushes(b, root, next, threat, cfg) {
  const horizon = Math.max(1, Math.round(cfg.threatHorizon));
  const limit = Math.min(Math.max(1, Math.round(cfg.maxHalf)), horizon);
  let best = -1;
  for (let k = 0; k <= limit; k += 1) {
    const guard = guardTimeline(b, root, next, k, cfg);
    let safe = true;
    for (let tick = 1; tick <= horizon; tick += 1) {
      if (guard[tick] < threat[tick] + cfg.guardMargin) {
        safe = false;
        break;
      }
    }
    // The guard only shrinks with each extra half push, so the first unsafe k
    // ends the ladder.
    if (!safe) break;
    best = k;
  }
  return best;
}

/**
 * Branch classification at a junction, kept separate from the simulation so the
 * rule is testable: own ground is only skipped when it survives the horizon,
 * neutral ground is a delayed path, the planned destination is skipped only
 * when our planned push really captures it, and an isolated enemy stack cannot
 * move and is skipped on its own side only (the other branches still count).
 */
function classifySides(b, root, next, cfg) {
  const sides = [];
  for (const side of b.neighbors(root)) {
    if (!b.passable(side)) continue;
    const kind = b.kind(side);
    const base = { at: side, kind, army: b.army[side], isolated: Boolean(b.isolated[side]) };
    if (side === next) {
      // `send >= defender + 1` is the engine capture test; the half push is the
      // weaker of the two modes, so a half that captures proves the push does.
      const send = computePush(b, root, side, 1);
      const captures = !b.enemy(side) || send > b.army[side];
      sides.push({ ...base, role: 'destination', threat: captures ? 0 : b.army[side] - 1, delay: 0, captured: captures });
      continue;
    }
    if (b.own(side)) {
      // Own ground is not safe by itself: an enemy stack that can take this
      // cell within the horizon and then reach the junction is a delayed threat.
      sides.push({ ...base, role: 'own', threat: 0, delay: 2, captured: false });
      continue;
    }
    if (b.enemy(side)) {
      if (b.isolated[side]) {
        sides.push({ ...base, role: 'enemy-isolated', threat: 0, delay: Infinity, captured: false });
        continue;
      }
      sides.push({ ...base, role: 'enemy', threat: Math.max(0, b.army[side] - 1), delay: 1, captured: false });
      continue;
    }
    // Neutral: the enemy must spend a tick capturing it before it can attack
    // from there, so it is a delayed path and never an immediate threat.
    sides.push({ ...base, role: 'neutral', threat: 0, delay: 1, captured: false });
  }
  return sides;
}

/**
 * Full analysis of a junction transit: the branch classification, the enemy
 * arrival timeline, whether that threat is real enough to pay a guard for, and
 * the half-push ladder k.
 */
function junctionThreat(b, root, next, path, cfg) {
  const sim = threatSnapshot(b);
  // Our planned push is a half push while the ladder runs; using the weaker
  // mode for the capture test means the destination is only ever excluded when
  // we really take it.
  const halfSend = simSend(sim, root, next, 1);
  const captures = sim.owner[next] !== SIM_ENEMY || halfSend > sim.army[next];
  const blocked = new Set();
  if (captures) {
    blocked.add(next);
    const beyond = path?.[2];
    if (Number.isInteger(beyond) && sim.owner[beyond] === SIM_ENEMY) blocked.add(beyond);
  }
  const threat = threatTimeline(b, sim, root, blocked, cfg);
  let maxThreat = 0;
  for (let tick = 1; tick < threat.length; tick += 1) maxThreat = Math.max(maxThreat, threat[tick]);
  const real = maxThreat >= cfg.junctionThreat;
  const halfLimit = real ? selectHalfPushes(b, root, next, threat, cfg) : 0;
  return {
    junction: true,
    sides: classifySides(b, root, next, cfg),
    captures,
    blocked,
    threat,
    maxThreat,
    real,
    halfLimit,
  };
}

/**
 * The only two full pushes out of a threatened junction, both documented and
 * narrow:
 *   1. building: the cell ahead is an enemy crown/city one step away and no
 *      number of half pushes can take it (halving only shrinks the send), so
 *      the guard can never be worth keeping;
 *   2. trade: one own stack next to the junction can already take the cell we
 *      are pushing into on the following tick, so the 1-for-1 exchange of the
 *      junction guard for the advance is acceptable.  Large rooms never use
 *      this exception: there a full push leaves a 1-soldier tail that the
 *      opponent cuts, which is the v6 regression, so only the adjacent
 *      building (or a push paired with the rear cut rescue) may leave a live
 *      junction.
 */
function fullPushException(b, root, next, cfg, allowTrade = true) {
  if (!b.enemy(next)) return null;
  const kind = b.kind(next);
  if ((kind === 'crown' || kind === 'city') && computePush(b, root, next, 1) <= b.army[next]) return 'building';
  if (!allowTrade) return null;
  for (const from of b.neighbors(root)) {
    if (from === next || !b.own(from) || b.isolated[from]) continue;
    // The retaking stack has to be adjacent to the target, not only to the
    // junction: `computePush` does not check adjacency.
    if (!b.neighbors(from).includes(next)) continue;
    if (computePush(b, from, next, 2) > b.army[next]) return 'trade';
  }
  return null;
}

/**
 * No half push out of this junction is safe: reinforce instead of pushing the
 * guard away.  A half push leaves roughly half of the junction behind, so the
 * guard has to reach twice the threat plus the margin before the ladder opens
 * again.  With nothing left to reinforce with the caller hands the board back
 * (abort) rather than freeze or dump the guard.
 */
function holdJunction(b, m, own, h, state, cfg, threat) {
  const need = Math.max(STACK_MIN, Math.ceil(2 * (threat + cfg.guardMargin)));
  if (!b.own(state.root) || b.isolated[state.root]) return null;
  const delivery = blitzGather(b, m, own, state, state.crown, need, cfg, h, 'blitz-junction-hold');
  if (delivery) return delivery;
  return null;
}

/**
 * A closed ladder at a live junction.  `holdLimit` consecutive holds mean the
 * reinforcement is not arriving (the threat grows as fast as the deliveries),
 * so the plan aborts the blitz and hands the board back instead of feeding the
 * same junction for a hundred ticks - the v6 0.68 stall.
 */
function junctionHold(state, analysis, cfg, large) {
  state.holdTicks = (state.holdTicks || 0) + 1;
  // The abort is a large-room rule: on a compact 0.34 room the same hold really
  // does finish gathering and wins, so the ladder is allowed to wait there.
  if (large && state.holdTicks > cfg.holdLimit) {
    state.junctionAborts = (state.junctionAborts || 0) + 1;
    return { action: null, branch: 'blitz-junction-abort', threat: analysis.maxThreat, halfLimit: analysis.halfLimit };
  }
  return { action: null, branch: 'blitz-junction-hold', threat: analysis.maxThreat, halfLimit: analysis.halfLimit };
}

/* ========================================================================
 * Isolated-branch experiment (measure, do not assume it is safe).
 * ===================================================================== */

const ISO_WATCH_LIMIT = 8;
const ISO_WATCH_TICKS = 60;

function isoState(state) {
  if (!state.iso) {
    state.iso = {
      watched: [],
      watchedTotal: 0,
      recapture: 0,
      otherPath: 0,
      decayed: 0,
      pending: 0,
      reconnectTicks: 0,
      reconnectMass: 0,
      reconnects: 0,
    };
  }
  return state.iso;
}

/**
 * Watch the isolated enemy branches the wave walks away from and record which
 * of the three outcomes really happened: (1) the enemy recaptured the junction
 * we left and reconnected through it, (2) it reconnected through another path,
 * (3) the branch decayed/disappeared without ever reconnecting.  The counters
 * live on the plan state, so a diagnostic run can read them after a match
 * (`controller.stats().blitz.iso`) without any extra telemetry channel.
 */
function trackIsolatedBranches(b, state, root) {
  const iso = isoState(state);
  const keep = [];
  for (const watch of iso.watched) {
    if (!b.enemy(watch.at) || !b.isolated[watch.at]) {
      if (b.enemy(watch.at)) {
        iso.reconnects += 1;
        iso.reconnectTicks += Math.max(0, b.turn - watch.turn);
        iso.reconnectMass += Math.max(0, b.army[watch.at]);
        if (b.enemy(watch.junction)) iso.recapture += 1;
        else iso.otherPath += 1;
      } else {
        iso.decayed += 1;
      }
      continue;
    }
    if (b.turn - watch.turn > ISO_WATCH_TICKS) {
      iso.decayed += 1;
      continue;
    }
    keep.push(watch);
  }
  iso.watched = keep;
  if (!Number.isInteger(root) || !b.own(root)) return iso;
  for (const side of b.neighbors(root)) {
    if (!b.enemy(side) || !b.isolated[side]) continue;
    if (iso.watched.some((watch) => watch.at === side)) continue;
    if (iso.watched.length >= ISO_WATCH_LIMIT) iso.watched.shift();
    iso.watched.push({ at: side, junction: root, turn: b.turn, army: b.army[side] });
    iso.watchedTotal += 1;
  }
  iso.pending = iso.watched.length;
  return iso;
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
/**
 * Transit modes.  A junction ladder is half pushes only (mode 1); every other
 * move - and every move out of a junction whose half push is not justified by
 * the simulated threat - is a full push (mode 2).  Mode 0 (the smart split) is
 * never a transit mode: its reserve is a token guard, not a hold.
 */
function pushModes(halfAllowed) {
  return halfAllowed ? [1] : [2];
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

function ownCells(b) {
  const cells = [];
  for (let at = 0; at < b.size; at += 1) if (b.own(at) && !b.isolated[at]) cells.push(at);
  return cells;
}

/**
 * Whether a rear anchor can still reach the junction area through our own
 * ground inside the rescue window.  Only then may a large room push fully out
 * of a live junction: the push is paired with `rearRescueCut`, so the
 * one-soldier tail it leaves can be reopened instead of halving the wave.  The
 * anchor is one of the crowns/cities the gather already uses - this is not a
 * second anchor layer.
 */
function rearRescueReady(b, own, root, h, cfg) {
  if (!Number.isInteger(root) || !b.own(root)) return false;
  const f = h.field(b, [root], (at) => b.own(at) && !b.isolated[at]);
  for (const anchor of own) {
    if (b.isolated[anchor] || !b.own(anchor) || b.army[anchor] <= 1) continue;
    if (b.kind(anchor) !== 'crown' && b.kind(anchor) !== 'city') continue;
    const distance = f.distance[anchor];
    if (Number.isFinite(distance) && distance > 0 && distance <= cfg.rescueTicks + 2) return true;
  }
  return false;
}

/**
 * Main-route transit.
 *
 * Leaving a junction is the only place the half/full decision exists.  The
 * junction is simulated (`junctionThreat`): when its worst-case enemy arrival
 * over the horizon is a real threat, the wave halves out of it k times (k from
 * `selectHalfPushes`) so the guard the enemy can reach is never thinner than
 * the arrival plus the margin.  When the threat is not real, or the cell is not
 * a junction at all, the wave commits fully.  When no half push is safe the
 * decision is a hold and `pushDecision` reinforces or hands the board back.
 *
 * A half push that cannot take the cell ahead is not attempted either: dumping
 * half the wave on an uncapturable cell and keeping the other half on the
 * junction is worse than both alternatives, so only the documented
 * `fullPushException` may override the ladder.
 */
function march(b, state, path, cfg, h) {
  const root = state.root;
  const next = path[1];
  const sides = junctionSides(b, root, next, -1, cfg);
  // The guard only bypasses the generic push guard when every side branch is
  // structurally dead: there the enemy really cannot touch the tail.  A live
  // branch is left to `safeMove`.
  const deadOnly = sides.every((side) => !side.branch.reconnectable);
  const junction = isJunction(b, root);
  const large = b.size >= cfg.bigBoard;
  const analysis = junction ? junctionThreat(b, root, next, path, cfg) : null;
  const used = state.halfAt === root ? state.halfPushes : 0;
  let holding = false;
  let count = 0;
  let modes = pushModes(false);
  if (junction) {
    // Isolated branches we walk past are recorded whether or not the junction
    // is threatened: the diagnostic watch measures what happens to them.
    trackIsolatedBranches(b, state, root);
  }
  if (junction && analysis?.real) {
    state.junctionTicks = (state.junctionTicks || 0) + 1;
    const k = analysis.halfLimit;
    // A half push has to be able to take the cell ahead; otherwise sending half
    // the guard there is worse than both alternatives.
    const halfCaptures = !b.enemy(next) || computePush(b, root, next, 1) > b.army[next];
    if (b.enemy(next) && k >= 1 && !halfCaptures) {
      // No amount of halving takes the cell ahead: hold or use the documented
      // full-push exception, never dump half the wave on it.
      const exception = fullPushException(b, root, next, cfg, !large);
      if (!exception) {
        return junctionHold(state, analysis, cfg, large);
      }
    } else if (used >= cfg.maxHalf) {
      // The ladder cap is reached: hand the column to the forward cell.  The
      // guard stays on the junction, which is exactly what k protects.
      state.root = next;
      state.halfAt = -1;
      state.halfPushes = 0;
      const forward = h.route(h.field(b, [state.crown]), state.root);
      if (forward && forward.length > 1) return march(b, state, forward, cfg, h);
      return null;
    } else if (k < 1) {
      // Not even holding is safe (k = -1) or leaving the junction is not safe
      // yet (k = 0) although the cell ahead could be halved into: the ladder is
      // closed, so a plain full push out of the junction is not allowed.  The
      // adjacent building is the one documented exception; on a large room the
      // push may instead be paired with the rear cut rescue, which is what
      // reopens the one-soldier tail a full push leaves.  Everything else holds
      // and reinforces, and aborts when there is nothing left to reinforce with.
      const exception = fullPushException(b, root, next, cfg, !large);
      if (exception) {
        state.fullExceptions = (state.fullExceptions || 0) + 1;
      } else if (large && halfCaptures && cfg.pairRescue && rearRescueReady(b, ownCells(b), root, h, cfg)) {
        state.rescuePaired += 1;
      } else {
        return junctionHold(state, analysis, cfg, large);
      }
    } else {
      modes = pushModes(true);
      holding = true;
      count = used + 1;
    }
  }
  let action = null;
  for (const candidate of modes) {
    // The generic guard still charges us for a branch the simulation does not
    // consider a threat, so a junction with only dead sides may verify the same
    // push directly.  A half push is never promoted to a full push here: the
    // ladder is the whole point of the junction rule.
    let attempt = h.safeMove(b, root, next, 'blitz-push', [candidate]);
    if (!attempt && deadOnly) attempt = directPush(b, root, next, candidate);
    if (!attempt) continue;
    action = attempt;
    break;
  }
  if (!action) {
    if (holding) {
      // The guard refused the half push: hold instead of promoting it to a full
      // push behind the junction rule.
      return junctionHold(state, analysis ?? { maxThreat: 0, halfLimit: 0 }, cfg, large);
    }
    return null;
  }
  if (process.env.APEX_MAZE_BLITZ_DEBUG === '1' && junction) {
    console.error(
      'JUNCTION',
      b.turn,
      'root',
      root,
      'army',
      b.army[root],
      'mode',
      action.mode,
      'threat',
      analysis ? analysis.threat.slice(1).join('/') : '-',
      'k',
      analysis ? analysis.halfLimit : '-',
      'sides',
      (analysis ? analysis.sides : [])
        .map((side) => `${side.at}:${side.role}:${side.isolated ? 'iso' : 'free'}:${side.army}`)
        .join(','),
      'dead',
      deadOnly,
    );
  }
  // Repeated half pushes are the junction ladder: the guard stays on the
  // junction until the ladder reaches k, and the k-th push hands the column to
  // the forward cell.
  if (holding && count === 1) state.halfLadders = (state.halfLadders || 0) + 1;
  return {
    action,
    branch: b.enemy(next) ? 'blitz-break' : 'blitz-march',
    next,
    mode: action.mode,
    live: Boolean(analysis?.real),
    // This push is the last affordable one when the fresh ladder from the
    // post-push state has no room left, or when the maxHalf cap is reached: the
    // column then moves to the forward cell and the guard stays behind.
    advance: !holding || count >= cfg.maxHalf || (analysis?.halfLimit ?? 0) <= 1,
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
function trappedComponent(b, root) {
  const trapped = new Set([root]);
  const queue = [root];
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of b.neighbors(queue[head])) {
      if (trapped.has(next) || !b.own(next) || !b.isolated[next]) continue;
      trapped.add(next);
      queue.push(next);
    }
  }
  return trapped;
}

/**
 * Every enemy cell whose capture reconnects the trapped column: it is adjacent
 * to a trapped cell and to one of our own cells that is still connected to the
 * rear (`hub`, the cell a rescue has to reach first).
 */
function cutTargets(b, trapped) {
  const targets = [];
  const seen = new Set();
  for (const at of trapped) {
    for (const to of b.neighbors(at)) {
      if (!b.enemy(to) || b.isolated[to] || seen.has(to)) continue;
      seen.add(to);
      for (const hub of b.neighbors(to)) {
        if (trapped.has(hub) || !b.own(hub) || b.isolated[hub]) continue;
        targets.push({ to, hub, army: b.army[to], hubArmy: b.army[hub] });
      }
    }
  }
  return targets;
}

function rescueCut(b, own, state, h, cfg) {
  const root = state.root;
  if (!b.own(root) || !b.isolated[root]) return null;
  const trapped = trappedComponent(b, root);
  const candidates = [];
  for (const target of cutTargets(b, trapped)) {
    if (b.army[target.hub] <= 1) continue;
    candidates.push({ from: target.hub, to: target.to, army: target.army });
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

/**
 * Rear-anchor cut rescue, paired with the junction k ladder.
 *
 * A full push leaves a one-soldier tail, so when the opponent cuts it behind
 * the column `rescueCut` finds no own stack left to push back in and the wave
 * is abandoned (half its soldiers already gone).  This walks a real stack from
 * the nearest rear anchor (crown/city, the anchors the gather already uses - no
 * second anchor layer) along own ground to the cut's own-side hub, one action
 * per tick, and lets `rescueCut` reconnect from there.  Bounded by
 * `rescueTicks`, and only for a column worth the march.
 */
function rearRescueCut(b, own, state, h, cfg) {
  const root = state.root;
  if (!Number.isInteger(root) || !b.own(root) || !b.isolated[root]) {
    state.rescue = null;
    state.rescueSince = 0;
    return null;
  }
  if (!state.rescueSince) state.rescueSince = b.turn;
  if (b.turn - state.rescueSince > cfg.rescueTicks) {
    state.rescue = null;
    return null;
  }
  const trapped = trappedComponent(b, root);
  const mass = componentMass(b, trapped);
  const minimum = cfg.rescueMass > 0 ? cfg.rescueMass : Math.max(60, waveFloor(b.size, cfg) * 0.25);
  if (mass < minimum) return null;
  const targets = cutTargets(b, trapped);
  if (!targets.length) return null;
  let plan = state.rescue;
  if (plan && !targets.some((target) => target.to === plan.to && target.hub === plan.hub)) plan = null;
  if (plan && (!b.own(plan.at) || b.isolated[plan.at] || b.army[plan.at] <= 1)) plan = null;
  if (!plan) {
    let best = null;
    for (const target of targets.slice(0, cfg.rescueScan)) {
      const f = h.field(b, [target.hub], (at) => b.own(at) && !b.isolated[at]);
      for (const anchor of own) {
        if (b.isolated[anchor] || !b.own(anchor) || b.army[anchor] <= 1) continue;
        if (b.kind(anchor) !== 'crown' && b.kind(anchor) !== 'city') continue;
        const distance = f.distance[anchor];
        if (!Number.isFinite(distance) || distance <= 0) continue;
        if (!best || distance < best.distance || (distance === best.distance && b.army[anchor] > best.army)) {
          best = { to: target.to, hub: target.hub, at: anchor, distance, army: b.army[anchor] };
        }
      }
    }
    if (!best) return null;
    plan = { to: best.to, hub: best.hub, at: best.at, started: b.turn };
    state.rescue = plan;
  }
  const f = h.field(b, [plan.hub], (at) => b.own(at) && !b.isolated[at]);
  const route = h.route(f, plan.at);
  if (route.length < 2) return null;
  const next = route[1];
  const action = h.safeMove(b, plan.at, next, 'blitz-rescue-rear', [2]) || directPush(b, plan.at, next, 2);
  if (!action) return null;
  plan.at = next;
  state.rearRescues += 1;
  if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') {
    console.error('RESCUE-REAR', b.turn, plan.at, '->', plan.hub, 'cut', plan.to, b.army[root]);
  }
  return { action, branch: 'blitz-rescue-rear' };
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
      state.rescue = null;
      state.rescueSince = 0;
      return rescue;
    }
    // No adjacent stack can push the cut back in (the tail of a full push is a
    // run of one-soldier cells).  Walk a rear anchor to the cut instead of
    // abandoning the column: this is the rescue the k ladder is paired with.
    const rear = rearRescueCut(b, own, state, h, cfg);
    if (rear) {
      state.frozen = 0;
      state.idle = 0;
      return rear;
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
    state.rescue = null;
    state.rescueSince = 0;
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
  } else {
    // The column is connected again: no rescue march is pending.
    state.rescue = null;
    state.rescueSince = 0;
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
  // No half push out of this junction is safe: reinforce it, and only hand the
  // board back when there is nothing left to reinforce with.
  if (moved && !moved.action && moved.branch === 'blitz-junction-hold') {
    if (process.env.APEX_MAZE_BLITZ_DEBUG === '1')
      console.error('JUNCTION-HOLD', b.turn, state.root, b.army[state.root], moved.threat, moved.halfLimit);
    const hold = holdJunction(b, m, own, h, state, cfg, moved.threat || 0);
    if (hold) {
      state.idle = 0;
      return hold;
    }
    // Nothing can raise the guard: abort the blitz instead of pushing it away.
    state.phase = 'done';
    return waitOne(b, m, own, state, h, cfg, { action: null, branch: 'blitz-junction-abort' });
  }
  if (moved && !moved.action && moved.branch === 'blitz-junction-abort') {
    // The ladder stayed closed for `holdLimit` ticks: the reinforcement never
    // arrived, so the blitz hands the board back (abort) rather than keep
    // feeding the junction.  `waitOne` still spends this tick on progress.
    if (process.env.APEX_MAZE_BLITZ_DEBUG === '1')
      console.error('JUNCTION-ABORT', b.turn, state.root, b.army[state.root], moved.threat);
    state.phase = 'done';
    return waitOne(b, m, own, state, h, cfg, { action: null, branch: 'blitz-junction-abort' });
  }
  if (process.env.APEX_MAZE_BLITZ_DEBUG === '1')
    console.error(
      'PUSH',
      b.turn,
      state.root,
      b.army[state.root],
      path.slice(0, 3),
      moved && moved.action
        ? [moved.action.x, moved.action.y, moved.action.dx, moved.action.dy, moved.action.mode]
        : moved
          ? moved.branch
          : null,
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
    state.holdTicks = 0;
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

/**
 * Opponent-style gate (APEX_MAZE_BLITZ_GATE, on by default).
 *
 * The blitz is not a general improvement: seeds 8 of the 0.34/0.68 maze suite
 * moved Anti-Human from 21W/6D/5L to 23W/3D/6L but the Apex baseline from
 * 24W/1D/7L to 17W/0D/15L.  Apex plays a crown race (build a second crown,
 * keep a large home garrison, stop painting), so a no-build swarm wave feeds
 * its defence instead of racing it.  The gate therefore reads only what the
 * board shows at the burst end - never a name, seed, or opponent id:
 *
 *   - enemy land growth inside the `gateWindow` ticks before the launch
 *     (`APEX_MAZE_BLITZ_GATE_WINDOW`, default 10, i.e. ticks 40..50).  A swarm
 *     still paints about one cell per tick there (measured over 16 games each:
 *     9-10 cells for Anti-Human, -1..5 for Apex);
 *   - enemy buildings (crowns + cities) at the launch tick.  A crown racer
 *     already owns a second building (`APEX_MAZE_BLITZ_GATE_BUILDINGS`,
 *     default 2), a swarm opponent still owns exactly its starting crown.
 *
 * The gate allows the blitz only when the opponent is *still painting at burst
 * rate* and has not started a second building.  Growth is normalised to the
 * configured window so a late first observation (bot joins mid-game) cannot
 * read as a swarm.  With no observation at all there is no style evidence and
 * the flag semantics are kept (blitz), which is also why `_FORCE=1` exists for
 * A/B runs; `GATE=0` restores the blanket v6 blitz.
 */
function enemyStyle(b) {
  let land = 0;
  let buildings = 0;
  for (let at = 0; at < b.size; at += 1) {
    if (!b.enemy(at)) continue;
    land += 1;
    const kind = b.kind(at);
    if (kind === 'crown' || kind === 'city') buildings += 1;
  }
  return { land, buildings };
}

// Record the first in-window enemy land sample.  Called once per expand tick,
// so the sample is the earliest tick at or after `openingEnd - gateWindow`.
function observeOpponent(b, state, cfg) {
  if (!cfg.gate || cfg.gateForce) return;
  if (!state.gate) state.gate = { turn: -1, land: -1, gate: false, reason: null, paint: -1, buildings: -1 };
  const gate = state.gate;
  if (gate.turn >= 0) return;
  const start = Math.max(0, cfg.openingEnd - cfg.gateWindow);
  if (b.turn < start) return;
  gate.turn = b.turn;
  gate.land = enemyStyle(b).land;
}

function opponentGate(b, state, cfg) {
  const gate = state.gate || { turn: -1, land: -1 };
  const style = enemyStyle(b);
  const result = {
    turn: b.turn,
    from: gate.turn,
    land: style.land,
    buildings: style.buildings,
    paint: -1,
    allow: true,
    reason: 'swarm',
  };
  if (!cfg.gate) return { ...result, reason: 'gate-off' };
  if (cfg.gateForce) return { ...result, reason: 'forced' };
  if (Number.isFinite(gate.turn) && gate.turn >= 0 && Number.isFinite(gate.land) && gate.land >= 0) {
    const span = Math.max(1, Number(b.turn) - Number(gate.turn));
    result.paint = ((style.land - gate.land) * cfg.gateWindow) / span;
  }
  // A second building before the wave launches is a crown race, not a swarm:
  // the wave would have to break a defended anchor instead of out-tempoing a
  // painter.  This rule does not need the growth window, so it also covers a
  // first observation after the burst.
  if (style.buildings >= cfg.gateBuildings) return { ...result, allow: false, reason: 'crown-race' };
  if (result.paint < 0) return { ...result, reason: 'unobserved' };
  if (result.paint >= cfg.gatePaint) return { ...result, reason: 'swarm' };
  return { ...result, allow: false, reason: 'quiet' };
}

function mazeBlitzPlan(b, m, own, enemies, h, cfg = mazeBlitzConfig()) {
  if (!cfg.enabled || !own.length) return null;
  if (String(m?.mapMode || '') !== 'maze') return null;
  const state = m.blitz || (m.blitz = initialState());
  if (state.phase === 'done') return null;
  // Observation window.  The burst opening belongs to the default planner:
  // the v7 "no construction until tick 50" opening was what cost the Apex
  // match-up six wins even when the wave itself was gated off (24W -> 18W,
  // see BASELINE.md), and it bought the Anti-Human match-up nothing (23W with
  // and without it).  So the blitz only *watches* the opponent here and hands
  // the board back unchanged; the plan becomes real at the launch tick, after
  // the gate has read the opponent's style.
  if (state.phase === 'expand') {
    if (b.turn < cfg.openingEnd) {
      observeOpponent(b, state, cfg);
      return null;
    }
    // The launch is committed here, so the opponent-style gate decides here:
    // a declined blitz stops existing (phase `done`) and this very tick is
    // planned by the untouched default planner - never a half-blitz.  Nothing
    // before this tick depended on the blitz, so a declined game is
    // byte-for-byte a blitz-free game.
    const gate = opponentGate(b, state, cfg);
    state.gate = gate;
    if (!gate.allow) {
      state.phase = 'done';
      if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') {
        console.error(
          'GATE',
          b.turn,
          'off',
          gate.reason,
          'paint',
          gate.paint,
          'buildings',
          gate.buildings,
        );
      }
      return null;
    }
    if (process.env.APEX_MAZE_BLITZ_DEBUG === '1') {
      console.error(
        'GATE',
        b.turn,
        'on',
        gate.reason,
        'paint',
        gate.paint,
        'buildings',
        gate.buildings,
      );
    }
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
  isJunction,
  growthAt,
  pileGrowth,
  computeDefense,
  threatSnapshot,
  threatTimeline,
  guardTimeline,
  selectHalfPushes,
  classifySides,
  junctionThreat,
  fullPushException,
  holdJunction,
  trackIsolatedBranches,
  ownCells,
  rearRescueReady,
  rearRescueCut,
  trappedComponent,
  cutTargets,
  enemyStyle,
  observeOpponent,
  opponentGate,
};
