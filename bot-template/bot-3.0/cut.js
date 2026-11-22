'use strict';

// Cut economics layer for the Bot(3.0) 1v1 planner.
//
// Diagnosis. The informative relay losses collapse between tick 100 and 250:
// our army falls 447 -> 232 while relay holds ~457, and the land goes 46.5 ->
// 36.5. The documented pathology (see `exp/bot3-multiecon`, `fog.js` header) is
// isolation: `applyConnectivity` re-anchors every region that still touches one
// of our crown/city tiles and flags the rest `isolated`, which halves the stack
// once, stops every plain/city in it from producing, and then decays 5% per
// round until the cells turn neutral. relay prices a cut at
// `+min(95, sqrt(cut) * 5)` and never scores the rival's articulation tiles
// offensively, and it only builds outposts at `anchorDist >= 5`, so its own
// chokepoint dies the moment the front moves. Four mechanisms sit behind their
// own flags; every one is OFF by default so the baseline stays byte identical.
//
// BOT3_CUTTIME  Time the cut to the growth windfall. `applyTickGrowth` runs
//               before the move phase, plains and cities gain +1 on turn % 50
//               == 0, and the orders chosen at turn T execute in tick T + 1.
//               A cut therefore has to land in tick 49 to deny the windfall,
//               i.e. it is chosen at `turn % 50 == 48` (the phase is a knob,
//               `BOT3_CUTTIME_PHASE`). A cut there halves the severed region
//               and every later windfall in it is gone for good.
// BOT3_CUTVALUE Price the cut at `+4 * cut` (hard floor for cut > 40, gated on
//               homes >= 2) instead of relay's saturating sqrt pricing. The
//               real effect is permanent immobility of `cut` army.
// BOT3_ARTIC    Fortify our own articulation tiles. A crown/city tile is an
//               engine anchor (`applyConnectivity` seeds there), so the region
//               behind it can never be severed while the tile holds. relay only
//               builds outposts far from the front, so its own choke dies on a
//               cut. The build is cheap (cost + keep army, default 3) and only
//               issued when the tile is provably out of contact, because an
//               anchor tile is capturable and a captured city is destroyed with
//               its whole garrison.
// BOT3_MULTICUT The same cut valuation in multi-line rooms, where sixteen
//               orders per tick make severing several subtrees at once the
//               cheapest large swing. This is the one lever relay has no
//               structural answer for (it computes `supplyCuts` but never
//               scores rival articulation tiles offensively).
//
// The layer is a pure score modifier plus, for BOT3_ARTIC, new build
// candidates. It keeps no state, uses no clock and no randomness.

const PLAIN_GROWTH_INTERVAL = 50;
const BUILD_COST = 50;
const INF = 1e6;
const ANCHOR_CITY = 50; // encoded `50 + owner`, and 201 is impassable terrain.

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

const crown = (code) => code >= 100 && code < 150;
const anchor = (code) => code >= 50 && code < 150;
const swamp = (code) => code >= 150 && code !== 200 && code !== 201;

