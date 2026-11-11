'use strict';

/**
 * Opponent-style gate diagnostic for the maze blitz.
 *
 * The blitz is anti-specific: it lifts the Anti-Human match-up and regresses
 * the Apex (crown-race/defensive) one.  This script measures the observable
 * features the blitz can read at the burst end / launch window (ticks 45-60)
 * so a gate can separate the two styles without naming or seeding them.
 *
 * Recorded per tick from our own board snapshot:
 *   - enemy crown / city count (early construction) and buildings total;
 *   - enemy land and army, plus their growth inside the window;
 *   - enemy army mass and share within radius R of its own crowns
 *     (defensiveness / concentration), and the largest crown garrison;
 *   - whether the enemy already holds several crowns by the launch tick.
 *
 * Usage:
 *   APEX_MAZE_BLITZ=1 node training/opponent-gate-report.cjs \
 *     [--seeds 2] [--sizes 0.34,0.68] [--seat both] [--turns 2400]
 *     [--opponent anti|apex|both] [--window 45,60] [--radius 2] [-o FILE]
 */

const path = require('node:path');
const { parseArgs } = require('node:util');
const { runMatch } = require('./engine.cjs');
const { makeBoard } = require('../bot/board.cjs');
const { createController } = require('../bot/controller.cjs');
const { chooseAction: antiAction } = require('../../anti-human-bot/bot/policy.cjs');

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      seeds: { type: 'string' },
      offset: { type: 'string' },
      sizes: { type: 'string' },
      seat: { type: 'string' },
      turns: { type: 'string' },
      opponent: { type: 'string' },
      prefix: { type: 'string' },
      window: { type: 'string' },
      radius: { type: 'string' },
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [from, to] = String(values.window ?? '45,60').split(',').map(Number);
  return {
    seeds: Number(values.seeds ?? 2),
    offset: Number(values.offset ?? 0),
    sizes: String(values.sizes ?? '0.34,0.68').split(',').map(Number),
    seat: String(values.seat ?? 'both'),
    turns: Number(values.turns ?? 2400),
    opponent: String(values.opponent ?? 'both'),
    prefix: String(values.prefix ?? 'apex-long'),
    window: [from, to],
    radius: Number(values.radius ?? 2),
    output: values.output ? path.resolve(values.output) : null,
    help: Boolean(values.help),
  };
}

function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// Observable opponent-style features.  Everything here is read from the same
// board snapshot the planner receives, so a gate built on it stays legal.
function features(board, radius) {
  const crowns = [];
  const cities = [];
  let enemyLand = 0;
  let enemyArmy = 0;
  let ownLand = 0;
  let ownArmy = 0;
  for (let at = 0; at < board.size; at += 1) {
    if (board.enemy(at)) {
      enemyLand += 1;
      enemyArmy += Math.max(0, Number(board.army[at]) || 0);
      if (board.kind(at) === 'crown') crowns.push(at);
      else if (board.kind(at) === 'city') cities.push(at);
    } else if (board.own(at)) {
      ownLand += 1;
      ownArmy += Math.max(0, Number(board.army[at]) || 0);
    }
  }
  let crownGuard = 0;
  let crownGuardMax = 0;
  for (const at of crowns) {
    const army = Math.max(0, Number(board.army[at]) || 0);
    crownGuard += army;
    crownGuardMax = Math.max(crownGuardMax, army);
  }
  const crownXY = crowns.map((at) => board.xy(at));
  let nearCrownArmy = 0;
  for (let at = 0; at < board.size; at += 1) {
    if (!board.enemy(at)) continue;
    const xy = board.xy(at);
    if (!crownXY.some((crown) => chebyshev(crown, xy) <= radius)) continue;
    nearCrownArmy += Math.max(0, Number(board.army[at]) || 0);
  }
  return {
    crowns: crowns.length,
    cities: cities.length,
    buildings: crowns.length + cities.length,
    land: enemyLand,
    army: enemyArmy,
    crownGuard,
    crownGuardMax,
    nearCrownArmy,
    nearCrownShare: enemyArmy > 0 ? nearCrownArmy / enemyArmy : 0,
    ownLand,
    ownArmy,
    landRatio: ownLand > 0 ? enemyLand / ownLand : 0,
  };
}

function play(options, seedIndex, mapSize, seat, opponent) {
  const controller = createController(seat + 1, { mapMode: 'maze' });
  const policies = [null, null];
  const samples = [];
  policies[seat] = (state) => {
    const board = makeBoard(state, seat + 1);
    const turn = Number(board.turn);
    if (turn >= options.window[0] && turn <= options.window[1])
      samples.push({ turn, ...features(board, options.radius) });    return controller.choose(state);
  };
  if (opponent === 'anti') policies[1 - seat] = (state) => antiAction(state);
  else {
    const { createController: createApex } = require('../../apex-bot/bot/controller.cjs');
    const baseline = createApex(2 - seat);
    policies[1 - seat] = (state) => baseline.choose(state);
  }
  const seed = `${options.prefix}-${seedIndex}-maze`;
  const result = runMatch({
    mapMode: 'maze',
    seed,
    mapSize,
    maxTurns: options.turns,
    policies,
    decisionTimeoutMs: 80,
    traceLimit: 0,
  });
  const blitz = controller.stats().blitz;
  return {
    seed,
    mapSize,
    seat,
    opponent,
    ownWon: result.winner === seat,
    ended: result.ended,
    turns: result.turns,
    phase: blitz?.phase ?? null,
    launches: blitz?.launches ?? 0,
    peakWave: blitz?.peakWave ?? 0,
    samples,
  };
}

