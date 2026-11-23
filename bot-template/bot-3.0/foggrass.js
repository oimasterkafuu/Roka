'use strict';

// Grass-fog multi-line doctrine (`BOT3_FOGRASS`, round 20, default off).
//
// Why this cell. `random` + fog + multi is the one relay cell with no purchase
// for the crown economy: its swamp share is 7-11 %, so both crown banks'
// geometry gates (`./bankgate` and `./mcrown2` via `BOT3_FOGBANK`) exclude it,
// and every bank variant measured -12 to -22 pp there (ROUND19-FOGBANK.md). It
// is also the cell where the exact search cannot work (fog hides the rival's
// board, so `./mqueue` refuses the room), which leaves the plain round-16
// policy: relay keeps no belief model, and in a multi room it has no objective
// field at all (`goal` is infinite until a crown is remembered, so the
// 285-point advance term never fires). It plays reactively off visible cells.
//
// Probe (`foggrass-probe.cjs`, 32 games, seeds 1-16, both seats):
//
//   * relay spends **122 013 of 122 018** moves on `mode 2` (all-in: push
//     everything but one) and 110 693 of its 122 018 moves are own merges. The
//     merges are forward (99 % toward our home), so relay is a conveyor belt:
//     rear army walks to its ring, the ring fires all-in.
//   * a relay ring cell holds 1 army in **3481** samples and 2 in 1375 (per
//     game, ring cells sampled once per tick); its pushes leave the source at
//     exactly 1.
//   * 10 819 relay captures, **8717 of them into a garrison of <= 1** (5570
//     of our cells lost at garrison 1, 1298 at 2). A defender of 2 forces a
//     3+ push and costs the attacker 2 army; a defender of 1 is free.
//   * relay has a winnable adjacent cell on 382 tick-cells per game and fires
//     from **84 %** of them - "a relay cell with a beatable neighbour is about
//     to empty" is a real public-information prior, not a guess.
//   * our own ring answers with 1 army in 86 % of its samples, so relay's
//     3-stacks take our cells for free in exactly the spot its own all-in
//     doctrine leaves its sources.
//
// Two reactions, both public-information only (visible garrisons and the known
// seat order; no batch prediction), and both gated to a grass fog multi room
// (`fog && multi && swamp share < 25 %`; corridor boards stay out like every
// other multi layer). Neither reaches the 21/32 bar; the measured tables are in
// ROUND20-FOGGRASS.md, and the verdicts are reproduced here so the negatives are
// not lost:
//
//   * `ring` (doctrine A, **off**): an own ring cell that faces a visible rival
//     stack of 3+ is a cell relay can take for free while it holds one army.
//     Hold it at `threat - 1` army (a capture has to strictly beat the
//     garrison, so 3 needs 4), capped by `holdCap`, fed by a merge from behind,
//     and do not let it fire the garrison away for a neutral capture while the
//     stack is still there. Threat 2 needs no reaction: a 2-stack cannot take
//     even a one-army cell. Measured: it works as designed (relay's failed
//     attacks rise 506 -> 699 per 32 games, i.e. ~6 free captures per game
//     become mutual destruction) but the wins do not follow: 17/32 on the
//     screen, 0 flips on the independent half.
//   * `counter` (doctrine B, **off**): when the rival resolves first on the
//     next tick, a visible rival cell that holds 2+ and has a beatable
//     neighbour is about to empty itself. A free own cell next to it with 3+
//     army attacks it: relay's push lands first (leaving one), the counter
//     lands second and takes the cell. Measured: 37 opportunities per game,
//     relay fires on 54 % of them; 15/32 on the screen (-2), the gains and the
//     losses are both in the player-1 side of the mirror.
//
// What ships when the switch is on is the one mechanism the probe found that
// moves the whole cell: **pulse capture discipline**. In a multi room the only
// army source is the growth pulse (`turn % 50 === 0`, +1 per owned plain), and
// the tick that pays for land is planned on the frame after `turn % 50 === 49`.
// On that frame every ring cell is about to hold two army and can capture, but
// `./mhalf`'s ring refill (bonus 60) also reaches `minFire` on the same frame,
// wins the sort and cancels the capture it was arming (the engine refuses a
// move out of a cell that is another move's target). Measured on the probe: the
// pulse tick captures 10 cells per game under the shipped stack against relay's
// 16.7. Lowering the refill bonus to `reload` recovers most of them; the cell
// goes 17 -> 19 on seeds 1-16 and 15 -> 17 on seeds 17-32, +2 on both halves.
// The two named doctrines stay behind their own switches because they are
// measured neutral/negative on their own.
//
// Off by default, so the shipped path is byte-identical: `foggrassUpdate`
// returns before allocating anything unless `BOT3_FOGRASS=1`, and both gates
// (room shape + swamp share) are exact reads.

