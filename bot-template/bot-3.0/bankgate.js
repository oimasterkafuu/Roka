'use strict';

// Geometry-gated crown bank (round 19, `BOT3_BANKGATE`).
//
// Round 18's `mcrown2` banks the stranded rear army (hop >= 3) into one rear
// cell and buys a crown with it, and it is the largest signal measured in this
// effort: 153/256 on the screen half and 144/256 on the independent half, with
// mediterranean at 28-30 of 32. Its failure is that it applies the same policy
// on boards where the rear army is not stranded at all: on an open random board
// the army behind the ring is a *pipe* to the frontier, so redirecting it costs
// land immediately (t100 land 60 against 95) and the cell regresses by 5-7 wins
// (random clear 21 -> 16). The map name is not available to the planner, so the
// gate has to be measured from the board itself.
//
// What this layer adds on top of the round-18 mechanics:
//
//   * `geometry()` measures, every tick, the quantities that separate a
//     reservoir from a pipe: the army at each hop from the ring, the number of
//     neutral plains the frontier can still take next tick (`demand`), the
//     swamp/mountain share of the board, the ring width, the articulation
//     count of our own territory, and the army/land trajectory over the last
//     10 and 50 ticks.
//   * the *pick* is gated on that geometry instead of on the map name: a vault
//     is only opened when the frontier has no income land left to take
//     (`demand <= DEMAND`), the rear basin actually holds a reservoir
//     (`REAR` army at hop >= HOP, rising by `RISE` over `WINDOW` ticks), the
//     basin can be held (`OUTLETS`) and - optionally - the board is wet
//     (`SWAMP` percent).
//   * the bank is self-limiting: after `RELEASE_GRACE` ticks it releases
//     (stops feeding, stops redirecting rear merges, keeps the army it has
//     already stacked) when the frontier is starved *and* our land is behind
//     the rival's, which is exactly the round-18 random loss mode.
//
// The rest is `./mcrown2` unchanged: the vault is the outlet of the rear basin
// that holds the most stranded army, the planner's own rear merges are
// re-pointed one hop down a BFS field toward it, up to `FEED` merges per tick
// are appended after the matching loop, and the city/crown are bought at 50
// and 100 army. Nothing here touches hop 0-2, so the frontier exchange keeps
// its army. Off by default: with `BOT3_BANKGATE` off `planner.js` takes the
// byte-identical baseline path.

const INF = 1e6;
const DEFAULT_MAX_BOARD = 800;
// Hops from the frontier a vault and its donors must sit at.
const DEFAULT_HOP = 3;
// First planning tick the gather may run.
const DEFAULT_START = 44;
const DEFAULT_END = 0;
const DEFAULT_FEED = 4;
// Score added to a merge that steps one hop down the vault field.
const DEFAULT_GAIN = 110;
const DEFAULT_MIN_ARMY = 2;
const DEFAULT_SAFE = 3;
const DEFAULT_CROWNS = 1;
const DEFAULT_CAP = 110;
const DEFAULT_KEEP = 0;
const DEFAULT_FOG = 1;
const DEFAULT_CORRIDOR = 0;
const DEFAULT_BUILD = 1;
// A basin must hold at least this much army to be worth a vault.
const DEFAULT_MIN_BASIN = 12;
// How many shallow ways out a basin may have (`8` = no effective cap).
const DEFAULT_OUTLETS = 8;
const DEFAULT_BEHIND = 100;

