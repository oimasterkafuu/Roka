'use strict';

// Crown economy from the stranded rear army (round 18, `BOT3_MCROWN2`).
//
// Diagnosis. Multi-line rooms pay +1 army every tick on a crown, and the game
// usually runs 350-600 ticks, so a crown bought at tick 100 pays ~250 army; a
// land cell pays +1 per 50 ticks, i.e. a hundredth of that. Round 15's `mcrown`
// tried to buy the crown out of the whole empire and lost 5.9pp, because the
// gather starved the frontier the exchange actually fires from.
//
// Round 17's census says the army is not where the frontier is. Measured on the
// 256-game relay screen, army by hop from the frontier at t50-250 is
// hop0 21.5, hop1 13.8, hop2 14.4, hop3 13.2, hop4+ **61.4** - and on the
// probe long games the hop4+ pool grows to 100-190 army by t300 while the
// frontier ring holds one or two army per cell. That rear pool is idle: four or
// more hops is longer than an exchange lasts, so it never reaches the front in
// time to matter.
//
// What this layer does (only in a multi-line room, only while `BOT3_MCROWN2` is
// on, byte-identical when off):
//
//   * vault: the safest rear plain of ours, `hop >= BOT3_MCROWN2_HOP` (default
//     3) hops from the ring, `>= safe` hops from any visible rival cell, not an
//     articulation of our own territory (`cut[i] === 0`) and connected. Among
//     the candidates it takes the one with the largest army supply inside four
//     hops - the point is to collect a *concentrated* stack, which the inherited
//     planner never builds (measured: no cell of ours reaches 50 army in the
//     rear, so the stock `develop` rule never fires there).
//   * gather: a BFS field toward the vault over our own cells. Every tick the
//     layer appends up to `feed` merge orders that step one hop down that field,
//     **from cells at hop >= HOP only** - never the ring, never hop 0/1, so the
//     frontier exchange is untouched. The engine runs several moves into one
//     cell per tick, so the vault is fed by 3-6 sources at once instead of the
//     one automatic order per target the planner's matching loop allows; the
//     chain rules below keep every appended order executable.
//   * build: at 50 army the vault builds a city (`b`) and at the next 50 the
//     city upgrades to a crown (`c`). The engine only asks 50 per step; the
//     inherited `develop` rule waits for 100 on a plain, which is why it never
//     fires on a spread-out rear.
//   * stand down: once the vault is a crown the layer stops feeding it. The
//     inherited planner then routes the crown's +1/tick forward itself, which is
//     the whole point. `keep` can pin a garrison on the crown instead.
//
// Chain rules (the engine drops a queued move whose source is another queued
// move's target, `game-engine.ts` multi-line branch): the layer never targets a
// cell it already made a source this tick, never uses a cell it already made a
// target as a source, and never collides with an order the planner already
// emitted. Several orders into the same cell are legal and intended.
//
// Negatives measured this round are in ROUND18-MCROWN2.md; the switches below
// reproduce every one of them.

