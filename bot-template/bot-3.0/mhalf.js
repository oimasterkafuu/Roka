'use strict';

// Sustained-pressure layer for multi-line rooms (round 16, `BOT3_MHALF`).
//
// Diagnosis. Round 15 measured the shape of a multi-line empire with
// `data/scratch/mhalf-probe.cjs`: after each growth pulse every owned plain
// holds exactly one army, only a handful of frontier cells hold two, and the
// army the pulse just paid sits two to six hops behind the ring. The inherited
// policy fires each frontier cell all-in (`mode 2`, "push everything but one")
// as soon as it holds two army, which is one capture per frontier cell per
// pulse, and spends the rest of the tick on merges whose destination is chosen
// by the serial objective terms (`route`, `heading`, `frontDist`, `defense`),
// not by distance to the ring. Measured on `random/bot3-baseline-1`: at t=60
// the empire has 75 land, 94 army, 12 frontier cells - and the army is 67 in
// one-army cells, 6 in two-army cells and 21 in stacks three or more hops
// behind the ring (`mass` histogram [1,1,3,1]). The ring therefore fires about
// once per tick while thirteen cells sit idle one hop away.
//
// Two rules, both read from the environment on each call, both inert unless
// `BOT3_MHALF=1` and the room is multi-line:
//
//   * `route` (default on): re-rank own merges by a hop field over our own
//     territory. A merge that steps one hop toward the ring (`hop[to] <
//     hop[from]`) earns a bonus that grows as the ring gets closer, and a merge
//     into a ring cell that cannot fire this tick (it holds one army) earns the
//     most: that is the reload. A merge that makes no progress toward the ring
//     is capped below the capture band. Scores of defence/rescue/siege work
//     (>= `exempt`) are never touched, and captures are never re-scored, so the
//     layer only decides *which staging merge* the tick pays for.
//   * `retain` (default on): choose the move mode per order instead of the
//     inherited "always 2". A capture keeps a rolling garrison (`mode 1`, the
//     engine's half push) when the halved push still takes the cell, the source
//     keeps at least `floor` army - so it can fire again next tick - and either
//     `retain=2` (any cell) or the source is a fork with another open target
//     (`retain=1`). `mode 2` stays for every other capture: a lone source with
//     one open direction gains nothing by keeping mass behind it, because the
//     captured cell inherits the army either way.
//
// Measured negatives are kept behind switches (`cheap`, `leak`, `relayGate`),
// see ROUND16-MHALF.md.