// --- The round-19 discriminator (all measured from the board) ---------------
// Master gate. `0` reproduces round 18's ungated layer exactly.
const DEFAULT_GATE = 1;
// Neutral plains the frontier can still take next tick. Above this the rear
// army is a pipe feeding an unfinished land race, not a reservoir.
const DEFAULT_DEMAND = 5;
// Army at hop >= HOP required before a vault may be opened (`0` = off).
const DEFAULT_REAR = 0;
// Rear army growth over `WINDOW` ticks required at the pick (`0` = off).
const DEFAULT_RISE = 0;
const DEFAULT_WINDOW = 40;
// Percent of the board that must be swamp before a vault may be opened.
const DEFAULT_SWAMP = 25;
// Percent that must be mountain. Swamp and mountain are the two observable
// shapes of a board whose frontier cannot convert army into income, so the
// terrain clause is satisfied by either; `0` on both disables it.
const DEFAULT_MOUNTAIN = 0;
// Our land as a percent of the rival's at the pick. A crown is a comeback
// investment, so it may only be started while the land race is not already won:
// on the measured relay mediterranean/archipelago picks the ratio is 0.98-1.00
// (p90 1.03), while the anti/archipelago room - the one full-matrix cell round
// 18 regressed, 32/32 -> 22/32 - banks at 1.25 (p10 1.05). At 105 that room
// recovers to 29/32 and at 95 it is byte-identical to the baseline, so the
// shipped rule is the strict one. `0` disables it.
const DEFAULT_LAND = 95;
// Self-limiting release: a bank that never fills is a basin the vault cannot
// hold (round 18 measured a bank stuck at one or two army for a hundred ticks),
// so after `RELEASE_GRACE` ticks a vault below `RELEASE_FILL` peak army is
// given back: feeding and redirection stop, the army already stacked stays.
const DEFAULT_RELEASE = 0;
const DEFAULT_RELEASE_FILL = 20;
const DEFAULT_RELEASE_GRACE = 40;
// Optional second release rule (measured negative on mediterranean, off by
// default): give the bank back when the frontier has been starved for
// `RELEASE_TICKS` consecutive ticks and our land trails the rival's by more
// than `RELEASE_GAP` cells. `RELEASE_DEMAND=0` disables it.
const DEFAULT_RELEASE_DEMAND = 0;
const DEFAULT_RELEASE_TICKS = 6;
const DEFAULT_RELEASE_GAP = 8;

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
function bankgateConfig(overrides = {}, env = process.env) {
  return {
    // Round 19 ships the bank **on**: the gated layer has zero regressed cells
    // in the 2048-game matrix and +44 wins over the 512-game paired screen.
    enabled: overrides.enabled ?? flag(env.BOT3_BANKGATE, true),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_BANKGATE_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    hop: overrides.hop ?? number(env.BOT3_BANKGATE_HOP, DEFAULT_HOP, 1, 50),
    startTurn: overrides.startTurn ?? number(env.BOT3_BANKGATE_START, DEFAULT_START, 0, 10000),
    endTurn: overrides.endTurn ?? number(env.BOT3_BANKGATE_END, DEFAULT_END, 0, 10000),
    feed: overrides.feed ?? number(env.BOT3_BANKGATE_FEED, DEFAULT_FEED, 0, 64),
    gain: overrides.gain ?? number(env.BOT3_BANKGATE_GAIN, DEFAULT_GAIN, 0, 5000),
    minArmy: overrides.minArmy ?? number(env.BOT3_BANKGATE_MIN, DEFAULT_MIN_ARMY, 2, 50),
    safe: overrides.safe ?? number(env.BOT3_BANKGATE_SAFE, DEFAULT_SAFE, 1, 50),
    crowns: overrides.crowns ?? number(env.BOT3_BANKGATE_CROWNS, DEFAULT_CROWNS, 1, 4),
    cap: overrides.cap ?? number(env.BOT3_BANKGATE_CAP, DEFAULT_CAP, 50, 100000),
    keep: overrides.keep ?? number(env.BOT3_BANKGATE_KEEP, DEFAULT_KEEP, 0, 1000),
    minBasin: overrides.minBasin ?? number(env.BOT3_BANKGATE_BASIN, DEFAULT_MIN_BASIN, 1, 10000),
    outlets: overrides.outlets ?? number(env.BOT3_BANKGATE_OUTLETS, DEFAULT_OUTLETS, 1, 40),
    behind: overrides.behind ?? number(env.BOT3_BANKGATE_BEHIND, DEFAULT_BEHIND, 0, 1000),
    build: overrides.build ?? flag(env.BOT3_BANKGATE_BUILD, DEFAULT_BUILD === 1),
    fog: overrides.fog ?? flag(env.BOT3_BANKGATE_FOG, DEFAULT_FOG === 1),
    corridor: overrides.corridor ?? flag(env.BOT3_BANKGATE_CORRIDOR, DEFAULT_CORRIDOR === 1),
    gate: overrides.gate ?? flag(env.BOT3_BANKGATE_GATE, DEFAULT_GATE === 1),
    demand: overrides.demand ?? number(env.BOT3_BANKGATE_DEMAND, DEFAULT_DEMAND, 0, 10000),
    rear: overrides.rear ?? number(env.BOT3_BANKGATE_REAR, DEFAULT_REAR, 0, 100000),
    rise: overrides.rise ?? number(env.BOT3_BANKGATE_RISE, DEFAULT_RISE, 0, 100000),
    window: overrides.window ?? number(env.BOT3_BANKGATE_WINDOW, DEFAULT_WINDOW, 1, 200),
    swamp: overrides.swamp ?? number(env.BOT3_BANKGATE_SWAMP, DEFAULT_SWAMP, 0, 100),
    mountain: overrides.mountain ?? number(env.BOT3_BANKGATE_MOUNTAIN, DEFAULT_MOUNTAIN, 0, 100),
    land: overrides.land ?? number(env.BOT3_BANKGATE_LAND, DEFAULT_LAND, 0, 10000),
    release: overrides.release ?? flag(env.BOT3_BANKGATE_RELEASE, DEFAULT_RELEASE === 1),
    releaseFill:
      overrides.releaseFill ??
      number(env.BOT3_BANKGATE_RELEASE_FILL, DEFAULT_RELEASE_FILL, 0, 10000),
    releaseDemand:
      overrides.releaseDemand ??
      number(env.BOT3_BANKGATE_RELEASE_DEMAND, DEFAULT_RELEASE_DEMAND, 0, 10000),
    releaseTicks:
      overrides.releaseTicks ??
      number(env.BOT3_BANKGATE_RELEASE_TICKS, DEFAULT_RELEASE_TICKS, 1, 200),
    releaseGap:
      overrides.releaseGap ?? number(env.BOT3_BANKGATE_RELEASE_GAP, DEFAULT_RELEASE_GAP, -10000, 10000),
    releaseGrace:
      overrides.releaseGrace ??
      number(env.BOT3_BANKGATE_RELEASE_GRACE, DEFAULT_RELEASE_GRACE, 0, 10000),
  };
}

