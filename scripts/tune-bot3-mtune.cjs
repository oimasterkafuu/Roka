'use strict';

// Round-17 self-play tuning harness for the Bot(3.0) multi-line evaluation.
//
//   node scripts/tune-bot3-mtune.cjs eval   --weights '{"capture":10}' --from 1 --to 8
//   node scripts/tune-bot3-mtune.cjs pass   --stage screen
//   node scripts/tune-bot3-mtune.cjs pass   --stage coarse --knobs capture,merge
//   node scripts/tune-bot3-mtune.cjs report
//
// Every evaluation is a set of independent seed shards (`scripts/evaluate-bot3.cjs`,
// the same entry the acceptance matrix uses), so the numbers are the real engine,
// not a model of it. The fitness is wins over the requested block; ties are broken
// by the mean land+army margin at t150, which is what separates two configs that
// differ by nothing more than a tempo flip on a game that would end anyway.
//
// The search is coordinate descent over the weight blob in `./mtune`, run in
// foreground passes with a finite game budget. Every evaluation is appended to
// `data/scratch/tune-log.jsonl` and reused by its content hash, so a pass can be
// interrupted and resumed, and a later pass never pays for the same config twice.
//
// Train on seeds 1-8, select on 9-16, confirm on 17-32 (never tuned on). The
// script itself never looks at 9-32 unless asked to with --from/--to.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = path.join(ROOT, 'data/scratch');
const LOG = path.join(SCRATCH, 'tune-log.jsonl');
const BEST = path.join(SCRATCH, 'tune-best.json');
const ENTRY = path.join(ROOT, 'scripts/evaluate-bot3.cjs');
const MAPS = 'random,maze,archipelago,mediterranean';
// The eight relay multi cells the acceptance target is written on, both seats.
const MODES = '001,011';
const OPPONENTS = 'relay';
const CHECKPOINTS = '50,100,150,250';

const { BASE_WEIGHTS, WEIGHT_BOUNDS, WEIGHT_KEYS } = require('../bot-template/bot-3.0/mtune');

// Coarse-to-fine grids. `screen` only probes the two directions of every knob
// from the current best; `coarse`/`fine` are the coordinate sweep values.
const GRIDS = {
  screen: {
    capture: [-10, 10],
    hostile: [-15, 20],
    ring: [5, 10],
    cut: [3, 8],
    pulse: [20, 40],
    merge: [-15, 15],
    march: [15, 30],
    reload: [40, 90],
    hop: [3, 10],
    retain: [1, 2],
    floor: [3, 5],
    minFire: [2, 5],
    cheap: [10, 30],
    water: [15, 30],
    corridor: [0, 1],
    start: [30, 60],
    end: [120, 250],
    slots: [32, 64],
    lead: [100, 130],
    steal: [50, 200],
  },
  // Knobs whose price is saturated by the unlimited order cap (the planner),
  // or whose candidate band is empty in a multi room, are kept in the blob but
  // measured separately in the notes (`lateral`, `defence`, `cut`).
  coarse: {
    capture: [-20, -10, 0, 10, 20],
    hostile: [-15, 0, 15, 30],
    ring: [0, 4, 8, 12],
    cut: [0, 3, 6],
    pulse: [0, 20, 40, 60],
    merge: [-30, -15, 0, 15],
    march: [0, 15, 30, 50],
    reload: [20, 40, 60, 90, 120],
    hop: [0, 3, 6, 10],
    retain: [0, 1, 2],
    floor: [2, 3, 4],
    minFire: [2, 3, 4],
    cheap: [0, 10, 20, 40],
    water: [0, 15, 30],
    corridor: [0, 1],
    start: [0, 30, 50],
    end: [0, 150, 250],
    slots: [16, 32, 64],
    lead: [90, 110, 130, 200],
    steal: [0, 50, 100, 200],
  },
  fine: {
    capture: [-15, -10, -5, 0, 5, 10, 15],
    hostile: [-20, -10, 0, 10, 20, 30],
    ring: [0, 2, 4, 6, 8, 10],
    cut: [0, 1, 2, 4, 6],
    pulse: [0, 10, 20, 30, 40],
    merge: [-20, -10, -5, 0, 5, 10],
    march: [0, 8, 15, 22, 30],
    reload: [30, 45, 60, 75, 90],
    hop: [0, 2, 4, 6, 8],
    retain: [0, 1, 2],
    floor: [2, 3, 4, 5],
    minFire: [2, 3, 4, 5],
    cheap: [0, 5, 10, 20],
    water: [0, 8, 15, 25],
    corridor: [0, 1],
    start: [0, 20, 40],
    end: [0, 100, 150, 200],
    slots: [32, 48, 64],
    lead: [95, 110, 125, 140],
    steal: [50, 75, 100, 150],
  },
};

