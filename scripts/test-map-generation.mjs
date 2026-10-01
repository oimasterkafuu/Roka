import assert from 'node:assert/strict';
import { SeededRandom, checkConnection } from '../src/map/map-core.ts';
import { selectRandomGenerals } from '../src/game-engine/general-selection.ts';
import { HUAXIA_RIDGES, HUAXIA_PASSES } from '../src/map/huaxia-terrain-data.ts';
import { generateHuaxiaMap, isLand } from '../src/map/huaxia-map-generator.ts';
import { HUAXIA_REGIONS, normalizeMapRegion } from '../src/map/huaxia-regions.ts';
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
assert.equal(HUAXIA_REGIONS.length, 10, 'exactly ten Huaxia regions are exposed');
assert.deepEqual(
  HUAXIA_REGIONS.map((region) => region.id),
  ['qin', 'han', 'tang', 'song', 'yuan', 'ming', 'liao', 'china', 'hong-kong', 'taiwan'],
);
assert.equal(normalizeMapRegion('three-kingdoms'), 'han');
assert.equal(normalizeMapRegion('northern-dynasties'), 'han');
assert.equal(normalizeMapRegion('qing'), 'china');
const china = HUAXIA_REGIONS.find((region) => region.id === 'china');
assert.deepEqual(china?.bounds, { west: 73, east: 135, south: 18, north: 54 });
for (const [name, lon, lat] of [
  ['新疆范围', 87, 43],
  ['西藏范围', 91, 30],
  ['北京范围', 116.4, 39.9],
  ['广东范围', 113.3, 23.1],
  ['台湾附近', 121, 23.5],
]) {
  assert.ok(
    lon >= china.bounds.west && lon <= china.bounds.east && lat >= china.bounds.south && lat <= china.bounds.north,
    `China viewport covers ${name}`,
  );
}
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
  assert.ok(counts[0] > 0, `${region.id} has playable plains`);
  assert.ok(counts[0] > counts[1], `${region.id} keeps plains dominant over mountains`);
  assert.ok(
    map.gridType.every((row, x) => row.every((tile, y) => tile !== 2 || !map.st[x][y])),
    `${region.id} spawn mask excludes sea`,
  );
  assert.ok(map.st.flat().filter(Boolean).length >= 16, `${region.id} has enough main-land plains`);
  const hasRidgeInViewport = HUAXIA_RIDGES.some((ridge) =>
    ridge.points.some(
      (point) =>
        point.lon >= region.bounds.west &&
        point.lon <= region.bounds.east &&
        point.lat >= region.bounds.south &&
        point.lat <= region.bounds.north,
    ),
  );
  if (hasRidgeInViewport) assert.ok(counts[1] > 0, `${region.id} has fixed mountain lines`);
  assert.ok(
    HUAXIA_RIDGES.some((ridge) => ridge.width >= 1.1),
    'main ridges are wider',
  );
  assert.ok(
    HUAXIA_RIDGES.some((ridge) => ridge.width <= 0.9),
    'branch ridges are thinner',
  );
  const hasLandInViewport = [0.2, 0.5, 0.8].some((latRatio) =>
    [0.2, 0.5, 0.8].some((lonRatio) =>
      isLand(
        region.bounds.west + (region.bounds.east - region.bounds.west) * lonRatio,
        region.bounds.south + (region.bounds.north - region.bounds.south) * latRatio,
      ),
    ),
  );
  assert.ok(hasLandInViewport, `${region.id} viewport contains land`);
  assert.equal(region.territoryAreaKm2, null, `${region.id} does not mislabel viewport as territory area`);
  assert.ok(HUAXIA_PASSES.length >= 11, 'fixed passes include narrow mountain corridors');
  const viewportPasses = HUAXIA_PASSES.filter(
    (pass) =>
      pass.lon >= region.bounds.west &&
      pass.lon <= region.bounds.east &&
      pass.lat >= region.bounds.south &&
      pass.lat <= region.bounds.north &&
      isLand(pass.lon, pass.lat),
  );
  for (const pass of viewportPasses) {
    let hasLand = false;
    let traversable = false;
    for (let x = 0; x < map.n; x += 1) {
      const lat = region.bounds.north - ((x + 0.5) * (region.bounds.north - region.bounds.south)) / map.n;
      for (let y = 0; y < map.m; y += 1) {
        const lon = region.bounds.west + ((y + 0.5) * (region.bounds.east - region.bounds.west)) / map.m;
        if (Math.hypot(lon - pass.lon, lat - pass.lat) <= pass.radius) {
          if (map.gridType[x][y] !== 2) hasLand = true;
          if (map.gridType[x][y] === 0) traversable = true;
        }
      }
    }
    if (hasLand) {
      assert.ok(traversable, `${region.id} pass ${pass.name} is traversable`);
    }
  }

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
    if (players === 2 && (region.id === 'taiwan' || region.id === 'hong-kong')) {
      assert.ok(
        generals.every(([x, y]) => {
          const lat =
            region.bounds.north - ((x + 0.5) * (region.bounds.north - region.bounds.south)) / sized.n;
          const lon = region.bounds.west + ((y + 0.5) * (region.bounds.east - region.bounds.west)) / sized.m;
          return isLand(lon, lat);
        }),
        `${region.id} spawns stay on its designated land component`,
      );
    }
  }
  maps.set(region.id, serialize(map));
}
assert.ok(new Set(maps.values()).size >= 2, 'regions should produce distinct terrain');
console.log(`map generation passed: ${HUAXIA_REGIONS.length} regions, 2-16 players`);