const DEFAULT_MAX_BOARD = 800;
// Swamp share (percent of the whole board, `./mcrown2`'s read) below this is a
// grass room: random 7-11 %, maze 8 %, mediterranean 36-47 %, archipelago 64-67 %.
const DEFAULT_SWAMP = 25;
// Ring garrison doctrine (A): hold `threat - 1` army on a ring cell that faces
// a visible stack of at least `minThreat`; never more than `holdCap`.
const DEFAULT_RING = 0;
const DEFAULT_MIN_THREAT = 3;
const DEFAULT_HOLD = 2;
const DEFAULT_HOLD_CAP = 4;
// Pulse discipline. The bot plans tick `turn + 1` from the frame after `turn`,
// and the engine runs the growth pulse *before* the moves of `turn % 50 === 0`,
// so the tick that pays for land is planned on `turn % 50 === 49`. On that
// frame every ring cell is about to hold two army and can capture; a staging
// merge into one of them wins the tick and cancels the capture (the engine
// refuses a move from a cell that is also a move target). `pulse = 1` caps
// non-defence own merges below the cheapest capture on that frame.
const DEFAULT_PULSE = 0;
const DEFAULT_PULSE_CAP = 20;
// Score bands. A feed has to beat the generic merge (14-59) and the staging
// march (60-260) but stay below defence/rescue/siege work (>= 300).
const DEFAULT_FEED = 0;
const DEFAULT_FEED_CAP = 260;
const DEFAULT_EXEMPT = 300;
// Doctrine B: attack a rival cell that is about to empty when we resolve second.
const DEFAULT_COUNTER = 0;
const DEFAULT_COUNTER_MIN = 3;
const DEFAULT_COUNTER_MASS = 2;
const DEFAULT_COUNTER_LIMIT = 4;
const DEFAULT_COUNTER_SCORE = 820;
// Corridor boards are excluded like every other multi-line layer.
const DEFAULT_CORRIDOR = 0;
// Seat gate. Seat order is public information, and this cell's shipped stack is
// unbalanced across the mirror (player 1 wins 12/32, player 2 20/32; the
// relay-vs-relay mirror itself is 32/32, so the imbalance is ours, not the
// map's). `0` = both seats, `1` = only when we are player 1, `2` = only when we
// are player 2. Measured: gating the ring/counter to player 1 gave +2 on the
// screen and 0 on the independent half, so it stays off.
const DEFAULT_SEAT = 0;
// Ring-refill bonus handed to `./mhalf` in this room (`-1` keeps the inherited
// 60). Measured: the refill reaches `minFire` on the growth-planning tick and
// wins the sort against the capture it was arming, which costs ~6 pulse-tick
// captures per game; 30 keeps most of the refill without that collision
// (19/32 on the screen, 17/32 independent; 0 is too low, 40-50 is back to
// baseline). This is the only part of the layer that ships on.
const DEFAULT_RELOAD = 30;
// Apply the reload override only on the growth-planning tick (`turn % 50 === 49`)
// instead of every tick: the refill is worth its score mid-cycle (it arms a cell
// that has no army yet), and only collides with a capture on the pulse frame.
const DEFAULT_PULSE_ONLY = 0;
const DEFAULT_START = 0;
const DEFAULT_END = 0;
// Keep attacking rival *cells* (the land swing) from an endangered ring cell:
// the doctrine only holds against neutral paint and rear shuffles.
const DEFAULT_KEEP_ATTACK = 1;

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
function foggrassConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.BOT3_FOGRASS, false),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_FOGRASS_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    swamp: overrides.swamp ?? number(env.BOT3_FOGRASS_SWAMP, DEFAULT_SWAMP, 0, 100),
    ring: overrides.ring ?? flag(env.BOT3_FOGRASS_RING, DEFAULT_RING === 1),
    minThreat: overrides.minThreat ?? number(env.BOT3_FOGRASS_MIN, DEFAULT_MIN_THREAT, 1, 50),
    hold: overrides.hold ?? number(env.BOT3_FOGRASS_HOLD, DEFAULT_HOLD, 0, 50),
    holdCap: overrides.holdCap ?? number(env.BOT3_FOGRASS_HOLDCAP, DEFAULT_HOLD_CAP, 1, 50),
    feed: overrides.feed ?? number(env.BOT3_FOGRASS_FEED, DEFAULT_FEED, 0, 5000),
    feedCap: overrides.feedCap ?? number(env.BOT3_FOGRASS_FEEDCAP, DEFAULT_FEED_CAP, 0, 5000),
    pulse: overrides.pulse ?? number(env.BOT3_FOGRASS_PULSE, DEFAULT_PULSE, 0, 2),
    pulseCap: overrides.pulseCap ?? number(env.BOT3_FOGRASS_PULSECAP, DEFAULT_PULSE_CAP, 0, 5000),
    exempt: overrides.exempt ?? number(env.BOT3_FOGRASS_EXEMPT, DEFAULT_EXEMPT, 0, 5000),
    counter: overrides.counter ?? flag(env.BOT3_FOGRASS_COUNTER, DEFAULT_COUNTER === 1),
    counterMin: overrides.counterMin ?? number(env.BOT3_FOGRASS_CMIN, DEFAULT_COUNTER_MIN, 2, 50),
    counterMass: overrides.counterMass ?? number(env.BOT3_FOGRASS_CMASS, DEFAULT_COUNTER_MASS, 2, 50),
    counterLimit: overrides.counterLimit ?? number(env.BOT3_FOGRASS_CLIMIT, DEFAULT_COUNTER_LIMIT, 1, 64),
    counterScore: overrides.counterScore ?? number(env.BOT3_FOGRASS_CSCORE, DEFAULT_COUNTER_SCORE, 0, 5000),
    corridor: overrides.corridor ?? flag(env.BOT3_FOGRASS_CORRIDOR, DEFAULT_CORRIDOR === 1),
    seat: overrides.seat ?? number(env.BOT3_FOGRASS_SEAT, DEFAULT_SEAT, 0, 2),
    reload: overrides.reload ?? number(env.BOT3_FOGRASS_RELOAD, DEFAULT_RELOAD, -1, 5000),
    pulseOnly: overrides.pulseOnly ?? flag(env.BOT3_FOGRASS_PULSE_ONLY, DEFAULT_PULSE_ONLY === 1),
    startTurn: overrides.startTurn ?? number(env.BOT3_FOGRASS_START, DEFAULT_START, 0, 10000),
    endTurn: overrides.endTurn ?? number(env.BOT3_FOGRASS_END, DEFAULT_END, 0, 10000),
    keepAttack: overrides.keepAttack ?? flag(env.BOT3_FOGRASS_KEEPATTACK, DEFAULT_KEEP_ATTACK === 1),
  };
}

