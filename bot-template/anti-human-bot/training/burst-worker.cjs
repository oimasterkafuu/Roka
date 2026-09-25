'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runMatch, loadEngine } = require('./arena.cjs');
const CHECKPOINTS = [25, 50, 100, 200];

function fingerprints() {
  const files = ['training/arena.cjs', 'training/burst-worker.cjs', 'training/burst-eval.cjs',
    'reference/src/game-engine.ts', 'bot/state.cjs'];
  for (const directory of ['bot', 'training/preburst', 'training/prearchitecture', 'training/preresilience', 'training/precampaign']) {
    for (const name of fs.readdirSync(path.resolve(__dirname, '..', directory)).sort()) {
      if (name.endsWith('.cjs')) files.push(`${directory}/${name}`);
    }
  }
  return Object.fromEntries([...new Set(files)].sort().map(file => [file,
    crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '..', file))).digest('hex')]));
}

function snapshot(state) {
  let land = 0, ordinaryLand = 0, army = 0, buildings = 0;
  const generals = [];
  for (let i = 0; i < state.grid.length; i++) {
    const cell = state.grid[i], me = state.playerId;
    if (![me, me + 50, me + 100, me + 150].includes(cell)) continue;
    land++; army += state.army[i];
    if (cell === me) ordinaryLand++;
    if (cell === me + 50) buildings++;
    if (cell === me + 100) generals.push({ x: Math.floor(i / state.m), y: i % state.m, army: state.army[i] });
  }
  return { tick: state.turn, land, ordinaryLand, army, buildings, generals,
    generalCount: generals.length, generalArmy: generals.reduce((sum, g) => sum + g.army, 0), dead: state.dead };
}

function instrument(policy) {
  let state;
  const timeline = [], buildingActions = [];
  const counts = { callbacks: 0, attacks: 0, builds: 0, upgrades: 0, idle: 0 };
  return {
    fn(s) {
      state = s;
      timeline.push(snapshot(s));
      counts.callbacks++;
      const action = policy(s);
      if (action && typeof action.then === 'function') throw new Error('policy 必须同步');
      if (!action) counts.idle++;
      else if (action.kind === 'attack') counts.attacks++;
      else if (action.kind === 'build') {
        counts[action.op === 'c' ? 'upgrades' : 'builds']++;
        buildingActions.push({ tick: s.turn, ...action });
      }
      return action;
    },
    finish() {
      // runMatch 的末帧无后续 policy 调用；BoardState 引用仍由引擎更新。
      const final = state ? snapshot(state) : null;
      if (final && timeline.at(-1)?.tick !== final.tick) timeline.push(final);
      return { counts, buildingActions, final, timeline,
        checkpoints: Object.fromEntries(CHECKPOINTS.map(t => [t, timeline.find(s => s.tick === t) || null])) };
    },
  };
}

if (parentPort) {
  try {
    const hashes = fingerprints();
    const current = require('../bot/policy.cjs').chooseAction;
    const opponent = workerData.self ? current : require(`./${workerData.opponent || 'preburst'}/policy.cjs`).chooseAction;
    if (typeof current !== 'function' || typeof opponent !== 'function') throw new Error('缺少 chooseAction');
    loadEngine(); // 每线程仅编译/加载一次；后续 runMatch 使用 arena 模块缓存。
    if (JSON.stringify(hashes) !== JSON.stringify(fingerprints())) throw new Error('加载期间策略文件发生变化');
    parentPort.postMessage({ type: 'ready', hashes });
    parentPort.on('message', job => {
      try {
        const currentSide = instrument(current), opponentSide = instrument(opponent);
        const players = job.seat === 0 ? [currentSide, opponentSide] : [opponentSide, currentSide];
        const result = runMatch({ mapMode: job.mapMode, seed: job.seed, maxTurns: workerData.turns,
          mapSize: workerData.size, policies: players.map(p => p.fn) });
        const sides = { current: currentSide.finish(), opponent: opponentSide.finish() };
        for (const [label, seat] of [['current', job.seat], ['opponent', 1 - job.seat]]) {
          sides[label].seat = seat;
          sides[label].acceptedStats = result.stats[seat];
          sides[label].acceptedBuildingActions = result.builds.filter(b => b.player === seat);
        }
        parentPort.postMessage({ type: 'result', match: { ...job, ...result, sides,
          winnerSide: result.winner === null ? null : result.winner === job.seat ? 'current' : 'opponent',
          outcome: !result.ended ? 'timeout_unresolved' : result.winner === null ? 'ended_without_winner' : 'decisive' } });
      } catch (error) { parentPort.postMessage({ type: 'failure', error: error.stack || String(error) }); }
    });
  } catch (error) { parentPort.postMessage({ type: 'failure', error: error.stack || String(error) }); }
}

module.exports = { fingerprints };
