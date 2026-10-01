'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createArena, runMatch } = require('../training/engine.cjs');
const { chooseAction: antiAction } = require('../../anti-human-bot/bot/policy.cjs');
const { createController } = require('../bot/controller.cjs');
const replay = require('./fixtures/human-vs-apex.json');

// The map metadata comes from roka-replay-g4fqY7lsJpPE.rpl.  Keeping the
// compact metadata here makes the regression independent of a user's local
// Downloads directory while still reproducing the exact 13x17 starting map.
const HUMAN_WIN_MAP = {
  width_ratio: 0.34,
  height_ratio: 0.34,
  city_ratio: 0.9524116884107728,
  mountain_ratio: 0.5220836194399938,
  swamp_ratio: 0.5,
  speed: 1,
  allow_team: false,
  fog: false,
  map_token: 'bb704e83aa6bf955413864aa8fba5a9d',
  map_mode: 'random',
  map_region: 'china',
  player_names: ['oimaster', 'Anti_Human'],
  player_teams: [1, 2],
  map_size_version: 2,
  map_size: 'normal',
};

const INITIAL_MAP_SHA256 = 'c9b15202d0aba7b5cd55c49842d03fee997609b6bbcafc6cad22e8d238459e73';

function initialMapHash(arena) {
  const frame = arena.engine.buildFullFramePayload(0, false);
  return createHash('sha256')
    .update(JSON.stringify({
      n: arena.engine.n,
      m: arena.engine.m,
      grid_type: frame.grid_type,
      army_cnt: frame.army_cnt,
      isolated: frame.isolated,
    }))
    .digest('hex');
}

function humanActions(ops) {
  const actions = new Map();
  let turn = 1;
  let selected = null;
  const dx = [-1, 1, 0, 0];
  const dy = [0, 0, -1, 1];
  for (const op of ops) {
    if (op.op === 'w') {
      turn += Math.max(0, op.n);
      continue;
    }
    if (op.op === 's') {
      selected = [op.x, op.y];
      continue;
    }
    if (op.op === 'r') {
      turn += 1;
      selected = null;
      continue;
    }
    if (!selected) continue;
    if (op.op === 'b' || op.op === 'c') {
      actions.set(turn, { kind: 'build', x: selected[0], y: selected[1], op: op.op });
      turn += 1;
      continue;
    }
    const action = {
      kind: 'attack',
      x: selected[0],
      y: selected[1],
      dx: selected[0] + dx[op.d],
      dy: selected[1] + dy[op.d],
      mode: op.a === 1 ? 2 : op.h === 1 ? 1 : 0,
    };
    actions.set(turn, action);
    selected = [action.dx, action.dy];
    turn += 1;
  }
  return actions;
}

test('reproduces the human-win replay map exactly', () => {
  const arena = createArena({ engineConfig: replay.meta, traceLimit: 0, captureReplay: false });
  assert.equal(`${arena.engine.n}x${arena.engine.m}`, '13x17');
  assert.equal(initialMapHash(arena), INITIAL_MAP_SHA256);
});

test('Apex wins the human-win replay map against Anti-Human within 600 turns', () => {
  const controller = createController(1);
  const result = runMatch({
    engineConfig: HUMAN_WIN_MAP,
    maxTurns: 600,
    traceLimit: 600,
    policies: [
      (state) => controller.choose(state),
      (state) => antiAction(state),
    ],
  });
  assert.equal(result.ended, true);
  assert.equal(result.winner, 0);
  assert.ok(result.turns <= 600);
  assert.equal(result.stats[1].class_, 'dead');
  assert.equal(controller.stats().rejected, 0);
});

test('new Apex defeats the exact human action stream from the replay', () => {
  const arena = createArena({ engineConfig: replay.meta, traceLimit: 360, captureReplay: false });
  const controller = createController(2);
  const human = humanActions(replay.player_ops[0]);
  while (!arena.ended && arena.engine.turn < 600) {
    const turn = arena.engine.turn + 1;
    arena.tick([human.get(turn) || null, controller.choose(arena.states[1])]);
  }
  assert.equal(arena.ended, true);
  const leaderboard = arena.engine.buildLeaderboard();
  // player_ops[0] belongs to oimaster, while Anti_Human is seat 1.  The
  // replay is therefore a human attack stream that the replacement Apex must
  // survive and win against.
  assert.equal(leaderboard[0].class_, 'dead');
  assert.notEqual(leaderboard[1].class_, 'dead');
  assert.ok(arena.engine.turn <= 600);
  assert.equal(controller.stats().rejected, 0);
});