const INF = 1e6;
const DEFAULT_MAX_BOARD = 800;
// Hops from the frontier a vault and its donors must sit at. The ring and hop 1
// are off limits: that army is the exchange.
const DEFAULT_HOP = 3;
// First planning tick the gather may run. The t50 pulse is the first big deposit
// of rear army, so pre-staging a few ticks early only moves the same army.
const DEFAULT_START = 44;
const DEFAULT_END = 0;
// Merge orders the layer may append per tick (the engine has no queue cap).
const DEFAULT_FEED = 4;
// Score added to a merge that steps one hop down the vault field. The inherited
// own-merge band is 14 + sqrt(send) * 4 (at most ~59) and a neutral capture is
// 32-100, so this routes rear merges to the bank without outranking a capture:
// the batch is 64 slots wide and a measured tick uses 9-16.
const DEFAULT_GAIN = 110;
// Army a donor keeps: a merge of `mode 2` pushes `units - 1`.
const DEFAULT_MIN_ARMY = 2;
// Hops between the vault and the closest *visible* rival cell. A crown is +1 per
// tick forever, so it is worth nothing if the rival can take it for free.
const DEFAULT_SAFE = 3;
// Vaults to crown. One crown is the measured default; two is a switch.
const DEFAULT_CROWNS = 1;
// Stop feeding once the vault holds this much (defensive ceiling).
const DEFAULT_CAP = 110;
// Garrison to pin on a finished crown (`0` = let the planner route it forward).
const DEFAULT_KEEP = 0;
const DEFAULT_FOG = 1;
const DEFAULT_CORRIDOR = 0;
const DEFAULT_BUILD = 1;
// A basin must hold at least this much army to be worth a vault.
const DEFAULT_MIN_BASIN = 12;
// How many shallow ways out a basin may have. Freezing one cell only holds the
// army behind it when the vault is the basin's single outlet, so `1` is the only
// rule that is safe by construction - and measured, it is also almost inert
// (-0.4pp, one flip): a single-outlet rear basin is rare on these boards, which
// is the ceiling of this whole direction. The layer's measured value needs the
// multi-outlet picks (`8` = no effective cap on a 20x20 board), which is also
// where it regresses: see ROUND18-MCROWN2.md.
const DEFAULT_OUTLETS = 8;
// Only start a vault while our army is behind this percent of the rival's
// (`0` = off). The crown is an income investment paid for with army the exchange
// could have used, and the measured cells say that trade only pays when the
// exchange is already being lost: with the gate off the layer loses 7pp and
// takes the whole random cell to 0/32, with it on it gains 4pp. It gates the
// *pick* only - abandoning a half-filled bank when the race flips throws the
// investment away (measured: a per-tick gate at 90 percent was inert).
const DEFAULT_BEHIND = 100;

// Round 19: the bank is a *fog* play. On a clear board the rival sees the
// vault and can punish the pause the gather costs; in fog it cannot see our
// rear at all, so the same redirect measures +4/+3 wins on archipelago fog and
// +13/+14 on mediterranean fog while the clear cells stay byte-identical.
// `BOT3_FOGBANK` is the fog-only switch (it enables the layer together with
// every fog default below); `BOT3_MCROWN2` keeps the round-18 behaviour.
const DEFAULT_FOGONLY = 0;

// Swamp share of the board (percent) a fog room needs before a bank may start.
// This is the measured divide between the two halves of the fog multi cells:
// archipelago fog is 65 % swamp and mediterranean fog 36-47 %, the two cells the
// bank wins; random fog is 7-11 % and maze fog 8 %, the two cells it loses on
// every single pick. Swamp pays no income at all (`+1` army comes from a plain
// cell only), so on a swamp-heavy board land is a poor place to keep army and a
// crown's `+1`/tick is the compounding income; on a grass board land *is* the
// income and the army the gather diverts is still the pipe that pays for it.
// Swamp is visible through the fog (`fog-vision.ts` keeps 204 visible), so the
// gate reads a board property the rival's vision does not hide.
const DEFAULT_SWAMP = 0;
const DEFAULT_FOGBANK_SWAMP = 30;
// Last tick a *new* vault may be picked (`0` = no limit). Measured on the fog
// multi cells: every archipelago vault picked after t90 was filled against a
// rival that already held twice our land and never finished; the early picks
// (t44-60, before the rival's expansion converts) are the ones that pay. This
// gates the pick only - a bank that is already filling is always finished.
const DEFAULT_PICKEND = 0;