function parseArgs(argv) {
  const args = { mode: argv[0] || 'report' };
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument "${token}"`);
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function integer(value, fallback, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`expected an integer in [${min}, ${max}], received "${value}"`);
  return parsed;
}

function weightsArg(raw) {
  if (raw === undefined) return { ...BASE_WEIGHTS };
  const inline = String(raw).trim();
  const text = inline.startsWith('{') ? inline : fs.readFileSync(path.resolve(raw), 'utf8');
  const parsed = JSON.parse(text);
  return { ...BASE_WEIGHTS, ...parsed };
}

function normalize(weights) {
  const out = {};
  for (const key of WEIGHT_KEYS) {
    const [min, max] = WEIGHT_BOUNDS[key];
    const value = Number(weights[key]);
    out[key] = Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.round(value * 1000) / 1000))
      : BASE_WEIGHTS[key];
  }
  return out;
}

function configKey(weights, from, to) {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({ w: normalize(weights), from, to, maps: MAPS, modes: MODES, opponents: OPPONENTS }),
  );
  return hash.digest('hex').slice(0, 16);
}

function loadLog() {
  const entries = new Map();
  if (!fs.existsSync(LOG)) return entries;
  for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.key) entries.set(entry.key, entry);
    } catch {
      /* a torn line from an interrupted pass is simply skipped */
    }
  }
  return entries;
}

function appendLog(entry) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
}

// Leaderboard checkpoint of one seat, or null when the game ended before it.
function checkpoint(row, seat, wanted) {
  const points = row.checkpoints || {};
  for (const tick of wanted) {
    const point = points[String(tick)];
    if (!point) continue;
    const self = point[seat];
    const rival = point[1 - seat];
    if (!self || !rival) continue;
    return { tick, self: self[0] + self[1], rival: rival[0] + rival[1] };
  }
  return null;
}

function summarise(rows, weights, from, to) {
  const games = rows.length;
  const win = rows.filter((row) => row.result === 'win').length;
  const loss = rows.filter((row) => row.result === 'loss').length;
  const timeout = rows.filter((row) => row.result === 'timeout').length;
  const margins = [];
  for (const row of rows) {
    const point = checkpoint(row, row.seat, [150, 100, 50]);
    margins.push(point ? point.self - point.rival : 0);
  }
  const cells = {};
  for (const row of rows) {
    const id = `${row.map}|${row.fog ? 1 : 0}`;
    cells[id] ??= { win: 0, games: 0 };
    cells[id].games += 1;
    if (row.result === 'win') cells[id].win += 1;
  }
  // The acceptance target is per cell, so a config that trades one cell for
  // three is not an improvement even when the total is higher.
  const worst = Math.min(...Object.values(cells).map((cell) => cell.win / Math.max(1, cell.games)));
  return {
    key: configKey(weights, from, to),
    weights: normalize(weights),
    from,
    to,
    games,
    win,
    loss,
    timeout,
    worst: Number(worst.toFixed(4)),
    margin: margins.length ? Number((margins.reduce((a, b) => a + b, 0) / margins.length).toFixed(2)) : 0,
    cells,
    ts: new Date().toISOString(),
  };
}

function runSeed(seed, weights) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      SEEDS: seed,
      TICKS: '1000',
      OPPONENTS,
      MAPS,
      MODES,
      CHECKPOINTS,
      RELAY_ENTRY: '../bot-template/bot-3.0/strategy',
      SELF_ID: 'bot3',
      BOT3_MTUNE: '1',
      BOT3_MTUNE_JSON: JSON.stringify(normalize(weights)),
    };
    const child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`seed ${seed} failed (exit ${code}): ${stderr.slice(-1500)}`));
      const rows = [];
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('{')) continue;
        rows.push(JSON.parse(line));
      }
      resolve(rows);
    });
  });
}

// Evaluate one weight blob over a seed block. Shards run in parallel but the
// call stays in the foreground and resolves only when every shard finished.
async function evaluate(weights, from, to, options = {}) {
  const known = options.log ?? loadLog();
  const key = configKey(weights, from, to);
  const hit = known.get(key);
  if (hit && !options.force) return hit;
  const seeds = [];
  for (let index = from; index <= to; index++) seeds.push(`bot3-baseline-${index}`);
  const par = options.par ?? 8;
  const rows = [];
  let cursor = 0;
  async function worker() {
    while (cursor < seeds.length) {
      const seed = seeds[cursor++];
      rows.push(...(await runSeed(seed, weights)));
    }
  }
  await Promise.all(Array.from({ length: Math.min(par, seeds.length) }, worker));
  const summary = summarise(rows, weights, from, to);
  summary.label = options.label ?? null;
  appendLog(summary);
  known.set(summary.key, summary);
  return summary;
}

function show(summary, tag = '') {
  const rate = (100 * summary.win) / Math.max(1, summary.games);
  const cells = Object.entries(summary.cells)
    .map(([id, cell]) => `${id} ${cell.win}/${cell.games}`)
    .join('  ');
  console.log(
    `${tag}W ${summary.win}/${summary.games} (${rate.toFixed(1)}%)  ` +
      `L ${summary.loss} T ${summary.timeout}  worst ${(100 * (summary.worst ?? 0)).toFixed(1)}%  ` +
      `margin ${summary.margin >= 0 ? '+' : ''}${summary.margin}  ${cells}`,
  );
}

function readBest() {
  if (!fs.existsSync(BEST)) return { weights: { ...BASE_WEIGHTS }, win: null };
  return JSON.parse(fs.readFileSync(BEST, 'utf8'));
}

function writeBest(weights, summary, stage) {
  fs.writeFileSync(
    BEST,
    JSON.stringify(
      {
        stage,
        weights: normalize(weights),
        win: summary.win,
        games: summary.games,
        margin: summary.margin,
        key: summary.key,
        ts: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
}

// Minimum gain an adopted step has to clear: one game in 128 is inside the
// tempo noise of a deterministic mirror, so a coordinate only moves on two.
const ADOPT = 2;

function improve(before, candidate) {
  if (candidate.win !== before.win) return candidate.win > before.win;
  if (candidate.worst !== before.worst) return candidate.worst > before.worst;
  return candidate.margin > before.margin;
}

async function pass(args) {
  const stage = String(args.stage || 'screen');
  const grid = GRIDS[stage];
  if (!grid) throw new Error(`unknown stage "${stage}" (use ${Object.keys(GRIDS).join(', ')})`);
  const knobs = args.knobs
    ? String(args.knobs)
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
    : Object.keys(grid);
  for (const knob of knobs) if (!Object.hasOwn(grid, knob)) throw new Error(`no grid for knob "${knob}"`);
  const from = integer(args.from, 1, 1, 1000);
  const to = integer(args.to, 8, 1, 1000);
  const par = integer(args.par, 8, 1, 32);
  const lanes = integer(args.lanes, 3, 1, 8);
  const cycles = integer(args.cycles, args.stage === 'fine' ? 2 : 1, 1, 10);
  const verbose = args.quiet !== true;
  const log = loadLog();
  const start = args.start ? weightsArg(args.start) : readBest().weights;
  const base = await evaluate(start, from, to, { log, par, label: `${stage}:start` });
  if (verbose) show(base, `${stage} start  `);
  let best = { weights: normalize(start), summary: base };

  for (let cycle = 1; cycle <= cycles; cycle++) {
    let moved = false;
    for (const knob of knobs) {
      const values = grid[knob].filter((value) => value !== best.weights[knob]);
      const trials = values.map((value) => ({ ...best.weights, [knob]: value }));
      const results = [];
      let cursor = 0;
      async function lane() {
        while (cursor < trials.length) {
          const index = cursor++;
          const weights = trials[index];
          results[index] = await evaluate(weights, from, to, {
            log,
            par,
            label: `${stage}:c${cycle}:${knob}=${weights[knob]}`,
          });
        }
      }
      await Promise.all(Array.from({ length: Math.min(lanes, trials.length) }, lane));
      let winner = best;
      for (const [index, result] of results.entries()) {
        if (verbose) show(result, `  ${knob}=${trials[index][knob]}\t`);
        if (improve(winner.summary, result) && result.win - best.summary.win >= ADOPT)
          winner = { weights: normalize(trials[index]), summary: result };
      }
      if (winner !== best) {
        if (verbose)
          show(winner.summary, `  ADOPT ${knob}=${winner.weights[knob]}  `);
        best = winner;
        moved = true;
        writeBest(best.weights, best.summary, `${stage}:c${cycle}`);
      }
    }
    if (!moved) break;
  }
  if (verbose) {
    console.log('');
    show(best.summary, `${stage} best   `);
    console.log(JSON.stringify(best.weights));
  }
  writeBest(best.weights, best.summary, stage);
  return best;
}

// Joint re-pricing search: coordinate descent on one knob at a time cannot
// reach a config that is only better as a set (the whole point of round 17),
// so a random-restart pass moves several knobs at once, drawn from the fine
// grid, and adopts the best block that clears `ADOPT`.
async function random(args) {
  const count = integer(args.count, 24, 1, 400);
  const from = integer(args.from, 1, 1, 1000);
  const to = integer(args.to, 8, 1, 1000);
  const par = integer(args.par, 6, 1, 32);
  const lanes = integer(args.lanes, 3, 1, 8);
  const picks = integer(args.picks, 3, 1, 14);
  const seed = integer(args.seed, 17, 1, 1e9);
  const log = loadLog();
  const start = args.start ? weightsArg(args.start) : readBest().weights;
  const base = await evaluate(start, from, to, { log, par, label: 'random:start' });
  show(base, 'random start  ');
  let best = { weights: normalize(start), summary: base };
  // Deterministic LCG so a restart block can be reproduced from its seed.
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const knobs = args.knobs
    ? String(args.knobs)
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
    : Object.keys(GRIDS.fine);
  const trials = [];
  for (let index = 0; index < count; index++) {
    const weights = { ...best.weights };
    const touched = new Set();
    const target = 1 + Math.floor(next() * picks);
    while (touched.size < target) {
      const knob = knobs[Math.floor(next() * knobs.length)];
      if (touched.has(knob)) continue;
      touched.add(knob);
      const values = GRIDS.fine[knob];
      weights[knob] = values[Math.floor(next() * values.length)];
    }
    trials.push(weights);
  }
  let cursor = 0;
  const results = [];
  async function lane() {
    while (cursor < trials.length) {
      const index = cursor++;
      results[index] = await evaluate(trials[index], from, to, {
        log,
        par,
        label: `random:${seed}:${index}`,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(lanes, trials.length) }, lane));
  for (const [index, result] of results.entries()) {
    show(result, `  #${index}\t`);
    if (improve(best.summary, result) && result.win - best.summary.win >= ADOPT) {
      best = { weights: normalize(trials[index]), summary: result };
      show(result, `  ADOPT #${index}\t`);
    }
  }
  console.log('');
  show(best.summary, 'random best   ');
  console.log(JSON.stringify(best.weights));
  writeBest(best.weights, best.summary, `random:${seed}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'eval') {
    const weights = weightsArg(args.weights);
    const from = integer(args.from, 1, 1, 1000);
    const to = integer(args.to, 8, 1, 1000);
    const summary = await evaluate(weights, from, to, {
      par: integer(args.par, 8, 1, 32),
      force: args.force === true,
      label: args.label ? String(args.label) : 'eval',
    });
    show(summary, `${args.label ? args.label + ' ' : ''}seeds ${from}-${to}  `);
    if (args.json) console.log(JSON.stringify(summary));
    return;
  }
  if (args.mode === 'pass') {
    await pass(args);
    return;
  }
  if (args.mode === 'random') {
    await random(args);
    return;
  }
  if (args.mode === 'report') {
    const log = loadLog();
    const entries = [...log.values()].filter((entry) => entry.from === 1 && entry.to === 8);
    entries.sort((a, b) => b.win - a.win || b.margin - a.margin);
    console.log(`| wins | games | margin | label | key |`);
    console.log(`| ---: | ---: | ---: | --- | --- |`);
    for (const entry of entries.slice(0, integer(args.top, 25, 1, 500)))
      console.log(
        `| ${entry.win} | ${entry.games} | ${entry.margin >= 0 ? '+' : ''}${entry.margin} | ` +
          `${entry.label ?? ''} | ${entry.key} |`,
      );
    console.log('');
    console.log(`${entries.length} train-block evaluations in ${path.relative(ROOT, LOG)}`);
    const best = readBest();
    if (best.weights) console.log(`best ${JSON.stringify(best.weights)}`);
    return;
  }
  throw new Error(`unknown mode "${args.mode}"`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