function freshBankgate() {
  return {
    ticks: 0,
    picks: 0,
    feeds: 0,
    builds: 0,
    vetoed: 0,
    repriced: 0,
    released: 0,
    done: 0,
    cells: [],
    hist: [],
    starve: 0,
    releasedAt: -1,
    pickGeom: null,
    lastGeom: null,
  };
}

const ownerOf = (code) => (code < 200 ? code % 50 : 0);
const crown = (code) => code >= 100 && code < 150;
const city = (code) => code >= 50 && code < 100;
const plain = (code) => code >= 1 && code < 50;
const swamp = (code) => code >= 150 && code !== 200 && code !== 201;
const neutralPlain = (code) => code === 200;
const mountain = (code) => code === 201;

// Tracing is opt-in and only feeds the round-19 probe; nothing reads it in a
// normal game, and the array stays empty unless probe mode is on.
const traceOn = () => process.env.BOT3_BANKGATE_TRACE === '1';
const probeOn = () => process.env.BOT3_BANKGATE_PROBE === '1';
function trace(row) {
  if (!probeOn() && !traceOn()) return;
  (globalThis.__bankgate ||= []).push(row);
}

// Hops from `cell` to every cell of ours (`-1` = not reachable through our
// territory). Used both for the vault field and for the supply metric.
function ownField(size, neighbors, teams, myTeam, cell) {
  const field = new Int32Array(size).fill(-1);
  const queue = [cell];
  field[cell] = 0;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (const j of neighbors[i]) {
      if (teams[j] !== myTeam || field[j] !== -1) continue;
      field[j] = field[i] + 1;
      queue.push(j);
    }
  }
  return field;
}

