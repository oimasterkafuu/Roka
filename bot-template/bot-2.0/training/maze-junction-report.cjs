'use strict';

/**
 * Summarise a long-eval report: totals, by size, by opponent and the five
 * reviewed maze blitz scenarios (seed / size / seat) the user names in the
 * replay reviews.
 */

const fs = require('node:fs');

const REVIEWED = [
  ['apex-long-1-maze', 0.34, 0, 'pzr'],
  ['apex-long-1-maze', 0.34, 1, '2ikw'],
  ['apex-long-0-maze', 0.34, 0, 'pbwm'],
  ['apex-long-7-maze', 0.68, 1, 'KuYd'],
  ['apex-long-3-maze', 0.68, 0, '4bQF'],
];

function outcome(row) {
  if (row.error) return 'E';
  if (row.ownWon) return 'W';
  if (!row.ended) return 'D';
  return 'L';
}

function rowKey(row) {
  return `${row.seed}|${Number(row.mapSize)}|${row.ownSeat}`;
}

function summarise(report) {
  const rows = report.results || [];
  const tally = (list) => ({
    n: list.length,
    w: list.filter((row) => outcome(row) === 'W').length,
    d: list.filter((row) => outcome(row) === 'D').length,
    l: list.filter((row) => outcome(row) === 'L').length,
  });
  const bySize = {};
  for (const row of rows) {
    const key = String(Number(row.mapSize));
    (bySize[key] = bySize[key] || []).push(row);
  }
  const byOpponent = {};
  for (const row of rows) {
    (byOpponent[row.opponent] = byOpponent[row.opponent] || []).push(row);
  }
  return {
    total: tally(rows),
    bySize: Object.fromEntries(Object.entries(bySize).map(([key, list]) => [key, tally(list)])),
    byOpponent: Object.fromEntries(Object.entries(byOpponent).map(([key, list]) => [key, tally(list)])),
    wins: rows.filter((row) => outcome(row) === 'W').map((row) => `${row.seed}/${row.mapSize}/s${row.ownSeat}/${row.turns}`),
  };
}

function main() {
  const files = process.argv.slice(2);
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const summary = summarise(report);
    const index = new Map((report.results || []).map((row) => [rowKey(row), row]));
    console.log(`\n== ${file}`);
    console.log(
      `total ${summary.total.w}W/${summary.total.d}D/${summary.total.l}L of ${summary.total.n}`,
      JSON.stringify(summary.bySize),
      JSON.stringify(summary.byOpponent),
    );
    for (const [seed, size, seat, tag] of REVIEWED) {
      const row = index.get(`${seed}|${size}|${seat}`);
      if (!row) continue;
      console.log(`  reviewed ${tag} ${seed} ${size} seat${seat}: ${outcome(row)} t${row.turns}`);
    }
  }
}

main();
