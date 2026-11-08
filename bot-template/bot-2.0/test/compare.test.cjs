'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  CompareError,
  bootstrapPairs,
  buildPairs,
  classify,
  compareReports,
  compareSettings,
  createRandom,
  main,
  pairKey,
  parseCli,
  scoreOf,
} = require('../training/compare.cjs');

const COMPARE = path.join(__dirname, '..', 'training', 'compare.cjs');
const MODES = ['random', 'maze', 'archipelago', 'mediterranean'];

function row(overrides = {}) {
  return {
    mode: 'random',
    mapSize: 0.5,
    seed: 'apex-long-0-0-random',
    swap: false,
    opponent: 'anti',
    fog: false,
    ownWon: false,
    ended: true,
    turns: 600,
    winner: null,
    error: null,
    ...overrides,
  };
}

function matrix(overrides = {}) {
  const rows = [];
  for (const mode of MODES) {
    for (const swap of [false, true]) {
      rows.push(
        row({
          mode,
          swap,
          seed: `apex-long-0-0-${mode}`,
          ...overrides,
        }),
      );
    }
  }
  return rows;
}

function report(rows, settingsOverrides = {}) {
  const modes = [...new Set(rows.map((item) => item.mode))].sort();
  const sizes = [...new Set(rows.map((item) => Number(item.mapSize)))].sort((a, b) => a - b);
  const opponents = [...new Set(rows.map((item) => item.opponent))].sort();
  const seats = [...new Set(rows.map((item) => Boolean(item.swap)))].sort((a, b) => Number(a) - Number(b));
  const fogs = [...new Set(rows.map((item) => Boolean(item.fog)))].sort((a, b) => Number(a) - Number(b));
  return {
    schemaVersion: 3,
    settings: {
      profile: 'standard',
      seeds: 1,
      seedOffset: 0,
      seedPrefix: 'apex-long',
      turns: 600,
      workers: 1,
      sizes,
      modes,
      opponents,
      seats,
      fogs,
      ...settingsOverrides,
    },
    results: rows,
  };
}

function withBaselineWins(rows, wins) {
  return rows.map((item, index) => ({
    ...item,
    ownWon: index < wins,
    ended: index < wins,
  }));
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'roka-compare-test-'));
}

function writeReport(dir, name, doc) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

function runCli(args) {
  return spawnSync(process.execPath, [COMPARE, ...args], { encoding: 'utf8' });
}

test('classify and score map outcomes to +1/0/-1 with errors as losses', () => {
  assert.equal(classify(row({ ownWon: true, ended: true })), 'win');
  assert.equal(classify(row({ ownWon: false, ended: false })), 'draw');
  assert.equal(classify(row({ ownWon: false, ended: true })), 'loss');
  assert.equal(classify(row({ ownWon: true, error: 'boom' })), 'error');
  assert.deepEqual(
    [scoreOf(row({ ownWon: true })), scoreOf(row({ ended: false })), scoreOf(row({}))],
    [1, 0, -1],
  );
  assert.equal(scoreOf(row({ ownWon: true, error: 'boom' })), -1);
});

test('pair key covers every pairing dimension', () => {
  const base = row();
  const key = pairKey(base);
  assert.equal(key, 'random|0.5|apex-long-0-0-random|0|anti|0');
  for (const change of [
    { mode: 'maze' },
    { mapSize: 1 },
    { seed: 'other' },
    { swap: true },
    { opponent: 'simple' },
    { fog: true },
  ]) {
    assert.notEqual(pairKey(row(change)), key);
  }
});

