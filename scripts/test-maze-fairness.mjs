import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { GameEngine } from '../src/game-engine.ts';
import { MAX_SWAMP_RATIO, SeededRandom, resolveMapSeed, shuffle } from '../src/map/map-core.ts';
import { MazeGraph, optimizeMazeLayout } from '../src/map/maze-layout.ts';
import { generateMazeMap } from '../src/map/maze-map-generator.ts';
import { mapConfig, measureMap } from './evaluate-maze-fairness.mjs';

test('maze supports every player count and avoids dead ends at both lobby sizes', async () => {
  for (const size of ['normal', 'large']) {
    for (let players = 2; players <= 16; players += 1) {
      const config = mapConfig(players, size, 'maze-regression');
      const board = await GameEngine.buildReplayBaseMap(config);
      const metrics = measureMap(board, players);
      const label = `${size}, ${players} players`;
      assert.equal(metrics.actual, players, label);
      assert.equal(metrics.missing + metrics.duplicates + metrics.illegal + metrics.deadEnds, 0, label);
      assert.ok(metrics.connected, label);
      assert.equal(
        board.grid_type.filter((tile) => tile === 204).length,
        Math.floor(board.n * board.m * MAX_SWAMP_RATIO * config.swamp_ratio),
        label,
      );
    }
  }
});

test('maze gives all seats productive openings and meaningful territory', async () => {
  for (const players of [2, 4, 8, 16]) {
    const config = mapConfig(players, 'normal', 'maze-economy');
    const metrics = measureMap(await GameEngine.buildReplayBaseMap(config), players);
    assert.ok(metrics.local[6].plains.min >= 9, `${players} players: radius 6 plains floor`);
    assert.ok(metrics.local[10].plains.min >= 15, `${players} players: radius 10 plains floor`);
    assert.ok(metrics.local[6].plains.cv < 0.28, `${players} players: radius 6 plains CV`);
    assert.ok(metrics.local[10].plains.cv < 0.28, `${players} players: radius 10 plains CV`);
    assert.ok(metrics.voronoi.plains.worstBest > 0.35, `${players} players: territory floor`);
  }
});

test('Voronoi divides a tied cell equally and excludes crowns from productive land', () => {
  const board = { n: 1, m: 5, grid_type: [101, 200, 200, 204, 102], army_cnt: [1, 0, 0, 0, 1] };
  const { voronoi } = measureMap(board, 2);
  assert.deepEqual(voronoi.counts, [
    { passable: 2.5, plains: 1.5 },
    { passable: 2.5, plains: 0.5 },
  ]);
  const graph = new MazeGraph(Uint8Array.from([0, 0, 0, 2, 0]), 5);
  assert.deepEqual(graph.territory([0, 4]), { passable: [2.5, 2.5], plains: [1.5, 0.5] });
});

test('crowded layouts use every available non-dead-end position before endpoints', () => {
  const graph = new MazeGraph(new Uint8Array(5), 5);
  for (const players of [2, 3, 4, 5]) {
    const first = optimizeMazeLayout(graph, players, 12, new SeededRandom('corridor'));
    const repeated = optimizeMazeLayout(graph, players, 12, new SeededRandom('corridor'));
    assert.deepEqual(first, repeated);
    assert.equal(new Set(first).size, players);
    assert.equal(first.filter((cell) => graph.degree[cell] < 2).length, Math.max(0, players - 3));
  }
  const tiny = generateMazeMap(new SeededRandom('tiny-crowded'), {
    widthRatio: 0.1,
    heightRatio: 0.1,
    cityRatio: 0,
    mountainRatio: 0,
    swampRatio: 1,
    requiredPlayers: 16,
  });
  assert.equal(tiny.n * tiny.m, 49);
  assert.equal(new Set(tiny.generals.map(String)).size, 16);
  assert.ok(tiny.generals.every(([row, col]) => tiny.gridType[row][col] === 0 && tiny.st[row][col]));
  const graphTiny = new MazeGraph(Uint8Array.from(tiny.gridType.flat()), tiny.m);
  assert.equal(
    tiny.generals.filter(([row, col]) => graphTiny.degree[row * tiny.m + col] < 2).length,
    Math.max(0, 16 - graphTiny.cells.filter((cell) => graphTiny.degree[cell] >= 2).length),
  );
});

test('live and action replay initialization share deterministic, independently shuffled seats', async () => {
  const players = 8;
  const config = mapConfig(players, 'normal', 'seat-regression');
  const seed = resolveMapSeed('maze', config.map_token);
  const generated = generateMazeMap(new SeededRandom(seed), {
    widthRatio: config.width_ratio,
    heightRatio: config.height_ratio,
    cityRatio: 0,
    mountainRatio: 0,
    swampRatio: config.swamp_ratio,
    requiredPlayers: players,
  });
  const expected = [...generated.generals];
  shuffle(expected, new SeededRandom(`${seed}:maze-seats`));
  assert.notDeepEqual(expected, generated.generals, 'fixture must distinguish shuffled and layout order');
  const seats = [];
  const ids = config.player_names.map((_, seat) => `s${seat}`);
  const live = await GameEngine.create(config, ids, ids, 'maze-test', {
    update() {},
    chatMessage() {},
    endGame() {},
    md5: (value) => value,
    emitInitMap(_sid, { general }) {
      seats.push(general);
    },
    replayStore: { saveReplay: async () => '' },
  });
  assert.deepEqual(seats, expected);
  const base = await GameEngine.buildReplayBaseMap(config);
  assert.deepEqual(base, await GameEngine.buildReplayBaseMap(config));
  assert.notDeepEqual(
    base.grid_type,
    (await GameEngine.buildReplayBaseMap({ ...config, map_token: 'different-maze' })).grid_type,
  );
  const frame = live.buildReplayFrame(false);
  assert.equal(base.n, generated.n);
  assert.equal(base.m, generated.m);
  assert.deepEqual(frame.grid_type, base.grid_type);
  assert.deepEqual(frame.army_cnt, base.army_cnt);
  for (const version of ['ops-v1', 'ops-v2']) {
    const replay = await GameEngine.buildReplayFromActions({
      version,
      meta: live.replayMeta,
      total_turns: 1,
      player_ops: ids.map(() => [{ op: 'w', n: 1 }]),
    });
    assert.equal(replay.n, base.n);
    assert.equal(replay.m, base.m);
    assert.deepEqual(replay.initial, frame);
    assert.equal(replay.patches.length, 1);
  }
});

test('non-maze initialization is byte-identical to the pre-rewrite engine', async () => {
  const hashes = {
    random: 'b2650d0e03284817af8d211f30144ed2875d6c2f04e375b0571377302fb4a206',
    archipelago: '34dcccd9a54f968d3103b4a43900b971d024418fade7c15089b5b56a6ed204c1',
    mediterranean: '36798ab53bf9a18c91309a950876ab405d79bce6077d642dce25fa7e5e7b795e',
    huaxia: '940521c718bd1715d1f9234451f4786835e0ed9b710fa2001656e9d0312cb1b4',
  };
  for (const [map_mode, expected] of Object.entries(hashes)) {
    const board = await GameEngine.buildReplayBaseMap(
      mapConfig(4, 'normal', 'maze-isolation-test', { map_mode }),
    );
    assert.equal(createHash('sha256').update(JSON.stringify(board)).digest('hex'), expected, map_mode);
  }
});