const DEFAULT_MAX_BOARD = 800;
// A cell that fires must keep at least this much army to be able to fire again
// on the next tick (a push needs two army on the source).
const DEFAULT_FLOOR = 2;
// How many other open directions make a source a fork worth keeping mass for.
const DEFAULT_FORK = 1;
const DEFAULT_ROUTE = 1;
// Measured neutral (see ROUND16-MHALF.md): the halved push almost never takes a
// cell a ring cell could not already take, so the mode policy ships off.
const DEFAULT_RETAIN = 0;
// Bonus for a merge that steps one hop toward the ring, and the per-hop decay
// that makes the last hop (the reload) the most valuable one.
const DEFAULT_CONVOY = 0;
const DEFAULT_HOP = 6;
// Extra bonus for refilling a ring cell that holds one army: that cell cannot
// capture this tick, so a merge into it invalidates nothing.
const DEFAULT_RELOAD = 60;
// A merge that makes no hop progress is capped here, i.e. below every capture
// score the planner proposes (the cheapest neutral capture scores 32).
const DEFAULT_STALE = 28;
// Optional: prefer cheap captures (the defender's garrison is the whole cost).
const DEFAULT_CHEAP = 0;
// Scores at or above this are defence/rescue/siege decisions and stay untouched.
const DEFAULT_EXEMPT = 300;
// Corridor boards keep the inherited shape: the ring is one cell wide, so a hop
// field has nothing to route (see ROUND15-MSHAPE.md for the same measurement).
const DEFAULT_CORRIDOR = 0;
const DEFAULT_FOG = 1;
const DEFAULT_LEAD = 110;
const DEFAULT_START = 0;
const DEFAULT_END = 0;
// Refill a ring cell that already holds two army: it fires anyway this tick, so
// the delivery only makes its fire wait one tick (`leak` reproduces the loss).
const DEFAULT_LEAK = 0;
// Army a cell needs before an all-in push can take a one-army garrison.
const DEFAULT_MIN_FIRE = 3;
// Cap merges that stay at the same hop distance (`0` = leave them alone).
const DEFAULT_SIDEWAYS = 0;
// Bonus per plain (non-swamp) neutral neighbour of the ring cell being armed:
// an armed cell that only faces swamp buys land with no pulse income.
const DEFAULT_ARM_RING = 0;
// Charge for arming a ring cell whose whole open frontier is swamp.
const DEFAULT_ARM_WATER = 0;

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
function mhalfConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.BOT3_MHALF, true),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_MHALF_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    route: overrides.route ?? number(env.BOT3_MHALF_ROUTE, DEFAULT_ROUTE, 0, 1),
    retain: overrides.retain ?? number(env.BOT3_MHALF_RETAIN, DEFAULT_RETAIN, 0, 2),
    floor: overrides.floor ?? number(env.BOT3_MHALF_FLOOR, DEFAULT_FLOOR, 1, 50),
    fork: overrides.fork ?? number(env.BOT3_MHALF_FORK, DEFAULT_FORK, 0, 4),
    convoy: overrides.convoy ?? number(env.BOT3_MHALF_CONVOY, DEFAULT_CONVOY, 0, 5000),
    hop: overrides.hop ?? number(env.BOT3_MHALF_HOP, DEFAULT_HOP, 0, 200),
    reload: overrides.reload ?? number(env.BOT3_MHALF_RELOAD, DEFAULT_RELOAD, 0, 5000),
    stale: overrides.stale ?? number(env.BOT3_MHALF_STALE, DEFAULT_STALE, 0, 5000),
    cheap: overrides.cheap ?? number(env.BOT3_MHALF_CHEAP, DEFAULT_CHEAP, 0, 5000),
    exempt: overrides.exempt ?? number(env.BOT3_MHALF_EXEMPT, DEFAULT_EXEMPT, 0, 5000),
    leak: overrides.leak ?? number(env.BOT3_MHALF_LEAK, DEFAULT_LEAK, 0, 1),
    minFire: overrides.minFire ?? number(env.BOT3_MHALF_MIN_FIRE, DEFAULT_MIN_FIRE, 2, 50),
    sideways: overrides.sideways ?? number(env.BOT3_MHALF_SIDEWAYS, DEFAULT_SIDEWAYS, 0, 1),
    armRing: overrides.armRing ?? number(env.BOT3_MHALF_ARM_RING, DEFAULT_ARM_RING, 0, 5000),
    armWater: overrides.armWater ?? number(env.BOT3_MHALF_ARM_WATER, DEFAULT_ARM_WATER, 0, 5000),
    corridor: overrides.corridor ?? flag(env.BOT3_MHALF_CORRIDOR, DEFAULT_CORRIDOR === 1),
    fog: overrides.fog ?? flag(env.BOT3_MHALF_FOG, DEFAULT_FOG === 1),
    leadCap: overrides.leadCap ?? number(env.BOT3_MHALF_LEAD, DEFAULT_LEAD, 0, 1000),
    startTurn: overrides.startTurn ?? number(env.BOT3_MHALF_START, DEFAULT_START, 0, 10000),
    endTurn: overrides.endTurn ?? number(env.BOT3_MHALF_END, DEFAULT_END, 0, 10000),
  };
}

function freshMhalf() {
  return { ticks: 0 };
}

const ownerOf = (code) => (code < 200 ? code % 50 : 0);
const swamp = (code) => code >= 150 && code !== 200 && code !== 201;

