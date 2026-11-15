import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { UserStore } from '../dist/auth-store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'roka-chat-server-'));
const secret = 'chat-regression-secret';
const probe = net.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const users = new UserStore(dir);
await users.ensureReady();
const cookies = {};
for (const username of ['chat_admin', 'chat_ad', 'chat_normal', 'chat_peer']) {
  await users.register(username, 'chat-test-password');
  const sid = await users.rotateSession(username);
  cookies[username] = `auth_token=${jwt.sign({ sub: username, sid }, secret)}`;
}
const server = spawn(process.execPath, ['dist/server.js', '--port', String(port)], {
  env: {
    ...process.env,
    JWT_SECRET: secret,
    WEBHOOK_SECRET: secret,
    ROKA_DATA_DIR: dir,
    ROKA_STATIC_CDN: '0',
    ROKA_BOT_TOKENS: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', (b) => {
  logs += b;
});
server.stderr.on('data', (b) => {
  logs += b;
});
const sockets = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(predicate, label) {
  for (let i = 0; i < 160; i++) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error('timeout: ' + label + '\n' + logs.slice(-3000));
}
async function connect(username, room) {
  const socket = io(base, {
    transports: ['websocket'],
    extraHeaders: { Cookie: cookies[username] },
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  await once(socket, 'connect');
  const joined = once(socket, 'room_update');
  socket.emit('join_game_room', { room });
  await joined;
  return socket;
}
async function audit(query = '') {
  const res = await fetch(base + '/api/admin/chat-audit' + query, {
    headers: { cookie: cookies.chat_admin },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  return (await res.json()).items;
}
async function post(url, cookie, body) {
  return fetch(base + url, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const timeout = setTimeout(() => server.kill('SIGKILL'), 30000);
try {
  await wait(async () => {
    try {
      return (await fetch(base + '/api/version')).ok;
    } catch {
      return false;
    }
  }, 'startup');
  for (const [cookie, status] of [
    ['', 401],
    [cookies.chat_normal, 403],
  ]) {
    assert.equal((await fetch(base + '/api/admin/chat-audit', { headers: { cookie } })).status, status);
    assert.equal((await post('/api/admin/chat-release', cookie, { username: 'chat_ad' })).status, status);
  }
  const peer = await connect('chat_peer', 'ad-room');
  const ad = await connect('chat_ad', 'ad-room');
  const received = once(peer, 'chat_message');
  ad.emit('send_message', { text: '优惠 https://ads.example.com/private?token=secret', team: false });
  await received;
  ad.disconnect();
  await wait(async () => (await audit('?candidates=1')).length === 1, 'drive-by candidate');
  const entry = (await audit('?username=chat_ad'))[0];
  assert.equal(entry.text, '优惠 https://ads.example.com');
  assert.equal(entry.room, 'ad-room');
  assert.ok(entry.mutedUntil > Date.now());
  const reconnected = await connect('chat_ad', 'other-room');
  const blocked = once(reconnected, 'error_message');
  reconnected.emit('send_message', { text: 'https://ads.example.com', team: false });
  assert.match((await blocked)[0].error, /暂限/);
  assert.equal((await audit('?username=chat_ad')).length, 1, 'blocked attempts not stored');
  assert.equal(
    (await post('/api/admin/chat-release', cookies.chat_normal, { username: 'chat_ad' })).status,
    403,
  );
  assert.equal(
    (await post('/api/admin/chat-release', cookies.chat_admin, { username: 'chat_ad' })).status,
    200,
  );
  const afterRelease = once(reconnected, 'chat_message');
  reconnected.emit('send_message', { text: '正常游戏讨论：先占城再进攻', team: false });
  await afterRelease;
  await wait(async () => (await audit('?username=chat_ad')).length === 2, 'release restores chat');
  assert.equal((await audit('?candidates=1'))[0].reviewedBy, 'chat_admin');
  const normal = await connect('chat_normal', 'normal-room');
  let accepted = once(normal, 'chat_message');
  normal.emit('send_message', { text: '玩法说明 https://roka.oim.moe/tutorial', team: false });
  await accepted;
  accepted = once(normal, 'chat_message');
  normal.emit('send_message', { text: '下一局先占城再支援队友', team: false });
  await accepted;
  await wait(async () => (await audit('?username=chat_normal')).length === 2, 'normal public chat audit');
  assert.equal((await audit('?username=chat_normal&candidates=1')).length, 0);
  normal.emit('send_message', null);
  normal.emit('send_message', { text: 'x'.repeat(501) });
  await sleep(100);
  assert.equal((await audit('?username=chat_normal')).length, 2);
  // Enter a real match: team messages remain private, public game chat has a replay id.
  const opponent = await connect('chat_peer', 'normal-room');
  const started = once(normal, 'init_map');
  normal.emit('change_ready', { ready: true });
  opponent.emit('change_ready', { ready: true });
  await started;
  normal.emit('send_message', { text: 'private team discussion', team: true });
  normal.emit('send_message', { text: 'public game discussion', team: false });
  await wait(
    async () => (await audit('?username=chat_normal')).some((e) => e.text === 'public game discussion'),
    'game chat',
  );
  const items = await audit('?username=chat_normal');
  assert.ok(items.find((e) => e.text === 'public game discussion').gameId);
  assert.ok(!items.some((e) => e.text.includes('private team')));
  const gameLink = once(normal, 'chat_message');
  normal.emit('send_message', { text: 'https://ads.example.xyz/deal', team: false });
  await gameLink;
  const left = once(normal, 'left');
  normal.emit('return_room');
  await left;
  const gameCandidate = (await audit('?username=chat_normal&candidates=1'))[0];
  assert.ok(gameCandidate.gameId, 'explicit game exit creates a candidate with game id');
  assert.equal((await post('/api/admin/unban', cookies.chat_admin, { username: 'chat_normal' })).status, 200);
  assert.equal((await audit('?username=chat_normal&candidates=1'))[0].reviewedBy, 'chat_admin');
  console.log('chat moderation HTTP permissions, socket enforcement, release and game privacy tests passed');
} finally {
  clearTimeout(timeout);
  for (const socket of sockets) socket.disconnect();
  server.kill('SIGTERM');
  if (server.exitCode === null) await once(server, 'exit');
  await rm(dir, { recursive: true, force: true });
}