function freshFoggrass() {
  return { ticks: 0, feeds: 0, holds: 0, counters: 0, pulses: 0 };
}

// Per-process counters for `BOT3_FOGRASS_TRACE=1` (diagnosis only).
const totals = { ticks: 0, feeds: 0, holds: 0, counters: 0, pulses: 0 };
if (process.env.BOT3_FOGRASS_TRACE === '1')
  process.on('exit', () => {
    if (totals.ticks) process.stderr.write(`[foggrass] ${JSON.stringify(totals)}\n`);
  });

const swamp = (code) => code >= 150 && code !== 200 && code !== 201;
const passable = (code) => code !== 201;

// Swamp share of the whole board, percent. Unseen swamp is re-encoded to 204 by
// `fog-vision.ts`, so this is an exact read on tick 1 even in a fog room.
function swampShare(input) {
  const { size, tile } = input;
  if (!tile || !(size > 0)) return 0;
  let cells = 0;
  for (let i = 0; i < size; i++) if (swamp(tile[i])) cells += 1;
  return (cells * 100) / size;
}

// One call per planning tick. Returns null whenever the layer has nothing to
// say, keeping the shipped planner byte-identical.
function foggrassUpdate(b, input, config = foggrassConfig()) {
  if (!config.enabled) return null;
  if (!input || input.multi !== true || input.fog !== true) return null;
  if (!(Number(input.size) <= config.maxBoard)) return null;
  if (!config.corridor && input.corridor === true) return null;
  const turn = Math.max(0, Number(input.turn) || 0);
  if (turn < config.startTurn) return null;
  if (config.endTurn > 0 && turn >= config.endTurn) return null;
  const me = Number(input.me) || b.me;
  if (config.seat === 1 && me !== 1) return null;
  if (config.seat === 2 && me !== 2) return null;
  const share = swampShare(input);
  if (share >= config.swamp) return null;
  const state = (b.foggrass ??= freshFoggrass());
  state.ticks += 1;
  totals.ticks += 1;
  return { config, turn, share, me, state };
}