// One row per game: fixed checkpoints plus the in-window growth deltas.  A
// fixed window keeps the growth rate comparable when a game ends inside it.
const CHECK_POINTS = [40, 45, 50, 55, 60];

function summarize(row) {
  const at = new Map(row.samples.map((sample) => [sample.turn, sample]));
  const sample = (turn) => at.get(turn) || null;
  const first = sample(CHECK_POINTS[0]);
  const last = sample(CHECK_POINTS[CHECK_POINTS.length - 1]);
  if (!first || !last) return null;
  const mid = sample(50) || first;
  const out = {
    seed: row.seed,
    size: row.mapSize,
    seat: row.seat,
    opponent: row.opponent,
    result: row.ownWon ? 'W' : row.ended ? 'L' : 'D',
    turns: row.turns,
    launches: row.launches,
    peakWave: row.peakWave,
  };
  for (const turn of CHECK_POINTS) {
    const point = sample(turn);
    if (!point) continue;
    out[`land${turn}`] = point.land;
    out[`army${turn}`] = point.army;
    out[`crowns${turn}`] = point.crowns;
    out[`cities${turn}`] = point.cities;
    out[`guardMax${turn}`] = point.crownGuardMax;
    out[`nearShare${turn}`] = point.nearCrownShare;
    out[`landRatio${turn}`] = point.landRatio;
    out[`ownLand${turn}`] = point.ownLand;
  }
  out.landGrowth45_50 = (out.land50 ?? 0) - (out.land45 ?? 0);
  out.landGrowth50_55 = (out.land55 ?? 0) - (out.land50 ?? 0);
  out.landGrowth40_50 = (out.land50 ?? 0) - (out.land40 ?? 0);
  out.landGrowth45_55 = (out.land55 ?? 0) - (out.land45 ?? 0);
  out.crowns = mid.crowns;
  out.cities = mid.cities;
  out.buildings = mid.buildings;
  out.land = mid.land;
  out.army = mid.army;
  out.nearCrownShare = mid.nearCrownShare;
  out.nearCrownArmy = mid.nearCrownArmy;
  out.crownGuard = mid.crownGuard;
  out.crownGuardMax = mid.crownGuardMax;
  out.landRatio = mid.landRatio;
  out.ownLand = mid.ownLand;
  out.ownArmy = mid.ownArmy;
  return out;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

function describe(rows, key) {
  const values = rows.map((row) => row[key]).filter((value) => Number.isFinite(value));
  if (!values.length) return `${key}=n/a`;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return `${key} min=${percentile(values, 0)} p25=${percentile(values, 25)} med=${percentile(values, 50)} p75=${percentile(values, 75)} max=${percentile(values, 100)} mean=${mean.toFixed(2)}`;
}

function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log('node training/opponent-gate-report.cjs [--seeds N] [--sizes 0.34,0.68] [--opponent anti|apex|both]');
    return;
  }
  const opponents = options.opponent === 'both' ? ['anti', 'apex'] : [options.opponent];
  const seats = options.seat === 'both' ? [0, 1] : [Number(options.seat)];
  const rows = [];
  for (const opponent of opponents) {
    for (let index = options.offset; index < options.offset + options.seeds; index += 1) {
      for (const mapSize of options.sizes) {
        for (const seat of seats) {
          const game = play(options, index, mapSize, seat, opponent);
          const row = summarize(game);
          rows.push({ ...row, phase: game.phase });
          if (row) {
            console.log(
              `${opponent} ${row.seed} size=${row.size} seat=${row.seat} ${row.result} t${row.turns}`,
              `C${row.crowns} cities=${row.cities} land=${row.land}`,
              `g45_50=${row.landGrowth45_50} g50_55=${row.landGrowth50_55}`,
              `g40_50=${row.landGrowth40_50}`,
              `army=${row.army} share=${row.nearCrownShare.toFixed(2)} guardMax=${row.crownGuardMax}`,
              `landRatio=${row.landRatio.toFixed(2)} launches=${row.launches}`,
            );
          } else {
            console.log(`${opponent} ${game.seed} size=${game.mapSize} seat=${game.seat} no samples in window`);
          }
        }
      }
    }
  }
  const keys = [
    'crowns',
    'cities',
    'buildings',
    'land40',
    'land45',
    'land50',
    'land55',
    'landGrowth45_50',
    'landGrowth50_55',
    'landGrowth40_50',
    'landGrowth45_55',
    'army40',
    'army50',
    'army55',
    'nearCrownShare',
    'nearCrownArmy',
    'crownGuard',
    'crownGuardMax',
    'landRatio',
    'landRatio40',
    'ownLand',
    'ownArmy',
  ];
  for (const opponent of opponents) {
    const subset = rows.filter((row) => row && row.opponent === opponent);
    console.log(`\n== ${opponent} (${subset.length} games) ==`);
    for (const key of keys) console.log(describe(subset, key));
  }
  if (options.output) require('node:fs').writeFileSync(options.output, JSON.stringify(rows, null, 2));
}

main();