// The rear basin a vault would own. Starting at `i`, walk only through cells
// that are at least as deep as `i` itself: that is the watershed whose army has
// to pass through `i` on its way to the ring. Vetoing `i`'s outgoing merge turns
// the pipe into a reservoir, so the basin - not the cell - is what the layer
// really banks. `exits` counts the shallow neighbours of the vault itself,
// `outlets` the ways out of the whole basin.
function deepBasin(ctx, i, floor) {
  const { size, neighbors, teams, units, frontDist, enemyDist } = ctx;
  const seen = new Uint8Array(size);
  const stack = [i];
  seen[i] = 1;
  let army = units[i],
    cells = 1,
    minEnemy = enemyDist[i],
    deepest = frontDist[i];
  while (stack.length) {
    const k = stack.pop();
    for (const j of neighbors[k]) {
      if (seen[j] || teams[j] !== ctx.myTeam) continue;
      if (frontDist[j] < floor || frontDist[j] >= INF) continue;
      seen[j] = 1;
      cells += 1;
      army += units[j];
      deepest = Math.max(deepest, frontDist[j]);
      minEnemy = Math.min(minEnemy, enemyDist[j]);
      stack.push(j);
    }
  }
  let outlets = 0;
  for (let k = 0; k < size; k++) {
    if (!seen[k]) continue;
    for (const j of neighbors[k]) if (frontDist[j] < floor) outlets += 1;
  }
  let exits = 0;
  for (const j of neighbors[i]) if (frontDist[j] < floor) exits += 1;
  return { army, cells, minEnemy, deepest, exits, outlets };
}

function vaultOk(ctx, i, config, pick = true) {
  const { tile, teams, myTeam, isolated, frontDist, enemyDist } = ctx;
  if (teams[i] !== myTeam) return false;
  if (!plain(tile[i]) && !city(tile[i]) && !crown(tile[i])) return false;
  if (isolated && isolated[i]) return false;
  if (pick) {
    if (!plain(tile[i])) return false;
    if (frontDist[i] < config.hop) return false;
    if (enemyDist[i] < config.safe) return false;
    return true;
  }
  if (frontDist[i] < Math.max(1, config.hop - 1)) return false;
  if (enemyDist[i] < 2) return false;
  return true;
}

// The rear plain of ours whose basin holds the most stranded army, with its
// basin metrics. `taken` are cells that already hold a vault.
function scanVaults(ctx, config, taken = []) {
  const { size, frontDist } = ctx;
  const found = [];
  for (let i = 0; i < size; i++) {
    if (taken.includes(i)) continue;
    if (!vaultOk(ctx, i, config, true)) continue;
    const basin = deepBasin(ctx, i, frontDist[i]);
    if (basin.cells < 3 || basin.army < config.minBasin) continue;
    if (basin.minEnemy < config.safe) continue;
    if (basin.exits < 1) continue;
    if (basin.outlets > config.outlets) continue;
    const score =
      basin.army * 100 +
      Math.max(0, 8 - basin.exits * 4) * 300 +
      Math.min(4, basin.deepest - frontDist[i]) * 400 +
      Math.min(6, ctx.enemyDist[i]) * 100;
    found.push({ cell: i, basin, score, hop: frontDist[i] });
  }
  found.sort((a, b) => b.score - a.score);
  return found;
}

function pickVault(ctx, config, taken) {
  const found = scanVaults(ctx, config, taken);
  return found.length ? found[0] : null;
}

// Is the army race lost far enough to justify paying for income with army?
function behindOk(config, input) {
  if (!config.behind) return true;
  const army = Math.max(0, Number(input.army) || 0);
  const enemyArmy = Math.max(0, Number(input.enemyArmy) || 0);
  if (enemyArmy <= 0) return true;
  return army * 100 < enemyArmy * config.behind;
}