// Ring census over our visible territory: `ring[i]` = our cell that touches a
// non-own passable cell, `threat[i]` = the strongest visible rival garrison
// orthogonally adjacent (fog vision is a radius 1 read, and attacks are
// orthogonal), `holdAt[i]` = the garrison that push cannot strictly beat.
function foggrassField(tile, teams, units, neighbors, myTeam, config) {
  const size = teams.length;
  const ring = new Uint8Array(size);
  const threat = new Int16Array(size);
  const holdAt = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (teams[i] !== myTeam) continue;
    let isRing = false,
      best = 0;
    for (const j of neighbors[i]) {
      if (!passable(tile[j])) continue;
      if (teams[j] !== myTeam) isRing = true;
      if (teams[j] && teams[j] !== myTeam) best = Math.max(best, units[j]);
    }
    if (!isRing) continue;
    ring[i] = 1;
    threat[i] = best;
    if (best >= config.minThreat)
      holdAt[i] = Math.min(config.holdCap, Math.max(config.hold, Math.min(config.holdCap, best - 1)));
  }
  return { ring, threat, holdAt };
}

// Doctrine A. Feed an endangered ring cell up to its hold garrison; hold it
// instead of firing the garrison away for a neutral cell.
function applyFoggrass(plan, ctx, candidates) {
  const { config, turn } = plan;
  const { tile, teams, units, neighbors, myTeam } = ctx;
  const field = plan.ring ? null : foggrassField(tile, teams, units, neighbors, myTeam, config);
  if (field) Object.assign(plan, field);
  const { holdAt } = plan;
  const counts = { feeds: 0, holds: 0, pulses: 0 };
  // Pulse discipline: considered before the feed because a merge into a ring
  // cell that is about to reach `minFire` on the growth tick is exactly the
  // order that cancels the capture (see `DEFAULT_PULSE`).
  const pulseTick = config.pulse > 0 && ((turn + 1) % 50 === 0 || (config.pulse > 1 && turn % 50 === 0));
  for (const op of candidates) {
    if (!pulseTick || op.build || op.score >= config.exempt) continue;
    if (teams[op.to] !== myTeam) continue;
    // Keep a feed into an endangered ring cell: it is the doctrine's own order.
    if (holdAt[op.to] && units[op.to] < holdAt[op.to] && op.score < config.exempt) continue;
    if (op.score > config.pulseCap) {
      op.score = config.pulseCap;
      counts.pulses += 1;
    }
  }
  for (const op of candidates) {
    if (op.build) continue;
    const to = teams[op.to];
    const toOwner = to === myTeam;
    // Feed: a merge into an endangered ring cell that reaches its hold.
    if (config.feed && toOwner && holdAt[op.to] > units[op.to] && op.score < config.exempt) {
      const send = Math.max(1, op.send || Math.max(0, units[op.from] - 1));
      const result = units[op.to] + send;
      if (result >= holdAt[op.to] && units[op.from] > 1) {
        const boost = Math.min(
          config.feedCap,
          config.feed + 10 * (holdAt[op.to] - units[op.to]) + Math.min(20, send * 2),
        );
        if (op.score < boost) {
          op.score = boost;
          counts.feeds += 1;
        }
      }
      continue;
    }
    // Hold: do not spend the garrison of an endangered ring cell on a move that
    // cannot take a rival cell while the visible stack is still next door.
    if (!config.ring || !holdAt[op.from]) continue;
    if (units[op.from] < holdAt[op.from]) continue;
    if (op.score >= config.exempt) continue;
    if (config.keepAttack && to && !toOwner) continue;
    op.vetoHold = true;
    counts.holds += 1;
  }
  plan.state.feeds = (plan.state.feeds ?? 0) + counts.feeds;
  plan.state.holds = (plan.state.holds ?? 0) + counts.holds;
  plan.state.pulses = (plan.state.pulses ?? 0) + counts.pulses;
  totals.feeds += counts.feeds;
  totals.holds += counts.holds;
  totals.pulses += counts.pulses;
  // The planner keeps `vetoHold` candidates out of the matching loop; a frame
  // with nothing else left keeps them (an idle tick is worse than a trade).
  if (config.ring) {
    const kept = candidates.filter((op) => !op.vetoHold);
    if (kept.length) candidates.splice(0, candidates.length, ...kept);
  }
}

