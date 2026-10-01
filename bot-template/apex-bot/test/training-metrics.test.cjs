'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMetrics,
  createArena,
  metricsSummary,
  recordTiming,
  runMatch,
  replayMatch,
} = require('../training/engine.cjs');
const { parseCli } = require('../training/long-eval.cjs');

test('long evaluation --help parses without constructing a match', () => {
  const parsed = parseCli(['--help']);
  assert.equal(parsed.help, true);
  assert.deepEqual(parsed.options, {});
  assert.equal(parseCli(['--seeds', '2', '--workers', '3', '--seat', 'both']).options.seeds, '2');
});

test('decision timing uses bounded samples and keeps an exact maximum', () => {
  const row = createMetrics();
  for (const duration of [0.1, 0.2, 1, 25, 1000]) {
    row.decisions += 1;
    recordTiming(row.timing, duration);
  }
  const summary = metricsSummary(row);
  assert.equal(summary.decisions, 5);
  assert.equal(summary.measuredDecisions, 5);
  assert.equal(summary.maxMs, 1000);
  assert.equal(summary.maxIsExact, true);
  assert.equal(summary.percentileEstimation.method, 'log-histogram-upper-bound');
  assert.equal(summary.percentileEstimation.bins, 2048);
});

test('failure replay contains initial state and bounded actions and round-trips', () => {
  const result = runMatch({
    mapMode: 'random',
    seed: 'metrics-replay',
    mapSize: 0.2,
    maxTurns: 3,
    policies: [() => null, () => null],
    traceLimit: 2,
  });
  assert.equal(result.replay.complete, true);
  assert.ok(result.replay.initial.n > 0);
  assert.equal(result.replay.totalTicks, 3);
  const replayed = replayMatch(result.replay);
  assert.equal(replayed.matches, true);
  assert.equal(replayed.actualHash, result.replay.finalStateSha256);
});

test('arena starts at server turn zero and applies growth before the first action', () => {
  const arena = createArena({ mapMode: 'random', seed: 'tick-order', mapSize: 0.2, traceLimit: 4 });
  assert.equal(arena.engine.turn, 0);
  assert.equal(arena.states[0].turn, 0);
  const crown = arena.engine.gridType
    .flatMap((row, x) =>
      row.map((tile, y) => (tile === -2 && arena.engine.owner[x][y] === 1 ? [x, y] : null)),
    )
    .find(Boolean);
  assert.ok(crown, 'seat 1 should have an initial crown');
  const [x, y] = crown;
  const before = arena.engine.armyCnt[x][y];
  arena.tick();
  assert.equal(arena.engine.turn, 1);
  assert.equal(arena.engine.armyCnt[x][y], before + 1);
  assert.equal(arena.trace.at(-1).turn, 1);
});

test('large-map evaluation records development checkpoints', () => {
  const result = runMatch({
    mapMode: 'maze',
    seed: 'large-development-metrics',
    mapSize: 1,
    maxTurns: 3,
    policies: [() => null, () => null],
    traceLimit: 0,
  });
  assert.deepEqual(result.telemetry.checkpoints, [120, 300, 600, 900, 1200]);
  assert.ok(Array.isArray(result.telemetry.players));
  assert.equal(result.telemetry.players.length, 2);
  assert.ok(Number.isInteger(result.telemetry.maxCrowns[0]));
  assert.ok(Number.isInteger(result.telemetry.maxCities[0]));
});
