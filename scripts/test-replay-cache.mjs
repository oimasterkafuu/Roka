import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ ArrayBuffer, Uint8Array, Number });
vm.runInContext(
  'var replay_binary_magic = [0x52, 0x50, 0x42, 0x34];\n' +
    readFileSync(new URL('../static/main/replay-cache.js', import.meta.url), 'utf8'),
  context,
);

const id = 'a+b-Cdefghij';
assert.equal(context.replayCacheKey(id), id, 'ID 原样作为键，保留 + 和 -');
const buffer = Uint8Array.from([0x52, 0x50, 0x42, 0x34, 1]).buffer;
const entry = {
  id,
  version: context.REPLAY_CACHE_VERSION,
  buffer,
  size: buffer.byteLength,
  downloadedAt: 100,
  lastViewedAt: 200,
  etag: '',
  lastModified: '',
};
assert.ok(context.replayCacheValid(entry, id), '当前魔数和版本命中');
assert.ok(!context.replayCacheValid(entry, 'another-id'), '不同 ID 不命中');
assert.ok(!context.replayCacheValid({ ...entry, version: 0 }, id), '版本不一致失效');
assert.ok(!context.replayCacheValid({ ...entry, size: 4 }, id), '长度不一致失效');
assert.ok(
  !context.replayCacheValid({ ...entry, buffer: Uint8Array.from([0x52, 0x50, 0x42, 0x33, 1]).buffer }, id),
  '旧魔数失效',
);

const entries = Array.from({ length: 200 }, (_, i) => ({ id: String(i), size: 10, lastViewedAt: i }));
assert.deepEqual(
  Array.from(context.replayCacheEvictions(entries, 'new', 10)),
  ['0'],
  '条数超限淘汰最久未查看',
);
assert.deepEqual(Array.from(context.replayCacheEvictions(entries, '0', 10)), [], '覆盖同键不增加条数');
assert.deepEqual(
  Array.from(context.replayCacheEvictions(entries.slice(0, 3), 'new', context.REPLAY_CACHE_MAX_BYTES - 15)),
  ['0', '1'],
  '容量超限按最近查看时间淘汰',
);
console.log('回放缓存键、版本、魔数及 LRU 容量断言通过');