// Read on every call so tests and A/B runs can toggle the layer in-process.
function cutConfig(overrides = {}, env = process.env) {
  const time = overrides.time ?? {};
  const value = overrides.value ?? {};
  const artic = overrides.artic ?? {};
  const multiCut = overrides.multiCut ?? {};
  const save = overrides.save ?? {};
  return {
    time: {
      enabled: time.enabled ?? flag(env.BOT3_CUTTIME, false),
      // Orders chosen at turn T execute in tick T + 1; growth on turn % 50 == 0
      // happens before that move phase, so the windfall-denying tick is 49.
      phase: time.phase ?? number(env.BOT3_CUTTIME_PHASE, 48, 0, PLAIN_GROWTH_INTERVAL - 1),
      gain: time.gain ?? number(env.BOT3_CUTTIME_GAIN, 300, 0, 20000),
      cap: time.cap ?? number(env.BOT3_CUTTIME_CAP, 600, 0, 50000),
      minCut: time.minCut ?? number(env.BOT3_CUTTIME_MIN, 8, 0, 20000),
      sure: time.sure ?? flag(env.BOT3_CUTTIME_SURE, true),
      // The windfall window only prices a cut we are already next to. The
      // approach term is what walks the column onto the choke in time: for the
      // last `lead` ticks before the window, advancing down the distance field
      // of the rival's articulation tiles is scored.
      approach: time.approach ?? number(env.BOT3_CUTTIME_APPROACH, 0, 0, 5000),
      lead: time.lead ?? number(env.BOT3_CUTTIME_LEAD, 14, 0, PLAIN_GROWTH_INTERVAL),
      targets: time.targets ?? number(env.BOT3_CUTTIME_TARGETS, 4, 1, 64),
      // `0` keeps the approach out of multi-line rooms, where the severed army
      // is 1-5 units (see CUT.md) and the field only adds noise.
      multi: time.multi ?? flag(env.BOT3_CUTTIME_MULTI, true),
    },
    value: {
      enabled: value.enabled ?? flag(env.BOT3_CUTVALUE, false),
      gain: value.gain ?? number(env.BOT3_CUTVALUE_GAIN, 4, 0, 200),
      cap: value.cap ?? number(env.BOT3_CUTVALUE_CAP, 600, 0, 50000),
      floor: value.floor ?? number(env.BOT3_CUTVALUE_FLOOR, 420, 0, 50000),
      floorCut: value.floorCut ?? number(env.BOT3_CUTVALUE_FLOOR_CUT, 40, 0, 20000),
      homes: value.homes ?? number(env.BOT3_CUTVALUE_HOMES, 2, 0, 32),
    },
    artic: {
      enabled: artic.enabled ?? flag(env.BOT3_ARTIC, false),
      minCut: artic.minCut ?? number(env.BOT3_ARTIC_MIN, 20, 0, 20000),
      keep: artic.keep ?? number(env.BOT3_ARTIC_KEEP, 3, 0, 1000),
      score: artic.score ?? number(env.BOT3_ARTIC_SCORE, 430, 0, 5000),
      turn: artic.turn ?? number(env.BOT3_ARTIC_TURN, 51, 0, 5000),
      enemyDist: artic.enemyDist ?? number(env.BOT3_ARTIC_ENEMY, 3, 0, 64),
      top: artic.top ?? number(env.BOT3_ARTIC_TOP, 3, 1, 64),
      // `enemyDist` only counts *visible* rivals, so in a fog room the safety
      // gate passes trivially and the city dies to the first unseen stack.
      fog: artic.fog ?? flag(env.BOT3_ARTIC_FOG, false),
    },
    multiCut: {
      enabled: multiCut.enabled ?? flag(env.BOT3_MULTICUT, false),
      gain: multiCut.gain ?? number(env.BOT3_MULTICUT_GAIN, 4, 0, 200),
      cap: multiCut.cap ?? number(env.BOT3_MULTICUT_CAP, 600, 0, 50000),
      turn: multiCut.turn ?? number(env.BOT3_MULTICUT_TURN, 0, 0, 5000),
    },
    save: {
      enabled: save.enabled ?? flag(env.BOT3_CUTSAVE, false),
      gain: save.gain ?? number(env.BOT3_CUTSAVE_GAIN, 3, 0, 200),
      cap: save.cap ?? number(env.BOT3_CUTSAVE_CAP, 1400, 0, 50000),
      min: save.min ?? number(env.BOT3_CUTSAVE_MIN, 30, 0, 20000),
      // A reconnect only pays if the door falls this tick: a failed attack burns
      // the stack and leaves the pocket severed (and decaying).
      sure: save.sure ?? flag(env.BOT3_CUTSAVE_SURE, true),
    },
  };
}

