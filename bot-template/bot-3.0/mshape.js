'use strict';

// Expansion-shape layer for multi-line rooms (round 15).
//
// Diagnosis. In a multi-line room the empire's only recurring income is land:
// every normal plain pays +1 army on t = 50, 100, 150, ..., army relocates for
// free, and a move costs the attacker nothing except the defender's garrison.
// The rules allow one order per non-empty front per tick and neither the engine
// nor the server caps the queue ("多线争锋"), so the number of simultaneous
// captures is the number of frontier cells that hold two army - not a policy
// choice the serial planner makes.
//
// What the serial planner does with those slots is the problem. Measured on the
// mirror (relay multi, `data/scratch/mshape-probe.cjs`), the tick after a growth
// pulse looks like this: 40 land, 88 army, 23 cells holding two army, 9 frontier
// cells, and the tick spends its orders on rear merges that leave the frontier
// one army short. Two thirds of the pulse army never becomes land, and land is
// what the next pulse pays for.
//
// The layer moves scores and the order cap only; it never creates a candidate,
// because the planner already proposes every edge of every cell that holds two
// army (the supply is army-bound and cannot be widened). The mechanism that
// measured positive is two rules, not a weight:
//
//   * `slots` - the sixteen-order clamp is self-imposed. Off a pulse a multi
//     tick has 5-25 candidates, on the pulse tick 40+, so lifting the cap to
//     "every candidate" is worth +7 wins in the 256-game screen and `64` is
//     already "unlimited" (`4096` is identical).
//   * `steal` - a plain merge that uses a cell which could capture this tick
//     spends the slot on moving one army instead of taking a cell. The engine
//     also refuses the capture (the source is a queued move target) and
//     `strategy.js` skips planning while `pending` is non-empty, so the tick is
//     lost twice over. Demoting such a merge below the capture it would
//     invalidate is worth another +2 wins; `stealCap` keeps defence, rescue and
//     siege scores out of it.
//
// The remaining knobs are the measured negatives of the round, kept behind
// switches so they can be reproduced: `feed` (0.2), `capture`/`ring` (0.6),
// `hole` (0.3) and `fan` (0.3) all lose games against the plain `slots+steal`
// core, because the frontier ring is spent every time it captures and the army
// that would feed it sits two to six hops away. `ROUND15-MSHAPE.md` has the
// tables.
//
// Every knob is read from the environment on each call, and with `BOT3_MSHAPE`
// unset the planner is byte-identical to the round-13 baseline.

