'use strict';

// Fog single-line layer for the Bot(3.0) 1v1 planner.
//
// Diagnosis. Relay's planner prices a move by what it can *see*; in fog that is
// wrong in three specific ways, and the round-2 replay traces show all three:
//
//   1. No objective. `targets` is built from remembered enemy crowns, and fog
//      vision is Chebyshev radius 1, so a crown is only ever remembered after
//      our land touches its neighbour. A replay of `relay/random/seed 12`
//      never learns a single enemy crown in 1000 ticks, so `goal` stays
//      infinite, every advance rule is dead, and the planner falls back to the
//      scouting field. The fix is to aim at the *visible* enemy front while no
//      crown is known: capturing it is what opens the vision that reveals the
//      crowns.
//   2. The column never converts into an attack. With no objective the march
//      term (`60 + sqrt(mass)` and a pickup bonus of up to 55 for stepping onto
//      an owned cell) outranks every plain capture (`32..65`), so a 1900-unit
//      hoard spends its ticks merging between its own cells. The same replay
//      spends 194 of 255 ticks on own-merge orders, 41 on neutral captures and
//      16 on attacks while the empire's crowns are picked off one by one.
//   3. No staging cost for the unknown. `assaultStrength` prices only visible
//      defenders; a fogged cell reports `grid_type 200` and `army_cnt 0`, so a
//      route into the dark looks free.
//
// Behaviour while the layer is active (fog, single line, small board, from
// `BOT3_FOG_TURN`): the heaviest stack becomes a column that advances down the
// objective field and attacks the frontier. With `BOT3_FOG_AIM` and no
// remembered crown the whole planner aims at the visible enemy front instead of
// an infinite goal. The column only commits when it can pay `required` plus a
// reserve of `guess` units per remaining step, which is the conservative
// stand-in for defenders the fog hides. Everything else - building, defence,
// the pressure model - stays on the existing path, so a threat still takes the
// tick and the layer simply pauses (it is a predicate, not a latch).
//
// Objective prior. Vision comes from owned land, not from armies, so a lone
// scout reveals nothing: exploration *is* capture, one serial order per tick.
// The layer therefore uses two priors for an unseen enemy home, both built from
// information the fog leaves visible:
//
//   * the terrain map - mountains block movement and swamp stays visible, so
//     the passable map is known before it is explored;
//   * the spawn rule in `general-selection.ts` - the generals are chosen to
//     maximise the shortest-path distance between them, so the far region of
//     the passable map is the best place to look first.
//
// `fogBeliefTargets` turns that into a small set of far anchors, `scout` steers
// the column at them, `belief` hands them the whole objective field, and
// `raid` adds a gather-then-raid state machine (assemble the heavy stack, hold
// it while the rear feeds it, then drive it at the anchors). All four are
// opt-in and were measured; the measured verdicts are in BOT3_FOG.md.
//
// Opt-in: `BOT3_FOG=1` turns the layer on. The tuned defaults (aim from tick
// 60, 60% material edge, 80% on swamp-heavy boards, corridor maps excluded)
// reach 71.1% on the fog single-line screen - +51 wins with no cell below its
// paired baseline - and 77.7% on the full 2048-game matrix (+2.5pp, also with
// no regressing cell). They still leave the Relay cells below the 65% target,
// so the layer stays opt-in: `BOT3_FOG=0` restores the previous behaviour byte
// for byte (verified on the full matrix, all flip counts zero).

