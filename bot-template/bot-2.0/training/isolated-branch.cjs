'use strict';

/**
 * Isolated-branch experiment for the maze blitz junction rule.
 *
 * The junction rule treats an isolated enemy stack as unable to move (the
 * engine freezes it), so the wave walks past it.  That is a *measurement*, not
 * an assumption: this script drives real matches with `APEX_MAZE_BLITZ=1` on
 * maze rooms and reads the plan's own watch counters
 * (`controller.stats().blitz.iso`) for the three outcomes the user asked about:
 *
 *   1. the enemy recaptured the junction we left and reconnected the branch;
 *   2. the enemy reconnected the branch through a different path;
 *   3. the branch decayed/disappeared without ever reconnecting.
 *
 * Usage:
 *   APEX_MAZE_BLITZ=1 node training/isolated-branch.cjs \
 *     [--seeds 2] [--sizes 0.34,0.68] [--seat both] [--turns 2400]
 *     [--opponent anti|apex] [-o FILE]
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { runMatch } = require('./engine.cjs');
const { createController } = require('../bot/controller.cjs');
const { chooseAction: antiAction } = require('../../anti-human-bot/bot/policy.cjs');

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      seeds: { type: 'string' },
      offset: { type: 'string' },
      sizes: { type: 'string' },
      seat: { type: 'string' },
      turns: { type: 'string' },
      opponent: { type: 'string' },
      prefix: { type: 'string' },
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return {
    seeds: Number(values.seeds ?? 2),
    offset: Number(values.offset ?? 0),
    sizes: String(values.sizes ?? '0.34,0.68').split(',').map(Number),
    seat: String(values.seat ?? 'both'),
    turns: Number(values.turns ?? 2400),
    opponent: String(values.opponent ?? 'anti'),
    prefix: String(values.prefix ?? 'apex-long'),
    output: values.output ? path.resolve(values.output) : null,
    help: Boolean(values.help),
  };
}

function play(options, seedIndex, mapSize, seat) {
  const controller = createController(seat + 1, { mapMode: 'maze' });
  const policies = [null, null];
  policies[seat] = (state) => controller.choose(state);
  if (options.opponent === 'anti') policies[1 - seat] = (state) => antiAction(state);
  else {
    const { createController: createApex } = require('../../apex-bot/bot/controller.cjs');
    const baseline = createApex(2 - seat);
    policies[1 - seat] = (state) => baseline.choose(state);
  }
  const seed = `${options.prefix}-${seedIndex}-maze`;
  const result = runMatch({
    mapMode: 'maze',
    seed,
    mapSize,
    maxTurns: options.turns,
    policies,
    decisionTimeoutMs: 80,
    traceLimit: 0,
  });
  const blitz = controller.stats().blitz;
  return {
    seed,
    mapSize,
    seat,
    winner: result.winner,
    ownWon: result.winner === seat,
    ended: result.ended,
    turns: result.turns,
    phase: blitz?.phase ?? null,
    junctionTicks: blitz?.junctionTicks ?? 0,
    halfLadders: blitz?.halfLadders ?? 0,
    iso: blitz?.iso ?? null,
  };
}

function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log('node training/isolated-branch.cjs [--seeds N] [--sizes 0.34,0.68] [--seat both]');
    return;
  }
  if (String(process.env.APEX_MAZE_BLITZ || '') !== '1') {
    console.error('set APEX_MAZE_BLITZ=1: this experiment measures the blitz junction rule');
    process.exitCode = 2;
    return;
  }
  const seats = options.seat === 'both' ? [0, 1] : [Number(options.seat)];
  const rows = [];
  for (let index = options.offset; index < options.offset + options.seeds; index += 1) {
    for (const mapSize of options.sizes) {
      for (const seat of seats) {
        const row = play(options, index, mapSize, seat);
        rows.push(row);
        const iso = row.iso || {};
        console.log(
          `${row.seed} size=${row.mapSize} seat=${row.seat} ${row.ownWon ? 'W' : row.ended ? 'L' : 'D'} t${row.turns}`,
          `junctions=${row.junctionTicks} ladders=${row.halfLadders}`,
          `watched=${iso.watchedTotal ?? 0} recapture=${iso.recapture ?? 0}`,
          `otherPath=${iso.otherPath ?? 0} decayed=${iso.decayed ?? 0} pending=${iso.pending ?? 0}`,
        );
      }
    }
  }
  const total = rows.reduce(
    (sum, row) => {
      const iso = row.iso || {};
      sum.watched += iso.watchedTotal || 0;
      sum.recapture += iso.recapture || 0;
      sum.otherPath += iso.otherPath || 0;
      sum.decayed += iso.decayed || 0;
      sum.pending += iso.pending || 0;
      sum.reconnects += iso.reconnects || 0;
      sum.reconnectTicks += iso.reconnectTicks || 0;
      sum.reconnectMass += iso.reconnectMass || 0;
      sum.junctionTicks += row.junctionTicks || 0;
      sum.halfLadders += row.halfLadders || 0;
      return sum;
    },
    {
      watched: 0,
      recapture: 0,
      otherPath: 0,
      decayed: 0,
      pending: 0,
      reconnects: 0,
      reconnectTicks: 0,
      reconnectMass: 0,
      junctionTicks: 0,
      halfLadders: 0,
    },
  );
  const resolved = total.recapture + total.otherPath + total.decayed;
  const report = {
    settings: options,
    matches: rows.length,
    wins: rows.filter((row) => row.ownWon).length,
    branchesWatched: total.watched,
    resolved,
    recapture: total.recapture,
    otherPath: total.otherPath,
    decayed: total.decayed,
    pendingAtEnd: total.pending,
    recaptureRate: resolved ? total.recapture / resolved : null,
    otherPathRate: resolved ? total.otherPath / resolved : null,
    decayedRate: resolved ? total.decayed / resolved : null,
    meanReconnectTicks: total.reconnects ? total.reconnectTicks / total.reconnects : null,
    meanReconnectMass: total.reconnects ? total.reconnectMass / total.reconnects : null,
    junctionTicks: total.junctionTicks,
    halfLadders: total.halfLadders,
    rows,
  };
  console.log(JSON.stringify(report, null, 2));
  if (options.output) fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
}

main();
