'use strict';

// Merge the JSONL parts produced by batched
// bot-template/relay-bot/training/evaluate-matrix.cjs runs, then emit the final combined data
// and summary. Duplicate games are rejected so a part cannot be counted twice.
//
//   node bot-template/relay-bot/training/summarize.cjs /tmp/bot3-part-*.jsonl
//
// Without arguments, PARTS (comma separated) is used.
const fs = require('node:fs');
const path = require('node:path');
const {
  ROOT,
  seedIndex,
  sortRows,
  parseRows,
  modeOf,
  validate,
  summarize,
  printTable,
} = require('./matrix.cjs');

function inputs() {
  const args = process.argv.slice(2);
  if (args.length) return args.map((file) => path.resolve(ROOT, file));
  const parts = String(process.env.PARTS || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('pass JSONL files or set PARTS');
  return parts.map((file) => path.resolve(ROOT, file));
}

function main() {
  const files = inputs();
  const rows = [];
  const seen = new Set();
  for (const file of files) {
    const part = parseRows(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file));
    for (const row of part) {
      const key = [row.seed, row.opponent, row.map, Number(row.fog), Number(row.multi), row.seat].join('|');
      if (seen.has(key)) throw new Error(`duplicate game across parts: ${key}`);
      seen.add(key);
      rows.push(row);
    }
  }
  sortRows(rows);
  const opponents = [...new Set(rows.map((row) => row.opponent))];
  const maps = [...new Set(rows.map((row) => row.map))];
  const modes = [...new Set(rows.map(modeOf))].sort();
  if (!modes.length || modes.some((mode) => !/^0[01]{2}$/.test(mode)))
    throw new Error(`expected small-map fog/multi modes, found ${modes.join(',')}`);
  const seeds = [...new Set(rows.map((row) => row.seed))].sort((a, b) => seedIndex(a) - seedIndex(b));
  const perCell = seeds.length * 2;
  const ticks = Number(process.env.TICKS || 1000);
  if (!Number.isSafeInteger(ticks) || ticks <= 0) throw new Error('TICKS must be a positive integer');
  const options = {
    ticks,
    opponents,
    maps,
    modes,
    gamesPerCell: perCell,
    expectedRows: perCell * opponents.length * maps.length * modes.length,
    seedsLabel: process.env.SEEDS_LABEL || `${seeds[0]}..${seeds.at(-1)} (${seeds.length} seeds)`,
  };
  validate(rows, options);

  const out = path.resolve(ROOT, process.env.OUT || 'data/scratch/relay-results.jsonl');
  const summaryPath = path.resolve(ROOT, process.env.SUMMARY || 'data/scratch/relay-summary.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const summary = summarize(rows, options);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  printTable(summary);
  console.error(`[relay] merged ${files.length} parts into ${path.relative(ROOT, out)}`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
