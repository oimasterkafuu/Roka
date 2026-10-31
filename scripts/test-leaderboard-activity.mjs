import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { serialize, deserialize } from 'node:v8';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { migrate } from './migrate-last-game-at.mjs';
const require = createRequire(import.meta.url);
const { UserStore, LEADERBOARD_INACTIVITY_MS: WEEK } = require('../dist/auth-store.js');
const { deriveLastGameAt } = require('../src/rating-activity.js');
const now = Date.now();
const originalNow = Date.now;
Date.now = () => now;
const dir = await mkdtemp(path.join(tmpdir(), 'roka-active-rank-'));
const encode = (data) => brotliCompressSync(serialize(data));
const decode = (data) => deserialize(brotliDecompressSync(data));
try {
  const base = {
    passwordSalt: 'salt',
    passwordHash: 'hash',
    sessionId: null,
    createdAt: 1,
    updatedAt: now,
    lastSeenAt: now,
    rating: 1944,
    ratingGames: 273,
    points: 5,
    secretFixture: 'preserve',
    ratingHistory: [],
  };
  const users = [
    { ...base, username: 'Milkcat', ratingHistory: [{ t: now - WEEK - 1, r: 1944 }] },
    { ...base, username: 'no_history' },
    { ...base, username: 'boundary', lastGameAt: now - WEEK },
    { ...base, username: 'banned', lastGameAt: now - 1, bannedUntil: now + WEEK },
    { ...base, username: 'permanent', lastGameAt: now - 1, bannedUntil: -2 },
    { ...base, username: 'expired', lastGameAt: now - 1, bannedUntil: now - 1 },
    { ...base, username: 'no_games', lastGameAt: now - 1, ratingGames: 0 },
    ...[NaN, Infinity, -1, now + WEEK, 'bad'].map((v, i) => ({
      ...base,
      username: `invalid_${i}`,
      lastGameAt: v,
      ratingHistory: [
        { t: NaN, r: 1 },
        { t: Infinity, r: 1 },
        { t: -1, r: 1 },
        { t: now + WEEK, r: 1 },
        { t: now, r: NaN },
        { t: 0, r: 1 },
      ],
    })),
    {
      ...base,
      username: 'legacy_recent',
      ratingHistory: [
        { t: now - 2, r: 4 },
        { t: now - 1, r: 5 },
      ],
    },
    ...Array.from({ length: 12 }, (_, i) => ({
      ...base,
      username: `active_${String(11 - i).padStart(2, '0')}`,
      lastGameAt: now - 10,
      createdAt: i === 0 ? 0 : 1,
    })),
  ];
  const data = { users, pointsMigrationVersion: 1, extra: { unchanged: true } };
  const file = path.join(dir, 'users.bin');
  const bytes = encode(data);
  await writeFile(file, bytes);
  const cli = JSON.parse(
    execFileSync(process.execPath, ['scripts/migrate-last-game-at.mjs', '--data-dir', dir], {
      encoding: 'utf8',
    }),
  );
  assert.equal(cli.mode, 'dry-run');
  assert.equal(cli.changed, 8);
  assert.equal(
    deriveLastGameAt(
      { ratingHistory: [{ t: 1792298004731, r: 1944 }], updatedAt: 1793078097581 },
      1793078097581,
    ).value,
    1792298004731,
  );
  const dry = await migrate(dir, false, now);
  assert.equal(dry.changed, 8);
  assert.equal(dry.fromHistory, 2);
  assert.equal(dry.noEvidence, 6);
  assert.deepEqual(await readFile(file), bytes);
  const applied = await migrate(dir, true, now);
  assert.equal(applied.allValidAfter, true);
  assert.deepEqual(await readFile(applied.backup), bytes);
  const migrated = decode(await readFile(file));
  for (let i = 0; i < users.length; i++) {
    const { lastGameAt: old, ...before } = users[i];
    const { lastGameAt: value, ...after } = migrated.users[i];
    assert.deepEqual(after, before, 'only lastGameAt may change');
    assert.equal(value, deriveLastGameAt(users[i], now).value);
  }
  assert.deepEqual(migrated.extra, data.extra);
  assert.equal((await migrate(dir, true, now)).changed, 0);
  console.log(
    'ok - offline dry-run, original backup, exact field preservation, invalid timestamps, idempotence',
  );

  const failureDir = path.join(dir, 'failure');
  await mkdir(failureDir);
  const failureFile = path.join(failureDir, 'users.bin');
  await writeFile(failureFile, bytes);
  mock.method(fsPromises, 'rename', async () => {
    throw new Error('injected rename failure');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(migrate(failureDir, true, now), /injected rename failure/);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readFile(failureFile), bytes);
  const failureFiles = await readdir(failureDir);
  assert.equal(failureFiles.filter((name) => name.endsWith('.tmp')).length, 0);
  const backup = failureFiles.find((name) => name.includes('.last-game-at-original-'));
  assert.deepEqual(await readFile(path.join(failureDir, backup)), bytes);
  await writeFile(failureFile, Buffer.from('corrupt'));
  await assert.rejects(migrate(failureDir, true, now));
  assert.deepEqual(await readFile(failureFile), Buffer.from('corrupt'));
  console.log(
    'ok - injected atomic rename failure and corrupt input preserve original, retain backup, clean temporary files',
  );

  // Runtime migrates independently, without requiring the offline script first.
  await writeFile(file, bytes);
  let store = new UserStore(dir);
  await store.ensureReady();
  assert.equal(store.usersByKey.get('milkcat').lastGameAt, now - WEEK - 1);
  assert.equal(store.usersByKey.get('no_history').lastGameAt, 0);
  const persisted = decode(await readFile(file));
  assert.equal(persisted.users.find((u) => u.username === 'Milkcat').lastGameAt, now - WEEK - 1);
  for (const name of ['Milkcat', 'no_history', 'boundary', 'banned', 'permanent', 'no_games', 'invalid_0']) {
    assert.equal(store.getRatingRank(name), null, name);
    assert.equal(store.getPublicProfile(name).ratingRawRank, null);
    assert.equal(store.getPublicProfile(name).ratingDisplayRank, '-');
  }
  const full = store.listTopRated(100);
  const top = store.listTopRated(10);
  assert.equal(full.length, 14);
  assert.equal(top[0].username, 'active_11', 'earlier registration breaks tie');
  assert.equal(top[1].username, 'active_00', 'username breaks remaining ties');
  assert.deepEqual(top, full.slice(0, 10));
  full.forEach((entry, i) => {
    assert.equal(store.getRatingRank(entry.username).rawRank, i + 1);
    assert.equal(store.getPublicProfile(entry.username).ratingRawRank, i + 1);
    assert.equal(
      store.getPublicProfile(entry.username).ratingDisplayRank,
      store.getRatingRank(entry.username).displayRank,
    );
  });
  assert.equal(store.getRatingRank(full[10].username).rawRank, 11);
  await store.rotateSession('Milkcat');
  await store.setLastSeenAt('Milkcat', now);
  store = new UserStore(dir);
  await store.ensureReady();
  assert.equal(store.getRatingRank('Milkcat'), null);
  assert.equal(store.usersByKey.get('milkcat').lastGameAt, now - WEEK - 1);
  const restartBytes = await readFile(file);
  await store.ensureReady();
  assert.deepEqual(await readFile(file), restartBytes);
  await store.applyRatingUpdates([{ username: 'Milkcat', delta: 0 }]);
  assert.ok(store.getRatingRank('Milkcat'));
  assert.equal(store.getPublicProfile('Milkcat').ratingGames, 274);
  console.log(
    'ok - runtime persistence, restart/login, seven-day boundary, bans, stable full ranking, top10/profile, rank11, zero-delta settlement',
  );

  const source = await readFile(new URL('../static/profile.js', import.meta.url), 'utf8');
  const render = source.split('\n').find((line) => line.includes("$('#p-rating-rank').text"));
  for (const raw of [null, 0, undefined, 11]) {
    let result;
    vm.runInNewContext(render, {
      p: { ratingRawRank: raw, ratingDisplayRank: '11' },
      $: () => ({
        text: (value) => {
          result = value;
        },
      }),
    });
    assert.equal(result, raw > 0 ? '11' : '-');
  }
  console.log('ok - actual profile rendering expression handles null/zero/undefined and active ranks');
} finally {
  Date.now = originalNow;
  await rm(dir, { recursive: true, force: true });
}
console.log('All active ranking and migration assertions passed');