const DEFAULT_MAX_BOARD = 800;
// The engine and the server have no queue cap, and the rules allow one order per
// non-empty front per tick; 16 is the number both bots inherited from relay.
const DEFAULT_SLOTS = 16;
const DEFAULT_CAPTURE = 0;
const DEFAULT_RING = 0;
const DEFAULT_RING_CAP = 6;
const DEFAULT_HOLE = 0;
const DEFAULT_FEED = 0;
const DEFAULT_FEED_CAP = 80;
const DEFAULT_STEAL = 0;
// Merges at or above this score are defence/rescue/siege decisions, not land
// economy, so `steal` never demotes them.
const DEFAULT_STEAL_CAP = 300;
const DEFAULT_MERGE = 0;
const DEFAULT_RAID = 0;
const DEFAULT_WATER = 0;
const DEFAULT_LEAD_CAP = 0;
// `1` = gate on the neutral frontier, `0` = off.
const DEFAULT_FRONTIER = 0;
const DEFAULT_FAN = 0;
const DEFAULT_CORRIDOR = 0;
const DEFAULT_FAN_ARMY = 5;
const DEFAULT_END_TURN = 0;
const DEFAULT_START_TURN = 0;

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
function mshapeConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.BOT3_MSHAPE, false),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_MSHAPE_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    slots: overrides.slots ?? number(env.BOT3_MSHAPE_SLOTS, DEFAULT_SLOTS, 1, 4096),
    capture: overrides.capture ?? number(env.BOT3_MSHAPE_CAPTURE, DEFAULT_CAPTURE, 0, 5000),
    ring: overrides.ring ?? number(env.BOT3_MSHAPE_RING, DEFAULT_RING, 0, 1000),
    ringCap: overrides.ringCap ?? number(env.BOT3_MSHAPE_RING_CAP, DEFAULT_RING_CAP, 1, 8),
    hole: overrides.hole ?? number(env.BOT3_MSHAPE_HOLE, DEFAULT_HOLE, 0, 5000),
    feed: overrides.feed ?? number(env.BOT3_MSHAPE_FEED, DEFAULT_FEED, 0, 5000),
    feedCap: overrides.feedCap ?? number(env.BOT3_MSHAPE_FEED_CAP, DEFAULT_FEED_CAP, 0, 1000),
    steal: overrides.steal ?? number(env.BOT3_MSHAPE_STEAL, DEFAULT_STEAL, 0, 5000),
    stealCap: overrides.stealCap ?? number(env.BOT3_MSHAPE_STEAL_CAP, DEFAULT_STEAL_CAP, 0, 5000),
    merge: overrides.merge ?? number(env.BOT3_MSHAPE_MERGE, DEFAULT_MERGE, 0, 5000),
    raid: overrides.raid ?? number(env.BOT3_MSHAPE_RAID, DEFAULT_RAID, 0, 5000),
    water: overrides.water ?? number(env.BOT3_MSHAPE_WATER, DEFAULT_WATER, 0, 5000),
    startTurn: overrides.startTurn ?? number(env.BOT3_MSHAPE_START, DEFAULT_START_TURN, 0, 10000),
    // Stand down once no neutral cell touches our border any more (`0` = off).
    // The layer prices the land race; with the race over every capture score it
    // moves is dead weight, and the merge pricing is exactly what the endgame
    // multi cells of the weaker opponents do not need.
    frontier: overrides.frontier ?? flag(env.BOT3_MSHAPE_FRONTIER, DEFAULT_FRONTIER === 1),
    // Corridor boards are excluded by default: the measured maze cells are 0.0
    // to -6.3pp under the layer (see ROUND15-MSHAPE.md), so a maze room keeps the
    // inherited sixteen-order shape until a corridor-specific plan is measured.
    corridor: overrides.corridor ?? flag(env.BOT3_MSHAPE_CORRIDOR, DEFAULT_CORRIDOR === 1),
    // Unlimited fronts: the rules allow one order per non-empty front per tick
    // and the engine runs every queued move whose source is not itself a target,
    // so one cell may attack two different neighbours in the same tick. See
    // `applyFan`.
    fan: overrides.fan ?? number(env.BOT3_MSHAPE_FAN, DEFAULT_FAN, 0, 3),
    // Minimum army before a capture is split into several fronts.
    fanArmy: overrides.fanArmy ?? number(env.BOT3_MSHAPE_FAN_ARMY, DEFAULT_FAN_ARMY, 2, 200),
    // Do not spend on breadth once our land already leads by this percent of the
    // rival's (`0` = off). The layer is an expansion layer for even and losing
    // games; standing down when we already own more land is what keeps the
    // already-won multi cells of the weaker opponents out of it.
    leadCap: overrides.leadCap ?? number(env.BOT3_MSHAPE_LEAD, DEFAULT_LEAD_CAP, 0, 1000),
    endTurn: overrides.endTurn ?? number(env.BOT3_MSHAPE_END, DEFAULT_END_TURN, 0, 10000),
  };
}

function freshMshape() {
  return { ticks: 0 };
}

const ownerOf = (code) => (code < 200 ? code % 50 : 0);
const swamp = (code) => code >= 150 && code !== 200 && code !== 201;

// Does any neutral cell still touch our territory? The land race is over when
// this is false: every capture score the layer moves is dead weight from then
// on, and the pulse that pays for land has nothing left to pay for.
function neutralFrontier(b, me) {
  const { size, neighbors, grid_type: tile } = b;
  for (let i = 0; i < size; i++) {
    if (tile[i] === 201 || ownerOf(tile[i]) === 0) continue;
    if (ownerOf(tile[i]) !== me) continue;
    for (const j of neighbors[i]) if (tile[j] !== 201 && ownerOf(tile[j]) === 0) return true;
  }
  return false;
}

// One call per planning tick. Returns null when the layer has nothing to say,
// which keeps the planner on the exact baseline path.
function mshapeUpdate(b, input, config = mshapeConfig()) {
  if (!config.enabled) return null;
  if (!input || input.multi !== true) return null;
  if (!(Number(input.size) <= config.maxBoard)) return null;
  const me = Number(input.me) || b.me;
  const turn = Math.max(0, Number(input.turn) || 0);
  if (turn < config.startTurn) return null;
  if (config.endTurn > 0 && turn >= config.endTurn) return null;
  if (!config.corridor && input.corridor === true) return null;
  const land = Math.max(0, Number(input.land) || 0);
  const enemyLand = Math.max(0, Number(input.enemyLand) || 0);
  if (config.leadCap > 0 && enemyLand > 0 && land * 100 > enemyLand * config.leadCap) return null;
  if (config.frontier && !neutralFrontier(b, me)) return null;
  const state = (b.mshapeLine ??= freshMshape());
  state.ticks += 1;
  return { config, turn, slots: config.slots, state };
}

// Plain (non-swamp) neutral neighbours of `i`: the frontier a capture of `i`
// would keep open. Swamp is excluded on purpose - it pays no pulse income, so it
// buys no army at the next growth tick.
function ringCount(ctx, i) {
  const { tile, teams, neighbors } = ctx;
  let open = 0;
  for (const j of neighbors[i]) {
    if (tile[j] === 201 || teams[j]) continue;
    if (swamp(tile[j])) continue;
    open++;
  }
  return open;
}