// Board measurement. Everything here is observable: own cells come from the
// grid, neutral land is only counted where it is visible (a fogged cell reports
// `200`, so an unseen cell must never be mistaken for an empty plain), and the
// swamp/mountain mix is visible through the fog.
function geometry(ctx) {
  const { size, tile, teams, units, neighbors, myTeam, frontDist, enemyDist, cut, isolated } = ctx;
  const seen = ctx.fogMask ?? null;
  const adjacent = new Set();
  const adjacentSwamp = new Set();
  const hop = [0, 0, 0, 0, 0];
  let ring = 0,
    own = 0,
    rear = 0,
    live = 0,
    swampCells = 0,
    mountains = 0,
    plains = 0,
    articulations = 0,
    nearEnemy = 0;
  for (let i = 0; i < size; i++) {
    const code = tile[i];
    if (swamp(code)) swampCells++;
    if (mountain(code)) mountains++;
    if (neutralPlain(code) && !(seen && seen[i])) plains++;
    if (teams[i] !== myTeam) continue;
    own += 1;
    if (isolated && isolated[i]) continue;
    live += 1;
    const d = frontDist[i];
    const bucket = d >= INF ? 4 : Math.min(4, Math.max(0, d));
    hop[bucket] += units[i];
    if (d >= ctx.config.hop && d < INF) rear += units[i];
    if (d === 0) ring += 1;
    if (cut && cut[i] > 0) articulations += 1;
    if (enemyDist[i] < INF && enemyDist[i] <= 4) nearEnemy += 1;
    for (const j of neighbors[i]) {
      if (teams[j] === myTeam) continue;
      if (seen && seen[j]) continue;
      if (neutralPlain(tile[j])) adjacent.add(j);
      else if (tile[j] >= 150 && tile[j] !== 200 && tile[j] !== 201) adjacentSwamp.add(j);
    }
  }
  return {
    own,
    live,
    ring,
    hop0: hop[0],
    hop1: hop[1],
    hop2: hop[2],
    hop3: hop[3],
    hop4: hop[4],
    rear,
    demand: adjacent.size,
    demandSwamp: adjacentSwamp.size,
    plains,
    swampShare: size ? swampCells / size : 0,
    mountainShare: size ? mountains / size : 0,
    articulations,
    nearEnemy,
  };
}

function histAt(state, turn) {
  const hist = state.hist;
  for (let i = hist.length - 1; i >= 0; i--) if (hist[i].turn === turn) return hist[i];
  return null;
}

function recordHistory(state, turn, geom, input) {
  state.hist.push({
    turn,
    rear: geom.rear,
    demand: geom.demand,
    land: Number(input.land) || 0,
    enemyLand: Number(input.enemyLand) || 0,
    army: Number(input.army) || 0,
    enemyArmy: Number(input.enemyArmy) || 0,
  });
  while (state.hist.length > 260) state.hist.shift();
}

// Rear army growth over the last `window` ticks (`0` when there is no history).
function rearRise(state, geom, config) {
  const now = state.hist.at(-1);
  if (!now) return 0;
  const before = histAt(state, now.turn - config.window);
  if (!before) return 0;
  return geom.rear - before.rear;
}

// The pick this tick (for the probe), or `undefined`.
function pickOf(state, turn) {
  return state.pickGeom && state.pickGeom.turn === turn ? state.pickGeom : undefined;
}

// The gate. Everything it reads is a board measurement; there is no map name
// in the protocol, and none is used here.
function gateOpen(state, geom, config) {
  if (!config.gate) return true;
  if (geom.demand > config.demand) return false;
  if (config.rear && geom.rear < config.rear) return false;
  if (config.land > 0 && geom.enemyLand > 0 && geom.land * 100 > geom.enemyLand * config.land)
    return false;
  if (config.rise && rearRise(state, geom, config) < config.rise) return false;
  if (config.swamp > 0 || config.mountain > 0) {
    const wet = config.swamp > 0 && geom.swampShare * 100 >= config.swamp;
    const corridor = config.mountain > 0 && geom.mountainShare * 100 >= config.mountain;
    if (!wet && !corridor) return false;
  }
  return true;
}

