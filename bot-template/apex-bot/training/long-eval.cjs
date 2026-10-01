'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { MAP_MODES, metricsSummary, createMetrics, mergeTiming } = require('./engine.cjs');

const ROOT = path.resolve(__dirname, '../../..');

function integer(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`expected integer in [${min}, ${max}]: ${value}`);
  return parsed;
}
function list(value, fallback) {
  return Array.isArray(value)
    ? value
    : String(value ?? fallback)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
}
function config(options = {}) {
  const env = process.env;
  const profile = String(options.profile ?? env.APEX_EVAL_PROFILE ?? 'standard');
  if (!['standard', 'large'].includes(profile)) throw new Error('profile must be standard or large');
  const defaultSizes = profile === 'large' ? '0.5,0.68,1' : '0.5';
  const sizes = list(
    options.sizes ?? options.mapSize ?? env.APEX_EVAL_SIZES ?? env.APEX_EVAL_SIZE,
    defaultSizes,
  ).map(Number);
  if (!sizes.length || sizes.some((size) => !Number.isFinite(size) || size < 0.2 || size > 3))
    throw new Error('map sizes must be in [0.2, 3]');
  const modes = list(options.modes ?? env.APEX_EVAL_MODES, MAP_MODES);
  if (!modes.length || modes.some((mode) => !MAP_MODES.includes(mode))) throw new Error('unknown map mode');
  const opponents = list(
    options.opponents ?? options.opponent ?? env.APEX_EVAL_OPPONENTS ?? env.APEX_EVAL_OPPONENT,
    'anti',
  );
  if (!opponents.length || opponents.some((opponent) => !['anti', 'simple'].includes(opponent)))
    throw new Error('opponents must be anti and/or simple');
  const fogOption = options.fog ?? env.APEX_EVAL_FOG ?? 'false';
  const fogs =
    fogOption === 'both'
      ? [false, true]
      : list(fogOption, 'false').map((item) => {
          if ([true, 'true', 1, '1'].includes(item)) return true;
          if ([false, 'false', 0, '0'].includes(item)) return false;
          throw new Error('fog must be true, false, or both');
        });
  const seats =
    options.seats ??
    (env.APEX_EVAL_SEAT === undefined ? [false, true] : [integer(env.APEX_EVAL_SEAT, 0, 0, 1) === 1]);
  if (!fogs.length) throw new Error('fog must be true, false, or both');
  if (!Array.isArray(seats) || !seats.length || seats.some((seat) => typeof seat !== 'boolean'))
    throw new Error('seats must be a nonempty array of booleans');
  return {
    profile,
    seeds: integer(options.seeds ?? env.APEX_EVAL_SEEDS, 8, 1, 10000),
    seedOffset: integer(options.seedOffset ?? env.APEX_EVAL_OFFSET, 0, 0, 10000000),
    seedPrefix: String(options.seedPrefix ?? env.APEX_EVAL_PREFIX ?? 'apex-long'),
    turns: integer(options.turns ?? env.APEX_EVAL_TURNS, 600, 1, 100000),
    workers: integer(
      options.workers ?? env.APEX_EVAL_WORKERS,
      Math.max(1, Math.min(8, (os.availableParallelism?.() || 4) - 1)),
      1,
      32,
    ),
    traceLimit: integer(options.traceLimit ?? env.APEX_EVAL_TRACE, 120, 0, 5000),
    failureLimit: integer(options.failureLimit ?? env.APEX_EVAL_FAILURES, 12, 0, 1000),
    decisionTimeoutMs: integer(options.decisionTimeoutMs ?? env.APEX_EVAL_DECISION_MS, 40, 1, 10000),
    jobTimeoutMs: integer(options.jobTimeoutMs ?? env.APEX_EVAL_JOB_MS, 300000, 100, 3600000),
    sizes,
    modes,
    opponents,
    fogs,
    seats,
    quiet: options.quiet ?? env.APEX_EVAL_QUIET === '1',
  };
}
function makeJobs(options) {
  const jobs = [];
  for (let offset = 0; offset < options.seeds; offset += 1) {
    for (const mode of options.modes)
      for (const mapSize of options.sizes) {
        for (const opponent of options.opponents)
          for (const fog of options.fogs)
            for (const swap of options.seats) {
              jobs.push({
                mode,
                mapSize,
                opponent,
                fog,
                swap,
                seed: `${options.seedPrefix}-${options.seedOffset + offset}-${mode}`,
                turns: options.turns,
                traceLimit: options.traceLimit,
                decisionTimeoutMs: options.decisionTimeoutMs,
              });
            }
      }
  }
  return jobs;
}
function developmentSummary(rows) {
  const checkpoints = [120, 300, 600, 900, 1200];
  const at = {};
  for (const checkpoint of checkpoints) {
    const samples = rows
      .map((row) => ({
        own: row.telemetry?.own?.[checkpoint],
        opponent: row.telemetry?.opponent?.[checkpoint],
      }))
      .filter((sample) => sample.own);
    if (!samples.length) continue;
    const paired = samples.filter((sample) => sample.opponent);
    const ratio = (key) => {
      const values = paired
        .map((sample) => {
          const denominator = Number(sample.opponent[key]);
          return denominator > 0 ? Number(sample.own[key]) / denominator : null;
        })
        .filter(Number.isFinite);
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    at[checkpoint] = {
      samples: samples.length,
      coverage: samples.length / rows.length,
      pairedSamples: paired.length,
      meanCrowns: samples.reduce((sum, sample) => sum + sample.own.crowns, 0) / samples.length,
      meanCities: samples.reduce((sum, sample) => sum + sample.own.cities, 0) / samples.length,
      meanArmy: samples.reduce((sum, sample) => sum + sample.own.army, 0) / samples.length,
      meanLand: samples.reduce((sum, sample) => sum + sample.own.land, 0) / samples.length,
      meanBuilds: samples.reduce((sum, sample) => sum + (sample.own.builds || 0), 0) / samples.length,
      meanUpgrades: samples.reduce((sum, sample) => sum + (sample.own.upgrades || 0), 0) / samples.length,
      meanAttacks: samples.reduce((sum, sample) => sum + (sample.own.attacks || 0), 0) / samples.length,
      alive: samples.filter((sample) => sample.own.crowns > 0).length,
      aliveRate: samples.filter((sample) => sample.own.crowns > 0).length / rows.length,
      armyRatio: ratio('army'),
      landRatio: ratio('land'),
      crownRatio: ratio('crowns'),
      cityDelta: paired.length
        ? paired.reduce((sum, sample) => sum + sample.own.cities - sample.opponent.cities, 0) / paired.length
        : null,
      armyAheadRate: paired.length
        ? paired.filter((sample) => sample.own.army >= sample.opponent.army).length / paired.length
        : null,
    };
  }
  const maxCrowns = rows.map((row) => row.telemetry?.maxCrowns).filter(Number.isFinite);
  const maxCities = rows.map((row) => row.telemetry?.maxCities).filter(Number.isFinite);
  return {
    checkpoints: at,
    meanMaxCrowns: maxCrowns.length ? maxCrowns.reduce((a, b) => a + b, 0) / maxCrowns.length : null,
    meanMaxCities: maxCities.length ? maxCities.reduce((a, b) => a + b, 0) / maxCities.length : null,
  };
}

function aggregate(rows) {
  const completed = rows.filter((row) => !row.error);
  const wins = completed.filter((row) => row.ownWon);
  const winTurns = wins.map((row) => row.turns).sort((a, b) => a - b);
  return {
    matches: rows.length,
    wins: wins.length,
    losses: completed.filter((row) => row.ended && !row.ownWon).length,
    draws: completed.filter((row) => !row.ended).length,
    errors: rows.length - completed.length,
    hardTimeouts: rows.filter((row) => row.hardTimeout).length,
    winRate: rows.length ? wins.length / rows.length : 0,
    meanWinTurns: winTurns.length ? winTurns.reduce((a, b) => a + b, 0) / winTurns.length : null,
    maxWinTurns: winTurns.at(-1) ?? null,
    within120: wins.filter((row) => row.turns <= 120).length,
    within600: wins.filter((row) => row.turns <= 600).length,
    largeMap: rows.length > 0 && rows.every((row) => Number(row.mapSize) >= 0.68),
    elapsedMs: rows.reduce((total, row) => total + (row.elapsedMs || 0), 0),
    development: developmentSummary(rows),
  };
}
function group(rows, key) {
  const keys = [...new Set(rows.map((row) => String(row[key])))];
  return Object.fromEntries(
    keys.map((value) => [value, aggregate(rows.filter((row) => String(row[key]) === value))]),
  );
}

function sourceFingerprint() {
  const roots = [
    'src',
    'bot-template/apex-bot/bot',
    'bot-template/apex-bot/training',
    'bot-template/apex-bot/strategy.js',
    'bot-template/anti-human-bot/bot',
    'bot-template/simple-strategy-bot/strategy.js',
    'bot-template/simple-strategy-bot/bot',
    'package.json',
    'pnpm-lock.yaml',
    'bot-template/apex-bot/package.json',
    'bot-template/apex-bot/pnpm-lock.yaml',
  ];
  const files = [];
  const visit = (relative) => {
    const filename = path.join(ROOT, relative);
    if (!fs.existsSync(filename)) return;
    if (fs.statSync(filename).isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) visit(`${relative}/${name}`);
    } else if (/\.(?:ts|js|cjs|json|yaml)$/.test(relative)) {
      files.push({
        path: relative,
        sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
      });
    }
  };
  roots.forEach(visit);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return {
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    gitHead: git(['rev-parse', 'HEAD']),
    gitStatus: git(['status', '--porcelain', '--untracked-files=normal']),
    files,
  };
}