// One call per planning tick. Returns null when every mechanism is off, which
// leaves the planner on the exact baseline path.
function cutUpdate(input, config = cutConfig()) {
  const { time, value, artic, multiCut, save } = config;
  if (
    !time.enabled &&
    !value.enabled &&
    !artic.enabled &&
    !save.enabled &&
    !(multiCut.enabled && input?.multi === true)
  )
    return null;
  const turn = Math.max(0, Number(input.turn) || 0);
  // Deny the windfall that lands in tick turn + 1.
  const timeActive = time.enabled && turn % PLAIN_GROWTH_INTERVAL === time.phase;
  let approach = null;
  if (time.enabled && time.approach > 0 && input && (time.multi || input.multi !== true)) {
    // Ticks left before the windfall is decided; the approach is only priced
    // inside that window so it never competes with the normal front.
    const left =
      (time.phase - (turn % PLAIN_GROWTH_INTERVAL) + PLAIN_GROWTH_INTERVAL) % PLAIN_GROWTH_INTERVAL;
    if (left <= time.lead) approach = cutApproach(input, config, 1 - left / (time.lead + 1));
  }
  return { config, turn, timeActive, approach, rescue: save.enabled ? cutRescue(input, config) : null };
}

// The inverse of a cut: `applyConnectivity` halves a freshly severed region once
// and then decays it 5% per round, but reconnecting it *doubles* the army again
// (unless a stack was pushed in meanwhile, which forfeits the doubling). So the
// cell that reopens a pocket is worth about the pocket's own army, on top of the
// production the region starts paying again. relay prices that at a flat +90
// reconnect bonus, which is nothing against a 200-army pocket.
function cutRescue(input, config) {
  const { b, teams, units, myTeam, size } = input;
  const seen = new Uint8Array(size);
  const rescue = new Float64Array(size);
  for (let start = 0; start < size; start++) {
    if (seen[start] || teams[start] !== myTeam || !b.isolated[start]) continue;
    // Collect one severed region and the cells that would reopen it: a cell we
    // do not own that touches both the region and our *connected* territory.
    // Capturing that cell is a real reconnect, not another frontier step.
    const region = [start];
    seen[start] = 1;
    let army = 0;
    let connected = false;
    const rim = [];
    for (let head = 0; head < region.length; head++) {
      const i = region[head];
      army += units[i];
      for (const j of b.neighbors[i]) {
        if (b.grid_type[j] === 201) continue;
        if (teams[j] === myTeam) {
          if (b.isolated[j]) {
            if (!seen[j]) {
              seen[j] = 1;
              region.push(j);
            }
          } else connected = true;
          continue;
        }
        if (b.neighbors[j].some((k) => teams[k] === myTeam && !b.isolated[k]) && !rim.includes(j))
          rim.push(j);
      }
    }
    // A connected own neighbour means the region is not actually severed (stale
    // fog memory), so there is nothing to save.
    if (connected || army < config.save.min) continue;
    for (const j of rim) if (army > rescue[j]) rescue[j] = army;
  }
  return rescue;
}