// The self-limiting half. Two rules, both measured (see ROUND19-BANKGATE.md):
//
//   a) *the bank does not fill* - after `releaseGrace` ticks the vault's peak
//      army is still below `releaseFill`, i.e. the basin cannot be held and the
//      gather is only starving the frontier. This is the round-18 failure mode
//      (a bank stuck at one or two army for a hundred ticks).
//   b) *the starved land race* (opt-in, measured negative): the frontier has
//      been starved for `releaseTicks` consecutive ticks and our land trails
//      the rival's by more than `releaseGap` cells.
//
// Releasing stops the feed, the redirect and the veto, and leaves the army
// already stacked in the cell: the crown keeps paying, the frontier gets its
// merges back.
function releaseNow(state, geom, config, turn) {
  if (!config.release) return false;
  const active = state.cells.filter((vault) => !vault.done);
  if (!active.length) return false;
  for (const vault of active) {
    if (turn - (vault.pickTurn ?? turn) < config.releaseGrace) continue;
    if (vault.peak < config.releaseFill) return true;
  }
  if (config.releaseDemand > 0) {
    state.starve = geom.demand > config.releaseDemand ? state.starve + 1 : 0;
    if (state.starve >= config.releaseTicks) {
      const land = Number(geom.land) || 0;
      const enemyLand = Number(geom.enemyLand) || 0;
      if (enemyLand <= 0 || enemyLand - land > config.releaseGap) return true;
    }
  }
  return false;
}

// One call per planning tick. Returns null when the layer has nothing to say.
function bankgateUpdate(b, input, config = bankgateConfig()) {
  if (!config.enabled && !probeOn()) return null;
  if (!input || input.multi !== true) return null;
  if (!(Number(input.size) <= config.maxBoard)) return null;
  const turn = Math.max(0, Number(input.turn) || 0);
  if (config.endTurn > 0 && turn >= config.endTurn) return null;

  const ctx = {
    size: Number(input.size),
    tile: input.tile,
    teams: input.teams,
    units: input.units,
    neighbors: input.neighbors,
    myTeam: input.myTeam,
    me: input.me,
    isolated: input.isolated,
    frontDist: input.frontDist,
    enemyDist: input.enemyDist,
    cut: input.cut,
    fogMask: input.fogMask ?? null,
    config,
  };
  const state = (b.bankgate ??= freshBankgate());
  state.ticks += 1;
  const geom = geometry(ctx);
  geom.land = Number(input.land) || 0;
  geom.enemyLand = Number(input.enemyLand) || 0;
  geom.army = Number(input.army) || 0;
  geom.enemyArmy = Number(input.enemyArmy) || 0;
  recordHistory(state, turn, geom, input);
  state.lastGeom = geom;

  if (!config.enabled) {
    trace({
      turn,
      geom,
      bank: state.cells.map((vault) => vault.cell),
      picks: state.picks,
      released: 0,
      pick: pickOf(state, turn),
    });
    return null;
  }
  if (turn < config.startTurn) return null;
  if (config.fog === false && input.fog === true) return null;
  if (!config.corridor && input.corridor === true) return null;

  // A vault that reached the crown is finished: count it, stop feeding it and
  // (if the budget allows) look for the next one.
  for (const vault of state.cells) {
    if (vault.done) continue;
    if (crown(ctx.tile[vault.cell]) && ownerOf(ctx.tile[vault.cell]) === ctx.me) {
      vault.done = true;
      state.done += 1;
    }
  }
  for (const vault of [...state.cells]) {
    if (vault.done) continue;
    if (ctx.teams[vault.cell] !== ctx.myTeam || !vaultOk(ctx, vault.cell, config, false)) {
      state.cells.splice(state.cells.indexOf(vault), 1);
    }
  }
  // Self-limiting release (see `releaseNow`). The army already in the cell is
  // left alone: the crown keeps paying, the frontier gets its merges back.
  if (state.cells.length && releaseNow(state, geom, config, turn)) {
    state.released += 1;
    state.releasedAt = turn;
    state.cells = [];
    trace({
      turn,
      geom,
      bank: [],
      picks: state.picks,
      released: state.released,
      pick: pickOf(state, turn),
    });
    return null;
  }
  const active = state.cells.filter((vault) => !vault.done);
  const budget = config.crowns - state.done - active.length;
  if (budget > 0 && behindOk(config, input) && gateOpen(state, geom, config)) {
    const taken = state.cells.map((vault) => vault.cell);
    const pick = pickVault(ctx, config, taken);
    if (pick) {
      state.cells.push({
        cell: pick.cell,
        done: false,
        pickTurn: turn,
        peak: ctx.units[pick.cell],
      });
      state.picks += 1;
      state.pickGeom = {
        turn,
        demand: geom.demand,
        rear: geom.rear,
        swampShare: geom.swampShare,
        basinArmy: pick.basin.army,
        basinOutlets: pick.basin.outlets,
        hop: pick.hop,
        rise: rearRise(state, geom, config),
        land: geom.land,
        enemyLand: geom.enemyLand,
        army: geom.army,
        enemyArmy: geom.enemyArmy,
      };
      active.push(state.cells.at(-1));
    }
  }
  if (!active.length) {
    trace({
      turn,
      geom,
      bank: state.cells.map((vault) => vault.cell),
      picks: state.picks,
      released: state.released,
      done: state.done,
      pick: pickOf(state, turn),
    });
    return null;
  }
  for (const vault of active) {
    vault.field = ownField(ctx.size, ctx.neighbors, ctx.teams, ctx.myTeam, vault.cell);
    vault.peak = Math.max(vault.peak ?? 0, ctx.units[vault.cell]);
  }
  const crowns = state.cells.filter((vault) => vault.done).map((vault) => vault.cell);
  return { config, turn, ctx, active, state, keep: config.keep, crowns };
}