async function evaluate(options = {}) {
  const settings = config(options);
  const jobs = makeJobs(settings);
  const source = sourceFingerprint();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const results = [];
  const slots = [];
  let nextJob = 0;
  let failureCount = 0;
  const metricRows = { own: createMetrics(), opponent: createMetrics() };
  function collect(result) {
    for (const [key, seat] of [
      ['own', result.ownSeat],
      ['opponent', 1 - result.ownSeat],
    ]) {
      if (!result.metrics?.[key]) continue;
      const dst = metricRows[key];
      const src = result.metrics[key];
      mergeTiming(dst.timing, result.decisionHistograms?.[seat]);
      dst.decisions += src.decisions;
      dst.rejected += src.rejections;
      dst.timeouts += src.timeouts;
      dst.emitted += src.emitted;
    }
    delete result.decisionHistograms;
    if (result.failureTrace && failureCount++ < settings.failureLimit) {
      if (result.replay) result.replay.sourceSha256 = source.sha256;
    } else {
      delete result.failureTrace;
      delete result.replay;
    }
    results.push(result);
    if (!settings.quiet) {
      process.stderr.write(
        `${JSON.stringify({
          completed: results.length,
          total: jobs.length,
          mode: result.mode,
          opponent: result.opponent,
          mapSize: result.mapSize,
          fog: result.fog,
          swap: result.swap,
          seed: result.seed,
          ownWon: result.ownWon,
          ended: result.ended,
          turns: result.turns,
          error: result.error,
          elapsedMs: Math.round(result.elapsedMs || 0),
        })}\n`,
      );
    }
  }
  await new Promise((resolve, reject) => {
    let stopping = false;
    const stopAll = async () => {
      stopping = true;
      for (const slot of slots) if (slot.timer) clearTimeout(slot.timer);
      await Promise.all(slots.map((slot) => slot.worker?.terminate()));
    };
    const done = () => {
      if (results.length === jobs.length) stopAll().then(resolve, reject);
    };
    const launch = (slot) => {
      if (stopping) return;
      const job = jobs[nextJob++];
      if (!job) {
        done();
        return;
      }
      slot.job = job;
      slot.timer = setTimeout(() => {
        slot.job = null;
        collect({
          ...job,
          error: `match exceeded ${settings.jobTimeoutMs} ms`,
          hardTimeout: true,
          ownWon: false,
          ended: false,
        });
        const old = slot.worker;
        slot.worker = null;
        old.terminate().then(() => {
          if (!stopping) {
            startWorker(slot);
            done();
          }
        });
      }, settings.jobTimeoutMs);
      slot.worker.postMessage(job);
    };
    const startWorker = (slot) => {
      if (stopping) return;
      const worker = new Worker(path.join(__dirname, 'worker.cjs'));
      slot.worker = worker;
      worker.on('message', (message) => {
        if (stopping || slot.worker !== worker || !slot.job) return;
        clearTimeout(slot.timer);
        const job = slot.job;
        slot.job = null;
        collect(message.ok ? message.result : { ...job, error: message.error, ownWon: false, ended: false });
        launch(slot);
        done();
      });
      worker.on('error', (error) => {
        if (stopping || slot.worker !== worker) return;
        clearTimeout(slot.timer);
        const job = slot.job;
        slot.job = null;
        if (job) collect({ ...job, error: error.stack || String(error), ownWon: false, ended: false });
        worker.terminate().then(() => {
          if (!stopping) {
            startWorker(slot);
            done();
          }
        });
      });
      launch(slot);
    };
    for (let i = 0; i < Math.min(settings.workers, jobs.length); i += 1) {
      const slot = { worker: null, job: null, timer: null };
      slots.push(slot);
      startWorker(slot);
    }
  });
  results.sort(
    (a, b) =>
      a.seed.localeCompare(b.seed) ||
      a.mapSize - b.mapSize ||
      a.opponent.localeCompare(b.opponent) ||
      Number(a.fog) - Number(b.fog) ||
      Number(a.swap) - Number(b.swap),
  );
  const sourceAtEnd = sourceFingerprint();
  return {
    schemaVersion: 3,
    startedAt,
    finishedAt: new Date().toISOString(),
    wallMs: performance.now() - started,
    settings,
    source,
    sourceAtEndSha256: sourceAtEnd.sha256,
    sourceUnchangedDuringEvaluation: source.sha256 === sourceAtEnd.sha256,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      parallelism: os.availableParallelism?.() || os.cpus().length,
      esbuild: require('esbuild/package.json').version,
    },
    tickUnit: 'server tick (two ticks per displayed game turn)',
    ...aggregate(results),
    decision: { own: metricsSummary(metricRows.own), opponent: metricsSummary(metricRows.opponent) },
    byMode: group(results, 'mode'),
    byOpponent: group(results, 'opponent'),
    bySize: group(results, 'mapSize'),
    byFog: group(results, 'fog'),
    byScale: {
      standard: aggregate(results.filter((row) => Number(row.mapSize) < 0.68)),
      large: aggregate(results.filter((row) => Number(row.mapSize) >= 0.68)),
    },
    results,
  };
}

