import assert from 'node:assert/strict';
import { SeededRandom, checkConnection } from '../src/map/map-core.ts';
import { selectRandomGenerals } from '../src/game-engine/general-selection.ts';
import { HUAXIA_RIDGES, HUAXIA_PASSES } from '../src/map/huaxia-terrain-data.ts';
import { generateHuaxiaMap } from '../src/map/huaxia-map-generator.ts';
import { HUAXIA_REGIONS } from '../src/map/huaxia-regions.ts';
import { resolveMapSizeRatioByPlayers } from '../src/map/map-size.ts';

const baseConfig = {
  widthRatio: 0.8,
  heightRatio: 0.8,
  cityRatio: 0.5,
  mountainRatio: 0.5,
  swampRatio: 0.5,
};

const serialize = (map) => JSON.stringify({ n: map.n, m: map.m, gridType: map.gridType });
const maps = new Map();
const first = generateHuaxiaMap(new SeededRandom('map-test:first'), {
  ...baseConfig,
  mapRegion: 'han',
});
const differentSeed = generateHuaxiaMap(new SeededRandom('map-test:second'), {
  ...baseConfig,
  mapRegion: 'han',
});
assert.equal(serialize(first), serialize(differentSeed), 'terrain must not depend on the map seed');

for (const region of HUAXIA_REGIONS) {
  const map = generateHuaxiaMap(new SeededRandom(`map-test:${region.id}`), {
    ...baseConfig,
    mapRegion: region.id,
  });
  assert.ok(map.n >= 7 && map.m >= 7, `${region.id} dimensions are playable`);
  assert.notDeepEqual(checkConnection(map.gridType, map.n, map.m), [-1, -1], `${region.id} is connected`);
  const counts = map.gridType.flat().reduce(
    (result, tile) => {
      result[tile] += 1;
      return result;
    },
    [0, 0, 0],
  );
  assert.ok(counts[2] > 0, `${region.id} has a fixed eastern/southeastern sea`);
  assert.ok(counts[0] > counts[1], `${region.id} keeps plains dominant over mountains`);
  assert.ok(counts[1] > 0, `${region.id} has fixed mountain lines`);
  assert.ok(
    HUAXIA_RIDGES.some((ridge) => ridge.width >= 0.04),
    'main ridges are wider',
  );
  assert.ok(
    HUAXIA_RIDGES.some((ridge) => ridge.width <= 0.02),
    'branch ridges are thinner',
  );
  assert.ok(HUAXIA_PASSES.length >= 5, 'fixed passes are part of the terrain data');

  for (let players = 2; players <= 16; players += 1) {
    const playerRatio = resolveMapSizeRatioByPlayers(players);
    const sized = generateHuaxiaMap(new SeededRandom(`size:${players}`), {
      ...baseConfig,
      widthRatio: playerRatio,
      heightRatio: playerRatio,
      mapRegion: region.id,
    });
    const generals = selectRandomGenerals(
      {
        n: sized.n,
        m: sized.m,
        st: sized.st,
        gridType: sized.gridType,
        rng: new SeededRandom(`spawn:${players}`),
      },
      players,
    );
    assert.equal(generals.length, players, `${region.id} supports ${players} players`);
    assert.ok(
      generals.every(([x, y]) => x >= 0 && sized.st[x][y] && sized.gridType[x][y] === 0),
      `${region.id} ${players}-player spawns stay on connected plains`,
    );
  }
  maps.set(region.id, serialize(map));
}
assert.ok(new Set(maps.values()).size >= 2, 'regions should produce distinct terrain');
console.log(`map generation passed: ${HUAXIA_REGIONS.length} regions, 2-16 players`);