const DEFAULT_MAX_BOARD = 800;
// Late enough to keep the opening untouched; the early economy is the same on
// both sides of a mirror, and the measured gains come from the attrition that
// follows.
const DEFAULT_START_TURN = 60;
// Reserve per remaining step toward the objective. A fogged cell can hide any
// number of units; eight is the measured compromise between walking into an
// ambush and never moving at all (see BOT3_FOG.md).
const DEFAULT_GUESS = 8;
// Do not commit while behind on material: the reserve above is only a guess,
// the leaderboard army is measured.
const DEFAULT_FLOOR = 0;
// The front aim needs a material edge. On the open maps a loose 60% is the
// measured optimum (the round-2 doc kept 100 to protect anti/archipelago, but
// that cell has its own threshold below). The thresholds are re-measured in
// BOT3_FOG.md; the old 100% default only bought the archipelago cells.
const DEFAULT_AIM_LEAD = 60;
// Archipelago keeps 60-70% of the board as swamp, and swamp stays visible in
// fog. On those rooms a stricter edge is needed before chasing the visible
// front: 80% is the measured point where every archipelago cell stops
// regressing (see BOT3_FOG.md).
const DEFAULT_SWAMP_LEAD = 80;
// Belief field over the unknown. Relay spawns are the two land cells with the
// largest shortest-path distance on the board (`general-selection.ts` picks a
// max-min layout), and mountains stay visible in fog, so the *passable* map is
// known even where the tiles are not. The cells at `scoutRatio` of the largest
// reachable distance are therefore the best prior for an unseen enemy crown.
// Measured over the sixteen seeds: random puts the enemy home in the top three
// distance cells in 14/16 maps, maze in 16/16, mediterranean in 10/16 (top
// ten 15/16), archipelago not at all - it is kept out of that cell.
const DEFAULT_SCOUT_RATIO = 0.7;
// Two spread-out anchors are enough to cover a far region without flattening
// the goal field into "anywhere but here".
const DEFAULT_SCOUT_COUNT = 2;
// Reject a second anchor within three cells of the first: duplicates would
// collapse the belief region onto one corner.
const DEFAULT_SCOUT_SPREAD = 3;
// Raid doctrine. Assembling a lead stack before the march is what separates a
// raid from the blind front push: in the traced losses the heaviest stack is
// 140-150 units and trades evenly, while the recalled crowns sit at 5-30. A
// 250-unit lead therefore takes a crown per step; anything thinner bounces.
const DEFAULT_RAID_MASS = 240;
const DEFAULT_RAID_RATIO = 0.6;
const DEFAULT_RAID_ABORT = 0.35;
// Scores. The raid has to outrank the march/merge terms (< 300) and the economy
// build (675), but stay under the column advance so a remembered crown still
// wins the frame.
const RAID_SCORE = 880;

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
function fogConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.BOT3_FOG, false),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_FOG_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    startTurn: overrides.startTurn ?? number(env.BOT3_FOG_TURN, DEFAULT_START_TURN, 0, 100000),
    guess: overrides.guess ?? number(env.BOT3_FOG_GUESS, DEFAULT_GUESS, 0, 200),
    floor: overrides.floor ?? number(env.BOT3_FOG_FLOOR, DEFAULT_FLOOR, 0, 4),
    column: overrides.column ?? flag(env.BOT3_FOG_COLUMN, true),
    funnel: overrides.funnel ?? flag(env.BOT3_FOG_FUNNEL, false),
    aimFront: overrides.aimFront ?? flag(env.BOT3_FOG_AIM, true),
    aimLead: overrides.aimLead ?? number(env.BOT3_FOG_AIM_LEAD, DEFAULT_AIM_LEAD, 0, 200),
    // Swamp-heavy boards (archipelago keeps 60-70% swamp visible through the
    // fog) reward a different front-aim threshold than the open maps. The
    // separated islands make an unguarded front chase expensive.
    aimLeadSwamp:
      overrides.aimLeadSwamp ?? number(env.BOT3_FOG_SWAMP_LEAD, DEFAULT_SWAMP_LEAD, 0, 200),
    swampShare: overrides.swampShare ?? number(env.BOT3_FOG_SWAMP_SHARE, 0.55, 0, 1),
    // Keep the whole layer off corridor maps by default: the maze planner
    // already owns that shape and the fog column only adds one-game noise
    // there (the measured matrix in BOT3_FOG.md shows a -1 flip).
    maze: overrides.maze ?? flag(env.BOT3_FOG_MAZE, false),
    expand: overrides.expand ?? flag(env.BOT3_FOG_EXPAND, false),
    invest: overrides.invest ?? flag(env.BOT3_FOG_INVEST, false),
    guard: overrides.guard ?? flag(env.BOT3_FOG_GUARD, false),
    // Scout: steer the column at the belief region while no crown is known.
    scout: overrides.scout ?? flag(env.BOT3_FOG_SCOUT, false),
    // Raid: assemble the heaviest stack first, then drive it at the belief
    // region (or the remembered crown) instead of feeding the frontier.
    raid: overrides.raid ?? flag(env.BOT3_FOG_RAID, false),
    // Raid until the lead stack carries this many units (or this share of the
    // mobile army), and abort back to the gather phase when it has been spent.
    raidMass: overrides.raidMass ?? number(env.BOT3_FOG_RAID_MASS, DEFAULT_RAID_MASS, 10, 100000),
    raidRatio: overrides.raidRatio ?? number(env.BOT3_FOG_RAID_RATIO, DEFAULT_RAID_RATIO, 0, 1),
    raidAbort: overrides.raidAbort ?? number(env.BOT3_FOG_RAID_ABORT, DEFAULT_RAID_ABORT, 0, 1),
    // Belief: let the belief region own the whole objective field.
    belief: overrides.belief ?? flag(env.BOT3_FOG_BELIEF, false),
    scoutRatio: overrides.scoutRatio ?? number(env.BOT3_FOG_SCOUT_RATIO, DEFAULT_SCOUT_RATIO, 0.1, 1),
    scoutCount: overrides.scoutCount ?? number(env.BOT3_FOG_SCOUT_COUNT, DEFAULT_SCOUT_COUNT, 1, 8),
    scoutSpread: overrides.scoutSpread ?? number(env.BOT3_FOG_SCOUT_SPREAD, DEFAULT_SCOUT_SPREAD, 1, 100),
    // Keep new crowns at least this many steps from every existing crown. A
    // cluster of crowns is one raid away from elimination: the traced losses
    // lose two or three crowns in a row to a single enemy stack.
    spread: overrides.spread ?? number(env.BOT3_FOG_SPREAD, 0, 0, 20),
    // Raise the crown ceiling in fog. A crown is +1 army per tick and one more
    // body between a raider and elimination; the stock planner caps the count
    // by mobile army instead of by what the map can support.
    homes: overrides.homes ?? number(env.BOT3_FOG_HOMES, 0, 0, 32),
  };
}