// Round 20 (`BOT3_MCROWN2_MINBANK`): army the bank must already hold before the
// *first* of the two builds is issued (0 = the shipped 50, i.e. a city is bought
// as soon as the vault can pay for it). A crown costs two builds of 50, and the
// rear basin that fed the vault is usually drained by the first one: measured on
// the archipelago fog multi cell, every pick that built a city at 50 but never
// reached the second 50 lost the game (0W/9L), while every pick that completed
// the crown won (8W/1L/1T). Waiting until the vault can pay for both builds in
// two ticks turns a failed pick into "no build" instead of a 50-army hole.
const DEFAULT_MINBANK = 0;

// Round 20 (`BOT3_MCROWN2_SHALLOW`): swamp share (percent) above which the
// gather band may be shortened from `hop` 3 to 2. This is the round-20 result on
// the archipelago fog multi cell: the rear basin on an island board is drained
// by the first build of the crown (the two builds cost 100 army), and the only
// army left is one hop shallower than the round-18 band. Shortening the band to
// hop 2 fills the bank out of that ring - measured +5 wins on the cell (19 ->
// 24) with the archipelago clear cell and the other three fog cells untouched,
// because the gate is the board's swamp share (archipelago 64-67 %, the next
// wettest room, mediterranean, is 36-47 %). Off at 0, so the shipped path is
// byte-identical.
const DEFAULT_SHALLOW = 55;

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
function mcrown2Config(overrides = {}, env = process.env) {
  const fogBank = flag(env.BOT3_FOGBANK, true);
  return {
    enabled: overrides.enabled ?? (flag(env.BOT3_MCROWN2, false) || fogBank),
    fogBank: overrides.fogBank ?? fogBank,
    maxBoard: overrides.maxBoard ?? number(env.BOT3_MCROWN2_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    hop: overrides.hop ?? number(env.BOT3_MCROWN2_HOP, DEFAULT_HOP, 1, 50),
    startTurn: overrides.startTurn ?? number(env.BOT3_MCROWN2_START, DEFAULT_START, 0, 10000),
    endTurn: overrides.endTurn ?? number(env.BOT3_MCROWN2_END, DEFAULT_END, 0, 10000),
    feed: overrides.feed ?? number(env.BOT3_MCROWN2_FEED, DEFAULT_FEED, 0, 64),
    gain: overrides.gain ?? number(env.BOT3_MCROWN2_GAIN, DEFAULT_GAIN, 0, 5000),
    minArmy: overrides.minArmy ?? number(env.BOT3_MCROWN2_MIN, DEFAULT_MIN_ARMY, 2, 50),
    safe: overrides.safe ?? number(env.BOT3_MCROWN2_SAFE, DEFAULT_SAFE, 1, 50),
    crowns: overrides.crowns ?? number(env.BOT3_MCROWN2_CROWNS, DEFAULT_CROWNS, 1, 4),
    cap: overrides.cap ?? number(env.BOT3_MCROWN2_CAP, DEFAULT_CAP, 50, 100000),
    keep: overrides.keep ?? number(env.BOT3_MCROWN2_KEEP, DEFAULT_KEEP, 0, 1000),
    minBasin: overrides.minBasin ?? number(env.BOT3_MCROWN2_BASIN, DEFAULT_MIN_BASIN, 1, 10000),
    outlets: overrides.outlets ?? number(env.BOT3_MCROWN2_OUTLETS, DEFAULT_OUTLETS, 1, 40),
    behind: overrides.behind ?? number(env.BOT3_MCROWN2_BEHIND, DEFAULT_BEHIND, 0, 1000),
    build: overrides.build ?? flag(env.BOT3_MCROWN2_BUILD, DEFAULT_BUILD === 1),
    fog: overrides.fog ?? flag(env.BOT3_MCROWN2_FOG, DEFAULT_FOG === 1),
    corridor: overrides.corridor ?? flag(env.BOT3_MCROWN2_CORRIDOR, DEFAULT_CORRIDOR === 1),
    // Fog-only gate: the layer only ever runs in a fog room. Both round-18
    // regressions (random clear -15.6pp, relay random clear) are clear cells.
    fogOnly: overrides.fogOnly ?? flag(env.BOT3_MCROWN2_FOGONLY, DEFAULT_FOGONLY === 1 || fogBank),
    pickEnd: overrides.pickEnd ?? number(env.BOT3_MCROWN2_PICKEND, DEFAULT_PICKEND, 0, 10000),
    minBank: overrides.minBank ?? number(env.BOT3_MCROWN2_MINBANK, DEFAULT_MINBANK, 0, 1000),
    shallow: overrides.shallow ?? number(env.BOT3_MCROWN2_SHALLOW, DEFAULT_SHALLOW, 0, 100),
    swamp:
      overrides.swamp ??
      number(env.BOT3_MCROWN2_SWAMP, fogBank ? DEFAULT_FOGBANK_SWAMP : DEFAULT_SWAMP, 0, 100),
  };
}

function freshMcrown2() {
  return { ticks: 0, picks: 0, feeds: 0, builds: 0, vetoed: 0, repriced: 0, done: 0, cells: [], last: null };
}

const ownerOf = (code) => (code < 200 ? code % 50 : 0);
const crown = (code) => code >= 100 && code < 150;
const city = (code) => code >= 50 && code < 100;
const plain = (code) => code >= 1 && code < 50;
const swamp = (code) => code >= 150 && code !== 200 && code !== 201;

// Tracing is opt-in and only feeds the round-18 probe; nothing reads it in a
// normal game, and the array stays empty unless the variable is set.
const traceOn = () => process.env.BOT3_MCROWN2_TRACE === '1';
function trace(row) {
  if (!traceOn()) return;
  (globalThis.__mcrown2 ||= []).push(row);
}

// Diagnosis-only census (round 19): our army by hop band, our cell count and the
// leaderboard land of both sides. Nothing is walked unless the trace is on, so a
// normal game never pays for it.
function traceCensus(ctx, input) {
  if (!traceOn()) return {};
  const { teams, units, frontDist, myTeam } = ctx;
  const size = ctx.size ?? teams.length;
  const hop = [0, 0, 0, 0, 0];
  let cells = 0;
  for (let i = 0; i < size; i++) {
    if (teams[i] !== myTeam) continue;
    cells += 1;
    const d = frontDist[i];
    if (!(d >= 1)) hop[0] += units[i];
    else if (d === 1) hop[1] += units[i];
    else if (d === 2) hop[2] += units[i];
    else if (d === 3) hop[3] += units[i];
    else hop[4] += units[i];
  }
  return {
    hop,
    cells,
    land: input?.land ?? null,
    enemyLand: input?.enemyLand ?? null,
    army: input?.army ?? null,
    enemyArmy: input?.enemyArmy ?? null,
  };
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
// really banks. `exits` counts the shallow neighbours (the other ways out), and
// a basin with two outlets cannot be held by freezing one cell.
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
  // Outlets of the basin: the basin cells that still touch a shallower cell.
  // Freezing the vault only holds the army behind it when it is the *only*
  // outlet; a basin with two ways out just reroutes the flow through the other
  // one, which is exactly the measured failure of the multi-outlet picks (the
  // bank stayed at one or two army for a hundred ticks).
  let outlets = 0;
  for (let k = 0; k < size; k++) {
    if (!seen[k]) continue;
    for (const j of neighbors[k]) if (frontDist[j] < floor) outlets += 1;
  }
  let exits = 0;
  for (const j of neighbors[i]) if (frontDist[j] < floor) exits += 1;
  return { army, cells, minEnemy, deepest, exits, outlets };
}

// The rear plain of ours whose basin holds the most stranded army. The round-17
// census says that army is four or more hops behind the ring and never reaches
// the exchange; this picks the outlet of the basin it sits in, preferring a
// basin with a single way out (a cell inside a bundle of outlets cannot be held
// by freezing one cell) and one the rival cannot see.
function pickVault(ctx, config, taken) {
  const { size, tile, teams, units, myTeam, isolated, frontDist, enemyDist } = ctx;
  let best = -1,
    bestScore = -Infinity;
  for (let i = 0; i < size; i++) {
    if (taken.includes(i)) continue;
    if (!vaultOk(ctx, i, config, true)) continue;
    const basin = deepBasin(ctx, i, frontDist[i]);
    if (basin.cells < 3 || basin.army < config.minBasin) continue;
    if (basin.minEnemy < config.safe) continue;
    // The vault has to be an *outlet* and the only one its basin has; see
    // `deepBasin`. A multi-outlet basin cannot be held by freezing one cell.
    if (basin.exits < 1) continue;
    if (basin.outlets > config.outlets) continue;
    const score =
      basin.army * 100 +
      Math.max(0, 8 - basin.exits * 4) * 300 +
      Math.min(4, basin.deepest - frontDist[i]) * 400 +
      Math.min(6, enemyDist[i]) * 100;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

// Is this cell still a legal vault? Two levels on purpose.
//
// `pick` is the entry rule: a plain, `hop` or deeper, `safe` hops from any
// visible rival cell. Note what is *not* here: `cut[i] > 0`. An articulation of
// our own territory is exactly the cell whose outflow holds a rear basin - the
// planner's `cut` field would reject every good vault, and the measured effect
// of that gate was a vault that moved every tick (`START=150` lost 30pp).
//
// Keeping an existing vault is deliberately looser: as the frontier moves the
// hop and rival distances drift, and re-picking on every drift thrashes the
// redirect. A held vault only has to stay ours, un-isolated and not on the
// rival's doorstep.
function vaultOk(ctx, i, config, pick = true) {
  const { tile, teams, myTeam, isolated, frontDist, enemyDist } = ctx;
  if (teams[i] !== myTeam) return false;
  // A vault keeps its slot while it is a plain, the city it bought at 50 or the
  // crown that city upgrades into; only a pick insists on a plain.
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

// Swamp share of the whole board, in percent. Swamp cells are visible through
// the fog (`fog-vision.ts` blanks unseen cells to 200/204 but keeps 204), so
// this is an exact, fog-observable read of the room's terrain mix. `swamp` is a
// board terrain fact, not a guess about the rival.
function swampShare(input) {
  const { size, tile } = input;
  if (!tile || !(size > 0)) return 0;
  let swampCells = 0;
  for (let i = 0; i < size; i++) if (swamp(tile[i])) swampCells += 1;
  return (swampCells * 100) / size;
}

function swampOk(config, input) {
  return swampShare(input) >= config.swamp;
}

// Is the army race lost far enough to justify paying for income with army?
function behindOk(config, input) {
  if (!config.behind) return true;
  const army = Math.max(0, Number(input.army) || 0);
  const enemyArmy = Math.max(0, Number(input.enemyArmy) || 0);
  if (enemyArmy <= 0) return true;
  return army * 100 < enemyArmy * config.behind;
}

// One call per planning tick. Returns null when the layer has nothing to say,
// which keeps the planner on the exact baseline path.
function mcrown2Update(b, input, config = mcrown2Config()) {
  if (!config.enabled) return null;
  if (!input || input.multi !== true) return null;
  if (!(Number(input.size) <= config.maxBoard)) return null;
  const turn = Math.max(0, Number(input.turn) || 0);
  if (turn < config.startTurn) return null;
  if (config.endTurn > 0 && turn >= config.endTurn) return null;
  if (config.fog === false && input.fog === true) return null;
  if (config.fogOnly && input.fog !== true) return null;
  if (config.swamp > 0 && !swampOk(config, input)) return null;
  if (!config.corridor && input.corridor === true) return null;

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
  };
  // Shallow gather band (`BOT3_MCROWN2_SHALLOW`): on a swamp-heavy island board
  // the crown's first build drains the rear basin and the army that would finish
  // the second one sits one hop shallower. Everything below reads `cfg`, so the
  // pick, the redirect, the feed and the basin walk all move together.
  const cfg =
    config.shallow > 0 && swampShare(input) >= config.shallow && config.hop > 2
      ? { ...config, hop: 2 }
      : config;
  const state = (b.mcrown2 ??= freshMcrown2());
  state.ticks += 1;
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
    if (ctx.teams[vault.cell] !== ctx.myTeam) {
      state.cells.splice(state.cells.indexOf(vault), 1);
      continue;
    }
    if (!vaultOk(ctx, vault.cell, cfg, false)) {
      state.cells.splice(state.cells.indexOf(vault), 1);
      continue;
    }
  }
  const active = state.cells.filter((vault) => !vault.done);
  const budget = config.crowns - state.done - active.length;
  // `behind` is a *pick* gate, not a run gate: abandoning a half-filled bank
  // when the army race flips throws the investment away, and the measured
  // version of that (a per-tick gate) was inert at 90 percent and lost 5pp at
  // 100. Once the bank exists it is finished.
  const pickOpen = !(config.pickEnd > 0 && turn >= config.pickEnd);
  if (budget > 0 && pickOpen && behindOk(config, input)) {
    const taken = state.cells.map((vault) => vault.cell);
    const cell = pickVault(ctx, cfg, taken);
    if (cell >= 0) {
      state.cells.push({ cell, done: false });
      state.picks += 1;
      active.push(state.cells.at(-1));
    }
  }
  if (!active.length) {
    trace({
      turn,
      me: ctx.me,
      vaults: state.cells.map((vault) => vault.cell),
      feed: 0,
      build: [],
      done: state.done,
      vetoed: state.vetoed,
      ...traceCensus(ctx, input),
    });
    return null;
  }
  // Recompute the field every tick: the empire moves, and a stale field would
  // route army into a cell we no longer hold.
  for (const vault of active)
    vault.field = ownField(ctx.size, ctx.neighbors, ctx.teams, ctx.myTeam, vault.cell);
  const crowns = state.cells.filter((vault) => vault.done).map((vault) => vault.cell);
  return { config: cfg, turn, ctx, active, state, keep: cfg.keep, crowns, input };
}

// One step down the vault field from `from`: the own neighbour that is closest
// to the bank. `-1` when the cell already is the bank or has no closer
// neighbour (a pocket, or a target the layer would not accept).
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

// Veto the planner's own orders on a vault. A `mode 2` merge out of the vault
// pushes everything but one army, which would drain the gather bank every tick
// (`frontDist`-decreasing merges score 14-59 and land inside the 64-slot batch).
// Defence, rescue and sieges (>= 300) are left alone: dropping a defence to fund
// a rear bank is how round 15's `mcrown` lost.
//
// The same pass re-prices every own merge that steps one hop down the vault
// field. This is the mechanism that measured: the bank is not filled by extra
// orders (only a handful of rear cells hold two army on any one tick, so the
// appended `feed` path fires 0.3 times a tick) but by *redirecting* the merges
// the planner already emits after each pulse. Only cells at `hop` or deeper and
// only merges whose target is also at `hop` or deeper are touched, so the
// hop2->hop1->hop0 exchange that the frontier fires from keeps its supply.
function applyMcrown2(plan, ctx, candidates) {
  if (!plan || !plan.active.length) return;
  const { units, teams, neighbors, frontDist } = ctx;
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
    // Redirect an own merge that starts at `hop` or deeper. The inherited
    // planner only proposes a rear merge when it steps *toward* the ring
    // (`frontDist[to] < frontDist[from]`), so nothing it emits would ever carry
    // that army to a rear bank: the army is already on its way to the frontier
    // and this layer's only lever is where it goes instead.
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
// matching loop, on the final `orders` array.
function mcrown2Orders(plan, ctx, orders) {
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
    // Closest to the vault first: the army that is one hop away lands in the
    // bank this tick, the rest keeps walking, so the gather is continuous.
    sources.sort((a, c) => field[a] - field[c] || units[c] - units[a]);
    for (const from of sources) {
      if (feed >= config.feed) break;
      if (moved.has(from) || blocked.has(from) || baseSrc.has(from) || baseTgt.has(from)) continue;
      let to = -1;
      for (const j of neighbors[from]) {
        if (teams[j] !== myTeam || field[j] < 0 || field[j] >= field[from]) continue;
        if (moved.has(j) || baseSrc.has(j)) continue;
        // The gather stays in the rear: a target may be one hop closer to the
        // ring than the donor gate, never more.
        if (frontDist[j] < config.hop - 1) continue;
        if (to < 0 || field[j] < field[to] || (field[j] === field[to] && units[j] > units[to])) to = j;
      }
      if (to < 0) continue;
      const send = units[from] - 1;
      if (send <= 0) continue;
      extra.push({ score: 0, from, to, mode: 2, send, mcrown2: true });
      moved.add(from);
      blocked.add(to);
      incoming.set(to, (incoming.get(to) ?? 0) + send);
      feed += 1;
    }
    // Build as soon as the *predicted* army (the frame forecast plus everything
    // this tick's merges deliver) pays for it. Two steps of 50, the engine's
    // `BUILD_COST`; the inherited `develop` rule waits for 100 on a plain and
    // therefore never fires on a spread-out rear.
    if (!config.build) continue;
    const cell = vault.cell;
    if (baseSrc.has(cell)) continue;
    if (orders.some((op) => op.build && op.from === cell)) continue;
    const bank = units[cell] + (incoming.get(cell) ?? 0);
    // A city is only worth buying when the *crown* it upgrades into is already
    // affordable: `minBank` (default 0 -> the shipped 50) raises the first build
    // to the two-build total, so a bank that cannot finish spends nothing. The
    // second build (city -> crown) keeps the engine's single 50.
    const need = plain(tile[cell]) ? Math.max(50, config.minBank) : 50;
    if (bank < need) continue;
    if (plain(tile[cell])) {
      extra.push({ score: 0, from: cell, to: cell, mode: 2, build: 'b', mcrown2: true });
      plan.state.builds += 1;
    } else if (city(tile[cell])) {
      extra.push({ score: 0, from: cell, to: cell, mode: 2, build: 'c', mcrown2: true });
      plan.state.builds += 1;
    }
  }
  plan.state.feeds += feed;
  trace({
    turn: plan.turn,
    me: plan.ctx.me,
    vaults: plan.active.map((vault) => vault.cell),
    feed,
    build: extra.filter((op) => op.build).map((op) => `${op.build}@${op.from}`),
    done: plan.state.done,
    sources: plan.active.map((vault) => {
      const field = vault.field;
      let count = 0;
      for (let i = 0; i < field.length; i++)
        if (field[i] > 0 && frontDist[i] >= config.hop && frontDist[i] < INF && units[i] >= config.minArmy)
          count += 1;
      return count;
    }),
    bank: plan.active.map((vault) => units[vault.cell]),
    repriced: plan.state.repriced,
    vetoed: plan.state.vetoed,
    ...traceCensus(ctx, plan.input),
  });
  return extra;
}

module.exports = {
  mcrown2Config,
  mcrown2Update,
  applyMcrown2,
  mcrown2Orders,
  ownField,
  deepBasin,
  pickVault,
  vaultOk,
  freshMcrown2,
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
  DEFAULT_FOGONLY,
  DEFAULT_SWAMP,
  DEFAULT_PICKEND,
  DEFAULT_MINBANK,
  DEFAULT_SHALLOW,
  DEFAULT_FOGBANK_SWAMP,
  swampShare,
  swampOk,
};