const CLI_FIELDS = {
  seeds: 'seeds',
  offset: 'seedOffset',
  prefix: 'seedPrefix',
  turns: 'turns',
  workers: 'workers',
  sizes: 'sizes',
  profile: 'profile',
  modes: 'modes',
  opponents: 'opponents',
  fog: 'fog',
  trace: 'traceLimit',
  failures: 'failureLimit',
  'decision-ms': 'decisionTimeoutMs',
  'job-ms': 'jobTimeoutMs',
};

function parseCli(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      ...Object.fromEntries(Object.keys(CLI_FIELDS).map((name) => [name, { type: 'string' }])),
      seat: { type: 'string' },
      output: { type: 'string', short: 'o' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const options = {};
  for (const [flag, key] of Object.entries(CLI_FIELDS)) {
    if (values[flag] !== undefined) options[key] = values[flag];
  }
  if (values.quiet !== undefined) options.quiet = values.quiet;
  if (values.seat !== undefined) {
    if (!['0', '1', 'both'].includes(values.seat)) throw new Error('--seat must be 0, 1, or both');
    options.seats = values.seat === 'both' ? [false, true] : [values.seat === '1'];
  }
  return { help: Boolean(values.help), output: values.output, options };
}

function cliHelp(defaults = {}) {
  const seedDefault = defaults.seeds ?? 8;
  return `Usage: node bot-template/apex-bot/training/long-eval.cjs [options]

Run deterministic map seeds against the real server engine in worker threads.
All turn limits and results count server ticks (2 ticks = 1 displayed game turn).
CLI values override APEX_EVAL_* environment variables.

  --seeds N          Seeds per map (default ${seedDefault}; APEX_EVAL_SEEDS)
  --offset N         First seed index (APEX_EVAL_OFFSET)
  --prefix TEXT      Seed namespace (APEX_EVAL_PREFIX)
  --turns N          Maximum server ticks per match (default 600; APEX_EVAL_TURNS)
  --workers N        Worker count, 1..32 (default up to 8; APEX_EVAL_WORKERS)
  --modes CSV        random,maze,archipelago,mediterranean (APEX_EVAL_MODES)
  --sizes CSV        Map size ratios, 0.2..3 (default 0.5; APEX_EVAL_SIZES)
  --profile NAME     standard (0.5) or large (0.5,0.68,1) size suite
  --opponents CSV    anti,simple (default anti; APEX_EVAL_OPPONENTS)
  --fog VALUE        false, true, or both (default false; APEX_EVAL_FOG)
  --seat VALUE       Apex seat: 0, 1, or both (default both; APEX_EVAL_SEAT=0|1)
  --trace N          Recent tick records per retained failure; 0 disables replay
                     (default 120; APEX_EVAL_TRACE)
  --failures N       Maximum retained failure traces/replays (APEX_EVAL_FAILURES)
  --decision-ms N    Count decisions above this wall time (default 40; APEX_EVAL_DECISION_MS)
  --job-ms N         Terminate a match above this wall time (default 300000; APEX_EVAL_JOB_MS)
  -o, --output FILE  Also write the JSON report to FILE (APEX_EVAL_OUTPUT)
  -q, --quiet        Suppress per-match stderr progress (APEX_EVAL_QUIET=1)
  -h, --help         Print this help and exit without starting workers

Example:
  node bot-template/apex-bot/training/long-eval.cjs --seeds 32 --workers 8 --opponents anti,simple --output /tmp/apex-eval.json
`;
}

async function runCli(args = process.argv.slice(2), defaults = {}) {
  const parsed = parseCli(args);
  if (parsed.help) {
    process.stdout.write(cliHelp(defaults));
    return 0;
  }
  const summary = await evaluate({ ...defaults, ...parsed.options });
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  const output = parsed.output ?? process.env.APEX_EVAL_OUTPUT;
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, json);
  }
  process.stdout.write(json);
  return summary.errors ? 1 : 0;
}

if (require.main === module) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}
module.exports = { evaluate, makeJobs, config, aggregate, sourceFingerprint, parseCli, cliHelp, runCli };
