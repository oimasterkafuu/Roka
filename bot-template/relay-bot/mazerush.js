'use strict';

// Corridor multi-line layer for Bot(3.0) (round 20, `BOT3_MAZERUSH`).
//
// Scope. Multi-line rooms on a maze board (`isMazeBoard`) are the one cell the
// shipped stack leaves almost untouched: `./mshape` and `./mhalf` both stand
// down on corridors, the three-tick search only runs in clear rooms, and the
// corridor boards are a single lane where the inherited planner spends its
// sixteen orders on one-hop merges that a corridor cannot convert. Round 19
// measured the shape of the problem: land is equal at t100 even where the
// Voronoi split is lopsided 24/76, the frontier freezes because the cell behind
// it holds one army (a push needs two), and 61 army sits at hop >= 6 behind a
// six-cell ring. The maze multi cells are the last four relay cells of the
// matrix (clear 18/32, fog 16/32 against a 21/32 bar).
//
// The corridor lane. A maze is a spanning tree with a few extra openings: the
// two crowns sit at opposite ends of one trunk, and the game is decided on that
// trunk. Whoever holds a junction (degree >= 3) on it seals the side branches
// behind it (isolation halves their army and stops their pulses) and owns the
// Voronoi split. The key measured asymmetry of a corridor: a cell with one army
// cannot push at all (`computePush` caps a move at `total - 1`), so a lane where
// every cell holds one army delivers *nothing*. The inherited matching loop also
// allows one order per target, so even when several own neighbours can feed the
// same frontier cell in one tick, only one of them is emitted. The engine,
// however, runs several queued moves into the same cell in queue order (that is
// what `multi_line` means), which makes a multi-feed the one way to arm a
// corridor front faster than one army per tick.
//
// Components, each behind its own knob and all inert unless the layer is on:
//
//   * `feed`  - append own merges into a ring cell from the remaining own
//               neighbours, bypassing the one-order-per-target rule of the
//               matching loop. A ring cell is armed to `target` army in one
//               tick: `minFire` (2, the cheapest capture against an empty
//               neutral cell) when it faces only neutral cells, or the largest
//               adjacent hostile garrison + 2 when it faces a rival stack (a
//               push must strictly beat the defender). This is the "two-army
//               pump" specialised to a corridor: the rear army is spent on the
//               one cell that can convert it, not on a one-hop shuffle.
//   * `pump`  - re-rank own merges so the cell one hop behind the ring is kept
//               at two army (`minFire`) whenever the ring itself is short. A
//               hop-1 cell that holds one army cannot feed the front; that is
//               the measured freeze.
//   * `hold`  - price a ring cell by the hostile stack next to it: a junction
//               (degree >= 3) that faces a rival stack is worth holding at
//               `threat + 1`, a degree-2 corridor cell only at `minFire`.
//   * `seal`  - price an attack on a rival *junction* by the branches it cuts
//               off from the rival crown (terrain-only geometry, so it also
//               works in a fog room), instead of by the cell it takes.
//   * `lane`  - enable the `./mhalf` corridor routing (the hop field + ring
//               reload) that measured +2 clear / +3 fog on the round-20 screen,
//               so the layer ships as one switch.
//
// Everything is read from the environment on each call and the layer returns
// null when off, so `BOT3_MAZERUSH` unset keeps the shipped path byte for byte.

const { isMazeBoard } = require('./maze');

