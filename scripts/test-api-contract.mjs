import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { UserStore } from '../dist/auth-store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'roka-contract-'));
const probe = net.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const secret = 'contract-test-secret';
const store = new UserStore(dir);
await store.ensureReady();
await store.register('contract_user', 'contract-pass');
const sid = await store.rotateSession('contract_user');
const token = jwt.sign({ sub: 'contract_user', sid }, secret);
const cookie = `auth_token=${token}`;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server.js', '--port', String(port)], {
  env: {
    ...process.env,
    JWT_SECRET: secret,
    WEBHOOK_SECRET: secret,
    ROKA_DATA_DIR: dir,
    ROKA_STATIC_CDN: '0',
    ROKA_BOT_TOKENS: 'token-a:contract_a,token-b:contract_b,token-s:contract_s',
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
const wait = async (predicate, label) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timeout: ${label}`);
};
const timeout = setTimeout(() => {
  server.kill('SIGKILL');
  throw new Error('contract test hard timeout');
}, 40000);
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/version`)).ok) break;
    } catch {}
    await sleep(50);
  }
  for (const route of ['/rooms', '/replays', '/games']) {
    const response = await fetch(base + route, { headers: { cookie }, redirect: 'manual' });
    assert.equal(response.status, 404, route);
  }
  for (const route of ['/', '/api/rooms', '/api/replays'])
    assert.equal((await fetch(base + route)).status, 200, route);
  const body = JSON.stringify({ ref: 'refs/heads/other' }, null, 2);
  const headers = {
    cookie,
    'content-type': 'application/json',
    'x-github-event': 'push',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  };
  assert.equal((await fetch(`${base}/postreceive/`, { method: 'POST', headers, body })).status, 404);
  assert.equal((await fetch(`${base}/postreceive`, { method: 'POST', headers, body })).status, 200);
  for (const header of ['x-webhook-secret', 'x-kana-webhook-secret']) {
    assert.equal(
      (
        await fetch(`${base}/postreceive`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [header]: secret },
          body,
        })
      ).status,
      401,
    );
  }
  const wrapped = JSON.stringify({ payload: body });
  assert.equal(
    (
      await fetch(`${base}/postreceive`, {
        method: 'POST',
        headers: {
          ...headers,
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(wrapped).digest('hex')}`,
        },
        body: wrapped,
      })
    ).status,
    400,
  );
  const form = new URLSearchParams({ payload: body }).toString();
  assert.equal(
    (
      await fetch(`${base}/postreceive`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/x-www-form-urlencoded',
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(form).digest('hex')}`,
        },
        body: form,
      })
    ).status,
    415,
  );
  for (const region of ['three-kingdoms', 'northern-dynasties', 'qing', 'hong-kong'])
    assert.equal((await fetch(`${base}/api/map-examples?map_region=${region}`)).status, 400, region);
  assert.equal((await fetch(`${base}/api/map-examples?map_region=han`)).status, 200);

  const peers = [];
  for (const authToken of ['token-a', 'token-b']) {
    const socket = io(base, { transports: ['websocket'], auth: { token: authToken }, reconnection: false });
    sockets.push(socket);
    const peer = { socket, rooms: [], frames: [], inits: [], left: 0 };
    peers.push(peer);
    socket.on('room_update', (d) => peer.rooms.push(d));
    socket.on('update', (d) => peer.frames.push(d));
    socket.on('init_map', (d) => peer.inits.push(d));
    socket.on('left', () => peer.left++);
    await once(socket, 'connect');
    socket.emit('join_game_room', { room: 'contract' });
    await wait(() => peer.rooms.length, 'join');
  }
  const [a, b] = peers;
  const room = a.rooms.at(-1);
  assert.ok(room.ready_counts);
  assert.equal(Object.hasOwn(room, 'ready'), false);
  assert.equal(Object.hasOwn(room, 'need'), false);
  const rooms = await (await fetch(`${base}/api/rooms`)).json();
  assert.equal(Object.hasOwn(rooms[0], 'ready'), false);
  assert.equal(Object.hasOwn(rooms[0], 'need'), false);
  a.socket.emit('change_game_conf', { map_region: 'tang' });
  await wait(() => a.rooms.at(-1).map_region === 'tang', 'current region');
  for (const old of ['three-kingdoms', 'northern-dynasties', 'qing', 'hong-kong'])
    a.socket.emit('change_game_conf', { map_region: old });
  await sleep(100);
  assert.equal(a.rooms.at(-1).map_region, 'tang');
  a.socket.emit('change_ready', { ready: true });
  b.socket.emit('change_ready', { ready: true });
  await wait(() => a.inits.length && a.frames.length, 'game start');
  const spectator = io(base, { transports: ['websocket'], auth: { token: 'token-s' }, reconnection: false });
  sockets.push(spectator);
  const spectatorFrames = [],
    spectatorInits = [];
  spectator.on('init_map', (d) => spectatorInits.push(d));
  spectator.on('update', (d) => spectatorFrames.push(d));
  await once(spectator, 'connect');
  spectator.emit('join_game_room', { room: 'contract' });
  await wait(() => spectatorFrames.length, 'spectator start');
  assert.equal(spectatorInits[0].next_seq, 1);
  assert.deepEqual(spectatorInits[0].queue_ops, []);
  assert.equal(a.inits[0].next_seq, 1);
  assert.deepEqual(a.inits[0].queue_ops, []);
  const invalid = { x: -100, y: -100, dx: -100, dy: -99 };
  a.socket.emit('attack', { ...invalid, half: true });
  a.socket.emit('attack', { ...invalid, mode: 0, half: false });
  a.socket.emit('attack', { ...invalid, mode: 0, line: 0 });
  a.socket.emit('attack', { ...invalid });
  a.socket.emit('attack', { ...invalid, mode: '0' });
  a.socket.emit('build', { x: -100, y: -100, op: 'b', line: 0 });
  await sleep(400);
  assert.ok(
    a.frames.every((f) => f.lst_moves.length === 0),
    'old inputs never enqueue',
  );
  // Invalid coordinates are dequeued and acknowledged, making queue admission observable.
  for (const mode of [0, 1, 2]) a.socket.emit('attack', { ...invalid, mode });
  a.socket.emit('build', { x: -100, y: -100, op: 'b' });
  a.socket.emit('clear_queue', { line: 0 });
  a.socket.emit('pop_queue', { line: 0 });
  await wait(() => a.frames.flatMap((f) => f.lst_moves).includes(4), 'current inputs acknowledged');
  assert.deepEqual(
    a.frames.flatMap((f) => f.lst_moves),
    [1, 2, 3, 4],
  );
  for (const peer of [...peers, { frames: spectatorFrames }])
    for (const f of peer.frames) {
      assert.ok(Array.isArray(f.lst_moves));
      for (const key of ['lst_move', 'lst_skip', 'line']) assert.equal(Object.hasOwn(f, key), false, key);
    }
  a.socket.emit('surrender');
  await sleep(100);
  a.socket.emit('leave');
  await sleep(100);
  assert.equal(a.left, 0, 'removed event has no acknowledgement');
  a.socket.emit('return_room');
  await wait(() => a.left === 1, 'return_room');
  await sleep(100);
  assert.equal(a.left, 1, 'single acknowledgement');
  console.log('API contract: removed routes/events/fields rejected; current REST/socket contract passed');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  clearTimeout(timeout);
  for (const socket of sockets) socket.disconnect();
  server.kill('SIGTERM');
  await once(server, 'exit');
  await rm(dir, { recursive: true, force: true });
}
