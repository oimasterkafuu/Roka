import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ChatModeration,
  webOrigins,
  CHAT_RETENTION_MS,
  CHAT_MAX_ENTRIES,
  CHAT_MAX_BYTES,
  CHAT_MUTE_MS,
} from '../dist/server/chat-moderation.js';
const dir = await mkdtemp(path.join(tmpdir(), 'roka-chat-policy-'));
let now = Date.now();
try {
  const chat = new ChatModeration(dir, () => now);
  await chat.ensureReady();
  assert.deepEqual(webOrigins('一起打中路，广告这个词不构成证据'), []);
  assert.deepEqual(webOrigins('https://ads.example.com/deal?token=secret#private'), [
    'https://ads.example.com',
  ]);
  assert.deepEqual(webOrigins('www.example.com example.xyz'), [
    'https://www.example.com',
    'https://example.xyz',
  ]);
  chat.begin('normal', 'normal', 'room');
  chat.record('normal', '地图说明 https://roka.oim.moe/tutorial');
  now += 16_000;
  chat.end('normal');
  assert.equal(chat.check('normal'), null, 'normal URL with continued presence is not restricted');
  chat.begin('talk', 'talk', 'room');
  chat.record('talk', '这局先占城，等队友再进攻');
  chat.end('talk');
  assert.equal(chat.check('talk'), null, 'discussion and quick departure alone are harmless');
  chat.begin('ad', 'spammer', 'room');
  chat.record('ad', '优惠 https://user:password@ads.example.com/private?secret=123#token', 'game1');
  now += 1000;
  chat.end('ad');
  assert.match(chat.check('SPAMMER'), /暂限/);
  const candidate = chat.list({ candidates: true })[0];
  assert.equal(candidate.gameId, 'game1');
  assert.equal(candidate.text, '优惠 https://ads.example.com');
  assert.equal(candidate.candidateAt, now);
  await chat.flush();
  assert.equal((await stat(path.join(dir, 'chat-audit.json'))).mode & 0o777, 0o600);
  const restart = new ChatModeration(dir, () => now);
  await restart.ensureReady();
  assert.match(restart.check('spammer'), /暂限/, 'restriction persists across restart');
  restart.release('spammer', 'admin');
  assert.equal(restart.check('spammer'), null);
  assert.equal(restart.list({ candidates: true })[0].reviewedBy, 'admin');
  chat.begin('special', '__proto__', 'room');
  chat.record('special', 'https://ads.example.com');
  chat.end('special');
  assert.match(chat.check('__proto__'), /暂限/, 'special property names cannot bypass account restriction');
  chat.begin('late', 'late', 'room');
  now += 31_000;
  chat.record('late', 'https://example.com');
  chat.end('late');
  assert.equal(chat.check('late'), null, 'established visitor is not a drive-by candidate');
  chat.begin('rejoin', 'rejoin', 'room', false);
  chat.record('rejoin', 'https://example.com');
  chat.end('rejoin');
  assert.equal(chat.check('rejoin'), null, 'rejoining existing game is not a new visit');
  for (let i = 0; i < 5; i++) assert.equal(chat.check('rate'), null);
  assert.match(chat.check('rate'), /频繁/);
  now += 10_000;
  assert.equal(chat.check('rate'), null);
  // Exercise both count and byte bounds with worst-case multibyte text.
  chat.begin('bulk', 'bulk', 'room');
  for (let i = 0; i < CHAT_MAX_ENTRIES + 50; i++) {
    chat.record('bulk', '界'.repeat(500));
  }
  await Promise.all([chat.flush(), chat.flush(), chat.flush()]);
  const first = chat.list({});
  const second = chat.list({ before: first.at(-1).id });
  assert.equal(first.length, 100);
  assert.equal(second.length, 100);
  assert.ok(
    second.every((entry) => !first.some((item) => item.id === entry.id)),
    'pagination handles equal timestamps',
  );
  assert.ok(chat.list({}).length <= 100);
  const snapshot = JSON.parse(await readFile(path.join(dir, 'chat-audit.json'), 'utf8'));
  assert.ok(snapshot.entries.length <= CHAT_MAX_ENTRIES);
  assert.ok((await stat(path.join(dir, 'chat-audit.json'))).size <= CHAT_MAX_BYTES);
  assert.match(chat.check('spammer'), /暂限/, 'log eviction cannot lift account restriction');
  now += CHAT_MUTE_MS;
  assert.equal(chat.check('spammer'), null);
  now += CHAT_RETENTION_MS;
  await chat.flush();
  assert.equal(chat.list({}).length, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'chat-audit.json'), 'utf8')), {
    entries: [],
    mutes: {},
  });
  console.log('chat moderation policy, privacy and retention tests passed');
} finally {
  await rm(dir, { recursive: true, force: true });
}