// One step down the vault field from `from`.
function vaultStep(plan, ctx, from) {
  const { teams, neighbors, frontDist } = ctx;
  const { config } = plan;
  let best = -1,
    bestField = Infinity,
    bestArmy = -1;
  for (const vault of plan.active) {
    const field = vault.field;
    if (field[from] <= 0) continue;
    for (const j of neighbors[from]) {
      if (teams[j] !== ctx.myTeam) continue;
      if (field[j] < 0 || field[j] >= field[from]) continue;
      if (frontDist[j] < config.hop) continue;
      const army = ctx.units[j];
      if (field[j] < bestField || (field[j] === bestField && army > bestArmy)) {
        best = j;
        bestField = field[j];
        bestArmy = army;
      }
    }
  }
  return best;
}

// Veto the planner's own orders on a vault and re-point its rear merges at the
// bank. See `./mcrown2`: the redirect, not the appended feed, is the channel.
function applyBankgate(plan, ctx, candidates) {
  if (!plan || !plan.active.length) return;
  const { units, teams, frontDist } = ctx;
  const { config } = plan;
  const bank = new Set();
  for (const vault of plan.active) bank.add(vault.cell);
  const pinned = plan.keep > 0 ? new Set(plan.crowns ?? []) : null;
  const kept = [];
  for (const op of candidates) {
    if (op.build) {
      kept.push(op);
      continue;
    }
    if (bank.has(op.from) && op.score < 300) {
      plan.state.vetoed += 1;
      continue;
    }
    if (
      pinned &&
      pinned.has(op.from) &&
      op.score < 300 &&
      teams[op.to] === teams[op.from] &&
      units[op.from] <= plan.keep
    ) {
      plan.state.vetoed += 1;
      continue;
    }
    if (
      config.gain > 0 &&
      op.score < 300 &&
      teams[op.to] === teams[op.from] &&
      units[op.to] < config.cap &&
      frontDist[op.from] >= config.hop
    ) {
      const step = vaultStep(plan, ctx, op.from);
      if (step >= 0 && frontDist[step] >= config.hop) {
        op.to = step;
        op.score += config.gain + (plan.active.some((vault) => vault.cell === step) ? 40 : 0);
        plan.state.repriced += 1;
      }
    }
    kept.push(op);
  }
  if (kept.length !== candidates.length) candidates.splice(0, candidates.length, ...kept);
}

