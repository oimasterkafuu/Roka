'use strict';

// Batch runner for the Bot(3.0) 1v1 acceptance matrix.
//
// Each seed shard is a separate Node process so the real engine and the mock
// clock stay isolated. Shards run in parallel, but this command stays in the
// foreground: it exits only after every shard in the requested range finished.
//
//   SEED_FROM=1 SEED_TO=4 WORKERS=4 node bot-template/relay-bot/training/evaluate-matrix.cjs
//
// Output is written under data/scratch by default. Use OUT and SUMMARY
// to keep per-batch files instead; bot-template/relay-bot/training/summarize.cjs can then
// merge them.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, sortRows, parseRows, validate, summarize, printTable } = require('./matrix.cjs');

const ENTRY = path.join(__dirname, 'evaluate.cjs');

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return value;
}
function list(name, fallback) {
  return String(process.env[name] ?? fallback)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function runShard(seed, options) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      SEEDS: seed,
      TICKS: String(options.ticks),
      OPPONENTS: options.opponents.join(','),
      MAPS: options.maps.join(','),
      MODES: options.modes.join(','),
    };
    const child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0)
        return reject(
          new Error(`seed ${seed} failed (exit ${code})\n${stderr.trim() || stdout.slice(-2000)}`),
        );
      let rows;
      try {
        rows = parseRows(stdout, `seed ${seed}`);
      } catch (error) {
        return reject(error);
      }
      console.error(
        `[relay] seed ${seed}: ${rows.length} games in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      resolve(rows);
    });
  });
}

async function main() {
  const options = {
    from: integer('SEED_FROM', 1, 1, 100000),
    to: integer('SEED_TO', 16, 1, 100000),
    prefix: process.env.SEED_PREFIX || 'bot3-baseline',
    workers: integer('WORKERS', Math.min(8, require('node:os').availableParallelism?.() || 4), 1, 32),
    ticks: integer('TICKS', 1000, 1, 100000),
    opponents: list('OPPONENTS', 'apex,anti,v2,relay'),
    maps: list('MAPS', 'random,maze,archipelago,mediterranean'),
    modes: list('MODES', '000,001,010,011'),
    out: path.resolve(ROOT, process.env.OUT || 'data/scratch/relay-results.jsonl'),
    summary: path.resolve(ROOT, process.env.SUMMARY || 'data/scratch/relay-summary.json'),
  };
  if (options.to < options.from) throw new Error('SEED_TO must be >= SEED_FROM');
  for (const mode of options.modes)
    if (!/^0[01]{2}$/.test(mode))
      throw new Error(`MODES expects 0/fog/multi bits for the small-map matrix: ${mode}`);

  const seeds = [];
  for (let index = options.from; index <= options.to; index += 1) seeds.push(`${options.prefix}-${index}`);
  const reportOptions = {
    ...options,
    seedsLabel: `${options.prefix}-${options.from}..${options.to}`,
    gamesPerCell: seeds.length * 2,
    expectedRows: seeds.length * 2 * options.opponents.length * options.maps.length * options.modes.length,
  };

  console.error(
    `[relay] batch seeds=${seeds.length} workers=${options.workers} ticks=${options.ticks} ` +
      `expected=${reportOptions.expectedRows} games`,
  );
  const rows = [];
  let cursor = 0;
  async function worker() {
    while (cursor < seeds.length) {
      const seed = seeds[cursor++];
      rows.push(...(await runShard(seed, options)));
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.workers, seeds.length) }, worker));

  sortRows(rows);
  validate(rows, reportOptions);
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const summary = summarize(rows, reportOptions);
  fs.mkdirSync(path.dirname(options.summary), { recursive: true });
  fs.writeFileSync(options.summary, JSON.stringify(summary, null, 2) + '\n');
  printTable(summary);
  console.error(
    `[relay] wrote ${path.relative(ROOT, options.out)} and ${path.relative(ROOT, options.summary)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
