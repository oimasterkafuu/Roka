import assert from 'node:assert/strict';
import { serialize } from 'node:v8';
import { brotliCompressSync } from 'node:zlib';
import { encodeRpl, decodeRpl, inspectRpl } from '../dist/rpl.js';
import { crc32 } from '../dist/rpl-check.js';
import { GameEngine } from '../dist/game-engine.js';
import { recordFixture } from './rpl-fixture.mjs';

const meta = {
  map_mode: 'random',
  map_region: 'china',
  map_token: '边界-test',
  width_ratio: 0.6,
  height_ratio: 0.6,
  swamp_ratio: 0.1,
  speed: 1,
  fog_mode: 'normal',
  allow_team: true,
  player_teams: [1, 2, 2, 3],
  player_names: ['A', 'B', 'C', 'D'],
};
const archive = await recordFixture(meta, 5, (engine, tick) => {
  if (tick === 5) {
    engine.surrender('C');
    engine.surrender('B');
  }
});
const bytes = Buffer.from(await encodeRpl(archive));
assert.deepEqual(await decodeRpl(bytes), archive);
assert.deepEqual(bytes, Buffer.from(await encodeRpl(archive)));
const replay = await GameEngine.buildReplayFromActions(await decodeRpl(bytes));
assert.equal(replay.patches.length, 5);
assert.deepEqual(archive.surrenders, [
  [4, 2, 1],
  [4, 1, 1],
]);
const repaired = (mutate) => {
  const copy = Buffer.from(bytes);
  mutate(copy, copy.length - 26);
  copy.writeUInt32LE(crc32(copy.subarray(0, -4)), copy.length - 4);
  return copy;
};
const invalid = [
  ['truncated', bytes.subarray(0, -3)],
  ['magic', Buffer.alloc(32)],
  ['version', repaired((copy) => copy[3]++)],
  ['meta length', repaired((copy) => (copy[5] = 127))],
  ['count', repaired((copy, tail) => copy.writeUInt32LE(1, tail + 14))],
  ['seat count', repaired((copy, tail) => (copy[tail + 9] = 0))],
  ['area', repaired((copy, tail) => copy.writeUInt16LE(0, tail + 10))],
  ['tick limit', repaired((copy, tail) => copy.writeUInt32LE(0xffffffff, tail + 5))],
  ['layout', repaired((copy) => (copy[4] = 255))],
  ['CHECK', repaired((copy, tail) => copy[tail]++)],
  ['CRC', Buffer.from(bytes).fill(0, bytes.length - 4)],
  ['EOF', Buffer.concat([bytes, Buffer.from([0])])],
  ['ops-v3', brotliCompressSync(serialize({ version: 'ops-v3' }))],
  ['RPB5', Buffer.from('RPB5')],
  ['RPB4', Buffer.from('RPB4')],
];
for (const [label, content] of invalid)
  await assert.rejects(decodeRpl(content), /回放格式不支持|回放损坏/, label);
await assert.rejects(
  GameEngine.buildReplayFromActions(await decodeRpl(repaired((copy, tail) => (copy[tail + 18] ^= 1)))),
  /终局校验/,
);
const dense = await recordFixture(meta, 180, (engine, tick) => {
  const [row, col] = engine.generals[0],
    dest = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ]
      .map(([dr, dc]) => [row + dr, col + dc])
      .find(([r, c]) => engine.chkxy(r, c) && engine.gridType[r][c] === 0);
  if (tick % 2 === 0) engine.addMove('A', row, col, ...dest, 1);
});
const compressed = Buffer.from(await encodeRpl(dense));
assert.ok(inspectRpl(compressed).layout & 4);
const trailing = Buffer.concat([compressed.subarray(0, -26), Buffer.from([7]), compressed.subarray(-26)]);
trailing.writeUInt32LE(crc32(trailing.subarray(0, -4)), trailing.length - 4);
await assert.rejects(decodeRpl(trailing), /回放损坏/);
const zero = await recordFixture(meta, 0);
assert.equal(
  (await GameEngine.buildReplayFromActions(await decodeRpl(await encodeRpl(zero)))).initial.game_end,
  true,
);
assert.equal(inspectRpl(bytes).checkBytes, 26);
console.log(
  'PASS RKL1 round-trip, deterministic bytes, zero ticks, ordered surrenders; rejected ' +
    invalid.map(([label]) => label).join(', ') +
    ' and mismatched final board',
);
