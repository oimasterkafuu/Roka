import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  UserStore,
  calculateHistoricalPoints,
  displayPointsRank,
  displayRatingRank,
  getGamePoints,
  getUserLevelProgress,
} = require('../dist/auth-store.js');

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

for (const [place, players, points] of [
  [1, 1, 80],
  [1, 2, 90],
  [2, 2, 80],
  [1, 7, 140],
  [7, 7, 80],
]) {
  assert.equal(getGamePoints(place, players), points, `game points ${place}/${players}`);
}

const historical = calculateHistoricalPoints(
  [{ rank: ['Alpha', 'Beta', 'Alpha'] }, { rank: ['Beta', 'Alpha'] }],
  [
    {
      author: 'Alpha',
      likes: ['Beta', 'Alpha'],
      comments: [{ author: 'Beta' }],
    },
  ],
);
assert.equal(historical.get('alpha'), 90 + 80 + 30 + 10 + 10, 'historical author points');
assert.equal(historical.get('beta'), 80 + 90 + 10 + 20, 'historical interaction points');

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
]) {
  assert.equal(displayRatingRank(rank), display, `display rating rank ${rank}`);
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

  await store.initializeHistoricalPoints(
    [{ rank: ['Alpha', 'Beta'] }],
    [{ author: 'Alpha', likes: ['Beta'], comments: [{ author: 'Beta' }] }],
  );
  assert.equal(store.getPoints('Alpha'), 140, 'migration rebuilds old points');
  assert.equal(store.getPoints('Beta'), 110, 'migration includes received and given interactions');
  await store.applyPointsUpdates([{ username: 'Alpha', points: 5 }]);
  await store.initializeHistoricalPoints([{ rank: ['Beta', 'Alpha'] }], []);
  assert.equal(store.getPoints('Alpha'), 145, 'migration marker prevents rerun');
  const restarted = new UserStore(dataDir);
  await restarted.ensureReady();
  await restarted.initializeHistoricalPoints([], []);
  assert.equal(restarted.getPoints('Alpha'), 145, 'migration marker persists across restart');

  await store.register('RatedA', 'password');
  await store.register('RatedB', 'password');
  await store.applyRatingUpdates([
    { username: 'RatedA', delta: 1000 },
    { username: 'RatedB', delta: 1000 },
  ]);
  assert.equal(store.getRatingRank('RatedA').rawRank, 1, 'rating ties use registration order');
  assert.equal(store.getRatingRank('RatedB').rawRank, 2, 'rating ties use registration order');
  assert.equal(store.getRatingRank('Alpha'), null, 'unrated users are excluded from rating rank');
  const ratedProfile = store.getPublicProfile('RatedB');
  assert.equal(ratedProfile.ratingRawRank, 2, 'profile exposes rating raw rank');
  assert.equal(ratedProfile.ratingDisplayRank, '2', 'profile exposes rating display rank');
  assert.equal(ratedProfile.rawRank, undefined, 'profile does not expose points rank');
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log('points tests passed');