test('identical reports yield zero delta and a CI that includes zero', () => {
  const rows = withBaselineWins(matrix(), 2);
  const result = compareReports(report(rows), report(rows), { iterations: 500, seed: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.coverage.matched, 8);
  assert.equal(result.aggregate.delta.meanScore, 0);
  assert.equal(result.aggregate.delta.winRate, 0);
  assert.equal(result.aggregate.delta.drawRate, 0);
  assert.equal(result.changed.length, 0);
  assert.deepEqual(result.aggregate.bootstrap.ci95, { low: 0, high: 0 });
  assert.equal(result.aggregate.bootstrap.includesZero, true);
  assert.deepEqual(result.aggregate.deltaDistribution, [{ delta: 0, pairs: 8 }]);
});

test('candidate winning one extra pair produces a positive paired delta', () => {
  const baselineRows = matrix();
  const candidateRows = baselineRows.map((item, index) =>
    index === 0 ? { ...item, ownWon: true, ended: true } : item,
  );
  const result = compareReports(report(baselineRows), report(candidateRows), { iterations: 500, seed: 11 });
  assert.equal(result.ok, true);
  assert.equal(result.aggregate.delta.wins, 1);
  assert.equal(result.aggregate.baseline.winRate, 0);
  assert.equal(result.aggregate.candidate.winRate, 1 / 8);
  // loss (-1) -> win (+1); the bootstrap resamples pairs, so its mean wobbles
  // around the population mean of 2/8.
  assert.ok(Math.abs(result.aggregate.bootstrap.meanDelta - 0.25) < 0.15);
  // A single flipped pair in 8 resamples to zero often enough that the 2.5th
  // percentile still sits at 0; the point estimate must be strictly positive.
  assert.ok(result.aggregate.bootstrap.ci95.low >= 0);
  assert.ok(result.aggregate.bootstrap.meanDelta > 0);
  assert.equal(result.changed.length, 1);
  assert.deepEqual(
    {
      baseline: result.changed[0].baseline,
      candidate: result.changed[0].candidate,
      delta: result.changed[0].delta,
    },
    { baseline: 'loss', candidate: 'win', delta: 2 },
  );
});

test('draws count as 0.5-equivalent in the half-draw rate but stay effective losses', () => {
  const baselineRows = matrix();
  const candidateRows = baselineRows.map((item, index) =>
    index === 0 ? { ...item, ownWon: false, ended: false } : item,
  );
  const result = compareReports(report(baselineRows), report(candidateRows), { iterations: 200, seed: 3 });
  const delta = result.aggregate.delta;
  assert.equal(result.aggregate.candidate.draws, 1);
  assert.equal(delta.drawRate, 1 / 8);
  assert.equal(delta.halfDrawWinRate, 0.5 / 8);
  assert.equal(delta.winRate, 0);
  // A draw is still a missed kill: effective loss rate does not improve.
  assert.equal(delta.effectiveLossRate, 0);
  assert.equal(result.changed[0].delta, 1);
});

test('missing pairs are reported and block by default', () => {
  const baselineRows = matrix();
  const candidateRows = baselineRows.slice(1);
  const strict = compareReports(report(baselineRows), report(candidateRows), { iterations: 100, seed: 5 });
  assert.equal(strict.ok, false);
  assert.equal(strict.blocking, true);
  assert.equal(strict.coverage.missingCandidate, 1);
  assert.equal(strict.coverage.matched, 7);
  assert.equal(strict.issues.filter((issue) => issue.kind === 'missing').length, 1);

  const lenient = compareReports(report(baselineRows), report(candidateRows), {
    iterations: 100,
    seed: 5,
    allowMissing: true,
  });
  assert.equal(lenient.ok, true);
  assert.equal(lenient.blocking, false);

  // The opposite direction is reported too.
  const reversed = compareReports(report(candidateRows), report(baselineRows), { iterations: 10, seed: 5 });
  assert.equal(reversed.coverage.missingBaseline, 1);
});

test('incompatible settings block the comparison and name the fields', () => {
  const baselineRows = matrix();
  const candidateRows = matrix();
  const baselineDoc = report(baselineRows);
  const candidateDoc = report(candidateRows, { turns: 1200, modes: [...MODES].reverse() });
  const result = compareReports(baselineDoc, candidateDoc, { iterations: 10, seed: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.settings.compatible, false);
  assert.deepEqual(
    result.settings.mismatches.map((mismatch) => mismatch.field),
    ['turns'],
  );
  assert.equal(result.issues[0].kind, 'incompatible');

  // List order must not matter.
  const reordered = compareSettings(
    { ...baselineDoc.settings, modes: [...MODES].reverse() },
    baselineDoc.settings,
  );
  assert.equal(reordered.compatible, true);
  const sizeOrder = compareSettings({ sizes: [1, 0.5], turns: 1 }, { sizes: [0.5, 1], turns: 1 });
  assert.equal(sizeOrder.compatible, true);
});

test('duplicate pair keys are rejected', () => {
  const rows = matrix();
  const duplicated = report([...rows, { ...rows[0] }]);
  assert.throws(
    () => compareReports(duplicated, report(rows)),
    (error) => error instanceof CompareError && error.kind === 'duplicate',
  );
  assert.equal(buildPairs([rows[0], { ...rows[0] }], [rows[0]]).duplicates.length, 1);
});

test('bootstrap is deterministic for a fixed seed and resamples pairs', () => {
  const rows = matrix();
  const baselineRows = rows.map((item, index) => ({
    ...item,
    ownWon: index % 3 === 0,
    ended: index % 4 !== 0,
  }));
  const candidateRows = rows.map((item, index) => ({
    ...item,
    ownWon: index % 2 === 0,
    ended: index % 5 !== 0,
  }));
  const pairs = buildPairs(baselineRows, candidateRows).pairs;
  assert.equal(pairs.length, 8);
  const first = bootstrapPairs(pairs, { iterations: 800, seed: 42 });
  const second = bootstrapPairs(pairs, { iterations: 800, seed: 42 });
  assert.deepEqual(first, second);
  const other = bootstrapPairs(pairs, { iterations: 800, seed: 43 });
  assert.notDeepEqual(first.ci95, other.ci95);
  assert.ok(first.ci95.low <= first.meanDelta && first.meanDelta <= first.ci95.high);
  assert.equal(createRandom(9)(), createRandom(9)());
  assert.equal(bootstrapPairs([], { iterations: 100 }).ci95, null);
  assert.equal(bootstrapPairs(pairs, { iterations: 0 }).iterations, 0);
});

test('per-mode, per-scale and per-seat breakdowns are produced', () => {
  const baselineRows = [
    ...matrix().map((item) => ({ ...item, ownWon: true, ended: true })),
    row({
      mode: 'random',
      mapSize: 1,
      seed: 'apex-long-0-0-random',
      swap: false,
      ownWon: false,
      ended: true,
    }),
  ];
  const candidateRows = baselineRows.map((item) => ({ ...item, ownWon: true, ended: true }));
  const result = compareReports(report(baselineRows), report(candidateRows), { iterations: 100, seed: 2 });
  assert.deepEqual(Object.keys(result.byMode).sort(), [...MODES].sort());
  assert.deepEqual(Object.keys(result.byMapSize).sort(), ['0.5', '1']);
  assert.deepEqual(Object.keys(result.byScale).sort(), ['large', 'standard']);
  assert.deepEqual(Object.keys(result.bySeat).sort(), ['seat0', 'seat1']);
  assert.equal(result.byMode.random.pairs, 3);
  assert.equal(result.byScale.large.pairs, 1);
  assert.equal(result.byScale.large.delta.meanScore, 2);
  assert.equal(result.bySeat.seat0.pairs, 5);
});

test('CLI compares existing reports, writes JSON and exits zero when identical', () => {
  const dir = tempDir();
  const rows = withBaselineWins(matrix(), 1);
  const baselineFile = writeReport(dir, 'baseline.json', report(rows));
  const candidateFile = writeReport(dir, 'candidate.json', report(rows));
  const output = path.join(dir, 'comparison.json');
  const result = runCli([
    '--baseline-json',
    baselineFile,
    '--candidate-json',
    candidateFile,
    '--output',
    output,
    '--iterations',
    '200',
    '--seed',
    '9',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Paired bot evaluation comparison/);
  assert.match(result.stdout, /Verdict: OK/);
  const saved = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.aggregate.delta.meanScore, 0);
  assert.equal(saved.aggregate.bootstrap.iterations, 200);
  assert.equal(saved.aggregate.bootstrap.seed, 9);
  assert.equal(saved.pairs.length, 8);
  assert.equal(saved.byMode.random.pairs, 2);
});

test('CLI exits non-zero on incompatible settings and on missing pairs', () => {
  const dir = tempDir();
  const rows = matrix();
  const baselineFile = writeReport(dir, 'baseline.json', report(rows));
  const incompatibleFile = writeReport(dir, 'incompatible.json', report(rows, { turns: 1200 }));
  const incompatible = runCli(['--baseline-json', baselineFile, '--candidate-json', incompatibleFile]);
  assert.equal(incompatible.status, 1);
  assert.match(incompatible.stdout, /INCOMPATIBLE/);
  assert.match(incompatible.stdout, /FAILED/);

  const shortFile = writeReport(dir, 'short.json', report(rows.slice(1)));
  const missing = runCli(['--baseline-json', baselineFile, '--candidate-json', shortFile]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /missing candidate 1/);

  const allowed = runCli(['--baseline-json', baselineFile, '--candidate-json', shortFile, '--allow-missing']);
  assert.equal(allowed.status, 0, allowed.stderr);

  const ambiguous = runCli(['--baseline-json', baselineFile, '--candidate-json', 'does-not-exist.json']);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /cannot read/);
});

test('CLI validates evaluation flags without running a suite', () => {
  const dir = tempDir();
  const rows = matrix();
  const baselineFile = writeReport(dir, 'baseline.json', report(rows));
  const parsed = parseCli(['--baseline-json', baselineFile, '--seeds', '2', '--seat', 'both']).values;
  assert.equal(parsed.seeds, '2');
  assert.equal(parsed.seat, 'both');

  const tooManyWorkers = runCli([
    '--baseline-json',
    baselineFile,
    '--candidate-json',
    baselineFile,
    '--workers',
    '8',
  ]);
  assert.equal(tooManyWorkers.status, 2);
  assert.match(tooManyWorkers.stderr, /--workers must be an integer in \[1, 2\]/);

  const largeProfile = runCli([
    '--baseline-json',
    baselineFile,
    '--candidate-json',
    baselineFile,
    '--profile',
    'large',
  ]);
  assert.equal(largeProfile.status, 2);
  assert.match(largeProfile.stderr, /--profile large is not allowed/);

  const helpRun = runCli(['--help']);
  assert.equal(helpRun.status, 0);
  assert.match(helpRun.stdout, /--baseline-json FILE/);
  assert.match(helpRun.stdout, /--iterations N/);
});

test('main() reports duplicate keys as a failure instead of comparing garbage', () => {
  const dir = tempDir();
  const rows = matrix();
  const duplicateFile = writeReport(dir, 'duplicate.json', report([...rows, { ...rows[0] }]));
  const cleanFile = writeReport(dir, 'clean.json', report(rows));
  const code = main(['--baseline-json', duplicateFile, '--candidate-json', cleanFile, '--quiet']);
  assert.equal(code, 1);
});