const WALL = 201;
const DEFAULT_MAX_BOARD = 800;
// The cheapest capture against an empty neutral cell: source army 2 pushes 1.
const DEFAULT_MIN_FIRE = 2;
// Extra merges into one ring cell per tick (the engine runs them in sequence).
const DEFAULT_FEED = 0;
const DEFAULT_FEED_TARGET = 1;
// Ring army that justifies a hold: the largest adjacent hostile garrison + 2,
// capped so a single huge rival stack cannot ask for a whole empire.
const DEFAULT_HOLD = 20;
const DEFAULT_HOLD_CAP = 8;
const DEFAULT_HOLD_PLUS = 0;
const DEFAULT_PUMP = 0;
const DEFAULT_SEAL = 0;
const DEFAULT_SEAL_CAP = 400;
// Junction rush: concentrate the lane on the one ring cell whose fall would
// isolate our own branch. `rush` is the score an appended redirect pays (any
// value > 0 enables it); `rushMin` is the smallest own branch worth defending.
const DEFAULT_RUSH = 0;
const DEFAULT_RUSH_MIN = 2;
// Only concentrate while we are behind on land: a comeback doctrine, not a
// general shape change. Percent of the rival land (`0` = always).
const DEFAULT_RUSH_BEHIND = 100;
const DEFAULT_LANE = 1;
// Measured clear-room optimum: capping same-hop merges (`./mhalf` sideways)
// keeps the lane from spending packets on lateral shuffles.
const DEFAULT_SIDEWAYS = 1;
// Fog rooms: how many distinct corridor branches the sixteen orders may spread
// over (the existing `./fog-maze` multi-line branch objective, measured here).
// A fogged corridor has no objective field at all without it, so the orders
// stack into one lane and stop growing vision.
const DEFAULT_BRANCH = 5;
const DEFAULT_START = 0;
const DEFAULT_END = 0;
// A throttle for the appended feed: never spend more than this many extra
// orders on one tick (the base orders are untouched).
const DEFAULT_FEED_ORDERS = 6;

function number(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function flag(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

// Read on every call so tests and A/B runs can toggle the layer in-process.
function mazerushConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.BOT3_MAZERUSH, true),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_MAZERUSH_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    feed: overrides.feed ?? number(env.BOT3_MAZERUSH_FEED, DEFAULT_FEED, 0, 4),
    feedTarget: overrides.feedTarget ?? number(env.BOT3_MAZERUSH_FEED_TARGET, DEFAULT_FEED_TARGET, 1, 4),
    feedOrders: overrides.feedOrders ?? number(env.BOT3_MAZERUSH_FEED_ORDERS, DEFAULT_FEED_ORDERS, 1, 32),
    minFire: overrides.minFire ?? number(env.BOT3_MAZERUSH_MIN_FIRE, DEFAULT_MIN_FIRE, 2, 20),
    hold: overrides.hold ?? number(env.BOT3_MAZERUSH_HOLD, DEFAULT_HOLD, 0, 5000),
    holdCap: overrides.holdCap ?? number(env.BOT3_MAZERUSH_HOLD_CAP, DEFAULT_HOLD_CAP, 1, 50),
    holdPlus: overrides.holdPlus ?? number(env.BOT3_MAZERUSH_HOLD_PLUS, DEFAULT_HOLD_PLUS, 0, 6),
    pump: overrides.pump ?? number(env.BOT3_MAZERUSH_PUMP, DEFAULT_PUMP, 0, 5000),
    seal: overrides.seal ?? number(env.BOT3_MAZERUSH_SEAL, DEFAULT_SEAL, 0, 5000),
    sealCap: overrides.sealCap ?? number(env.BOT3_MAZERUSH_SEAL_CAP, DEFAULT_SEAL_CAP, 0, 5000),
    rush: overrides.rush ?? number(env.BOT3_MAZERUSH_RUSH, DEFAULT_RUSH, 0, 5000),
    rushMin: overrides.rushMin ?? number(env.BOT3_MAZERUSH_RUSH_MIN, DEFAULT_RUSH_MIN, 1, 100),
    rushBehind: overrides.rushBehind ?? number(env.BOT3_MAZERUSH_RUSH_BEHIND, DEFAULT_RUSH_BEHIND, 0, 1000),
    lane: overrides.lane ?? flag(env.BOT3_MAZERUSH_LANE, DEFAULT_LANE === 1),
    sideways: overrides.sideways ?? number(env.BOT3_MAZERUSH_SIDEWAYS, DEFAULT_SIDEWAYS, 0, 1),
    branch: overrides.branch ?? number(env.BOT3_MAZERUSH_BRANCH, DEFAULT_BRANCH, 0, 16),
    leadCap: overrides.leadCap ?? number(env.BOT3_MAZERUSH_LEAD, 0, 0, 1000),
    startTurn: overrides.startTurn ?? number(env.BOT3_MAZERUSH_START, DEFAULT_START, 0, 10000),
    endTurn: overrides.endTurn ?? number(env.BOT3_MAZERUSH_END, DEFAULT_END, 0, 10000),
  };
}

function freshMazerush() {
  return { ticks: 0, feeds: 0, pump: 0, hold: 0, seal: 0 };
}

const ownerOf = (code) => (code < 200 ? code % 50 : 0);