// Score adjustments. `ctx` carries the arrays the planner already built.
function applyMshape(plan, ctx, candidates) {
  const { config } = plan;
  const { tile, teams, neighbors, myTeam } = ctx;
  // Which cells can take a cell of somebody else's this tick, and at what score.
  // A merge that uses one of them as its source or its target spends the tick on
  // a one-army shuffle and invalidates the capture, so the capture has to win
  // the sort.
  const capture = config.steal > 0 ? new Map() : null;
  if (capture) {
    for (const op of candidates) {
      if (op.build || op.score <= 0) continue;
      if (teams[op.to] === myTeam) continue;
      capture.set(op.from, Math.max(capture.get(op.from) ?? -Infinity, op.score));
    }
  }
  for (const op of candidates) {
    if (op.build) continue;
    const to = teams[op.to];
    if (!to) {
      if (config.water && swamp(tile[op.to])) op.score -= config.water;
      if (config.capture) op.score += config.capture;
      if (config.ring || config.hole) {
        const ring = ringCount(ctx, op.to);
        if (config.ring) op.score += config.ring * Math.min(config.ringCap, ring);
        if (config.hole && ring === 0) op.score -= config.hole;
      }
      continue;
    }
    if (to !== myTeam) {
      // Taking a rival cell is a two-cell land swing (ours +1, theirs -1) for the
      // same army a neutral capture spends, which is why it outranks one while
      // the map still has room.
      if (config.raid) op.score += config.raid;
      continue;
    }
    // Own merge. Staging into a frontier cell buys tomorrow's capture; any other
    // merge only moves army that has nowhere to go.
    const destFront = neighbors[op.to].some((k) => tile[k] !== 201 && !teams[k]);
    if (config.feed && destFront && !(capture && capture.has(op.to))) {
      const send = Math.max(1, op.send || 1);
      op.score += Math.min(config.feedCap, config.feed) + Math.min(3, Math.sqrt(send) * 2);
    }
    if (config.merge && !destFront) op.score -= config.merge;
    if (capture) {
      // Never let a plain merge outrank the capture it would invalidate. Scores
      // in the hundreds are defence, rescue and siege work, which must keep
      // outranking a land capture, so those are left alone.
      const blocked = Math.max(capture.get(op.from) ?? -Infinity, capture.get(op.to) ?? -Infinity);
      if (blocked > -Infinity && op.score >= blocked && op.score < config.stealCap)
        op.score = blocked - config.steal;
    }
  }
}

// Unlimited fronts (see the header). A cell with a big stack and two or more
// neutral neighbours can take two cells in one tick if the pushes are halved:
// the engine runs every queued move whose source is not itself a move target, so
// both orders execute, the second on what the first left behind. Mode 1 halves
// the smart push, which is the only mode that leaves army for the second front.
// Only neutral targets are fanned: a halved push into a defended cell can fail
// and mutual destruction is the one way army disappears.
function applyFan(plan, ctx, orders) {
  const config = plan.config;
  if (!config.fan) return [];
  const { tile, teams, units, neighbors } = ctx;
  const extra = [];
  for (const op of orders) {
    if (op.build || op.mode !== 2) continue;
    if (teams[op.to]) continue;
    if ((units[op.from] || 0) < config.fanArmy) continue;
    if (extra.some((other) => other.from === op.from)) continue;
    const rest = [];
    for (const j of neighbors[op.from]) {
      if (j === op.to || tile[j] === 201 || teams[j]) continue;
      rest.push(j);
    }
    if (!rest.length) continue;
    // Keep the branch that reopens the most frontier for the primary order.
    rest.sort((a, c) => ringCount(ctx, c) - ringCount(ctx, a));
    op.mode = 1;
    for (const j of rest.slice(0, config.fan)) extra.push({ score: op.score, from: op.from, to: j, mode: 1, send: 0 });
  }
  return extra;
}

module.exports = {
  mshapeConfig,
  mshapeUpdate,
  applyMshape,
  applyFan,
  freshMshape,
  ringCount,
  neutralFrontier,
  DEFAULT_MAX_BOARD,
  DEFAULT_SLOTS,
  DEFAULT_CAPTURE,
  DEFAULT_RING,
  DEFAULT_RING_CAP,
  DEFAULT_HOLE,
  DEFAULT_FEED,
  DEFAULT_FEED_CAP,
  DEFAULT_STEAL,
  DEFAULT_STEAL_CAP,
  DEFAULT_MERGE,
  DEFAULT_RAID,
  DEFAULT_WATER,
  DEFAULT_LEAD_CAP,
  DEFAULT_FRONTIER,
  DEFAULT_FAN,
  DEFAULT_FAN_ARMY,
  DEFAULT_CORRIDOR,
  DEFAULT_START_TURN,
  DEFAULT_END_TURN,
};
