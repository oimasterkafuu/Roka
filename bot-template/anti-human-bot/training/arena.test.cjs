'use strict';
// node --test training/arena.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { runMatch, createArena, loadEngine, MAP_MODES } = require('./arena.cjs');

for (const mapMode of MAP_MODES) {
  test(`${mapMode}: 真实地图构造、同种子全帧与结果确定性`, () => {
    const options = { mapMode, seed: 'arena-test-42', mapSize: 0.5 };
    const a = createArena(options);
    const b = createArena(options);
    assert.ok(a.engine.n > 0 && a.engine.m > 0);
    assert.deepEqual(a.states, b.states);
    assert.equal(a.states[0].grid.filter((v) => v === 101).length, 1);
    assert.equal(a.states[0].grid.filter((v) => v === 102).length, 1);
    for (let i = 0; i < 60; i++) {
      a.tick(); b.tick();
      assert.deepEqual(a.states, b.states);
    }
    const play = () => {
      const frames = [];
      const result = runMatch({ ...options, maxTurns: 80, policies: [
        (state) => {
          frames.push([state.grid.slice(), state.army.slice(), state.isolated.slice()]);
          for (let i = 0; i < state.grid.length; i++) {
            if (![1, 51, 101, 151].includes(state.grid[i]) || state.army[i] < 3) continue;
            const x = Math.floor(i / state.m), y = i % state.m;
            for (const [dx, dy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
              if (dx >= 0 && dx < state.n && dy >= 0 && dy < state.m && state.grid[dx * state.m + dy] === 200) {
                return { kind: 'attack', x, y, dx, dy, mode: 2 };
              }
            }
          }
          return null;
        }, () => null,
      ] });
      delete result.elapsedMs;
      return { result, frames };
    };
    assert.deepEqual(play(), play());
    assert.equal(a.engine.tickTimer, null);
    assert.equal(a.engine.replayTurnMoves.length, 0);
  });
}

// 手工布置小棋盘，但增长/移动/建造/连通/胜负均由真实 gameTick 执行。
function fixture(arena) {
  const e = arena.engine;
  e.n = 3; e.m = 5; e.turn = 0;
  e.owner = [[1, 1, 0, 0, 2], [0, 0, 0, 0, 0], [1, 0, 0, 0, 0]];
  e.gridType = [[-2, 0, 0, 0, -2], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
  e.armyCnt = [[120, 60, 0, 0, 1], [0, 0, 0, 0, 0], [20, 0, 0, 0, 0]];
  e.isolated = Array.from({ length: 3 }, () => Array(5).fill(false));
  e.isolatedAge = Array.from({ length: 3 }, () => Array(5).fill(0));
  e.st = Array.from({ length: 3 }, () => Array(5).fill(false));
  for (let p = 0; p < 2; p++) e.emitInitMap(`arena-${p}`, { n: 3, m: 5, player_ids: ['arena-0', 'arena-1'] });
  e.sendMap(false);
}
const move = (x, y, dx, dy) => ({ kind: 'attack', x, y, dx, dy, mode: 2 });

test('手动局：增长、移动、建造升级、孤军、真实胜负和回调', () => {
  const a = createArena(); fixture(a);
  a.tick([{ kind: 'build', x: 0, y: 1, op: 'b' }, null]);
  assert.equal(a.engine.armyCnt[0][0], 121);
  assert.equal(a.engine.gridType[0][1], -1);
  assert.equal(a.engine.armyCnt[0][1], 10);
  assert.equal(a.engine.armyCnt[2][0], 10);
  assert.equal(a.states[0].isolated[10], 1);
  a.tick([move(0, 0, 0, 1), null]);
  assert.equal(a.engine.armyCnt[0][0], 1);
  assert.equal(a.engine.armyCnt[0][1], 131);
  a.tick([{ kind: 'build', x: 0, y: 1, op: 'c' }, null]);
  assert.equal(a.engine.gridType[0][1], -2);
  assert.equal(a.engine.armyCnt[0][1], 81);
  a.tick([move(0, 1, 0, 2), null]);
  assert.equal(a.engine.armyCnt[0][2], 81);
  a.tick([move(0, 2, 0, 3), null]);
  assert.equal(a.tick([move(0, 3, 0, 4), null]), true);
  assert.equal(a.ended, true);
  assert.equal(a.states[1].dead, true);
  assert.equal(a.states[0].ended, true);
  assert.ok(a.result);
  assert.deepEqual(a.builds.map((b) => b.op), ['b', 'c']);
  assert.equal(a.engine.tickTimer, null);
});

test('同步适配与未修改 async gameTick 逐 Tick 一致', async () => {
  const a = createArena();
  const b = createArena({ synchronous: false });
  await b.initialization;
  fixture(a); fixture(b);
  const script = [
    { kind: 'build', x: 0, y: 1, op: 'b' }, move(0, 0, 0, 1),
    { kind: 'build', x: 0, y: 1, op: 'c' },
    move(0, 1, 0, 2), move(0, 2, 0, 3), move(0, 3, 0, 4),
  ];
  for (const action of script) {
    assert.equal(a.tick([action, null]), await b.tick([action, null]));
    assert.deepEqual(a.states, b.states);
    assert.deepEqual(a.engine.owner, b.engine.owner);
    assert.deepEqual(a.builds, b.builds);
  }
  assert.deepEqual(a.result, b.result);
  assert.equal(loadEngine(), loadEngine());
});

test('超时不冒充胜利；非法操作由引擎拒绝', () => {
  const result = runMatch({ seed: 12, maxTurns: 30, policies: [
    () => ({ kind: 'build', x: -1, y: -1, op: 'b' }), () => null,
  ] });
  assert.equal(result.ended, false);
  assert.equal(result.winner, null);
  assert.equal(result.turns, 30);
  assert.equal(result.stats[0].rejected, 30);
  assert.deepEqual(result.builds, []);
  assert.ok(Number.isFinite(result.elapsedMs));
});
