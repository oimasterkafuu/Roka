import assert from 'node:assert/strict';
import { SeededRandom, checkConnection } from '../src/map/map-core.ts';
import { generateHuaxiaMap } from '../src/map/huaxia-map-generator.ts';
import { HUAXIA_REGIONS } from '../src/map/huaxia-regions.ts';

const baseConfig = {
  widthRatio: 0.8,
  heightRatio: 0.8,
  cityRatio: 0.5,
  mountainRatio: 0.5,
  swampRatio: 0.5,
};

const serialize = (map) => JSON.stringify({ n: map.n, m: map.m, gridType: map.gridType });
const maps = new Map();
for (const region of HUAXIA_REGIONS) {
  const first = generateHuaxiaMap(new SeededRandom(`map-test:${region.id}`), {
    ...baseConfig,
    mapRegion: region.id,
  });
  const second = generateHuaxiaMap(new SeededRandom(`map-test:${region.id}`), {
    ...baseConfig,
    mapRegion: region.id,
  });
  assert.equal(serialize(first), serialize(second), `${region.id} must be deterministic`);
  assert.ok(first.n >= 7 && first.m >= 7, `${region.id} dimensions are playable`);
  assert.notDeepEqual(
    checkConnection(first.gridType, first.n, first.m),
    [-1, -1],
    `${region.id} is connected`,
  );
  assert.ok(
    first.gridType.flat().some((tile) => tile === 0),
    `${region.id} has walkable land`,
  );
  maps.set(region.id, serialize(first));
}
assert.ok(new Set(maps.values()).size >= 2, 'regions should produce distinct terrain');
console.log(`map generation passed: ${HUAXIA_REGIONS.length} regions`);