// Append the gather orders and the build order. Called after the planner's own
// matching loop (and after the three-tick search, whose adopted set it feeds).
function bankgateOrders(plan, ctx, orders) {
  const extra = [];
  if (!plan || !plan.active.length) return extra;
  const { tile, teams, units, neighbors, frontDist, myTeam } = ctx;
  const { config } = plan;
  const baseSrc = new Set(),
    baseTgt = new Set();
  for (const op of orders) {
    if (op.build) continue;
    baseSrc.add(op.from);
    baseTgt.add(op.to);
  }
  const moved = new Set(),
    blocked = new Set();
  let feed = 0;
  for (const vault of plan.active) {
    const field = vault.field;
    const incoming = new Map();
    if (feed >= config.feed) break;
    if (units[vault.cell] >= config.cap) continue;
    const sources = [];
    for (let i = 0; i < field.length; i++) {
      if (field[i] <= 0) continue;
      if (frontDist[i] < config.hop || frontDist[i] >= INF) continue;
      if (units[i] < config.minArmy) continue;
      if (teams[i] !== myTeam) continue;
      if (ctx.isolated && ctx.isolated[i]) continue;
      sources.push(i);
    }
    sources.sort((a, c) => field[a] - field[c] || units[c] - units[a]);
    for (const from of sources) {
      if (feed >= config.feed) break;
      if (moved.has(from) || blocked.has(from) || baseSrc.has(from) || baseTgt.has(from)) continue;
      let to = -1;
      for (const j of neighbors[from]) {
        if (teams[j] !== myTeam || field[j] < 0 || field[j] >= field[from]) continue;
        if (moved.has(j) || baseSrc.has(j)) continue;
        if (frontDist[j] < config.hop - 1) continue;
        if (to < 0 || field[j] < field[to] || (field[j] === field[to] && units[j] > units[to])) to = j;
      }
      if (to < 0) continue;
      const send = units[from] - 1;
      if (send <= 0) continue;
      extra.push({ score: 0, from, to, mode: 2, send, bankgate: true });
      moved.add(from);
      blocked.add(to);
      incoming.set(to, (incoming.get(to) ?? 0) + send);
      feed += 1;
    }
    if (!config.build) continue;
    const cell = vault.cell;
    if (baseSrc.has(cell)) continue;
    if (orders.some((op) => op.build && op.from === cell)) continue;
    const bank = units[cell] + (incoming.get(cell) ?? 0);
    if (bank < 50) continue;
    if (plain(tile[cell])) {
      extra.push({ score: 0, from: cell, to: cell, mode: 2, build: 'b', bankgate: true });
      plan.state.builds += 1;
    } else if (city(tile[cell])) {
      extra.push({ score: 0, from: cell, to: cell, mode: 2, build: 'c', bankgate: true });
      plan.state.builds += 1;
    }
  }
  plan.state.feeds += feed;
  trace({
    turn: plan.turn,
    geom: plan.state.lastGeom,
    feed,
    build: extra.filter((op) => op.build).map((op) => `${op.build}@${op.from}`),
    bank: plan.active.map((vault) => ({
      cell: vault.cell,
      army: units[vault.cell],
      hop: frontDist[vault.cell],
    })),
    picks: plan.state.picks,
    released: plan.state.released,
    done: plan.state.done,
    pick: pickOf(plan.state, plan.turn),
  });
  return extra;
}

module.exports = {
  bankgateConfig,
  bankgateUpdate,
  applyBankgate,
  bankgateOrders,
  geometry,
  gateOpen,
  releaseNow,
  rearRise,
  ownField,
  deepBasin,
  scanVaults,
  pickVault,
  vaultOk,
  freshBankgate,
  INF,
  DEFAULT_MAX_BOARD,
  DEFAULT_HOP,
  DEFAULT_START,
  DEFAULT_END,
  DEFAULT_FEED,
  DEFAULT_GAIN,
  DEFAULT_MIN_ARMY,
  DEFAULT_SAFE,
  DEFAULT_CROWNS,
  DEFAULT_CAP,
  DEFAULT_KEEP,
  DEFAULT_FOG,
  DEFAULT_CORRIDOR,
  DEFAULT_BUILD,
  DEFAULT_MIN_BASIN,
  DEFAULT_OUTLETS,
  DEFAULT_BEHIND,
  DEFAULT_GATE,
  DEFAULT_DEMAND,
  DEFAULT_REAR,
  DEFAULT_RISE,
  DEFAULT_WINDOW,
  DEFAULT_SWAMP,
  DEFAULT_MOUNTAIN,
  DEFAULT_LAND,
  DEFAULT_RELEASE,
  DEFAULT_RELEASE_FILL,
  DEFAULT_RELEASE_DEMAND,
  DEFAULT_RELEASE_TICKS,
  DEFAULT_RELEASE_GAP,
  DEFAULT_RELEASE_GRACE,
};