// The corridor geometry the components share:
//   ring[i] - our cell that touches a non-own, non-wall cell (the frontier);
//   hop[i]  - hops from i to the nearest ring cell through our own territory
//             (-1 inside a pocket that does not reach the ring);
//   deg[i]  - passable degree of i (walls are 201, and a fogged maze keeps its
//             mountains visible, so this is exact in fog as well);
//   threat[i]- largest adjacent hostile garrison (ring cells only; every cell
//             adjacent to ours is inside fog vision radius 1, so this is exact
//             in fog too).
function mazerushField(b, teams, units, neighbors, myTeam) {
  const size = b.size;
  const tile = b.grid_type;
  const ring = new Uint8Array(size);
  const hop = new Int16Array(size).fill(-2);
  const threat = new Int16Array(size);
  const queue = [];
  for (let i = 0; i < size; i++) {
    if (teams[i] !== myTeam) continue;
    let front = false;
    for (const j of neighbors[i]) {
      if (tile[j] === WALL) continue;
      if (teams[j] !== myTeam) front = true;
      if (teams[j] && teams[j] !== myTeam) threat[i] = Math.max(threat[i], units[j] | 0);
    }
    if (front) {
      ring[i] = 1;
      hop[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (const j of neighbors[i]) {
      if (teams[j] !== myTeam || hop[j] !== -2) continue;
      hop[j] = hop[i] + 1;
      queue.push(j);
    }
  }
  for (let i = 0; i < size; i++) if (hop[i] === -2) hop[i] = -1;
  const deg = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (tile[i] === WALL) continue;
    let n = 0;
    for (const j of neighbors[i]) if (tile[j] !== WALL) n++;
    deg[i] = n;
  }
  return { ring, hop, deg, threat };
}

// One call per planning tick. Returns null when the layer has nothing to say,
// which keeps the planner on the exact shipped path.
function mazerushUpdate(b, input, config = mazerushConfig()) {
  if (!config.enabled) return null;
  if (!input || input.multi !== true) return null;
  if (!input.corridor) return null;
  if (!(Number(input.size) <= config.maxBoard)) return null;
  const turn = Math.max(0, Number(input.turn) || 0);
  if (turn < config.startTurn) return null;
  if (config.endTurn > 0 && turn >= config.endTurn) return null;
  const land = Math.max(0, Number(input.land) || 0);
  const enemyLand = Math.max(0, Number(input.enemyLand) || 0);
  if (config.leadCap > 0 && enemyLand > 0 && land * 100 > enemyLand * config.leadCap) return null;
  const state = (b.mazerush ??= freshMazerush());
  state.ticks += 1;
  return { config, turn, state, field: null, land, enemyLand };
}

// The army a ring cell needs before it is a useful spend this tick: enough to
// capture next tick. Against a rival stack the push has to strictly beat its
// garrison, so the source needs `garrison + 2`; against an empty neutral cell
// the cheapest capture is two army.
function armTarget(cfg, field, units, i) {
  const hostile = field.threat[i];
  if (hostile > 0) return Math.min(cfg.holdCap, hostile + 2);
  return cfg.minFire;
}

// Score-side moves: `pump` keeps the cell behind the ring armed, `hold` prices
// the ring cell by the stack facing it, `seal` prices a rival junction by the
// branches it cuts. Scores only; the candidate set is never widened here.
function applyMazerush(plan, ctx, candidates) {
  const { config } = plan;
  const { tile, teams, units, neighbors, myTeam } = ctx;
  const field = (plan.field = mazerushField(ctx.b, teams, units, neighbors, myTeam));
  const { ring, hop, deg, threat } = field;

  // `pump`: the hop-1 cell behind a short ring cell. A hop-1 cell holding one
  // army cannot send anything (`total - 1`), so the corridor stalls exactly
  // there; arming it is worth more than any sideways merge.
  if (config.pump) {
    for (const op of candidates) {
      if (op.build || op.score >= 300) continue;
      if (teams[op.to] !== myTeam) continue;
      const to = hop[op.to];
      if (to < 0) continue;
      const send = Math.max(1, op.send || 1);
      // Arm the cell behind the ring: the target is a hop-1 cell whose ring
      // neighbour is short, and the merge has to bring it to `minFire`.
      if (to === 1 && units[op.to] < config.minFire) {
        let shortRing = false;
        for (const k of neighbors[op.to]) {
          if (ring[k] && units[k] < armTarget(config, field, units, k)) shortRing = true;
        }
        if (!shortRing) continue;
        const result = units[op.to] + units[op.from] - 1;
        if (result < config.minFire) continue;
        op.score += config.pump + Math.min(20, send * 2);
        plan.state.pump += 1;
        continue;
      }
      // A merge into a ring cell that still cannot fire is the worst order in
      // the game; the reload bonus is priced by the army it adds.
      if (to === 0) {
        const target = armTarget(config, field, units, op.to);
        if (units[op.to] >= target) continue;
        const result = units[op.to] + units[op.from] - 1;
        if (result > target) continue;
        if (result < Math.min(target, config.minFire)) continue;
        op.score += config.pump;
        plan.state.pump += 1;
      }
    }
  }

  // `hold`: a junction on the corridor is the door to every side branch; a
  // degree-2 cell is only a lane. Price a merge into a threatened ring cell by
  // the stack it has to survive.
  if (config.hold) {
    for (const op of candidates) {
      if (op.build || op.score >= 300) continue;
      if (teams[op.to] !== myTeam) continue;
      if (hop[op.to] !== 0) continue;
      if (threat[op.to] <= 0) continue;
      const target = Math.min(config.holdCap, threat[op.to] + config.holdPlus);
      const result = units[op.to] + units[op.from] - 1;
      if (result > target) continue;
      const junction = deg[op.to] >= 3 ? 1 : 0;
      op.score += config.hold * (1 + junction) * Math.min(4, threat[op.to]);
      plan.state.hold += 1;
    }
  }

  // `seal`: taking a rival junction cuts the side branches behind it off the
  // rival crown (isolation halves their army and stops their pulses), so the
  // attack is priced by the branch, not by the cell. Terrain-only geometry:
  // one BFS over the passable graph, then the branch sizes hanging off the
  // target junction away from both crowns.
  if (config.seal) {
    const seal = sealValues(ctx);
    for (const op of candidates) {
      if (op.build) continue;
      if (teams[op.to] === myTeam || !teams[op.to]) continue;
      const value = seal[op.to];
      if (!value) continue;
      op.score += Math.min(config.sealCap, Math.sqrt(value) * config.seal);
      plan.state.seal += 1;
    }
  }
}

// Value of a rival junction as a cut: the visible army plus one per cell in the
// side branches that stop being connected to the rival crown once we take it.
// The trunk direction toward our own crown and the direction toward the rival
// side are excluded; everything else is a branch we would seal.
function sealValues(ctx) {
  const { b, tile, teams, units, neighbors, myTeam } = ctx;
  const size = b.size;
  const value = new Float64Array(size);
  const own = [];
  for (let i = 0; i < size; i++) if (teams[i] === myTeam) own.push(i);
  if (!own.length) return value;
  const dist = new Int32Array(size).fill(-1);
  const queue = [...own];
  for (const i of own) dist[i] = 0;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (const j of neighbors[i]) {
      if (tile[j] === WALL || dist[j] !== -1) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  for (let i = 0; i < size; i++) {
    if (teams[i] === myTeam || !teams[i]) continue;
    if (degOf(tile, neighbors, i) < 3) continue;
    let weight = 0;
    for (const j of neighbors[i]) {
      if (tile[j] === WALL) continue;
      const far = dist[j];
      if (far < 0) continue;
      // The branch that contains our own side is the one we attack from (the
      // smallest distance); the branch toward the rival crown is the farthest
      // one. Only the remaining branches are sealed by taking this cell.
      weight += far;
    }
    const branches = [];
    for (const j of neighbors[i]) {
      if (tile[j] === WALL) continue;
      const far = dist[j];
      if (far < 0) continue;
      branches.push({ j, far });
    }
    if (branches.length < 3) continue;
    branches.sort((a, c) => a.far - c.far);
    // Everything except the nearest (our side) and the farthest (their side).
    let sealed = 0;
    for (let k = 1; k < branches.length - 1; k++) {
      // Flood the branch without crossing i and count the rival cells in it.
      const start = branches[k].j;
      const seen = new Uint8Array(size);
      seen[i] = 1;
      seen[start] = 1;
      const q = [start];
      for (let head = 0; head < q.length; head++) {
        const cell = q[head];
        if (teams[cell] && teams[cell] !== myTeam) sealed += 1 + Math.min(20, units[cell] | 0);
        for (const m of neighbors[cell]) {
          if (seen[m] || tile[m] === WALL) continue;
          seen[m] = 1;
          q.push(m);
        }
      }
    }
    value[i] = sealed;
  }
  return value;
}

function degOf(tile, neighbors, i) {
  let n = 0;
  for (const j of neighbors[i]) if (tile[j] !== WALL) n++;
  return n;
}

// Extra orders appended after the matching loop: several own neighbours feed
// the same ring cell in one tick. The engine runs every queued move whose
// source is not itself a move target in queue order, so a multi-feed arms a
// corridor front at `feed + 1` army per tick instead of one. A ring cell that
// is already a base order's source is skipped (making it a target would cancel
// that order); a ring cell already armed by the base batch is skipped too.
// Own cells that would be cut off from our crown if `cell` fell: the isolation
// rule halves a severed pocket and stops its pulses, so a ring cell that guards
// a branch is worth far more than the one cell it occupies. One flood per ring
// candidate over our own territory, so this is cheap on a 221-cell board.
function isolationLoss(ctx, cell) {
  const { tile, teams, neighbors, myTeam } = ctx;
  const size = teams.length;
  let crown = -1;
  for (let i = 0; i < size; i++)
    if (teams[i] === myTeam && tile[i] >= 100 && tile[i] < 150) {
      crown = i;
      break;
    }
  if (crown < 0) return 0;
  let own = 0;
  for (let i = 0; i < size; i++) if (teams[i] === myTeam) own++;
  if (own <= 1) return 0;
  const seen = new Uint8Array(size);
  seen[crown] = 1;
  seen[cell] = 1;
  const queue = [crown];
  let reached = 1;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (const j of neighbors[i]) {
      if (seen[j] || tile[j] === WALL || teams[j] !== myTeam) continue;
      seen[j] = 1;
      reached += 1;
      queue.push(j);
    }
  }
  return own - reached - 1;
}

// Junction rush: pick the ring cell whose fall would isolate the largest own
// branch and concentrate this tick's lane deliveries on it. Orders that are own
// merges out of one of its neighbours are retargeted, and the remaining own
// neighbours (two army or more) get an appended order. The anchor is never a
// base source, because making it a move target would cancel its own order.
function rushPass(plan, ctx, orders, extra) {
  const { config } = plan;
  const { b, teams, units, neighbors, myTeam } = ctx;
  const field = plan.field;
  const { ring, hop, deg, threat } = field;
  if (!config.rush) return null;
  const baseSrc = new Set();
  for (const op of orders) if (!op.build) baseSrc.add(op.from);
  if (config.rushBehind > 0) {
    const land = plan.land | 0,
      enemyLand = plan.enemyLand | 0;
    if (enemyLand <= 0 || land * 100 >= enemyLand * config.rushBehind) return null;
  }
  let anchor = -1,
    bestScore = 0;
  for (let i = 0; i < b.size; i++) {
    if (!ring[i] || baseSrc.has(i)) continue;
    if (threat[i] <= 0) continue;
    // The main line is the ring cell facing the largest rival stack; a junction
    // is worth one extra point because its other lanes re-arm it.
    if (threat[i] < config.rushMin) continue;
    const score = threat[i] * 4 + (deg[i] >= 3 ? 2 : 0) + (hop[i] === 0 ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      anchor = i;
    }
  }
  plan.state.rushLoss = bestScore;
  if (anchor < 0) return null;
  // Retarget the lane's own merges that already leave a neighbour of the anchor.
  let redirected = 0;
  for (const op of orders) {
    if (op.build) continue;
    if (teams[op.to] !== myTeam) continue;
    if (op.to === anchor) continue;
    if (!neighbors[anchor].includes(op.from)) continue;
    if (hop[op.to] <= 0) continue;
    op.to = anchor;
    op.send = Math.max(0, units[op.from] - 1);
    redirected += 1;
  }
  // Append one delivery from every remaining armed own neighbour.
  const used = new Set(orders.filter((op) => !op.build).map((op) => op.from));
  for (const op of extra) used.add(op.from);
  let appended = 0;
  for (const j of neighbors[anchor]) {
    if (teams[j] !== myTeam || units[j] < 2 || used.has(j)) continue;
    if (hop[j] < 0) continue;
    extra.push({ score: 0, from: j, to: anchor, mode: 2, send: units[j] - 1, mazerush: true });
    used.add(j);
    appended += 1;
  }
  plan.state.rush += 1;
  plan.state.rushAnchor = anchor;
  plan.state.redirected = redirected;
  plan.state.appended = appended;
  return anchor;
}

function mazerushOrders(plan, ctx, orders) {
  const { config } = plan;
  const extra = [];
  if (!config.feed && !config.rush) return extra;
  const { b, teams, units, neighbors, myTeam } = ctx;
  const field = plan.field ?? (plan.field = mazerushField(b, teams, units, neighbors, myTeam));
  const { ring, hop, deg, threat } = field;
  const anchor = rushPass(plan, ctx, orders, extra);
  if (process.env.BOT3_MAZERUSH_TRACE === '1' && anchor >= 0)
    console.error(
      `[mazerush] t${plan.turn} anchor ${anchor} score ${plan.state.rushLoss} threat ${field.threat[anchor]} ` +
        `redirected ${plan.state.redirected} appended ${plan.state.appended}`,
    );
  if (!config.feed) return extra;
  const baseSrc = new Set();
  const incoming = new Map();
  for (const op of orders) {
    if (op.build) continue;
    baseSrc.add(op.from);
    if (teams[op.to] === myTeam) {
      const send = Math.max(0, op.send || units[op.from] - 1);
      incoming.set(op.to, (incoming.get(op.to) ?? 0) + send);
    }
  }
  for (const op of extra) incoming.set(op.to, (incoming.get(op.to) ?? 0) + (op.send || 0));
  // Most valuable first: a threatened junction with the biggest gap to its
  // arm target.
  const fronts = [];
  for (let i = 0; i < b.size; i++) {
    if (!ring[i] || baseSrc.has(i)) continue;
    const target = Math.max(config.minFire, armTarget(config, field, units, i));
    const have = units[i] + (incoming.get(i) ?? 0);
    if (have >= target) continue;
    const priority = (target - have) * 10 + (deg[i] >= 3 ? 25 : 0) + threat[i] * 2;
    fronts.push({ i, target, have, priority });
  }
  fronts.sort((a, c) => c.priority - a.priority);
  const usedSource = new Set(extra.map((op) => op.from));
  let spent = 0;
  for (const front of fronts) {
    if (spent >= config.feedOrders) break;
    // Extra deliveries must not make an already-firing ring cell a target.
    if (baseSrc.has(front.i)) continue;
    for (const j of neighbors[front.i]) {
      if (teams[j] !== myTeam) continue;
      if (units[j] < 2) continue;
      if (baseSrc.has(j) || usedSource.has(j)) continue;
      if (hop[j] < 0) continue;
      const send = units[j] - 1;
      if (front.have + send > front.target + config.feedTarget) continue;
      extra.push({ score: 0, from: j, to: front.i, mode: 2, send, mazerush: true });
      usedSource.add(j);
      front.have += send;
      spent += 1;
      if (spent >= config.feedOrders) break;
      if (front.have >= front.target + config.feedTarget) break;
    }
  }
  plan.state.feeds = extra.length;
  if (process.env.BOT3_MAZERUSH_TRACE === '1' && (extra.length || fronts.length))
    console.error(
      `[mazerush] t${plan.turn} fronts ${fronts
        .slice(0, 4)
        .map((f) => `${f.i}:${f.have}/${f.target}`)
        .join(',')} feed ${extra.map((o) => `${o.from}->${o.to}`).join(',')}`,
    );
  return extra;
}

module.exports = {
  mazerushConfig,
  mazerushUpdate,
  mazerushField,
  applyMazerush,
  mazerushOrders,
  sealValues,
  armTarget,
  freshMazerush,
  DEFAULT_MAX_BOARD,
  DEFAULT_MIN_FIRE,
  DEFAULT_FEED,
  DEFAULT_FEED_TARGET,
  DEFAULT_FEED_ORDERS,
  DEFAULT_HOLD,
  DEFAULT_HOLD_CAP,
  DEFAULT_PUMP,
  DEFAULT_SEAL,
  DEFAULT_SEAL_CAP,
  DEFAULT_LANE,
  DEFAULT_SIDEWAYS,
  DEFAULT_BRANCH,
  DEFAULT_START,
  DEFAULT_END,
};
