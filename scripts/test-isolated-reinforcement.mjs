import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { GameEngine } = require('../dist/game-engine.js');
const config = {
  speed: 1,
  width_ratio: 0.5,
  height_ratio: 0.5,
  swamp_ratio: 0.1,
  map_token: 'isolated-test',
  map_mode: 'random',
  map_region: 'china',
  allow_team: true,
  fog: false,
  map_size: 'normal',
  player_names: ['alice', 'bob', 'enemy'],
  player_teams: [1, 1, 2],
};
const hooks = {
  update() {},
  emitInitMap() {},
  chatMessage() {},
  endGame() {},
  md5: (x) => x,
  replayStore: {
    async saveReplay() {
      return '';
    },
  },
};
async function setup({ owner = 2, dead = false, multi = false, legacy = false } = {}) {
  const e = await GameEngine.create(
    { ...config, multi_line: multi },
    ['a', 'b', 'c'],
    ['a', 'b', 'c'],
    'test',
    hooks,
  );
  for (let x = 0; x < e.n; x++)
    for (let y = 0; y < e.m; y++) {
      e.owner[x][y] = 0;
      e.gridType[x][y] = 0;
      e.armyCnt[x][y] = 0;
      e.isolated[x][y] = false;
      e.isolatedAge[x][y] = 0;
    }
  e.owner[2][2] = 1;
  e.gridType[2][2] = -2;
  e.armyCnt[2][2] = 11;
  e.owner[2][3] = owner;
  e.armyCnt[2][3] = 5;
  e.isolated[2][3] = true;
  e.isolatedAge[2][3] = 1;
  if (dead) e.pstat[1] = 52;
  if (legacy) e.isolatedReinforcementFix = false;
  return e;
}
for (const multi of [false, true])
  for (const owner of [1, 2])
    for (const dead of [false, true]) {
      const e = await setup({ owner, dead, multi });
      assert.equal(e.attack(2, 2, 2, 3, 2), true);
      e.applyConnectivity();
      assert.equal(e.armyCnt[2][3], 15, `owner=${owner} dead=${dead} multi=${multi}`);
      assert.equal(e.isolatedReinforced[2][3], false);
    }
const old = await setup({ legacy: true });
old.attack(2, 2, 2, 3, 2);
old.applyConnectivity();
assert.equal(old.armyCnt[2][3], 30);
const normal = await setup();
normal.applyConnectivity();
assert.equal(normal.armyCnt[2][3], 10);
const delayed = await setup({ dead: true });
delayed.gridType[2][2] = 0;
delayed.attack(2, 2, 2, 3, 2);
delayed.applyConnectivity();
assert.equal(delayed.armyCnt[2][3], 15);
assert.equal(delayed.isolatedReinforced[2][3], true);
delayed.gridType[2][2] = -2;
delayed.applyConnectivity();
assert.equal(delayed.armyCnt[2][3], 15);
delayed.gridType[2][2] = 0;
delayed.applyConnectivity();
assert.equal(delayed.armyCnt[2][3], 7);
delayed.gridType[2][2] = -2;
delayed.applyConnectivity();
assert.equal(delayed.armyCnt[2][3], 14);
const multiple = await setup({ multi: true });
multiple.owner[1][3] = 1;
multiple.armyCnt[1][3] = 8;
multiple.attack(2, 2, 2, 3, 2);
multiple.attack(1, 3, 2, 3, 2);
multiple.applyConnectivity();
assert.equal(multiple.armyCnt[2][3], 22);
const enemy = await setup({ owner: 3 });
enemy.isolatedReinforced[2][3] = true;
enemy.attack(2, 2, 2, 3, 2);
enemy.applyConnectivity();
assert.equal(enemy.armyCnt[2][3], 5);
assert.equal(enemy.isolatedReinforced[2][3], false);
const neutral = await setup();
neutral.isolatedReinforced[2][3] = true;
neutral.armyCnt[2][3] = 1;
neutral.applyIsolatedDecay(2, 3);
assert.equal(neutral.owner[2][3], 0);
assert.equal(neutral.isolatedReinforced[2][3], false);
// Replay constructors must default to historical rules, explicitly opt in for new metadata.
for (const enabled of [undefined, true]) {
  const e = new GameEngine(
    { ...config, isolated_reinforcement_fix: enabled },
    ['a', 'b', 'c'],
    ['a', 'b', 'c'],
    '__replay_build__',
    hooks,
  );
  assert.equal(e.isolatedReinforcementFix, enabled === true);
}
console.log('isolated reinforcement regression passed');
// Exercise real tick scheduling as well as the shared combat/connectivity primitives.
for (const multi of [false, true]) {
  const e = await setup({ multi, dead: true });
  e.owner[e.n - 2][e.m - 2] = 3;
  e.gridType[e.n - 2][e.m - 2] = -2;
  e.armyCnt[e.n - 2][e.m - 2] = 10;
  assert.equal(e.addMove('a', 2, 2, 2, 3, 2), undefined);
  await e.gameTick();
  // Crown growth adds one before the queued push.
  assert.equal(e.armyCnt[2][3], 16);
}
const zero = await setup();
zero.armyCnt[2][2] = 1;
assert.equal(zero.attack(2, 2, 2, 3, 2), false);
zero.applyConnectivity();
assert.equal(zero.armyCnt[2][3], 10);

for (const owner of [1, 2])
  for (const dead of [false, true]) {
    const e = await setup({ owner, dead });
    e.gridType[2][2] = 0;
    e.attack(2, 2, 2, 3, 2);
    e.applyConnectivity();
    e.applyConnectivity();
    assert.equal(e.armyCnt[2][3], 15);
    e.gridType[2][2] = -2;
    e.applyConnectivity();
    assert.equal(e.armyCnt[2][3], 15);
  }
console.log('tick scheduling and delayed reconnection passed');