// Doctrine B. We resolve second on the next tick, so a rival cell that is about
// to empty itself (2+ army, a neighbour a push strictly beats) is a free
// capture for an adjacent own cell that can push 2.
function foggrassOrders(plan, ctx, orders) {
  const { config, turn } = plan;
  if (!config.counter) return [];
  const { tile, teams, units, neighbors, myTeam, me } = ctx;
  const order = turn + 1;
  // Seat 1 resolves first on even ticks, seat 2 on odd ticks; only a second
  // move can take a cell the first move just emptied.
  const first = order % 2 === 1 ? 2 : 1;
  if (first === me) return [];
  const usedFrom = new Set(),
    usedTo = new Set();
  for (const op of orders) {
    if (op.build) continue;
    usedFrom.add(op.from);
    usedTo.add(op.to);
  }
  const picks = [];
  for (let r = 0; r < teams.length; r++) {
    if (!teams[r] || teams[r] === myTeam) continue;
    const mass = units[r];
    if (mass < config.counterMass) continue;
    // Is there a neighbour the rival's all-in push strictly beats?
    let beatable = false;
    for (const j of neighbors[r]) {
      if (!passable(tile[j]) || teams[j] === teams[r]) continue;
      if (units[j] < mass - 1) {
        beatable = true;
        break;
      }
    }
    if (!beatable) continue;
    let best = -1,
      bestMass = 0;
    for (const s of neighbors[r]) {
      if (teams[s] !== myTeam || usedFrom.has(s) || units[s] < config.counterMin) continue;
      if (usedTo.has(r)) continue;
      if (units[s] > bestMass) {
        bestMass = units[s];
        best = s;
      }
    }
    if (best < 0) continue;
    // A bigger garrison on the empty source is the bigger swing; a ring source
    // is a two-cell swing.
    let value = mass * 2 + (units[r] > 1 ? 1 : 0);
    for (const j of neighbors[r]) if (passable(tile[j]) && teams[j] !== teams[r]) value += 1;
    picks.push({ from: best, to: r, mode: 2, build: null, send: 0, score: config.counterScore + value });
  }
  if (!picks.length) return [];
  picks.sort((a, c) => c.score - a.score);
  const out = [];
  for (const op of picks) {
    if (out.length >= config.counterLimit) break;
    if (usedFrom.has(op.from) || usedTo.has(op.to)) continue;
    usedFrom.add(op.from);
    usedTo.add(op.to);
    out.push(op);
  }
  plan.state.counters = (plan.state.counters ?? 0) + out.length;
  totals.counters += out.length;
  return out;
}

module.exports = {
  foggrassConfig,
  foggrassUpdate,
  foggrassField,
  applyFoggrass,
  foggrassOrders,
  freshFoggrass,
  swampShare,
  DEFAULT_MAX_BOARD,
  DEFAULT_SWAMP,
  DEFAULT_RING,
  DEFAULT_MIN_THREAT,
  DEFAULT_HOLD,
  DEFAULT_HOLD_CAP,
  DEFAULT_PULSE,
  DEFAULT_PULSE_CAP,
  DEFAULT_FEED,
  DEFAULT_FEED_CAP,
  DEFAULT_EXEMPT,
  DEFAULT_COUNTER,
  DEFAULT_COUNTER_MIN,
  DEFAULT_COUNTER_MASS,
  DEFAULT_COUNTER_LIMIT,
  DEFAULT_COUNTER_SCORE,
  DEFAULT_CORRIDOR,
  DEFAULT_SEAT,
  DEFAULT_RELOAD,
  DEFAULT_PULSE_ONLY,
  DEFAULT_START,
  DEFAULT_END,
  DEFAULT_KEEP_ATTACK,
};
