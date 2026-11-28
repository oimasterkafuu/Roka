import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {encodeRpl,decodeRpl} from '../dist/rpl.js';
import { recordFixture } from './rpl-fixture.mjs';
const require = createRequire(import.meta.url);
const { GameEngine } = require('../dist/game-engine.js');
const { MOVE_DX, MOVE_DY } = require('../dist/map/map-core.js');
const { serialize } = require('node:v8');
const { ReplayStore } = require('../dist/replay-store.js');
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
try {
  for (const teamed of [false, true]) {
    for (const midGame of [false, true]) {
      let saved;
      const config = {
        speed: 1,
        width_ratio: 0.5,
        height_ratio: 0.5,
        swamp_ratio: 0.1,
        map_token: 'replay-termination-143',
        map_mode: 'random',
        map_region: 'china',
        allow_team: teamed,
        fog_mode: 'visible',
        multi_line: false,
        map_size: 'normal',
        player_names: ['alice', 'bob', 'carol'],
        player_teams: teamed ? [1, 1, 2] : [1, 2, 3],
      };
      const e = await GameEngine.create(config, ['a', 'b', 'c'], ['a', 'b', 'c'], 'live', {
        update() {},
        emitInitMap() {},
        chatMessage() {},
        endGame() {},
        disciplineEvent() {},
        md5: (x) => x,
        replayStore: {
          async saveReplay(r) {
            saved = structuredClone(r);
            return 'test';
          },
        },
      });
      const frames = [];
      // Reach the AFK turn threshold without reaching its wall-clock threshold.
      for (let t = 1; t <= 59; t++) {
        assert.equal(await e.gameTick(), false);
        frames.push(e.buildReplayFrame(false));
      }
      now += 61_000;
      e.afkLastMoveAt[0] = now;
      if (midGame) e.afkLastMoveAt[2] = now;
      assert.equal(await e.gameTick(), !midGame);
      frames.push(e.buildReplayFrame(!midGame));
      if (midGame) {
        // A real manual surrender between ticks must keep its existing timing.
        e.surrender('c');
        assert.equal(await e.gameTick(), true);
        frames.push(e.buildReplayFrame(true));
      }
      assert.ok(saved, 'live termination saves the raw operation stream');
      const replay = await GameEngine.buildReplayFromActions(await decodeRpl(await encodeRpl(saved)));
      assert.equal(replay.patches.length, saved.total_turns);
      const arrays = Object.fromEntries(
        ['grid_type', 'army_cnt', 'isolated'].map((key) => [key, [...replay.initial[key]]]),
      );
      for (let i = 0; i < frames.length; i++) {
        const actual = replay.patches[i].forward;
        assert.deepEqual(
          actual.leaderboard,
          frames[i].leaderboard,
          `AFK elimination must match the live leaderboard at tick ${i + 1}`,
        );
        assert.equal(actual.game_end, frames[i].game_end);
        for (const key of Object.keys(arrays)) {
          for (let j = 0; j < actual[key].length; j += 2) arrays[key][actual[key][j]] = actual[key][j + 1];
          assert.deepEqual(arrays[key], frames[i][key], `${key} at tick ${i + 1}`);
        }
      }
      const decoded=replay;
      assert.equal(decoded.patches.length, saved.total_turns);
      assert.equal(decoded.patches.at(-1).forward.game_end, true);
      assert.equal(decoded.patches.at(-1).forward.leaderboard.filter((p) => p.class_ !== 'dead').length, 1);
      assert.equal(decoded.patches.at(-1).backward.game_end, false);
      const dir = await mkdtemp(path.join(tmpdir(), 'roka-replay143-'));
      try {
        await writeFile(path.join(dir, 'index.bin'), serialize([]));
        const store=new ReplayStore(dir);
        await store.ensureReady();
        const id = await store.saveReplay(saved, {
          rank: config.player_names,
          teams: [],
          turn: frames.length,
        });
        assert.deepEqual(await decodeRpl(await store.readRawReplay(id)),saved);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
} finally {
  Date.now = realNow;
}
console.log('replay AFK termination, mid-game elimination, manual surrender and RKL1 round-trip passed');

const meta = {
  speed: 1,
  width_ratio: 0.5,
  height_ratio: 0.5,
  swamp_ratio: 0.1,
  map_token: 'replay-termination-143',
  map_mode: 'maze',
  allow_team: false,
  fog_mode: 'visible',
  player_names: ['alice', 'bob', 'carol'],
  player_teams: [1, 2, 3],
};
const { n: rows, m: cols, grid_type: tiles } = await GameEngine.buildReplayBaseMap(meta);
const crown = tiles.indexOf(101);
assert.ok(crown >= 0);
const row = Math.floor(crown / cols);
const col = crown % cols;
const direction = MOVE_DX.findIndex((rowOffset, index) => {
  const nextRow = row + rowOffset;
  const nextCol = col + MOVE_DY[index];
  return (
    nextRow >= 0 &&
    nextRow < rows &&
    nextCol >= 0 &&
    nextCol < cols &&
    tiles[nextRow * cols + nextCol] === 200
  );
});
assert.ok(direction >= 0, 'the first seat needs an adjacent plain tile');
const archive=await recordFixture(meta,2151,(engine,tick)=>{
  if(tick===139)engine.surrender('carol');
  if(tick===601)engine.addMove('alice',row,col,row+MOVE_DX[direction],col+MOVE_DY[direction],2);
  if(tick===2151)engine.surrender('bob');
});
const replay=await GameEngine.buildReplayFromActions(await decodeRpl(await encodeRpl(archive)));
const destination = (row + MOVE_DX[direction]) * cols + col + MOVE_DY[direction];
assert.equal(replay.patches.length, 2151);
assert.equal(replay.patches[599].forward.game_end, false);
assert.equal(replay.patches[599].forward.leaderboard.filter((p) => p.class_ !== 'dead').length, 2);
assert.deepEqual(replay.patches[600].forward.grid_type, [destination, 1]);
assert.equal(replay.patches.at(-1).forward.game_end, true);
assert.equal(replay.patches.at(-1).forward.leaderboard.filter((p) => p.class_ !== 'dead').length, 1);
console.log('current maze ops replay without AFK events remains active at tick 600 and reaches tick 2151');
