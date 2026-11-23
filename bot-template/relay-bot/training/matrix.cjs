'use strict';

// Shared reporting helpers for the Bot(3.0) acceptance matrix. Kept separate
// so batched runs and the final merge produce identical summaries.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { BASELINE_COMMIT } = require('../../apex-bot/training/historical.cjs');

const ROOT = path.resolve(__dirname, '../../..');
const BOT_DIR = path.resolve(__dirname, '..');

function sourceHash() {
  const hash = createHash('sha256');
  const files = fs.readdirSync(BOT_DIR).filter((file) => file.endsWith('.js'));
  files.push(
    ...fs
      .readdirSync(path.join(BOT_DIR, 'baseline'))
      .filter((file) => file.endsWith('.js'))
      .map((file) => `baseline/${file}`),
  );
  for (const file of files.sort()) {
    hash.update(`bot-template/relay-bot/${file}\0`);
    hash.update(fs.readFileSync(path.join(BOT_DIR, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function seedIndex(seed) {
  const match = /-(\d+)$/.exec(seed);
  return match ? Number(match[1]) : 0;
}

function sortRows(rows) {
  return rows.sort(
    (a, b) =>
      seedIndex(a.seed) - seedIndex(b.seed) ||
      a.map.localeCompare(b.map) ||
      a.opponent.localeCompare(b.opponent) ||
      Number(a.fog) - Number(b.fog) ||
      Number(a.multi) - Number(b.multi) ||
      a.seat - b.seat,
  );
}

function parseRows(text, source = 'input') {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${source} contains invalid JSON: ${error.message}`);
    }
  }
  return rows;
}

function tally(rows) {
  return {
    games: rows.length,
    win: rows.filter((row) => row.result === 'win').length,
    loss: rows.filter((row) => row.result === 'loss').length,
    timeout: rows.filter((row) => row.result === 'timeout').length,
  };
}

function withRate(rows) {
  const counts = tally(rows);
  return { ...counts, winRate: counts.games ? counts.win / counts.games : 0 };
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return Object.fromEntries([...groups].map(([value, group]) => [value, withRate(group)]));
}

function modeOf(row) {
  return `${Number(row.large)}${Number(row.fog)}${Number(row.multi)}`;
}

function validate(rows, options) {
  if (rows.length !== options.expectedRows)
    throw new Error(`expected ${options.expectedRows} rows, received ${rows.length}`);
  const seen = new Set();
  for (const row of rows) {
    const mode = modeOf(row);
    if (
      !options.modes.includes(mode) ||
      !options.maps.includes(row.map) ||
      !options.opponents.includes(row.opponent)
    )
      throw new Error(`unexpected cell ${row.opponent}/${row.map}/${mode}`);
    const key = JSON.stringify([row.seed, row.opponent, row.map, mode, row.seat]);
    if (seen.has(key) || ![0, 1].includes(row.seat)) throw new Error(`invalid or duplicate seat: ${key}`);
    seen.add(key);
    if (!(row.tick <= options.ticks))
      throw new Error(`row ${row.seed}/${row.opponent} exceeds ${options.ticks} ticks`);
  }
}

function summarize(rows, options) {
  const cells = [];
  for (const opponent of options.opponents)
    for (const map of options.maps)
      for (const mode of options.modes) {
        const [, fog, multi] = [...mode].map((bit) => bit === '1');
        const group = rows.filter(
          (row) => row.opponent === opponent && row.map === map && modeOf(row) === mode,
        );
        if (group.length !== options.gamesPerCell)
          throw new Error(
            `cell ${opponent}/${map}/fog=${fog}/multi=${multi} has ${group.length}, ` +
              `expected ${options.gamesPerCell}`,
          );
        const ended = group.filter((row) => row.result !== 'timeout');
        const wins = group.filter((row) => row.result === 'win');
        cells.push({
          opponent,
          map,
          fog,
          multi,
          ...tally(group),
          winRate: group.length ? wins.length / group.length : 0,
          meanWinTick: wins.length
            ? Number((wins.reduce((sum, row) => sum + row.tick, 0) / wins.length).toFixed(1))
            : null,
          meanTick: ended.length
            ? Number((ended.reduce((sum, row) => sum + row.tick, 0) / ended.length).toFixed(1))
            : null,
        });
      }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    evaluatedCommit: gitHead(),
    sourceSha256: sourceHash(),
    settings: {
      bot: 'bot-template/relay-bot',
      historicalControlsCommit: BASELINE_COMMIT,
      mapSize: 'official-small (0.34)',
      large: false,
      ticks: options.ticks,
      seeds: options.seedsLabel,
      seatSwaps: 2,
      gamesPerCell: options.gamesPerCell,
      opponents: options.opponents,
      maps: options.maps,
      modes: options.modes,
    },
    total: withRate(rows),
    byOpponent: groupBy(rows, (row) => row.opponent),
    byMap: groupBy(rows, (row) => row.map),
    byMode: groupBy(rows, (row) => `fog=${row.fog},multi=${row.multi}`),
    byOpponentMap: groupBy(rows, (row) => `${row.opponent}/${row.map}`),
    cells,
  };
}

function printTable(summary) {
  console.log('| opponent | map | fog | multi | games | win | loss | timeout | winRate |');
  console.log('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const cell of summary.cells)
    console.log(
      `| ${cell.opponent} | ${cell.map} | ${cell.fog ? 'on' : 'off'} | ${cell.multi ? 'on' : 'off'} | ` +
        `${cell.games} | ${cell.win} | ${cell.loss} | ${cell.timeout} | ` +
        `${(cell.winRate * 100).toFixed(1)}% |`,
    );
  console.log('');
  console.log(
    `total ${summary.total.games}: ${summary.total.win}W / ${summary.total.loss}L / ` +
      `${summary.total.timeout}T (${(summary.total.winRate * 100).toFixed(1)}% win, ` +
      `${summary.settings.ticks} ticks)`,
  );
}

module.exports = {
  modeOf,
  ROOT,
  BOT_DIR,
  sourceHash,
  gitHead,
  seedIndex,
  sortRows,
  parseRows,
  tally,
  withRate,
  groupBy,
  validate,
  summarize,
  printTable,
};
