import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UserStore, displayPointsRank, getUserLevelProgress } = require('../dist/auth-store.js');

for (const [points, level, next] of [
  [0, 1, 16],
  [15, 1, 16],
  [16, 2, 108],
  [108, 3, 288],
  [288, 4, 1000],
  [1000, 5, 2888],
  [2888, 6, null],
]) {
  const result = getUserLevelProgress(points);
  assert.equal(result.level, level, `level at ${points}`);
  assert.equal(result.nextLevelPoints, next, `next level at ${points}`);
}
for (const [rank, display] of [
  [1, '1'],
  [20, '20'],
  [21, '20+'],
  [50, '20+'],
  [51, '50+'],
  [100, '50+'],
  [101, '100+'],
  [200, '100+'],
  [201, '200+'],
  [500, '200+'],
  [501, '500+'],
]) {
  assert.equal(displayPointsRank(rank), display, `display rank ${rank}`);
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roka-points-'));
try {
  const store = new UserStore(dataDir);
  await store.ensureReady();
  await store.register('Alpha', 'password');
  await store.register('Beta', 'password');
  delete store.usersByKey.get('alpha').points;
  assert.equal(store.getPoints('Alpha'), 0, 'old/missing points default to zero');
  await store.applyPointsUpdates([
    { username: 'Alpha', points: 10 },
    { username: 'MissingBot', points: 10 },
    { username: 'Beta', points: 20 },
  ]);
  assert.equal(store.getPoints('Alpha'), 10);
  assert.equal(store.getPoints('Beta'), 20);
  assert.equal(store.getPoints('MissingBot'), 0, 'synthetic bot is ignored');
  const ranks = store.listPointsRank();
  assert.deepEqual(
    ranks.map((entry) => entry.username),
    ['Beta', 'Alpha'],
  );
  assert.equal(store.getPointsRank('Beta').rawRank, 1);
  assert.equal(store.getPublicProfile('Alpha').level.level, 1);
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log('points tests passed');
