'use strict';
const { parentPort } = require('node:worker_threads');
const { runMatch, makeSimpleAdapter } = require('./engine.cjs');
const { chooseAction: antiAction } = require('../../anti-human-bot/bot/policy.cjs');
const { createController } = require('../bot/controller.cjs');

function run(job) {
  const ownSeat = job.swap ? 1 : 0;
  const opponent = job.opponent || 'anti';
  const controllers = [null, null];
  const policies = [null, null];
  const adapters = [];
  function apexPolicy(seat) {
    const controller = createController(seat + 1);
    controllers[seat] = controller;
    return (state) => controller.choose(state);
  }
  policies[ownSeat] = apexPolicy(ownSeat);
  if (opponent === 'simple') {
    adapters.push(makeSimpleAdapter({ seat: 1 - ownSeat, decisionTimeoutMs: job.decisionTimeoutMs || 40 }));
  } else if (opponent === 'anti') {
    policies[1 - ownSeat] = (state) => antiAction(state);
  } else {
    throw new Error(`unsupported opponent: ${opponent}`);
  }
  const result = runMatch({
    mapMode: job.mode || 'random', seed: job.seed, maxTurns: job.turns || 600,
    mapSize: job.mapSize ?? 0.5, fog: Boolean(job.fog), policies, adapters,
    traceLimit: job.traceLimit ?? 120, decisionTimeoutMs: job.decisionTimeoutMs || 40,
  });
  const apex = result.decision[ownSeat];
  const opponentMetric = result.decision[1 - ownSeat];
  if (controllers[ownSeat]) {
    result.controller = controllers[ownSeat].stats();
  }
  result.opponent = opponent;
  result.ownSeat = ownSeat;
  result.mode = job.mode;
  result.swap = Boolean(job.swap);
  result.ownWon = result.winner === ownSeat;
  result.ownArmy = result.stats[ownSeat].army;
  result.ownLand = result.stats[ownSeat].land;
  result.enemyArmy = result.stats[1 - ownSeat].army;
  result.enemyLand = result.stats[1 - ownSeat].land;
  result.seed = job.seed;
  result.mapSize = job.mapSize;
  result.fog = Boolean(job.fog);
  result.metrics = { own: apex, opponent: opponentMetric };
  // Keep a bounded failure replay. Successful rows omit the per-tick trace to
  // keep long JSON reports small; callers may set keepTrace for all rows.
  if (job.keepTrace || result.winner !== ownSeat) result.failureTrace = result.trace;
  delete result.trace;
  return result;
}

if (parentPort) parentPort.on('message', (job) => {
  try {
    const result = run(job);
    result.ownWon = result.winner === result.ownSeat;
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.stack : String(error), job });
  }
});

module.exports = { run };