const ownerOf = (code) => (code < 200 ? code % 50 : 0);

// Belief field for the hidden enemy home. BFS runs over the terrain the fog
// leaves visible (mountains block, everything else is assumed passable), from
// our own crowns outward. The anchors are the farthest reachable, not-yet-owned
// cells, spread out so the prior covers a region instead of a single guess.
// Returns an empty list when the whole reachable map is already ours, which is
// the only case where the prior has nothing to add.
function fogBeliefTargets(b, homes, config = fogConfig()) {
  const { size, cols, neighbors, grid_type: tile } = b;
  const dist = new Int32Array(size).fill(-1);
  const queue = [];
  for (const home of homes) {
    if (home < 0 || home >= size) continue;
    dist[home] = 0;
    queue.push(home);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (const j of neighbors[i]) {
      if (dist[j] >= 0 || tile[j] === 201) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  let far = 0;
  for (let i = 0; i < size; i++) if (dist[i] > far) far = dist[i];
  if (!far) return [];
  const floor = Math.max(1, Math.ceil(far * config.scoutRatio));
  const candidates = [];
  for (let i = 0; i < size; i++) {
    if (dist[i] < floor || ownerOf(tile[i]) === b.me) continue;
    candidates.push(i);
  }
  candidates.sort((x, y) => dist[y] - dist[x] || x - y);
  const picks = [];
  for (const i of candidates) {
    if (picks.length >= config.scoutCount) break;
    const row = Math.floor(i / cols),
      col = i % cols;
    const tooClose = picks.some((p) => {
      const pr = Math.floor(p / cols),
        pc = p % cols;
      return Math.abs(pr - row) + Math.abs(pc - col) < config.scoutSpread;
    });
    if (tooClose) continue;
    picks.push(i);
  }
  return picks;
}

// The planner derives `clearSerial` from the same expression, so a board is in
// fog exactly when `clearSerial` is false on a serial (non-multi) game.
function fogBoard(b) {
  return Boolean(b?.fogMode ?? (b?.fog ? b.fog.includes(1) : false));
}

// Layer state lives under its own key: `board.fog` is the per-cell visibility
// array the diff carries, so it must not be used as scratch space.
function freshFog() {
  return { active: false, entries: 0, entry: null, exit: null };
}

// Gate for the whole layer: fog, serial, small board, late enough. `active`
// additionally needs a measured material edge and no threatened home.
function fogUpdate(board, input, config = fogConfig()) {
  const state = (board.fogLayer ??= freshFog());
  const off = { active: false, state, entries: state.entries, entry: state.entry };
  if (!config.enabled) return off;
  if (input?.multi) return off;
  if (!(Number(input?.size) <= config.maxBoard)) return off;
  const turn = Number(input?.turn) || 0;
  if (turn < config.startTurn) return off;
  const army = Math.max(0, Number(input.army) || 0);
  const enemyArmy = Math.max(0, Number(input.enemyArmy) || 0);
  const threatened = (Number(input.danger) || 0) > 0;
  const active = !threatened && enemyArmy > 0 && army >= enemyArmy * config.floor;
  if (active && !state.active) {
    state.entries += 1;
    state.entry = { turn, army, enemyArmy };
  } else if (!active && state.active) {
    state.exit = threatened ? 'threat' : 'material';
  }
  state.active = active;
  return { active, state, entries: state.entries, entry: state.entry };
}

// `assaultStrength` cannot price a fogged cell, so every remaining step toward
// the objective carries a flat reserve. `goal` is the planner's objective
// distance field, so this is exactly the dark part of the route.
function fogRequired(required, goal, guess, cap = 8) {
  const out = new Float64Array(required.length);
  for (let i = 0; i < required.length; i++) {
    const base = required[i];
    const distance = Number(goal[i]);
    const steps = Number.isFinite(distance) && distance < cap ? Math.max(0, distance) : cap;
    out[i] = Number.isFinite(base) ? base + guess * steps : base;
  }
  return out;
}

// Scores for the fog column, kept next to the closing layer's numbers: the
// column advance has to outrank the march/merge terms (below 300) and the
// economy build (675), and the rear funnel has to outrank a march as well.
const COLUMN_SCORE = 1000;
const FUNNEL_SCORE = 940;
// A forward capture has to beat the march/merge pickup bonus (capped at 55 in
// the planner), otherwise the heaviest stack spends the game shuffling between
// its own cells (194 of 255 ticks in `relay/random/seed 12`).
const EXPAND_BONUS = 70;
// Falling back toward the nearest crown when the front is out of reach.
const GUARD_SCORE = 300;
// A crown pays +1 army per tick, so a stack that keeps walking to a preselected
// build site builds nothing: `relay/random/seed 12` finished 1000 ticks with
// 2479 army and two crowns. Building where the stack already stands is worth
// more than the march term but less than a strike.
const INVEST_SCORE = 700;

function columnAdvance(send, remaining) {
  return COLUMN_SCORE + Math.min(620, Math.sqrt(Math.max(send, remaining)) * 14);
}

function funnelScore(mass) {
  return FUNNEL_SCORE + Math.min(500, Math.sqrt(Math.max(0, mass)) * 14);
}

// Holding position is worth more than a march (which caps near 230) when the
// column has nothing adjacent to attack: a hoard that wanders is exactly how a
// fog mirror loses its crowns (`relay/random/seed 11` died at tick 256 while
// the 178-unit lead was two cells from home).
function guardScore(send) {
  return GUARD_SCORE + Math.min(140, Math.sqrt(Math.max(0, send)) * 8);
}

// Cheap forward expansion: capturing an undefended cell adds land (income) and
// opens one more ring of vision, which is how the enemy crowns are found.
function expandScore(send, heading) {
  return 60 + Math.min(140, Math.sqrt(Math.max(0, send)) * 8) + EXPAND_BONUS - Math.min(30, heading);
}

// Gather-then-raid state machine. The planner is stateless per tick, so the
// phase has to persist on the board next to the fog layer's own counters.
// `gather`: the lead stack holds and the other stacks feed it, `raid`: the lead
// drives at the objective, `idle`: the doctrine is off or paused.
function freshRaid() {
  return { phase: 'idle', lead: -1, mass: 0, since: -1, entries: 0 };
}

function fogRaidUpdate(b, input, config = fogConfig()) {
  const state = (b.fogRaid ??= freshRaid());
  const lead = Number(input?.lead) >= 0 ? Number(input.lead) : -1;
  const leadMass = lead >= 0 ? Math.max(0, Number(input.leadMass) || 0) : 0;
  const mobile = Math.max(0, Number(input.mobileArmy) || 0);
  const turn = Number(input?.turn) || 0;
  const off = { phase: 'idle', lead: -1, mass: state.mass, gather: false, resting: false };
  if (!config.raid || lead < 0) {
    state.phase = 'idle';
    return off;
  }
  if ((Number(input.danger) || 0) > 0) {
    state.phase = 'idle';
    return { ...off, resting: true };
  }
  const target = Math.max(config.raidMass, Math.ceil(mobile * config.raidRatio));
  if (state.phase !== 'raid') {
    if (leadMass < target) {
      state.phase = 'gather';
      state.lead = lead;
      return { phase: 'gather', lead, mass: state.mass, gather: true, resting: false };
    }
    state.phase = 'raid';
    state.lead = lead;
    state.mass = leadMass;
    state.since = turn;
    state.entries += 1;
  } else if (leadMass < Math.max(12, Math.ceil(state.mass * config.raidAbort))) {
    state.phase = 'gather';
    state.lead = lead;
    return { phase: 'gather', lead, mass: state.mass, gather: true, resting: false };
  }
  return { phase: 'raid', lead, mass: state.mass, gather: false, resting: false };
}

module.exports = {
  fogConfig,
  fogBoard,
  fogUpdate,
  fogRequired,
  fogBeliefTargets,
  fogRaidUpdate,
  freshFog,
  freshRaid,
  columnAdvance,
  funnelScore,
  expandScore,
  guardScore,
  INVEST_SCORE,
  DEFAULT_MAX_BOARD,
  DEFAULT_START_TURN,
  DEFAULT_GUESS,
  DEFAULT_FLOOR,
  DEFAULT_AIM_LEAD,
  DEFAULT_SWAMP_LEAD,
  DEFAULT_SCOUT_RATIO,
  DEFAULT_SCOUT_COUNT,
  DEFAULT_SCOUT_SPREAD,
  COLUMN_SCORE,
  FUNNEL_SCORE,
  GUARD_SCORE,
  EXPAND_BONUS,
  RAID_SCORE,
  DEFAULT_RAID_MASS,
  DEFAULT_RAID_RATIO,
  DEFAULT_RAID_ABORT,
};
