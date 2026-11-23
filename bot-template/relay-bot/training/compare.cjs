'use strict';

// Compare a Bot(3.0) experiment result set with the recorded baseline.
//
//   node bot-template/relay-bot/training/compare.cjs /tmp/candidate.jsonl
//
// The candidate may contain a subset of the baseline matrix (for example a
// two-seed screen). Comparison is paired on
// (opponent, map, fog, multi, seed, seat), so the baseline win rate is
// recomputed over exactly the games the candidate played. This avoids
// comparing a screen against the full 32-game baseline by mistake.
//
// Gate: every relay cell must reach 65% and every other cell must reach 50%
// without dropping below the paired baseline. Exits 1 when the gate fails;
// set NO_GATE=1 to report only.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, parseRows } = require('./matrix.cjs');

function key(row) {
  return [row.opponent, row.map, Number(row.fog), Number(row.multi), row.seed, row.seat].join('|');
}
function cellKey(row) {
  return [row.opponent, row.map, Number(row.fog), Number(row.multi)].join('|');
}
function counts(rows) {
  return {
    games: rows.length,
    win: rows.filter((row) => row.result === 'win').length,
    loss: rows.filter((row) => row.result === 'loss').length,
    timeout: rows.filter((row) => row.result === 'timeout').length,
  };
}
function rate(rows) {
  const count = counts(rows);
  return { ...count, winRate: count.games ? count.win / count.games : 0 };
}

function main() {
  const candidateFile = process.argv[2];
  if (!candidateFile) throw new Error('usage: pnpm run eval:relay:compare <candidate.jsonl> [baseline.jsonl]');
  const baselineFile = process.argv[3] || path.join(ROOT, 'bot-template/relay-bot/baseline-results.jsonl');
  const candidateRows = parseRows(fs.readFileSync(path.resolve(candidateFile), 'utf8'), candidateFile);
  const baselineRows = parseRows(fs.readFileSync(path.resolve(baselineFile), 'utf8'), baselineFile);
  if (!candidateRows.length) throw new Error('candidate has no rows');

  const baseline = new Map(baselineRows.map((row) => [key(row), row]));
  const seen = new Set();
  const pairedBaseline = [];
  for (const row of candidateRows) {
    const id = key(row);
    if (seen.has(id)) throw new Error(`duplicate candidate game: ${id}`);
    seen.add(id);
    const base = baseline.get(id);
    if (!base) throw new Error(`candidate game not found in baseline: ${id}`);
    pairedBaseline.push(base);
  }

  const cellMap = new Map();
  for (const row of candidateRows) {
    const id = cellKey(row);
    if (!cellMap.has(id)) cellMap.set(id, { candidate: [], baseline: [] });
    cellMap.get(id).candidate.push(row);
  }
  for (const row of pairedBaseline) cellMap.get(cellKey(row)).baseline.push(row);

  const results = [];
  for (const [id, group] of [...cellMap].sort()) {
    const [opponent, map, fog, multi] = id.split('|');
    const candidate = rate(group.candidate);
    const base = rate(group.baseline);
    const delta = candidate.winRate - base.winRate;
    const target = opponent === 'relay' ? 0.65 : 0.5;
    const pass = candidate.winRate >= target && candidate.winRate >= base.winRate;
    results.push({
      opponent,
      map,
      fog: fog === '1',
      multi: multi === '1',
      candidate,
      baseline: base,
      delta,
      target,
      pass,
    });
  }

  const flips = {
    winToLoss: 0,
    lossToWin: 0,
    winToTimeout: 0,
    timeoutToWin: 0,
    lossToTimeout: 0,
    timeoutToLoss: 0,
  };
  const names = [
    ['win', 'loss', 'winToLoss'],
    ['loss', 'win', 'lossToWin'],
    ['win', 'timeout', 'winToTimeout'],
    ['timeout', 'win', 'timeoutToWin'],
    ['loss', 'timeout', 'lossToTimeout'],
    ['timeout', 'loss', 'timeoutToLoss'],
  ];
  const baselineByKey = new Map(pairedBaseline.map((row) => [key(row), row]));
  for (const row of candidateRows) {
    const base = baselineByKey.get(key(row));
    for (const [from, to, name] of names) if (base.result === from && row.result === to) flips[name]++;
  }

  console.log(
    '| opponent | map | fog | multi | games | candidate W/L/T | baseline W/L/T | Δwin | target | gate |',
  );
  console.log('| --- | --- | --- | --- | ---: | --- | --- | ---: | ---: | --- |');
  for (const result of results) {
    const c = result.candidate;
    const b = result.baseline;
    console.log(
      `| ${result.opponent} | ${result.map} | ${result.fog ? 'on' : 'off'} | ` +
        `${result.multi ? 'on' : 'off'} | ${c.games} | ${c.win}/${c.loss}/${c.timeout} | ` +
        `${b.win}/${b.loss}/${b.timeout} | ${(result.delta * 100).toFixed(1)}pp | ` +
        `${(result.target * 100).toFixed(0)}% | ${result.pass ? 'PASS' : 'FAIL'} |`,
    );
  }
  const totalCandidate = rate(candidateRows);
  const totalBaseline = rate(pairedBaseline);
  console.log('');
  console.log(
    `total ${totalCandidate.games}: candidate ${totalCandidate.win}/${totalCandidate.loss}/` +
      `${totalCandidate.timeout} (${(totalCandidate.winRate * 100).toFixed(1)}%), baseline ` +
      `${totalBaseline.win}/${totalBaseline.loss}/${totalBaseline.timeout} ` +
      `(${(totalBaseline.winRate * 100).toFixed(1)}%), Δ ` +
      `${((totalCandidate.winRate - totalBaseline.winRate) * 100).toFixed(1)}pp`,
  );
  console.log(`flips: ${JSON.stringify(flips)}`);
  const failed = results.filter((result) => !result.pass);
  console.log(`gate: ${failed.length ? `FAIL (${failed.length}/${results.length} cells)` : 'PASS'}`);

  const out = process.env.OUT;
  if (out) {
    fs.writeFileSync(
      path.resolve(ROOT, out),
      JSON.stringify({ results, flips, totalCandidate, totalBaseline, failed }, null, 2) + '\n',
    );
  }
  if (failed.length && process.env.NO_GATE !== '1') process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