// One call per planning tick. Returns null when the layer has nothing to say,
// which keeps the planner on the exact inherited path.
function mhalfUpdate(b, input, config = mhalfConfig()) {
  if (!config.enabled) return null;
  if (!input || input.multi !== true) return null;
  if (!(Number(input.size) <= config.maxBoard)) return null;
  const turn = Math.max(0, Number(input.turn) || 0);
  if (turn < config.startTurn) return null;
  if (config.endTurn > 0 && turn >= config.endTurn) return null;
  if (config.fog === false && input.fog === true) return null;
  if (!config.corridor && input.corridor === true) return null;
  const land = Math.max(0, Number(input.land) || 0);
  const enemyLand = Math.max(0, Number(input.enemyLand) || 0);
  if (config.leadCap > 0 && enemyLand > 0 && land * 100 > enemyLand * config.leadCap) return null;
  const state = (b.mhalfLine ??= freshMhalf());
  state.ticks += 1;
  return { config, turn, state, ring: null, hop: null };
}

// `ring[i]`: our cell that touches a non-own, non-water cell (the frontier the
// next capture comes from). `hop[i]`: hops from i to the nearest ring cell
// through our own territory; -1 inside a pocket that does not reach the ring.
function mhalfField(tile, teams, neighbors, myTeam) {
  const size = tile.length;
  const ring = new Uint8Array(size);
  const hop = new Int16Array(size).fill(-2);
  const queue = [];
  for (let i = 0; i < size; i++) {
    if (teams[i] !== myTeam) continue;
    if (neighbors[i].some((j) => tile[j] !== 201 && teams[j] !== myTeam)) {
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
  return { ring, hop };
}

// Open directions of `i` other than `to`: a cell that keeps mass in `retain`
// mode is only useful if it still has somewhere to send it next tick.
function forkCount(tile, teams, neighbors, myTeam, i, to) {
  let open = 0;
  for (const j of neighbors[i]) {
    if (j === to || tile[j] === 201 || teams[j] === myTeam) continue;
    open += 1;
  }
  return open;
}

// The engine's push for each mode (`computePush` in src/game-engine.ts):
// mode 2 pushes `total - 1`; modes 0/1 reserve the threat sum `B` of the other
// non-friendly neighbours and push `total - B - 1`, halved for mode 1.
function mhalfPush(tile, teams, units, neighbors, myTeam, i, to) {
  const total = units[i];
  const cap = Math.max(0, total - 1);
  let threat = 0;
  for (const j of neighbors[i]) {
    if (j === to || tile[j] === 201) continue;
    if (teams[j] === myTeam) continue;
    threat += units[j] - 1;
  }
  const theory = Math.max(0, total - threat - 1);
  return {
    mode0: Math.min(theory, cap),
    mode1: Math.min(Math.floor(theory / 2), cap),
    mode2: cap,
  };
}

// Re-rank our own merges by the hop field and by what the merge buys.
//
// A capture needs `minFire` army on the ring cell (all-in pushes `total - 1`,
// and a push has to *strictly* beat the defender, so two army cannot take even
// an empty cell and three army is the cheapest capture against a one-army
// garrison). A delivery that leaves the target one army short is therefore the
// worst order in the game: it spends a slot, spends the source's army and still
// cannot fire. The layer prices deliveries by the army the target holds *after*
// the merge:
//   * `arming`  - a ring cell that reaches `minFire`: the reload, best score;
//   * `convoy`  - a merge that steps one hop toward the ring with a stack that
//                 survives the trip;
//   * `pit`     - any merge that lands below `minFire` on the ring, or walks
//                 away from it: capped below the cheapest capture (`stale`).
// Merges that make no hop progress are left alone: stacking two interior cells
// is how the next stack that can fire gets built, and capping it only starves
// the ring (measured: `ROUTE=1 STALE=28` loses 26 wins).
function applyMhalf(plan, ctx, candidates) {
  const cfg = plan.config;
  if (!cfg.route) return;
  const { tile, teams, units, neighbors, myTeam } = ctx;
  const field = mhalfField(tile, teams, neighbors, myTeam);
  plan.ring = field.ring;
  plan.hop = field.hop;
  const counts = { arm: 0, convoy: 0, pit: 0 };
  for (const op of candidates) {
    if (op.build) continue;
    if (op.score >= cfg.exempt) continue;
    const own = teams[op.to] === myTeam;
    if (!own) {
      if (cfg.cheap) op.score += cfg.cheap * Math.max(0, cfg.minFire - 1 - units[op.to]);
      continue;
    }
    const from = plan.hop[op.from];
    const to = plan.hop[op.to];
    if (from < 0 || to < 0) continue;
    const send = Math.max(1, op.send || 1);
    const result = units[op.to] + units[op.from] - 1;
    if (to === 0) {
      // Only an unloaded ring cell is worth refilling: a ring cell that already
      // holds `minFire` army captures this tick, and boosting a merge into it
      // would outrank (and so cancel) that capture, which is the measured
      // `feed` failure of round 15. Deliveries also come from behind the ring
      // (`from >= 1`), never ring-to-ring.
      if (units[op.to] < cfg.minFire && from >= 1 && result >= cfg.minFire) {
        let bonus = cfg.reload + Math.min(24, result * 2) - cfg.hop * Math.min(4, from);
        if (cfg.armRing || cfg.armWater) {
          let plain = 0;
          for (const k of neighbors[op.to])
            if (tile[k] !== 201 && teams[k] !== myTeam && !swamp(tile[k])) plain += 1;
          bonus += cfg.armRing * Math.min(4, plain);
          if (!plain) bonus -= cfg.armWater;
        }
        op.score += bonus;
        counts.arm += 1;
        continue;
      }
      if (units[op.to] < cfg.minFire) {
        op.score = Math.min(op.score, cfg.stale);
        counts.pit += 1;
      }
      continue;
    }
    if (to < from) {
      op.score += cfg.convoy + cfg.hop * (5 - Math.min(5, to)) + Math.min(20, send * 2);
      counts.convoy += 1;
      continue;
    }
    if (to === from && cfg.stale > 0 && cfg.sideways) {
      op.score = Math.min(op.score, cfg.stale);
      counts.pit += 1;
    }
  }
  plan.state.arm = counts.arm;
  plan.state.convoy = counts.convoy;
  plan.state.pit = counts.pit;
}

// Choose the mode of every capture instead of the inherited constant 2.
function applyMhalfModes(plan, ctx, orders) {
  if (!plan.config.retain) return;
  const { tile, teams, units, neighbors, myTeam } = ctx;
  const { floor, fork, retain } = plan.config;
  let kept = 0;
  for (const op of orders) {
    if (op.build || op.mode !== 2) continue;
    if (teams[op.to] === myTeam) continue;
    const total = units[op.from];
    if (total < 4) continue;
    const push = mhalfPush(tile, teams, units, neighbors, myTeam, op.from, op.to);
    // The halved push has to take the cell, and what stays behind has to be
    // able to fire again on the next tick.
    if (push.mode1 <= units[op.to]) continue;
    if (total - push.mode1 < floor) continue;
    if (retain === 1 && forkCount(tile, teams, neighbors, myTeam, op.from, op.to) < fork) continue;
    op.mode = 1;
    kept += 1;
  }
  plan.state.kept = kept;
}

module.exports = {
  mhalfConfig,
  mhalfUpdate,
  mhalfField,
  mhalfPush,
  forkCount,
  applyMhalf,
  applyMhalfModes,
  freshMhalf,
  DEFAULT_MAX_BOARD,
  DEFAULT_FLOOR,
  DEFAULT_FORK,
  DEFAULT_ROUTE,
  DEFAULT_RETAIN,
  DEFAULT_CONVOY,
  DEFAULT_HOP,
  DEFAULT_RELOAD,
  DEFAULT_STALE,
  DEFAULT_CHEAP,
  DEFAULT_EXEMPT,
  DEFAULT_CORRIDOR,
  DEFAULT_FOG,
  DEFAULT_LEAD,
  DEFAULT_START,
  DEFAULT_END,
  DEFAULT_LEAK,
  DEFAULT_MIN_FIRE,
  DEFAULT_SIDEWAYS,
  DEFAULT_ARM_RING,
  DEFAULT_ARM_WATER,
};
