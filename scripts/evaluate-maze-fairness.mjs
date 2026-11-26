import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { GameEngine } from '../src/game-engine.ts';
import { FIXED_SWAMP_RATIO, LobbyService } from '../src/server/lobby-service.ts';

export const RADII = [6, 10];
const SEEDS = Array.from({ length: 24 }, (_, index) => `maze-fairness-${index + 1}`);
const FOCUS = [2, 4, 8, 16];
const SIZES = ['normal', 'large'];
const lobby = Object.create(LobbyService.prototype);

export const mapConfig = (players, size, seed, overrides = {}) => {
  const player_teams = Array.from({ length: players }, (_, seat) => seat + 1);
  return {
    ...lobby.getMapSizeConfigByPlayers(
      player_teams.map((team) => ({ team })),
      { map_region: 'china', map_size: size },
    ),
    city_ratio: 0.5,
    mountain_ratio: 0.5,
    swamp_ratio: FIXED_SWAMP_RATIO,
    speed: 1,
    allow_team: false,
    fog: false,
    multi_line: false,
    map_token: seed,
    map_mode: 'maze',
    map_region: 'china',
    map_size: size,
    player_names: player_teams.map((team) => `Player ${team}`),
    player_teams,
    ...overrides,
  };
};

const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const distribution = (values) => {
  if (!values.length) return { min: 0, max: 0, mean: 0, cv: 0, worstBest: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = average(values);
  const cv = mean ? Math.sqrt(average(values.map((value) => (value - mean) ** 2))) / mean : 0;
  return { min, max, mean, cv, worstBest: max ? min / max : 1 };
};

export const measureMap = ({ n, m, grid_type: tiles, army_cnt: armies }, players) => {
  const seats = Array.from({ length: players }, () => []);
  let illegal = 0;
  for (let cell = 0; cell < tiles.length; cell += 1) {
    const tile = tiles[cell];
    if (tile > 100 && tile <= 116) {
      if (!seats[tile - 101] || armies[cell] !== 1) illegal += 1;
      else seats[tile - 101].push(cell);
    }
  }
  const spawns = seats.flat();
  const duplicates = seats.reduce((sum, cells) => sum + Math.max(0, cells.length - 1), 0);
  const missing = seats.filter((cells) => !cells.length).length;
  const neighbors = tiles.map((tile, cell) => {
    if (tile === 201) return [];
    return [
      cell >= m ? cell - m : -1,
      cell + m < n * m ? cell + m : -1,
      cell % m ? cell - 1 : -1,
      cell % m < m - 1 ? cell + 1 : -1,
    ].filter((next) => next >= 0 && tiles[next] !== 201);
  });
  const queue = new Int32Array(tiles.length);
  const distances = spawns.map((spawn) => {
    const distance = new Int32Array(tiles.length).fill(-1);
    let tail = 1;
    distance[spawn] = 0;
    queue[0] = spawn;
    for (let head = 0; head < tail; head += 1) {
      const cell = queue[head];
      for (const next of neighbors[cell]) {
        if (distance[next] !== -1) continue;
        distance[next] = distance[cell] + 1;
        queue[tail++] = next;
      }
    }
    return distance;
  });
  const connected = spawns.length > 0 && spawns.every((cell) => distances[0][cell] >= 0);
  const nearest = distances.map((distance, seat) => {
    const others = spawns.filter((_, index) => index !== seat).map((cell) => distance[cell]);
    return others.length ? Math.min(...others) : 0;
  });
  const local = Object.fromEntries(
    RADII.map((radius) => {
      const counts = distances.map((distance) => {
        let plains = 0;
        let swamps = 0;
        for (let cell = 0; cell < tiles.length; cell += 1) {
          if (distance[cell] <= 0 || distance[cell] > radius) continue;
          if (tiles[cell] === 200) plains += 1;
          if (tiles[cell] === 204) swamps += 1;
        }
        return { plains, swamps };
      });
      return [
        radius,
        {
          plains: distribution(counts.map((count) => count.plains)),
          swamps: distribution(counts.map((count) => count.swamps)),
          counts,
        },
      ];
    }),
  );
  const territory = spawns.map(() => ({ passable: 0, plains: 0 }));
  for (let cell = 0; cell < tiles.length; cell += 1) {
    let best = Infinity;
    const ties = [];
    for (let seat = 0; seat < distances.length; seat += 1) {
      const distance = distances[seat][cell];
      if (distance < 0 || distance > best) continue;
      if (distance < best) ties.length = 0;
      best = distance;
      ties.push(seat);
    }
    for (const seat of ties) {
      territory[seat].passable += 1 / ties.length;
      if (tiles[cell] === 200) territory[seat].plains += 1 / ties.length;
    }
  }
  const exits = spawns.map((cell) => neighbors[cell].length);
  return {
    n,
    m,
    players,
    spawns,
    actual: spawns.length,
    missing,
    duplicates,
    illegal,
    connected,
    eligibleNonDeadEnds: tiles.filter((tile, cell) => tile !== 201 && neighbors[cell].length >= 2).length,
    minPair: nearest.length ? Math.min(...nearest) : 0,
    nearest: distribution(nearest),
    local,
    voronoi: {
      passable: distribution(territory.map((count) => count.passable)),
      plains: distribution(territory.map((count) => count.plains)),
      counts: territory,
    },
    exits,
    deadEnds: exits.filter((count) => count <= 1).length,
  };
};

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const summarize = (maps) => ({
  maps: maps.length,
  invalidMaps: maps.filter(
    (map) => map.actual !== map.players || map.duplicates || map.illegal || map.missing || !map.connected,
  ).length,
  local: Object.fromEntries(
    RADII.map((radius) => [
      radius,
      {
        plainsCV: median(maps.map((map) => map.local[radius].plains.cv)),
        swampCV: median(maps.map((map) => map.local[radius].swamps.cv)),
        weakestPlains: median(maps.map((map) => map.local[radius].plains.min)),
      },
    ]),
  ),
  voronoi: Object.fromEntries(
    ['passable', 'plains'].map((type) => [
      type,
      {
        cv: median(maps.map((map) => map.voronoi[type].cv)),
        worstBest: median(maps.map((map) => map.voronoi[type].worstBest)),
      },
    ]),
  ),
  minimumDistance: average(maps.map((map) => map.minPair)),
  nearestMean: average(maps.map((map) => map.nearest.mean)),
  nearestCV: median(maps.map((map) => map.nearest.cv)),
  deadEndRate:
    maps.reduce((sum, map) => sum + map.deadEnds, 0) / maps.reduce((sum, map) => sum + map.actual, 0),
  exits: Object.fromEntries(
    [0, 1, 2, 3, 4].map((degree) => [
      degree,
      maps.flatMap((map) => map.exits).filter((value) => value === degree).length,
    ]),
  ),
  timingMs: {
    total: maps.reduce((sum, map) => sum + map.ms, 0),
    median: median(maps.map((map) => map.ms)),
    max: Math.max(...maps.map((map) => map.ms)),
  },
});

async function main(output, baselinePath) {
  assert.ok(output, 'usage: pnpm exec tsx scripts/evaluate-maze-fairness.mjs OUTPUT [BASELINE]');
  const start = performance.now();
  const maps = [];
  for (const size of SIZES) {
    for (let players = 2; players <= 16; players += 1) {
      for (const seed of SEEDS) {
        const config = mapConfig(players, size, seed);
        const before = performance.now();
        const board = await GameEngine.buildReplayBaseMap(config);
        const ms = performance.now() - before;
        maps.push({ size, seed, ms, ...measureMap(board, players) });
      }
      console.error(`${size} / ${players}: ${SEEDS.length} maps`);
    }
  }
  const focused = maps.filter((map) => FOCUS.includes(map.players));
  const summary = {
    all: summarize(maps),
    focus: summarize(focused),
    bySize: Object.fromEntries(
      SIZES.map((size) => [size, summarize(maps.filter((map) => map.size === size))]),
    ),
    byPlayers: Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => index + 2).map((players) => [
        players,
        summarize(maps.filter((map) => map.players === players)),
      ]),
    ),
    focusBySize: Object.fromEntries(
      SIZES.map((size) => [
        size,
        Object.fromEntries(
          FOCUS.map((players) => [
            players,
            summarize(focused.filter((map) => map.size === size && map.players === players)),
          ]),
        ),
      ]),
    ),
  };
  writeFileSync(
    output,
    JSON.stringify(
      { seeds: SEEDS, radii: RADII, wallTimeMs: performance.now() - start, summary, maps },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ all: summary.all, focus: summary.focus }, null, 2));
  assert.equal(summary.all.invalidMaps, 0, 'invalid spawn layouts');
  if (!baselinePath) return;
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  assert.deepEqual(
    baseline.maps.map(({ size, players, seed, n, m }) => [size, players, seed, n, m]),
    maps.map(({ size, players, seed, n, m }) => [size, players, seed, n, m]),
  );
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };
  for (const radius of RADII) {
    expect(
      summary.focus.local[radius].plainsCV <= baseline.summary.focus.local[radius].plainsCV * 0.8,
      `radius ${radius} plains CV`,
    );
  }
  expect(
    summary.focus.voronoi.plains.cv <= baseline.summary.focus.voronoi.plains.cv * 0.8,
    'Voronoi plains CV',
  );
  expect(
    summary.focus.voronoi.plains.worstBest > baseline.summary.focus.voronoi.plains.worstBest,
    'Voronoi worst/best ratio',
  );
  for (const metric of ['minimumDistance', 'nearestMean']) {
    expect(summary.all[metric] >= baseline.summary.all[metric] * 0.95, metric);
  }
  expect(
    maps.every((map) => map.eligibleNonDeadEnds < map.players || !map.deadEnds),
    'avoidable dead-end spawns',
  );
  expect(summary.all.timingMs.max < 1000, 'generation reached one second');
  assert.deepEqual(failures, [], 'maze fairness thresholds failed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