// Distance field to the rival's articulation tiles. Those are the cells whose
// capture severs a subtree from every rival anchor, so the field is a map of
// where one capture is worth a whole region rather than one cell.
function cutApproach(input, config, ramp) {
  const { b, teams, cut, myTeam, size } = input;
  const targets = [];
  let best = 0;
  for (let i = 0; i < size; i++) {
    if (!teams[i] || teams[i] === myTeam || b.isolated[i]) continue;
    const severed = cut[i] || 0;
    if (severed < config.time.minCut) continue;
    if (severed > best) best = severed;
    targets.push([severed, i]);
  }
  if (!targets.length) return null;
  targets.sort((a, c) => c[0] - a[0] || a[1] - c[1]);
  const seeds = targets.slice(0, config.time.targets).map((entry) => entry[1]);
  const dist = new Int32Array(size).fill(INF);
  const queue = [...seeds];
  for (const i of seeds) dist[i] = 0;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (const j of b.neighbors[i]) {
      if (dist[j] !== INF || b.grid_type[j] === 201) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  const gain = config.time.approach * ramp * (1 + Math.min(2, Math.sqrt(best) / 8));
  return { dist, gain };
}

// Score a hostile capture by the army it strands (and, in the windfall window,
// by the production the severed region never gets back).
function cutValue(plan, ctx, op) {
  const { config } = plan;
  const { units, cut, homes, multi } = ctx;
  const severed = cut[op.to] || 0;
  if (severed <= 0) return 0;
  let extra = 0;
  if (config.value.enabled && homes.length >= config.value.homes) {
    extra += Math.min(config.value.cap, config.value.gain * severed);
    if (severed > config.value.floorCut) extra = Math.max(extra, config.value.floor);
  }
  if (config.multiCut.enabled && multi === true && plan.turn >= config.multiCut.turn)
    extra += Math.min(config.multiCut.cap, config.multiCut.gain * Math.sqrt(severed));
  if (plan.timeActive && severed >= config.time.minCut) {
    // A failed attack spends the turn and hands the windfall back: only a push
    // that captures this tick counts.
    if (!config.time.sure || op.send > units[op.to])
      extra += Math.min(config.time.cap, config.time.gain * Math.sqrt(severed));
  }
  return extra;
}

// Fortify our own articulation tiles: an anchor cannot be isolated, so the
// region behind it cannot be severed while the tile holds. Cheap by design
// (cost + `keep` army), which is the only way a rear choke ever reaches the
// real build thresholds (`units[i] >= 50 && (city || units[i] >= 100)`).
function articBuilds(plan, ctx, candidates) {
  const { config } = plan;
  const { b, teams, units, cut, myTeam, pressure, enemyDist, size, fog } = ctx;
  if (fog && !config.artic.fog) return;
  const picks = [];
  for (let i = 0; i < size; i++) {
    if (teams[i] !== myTeam || b.isolated[i]) continue;
    const tileCode = b.grid_type[i];
    if (swamp(tileCode) || crown(tileCode)) continue;
    const severed = cut[i] || 0;
    if (severed < config.artic.minCut) continue;
    const leftovers = units[i] - BUILD_COST;
    if (leftovers < config.artic.keep) continue;
    // An anchor tile is capturable and a captured city is destroyed with its
    // garrison, so a fortify is only issued out of contact: no hostile stack
    // within `enemyDist` and nothing adjacent that out-pushes the leftover.
    if (enemyDist[i] < config.artic.enemyDist) continue;
    if (pressure(i) > leftovers - config.artic.keep) continue;
    let threatened = false;
    for (const j of b.neighbors[i]) {
      if (!teams[j] || teams[j] === myTeam) continue;
      if (units[j] - 1 > leftovers) {
        threatened = true;
        break;
      }
    }
    if (threatened) continue;
    picks.push([severed, i, anchor(tileCode) ? 'c' : 'b']);
  }
  picks.sort((a, c) => c[0] - a[0] || a[1] - c[1]);
  for (const [severed, i, kind] of picks.slice(0, config.artic.top)) {
    candidates.push({
      score: config.artic.score + Math.min(120, Math.sqrt(severed) * 4),
      from: i,
      to: i,
      mode: 2,
      build: kind,
    });
  }
}

// Score adjustments. `ctx` carries the arrays the planner already built, so
// nothing is recomputed here.
function cutApply(plan, ctx, candidates) {
  if (!plan) return;
  const { teams, myTeam } = ctx;
  const approach = plan.approach;
  const rescue = plan.rescue;
  const save = plan.config.save;
  for (const op of candidates) {
    if (op.build) continue;
    const to = teams[op.to];
    // Walk onto the choke while the windfall is close; both our own merges and
    // rival captures along the field are priced, because the column needs mass.
    if (approach && approach.dist[op.to] < approach.dist[op.from] && approach.dist[op.from] < INF)
      op.score += Math.round(approach.gain);
    if (rescue && to !== myTeam) {
      const pocket = rescue[op.to];
      if (pocket > 0 && (!save.sure || op.send > ctx.units[op.to]))
        op.score += Math.min(save.cap, save.gain * pocket);
    }
    if (!to || to === myTeam) continue;
    const extra = cutValue(plan, ctx, op);
    if (extra) op.score += extra;
  }
  if (plan.config.artic.enabled && plan.turn >= plan.config.artic.turn) articBuilds(plan, ctx, candidates);
}

module.exports = {
  cutConfig,
  cutUpdate,
  cutApply,
  cutValue,
  cutApproach,
  cutRescue,
  articBuilds,
  BUILD_COST,
  ANCHOR_CITY,
};
